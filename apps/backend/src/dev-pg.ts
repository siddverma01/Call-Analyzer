import EmbeddedPostgres from "embedded-postgres";
import { execFileSync, execSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface DevPostgres {
  databaseUrl: string;
  stop(): Promise<void>;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Forcefully ends any PostgreSQL processes tied to the embedded-postgres
 * binary (postmaster + forked backends) that reference `dataDir`, plus any
 * process still listening on `port`. The embedded-postgres client's own
 * `stop()` can miss the postmaster on Windows and even the postmaster's death
 * can leave forked backends (`--forkchild`) running; any orphan keeps vitest
 * forks workers (and CI) from ever finishing teardown. Idempotent, best-effort.
 */
export function ensurePostgresStopped(dataDir?: string, port?: number, attempts = 15): void {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pids = new Set<number>();
    if (port) {
      try {
        const out = execSync(`netstat -ano -p TCP | findstr ":${port}"`, { encoding: "utf8" });
        for (const line of out.split(/\r?\n/)) {
          const match = line.trim().match(/(\d+)\s*$/);
          if (match) {
            const pid = Number(match[1]);
            if (Number.isInteger(pid) && pid > 0) pids.add(pid);
          }
        }
      } catch {
        /* no listeners */
      }
    }
    // Backends do not carry the data dir in their command line; match on the
    // embedded binary path (WMI can also return a blank ExecutablePath, but the
    // command line always starts with the embedded postgres.exe) so nothing
    // under its tree survives the suite.
    try {
      const script =
        `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'postgres.exe' -and ` +
        `($_.CommandLine -like '*embedded-postgres*' -or $_.CommandLine -like '*${dataDir}*') } | ` +
        `Select-Object -ExpandProperty ProcessId`;
      const out = execSync(`powershell -NoProfile -Command "${script}"`, { encoding: "utf8" });
      for (const pid of out.split(/\s+/)) {
        const n = Number(pid);
        if (Number.isInteger(n) && n > 0) pids.add(n);
      }
    } catch {
      /* no matching processes */
    }
    if (pids.size === 0) return;
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    }
    sleepSync(250);
  }
}

/**
 * Boots the embedded PostgreSQL used during development (no Docker needed)
 * and ensures the target database exists. Idempotent: subsequent calls reuse
 * the existing data directory. `initialise()` runs initdb and must only be
 * called on a freshly wiped directory, so it is gated on PG_VERSION.
 */
export async function startEmbeddedPostgres(): Promise<DevPostgres> {
  const port = Number(process.env["DEV_PG_PORT"] ?? 55432);
  const user = process.env["DEV_PG_USER"] ?? "callnotes";
  const password = process.env["DEV_PG_PASSWORD"] ?? "callnotes";
  const database = process.env["DEV_PG_DATABASE"] ?? "callnotes";
  const dataDir = process.env["DEV_PG_DATA_DIR"] ?? "./data/pg";

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: true,
  });

  if (!existsSync(join(dataDir, "PG_VERSION"))) {
    rmSync(dataDir, { recursive: true, force: true });
    await pg.initialise();
  }
  await pg.start();

  const client = pg.getPgClient();
  await client.connect();
  try {
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (result.rowCount === 0) {
      await client.query(
        `CREATE DATABASE "${database}" WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
      );
    }
  } finally {
    await client.end();
  }

  const databaseUrl = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}?schema=public`;
  return { databaseUrl, stop: () => pg.stop() };
}

/**
 * Applies pending Prisma migrations. Requires `prisma` to be reachable and
 * runs from the backend workspace directory (npm sets this cwd).
 */
export function runMigrations(databaseUrl: string): void {
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 120_000,
  });
}