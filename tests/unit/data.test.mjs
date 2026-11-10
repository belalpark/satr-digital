import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
    if (!r.polygon) { assert.equal(r.hasModel, false, `${r.id}: a room without a polygon cannot be in the model`); continue; }
    assert.ok(r.polygon.length >= 3, r.id);
    for (const [x, y] of r.polygon) {
      assert.ok(x >= 0 && x <= ref.width && y >= 0 && y <= ref.height, `${r.id} point ${x},${y}`);
    }
    assert.ok(r.label && r.label.x >= 0 && r.label.y >= 0, `${r.id} label`);
  }
});

test('the office area appears only as the agreed welcome figure (owner, 2026-11-08)', () => {
  const { facts, ...rest } = data.office.welcome;
  const others = JSON.stringify({ ...data, office: { ...data.office, welcome: rest } });
  assert.ok(!/"area[^"]*"\s*:/.test(others), 'area-like key found');
  assert.ok(!/م²|متر مربع/.test(others), 'area text outside the welcome figures');
  const area = facts.find((f) => f.unit === 'م²');
  assert.equal(area.value, '890');
  assert.equal(area.label, 'مساحة المكتب');
});

test('every room with photos has existing media and captions', () => {
  const withPhotos = data.rooms.filter((r) => r.hasPhotos);
  assert.ok(withPhotos.length >= 1, 'at least one room with photos');
  for (const r of withPhotos) {
    assert.ok(r.photos.length >= 1, `${r.id} photos`);
    for (const p of r.photos) {
      assert.ok(existsSync(resolve(root, p.src)), `missing ${p.src}`);
      assert.ok(existsSync(resolve(root, p.thumb)), `missing ${p.thumb}`);
      assert.ok(p.caption && !/م²|متر|DRC/i.test(p.caption), `caption for ${p.src}`);
    }
  }
  for (const r of data.rooms) {
    assert.equal(r.hasPhotos, (r.photos || []).length > 0, `${r.id} hasPhotos flag`);
    assert.equal(r.status === 'ready', r.hasPhotos || (r.hasModel && r.status !== 'info'), `${r.id} ready status`);
  }
  // the first fully documented room keeps its full record
  const ml = data.rooms.find((r) => r.id === 'meeting-large');
  assert.ok(ml.capacity && ml.capacity.seats === 16 && ml.fixtures.items.length > 0 && ml.summary);
});

test('plan, model, focus and hero images exist', () => {
  assert.ok(existsSync(resolve(root, data.office.plan.image)));
  assert.ok(existsSync(resolve(root, data.office.heroImage)), 'hero perspective');
  assert.ok(existsSync(resolve(root, data.office.heroFallback)), 'hero fallback');
  assert.ok(existsSync(resolve(root, data.office.model.glb)), 'web model');
  assert.ok(existsSync(resolve(root, data.office.model.scene)), 'web scene data');
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
    for (const p of r.polygon || []) {
      const [u, v] = project(p);
      assert.ok(u >= 0 && u <= width && v >= 0 && v <= height, `${r.id} ${p} -> ${u.toFixed(0)},${v.toFixed(0)}`);
    }
  }
});

test('room perspective renders (where present) exist and only belong to modelled rooms', () => {
  const rendered = data.rooms.filter((r) => r.render);
  assert.ok(rendered.length >= 10, `expected the main rooms to carry a render, got ${rendered.length}`);
  for (const r of rendered) {
    assert.notEqual(r.hasModel, false, `${r.id} has no model but carries a render`);
    // the host caches images for a month: the address carries the file's fingerprint, so a re-render is seen at once
    const m = r.render.image.match(/^(media\/twin\/rooms\/[a-z0-9-]+\.webp)\?v=([0-9a-f]{10})$/);
    assert.ok(m, `${r.id} render path with its fingerprint (${r.render.image})`);
    assert.ok(existsSync(resolve(root, m[1])), `missing ${m[1]}`);
    assert.equal(m[2], createHash('sha1').update(readFileSync(resolve(root, m[1]))).digest('hex').slice(0, 10), `${r.id}: the fingerprint is the file's (run tools/twin/finish_rooms.py --restamp)`);
    assert.ok(r.render.width > r.render.height, `${r.id} render is landscape`);
  }
});

