// End-to-end visitor flow on desktop and mobile, with a screenshot per step.
//
//   node tests/e2e/flow.mjs            → docs/qa/<yyyy-mm-dd>/<device>-<nn>-<step>.jpg
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/flow.mjs
//
// Exits non-zero on the first failed assertion.
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
const browser = await chromium.launch();
let failures = 0;

async function flow(name, contextOptions, { mobile, team }) {
  const ctx = await browser.newContext(contextOptions);
  const page = await ctx.newPage();
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
    await page.screenshot({ path: resolve(outDir, `${name}-${String(n).padStart(2, '0')}-${step}.jpg`), type: 'jpeg', quality: 82 });
  };
  const hash = () => new URL(page.url()).hash;
  let step = 'start';
  const focusShotReady = () => page.waitForFunction(() => {
    const s = document.querySelector('#plan-stage .focus-shot.is-visible');
    return s && s.complete && s.naturalWidth > 0 && getComputedStyle(s).opacity === '1';
  }, null, { timeout: 10000 });

  try {
    // 1. welcome — copy, totals, single call to action
    step = '1 welcome — copy, totals, single call to a';
    await page.goto(team ? `${url}/?team=${encodeURIComponent(TEAM)}` : `${url}/`);
    await page.waitForSelector('#app.is-ready');
    await page.waitForTimeout(600);
    if (team) {
      assert.equal(await page.textContent('#welcome-team'), TEAM, 'team name from ?team=');
      assert.match(await page.textContent('#welcome-title'), /^مرحبًا بفريق/);
    } else {
      assert.equal((await page.textContent('#welcome-title')).trim(), 'مرحبًا بكم');
    }
    assert.match(await page.textContent('#welcome-subtitle'), /اكتشفوا المكتب غرفةً غرفة/);
    const totals = await page.textContent('#welcome-highlights');
    assert.match(totals, /13\s*مكتبًا إداريًا/);
    assert.match(totals, /58\s*محطة عمل/);
    assert.match(totals, /والمزيد/);
    const body = await page.textContent('body');
    assert.ok(!/احجز معاينة/.test(body), 'no booking button');
    assert.ok(!/التوأم الرقمي للمكتب/.test(body), 'old product name gone');
    await shot('welcome');

    // 2. 3D plan with two scenes
    step = '2 3D plan with two scenes';
    await page.click('#btn-start');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForFunction(() => document.querySelector('#plan-stage .plan-image').complete);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.scene-tab').count(), 2, 'two scene tabs');
    assert.ok(await page.isVisible('polygon[data-id="meeting-large"]'), 'meeting room hotspot visible');
    await shot('plan');

    // 2b. a "soon" room does not navigate
    step = '2b a "soon" room does not navigate';
    await page.click('polygon[data-id="hr-pmo-ops"]');
    await page.waitForTimeout(400);
    assert.equal(hash(), '#/plan', 'soon room keeps the plan route');

    // 2c. routes: three colours, each can be toggled
    step = '2c routes: three colours, each can be toggl';
    await page.click('.scene-tab[data-scene="paths"]');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.route-line:visible').count(), 3, 'three routes drawn');
    assert.equal(await page.locator('#plan-stage .room-label:visible').count(), 0, 'room labels give way to route labels');
    const stopBoxes = await page.$$eval('#plan-stage .stop-name', (els) => els
      .filter((e) => e.getClientRects().length && getComputedStyle(e).display !== 'none')
      .map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
    if (mobile) {
      assert.equal(stopBoxes.length, 0, 'stop names wait for zoom on phones');
    } else {
      assert.ok(stopBoxes.length >= 6, 'stop names shown on desktop');
      for (let i = 0; i < stopBoxes.length; i++) {
        for (let j = i + 1; j < stopBoxes.length; j++) {
          const [a, b] = [stopBoxes[i], stopBoxes[j]];
          const overlap = a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
          assert.ok(!overlap, `stop names ${i} and ${j} overlap`);
        }
      }
    }
    await shot('paths');
    await page.click('.route-chip[data-route="executive"]');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.route-line:visible').count(), 2, 'route toggled off');
    await page.click('.route-chip[data-route="executive"]');
    await page.click('.scene-tab[data-scene="current"]');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.route-line:visible').count(), 0, 'routes hidden on the current scene');

    // 3. second shot: the room in its 3D context, neighbours dimmed
    step = '3 second shot: the room in its 3D context,';
    await page.click('polygon[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large', null, { timeout: 5000 });
    await focusShotReady();
    assert.ok(await page.isVisible('#focus-panel'), 'focus panel shown');
    assert.equal(await page.textContent('#focus-title'), 'غرفة الاجتماعات الكبرى');
    assert.match(await page.textContent('#focus-capacity'), /16 مقعدًا/);
    assert.ok(await page.$eval('#plan-stage .focus-mask', (p) => p.getAttribute('d').length > 20), 'neighbours dimmed');
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('#focus-panel')), 'keyboard focus moved into the room panel');
    // the sharp render must not be tinted while the pointer rests on the room
    const box = await page.locator('#plan-stage polygon[data-id="meeting-large"]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const fill = await page.$eval('#plan-stage polygon[data-id="meeting-large"]', (p) => getComputedStyle(p).fill);
    const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(fill);
    assert.ok(fill === 'none' || (alpha && Number(alpha[1]) <= 0.06), `focused room stays untinted (${fill})`);
    await page.mouse.move(5, 5);
    await shot('focus');

    // 4. real photos, gallery, back to the second shot
    step = '4 real photos, gallery, back to the second';
    await page.click('#btn-photos');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large/photos');
    await page.waitForFunction(() => {
      const img = document.getElementById('room-photo');
      return img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 10000 });
    await page.waitForTimeout(500);
    assert.equal(await page.textContent('#room-title'), 'غرفة الاجتماعات الكبرى');
    await shot('photos');
    await page.click('#gallery-next');
    await page.waitForTimeout(400);
    assert.ok((await page.getAttribute('#room-photo', 'src')).includes('/02.webp'), 'second photo shown');
    await page.click('#btn-back-plan');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');
    await page.waitForTimeout(500);
    assert.ok(await page.isVisible('#focus-panel'), 'back on the second shot');

    // 5. details: 3D view in the centre, features, photos
    step = '5 details: 3D view in the centre, features';
    await page.click('#btn-focus-details');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large/details');
    await page.waitForTimeout(700);
    assert.ok((await page.textContent('#details-features')).includes('16 مقعدًا'), 'capacity shown');
    assert.ok(!(await page.textContent('#details-features')).includes('مقترح'), 'no proposed use');
    await page.waitForFunction(() => {
      const s = document.querySelector('#details-stage .focus-shot.is-visible');
      return s && s.complete && s.naturalWidth > 0;
    }, null, { timeout: 10000 });
    await shot('details');
    if (mobile) {
      await page.click('#tab-features');
      await page.waitForTimeout(300);
      assert.ok(await page.isVisible('#details-features'), 'features tab visible on mobile');
      await shot('details-features-tab');
    }
    await page.click('#btn-close-details');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');

    // 6. back to the full plan: zoom glides back to the fit view
    step = '6 back to the full plan: zoom glides back ';
    await page.click('#btn-focus-back');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForTimeout(1200);
    const transform = await page.$eval('#plan-stage .plan-world', (el) => el.style.transform);
    assert.match(transform, /scale\(1\)/, 'plan back at fit scale');
    assert.ok(!(await page.isVisible('#focus-panel')), 'focus panel hidden');
    await shot('plan-after-back');

    // 7. browser history: back returns to the second shot, forward to the plan
    step = '7 browser history: back returns to the sec';
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');
    await focusShotReady();
    await page.goForward();
    await page.waitForFunction(() => location.hash === '#/plan');

    // 8. bad deep links fall back to the plan
    step = '8 bad deep links fall back to the plan';
    for (const bad of ['#/room/nope', '#/room/ceo', '#/room/meeting-large/xyz']) {
      await page.goto(`${url}/${bad}`);
      await page.waitForFunction(() => location.hash === '#/plan');
    }
    // deep link straight into the second shot works
    await page.goto(`${url}/#/room/meeting-large`);
    await page.waitForSelector('#app.is-ready');
    await focusShotReady();

    assert.deepEqual(errors, [], 'no console/page errors');
    console.log(`✓ ${name}: ${n} screenshots, all steps passed`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${name} at step "${step}": ${err.message.split('\n')[0]}`);
    await page.screenshot({ path: resolve(outDir, `${name}-FAILED.png`) }).catch(() => {});
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
