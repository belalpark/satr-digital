import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const data = JSON.parse(readFileSync(resolve(root, 'data/office.json'), 'utf8'));
const { width, height } = data.office.plan;

test('room ids are unique and non-empty', () => {
  const ids = data.rooms.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-z0-9-]+$/.test(id)));
});

test('every polygon has >= 3 points inside the plan bounds', () => {
  for (const r of data.rooms) {
    assert.ok(r.polygon.length >= 3, r.id);
    for (const [x, y] of r.polygon) {
      assert.ok(x >= 0 && x <= width && y >= 0 && y <= height, `${r.id} point ${x},${y}`);
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

test('plan and hero images exist', () => {
  assert.ok(existsSync(resolve(root, data.office.plan.image)));
  assert.ok(existsSync(resolve(root, data.office.heroImage)));
});

test('scenes reference existing rooms', () => {
  const ids = new Set(data.rooms.map((r) => r.id));
  const vp = data.scenes['visitor-path'];
  assert.ok(vp.waypoints.length >= 2);
  for (const s of vp.stops) assert.ok(ids.has(s.roomId), `stop ${s.roomId}`);
  const tl = data.scenes['team-layout'];
  for (const g of tl.groups) for (const id of g.rooms) assert.ok(ids.has(id), `group ${g.id} -> ${id}`);
  for (const c of tl.seatClusters) assert.ok(ids.has(c.roomId), `cluster ${c.roomId}`);
  const seats = tl.seatClusters.reduce((n, c) => n + c.seats, 0);
  assert.ok(seats > 0);
});

test('every room has current and proposed use text', () => {
  for (const r of data.rooms) {
    assert.ok(r.use && r.use.current && r.use.proposed, r.id);
  }
});