test('focus frames (where present) lie inside the image', () => {
  for (const r of data.rooms.filter((x) => x.focus)) {
    const [x, y, w, h] = r.focus.rect;
    assert.ok(x >= 0 && y >= 0 && x + w <= width + 0.5 && y + h <= height + 0.5, `${r.id} rect`);
  }
});

test('welcome copy: the acquisition opportunity first, the two agreed figures, then the tour', () => {
  const w = data.office.welcome;
  assert.equal(w.eyebrow, 'فرصة استحواذ');
  assert.equal(w.headlineLead, 'مكتب مجهّز في');
  assert.match(w.location, /^واجهة روشن للأعمال · الرياض$/);
  assert.deepEqual(w.facts.map((f) => [f.value, f.label]), [['890', 'مساحة المكتب'], ['72', 'مكتبًا']], 'exactly the owner\'s figures');
  assert.ok(!('highlights' in w), 'no other totals on the welcome');
  // owner's wording (2026-11-08): a gold line, then the one-sentence promise
  assert.equal(w.subtitle, 'مساحة تليق بأعمالك');
  assert.match(w.atmosphere, /^مقر إداري مفروش ومجهّز يجمع فريقك في مكان واحد$/);
  assert.equal(w.cta, 'ابدأ الجولة');
});

