import { describe, expect, it } from "vitest";
import { PcmRingBuffer } from "../../src/main/audio/dsp/ring-buffer";

describe("PcmRingBuffer", () => {
  it("writes and reads oldest-first", () => {
    const rb = new PcmRingBuffer(8);
    rb.write([1, 2, 3, 4]);
    expect(rb.size).toBe(4);
    expect(Array.from(rb.read(10))).toEqual([1, 2, 3, 4]);
    expect(rb.size).toBe(0);
  });

  it("reads in bounded chunks", () => {
    const rb = new PcmRingBuffer(8);
    rb.write([1, 2, 3, 4, 5]);
    expect(Array.from(rb.read(2))).toEqual([1, 2]);
    expect(Array.from(rb.read(2))).toEqual([3, 4]);
    expect(Array.from(rb.read(2))).toEqual([5]);
  });

  it("overwrites oldest samples once full (never grows)", () => {
    const rb = new PcmRingBuffer(4);
    rb.write([1, 2, 3, 4]);
    rb.write([5, 6]);
    expect(rb.capacity).toBe(4);
    expect(rb.size).toBe(4);
    expect(Array.from(rb.read(4))).toEqual([3, 4, 5, 6]);
  });

  it("drops everything when a single write exceeds capacity", () => {
    const rb = new PcmRingBuffer(4);
    rb.write([1, 2, 3, 4]);
    rb.write([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(Array.from(rb.read(10))).toEqual([4, 3, 2, 1]);
  });

  it("round-trips through full capacity and back to empty", () => {
    const rb = new PcmRingBuffer(8);
    for (const chunk of [[1, 2, 3], [4, 5], [6, 7, 8, 9]]) rb.write(chunk);
    expect(rb.size).toBe(8);
    expect(Array.from(rb.read(3))).toEqual([2, 3, 4]);
    expect(rb.isEmpty).toBe(false);
    rb.clear();
    expect(rb.isEmpty).toBe(true);
    expect(rb.read(5)).toHaveLength(0);
  });

  it("peeks without consuming", () => {
    const rb = new PcmRingBuffer(8);
    rb.write([1, 2, 3]);
    expect(Array.from(rb.peek(2))).toEqual([1, 2]);
    expect(rb.size).toBe(3);
  });

  it("rejects non-positive capacity", () => {
    expect(() => new PcmRingBuffer(0)).toThrow();
  });
});