/**
 * Local PostgreSQL harness (no Docker required).
 *
 * Usage:
 *   node scripts/dev-db.mjs up      - start (and create) the embedded database
 *   node scripts/dev-db.mjs down    - stop the database
 *   node scripts/dev-db.mjs status  - show runtime information
 *
 * Reads DEV_PG_* variables from .env (see .env.example).
 */
import EmbeddedPostgres from "embedded-postgres";
import { config as loadDotEnv } from "dotenv";
import { devDbEnvSchema } from "@callnotes/config";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

loadDotEnv();
const env = devDbEnvSchema.parse(process.env);
const pg = new EmbeddedPostgres({
  databaseDir: env.DEV_PG_DATA_DIR,
  user: env.DEV_PG_USER,
  password: env.DEV_PG_PASSWORD,
  port: env.DEV_PG_PORT,
  persistent: true,
  timeout: 60_000,
});

const databaseUrl = `postgresql://${env.DEV_PG_USER}:${env.DEV_PG_PASSWORD}@127.0.0.1:${env.DEV_PG_PORT}/${env.DEV_PG_DATABASE}?schema=public`;

async function up() {
  const dir = join(process.cwd(), env.DEV_PG_DATA_DIR);
  const isInitialised = existsSync(join(dir, "PG_VERSION"));
  if (!isInitialised) {
    console.log(`[dev-db] initialising data directory: ${dir}`);
    rmSync(dir, { recursive: true, force: true });
    await pg.initialise();
  }
  await pg.start();
  console.log(`[dev-db] starting embedded PostgreSQL`);

  const client = pg.getPgClient();
  await client.connect();
  try {
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [env.DEV_PG_DATABASE]);
    if (result.rowCount === 0) {
      // template0 avoids the WIN1252 template-database encoding on some installs.
      await client.query(
        `CREATE DATABASE "${env.DEV_PG_DATABASE}" WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
      );
      console.log(`[dev-db] created database: ${env.DEV_PG_DATABASE}`);
    }
  } finally {
    await client.end();
  }

  console.log(`[dev-db] ready at 127.0.0.1:${env.DEV_PG_PORT}`);
  console.log(`[dev-db] DATABASE_URL=${databaseUrl}`);
  console.log(
    "[dev-db] PostgreSQL is running in the foreground. Press Ctrl+C to stop it",
  );
  // Keep this process alive: embedded-postgres stops the cluster when its
  // owning Node process exits.
  await new Promise((resolve) => {
    const stop = () => resolve(undefined);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function down() {
  await pg.stop();
  console.log("[dev-db] stopped");
}

async function status() {
  console.log(`[dev-db] configured: 127.0.0.1:${env.DEV_PG_PORT}, database ${env.DEV_PG_DATABASE}, data dir ${env.DEV_PG_DATA_DIR}`);
  console.log(`[dev-db] DATABASE_URL=${databaseUrl}`);
}

const command = process.argv[2] ?? "status";
const actions = { up, down, status };
if (!(command in actions)) {
  console.error(`Unknown command: ${command}. Use: up | down | status`);
  process.exit(1);
}
await actions[command]();