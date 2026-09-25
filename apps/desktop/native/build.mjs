/**
 * Builds the CallNotes AI native addons:
 *
 *   - `callnotes-wasapi-<platform>-<arch>.node`  - Windows WASAPI capture
 *   - `callnotes-whisper-<platform>-<arch>.node` - CPU-only whisper.cpp engine
 *
 * Toolchain strategy:
 *   1. Zig (`zig cc` / `zig c++` + bundled mingw-w64 Windows SDK headers) when
 *      available - self-contained, no Visual Studio required.
 *   2. Otherwise it falls back to the Node.js headers + node.exe import library
 *      generated with `zig dlltool`. If Zig is missing entirely the script
 *      fails with instructions (install `winget install zig.zig` or Visual
 *      Studio Build Tools).
 *
 * Both addons are pure N-API (ABI-stable), so the compiled artifacts load in
 * both Node.js and Electron.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, "src");
const includeDir = join(root, "deps", "node-headers", "include", "node");
const cacheDir = join(root, ".build-cache");
const prebuildsDir = join(root, "prebuilds");
const whisperSrc = join(root, "deps", "whisper.cpp");
const force = process.argv.includes("--force");

const platform = process.platform;
const arch = process.arch;

function fail(message) {
  console.error(`\n[native] ERROR: ${message}\n`);
  process.exit(1);
}

function log(tag, message) {
  console.log(`[${tag}] ${message}`);
}

async function findZig() {
  const candidates = [process.env["CALLNOTES_ZIG"], process.env["ZIG"]].filter(Boolean);
  const onPath = spawnSync("zig", ["version"], { shell: true, encoding: "utf8" });
  if (onPath.status === 0 && onPath.stdout) candidates.unshift("zig");

  // Common winget install location.
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const winGetRoot = join(localAppData, "Microsoft", "WinGet", "Packages");
  if (existsSync(winGetRoot)) {
    const { readdirSync } = await import("node:fs");
    try {
      for (const pkg of readdirSync(winGetRoot)) {
        if (!pkg.startsWith("zig.zig")) continue;
        const pkgDir = join(winGetRoot, pkg);
        const { readdirSync: readdirSync2 } = await import("node:fs");
        for (const ver of readdirSync2(pkgDir)) {
          if (!ver.startsWith("zig-")) continue;
          const exe = join(pkgDir, ver, "zig.exe");
          if (existsSync(exe)) candidates.push(exe);
        }
      }
    } catch {
      /* ignore scan errors */
    }
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["version"], { shell: true, encoding: "utf8" });
    if (probe.status === 0 && probe.stdout) {
      return { exe: candidate, version: probe.stdout.trim() };
    }
  }
  return null;
}

/**
 * Reads the export table of a Windows PE executable and returns the exported
 * symbol names. Used to synthesize the `node.exe` import library that the
 * addon links against.
 */
