/**
 * End-to-end local verification of the backend without Docker:
 *
 *   1. starts embedded PostgreSQL       (via apps/backend/src/dev-pg.ts)
 *   2. generates the Prisma client
 *   3. applies migrations               (prisma migrate deploy)
 *   4. seeds development users           (prisma db seed)
 *   5. boots the Fastify server
 *   6. polls /health, /health/database, /api/version, /docs
 *   7. shuts everything down
 *
 * This process owns the embedded-PostgreSQL lifecycle: embedded-postgres stops
 * the cluster when its owning Node process exits, and the DB cannot survive a
 * standalone CLI invocation, so everything runs in this one process.
 *
 * Usage: npm run verify
 */
import { spawn, execSync } from "node:child_process";
import { config as loadDotEnv } from "dotenv";
import { join } from "node:path";

loadDotEnv();

const PORT = process.env["VERIFY_PORT"] ?? "8790";
const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://callnotes:callnotes@127.0.0.1:55432/callnotes?schema=public";

// Fix TLS downloads on corporate/proxied networks for child processes.
if (!process.env["NODE_OPTIONS"]) {
  process.env["NODE_OPTIONS"] = "--use-system-ca";
}

const { startEmbeddedPostgres } = await import("../apps/backend/src/dev-pg.ts");

const root = process.cwd();
const api = `http://127.0.0.1:${PORT}`;
const npx = (cmd) =>
  execSync(cmd, { cwd: root, stdio: "inherit", shell: true, env: process.env });

function step(message) {
  console.log(`\n=== ${message} ===`);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollHealth(url, tries = 30) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch {
      // server not up yet
    }
    await wait(1000);
  }
  throw new Error(`server did not become healthy at ${url}`);
}

async function main() {
  step("Starting embedded PostgreSQL");
  const devPg = await startEmbeddedPostgres();
  process.env["DATABASE_URL"] = devPg.databaseUrl;

  let child;

  try {
    step("Generating Prisma client");
    npx("npm run db:generate -w apps/backend");

    step("Applying migrations");
    npx("npm run db:deploy -w apps/backend");

    step("Seeding development users");
    process.env["SEED_ADMIN_PASSWORD"] = "DevAdmin1234!";
    process.env["SEED_DEMO_PASSWORD"] = "DevDemo1234!";
    npx("npm run db:seed -w apps/backend");

    step("Booting backend");
    child = spawn(
      process.execPath,
      [join(root, "node_modules", "tsx", "dist", "cli.mjs"), "src/main.ts"],
      {
        cwd: join(root, "apps", "backend"),
        env: {
          ...process.env,
          DATABASE_URL: devPg.databaseUrl,
          NODE_ENV: "test",
          LOG_LEVEL: "silent",
          PORT,
          HOST: "127.0.0.1",
          PUBLIC_API_URL: api,
        },
        stdio: "inherit",
        shell: false,
      },
    );

    step("Waiting for /health");
    const health = await pollHealth(`${api}/health`);
    console.log("GET /health ->", JSON.stringify(health));

    step("Checking /health/database");
    const dbHealth = await pollHealth(`${api}/health/database`);
    console.log("GET /health/database ->", JSON.stringify(dbHealth));
    if (dbHealth.components?.[0]?.status !== "ok") {
      throw new Error("database health check did not report ok");
    }

    step("Checking /api/version");
    const version = await pollHealth(`${api}/api/version`);
    console.log("GET /api/version ->", JSON.stringify(version));

    step("Checking /docs (OpenAPI)");
    const docs = await fetch(`${api}/docs`);
    console.log("GET /docs ->", docs.status);

    step("VERIFICATION PASSED");
  } finally {
    if (child) {
      child.kill("SIGTERM");
      await wait(1500);
    }
    step("Stopping embedded PostgreSQL");
    await devPg.stop().catch(() => {});
  }
}

main()
  .catch((error) => {
    console.error(
      "VERIFICATION FAILED:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    // Embedded postgres registers an exit hook; if this process lingers on
    // open handles, force a clean exit so the environment is deterministic.
    process.exit(process.exitCode ?? 0);
  });