import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuiltApp } from "../src/app.ts";
import { setEnvForTests, getEnv } from "../src/env.ts";
import type { Database } from "../src/db/prisma.ts";
import { APP_VERSION } from "@callnotes/shared";

/** Database stub used when the test environment has no reachable PostgreSQL. */
function staleDatabase(): Database {
  return {
    async ping() {
      throw new Error("no database in test environment");
    },
    client: undefined as never,
    disconnect: async () => {},
  };
}

let built: BuiltApp;
let app: FastifyInstance;

beforeAll(async () => {
  setEnvForTests({
    ...getEnv(),
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgresql://nope",
    COOKIE_SECRET: getEnv().COOKIE_SECRET ?? "test-cookie-secret-0123456789abcdef0123456789abcdef",
  });
  built = await buildApp({ env: getEnv(), database: staleDatabase() });
  app = built.app;
  app.get("/boom", async () => {
    throw new Error("secret internal detail");
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await built.database.disconnect();
});

describe("health endpoints", () => {
  it("responds on /health with service metadata", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.service).toBe("callnotes-api");
    expect(body.version).toBe(APP_VERSION);
    expect(body.checks.database).toBe("down");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.timestamp).toBe("string");
  });

  it("responds on /health/database", async () => {
    const res = await app.inject({ method: "GET", url: "/health/database" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.components[0]?.name).toBe("database");
    expect(body.components[0]?.status).toBe("down");
  });

  it("responds on /health/ready with an aggregate status", async () => {
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("down");
  });
});

describe("version endpoint", () => {
  it("returns version and runtime details", async () => {
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    const body = res.json().version;
    expect(body.name).toBe("CallNotes AI");
    expect(body.version).toBe(APP_VERSION);
  });
});

describe("error handling", () => {
  it("returns 404 as a structured JSON body", async () => {
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ message: "Route GET:/api/does-not-exist not found" });
  });

  it("does not expose stack traces for internal errors", async () => {
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.json())).not.toContain("secret internal detail");
    expect(res.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });
});