test('footer: condensed Satr essentials — both phone numbers, general location, no invented e-mail', () => {
  const f = data.office.footer;
  assert.equal(f.name, 'شركة سطر العقارية');
  assert.match(f.tagline, /نفهم الأصل/);
  const numbers = f.phones.map((p) => p.display);
  assert.deepEqual(numbers, ['+966 55 585 5057', '+966 54 417 1356'], 'Satr number first, the extra number beside it');
  for (const p of f.phones) assert.match(p.tel, /^\+9665\d{8}$/, `${p.display} tel link`);
  assert.match(f.location, /واجهة روشن للأعمال/);
  assert.ok(!/mailto:|[\w.]+@[\w-]+\.[a-z]{2,}/i.test(JSON.stringify(f)), 'no e-mail address is shown (the site hides it)');
  assert.ok(f.social.length >= 4 && f.social.every((s) => /^https:\/\//.test(s.href)));
  assert.match(f.copyright, /سطر العقارية/);
  assert.match(data.office.welcome.location, /واجهة روشن للأعمال/);
  const b = data.office.brand;
  assert.equal(b.name, 'سطر العقارية');
  assert.ok(b.logo === null || existsSync(resolve(root, b.logo)), 'brand logo file exists when set');
});

test('no booking call to action and no proposed layouts', () => {
  const text = JSON.stringify(data);
  assert.ok(!('booking' in data.office), 'booking removed');
  assert.ok(!/احجز معاينة/.test(text));
  assert.ok(!/proposed/.test(text), 'proposed fields removed');
  assert.ok(!/التوأم الرقمي للمكتب/.test(text), 'old product name removed from the record');
  assert.ok(!/الوضع الحالي/.test(JSON.stringify(data.scenes)), 'scene renamed to توزيعات المكاتب');
});

test('scenes: current state and three coloured routes over existing rooms', () => {
  assert.deepEqual(Object.keys(data.scenes).sort(), ['current', 'paths']);
  const ids = new Set(data.rooms.map((r) => r.id));
  const routes = data.scenes.paths.routes;
  assert.deepEqual(routes.map((r) => r.id), ['employees', 'executive', 'guests']);
  // employees loop past every employee office area; guests reach both meeting rooms and the lounge
  const empStops = new Set(routes[0].stops.map((s) => s.roomId));
  // the client's key plan: employee offices are 03a-03f (open-a, field-qc, finance, inner-1, research, hr-pmo-ops)
  for (const r of data.rooms.filter((x) => x.key && x.key.startsWith('03'))) assert.ok(empStops.has(r.id), `employees -> ${r.id} (${r.key})`);
  const guestStops = new Set(routes[2].stops.map((s) => s.roomId));
  for (const id of ['meeting-medium', 'meeting-large', 'lounge', 'reception']) assert.ok(guestStops.has(id), `guests -> ${id}`);
  const emp = routes[0].points;
  assert.deepEqual(emp[0], emp[emp.length - 1], 'the employee loop returns to the lobby');
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

test('web model scene data matches the office record', () => {
  const sceneInfo = JSON.parse(readFileSync(resolve(root, data.office.model.scene), 'utf8'));
  const ids = new Set(data.rooms.map((r) => r.id));
  assert.equal(sceneInfo.rooms.length, data.rooms.filter((r) => r.polygon).length, 'one anchor per room with a floor polygon');
  for (const a of sceneInfo.rooms) {
    assert.ok(ids.has(a.id), `anchor for unknown room ${a.id}`);
    assert.ok(a.floor.length >= 3 && a.label.length === 2, a.id);
  }
  assert.equal(sceneInfo.scale, ref.pxPerMetre, 'same plan scale');
  assert.ok(sceneInfo.lights.length > 10, 'ceiling light pools exported');
  // plan px -> metres mapping used by the viewer must reproduce the exported anchors
  const ml = data.rooms.find((r) => r.id === 'meeting-large');
  const a = sceneInfo.rooms.find((r) => r.id === 'meeting-large');
  const [px, py] = ml.polygon[0];
  const x = (px - sceneInfo.origin.cx) / sceneInfo.scale;
  const y = -(py - sceneInfo.origin.cy) / sceneInfo.scale;
  assert.ok(Math.abs(x - a.floor[0][0]) < 1e-3 && Math.abs(y - a.floor[0][1]) < 1e-3, 'anchor projection');
});

test('every room declares its dot capabilities consistently', () => {
  for (const r of data.rooms) {
    assert.equal(typeof r.hasModel, 'boolean', `${r.id} hasModel`);
    assert.equal(typeof r.hasPhotos, 'boolean', `${r.id} hasPhotos`);
    if (r.hasPhotos) assert.ok(r.photos.length > 0, `${r.id} photos`);
  }
  assert.ok(data.rooms.filter((r) => r.hasPhotos).length >= 20, 'most rooms have real photos now');
});

test('2D plan: a light base image plus a full set of high-resolution tiles on the same plan grid', () => {
  const p = data.office.plan2d;
  const base = resolve(root, p.image);
  assert.ok(existsSync(base));
  assert.ok(statSync(base).size < 300 * 1024, 'the base image every visitor loads stays light');
  assert.ok(Math.abs(p.width / ref.width - p.height / ref.height) < 0.01, 'base image on the plan grid');
  const t = p.tiles;
  assert.ok(t && t.width >= ref.width * 4 - 1, 'tiles carry 4x the plan grid');
  assert.ok(Math.abs(t.width / ref.width - t.height / ref.height) < 0.01, 'tiles on the plan grid');
  assert.equal(t.cols, Math.ceil(t.width / t.size));
  assert.equal(t.rows, Math.ceil(t.height / t.size));
  for (let y = 0; y < t.rows; y++) for (let x = 0; x < t.cols; x++) assert.ok(existsSync(resolve(root, t.path.replace('{x}', x).replace('{y}', y))), `tile ${x}_${y}`);
});

test('gallery covers: every room in the gallery has a card-sized cover from its first photo', () => {
  for (const r of data.rooms.filter((x) => x.hasPhotos && x.photos && x.photos.length)) {
    assert.ok(r.cover, `${r.id} has a cover`);
    const f = resolve(root, r.cover);
    assert.ok(existsSync(f), `${r.cover} exists`);
    assert.ok(statSync(f).size < statSync(resolve(root, r.photos[0].src)).size, `${r.id}: the cover is lighter than the photo`);
  }
});

test('room names carry no plan codes; offices are «مكتب», employee areas «مكاتب موظفين» (owner, 2026-11-10)', () => {
  for (const r of data.rooms) {
    assert.doesNotMatch(r.name, /\b(0[1-9][a-f]?|1[0-4])\b|[0-9]/, `${r.id}: no code in «${r.name}»`);
    if (r.kind === 'office') assert.equal(r.name, 'مكتب', r.id);
    if (r.kind === 'open') assert.equal(r.name, 'مكاتب موظفين', r.id);
  }
  // everything a visitor reads follows: route stops, captions and the «use» line
  const names = new Map(data.rooms.map((r) => [r.id, r.name]));
  for (const rt of data.scenes.paths.routes) for (const st of rt.stops) assert.equal(st.label, names.get(st.roomId), `${rt.id} stop label is the room name`);
  for (const r of data.rooms) {
    assert.doesNotMatch((r.use && r.use.current) || '', /مكتب مشرف/, `${r.id} use`);
    for (const ph of r.photos || []) assert.doesNotMatch(ph.caption, /مكتب مشرف|\b0[1-9][a-f]\b/, `${r.id} caption «${ph.caption}»`);
  }
  // the key-plan codes stay in the data (photos key, routes), they are just not shown
  assert.ok(data.rooms.every((r) => r.key), 'every room keeps its key-plan code');
});

test('live 3D: baked light maps are published and cover the model (no real-time lights in the viewer)', () => {
  const sceneInfo = JSON.parse(readFileSync(resolve(root, data.office.model.scene), 'utf8'));
  const dir = dirname(resolve(root, data.office.model.scene));
  const L = sceneInfo.light;
  assert.ok(L, 'scene.json carries the light block (tools/twin/finish_light.py)');
  assert.ok(L.gain > 0 && L.rect.w > 0 && L.rect.h > 0);
  // the maps' rectangle (Blender x/y, metres) contains the whole office outline, with ground to spare
  assert.ok(L.rect.x0 < sceneInfo.bounds.min[0] - 2 && L.rect.y0 < sceneInfo.bounds.min[1] - 2, 'rect starts beyond the outline');
  assert.ok(L.rect.x0 + L.rect.w > sceneInfo.bounds.max[0] + 2 && L.rect.y0 + L.rect.h > sceneInfo.bounds.max[1] + 2, 'rect ends beyond the outline');
  for (const mood of ['day', 'night']) {
    assert.equal(L.moods[mood].length, 2, `${mood}: structure map + furniture map`);
    for (const f of L.moods[mood]) {
      assert.match(f, /^light_[a-z]+_[ab]\.webp\?v=[0-9a-f]{6,}$/, `${f}: versioned address (the host caches images for a month)`);
      const file = resolve(dir, f.split('?')[0]);
      assert.ok(existsSync(file), `${f} exists`);
      assert.ok(statSync(file).size < 1500 * 1024, `${f} stays light`);
    }
  }
  assert.notDeepEqual(L.moods.day, L.moods.night, 'the evening has its own maps');
  assert.ok(L.static.includes('architecture'));
  // the model's address is versioned too, and the file is there
  assert.match(sceneInfo.glb, /^office\.glb\?v=[0-9a-f]{6,}$/);
  assert.ok(existsSync(resolve(dir, 'office.glb')));
  // the viewer multiplies its materials by the maps: no lights, no shadow maps
  const viewer = readFileSync(resolve(root, 'assets/js/twin3d.js'), 'utf8');
  assert.doesNotMatch(viewer, /new T\.(DirectionalLight|PointLight|SpotLight|HemisphereLight|AmbientLight)\b|shadowMap\.enabled\s*=\s*true/, 'no real-time lights');
});

test('one page on screen: a hidden page hides its content by rule, and the 3D viewer draws nothing while covered', () => {
  // Leaving a page while its content was still fading in left that content visible and clickable over the
  // next page (Chrome kept the visibility the animated block had inherited earlier). The rule must name the
  // elements themselves, with !important, so it never depends on inheritance.
  const css = readFileSync(resolve(root, 'assets/css/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = css.match(/\.view:not\(\.is-active\) \*[^{]*\{([^}]*)\}/);
  assert.ok(rule, 'app.css hides every element of a page that is not the active one');
  assert.match(rule[1], /visibility:\s*hidden\s*!important/, 'visibility is forced on each element');
  assert.match(rule[1], /pointer-events:\s*none\s*!important/, 'and so are pointer events');
  // A camera flight used to keep rendering behind the photos page: unseen frames, and on a slow GPU a long
  // freeze on the way back. The frame loop and the flights must both check that the stage can be seen.
  const viewer = readFileSync(resolve(root, 'assets/js/twin3d.js'), 'utf8');
  const frame = viewer.slice(viewer.indexOf('function frame(now)'), viewer.indexOf('function frame(now)') + 400);
  assert.match(frame, /if \(unseen\(\)\)/, 'frame() draws nothing while the stage is covered');
  assert.match(viewer, /function flyTo[\s\S]{0,400}reducedMotion \|\| unseen\(\)/, 'a flight nobody can see lands at once');
  assert.match(viewer, /function requestRender[\s\S]{0,400}if \(unseen\(\)\) return;/, 'no frame is queued while covered');
});
