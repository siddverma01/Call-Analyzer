import { describe, expect, it } from "vitest";
import {
  clampToWorkArea,
  defaultOverlaySpot,
  dragOverlay,
  findDisplayForPoint,
  overlayPillSize,
  type WorkArea,
} from "../../src/main/overlay/overlay-position";

const PRIMARY: WorkArea = { displayId: 1, x: 0, y: 0, width: 1920, height: 1080 };
const SECONDARY: WorkArea = { displayId: 2, x: 1920, y: 0, width: 2560, height: 1440 };
const SIDE: WorkArea = { displayId: 3, x: 1920 + 2560, y: 0, width: 1280, height: 1024 };

const SIZE = overlayPillSize();

describe("findDisplayForPoint", () => {
  it("selects the display containing the cursor", () => {
    expect(findDisplayForPoint([PRIMARY, SECONDARY, SIDE], { x: 2000, y: 200 })).toBe(SECONDARY);
  });

  it("falls back to the first display's center for out-of-bounds points", () => {
    expect(findDisplayForPoint([PRIMARY, SECONDARY], { x: -5000, y: -5000 })).toBe(PRIMARY);
  });
});

describe("defaultOverlaySpot", () => {
  it("sits top-right of the cursor's display with the edge margin", () => {
    const spot = defaultOverlaySpot([PRIMARY, SECONDARY, SIDE], { x: 3000, y: 300 }, SIZE);
    expect(spot.displayId).toBe(SECONDARY.displayId);
    expect(spot.pos.x).toBe(SECONDARY.x + SECONDARY.width - SIZE.width - 16);
    expect(spot.pos.y).toBe(SECONDARY.y + 16);
  });

  it("keeps the pill fully inside short displays", () => {
    const small = defaultOverlaySpot([SIDE], { x: SIDE.x + 10, y: SIDE.y + 10 }, SIZE);
    expect(small.pos.y).toBeGreaterThanOrEqual(SIDE.y);
    expect(small.pos.y + SIZE.height).toBeLessThanOrEqual(SIDE.y + SIDE.height);
  });
});

describe("clampToWorkArea", () => {
  it("slides the rect back inside when it overflows the right edge", () => {
    const rect = clampToWorkArea({ x: 1850, y: 0, width: 200, height: 60 }, PRIMARY);
    expect(rect.x + rect.width).toBe(PRIMARY.x + PRIMARY.width);
  });

  it("slides it back inside when it overflows the top", () => {
    const rect = clampToWorkArea({ x: 0, y: -80, width: 200, height: 60 }, PRIMARY);
    expect(rect.y).toBe(PRIMARY.y);
  });
});

describe("dragOverlay", () => {
  it("applies a delta and keeps the pill on the same display", () => {
    const moved = dragOverlay({ pos: { x: 100, y: 100 }, displayId: 1 }, { dx: 50, dy: 30 }, [PRIMARY, SECONDARY], SIZE);
    expect(moved.pos).toEqual({ x: 150, y: 130 });
  });

  it("clamps the drag so the pill never leaves the work area", () => {
    const moved = dragOverlay(
      { pos: { x: 1900, y: 100 }, displayId: 1 },
      { dx: 500, dy: -2000 },
      [PRIMARY, SECONDARY],
      SIZE,
    );
    expect(moved.pos.x + SIZE.width).toBeLessThanOrEqual(PRIMARY.x + PRIMARY.width);
    expect(moved.pos.y).toBeGreaterThanOrEqual(PRIMARY.y);
  });

  it("clamps into whichever display the pill currently sits on", () => {
    const moved = dragOverlay(
      { pos: { x: 1880, y: 100 }, displayId: 1 },
      { dx: 1000, dy: 0 },
      [PRIMARY, SECONDARY],
      SIZE,
    );
    expect(moved.pos.x + SIZE.width).toBe(PRIMARY.x + PRIMARY.width);
    expect(moved.pos.x).toBe(PRIMARY.x + PRIMARY.width - SIZE.width);
    expect(moved.displayId).toBe(1);
  });
});