import { describe, expect, it } from "vitest";
import { formatBytes, recommendModel } from "../../src/main/whisper/hardware";

const GB = 1024 * 1024 * 1024;

describe("recommendModel", () => {
  it("chooses tiny for machines under 4 GB RAM", () => {
    expect(recommendModel({ ramBytes: 3.5 * GB, cores: 2 })).toBe("tiny");
    expect(recommendModel({ ramBytes: 2 * GB, cores: 16 })).toBe("tiny");
  });

  it("chooses base for mid-range machines", () => {
    expect(recommendModel({ ramBytes: 4 * GB, cores: 4 })).toBe("base");
    expect(recommendModel({ ramBytes: 6 * GB, cores: 6 })).toBe("base");
  });

  it("chooses small for 7-13 GB machines", () => {
    expect(recommendModel({ ramBytes: 7 * GB, cores: 8 })).toBe("small");
    expect(recommendModel({ ramBytes: 13 * GB, cores: 16 })).toBe("small"); // 14+ needs a strong CPU for medium
  });

  it("drops to base when only 4 cores with 7-14 GB", () => {
    expect(recommendModel({ ramBytes: 7 * GB, cores: 4 })).toBe("small");
    expect(recommendModel({ ramBytes: 7 * GB, cores: 2 })).toBe("base");
  });

  it("chooses medium for big machines", () => {
    expect(recommendModel({ ramBytes: 16 * GB, cores: 8 })).toBe("medium");
    expect(recommendModel({ ramBytes: 64 * GB, cores: 32 })).toBe("medium");
  });
});

describe("formatBytes", () => {
  it("formats MB and GB", () => {
    expect(formatBytes(75 * 1024 * 1024)).toBe("75 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
});