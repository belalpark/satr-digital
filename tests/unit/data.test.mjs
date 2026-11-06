import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const data = JSON.parse(readFileSync(resolve(root, 'data/office.json'), 'utf8'));
const { width, height } = data.office.plan;
const ref = data.office.plan.reference;

test('room ids are unique and non-empty', () => {
  const ids = data.rooms.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-z0-9-]+$/.test(id)));
});

test('every polygon has >= 3 points inside the reference plan', () => {
  for (const r of data.rooms) {
    assert.ok(r.polygon.length >= 3, r.id);
    for (const [x, y] of r.polygon) {
      assert.ok(x >= 0 && x <= ref.width && y >= 0 && y <= ref.height, `${r.id} point ${x},${y}`);
    }
    assert.ok(r.label && r.label.x >= 0 && r.label.y >= 0, `${r.id} label`);
  }
});

test('no area fields anywhere in the record', () => {
  const text = JSON.stringify(data);
  assert.ok(!/"area[^"]*"\s*:/.test(text), 'area-like key found');
  assert.ok(!/م²|متر مربع/.test(text), 'area text found');
});

test('ready rooms are complete and their media exist', () => {
  const ready = data.rooms.filter((r) => r.status === 'ready');
  assert.ok(ready.length >= 1, 'at least one ready room');
  for (const r of ready) {
    assert.ok(r.photos.length >= 4, `${r.id} photos`);
    assert.ok(r.capacity && r.capacity.seats > 0 && r.capacity.basis, `${r.id} capacity`);
    assert.ok(r.fixtures && r.fixtures.items.length > 0 && r.fixtures.source, `${r.id} fixtures`);
    assert.ok(r.summary, `${r.id} summary`);
    for (const p of r.photos) {
      assert.ok(existsSync(resolve(root, p.src)), `missing ${p.src}`);
      assert.ok(existsSync(resolve(root, p.thumb)), `missing ${p.thumb}`);
      assert.ok(p.caption, `caption for ${p.src}`);
    }
  }
});

test('plan, focus and hero images exist', () => {
  assert.ok(existsSync(resolve(root, data.office.plan.image)));
  assert.ok(existsSync(resolve(root, data.office.heroImage)));
  for (const r of data.rooms.filter((x) => x.focus)) {
    assert.ok(existsSync(resolve(root, r.focus.image)), `focus image for ${r.id}`);
  }
});

test('3D plan carries floor and wall-top homographies', () => {
  for (const key of ['floor', 'top']) {
    const H = data.office.plan.homography[key];
    assert.equal(H.length, 9, key);
    assert.ok(H.every(Number.isFinite), key);
  }
  assert.ok(data.office.plan.focusFrame > 0 && data.office.plan.focusFrame <= 1);
});

test('every room polygon projects inside the rendered image', () => {
  const H = data.office.plan.homography.floor;
  const project = ([x, y]) => {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  };
  for (const r of data.rooms) {
    for (const p of r.polygon) {
      const [u, v] = project(p);
      assert.ok(u >= 0 && u <= width && v >= 0 && v <= height, `${r.id} ${p} -> ${u.toFixed(0)},${v.toFixed(0)}`);
    }
  }
});

test('ready rooms have a focus frame inside the image', () => {
  for (const r of data.rooms.filter((x) => x.status === 'ready')) {
    assert.ok(r.focus, `${r.id} focus`);
    const [x, y, w, h] = r.focus.rect;
    assert.ok(x >= 0 && y >= 0 && x + w <= width + 0.5 && y + h <= height + 0.5, `${r.id} rect`);
  }
});

test('welcome totals add up from the documented inventory', () => {
  const inv = new Map(data.office.inventory.items.map((i) => [i.name, i.count]));
  for (const h of data.office.welcome.highlights) {
    const sum = h.from.reduce((n, name) => {
      assert.ok(inv.has(name), `unknown inventory item ${name}`);
      return n + inv.get(name);
    }, 0);
    assert.equal(h.value, sum, h.label);
    if (h.dual) assert.equal(h.value, 2, `${h.label} is an Arabic dual`);
  }
});

test('no booking call to action and no proposed layouts', () => {
  const text = JSON.stringify(data);
  assert.ok(!('booking' in data.office), 'booking removed');
  assert.ok(!/احجز معاينة/.test(text));
  assert.ok(!/proposed/.test(text), 'proposed fields removed');
  assert.ok(!/التوأم الرقمي للمكتب/.test(text), 'old product name removed from the record');
});

test('scenes: current state and three coloured routes over existing rooms', () => {
  assert.deepEqual(Object.keys(data.scenes).sort(), ['current', 'paths']);
  const ids = new Set(data.rooms.map((r) => r.id));
  const routes = data.scenes.paths.routes;
  assert.deepEqual(routes.map((r) => r.id), ['employees', 'executive', 'guests']);
  assert.equal(new Set(routes.map((r) => r.color)).size, 3, 'three distinct colours');
  for (const r of routes) {
    assert.ok(r.points.length >= 2, r.id);
    assert.ok(r.stops.length >= 2, r.id);
    for (const s of r.stops) assert.ok(ids.has(s.roomId), `${r.id} stop ${s.roomId}`);
  }
});

test('every room has its current use', () => {
  for (const r of data.rooms) {
    assert.ok(r.use && r.use.current, r.id);
  }
});

test('routes only cross corridors, circulation zones or their own stop rooms', () => {
  const inside = ([px, py], poly) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  for (const route of data.scenes.paths.routes) {
    const allowed = new Set(route.stops.map((s) => s.roomId));
    for (const r of data.rooms) if (r.kind === 'circulation' && r.status !== 'info') allowed.add(r.id);
    for (let i = 1; i < route.points.length; i++) {
      const [x0, y0] = route.points[i - 1];
      const [x1, y1] = route.points[i];
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3);
      for (let k = 0; k <= steps; k++) {
        const p = [x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps];
        for (const r of data.rooms) {
          if (!allowed.has(r.id) && inside(p, r.polygon)) {
            assert.fail(`${route.id} crosses ${r.id} at ${p.map((v) => v.toFixed(0))}`);
          }
        }
      }
    }
  }
});

test('office.json camera data matches the published render (media/twin/twin.json)', () => {
  const twin = JSON.parse(readFileSync(resolve(root, 'media/twin/twin.json'), 'utf8'));
  const P = data.office.plan;
  assert.equal(P.width, twin.image.width);
  assert.equal(P.height, twin.image.height);
  assert.equal(P.focusFrame, twin.focusFrame);
  for (const key of ['floor', 'top']) {
    P.homography[key].forEach((v, i) => assert.ok(Math.abs(v - twin.homography[key][i]) < 1e-9, `${key}[${i}]`));
  }
  for (const r of data.rooms.filter((x) => x.focus)) {
    assert.deepEqual(r.focus.rect, twin.focus[r.id].rect, `${r.id} focus rect`);
  }
});
