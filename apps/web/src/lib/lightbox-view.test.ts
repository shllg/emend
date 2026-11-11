import { describe, expect, test } from "vitest";
import {
  type Bounds,
  clampView,
  classifyGesture,
  fitScale,
  fitView,
  panStep,
  pinchView,
  toggleZoom,
  wheelScale,
  zoomAt,
} from "./lightbox-view.ts";

const bounds: Bounds = { stage: { width: 800, height: 600 }, image: { width: 1600, height: 1200 }, pad: 0 };

test("fit respects both stage axes and padding and never upscales small images", () => {
  expect(fitScale(bounds)).toBe(0.5);
  expect(fitScale({ ...bounds, pad: 20 })).toBeCloseTo(560 / 1200);
  expect(fitScale({ ...bounds, stage: { width: 400, height: 600 } })).toBe(0.25);
  expect(fitScale({ ...bounds, image: { width: 40, height: 30 } })).toBe(1);
  expect(fitScale({ ...bounds, stage: { width: 1, height: 1 }, pad: 20 })).toBeGreaterThan(0);
});

test("clamp centres each small axis and holds each large axis's edges", () => {
  const small = { ...bounds, image: { width: 100, height: 50 } };
  expect(clampView({ x: -900, y: 800, scale: 1 }, small)).toEqual({ x: 350, y: 275, scale: 1 });
  expect(clampView({ x: 100, y: -2000, scale: 1 }, bounds)).toEqual({ x: 0, y: -600, scale: 1 });
  expect(clampView({ x: -2000, y: 100, scale: 1 }, bounds)).toEqual({ x: -800, y: 0, scale: 1 });
  expect(clampView({ x: -100, y: -100, scale: 1 }, { ...bounds, image: { width: 1600, height: 50 } })).toEqual({
    x: -100,
    y: 275,
    scale: 1,
  });
});

test("zoom preserves the image point under the cursor until an edge requires clamping", () => {
  const initial = fitView(bounds);
  const point = { x: 300, y: 200 };
  const zoomed = zoomAt(initial, 1, point, bounds);
  expect(zoomed).toEqual({ x: -300, y: -200, scale: 1 });
  expect((point.x - zoomed.x) / zoomed.scale).toBe((point.x - initial.x) / initial.scale);
  expect((point.y - zoomed.y) / zoomed.scale).toBe((point.y - initial.y) / initial.scale);
  expect(zoomAt(initial, 99, point, bounds).scale).toBe(4);
  expect(zoomAt(zoomed, 0.01, point, bounds)).toEqual(initial);
});

test("panStep moves by 15% of the stage and clamps at the image edges", () => {
  const view = { scale: 1, x: -400, y: -300 };
  expect(panStep(view, -1, 0, bounds)).toEqual({ ...view, x: -520 });
  expect(panStep(view, 1, 0, bounds)).toEqual({ ...view, x: -280 });
  expect(panStep(view, 0, -1, bounds)).toEqual({ ...view, y: -390 });
  expect(panStep(view, 0, 1, bounds)).toEqual({ ...view, y: -210 });
  expect(panStep({ ...view, x: -790, y: -590 }, -1, -1, bounds)).toEqual({ ...view, x: -800, y: -600 });
  expect(panStep({ ...view, x: -10, y: -10 }, 1, 1, bounds)).toEqual({ ...view, x: 0, y: 0 });
  expect(panStep(fitView(bounds), -1, 1, bounds)).toEqual(fitView(bounds));
});

test("tap toggles fit → natural size → fit, or doubles a small image", () => {
  const point = { x: 400, y: 300 };
  const full = toggleZoom(fitView(bounds), point, bounds);
  expect(full.scale).toBe(1);
  expect(toggleZoom(full, point, bounds)).toEqual(fitView(bounds));
  const small = { ...bounds, image: { width: 100, height: 50 } };
  const twice = toggleZoom(fitView(small), point, small);
  expect(twice.scale).toBe(2);
  expect(toggleZoom(twice, point, small)).toEqual(fitView(small));
});

test("pinch scales by the distance ratio and follows the moving midpoint", () => {
  const start = { scale: 1, x: -400, y: -300 };
  const zoomed = pinchView(
    start,
    [
      { x: 300, y: 300 },
      { x: 500, y: 300 },
    ],
    [
      { x: 300, y: 320 },
      { x: 700, y: 320 },
    ],
    bounds,
  );
  expect(zoomed).toEqual({ scale: 2, x: -1100, y: -880 });
  expect((500 - zoomed.x) / zoomed.scale).toBe((400 - start.x) / start.scale);
  expect((320 - zoomed.y) / zoomed.scale).toBe((300 - start.y) / start.scale);
  const translated = pinchView(
    start,
    [
      { x: 300, y: 300 },
      { x: 500, y: 300 },
    ],
    [
      { x: 350, y: 330 },
      { x: 550, y: 330 },
    ],
    bounds,
  );
  expect(translated).toEqual({ scale: 1, x: -350, y: -270 });
  const limited = pinchView(
    start,
    [
      { x: 300, y: 300 },
      { x: 500, y: 300 },
    ],
    [
      { x: 0, y: 300 },
      { x: 2000, y: 300 },
    ],
    bounds,
  );
  expect(limited.scale).toBe(4);
});

describe("gesture classification", () => {
  test.each([
    [{ x: 3, y: 2 }, false, false, 4, "tap"],
    [{ x: -60, y: 10 }, false, false, 61, "next"],
    [{ x: 60, y: 10 }, false, false, 61, "previous"],
    [{ x: 60, y: 80 }, false, false, 100, "none"],
    [{ x: 0, y: 100 }, false, false, 100, "none"],
    [{ x: -60, y: 0 }, true, false, 60, "pan"],
    [{ x: -60, y: 0 }, false, true, 60, "none"],
    [{ x: 0, y: 0 }, false, true, 0, "none"],
    [{ x: 0, y: 0 }, false, false, 20, "none"],
  ] as const)("%j zoomed=%s pinched=%s distance=%s → %s", (end, zoomed, pinched, maxDistance, expected) => {
    expect(classifyGesture({ start: { x: 0, y: 0 }, end, zoomed, pinched, maxDistance })).toBe(expected);
  });
});

test("wheel zoom normalizes line and page units", () => {
  expect(wheelScale(1, 1, 1, 600)).toBe(wheelScale(1, 16, 0, 600));
  expect(wheelScale(1, 1, 2, 600)).toBe(wheelScale(1, 600, 0, 600));
  expect(wheelScale(1, -100, 0, 600)).toBeGreaterThan(1);
});
