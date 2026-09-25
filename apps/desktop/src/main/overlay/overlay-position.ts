import { OVERLAY_EDGE_MARGIN, OVERLAY_PILL_HEIGHT, OVERLAY_PILL_WIDTH } from "@callnotes/shared";

/**
 * Pure geometry for the floating overlay window. Kept free of Electron so the
 * positioning + multi-monitor clamping rules stay unit-testable.
 */

export interface WorkArea {
  displayId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function pointInWorkArea(point: Point, work: WorkArea): boolean {
  return (
    point.x >= work.x &&
    point.x < work.x + work.width &&
    point.y >= work.y &&
    point.y < work.y + work.height
  );
}

/** Display containing the point; falls back to the first display's center. */
export function findDisplayForPoint(displays: WorkArea[], point: Point): WorkArea {
  const hit = displays.find((d) => pointInWorkArea(point, d));
  if (hit) return hit;
  if (displays.length === 0) return { displayId: 0, x: 0, y: 0, width: 1280, height: 720 };
  const first = displays[0] as WorkArea;
  return findDisplayForPoint(displays, {
    x: first.x + first.width / 2,
    y: first.y + first.height / 2,
  });
}

/** Keeps the whole rect inside the work area, sliding it in from either side. */
export function clampToWorkArea(rect: Rect, work: WorkArea): Rect {
  const w = Math.min(rect.width, work.width);
  const h = Math.min(rect.height, work.height);
  let x = rect.x;
  let y = rect.y;
  if (x < work.x) x = work.x;
  if (x + w > work.x + work.width) x = work.x + work.width - w;
  if (y < work.y) y = work.y;
  if (y + h > work.y + work.height) y = work.y + work.height - h;
  return { x, y, width: w, height: h };
}

/** Default spot: flush to the top-right of the display under the cursor. */
export function defaultOverlaySpot(
  displays: WorkArea[],
  cursor: Point,
  size: { width: number; height: number },
): { displayId: number; pos: Point } {
  const display = findDisplayForPoint(displays, cursor);
  const rect = clampToWorkArea(
    {
      x: display.x + display.width - size.width - OVERLAY_EDGE_MARGIN,
      y: display.y + OVERLAY_EDGE_MARGIN,
      width: size.width,
      height: size.height,
    },
    display,
  );
  return { displayId: display.displayId, pos: { x: rect.x, y: rect.y } };
}

/** Moves the pill by a drag delta, clamped to the display it sits on. */
export function dragOverlay(
  current: { pos: Point; displayId: number },
  delta: { dx: number; dy: number },
  displays: WorkArea[],
  size: { width: number; height: number },
): { pos: Point; displayId: number } {
  const display = displays.find((d) => d.displayId === current.displayId) ?? displays[0];
  if (!display) return current;
  const rect = clampToWorkArea(
    {
      x: current.pos.x + delta.dx,
      y: current.pos.y + delta.dy,
      width: size.width,
      height: size.height,
    },
    display,
  );
  return { pos: { x: rect.x, y: rect.y }, displayId: display.displayId };
}

export function overlayPillSize(): { width: number; height: number } {
  return { width: OVERLAY_PILL_WIDTH, height: OVERLAY_PILL_HEIGHT };
}