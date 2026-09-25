import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { buildApp, type BuiltApp } from "../../backend/src/app.ts";
import { getEnv, setEnvForTests } from "../../backend/src/env.ts";
import { createDatabase } from "../../backend/src/db/prisma.ts";
import { ensurePostgresStopped, startEmbeddedPostgres } from "../../backend/src/dev-pg.ts";
import { ApiClient, ApiError, type SessionStorage } from "../src/main/api-client.ts";

const COOKIE_SECRET = "desktop-test-cookie-secret-0123456789abcdef";
const PASSWORD = "Secure-Password-1234";

/** In-memory stand-in for the main process's encrypted session storage. */
class MemoryStorage implements SessionStorage {
  private token: string | null = null;
  async load(): Promise<string | null> {
    return this.token;
  }
  async save(token: string): Promise<void> {
    this.token = token;
  }
  async clear(): Promise<void> {
    this.token = null;
  }
}

let built: BuiltApp;
let pg: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
let baseUrl: string;

beforeAll(async () => {
  process.env["DEV_PG_DATA_DIR"] = mkdtempSync(join(tmpdir(), "lt-desktop-pg-"));
  process.env["DEV_PG_PORT"] = "55723";
  process.env["DEV_PG_DATABASE"] = "callnotes_desktop_test";

  pg = await startEmbeddedPostgres();
  const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "backend");
  execSync("npx.cmd prisma migrate deploy", {
    cwd: backendDir,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: pg.databaseUrl },
    timeout: 120_000,
  });

  setEnvForTests({ ...getEnv(), NODE_ENV: "test", LOG_LEVEL: "silent", COOKIE_SECRET, DATABASE_URL: pg.databaseUrl });
  database = createDatabase(pg.databaseUrl);
  built = await buildApp({ env: getEnv(), database });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  const quietly = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[desktop/ipc] ${label} failed:`, err);
    }
  };

  // Close the Prisma connection pool so no pg sockets linger in this worker.
  await quietly("prisma.disconnect", async () => {
    await database?.disconnect();
  });

  // Stop the embedded PostgreSQL cluster, then force-kill any process still
  // holding the test port or running from this data dir: the library's taskkill
  // can race or miss the postmaster on Windows, and an orphaned postmaster would
  // keep the forks worker alive. Vitest 5 forbids process.exit() in tests (it
  // turns a green suite red), so the worker exits on its own once every handle
  // is released.
  await quietly("pg.stop", async () => {
    await pg?.stop();
  });
  ensurePostgresStopped(process.env["DEV_PG_DATA_DIR"], Number(process.env["DEV_PG_PORT"]));
});

describe("ApiClient integration (real backend + embedded PostgreSQL)", () => {
  it("reports healthy when the backend is up", async () => {
    const client = new ApiClient(baseUrl);
    const health = await client.health();
    expect(health.status).toBe("ok");
  });

  it("registers, persists the session, and can list meetings on a fresh client", async () => {
    const storage = new MemoryStorage();
    const alice = new ApiClient(baseUrl, storage);
    const me = await alice.register({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: PASSWORD,
    });
    expect(me.user.email).toBe("ada@example.com");
    expect(alice.getExpiry()).toContain("20");

    const resurrected = new ApiClient(baseUrl, storage);
    const session = await resurrected.sessionInfo();
    expect(session.state).toBe("authenticated");
    if (session.state === "authenticated") {
      expect(session.user?.id).toBe(me.user.id);
    }

    const page = await resurrected.listMeetings({ page: 1, perPage: 20 });
    expect(page.items).toEqual([]);
  });

  it("throws ApiError with status 401 when unauthenticated", async () => {
    const anon = new ApiClient(baseUrl);
    const error = await anon.listMeetings().then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ApiError);
    if (error instanceof ApiError) {
      expect(error.status).toBe(401);
      expect(error.code).toBe("UNAUTHORIZED");
    }
  });

  it("rejects duplicate registration and bad credentials", async () => {
    const client = new ApiClient(baseUrl);
    const dup = await client
      .register({ name: "Ada Again", email: "ada@example.com", password: PASSWORD })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(dup).toBeInstanceOf(ApiError);
    if (dup instanceof ApiError) expect(dup.status).toBe(409);

    const badLogin = await client.login({ email: "ada@example.com", password: "wrong-password" }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(badLogin).toBeInstanceOf(ApiError);
    if (badLogin instanceof ApiError) expect(badLogin.status).toBe(401);
  });

  it("round-trips a meeting: create → detail → rename → delete", async () => {
    const storage = new MemoryStorage();
    const client = new ApiClient(baseUrl, storage);
    await client.register({ name: "Grace Hopper", email: "grace@example.com", password: PASSWORD });

    const created = await client.createMeeting({ title: "Ship it" });
    expect(created.title).toBe("Ship it");

    const detail = await client.getMeeting(created.id);
    expect(detail.meeting.id).toBe(created.id);

    const renamed = await client.updateMeeting(created.id, { title: "Ship it now" });
    expect(renamed.title).toBe("Ship it now");

    const updated = await client.getMeeting(created.id);
    expect(updated.meeting.title).toBe("Ship it now");

    await client.deleteMeeting(created.id);
    const list = await client.listMeetings();
    expect(list.items.some((m) => m.id === created.id)).toBe(false);
  });

  it("changes a password and rejects the old one afterwards", async () => {
    const client = new ApiClient(baseUrl);
    await client.register({ name: "Katherine Johnson", email: "katherine@example.com", password: PASSWORD });
    await client.changePassword({ currentPassword: PASSWORD, newPassword: "New-Password-9999" });

    const oldCreds = await client.login({ email: "katherine@example.com", password: PASSWORD }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(oldCreds).toBeInstanceOf(ApiError);
    if (oldCreds instanceof ApiError) expect(oldCreds.status).toBe(401);

    const newClient = await client.login({ email: "katherine@example.com", password: "New-Password-9999" });
    expect(newClient.user.email).toBe("katherine@example.com");
  });
});