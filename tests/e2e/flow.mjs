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
  const focusedOn = (id) => page.waitForFunction((rid) => document.getElementById('plan-stage').dataset.focus === rid, id, { timeout: 30000 });
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
    await shot('welcome');

    // 2. live 3D model, two tabs, sidebar list, dots legend
    step = '2 plan';
    await click('#btn-start');
    await modelReady();
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('.scene-tab').count(), 2, 'two scene tabs');
    assert.equal((await page.textContent('.scene-tab[data-scene="current"]')).trim(), 'توزيعات المكاتب');
    assert.ok(await page.$('#plan-stage canvas'), 'WebGL canvas present');
    assert.ok((await page.locator('#room-list .room-item-btn').count()) >= 20, 'sidebar lists the rooms');
    assert.ok((await page.locator('#overlay-dots .dot-blue').count()) >= 20, 'blue dot per room');
    assert.ok((await page.locator('#overlay-dots .dot-red').count()) >= 10, 'red dot where photos exist');
    const visibleBlue = await page.$$eval('#overlay-dots .dot-blue', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && getComputedStyle(e).display !== 'none' && r.left >= 0 && r.right <= innerWidth; }).length);
    assert.ok(visibleBlue >= 20, `blue dots visible on screen at the default view (${visibleBlue})`);
    // dots sit inside the stage, never outside the model's screen box
    const stageBox = await page.locator('#plan-stage').boundingBox();
    const outside = await page.$$eval('#overlay-dots .room-marker .dot-blue', (els) => els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
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
    await click('#overlay-dots .room-marker[data-id="meeting-large"] .dot-blue');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large', null, { timeout: 15000 });
    await focusedOn('meeting-large');
    await page.waitForTimeout(1400);
    assert.ok(await page.isVisible('#room-card'), 'room card shown');
    assert.equal(await page.textContent('#focus-title'), 'غرفة الاجتماعات الكبرى');
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
    await page.waitForFunction(() => !document.getElementById('plan-stage').dataset.focus, null, { timeout: 30000 });
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
    }, null, { timeout: 15000 });
    await page.waitForTimeout(500);
    assert.equal(await page.textContent('#room-title'), 'غرفة الاجتماعات الكبرى');
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
    await page.waitForFunction(() => { const i = document.getElementById('room-photo'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
    assert.equal(await page.textContent('#room-title'), 'الاستقبال');
    // a room without photos never shows a photo view
    await page.goto(`${url}/#/room/bleachers/photos`);
    await page.waitForFunction(() => location.hash === '#/room/bleachers');

    // 5b. details deep link for a room that has no real photos: no gallery crash, message + model snapshot
    step = '5b details without photos';
    await page.goto(`${url}/#/room/bleachers/details`);
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'details', null, { timeout: 15000 });
    assert.ok((await page.textContent('#details-photos')).includes('لا توجد صور حقيقية'), 'no-photos message');
    await page.waitForFunction(() => { const i = document.querySelector('#details-stage .details-render'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 });
    assert.ok(await page.isHidden('#btn-photos'), 'no photos button for a room without photos');

    // 5. details: render in the centre, features, photos
    step = '5 details';
    await page.goto(`${url}/#/room/meeting-large/details`);
    await page.waitForFunction(() => location.hash === '#/room/meeting-large/details');
    await page.waitForTimeout(900);
    assert.ok((await page.textContent('#details-features')).includes('16 مقعدًا'), 'capacity shown');
    assert.ok(!(await page.textContent('#details-features')).includes('مقترح'), 'no proposed use');
    await page.waitForFunction(() => { const i = document.querySelector('#details-stage .details-render'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 });
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
    await page.waitForFunction(() => !document.getElementById('plan-stage').dataset.focus, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('#overlay-dots .room-marker.is-dim').count(), 0, 'no stale dimming after a race');
    assert.ok(await page.isHidden('#room-card'), 'no stale card after a race');

    // 6c. race: an animated focus superseded by an immediate one (photos of another room) must not drift back
    step = '6c tween cancel';
    await page.goto(`${url}/#/room/ceo`);
    await page.waitForTimeout(200);
    await page.goto(`${url}/#/room/reception/photos`);
    await page.waitForFunction(() => document.getElementById('plan-stage').dataset.focus === 'reception', null, { timeout: 30000 });
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
    await page.waitForTimeout(800);
    await focusedOn('reception');
    const recPx = await page.evaluate(() => {
      const st = document.getElementById('plan-stage');
      const b = st.__twin.roomScreenBox('reception');
      return { size: Math.max(b.w, b.h), stage: Math.min(st.clientWidth, st.clientHeight), inside: b.x >= -b.w && b.x + b.w <= st.clientWidth + b.w };
    });
    assert.ok(recPx.inside && recPx.size > recPx.stage * 0.18, `camera sits on the reception after the superseded flight (room ${recPx.size.toFixed(0)}px)`);

    // 6d. the route stripes keep animating after the visitor has interacted; the loop idles when they are hidden
    step = '6d route animation';
    await page.goto(`${url}/#/plan?scene=paths`);
    await page.waitForFunction(() => !document.getElementById('plan-stage').dataset.focus, null, { timeout: 30000 });
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

    // 7. bad deep links fall back to the plan; old links keep working
    step = '7 deep links';
    for (const bad of ['#/room/nope', '#/room/core', '#/room/meeting-large/xyz', '#/whatever']) {
      await page.goto(`${url}/${bad}`);
      await page.waitForFunction(() => location.hash === '#/plan');
    }
    await page.goto(`${url}/#/plan?scene=visitor-path`);
    await page.waitForFunction(() => location.hash === '#/plan?scene=paths');

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
