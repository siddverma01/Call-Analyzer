import { getEnv } from "./env.js";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/prisma.js";
import { startEmbeddedPostgres, runMigrations } from "./dev-pg.js";

async function main(): Promise<void> {
  const env = getEnv();

  const useEmbedded = env.NODE_ENV === "development" && process.env["EMBEDDED_PG"] !== "0";
  let devPostgres: Awaited<ReturnType<typeof startEmbeddedPostgres>> | undefined;

  try {
    if (useEmbedded) {
      console.log("[dev] starting embedded PostgreSQL (set EMBEDDED_PG=0 to disable)");
      devPostgres = await startEmbeddedPostgres();
      console.log("[dev] running Prisma migrations");
      runMigrations(devPostgres.databaseUrl);
    }

    const database = devPostgres ? createDatabase(devPostgres.databaseUrl) : undefined;
    const built = await buildApp({ env, database, databaseUrl: devPostgres?.databaseUrl });
    const { app } = built;

    const shutdown = async (signal: string): Promise<void> => {
      app.log.info({ signal }, "shutting down");
      await app.close();
      await built.database.disconnect();
      if (devPostgres) {
        console.log("[dev] stopping embedded PostgreSQL");
        await devPostgres.stop().catch(() => {});
      }
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(
      { url: `${env.PUBLIC_API_URL}`, docs: `${env.PUBLIC_API_URL}/docs` },
      "CallNotes AI API listening",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env["LOG_LEVEL"] !== "silent") console.error(message);
    if (devPostgres) await devPostgres.stop().catch(() => {});
    process.exit(1);
  }
}

void main();