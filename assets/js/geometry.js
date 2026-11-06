// Pure geometry helpers for the plan overlay. No DOM, fully unit-tested.

/** Axis-aligned bounding box of a polygon given as [[x,y], ...]. */
export function bbox(polygon) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Vertex average — good enough for label placement of near-rectangular rooms. */
export function centroid(polygon) {
  let sx = 0, sy = 0;
  for (const [x, y] of polygon) { sx += x; sy += y; }
  return { x: sx / polygon.length, y: sy / polygon.length };
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon([px, py], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Compute the CSS transform that centers `box` (in plan units) inside the
 * viewport. The plan is displayed "fitted" at `fitScale` (plan units -> css px)
 * and the transform is applied on top of that: translate(tx, ty) scale(scale),
 * with the transform origin at the top-left corner of the fitted plan.
 */
export function zoomTransform(box, viewport, { fitScale = 1, padding = 0.15, maxScale = 4 } = {}) {
  const bw = box.w * fitScale;
  const bh = box.h * fitScale;
  const availW = viewport.w * (1 - padding * 2);
  const availH = viewport.h * (1 - padding * 2);
  let scale = Math.min(availW / bw, availH / bh);
  if (!Number.isFinite(scale) || scale < 1) scale = 1;
  if (scale > maxScale) scale = maxScale;
  const cx = (box.x + box.w / 2) * fitScale;
  const cy = (box.y + box.h / 2) * fitScale;
  const tx = viewport.w / 2 - cx * scale;
  const ty = viewport.h / 2 - cy * scale;
  return { scale, tx, ty };
}

/** Total length of a polyline. Used to size the dash animation of paths. */
export function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    len += Math.hypot(dx, dy);
  }
  return len;
}

/** "x,y x,y ..." attribute string for SVG polygons/polylines. */
export function pointsAttr(points) {
  return points.map(([x, y]) => `${x},${y}`).join(' ');
}
