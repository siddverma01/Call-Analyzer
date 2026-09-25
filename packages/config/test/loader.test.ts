import { describe, expect, it } from "vitest";
import { z } from "zod";
import { backendEnvSchema, loadConfig } from "@callnotes/config";

const COOKIE_SECRET = "test-cookie-secret-0123456789abcdef0123456789abcdef";

describe("config package", () => {
  it("applies defaults when variables are absent", () => {
    const parsed = backendEnvSchema.parse({ COOKIE_SECRET });
    expect(parsed.PORT).toBe(8080);
    expect(parsed.NODE_ENV).toBe("development");
    expect(parsed.CORS_ORIGINS).toEqual([]);
    expect(parsed.LOG_LEVEL).toBe("info");
  });

  it("coerces and splits CORS origins", () => {
    const parsed = backendEnvSchema.parse({
      COOKIE_SECRET,
      PORT: "9000",
      CORS_ORIGINS: "http://a.com, http://b.com,  ",
    });
    expect(parsed.PORT).toBe(9000);
    expect(parsed.CORS_ORIGINS).toEqual(["http://a.com", "http://b.com"]);
  });

  it("rejects invalid ports", () => {
    expect(() => backendEnvSchema.parse({ PORT: -1 })).toThrow();
    expect(() => backendEnvSchema.parse({ PORT: "not-a-port" })).toThrow();
  });

  it("loadConfig throws a clear error for invalid configuration", () => {
    const absentRequired = z.object({
      CALLNOTES_TEST_VAR_THAT_IS_NEVER_SET: z.string().min(1),
    });
    expect(() => loadConfig(absentRequired, { path: "./does-not-exist-ff.env" })).toThrow(
      /Invalid environment configuration: CALLNOTES_TEST_VAR_THAT_IS_NEVER_SET/,
    );
  });
});