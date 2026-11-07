// End-to-end visitor flow on desktop and mobile, with a screenshot per step.
//
//   node tests/e2e/flow.mjs            → docs/qa/<yyyy-mm-dd>/<device>-<nn>-<step>.jpg
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/flow.mjs
//
// The live 3D model needs WebGL; headless Chromium gets SwiftShader (software GL),
// so the model takes 10-20 s to load there. Exits non-zero on the first failed assertion.
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';

const pwMod = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { chromium, devices } = pwMod.default || pwMod;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const day = new Date().toISOString().slice(0, 10);
const outDir = process.env.QA_DIR || resolve(root, 'docs/qa', day);
await mkdir(outDir, { recursive: true });

const TEAM = 'شركة نور';
const { server, url } = await serve(root);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failures = 0;

async function flow(name, contextOptions, { mobile, team }) {
  const ctx = await browser.newContext(contextOptions);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000); // software WebGL (SwiftShader) can block the main thread for a while right after the model loads
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // Chrome's "Failed to load resource" message carries no URL; failed requests
    // are tracked through the response hook below instead.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('response', (r) => {
    // build-info.json only exists in the assembled Pages deployment
    if (r.status() >= 400 && !/build-info\.json$/.test(r.url())) errors.push(`${r.status()} ${r.url()}`);
  });
  let n = 0;
  const shot = async (step) => {
    n += 1;
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(outDir, `${name}-${String(n).padStart(2, '0')}-${step}.jpg`), type: 'jpeg', quality: 82, animations: 'disabled', timeout: 60000 });
  };
  const hash = () => new URL(page.url()).hash;
  const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel); // toolbar buttons move while the model renders
  const modelReady = () => page.waitForSelector('#plan-stage.is-ready', { timeout: 120000 });
  const focusedOn = (id) => page.waitForFunction((rid) => document.getElementById('plan-stage').dataset.focus === rid, id, { timeout: 60000 });
  // the camera flight has ended and one more frame was drawn (software GL can take seconds per frame)
  const settled = () => page.evaluate(() => new Promise((res) => {
    const twin = document.getElementById('plan-stage').__twin;
    twin.settled().then(() => { const off = twin.onFrame(() => { off(); res(); }); twin.requestRender(); setTimeout(() => { off(); res(); }, 20000); });
  }));
  let step = 'start';

  try {
    // 1. welcome — header with home, agreed copy, no totals, single call to action
    step = '1 welcome';
    await page.goto(team ? `${url}/?team=${encodeURIComponent(TEAM)}` : `${url}/`);
    await page.waitForSelector('#app.is-ready');
    await page.waitForTimeout(600);
    assert.ok(await page.isVisible('#site-header'), 'persistent header');
    assert.equal((await page.textContent('.site-nav a[data-nav="welcome"]')).trim(), 'الرئيسية');
    if (team) {
      assert.equal(await page.textContent('#welcome-team'), TEAM, 'team name from ?team=');
      assert.match(await page.textContent('#welcome-title'), /^مرحبًا بفريق/);
    } else {
      assert.equal((await page.textContent('#welcome-title')).trim(), 'مرحبًا بكم');
    }
    assert.match(await page.textContent('#welcome-subtitle'), /توأمة رقمية/);
    assert.match(await page.textContent('#welcome-atmosphere'), /أجواء جميلة وهادئة/);
    const body = await page.textContent('body');
    for (const banned of ['احجز معاينة', 'التوأم الرقمي للمكتب', 'محطة عمل', 'مكتبًا إداريًا', 'الوضع الحالي']) {
      assert.ok(!body.includes(banned), `welcome must not contain «${banned}»`);
    }
    // Satr identity on the welcome page: wordmark, general location, slogan; footer with both numbers
    assert.equal((await page.textContent('#welcome-brand-name')).trim(), 'سطر العقارية', 'Satr wordmark');
    assert.match(await page.textContent('#welcome-location'), /واجهة روشن للأعمال/, 'general location on the welcome');
    assert.match(await page.textContent('#welcome-slogan'), /نفهم الأصل/, 'Satr slogan');
    const footerText = await page.textContent('#app-footer');
    for (const must of ['+966 55 585 5057', '+966 54 417 1356', 'واجهة روشن للأعمال', 'جميع الحقوق محفوظة']) assert.ok(footerText.includes(must), `footer has «${must}»`);
    assert.equal(await page.$$eval('#app-footer a[href^="tel:"]', (as) => as.length), 2, 'two tel links');
    assert.ok(!footerText.includes('@'), 'no e-mail in the footer');
    const ctaStyle = await page.$eval('#btn-start', (b) => { const r = b.getBoundingClientRect(); return { inView: r.top >= 0 && r.bottom <= innerHeight, w: r.width }; });
    assert.ok(ctaStyle.inView && ctaStyle.w > 90, `call to action visible on the first screen (${JSON.stringify(ctaStyle)})`);
    await shot('welcome');
    // 2. the 2D plan opens by default: view tabs, dots, sidebar, routes, focus, red dot -> details
    step = '2a plan 2D';
    await click('#btn-start');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForFunction(() => document.querySelector('.plan2d-image') && document.querySelector('.plan2d-image').naturalWidth > 0);
    await page.waitForTimeout(600);
    assert.equal(await page.$eval('#plan-stage-wrap', (w) => w.dataset.mode), '2d', '2D is the default view');
    assert.ok(await page.isHidden('#plan-stage'), '3D stage hidden in 2D mode');
    assert.equal(await page.getAttribute('#view-tabs [data-view="2d"]', 'aria-selected'), 'true', '2D tab selected');
    assert.equal((await page.textContent('.site-nav a.is-active')).trim(), 'مخطط المكتب', 'header highlights مخطط المكتب');
    assert.equal((await page.textContent('#header-owner')).trim(), 'شركة سطر العقارية', 'owner name at the end of the header');
    assert.ok((await page.locator('#plan2d-stage .dot-blue').count()) >= 20, '2D: blue dot per room');
    assert.ok((await page.locator('#plan2d-stage .dot-red').count()) >= 10, '2D: red dot where photos exist');
    const vis2d = await page.$$eval('#plan2d-stage .dot-blue', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.left >= 0 && r.right <= innerWidth; }).length);
    assert.ok(vis2d >= 20, `2D dots on screen (${vis2d})`);
    await shot('plan-2d');
    // routes on the 2D plan
    await click('.scene-tab[data-scene="paths"]');
    await page.waitForFunction(() => location.hash === '#/plan?scene=paths');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#plan2d-stage .route2d').count(), 3, '2D: three routes');
    assert.ok(await page.$eval('#plan2d-stage .plan2d-routes', (g) => getComputedStyle(g).display !== 'none'), '2D: routes shown on the paths tab');
    await shot('paths-2d');
    await click('.scene-tab[data-scene="current"]');
    await page.waitForFunction(() => location.hash === '#/plan');
    assert.ok(await page.$eval('#plan2d-stage .plan2d-routes', (g) => getComputedStyle(g).display === 'none'), '2D: routes hidden on the layout tab');
    // focus a room on the 2D plan from the list: zoom-in, veil, card; the same item again returns to the plan
    await click('#room-list .room-item-btn[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');
    await page.waitForFunction(() => document.getElementById('plan2d-stage').dataset.focus === 'meeting-large');
    await page.waitForTimeout(900);
    assert.ok(await page.isVisible('#room-card'), '2D: room card shown');
    assert.match(await page.textContent('#focus-title'), /08b/, '2D: the room name carries its key code');
    assert.ok(await page.$eval('#plan2d-stage .plan2d-veil', (v) => getComputedStyle(v).display !== 'none'), '2D: neighbours dimmed');
    const box2d = await page.evaluate(() => { const st = document.getElementById('plan2d-stage'); const b = st.__twin.roomScreenBox('meeting-large'); return { size: Math.max(b.w, b.h), stage: Math.min(st.clientWidth, st.clientHeight) }; });
    assert.ok(box2d.size > box2d.stage * 0.4, `2D: zoomed to the room (room ${box2d.size.toFixed(0)}px on ${box2d.stage.toFixed(0)}px)`);
    await shot('focus-2d');
    await click('#room-list .room-item-btn[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForFunction(() => !document.getElementById('plan2d-stage').dataset.focus);
    // the red dot opens the room details (photos included), not the photos directly — a real pointer
    // click: the stage's pan handler must not capture the pointer away from the dot. Phones show the
    // red dot only for the focused room (or when zoomed in), so focus the reception first there.
    if (mobile) {
      await click('#room-list .room-item-btn[data-id="reception"]');
      await page.waitForFunction(() => document.getElementById('plan2d-stage').dataset.focus === 'reception');
      await page.waitForTimeout(900);
    }
    await page.locator('#plan2d-stage .room-marker[data-id="reception"] .dot-red').click();
    await page.waitForFunction(() => location.hash === '#/room/reception/details');
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'details');
    await page.waitForFunction(() => { const i = document.querySelector('#details-stage .details-render'); return i && i.complete && i.naturalWidth > 0; });
    assert.ok((await page.locator('#details-photos button').count()) >= 3, '2D red dot -> details with photos');
    await click('#btn-close-details');
    await page.waitForFunction(() => location.hash === '#/room/reception');
    // back to the whole plan (no focus, hash #/plan) before the gesture checks
    await page.goto(`${url}/#/plan`);
    await page.waitForFunction(() => location.hash === '#/plan' && !document.getElementById('plan2d-stage').dataset.focus);
    await page.waitForTimeout(800);
    // pinch-zoom keeps the plan point under the fingers still (the midpoint is converted to the stage's frame)
    const pinch = await page.evaluate(() => {
      const st = document.getElementById('plan2d-stage');
      const eng = st.__twin;
      const r = st.getBoundingClientRect();
      const mx = r.left + r.width * 0.62;
      const my = r.top + r.height * 0.58;
      const o = eng.project(0, 0);
      const ux = eng.project(1, 0).x - o.x; // stage px per plan px
      const uy = eng.project(0, 1).y - o.y;
      const plan = { x: (mx - r.left - o.x) / ux, y: (my - r.top - o.y) / uy }; // the plan point under the midpoint
      const ev = (type, id, x, y) => st.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      ev('pointerdown', 1, mx - 60, my);
      ev('pointerdown', 2, mx + 60, my);
      for (let k = 1; k <= 6; k++) { ev('pointermove', 1, mx - 60 - 5 * k, my); ev('pointermove', 2, mx + 60 + 5 * k, my); } // fingers 120 -> 180 px apart: 1.5x
      const after = eng.project(plan.x, plan.y);
      ev('pointerup', 1, mx - 90, my);
      ev('pointerup', 2, mx + 90, my);
      const drift = Math.hypot(after.x - (mx - r.left), after.y - (my - r.top));
      const zoom = (eng.project(1, 0).x - eng.project(0, 0).x) / ux;
      return { drift, zoom };
    });
    assert.ok(Math.abs(pinch.zoom - 1.5) < 0.05, `pinch zooms by the finger spread (${pinch.zoom.toFixed(2)}x)`);
    assert.ok(pinch.drift < 3, `the point under the fingers stays put (drift ${pinch.drift.toFixed(1)}px)`);
    await page.evaluate(() => document.getElementById('plan2d-stage').__twin.resetView());
    await page.waitForTimeout(800);
    // a pinch that starts during a focus flight takes over: the flight must not snap the plan back afterwards
    const pinchVsFlight = await page.evaluate(async () => {
      const st = document.getElementById('plan2d-stage');
      const eng = st.__twin;
      const r = st.getBoundingClientRect();
      const mx = r.left + r.width / 2;
      const my = r.top + r.height / 2;
      const ev = (type, id, x, y) => st.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      eng.focusRoom('meeting-large'); // animated flight (700 ms)
      await new Promise((res) => setTimeout(res, 120));
      ev('pointerdown', 1, mx - 60, my);
      ev('pointerdown', 2, mx + 60, my);
      for (let k = 1; k <= 4; k++) { ev('pointermove', 1, mx - 60 - 5 * k, my); ev('pointermove', 2, mx + 60 + 5 * k, my); }
      const right = eng.planPixelSize();
      ev('pointerup', 1, mx - 80, my);
      ev('pointerup', 2, mx + 80, my);
      await new Promise((res) => setTimeout(res, 900)); // longer than the flight
      const later = eng.planPixelSize();
      await eng.unfocus({ animate: false });
      return { right, later };
    });
    assert.ok(Math.abs(pinchVsFlight.later - pinchVsFlight.right) < pinchVsFlight.right * 0.01, `the flight does not override the pinch (${pinchVsFlight.right.toFixed(0)} -> ${pinchVsFlight.later.toFixed(0)}px)`);
    // a pinch with one finger still, released quickly, is not a tap: no room gets picked
    const afterGesture = await page.evaluate(async () => {
      const st = document.getElementById('plan2d-stage');
      const r = st.getBoundingClientRect();
      const mx = r.left + r.width / 2;
      const my = r.top + r.height / 2;
      const ev = (type, id, x, y) => st.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      ev('pointerdown', 1, mx - 40, my);
      ev('pointerdown', 2, mx + 40, my); // the second (still) finger
      ev('pointermove', 1, mx - 70, my); // the first finger spreads
      ev('pointerup', 2, mx + 40, my); // the still finger lifts first, in place and within 600 ms
      ev('pointerup', 1, mx - 70, my);
      await new Promise((res) => setTimeout(res, 400));
      return { hash: location.hash, focus: st.dataset.focus || null };
    });
    assert.equal(afterGesture.hash, '#/plan', `no room picked after a pinch (${JSON.stringify(afterGesture)})`);
    assert.equal(afterGesture.focus, null, 'no focus after a pinch');
    await page.evaluate(() => document.getElementById('plan2d-stage').__twin.resetView());
    await page.waitForTimeout(800);
    // a list-only space (the corridors) opens its details straight from the list
    await click('#room-list .room-item-btn[data-id="corridors"]');
    await page.waitForFunction(() => location.hash === '#/room/corridors/details');
    await click('#btn-close-details');
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'plan');
    await page.goto(`${url}/#/plan`);
    await page.waitForFunction(() => !document.getElementById('plan2d-stage').dataset.focus);

    // 2. switch to the live 3D model: two scene tabs, sidebar list, dots legend
    step = '2 plan 3D';
    await click('#view-tabs [data-view="3d"]');
    await modelReady();
    await page.waitForFunction(() => document.getElementById('plan-stage-wrap').dataset.mode === '3d');
    await page.waitForTimeout(1200);
    assert.ok(await page.isHidden('#plan2d-stage'), '2D stage hidden in 3D mode');
    assert.equal((await page.textContent('.site-nav a.is-active')).trim(), 'المخطط ثلاثي الأبعاد', 'header highlights the 3D plan');
    assert.equal(await page.locator('#scene-tabs .scene-tab').count(), 2, 'two scene tabs');
    assert.equal((await page.textContent('.scene-tab[data-scene="current"]')).trim(), 'توزيعات المكاتب');
    assert.ok(await page.$('#plan-stage canvas'), 'WebGL canvas present');
    assert.ok((await page.locator('#room-list .room-item-btn').count()) >= 20, 'sidebar lists the rooms');
    assert.ok((await page.locator('#overlay-dots .dot-blue').count()) >= 20, 'blue dot per room');
    assert.ok((await page.locator('#overlay-dots .dot-red').count()) >= 10, 'red dot where photos exist');
    const visibleBlue = await page.$$eval('#overlay-dots .dot-blue', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && getComputedStyle(e).display !== 'none' && r.left >= 0 && r.right <= innerWidth; }).length);
    assert.ok(visibleBlue >= 20, `blue dots visible on screen at the default view (${visibleBlue})`);
    // dots sit inside the stage, never outside the model's screen box
    const stageBox = await page.locator('#plan-stage').boundingBox();
    const outside = await page.$$eval('#overlay-dots .room-marker .dot-blue', (els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
    for (const [x, y] of outside) assert.ok(x >= stageBox.x && x <= stageBox.x + stageBox.width && y >= stageBox.y && y <= stageBox.y + stageBox.height, `dot inside the stage (${x.toFixed(0)},${y.toFixed(0)})`);
    if (!mobile) {
      const sb = await page.locator('#room-sidebar').boundingBox();
      assert.ok(sb.x + sb.width / 2 > stageBox.x + stageBox.width / 2, 'sidebar sits on the right (RTL)');
    }
    await shot('plan');

    // 2b. lighting toggle: day by default, evening on request, remembered
    step = '2b lighting';
    assert.equal(await page.getAttribute('#plan-stage', 'data-lighting'), 'day', 'daylight by default');
    await click('#btn-lighting');
    await page.waitForFunction(() => document.getElementById('plan-stage').dataset.lighting === 'night');
    await page.waitForTimeout(900);
    await shot('night');
    await click('#btn-lighting');
    await page.waitForFunction(() => document.getElementById('plan-stage').dataset.lighting === 'day');

    // 2c. routes: three colours, each can be toggled; employees loop, guests to meetings + lounge
    step = '2c routes';
    await click('.scene-tab[data-scene="paths"]');
    await page.waitForFunction(() => location.hash === '#/plan?scene=paths');
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.route-chip').count(), 3, 'three routes in the legend');
    assert.ok(!(await page.isHidden('#route-legend')), 'legend shown');
    await shot('paths');
    await click('.route-chip[data-route="executive"]');
    assert.equal(await page.getAttribute('.route-chip[data-route="executive"]', 'aria-pressed'), 'false', 'route toggled off');
    await click('.route-chip[data-route="executive"]');
    await click('.scene-tab[data-scene="current"]');
    await page.waitForFunction(() => location.hash === '#/plan');
    assert.ok(await page.isHidden('#route-legend'), 'legend hidden on the layout tab');

    // 2d. labels outside option
    step = '2d labels';
    await click('#btn-labels');
    await page.waitForTimeout(400);
    assert.ok(await page.$eval('#plan-stage', (s) => s.classList.contains('labels-outside')), 'outside labels mode');
    assert.ok((await page.locator('#plan-stage .room-tag.is-outside:not([hidden])').count()) >= 5, 'outside labels drawn');
    await shot('labels-outside');
    await click('#btn-labels');

    // 3. blue dot -> the room in its 3D context; the card appears in the sidebar
    step = '3 focus';
    await page.locator('#overlay-dots .room-marker[data-id="meeting-large"] .dot-blue').click({ timeout: 60000 });
    await page.waitForFunction(() => location.hash === '#/room/meeting-large', null, { timeout: 60000 });
    await focusedOn('meeting-large');
    await settled();
    assert.ok(await page.isVisible('#room-card'), 'room card shown');
    assert.equal((await page.textContent('#focus-title')).trim(), 'غرفة اجتماعات 08b', 'room named by the key plan');
    assert.match(await page.textContent('#focus-facts'), /16 مقعدًا/);
    assert.match(await page.textContent('#focus-facts'), /قاعة اجتماعات بفرشها الحالي/);
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('#room-card')), 'keyboard focus moved to the card');
    assert.ok(await page.$eval('#room-list .room-item-btn[data-id="meeting-large"]', (b) => b.classList.contains('is-active')), 'sidebar item highlighted');
    // the focused room must be a real close-up: its floor spans a good share of the stage
    const roomPx = await page.evaluate(() => {
      const st = document.getElementById('plan-stage');
      const b = st.__twin.roomScreenBox('meeting-large');
      return { size: Math.max(b.w, b.h), stage: Math.min(st.clientWidth, st.clientHeight) };
    });
    assert.ok(roomPx.size > roomPx.stage * (mobile ? 0.22 : 0.3), `focused room is a close-up (room ${roomPx.size.toFixed(0)}px on a ${roomPx.stage.toFixed(0)}px stage)`);
    for (const sel of ['#btn-photos', '#btn-focus-details', '#btn-focus-back']) {
      const bb = await page.locator(sel).boundingBox();
      assert.ok(bb && bb.y >= 0 && bb.y + bb.height <= page.viewportSize().height, `${sel} inside the viewport`);
    }
    await shot('focus');

    // 3b. clicking the same room again returns to the plan; clicking another room switches
    step = '3b toggle';
    await click('#room-list .room-item-btn[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForFunction(() => !document.getElementById('plan-stage').dataset.focus, null, { timeout: 60000 });
    assert.ok(await page.isHidden('#room-card'), 'card hidden after the second click');
    await click('#room-list .room-item-btn[data-id="ceo"]');
    await page.waitForFunction(() => location.hash === '#/room/ceo');
    await focusedOn('ceo');
    await click('#room-list .room-item-btn[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');
    await focusedOn('meeting-large');

    // 4. red dot / photos button -> real photos, gallery, back to the model
    step = '4 photos';
    await click('#btn-photos');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large/photos');
    await page.waitForFunction(() => {
      const img = document.getElementById('room-photo');
      return img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    assert.equal((await page.textContent('#room-title')).trim(), 'غرفة اجتماعات 08b');
    await shot('photos');
    await click('#gallery-next');
    await page.waitForTimeout(400);
    assert.ok((await page.getAttribute('#room-photo', 'src')).includes('/02.webp'), 'second photo shown');
    await click('#btn-back-plan');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');
    await page.waitForTimeout(500);
    assert.ok(await page.isVisible('#room-card'), 'back on the 3D view of the room');

    // 4b. a room with photos but no documented capacity still opens its photos (red dot)
    step = '4b other room photos';
    await page.goto(`${url}/#/room/reception/photos`);
    await page.waitForFunction(() => location.hash === '#/room/reception/photos');
    await page.waitForFunction(() => { const i = document.getElementById('room-photo'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 60000 });
    assert.equal((await page.textContent('#room-title')).trim(), 'الاستقبال 12');
    // a room without photos never shows a photo view
    await page.goto(`${url}/#/room/store/photos`);
    await page.waitForFunction(() => location.hash === '#/room/store');

    // 5b. details deep link for a room that has no real photos: no gallery crash, message + model snapshot
    step = '5b details without photos';
    await page.goto(`${url}/#/room/store/details`);
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'details', null, { timeout: 60000 });
    assert.ok((await page.textContent('#details-photos')).includes('لا توجد صور حقيقية'), 'no-photos message');
    await page.waitForFunction(() => { const i = document.querySelector('#details-stage .details-render'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 60000 });
    assert.ok(await page.isHidden('#btn-photos'), 'no photos button for a room without photos');

    // 5. details: render in the centre, features, photos
    step = '5 details';
    await page.goto(`${url}/#/room/meeting-large/details`);
    await page.waitForFunction(() => location.hash === '#/room/meeting-large/details');
    await page.waitForTimeout(900);
    assert.ok((await page.textContent('#details-features')).includes('16 مقعدًا'), 'capacity shown');
    assert.ok(!(await page.textContent('#details-features')).includes('مقترح'), 'no proposed use');
    await page.waitForFunction(() => { const i = document.querySelector('#details-stage .details-render'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 60000 });
    // the centre image is the furnished Cycles perspective of this room, not a plan snapshot
    const detailsSrc = await page.getAttribute('#details-stage .details-render', 'src');
    assert.ok(detailsSrc.endsWith('media/twin/rooms/meeting-large.webp'), `room render shown, got ${detailsSrc}`);
    assert.ok((await page.textContent('#view-details .details-plan-caption')).includes('بفرشها'), 'render caption');
    // thumbnails keep their 3:2 size inside the scrolling photos panel (rows must not share the panel height)
    const thumbH = await page.evaluate(() => document.querySelector('#details-photos button').getBoundingClientRect().height);
    assert.ok(thumbH >= 80, `photo thumbnails keep their size in the scrolling panel (${thumbH.toFixed(0)}px)`);
    await shot('details');
    if (mobile) {
      await click('#tab-features');
      await page.waitForTimeout(300);
      assert.ok(await page.isVisible('#details-features'), 'features tab visible on mobile');
      await shot('details-features-tab');
    }
    await click('#btn-close-details');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');

    // 6. header home link and browser history
    step = '6 navigation';
    await click('#nav-home');
    await page.waitForFunction(() => location.hash === '#/' || location.hash === '');
    assert.ok(await page.isVisible('#welcome-title'), 'home via the header');
    // nothing renders or spins behind the welcome screen: look for a quiet window longer than any software-GL frame
    const behindWelcome = await page.evaluate(async () => {
      const twin = document.getElementById('plan-stage').__twin;
      let last = performance.now();
      const off = twin.onFrame(() => { last = performance.now(); });
      const t0 = performance.now();
      let quiet = 0;
      while (performance.now() - t0 < 60000) {
        await new Promise((r) => setTimeout(r, 500));
        quiet = performance.now() - last;
        if (quiet > 8000) break;
      }
      off();
      return Math.round(quiet);
    });
    assert.ok(behindWelcome > 8000, `no turntable behind the welcome screen (longest quiet window ${behindWelcome} ms)`);
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');
    await focusedOn('meeting-large');
    await click('#btn-focus-back');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForTimeout(600);
    await shot('plan-after-back');

    // 6b. race: open a room and leave before the fly-to ends — overlay and model agree
    step = '6b race';
    await page.goto(`${url}/#/room/ceo`);
    await page.waitForTimeout(150);
    await page.goto(`${url}/#/plan`);
    await page.waitForFunction(() => !document.getElementById('plan-stage').dataset.focus, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('#overlay-dots .room-marker.is-dim').count(), 0, 'no stale dimming after a race');
    assert.ok(await page.isHidden('#room-card'), 'no stale card after a race');

    // 6c. race: an animated focus superseded by an immediate one (photos of another room) must not drift back
    step = '6c tween cancel';
    await page.goto(`${url}/#/room/ceo`);
    await page.waitForTimeout(200);
    await page.goto(`${url}/#/room/reception/photos`);
    await page.waitForFunction(() => document.getElementById('plan-stage').dataset.focus === 'reception', null, { timeout: 60000 });
    await page.waitForTimeout(1500); // longer than the superseded flight
    const drift = await page.evaluate(async () => {
      const twin = document.getElementById('plan-stage').__twin;
      const a = twin.project(0, 0, 0);
      await new Promise((r) => setTimeout(r, 700));
      const b = twin.project(0, 0, 0);
      return { focus: twin.getFocus(), moved: Math.hypot(a.x - b.x, a.y - b.y) };
    });
    assert.equal(drift.focus, 'reception', 'focus follows the latest route');
    assert.ok(drift.moved < 0.5, `camera is still after the immediate focus (moved ${drift.moved.toFixed(1)}px)`);
    await page.goto(`${url}/#/room/reception`);
    await focusedOn('reception');
    await settled();
    const recPx = await page.evaluate(() => {
      const st = document.getElementById('plan-stage');
      const b = st.__twin.roomScreenBox('reception');
      return { size: Math.max(b.w, b.h), stage: Math.min(st.clientWidth, st.clientHeight), inside: b.x >= -b.w && b.x + b.w <= st.clientWidth + b.w };
    });
    assert.ok(recPx.inside && recPx.size > recPx.stage * 0.18, `camera sits on the reception after the superseded flight (room ${recPx.size.toFixed(0)}px)`);

    // 6d. the route stripes keep animating after the visitor has interacted; the loop idles when they are hidden
    step = '6d route animation';
    await page.goto(`${url}/#/plan?scene=paths`);
    await page.waitForFunction(() => !document.getElementById('plan-stage').dataset.focus, null, { timeout: 60000 });
    await page.waitForTimeout(600);
    const frames = await page.evaluate(async () => {
      const twin = document.getElementById('plan-stage').__twin;
      twin.stopIdle();
      // software GL can need >2 s per frame on the phone profile: wait for k frames instead of a fixed window
      const waitFrames = (k, cap) => new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const off = twin.onFrame(() => { n += 1; if (n >= k) { off(); res(performance.now() - t0); } });
        setTimeout(() => { off(); if (n < k) res(-n); }, cap);
      });
      await new Promise((r) => setTimeout(r, 300));
      const ms = await waitFrames(3, 20000); // > 0: time the three frames took
      twin.setRoutesVisible(false);
      const gap = Math.max(800, ms > 0 ? (ms / 3) * 2 : 3000);
      await new Promise((r) => setTimeout(r, gap)); // the frame that hides the routes drains here
      let idleFrames = 0;
      const off = twin.onFrame(() => { idleFrames += 1; });
      await new Promise((r) => setTimeout(r, gap));
      off();
      twin.setRoutesVisible(true);
      return { ms, idleFrames };
    });
    assert.ok(frames.ms > 0, `routes keep animating without camera input (${frames.ms < 0 ? -frames.ms : 3} frames in 20 s)`);
    assert.ok(frames.idleFrames <= 1, `render loop idles when nothing animates (${frames.idleFrames} frames)`);
    // every route chip off (the group itself stays visible): the loop must idle too, and wake when a chip comes back
    const chips = await page.evaluate(async (gap) => {
      const twin = document.getElementById('plan-stage').__twin;
      const buttons = [...document.querySelectorAll('#route-legend .route-chip')];
      for (const b of buttons) b.click(); // all three off
      await new Promise((r) => setTimeout(r, gap)); // the frame that hides the last route drains here
      let idle = 0;
      let off = twin.onFrame(() => { idle += 1; });
      await new Promise((r) => setTimeout(r, gap));
      off();
      buttons[0].click(); // one route back on
      let resumed = 0;
      off = twin.onFrame(() => { resumed += 1; });
      await new Promise((r) => setTimeout(r, Math.max(gap * 3, 6000)));
      off();
      for (const b of buttons.slice(1)) b.click(); // restore the legend state
      return { count: buttons.length, idle, resumed, pressed: buttons.map((b) => b.getAttribute('aria-pressed')) };
    }, Math.max(800, (frames.ms / 3) * 2));
    assert.equal(chips.count, 3, 'three route chips');
    assert.ok(chips.idle <= 1, `render loop idles with every route chip off (${chips.idle} frames)`);
    assert.ok(chips.resumed >= 2, `route animation resumes when a chip comes back (${chips.resumed} frames)`);
    assert.deepEqual(chips.pressed, ['true', 'true', 'true'], 'chips restored');
    // an animated flight must not multiply render callbacks (controls' change event + end-of-frame scheduling)
    const perTick = await page.evaluate(async () => {
      const twin = document.getElementById('plan-stage').__twin;
      await twin.focusRoom('ceo'); // animated, routes still visible
      let ticks = 0;
      let renders = 0;
      const off = twin.onFrame(() => { renders += 1; });
      await new Promise((done) => { const t0 = performance.now(); const tick = () => { ticks += 1; if (performance.now() - t0 < 1200) requestAnimationFrame(tick); else done(); }; requestAnimationFrame(tick); });
      off();
      await twin.unfocus({ animate: false });
      return { ticks, renders };
    });
    assert.ok(perTick.renders <= perTick.ticks + 2, `one render per animation frame after a flight (${perTick.renders} renders in ${perTick.ticks} ticks)`);
    // nothing renders behind another view: open a room's photos while the routes are visible and count frames
    await page.goto(`${url}/#/room/reception/photos`);
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'photos');
    const behind = await page.evaluate(async (gap) => {
      const twin = document.getElementById('plan-stage').__twin;
      await new Promise((r) => setTimeout(r, gap)); // the focus render for the photos route drains here
      let n = 0;
      const off = twin.onFrame(() => { n += 1; });
      await new Promise((r) => setTimeout(r, gap)); // three frame-times: an animating loop would show ≥2 frames
      off();
      return n;
    }, Math.max(2000, frames.ms > 0 ? frames.ms : 3000));
    assert.ok(behind <= 1, `no rendering behind the photos view (${behind} frames)`);
    await page.goto(`${url}/#/plan?scene=paths`);
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'plan');
    const resumed = await page.evaluate(async () => {
      const twin = document.getElementById('plan-stage').__twin;
      let n = 0;
      const off = twin.onFrame(() => { n += 1; });
      await new Promise((r) => setTimeout(r, 15000)); // generous: software GL
      off();
      return n;
    });
    assert.ok(resumed >= 2, `route animation resumes when the plan view returns (${resumed} frames)`);

    // 6e. details requested while the flight to the room is still in progress: the snapshot is taken at the end of the flight
    // (the CFO office has no Cycles render yet, so its details page shows the live snapshot)
    step = '6e details mid-flight';
    await page.goto(`${url}/#/plan`); // layout scene: no animated routes, so two snapshots of a still camera are identical
    await page.waitForFunction(() => location.hash === '#/plan' && document.getElementById('route-legend').hidden);
    await page.waitForTimeout(300);
    const cfoHasRender = await page.evaluate(async () => { const d = await (await fetch('data/office.json')).json(); const r = d.rooms.find((x) => x.id === 'cfo'); return !!(r.render || r.focus); });
    assert.ok(!cfoHasRender, 'step 6e needs a room whose details page shows the live snapshot (no render/focus image)');
    await page.goto(`${url}/#/room/cfo`);
    await page.waitForTimeout(200);
    await page.goto(`${url}/#/room/cfo/details`);
    await page.waitForFunction(() => { const i = document.querySelector('#details-stage .details-render'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 60000 });
    await page.waitForTimeout(1500); // longer than any flight
    const snapDiff = await page.evaluate(async () => {
      const twin = document.getElementById('plan-stage').__twin;
      const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
      const a = await load(document.querySelector('#details-stage .details-render').src);
      const b = await load(twin.snapshot());
      const w = Math.min(a.width, b.width, 320);
      const h = Math.min(a.height, b.height, 200);
      const px = (im) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(im, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
      const pa = px(a);
      const pb = px(b);
      let sum = 0;
      for (let i = 0; i < pa.length; i += 4) sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
      return { sameSize: a.width === b.width && a.height === b.height, meanDiff: sum / (pa.length / 4) / 3 };
    });
    assert.ok(snapDiff.sameSize && snapDiff.meanDiff < 2, `details snapshot matches the settled camera (mean diff ${snapDiff.meanDiff.toFixed(2)})`);

    // 7. bad deep links fall back to the plan; old links keep working
    step = '7 deep links';
    for (const bad of ['#/room/nope', '#/room/core', '#/room/meeting-large/xyz', '#/whatever']) {
      await page.goto(`${url}/${bad}`);
      await page.waitForFunction(() => location.hash === '#/plan');
    }
    await page.goto(`${url}/#/plan?scene=visitor-path`);
    await page.waitForFunction(() => location.hash === '#/plan?scene=paths');
    // the view can be chosen in a deep link and is remembered afterwards
    await page.goto(`${url}/#/plan?view=2d`);
    await page.waitForFunction(() => document.getElementById('plan-stage-wrap').dataset.mode === '2d');
    await page.goto(`${url}/#/room/ceo?view=3d`);
    await page.waitForFunction(() => document.getElementById('plan-stage-wrap').dataset.mode === '3d');
    await focusedOn('ceo');
    assert.equal(await page.evaluate(() => localStorage.getItem('view')), '3d', 'the chosen view is remembered');
    // a cold details deep link in 2D for a room without a render: the centre image is a snapshot of the loaded plan
    await page.goto('about:blank');
    await page.goto(`${url}/#/room/cfo/details?view=2d`);
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'details', null, { timeout: 60000 });
    await page.waitForFunction(() => { const i = document.querySelector('#details-stage .details-render'); return i && !i.hidden && i.complete && i.naturalWidth > 0; }, null, { timeout: 60000 });
    assert.ok((await page.getAttribute('#details-stage .details-render', 'src')).startsWith('data:image/jpeg'), 'cold 2D details shows the plan snapshot');
    // the explicit ?view=2d in the link wins over the saved 3D preference: the 3D model is not even loaded
    assert.equal(await page.$eval('#plan-stage-wrap', (w) => w.dataset.mode), '2d', 'details deep link keeps its view');
    assert.equal(await page.evaluate(() => localStorage.getItem('view')), '2d', 'the explicit view is remembered');
    assert.ok(!(await page.$('#plan-stage.is-ready')), '3D model not loaded for a 2D deep link');

    assert.deepEqual(errors, [], 'no console/page errors');
    console.log(`✓ ${name}: ${n} screenshots, all steps passed`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${name} at step "${step}": ${err.message.split('\n')[0]}`);
    await page.screenshot({ path: resolve(outDir, `${name}-FAILED.png`), timeout: 60000 }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

await flow('desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, { mobile: false, team: true });
await flow('mobile', { ...devices['iPhone 13'], deviceScaleFactor: 1 }, { mobile: true, team: false });

await browser.close();
server.close();
console.log(`screenshots: ${outDir}`);
process.exit(failures ? 1 : 0);
