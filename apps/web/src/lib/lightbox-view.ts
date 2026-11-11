export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type View = Point & { scale: number };
export type Bounds = { stage: Size; image: Size; pad?: number };

export function fitScale({ stage, image, pad = 16 }: Bounds) {
  return Math.min(
    1,
    Math.max(1, stage.width - 2 * pad) / image.width,
    Math.max(1, stage.height - 2 * pad) / image.height,
  );
}

export function maxScale(bounds: Bounds) {
  return Math.max(4, fitScale(bounds));
}

function boundedScale(scale: number, bounds: Bounds) {
  return Math.min(maxScale(bounds), Math.max(fitScale(bounds), scale));
}

export function clampView(view: View, bounds: Bounds): View {
  const scale = boundedScale(view.scale, bounds);
  const axis = (position: number, stage: number, image: number) =>
    image <= stage ? (stage - image) / 2 : Math.min(0, Math.max(stage - image, position));
  return {
    scale,
    x: axis(view.x, bounds.stage.width, bounds.image.width * scale),
    y: axis(view.y, bounds.stage.height, bounds.image.height * scale),
  };
}

export function fitView(bounds: Bounds): View {
  return clampView({ x: 0, y: 0, scale: fitScale(bounds) }, bounds);
}

/** Move one keyboard step (15% of the stage) along each requested axis. */
export function panStep(view: View, dx: number, dy: number, bounds: Bounds): View {
  return clampView(
    { ...view, x: view.x + dx * bounds.stage.width * 0.15, y: view.y + dy * bounds.stage.height * 0.15 },
    bounds,
  );
}

export function isAtFit(view: View, bounds: Bounds) {
  return Math.abs(view.scale - fitScale(bounds)) < 0.000001;
}

export function zoomAt(view: View, nextScale: number, point: Point, bounds: Bounds): View {
  const scale = boundedScale(nextScale, bounds);
  const ratio = scale / view.scale;
  return clampView({ scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, bounds);
}

export function toggleZoom(view: View, point: Point, bounds: Bounds) {
  return zoomAt(view, view.scale < 1 ? 1 : !isAtFit(view, bounds) ? fitScale(bounds) : 2, point, bounds);
}

export const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Keep the image point under the old midpoint beneath the moving midpoint, then clamp once. */
export function pinchView(view: View, from: [Point, Point], to: [Point, Point], bounds: Bounds): View {
  const before = midpoint(...from);
  const after = midpoint(...to);
  const scale = boundedScale(view.scale * (distance(...to) / Math.max(1, distance(...from))), bounds);
  const ratio = scale / view.scale;
  return clampView(
    { scale, x: after.x - (before.x - view.x) * ratio, y: after.y - (before.y - view.y) * ratio },
    bounds,
  );
}

export type Gesture = {
  start: Point;
  end: Point;
  maxDistance: number;
  zoomed: boolean;
  pinched: boolean;
};

export function classifyGesture({ start, end, maxDistance, zoomed, pinched }: Gesture) {
  if (pinched) return "none";
  if (Math.max(maxDistance, distance(start, end)) <= 6) return "tap";
  if (zoomed) return "pan";
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) >= 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) return dx < 0 ? "next" : "previous";
  return "none";
}

export function wheelScale(scale: number, deltaY: number, deltaMode: number, stageHeight: number) {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? stageHeight : 1);
  return scale * Math.exp(-pixels * 0.002);
}
