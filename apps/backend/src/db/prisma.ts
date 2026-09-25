import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.ts";

/** Minimal dependency the application actually relies on. */
export interface Database {
  /** Executes a trivial round-trip query to verify connectivity. */
  ping(timeoutMs?: number): Promise<void>;
  client: PrismaClient;
  disconnect(): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Creates a Prisma client bound to PostgreSQL via the pg driver adapter.
 * The client connects lazily - the first query establishes the pool.
 */
export function createDatabase(databaseUrl: string): Database {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const client = new PrismaClient({
    adapter,
    // Offline-first sync upserts whole meetings (thousands of transcript
    // segments) inside one interactive transaction, one row at a time. The
    // default 5000ms interactive timeout kills 30min+ meeting restores with
    // PrismaClientKnownRequestError P2028, so raise it well above worst-case.
    transactionOptions: {
      maxWait: 10_000,
      timeout: 90_000,
    },
  });
  return {
    client,
    async ping(timeoutMs = 2000) {
      await withTimeout(client.$queryRaw`SELECT 1`, timeoutMs);
    },
    disconnect: () => client.$disconnect(),
  };
}