function readPeExports(exePath) {
  const buf = readFileSync(exePath);
  if (buf.length < 0x40) return [];
  const eLfanew = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", eLfanew, eLfanew + 4) !== "PE\0\0") return [];

  const isPe32 = buf.readUInt16LE(eLfanew + 24) === 0x10b;
  const optOff = eLfanew + 24;
  const ddOff = optOff + (isPe32 ? 96 : 112);
  const exportsRva = buf.readUInt32LE(ddOff);
  const exportsSize = buf.readUInt32LE(ddOff + 4);
  if (exportsRva === 0 || exportsSize === 0) return [];

  const numSections = buf.readUInt16LE(eLfanew + 6);
  const secOff = optOff + (isPe32 ? 224 : 240);
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const sec = secOff + i * 40;
    sections.push({
      virtualSize: buf.readUInt32LE(sec + 8),
      virtualAddress: buf.readUInt32LE(sec + 12),
      rawSize: buf.readUInt32LE(sec + 16),
      rawPtr: buf.readUInt32LE(sec + 20),
    });
  }
  const rvaToOff = (rva) => {
    for (const s of sections) {
      if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
        return s.rawPtr + (rva - s.virtualAddress);
      }
    }
    return -1;
  };

  const dirOff = rvaToOff(exportsRva);
  if (dirOff < 0) return [];
  const numNames = buf.readUInt32LE(dirOff + 24);
  const namesRva = buf.readUInt32LE(dirOff + 32);
  const namesOff = rvaToOff(namesRva);
  if (namesOff < 0) return [];

  const names = [];
  for (let i = 0; i < numNames; i++) {
    const nameRva = buf.readUInt32LE(namesOff + i * 4);
    const nameOff = rvaToOff(nameRva);
    if (nameOff < 0) continue;
    let end = nameOff;
    while (end < buf.length && buf[end] !== 0) end++;
    const name = buf.toString("latin1", nameOff, end);
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

async function ensureImportLib(zig, nodeExe) {
  const version = process.versions.node;
  const stamp = statSync(nodeExe).mtimeMs;
  const key = createHash("sha1").update(`${version}|${stamp}`).digest("hex").slice(0, 12);
  const libPath = join(cacheDir, `node-${version}-${key}.lib`);
  if (existsSync(libPath)) return libPath;

  mkdirSync(cacheDir, { recursive: true });
  log("native", `synthesizing import library from ${basename(nodeExe)} (node v${version})`);
  const exports = readPeExports(nodeExe);
  if (exports.length < 100) fail(`could not parse exports from ${nodeExe} (got ${exports.length})`);

  const defPath = join(cacheDir, `node-${version}.def`);
  const defLines = ["LIBRARY node.exe", "EXPORTS", ...exports.map((n) => `  ${n}`)];
  writeFileSync(defPath, defLines.join("\n") + "\n", "utf8");

  const tmpLib = join(cacheDir, `node-unstamped.lib`);
  const res = spawnSync(zig.exe, ["dlltool", "-m", "i386:x86-64", "-d", defPath, "-l", tmpLib], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (res.status !== 0) {
    fail(`zig dlltool failed:\n${res.stderr}`);
  }
  copyFileSync(tmpLib, libPath);
  return libPath;
}

async function ensureNodeHeaders() {
  // The headered bundle mirrors the Node runtime used for builds. Actual load
  // time resolution is handled by Node/Electron, so exact version matching is
  // not required for N-API (ABI-stable), only that the headers are recent.
  const sample = join(includeDir, "node_api.h");
  if (!existsSync(sample)) fail(`missing N-API headers at ${includeDir}`);
  return includeDir;
}

/** Runs an external tool, failing with a readable message on non-zero exit. */
function run(tool, tag, args) {
  const res = spawnSync(tool, args, { encoding: "utf8", stdio: "pipe" });
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    const lines = stderr.length === 0 ? (res.stdout ?? "").trim() : stderr;
    const logPath = join(cacheDir, `last-error-${tag.replace(/[^a-z0-9]+/gi, "-")}.log`);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(logPath, `$ ${tool} ${[...args].join(" ")}\n\n${lines}\n`, "utf8");
    fail(`${tag} failed - full output at ${logPath}\n${lines.split("\n").slice(-30).join("\n")}`);
  }
  return res;
}

let autoTag = 0;
function runTagged(tool, tag, args) {
  return run(tool, `${tag}#${autoTag++}`, args);
}

/* ------------------------------------------------------------------------- *
 * WASAPI addon (single-file C, straight to .node)
 * ------------------------------------------------------------------------- */

function buildWasapi(zig, importLib, nodeIncludes) {
  const outName = `callnotes-wasapi-${platform}-${arch}.node`;
  const outPath = join(prebuildsDir, outName);

  const args = [
    "cc",
    "-target",
    "x86_64-windows-gnu",
    "-O2",
    "-DBUILDING_NODE_EXTENSION",
    "-I",
    nodeIncludes,
    "-shared",
    join(srcDir, "wasapi_addon.c"),
    importLib,
    "-lole32",
    "-o",
    outPath,
  ];

  run(zig.exe, "wasapi compile", args);
  const size = statSync(outPath).size;
  log("wasapi", `built ${outName} (${(size / 1024).toFixed(1)} KiB) at ${outPath}`);
}

/* ------------------------------------------------------------------------- *
 * Whisper.cpp addon (C + C++ two-phase compile, link with `zig c++`)
 * ------------------------------------------------------------------------- */

const WHISPER_DEFS = ["-O2", "-DNDEBUG", "-D_CRT_SECURE_NO_WARNINGS", "-D_USE_MATH_DEFINES"];
const WHISPER_NODE = ["-DBUILDING_NODE_EXTENSION"];

/* CPU backend optimizations (mirror whisper.cpp desktop defaults). These are
 * runtime-dispatched: ggml selects kernels via cpuid, so the binary still runs
 * on CPUs without AVX2 - but only the ggml-cpu sources get these flags (the
 * rest of ggml/whisper.cpp compile without them, like the CMake build). */
const WHISPER_CPU_ARCH = [
  "-mavx2", "-mfma", "-mf16c",
  "-DGGML_AVX2", "-DGGML_FMA", "-DGGML_F16C",
];

const WHISPER_INCLUDES = [
  "-I", join(whisperSrc, "include"),
  "-I", join(whisperSrc, "src"),
  "-I", join(whisperSrc, "ggml", "include"),
  "-I", join(whisperSrc, "ggml", "src"),
  "-I", join(whisperSrc, "ggml", "src", "ggml-cpu"),
];

const WHISPER_C_SOURCES = [
  "ggml/src/ggml.c",
  "ggml/src/ggml-alloc.c",
  "ggml/src/ggml-quants.c",
  "ggml/src/ggml-cpu/ggml-cpu.c",
  "ggml/src/ggml-cpu/ggml-cpu-quants.c",
];

const WHISPER_CPP_SOURCES = [
  "src/whisper.cpp",
  "ggml/src/ggml-backend.cpp",
  "ggml/src/ggml-opt.cpp",
  "ggml/src/ggml-threading.cpp",
  "ggml/src/ggml-backend-reg.cpp",
  "ggml/src/ggml-cpu/ggml-cpu.cpp",
  "ggml/src/ggml-cpu/ggml-cpu-traits.cpp",
  "ggml/src/ggml-cpu/ggml-cpu-aarch64.cpp",
  "ggml/src/ggml-cpu/ggml-cpu-hbm.cpp",
  "ggml/src/ggml-cpu/amx/amx.cpp",
  "ggml/src/ggml-cpu/amx/mmq.cpp",
];

function buildWhisper(zig, importLib, nodeIncludes) {
  const outName = `callnotes-whisper-${platform}-${arch}.node`;
  const outPath = join(prebuildsDir, outName);

  if (!existsSync(join(whisperSrc, "src", "whisper.cpp"))) {
    fail(
      "whisper.cpp sources missing at deps/whisper.cpp.\n" +
        "  Clone it first (includes the ggml submodule):\n" +
        "    git clone --depth 1 --branch v1.7.4 --recurse-submodules --shallow-submodules " +
        "https://github.com/ggerganov/whisper.cpp.git native/deps/whisper.cpp",
    );
  }

  const objDir = join(cacheDir, `whisper-obj-${process.versions.node}`);
  rmSync(objDir, { recursive: true, force: true });
  mkdirSync(objDir, { recursive: true });

  const objects = [];
  const compile = (source, kind, { cpu = false } = {}) => {
    const tag = kind === "c" ? "cc" : "c++";
    const ext = kind === "c" ? "o" : "o";
    const baseName = basename(source).replace(/\.[^.]+$/, "");
    const objPath = join(objDir, `${baseName}-${objects.length}.${ext}`);
    const args = [
      tag,
      "-target",
      "x86_64-windows-gnu",
      ...WHISPER_DEFS,
      ...WHISPER_NODE,
      ...(cpu ? WHISPER_CPU_ARCH : []),
      ...(kind === "c" ? ["-std=c11"] : ["-std=c++17"]),
      ...WHISPER_INCLUDES,
      "-I",
      nodeIncludes,
      "-c",
      join(whisperSrc, source),
      "-o",
      objPath,
    ];
    run(zig.exe, `whisper compile ${source}`, args);
    objects.push(objPath);
  };

  const CPU_C_SET = new Set([
    "ggml/src/ggml-cpu/ggml-cpu.c",
    "ggml/src/ggml-cpu/ggml-cpu-quants.c",
  ]);
  const CPU_CPP_SET = new Set([
    "ggml/src/ggml-cpu/ggml-cpu.cpp",
    "ggml/src/ggml-cpu/ggml-cpu-traits.cpp",
    "ggml/src/ggml-cpu/ggml-cpu-aarch64.cpp",
    "ggml/src/ggml-cpu/ggml-cpu-hbm.cpp",
    "ggml/src/ggml-cpu/amx/amx.cpp",
    "ggml/src/ggml-cpu/amx/mmq.cpp",
  ]);

  for (const source of WHISPER_C_SOURCES) compile(source, "c", { cpu: CPU_C_SET.has(source) });
  for (const source of WHISPER_CPP_SOURCES) compile(source, "c++", { cpu: CPU_CPP_SET.has(source) });

  /* N-API module entry (C) that wraps the whisper C API. */
  const addonObj = join(objDir, "whisper_addon.o");
  run(
    zig.exe,
    "whisper compile whisper_addon.c",
    [
      "cc",
      "-target",
      "x86_64-windows-gnu",
      ...WHISPER_DEFS,
      ...WHISPER_NODE,
      "-I",
      nodeIncludes,
      ...WHISPER_INCLUDES,
      "-c",
      join(srcDir, "whisper_addon.c"),
      "-o",
      addonObj,
    ],
  );
  objects.push(addonObj);

  run(
    zig.exe,
    "whisper link",
    [
      "c++",
      "-target",
      "x86_64-windows-gnu",
      "-O2",
      "-shared",
      ...objects,
      importLib,
      "-o",
      outPath,
    ],
  );

  const size = statSync(outPath).size;
  log("whisper", `built ${outName} (${(size / 1024).toFixed(1)} KiB) at ${outPath}`);
}

async function main() {
  if (platform !== "win32") {
    log("native", `skipping native build: Windows-only addons (this host is ${platform})`);
    return;
  }
  if (arch !== "x64" && arch !== "ia32") {
    fail(`unsupported host architecture: ${arch}`);
  }

  mkdirSync(prebuildsDir, { recursive: true });

  const zig = await findZig();
  if (!zig) {
    fail(
      "no Zig toolchain found.\n" +
        "  Install it with:  winget install zig.zig\n" +
        "  or install Visual Studio Build Tools (msbuild + Windows SDK) and re-run; " +
        "or set CALLNOTES_ZIG=/path/to/zig.exe.",
    );
  }
  log("native", `using Zig ${zig.version} (${zig.exe})`);

  const nodeExe = process.execPath;
  const importLib = await ensureImportLib(zig, nodeExe);
  const nodeIncludes = await ensureNodeHeaders();

  buildWasapi(zig, importLib, nodeIncludes);
  buildWhisper(zig, importLib, nodeIncludes);
}

void main();