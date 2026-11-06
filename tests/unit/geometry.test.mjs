import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bbox, centroid, pointInPolygon, zoomTransform, pathLength, applyHomography, projectPoints, convexHull, pathData, bboxOf } from '../../assets/js/geometry.js';

const rect = [[0, 0], [10, 0], [10, 20], [0, 20]];

test('bbox of a rectangle', () => {
  assert.deepEqual(bbox(rect), { x: 0, y: 0, w: 10, h: 20 });
});

test('bbox of an L-shaped polygon', () => {
  const L = [[165, 105], [250, 105], [250, 38], [492, 38], [492, 242], [165, 242]];
  assert.deepEqual(bbox(L), { x: 165, y: 38, w: 327, h: 204 });
});

test('centroid is the vertex average', () => {
  assert.deepEqual(centroid(rect), { x: 5, y: 10 });
});

test('pointInPolygon inside/outside/edge-ish', () => {
  assert.equal(pointInPolygon([5, 5], rect), true);
  assert.equal(pointInPolygon([15, 5], rect), false);
  assert.equal(pointInPolygon([-1, 10], rect), false);
});

test('zoomTransform centers the box in the viewport', () => {
  const box = { x: 100, y: 100, w: 100, h: 100 };
  const opts = { fitScale: 0.5, padding: 0.1, maxScale: 4 };
  const t = zoomTransform(box, { w: 1000, h: 800 }, opts);
  assert.ok(t.scale <= 4, 'scale capped');
  // The box center in "fitted" pixels is (150*0.5, 150*0.5) = (75,75).
  // After translate+scale it must land on the viewport center.
  const cx = 75 * t.scale + t.tx;
  const cy = 75 * t.scale + t.ty;
  assert.ok(Math.abs(cx - 500) < 1e-6, `cx=${cx}`);
  assert.ok(Math.abs(cy - 400) < 1e-6, `cy=${cy}`);
});

test('zoomTransform recomputes for a different viewport (rotation)', () => {
  const box = { x: 100, y: 100, w: 100, h: 100 };
  const opts = { fitScale: 0.5, padding: 0.1, maxScale: 4 };
  const t = zoomTransform(box, { w: 400, h: 800 }, opts);
  const cx = 75 * t.scale + t.tx;
  const cy = 75 * t.scale + t.ty;
  assert.ok(Math.abs(cx - 200) < 1e-6);
  assert.ok(Math.abs(cy - 400) < 1e-6);
});

test('zoomTransform never zooms out below 1', () => {
  const box = { x: 0, y: 0, w: 1309, h: 1201 };
  const t = zoomTransform(box, { w: 300, h: 300 }, { fitScale: 1, padding: 0.1, maxScale: 4 });
  assert.equal(t.scale, 1);
});

test('pathLength sums segment lengths', () => {
  assert.equal(pathLength([[0, 0], [3, 4], [3, 10]]), 11);
});

test('identity and affine homographies', () => {
  assert.deepEqual(applyHomography([1, 0, 0, 0, 1, 0, 0, 0, 1], [3, 4]), [3, 4]);
  assert.deepEqual(applyHomography([2, 0, 5, 0, 3, -1, 0, 0, 1], [1, 1]), [7, 2]);
});

test('perspective homography divides by w', () => {
  // w = 0.5 * x + 1 -> point (2, 0) maps to (2/2, 0/2) = (1, 0)
  const [u, v] = applyHomography([1, 0, 0, 0, 1, 0, 0.5, 0, 1], [2, 0]);
  assert.equal(u, 1);
  assert.equal(v, 0);
  assert.deepEqual(projectPoints([1, 0, 0, 0, 1, 0, 0, 0, 1], [[1, 2], [3, 4]]), [[1, 2], [3, 4]]);
});

test('convex hull drops interior points', () => {
  const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [2, 8]]);
  assert.equal(hull.length, 4);
  for (const p of [[0, 0], [10, 0], [10, 10], [0, 10]]) assert.ok(hull.some((q) => q[0] === p[0] && q[1] === p[1]));
});

test('path data and combined bbox', () => {
  assert.equal(pathData([[0, 0], [1.25, 0], [1, 1]]), 'M0 0L1.3 0L1 1Z');
  assert.deepEqual(bboxOf([[0, 0], [1, 1]], [[5, -2]]), { x: 0, y: -2, w: 5, h: 3 });
});
