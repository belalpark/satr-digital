// End-to-end visitor flow on desktop and mobile, with a screenshot per step.
//
//   node tests/e2e/flow.mjs            → docs/qa/<yyyy-mm-dd>/<device>-<nn>-<step>.png
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

async function flow(name, contextOptions, { mobile }) {
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
    if (r.status() >= 400 && !/build-info\.json$/.test(r.url())) errors.push(`${r.status()} ${r.url()}`);
  });
  let n = 0;
  const shot = async (step) => {
    n += 1;
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(outDir, `${name}-${String(n).padStart(2, '0')}-${step}.jpg`), type: 'jpeg', quality: 82 });
  };
  const hash = () => new URL(page.url()).hash;

  try {
    // 1. welcome
    await page.goto(`${url}/?team=${encodeURIComponent(TEAM)}`);
    await page.waitForSelector('#app.is-ready');
    await page.waitForTimeout(600);
    assert.equal(await page.textContent('#welcome-team'), TEAM, 'team name from ?team=');
    assert.match(await page.textContent('#welcome-title'), /مرحبًا بفريق/);
    await shot('welcome');

    // 2. plan
    await page.click('#btn-start');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForTimeout(500);
    assert.ok(await page.isVisible('polygon[data-id="meeting-large"]'), 'meeting room polygon visible');
    await shot('plan');

    // 2b. a "soon" room does not navigate
    await page.click('polygon[data-id="ceo"]');
    await page.waitForTimeout(400);
    assert.equal(hash(), '#/plan', 'soon room keeps the plan route');
    await shot('plan-soon-tip');

    // 2c. scenes
    await page.click('.scene-tab[data-scene="visitor-path"]');
    await page.waitForTimeout(500);
    assert.ok(await page.isVisible('.path-line'), 'visitor path drawn');
    await shot('scene-visitor-path');
    await page.click('.scene-tab[data-scene="team-layout"]');
    await page.waitForTimeout(500);
    assert.ok(await page.isVisible('.seat-marker'), 'seat markers drawn');
    assert.match(await page.textContent('#plan-badge'), /تصوّر مقترح/);
    await shot('scene-team-proposed');
    await page.click('#mode-toggle .seg[data-mode="current"]');
    await page.waitForTimeout(300);
    assert.match(await page.textContent('#plan-badge'), /الوضع الحالي/);
    await shot('scene-team-current');
    await page.click('.scene-tab[data-scene="current"]');
    await page.waitForTimeout(300);

    // 3. open the ready room (zoom animation then route change)
    await page.click('polygon[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large', null, { timeout: 5000 });
    await page.waitForFunction(() => {
      const img = document.getElementById('room-photo');
      return img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 10000 });
    await page.waitForTimeout(600);
    assert.equal(await page.textContent('#room-title'), 'غرفة الاجتماعات الكبرى');
    await shot('room');

    // 3b. gallery navigation
    await page.click('#gallery-next');
    await page.waitForTimeout(500);
    assert.ok((await page.getAttribute('#room-photo', 'src')).includes('/02.webp'), 'second photo shown');
    await shot('room-photo-2');

    // 4. back to the plan — same scene, zoom glides back
    await page.click('#btn-back-plan');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForTimeout(1200);
    const transform = await page.$eval('#plan-stage .plan-world', (el) => el.style.transform);
    assert.match(transform, /scale\(1\)/, 'plan back at fit scale');
    await shot('plan-after-back');

    // 5. room again → details
    await page.click('polygon[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large', null, { timeout: 5000 });
    await page.waitForTimeout(500);
    await page.click('#btn-details');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large/details');
    await page.waitForTimeout(700);
    assert.ok((await page.textContent('#details-features')).includes('16 مقعدًا'), 'capacity shown');
    assert.ok(await page.isVisible('#details-stage polygon.is-highlight'), 'room highlighted on the details plan');
    await shot('details');
    if (mobile) {
      await page.click('#tab-features');
      await page.waitForTimeout(300);
      assert.ok(await page.isVisible('#details-features'), 'features tab visible on mobile');
      await shot('details-features-tab');
    }

    // 6. browser back twice → plan
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');
    await page.waitForTimeout(400);
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForTimeout(900);
    await shot('plan-after-history-back');

    // 7. bad deep links fall back to the plan
    await page.goto(`${url}/#/room/nope`);
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.goto(`${url}/#/room/ceo`);
    await page.waitForFunction(() => location.hash === '#/plan');

    assert.deepEqual(errors, [], 'no console/page errors');
    console.log(`✓ ${name}: ${n} steps passed`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${name}: ${err.message}`);
    await page.screenshot({ path: resolve(outDir, `${name}-FAILED.png`) }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

await flow('desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, { mobile: false });
await flow('mobile', { ...devices['iPhone 13'], deviceScaleFactor: 1 }, { mobile: true });

await browser.close();
server.close();
console.log(`screenshots: ${outDir}`);
process.exit(failures ? 1 : 0);
