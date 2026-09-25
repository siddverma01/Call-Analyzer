import { describe, expect, it } from "vitest";
import {
  firstName,
  formatDate,
  formatDateTime,
  formatDuration,
  formatRelative,
  initials,
  toDate,
  truncate,
} from "../src/renderer/src/lib/format";

describe("toDate", () => {
  it("returns null for empty or invalid input", () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("not-a-date")).toBeNull();
    expect(toDate("")).toBeNull();
  });

  it("parses ISO strings and preserves Date instances", () => {
    const iso = "2026-09-23T10:15:00.000Z";
    expect(toDate(iso)?.toISOString()).toBe(iso);
    const date = new Date(iso);
    expect(toDate(date)).toBe(date);
  });
});

describe("formatDuration", () => {
  it("handles non-positive and invalid inputs", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-5)).toBe("0m");
    expect(formatDuration(Number.NaN)).toBe("0m");
  });

  it("formats minutes and hours", () => {
    expect(formatDuration(90)).toBe("2m");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(3660)).toBe("1h 1m");
    expect(formatDuration(7250)).toBe("2h 1m");
  });
});

describe("formatDate / formatDateTime", () => {
  it("returns an em dash for null input", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
  });

  it("formats a valid date", () => {
    const formatted = formatDateTime("2026-09-23T10:15:00.000Z");
    expect(formatted).not.toBe("—");
    expect(formatted).toContain("2026");
  });
});

describe("formatRelative", () => {
  it("says just now for fresh timestamps", () => {
    expect(formatRelative(new Date().toISOString())).toBe("just now");
    expect(formatRelative(null)).toBe("—");
  });

  it("computes minute-, hour-, and day-based labels", () => {
    const now = Date.now();
    expect(formatRelative(new Date(now - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(formatRelative(new Date(now - 2 * 3_600_000).toISOString())).toBe("2h ago");
    expect(formatRelative(new Date(now - 4 * 86_400_000).toISOString())).toBe("4d ago");
  });
});

describe("person name helpers", () => {
  it("produces initials", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("Ada")).toBe("A");
    expect(initials("  ")).toBe("?");
  });

  it("extracts the first name", () => {
    expect(firstName("Ada Lovelace")).toBe("Ada");
    expect(firstName("Grace")).toBe("Grace");
  });
});

describe("truncate", () => {
  it("passes short strings through", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate(null)).toBe("");
  });

  it("truncates at the limit with an ellipsis", () => {
    const result = truncate("a".repeat(200), 10);
    expect(result).toHaveLength(11);
    expect(result.endsWith("…")).toBe(true);
  });
});