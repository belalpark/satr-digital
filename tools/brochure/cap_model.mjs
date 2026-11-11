// A clean picture of the live 3D model (no controls, dots or labels) for the brochure's plan page.
//   node tools/brochure/cap_model.mjs <built site dir> <out.jpg>
import { readFileSync } from 'node:fs';
const pwMod = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { chromium } = pwMod.default || pwMod;
const { serve } = await import('../../tests/e2e/serve.mjs');
const [site, out] = process.argv.slice(2);
const { server, url } = await serve(site);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })).newPage();
await page.route('**/twin3d.js', async (route) => {
  let js = readFileSync(`${site}${new URL(route.request().url()).pathname}`, 'utf8');
  const pr = 'let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);';
  if (!js.includes(pr)) throw new Error('pixel ratio line not found');
  await route.fulfill({ body: js.replace(pr, 'let pixelRatio = 2;'), contentType: 'text/javascript' });
});
await page.goto(`${url}/#/plan?view=3d`);
await page.waitForSelector('#plan-stage.is-ready', { timeout: 180000 });
await page.waitForFunction(() => document.getElementById('plan-stage').dataset.lit === 'day');
await page.addStyleTag({ content: '#overlay-dots,#overlay-svg,.dots-legend,.plan-badge,.plan-help,.zoom-controls,#build-sha,.room-tag{visibility:hidden!important}' });
await page.evaluate(() => new Promise((res) => { const t = document.getElementById('plan-stage').__twin; t.stopIdle(); t.zoom(1.22); setTimeout(() => t.settled().then(() => { const off = t.onFrame(() => { off(); res(); }); t.requestRender(); }), 900); }));
await page.waitForTimeout(8000);
const box = await page.locator('#plan-stage').boundingBox();
// the middle of the stage, 7:5, around the model
const w = Math.min(box.width, box.height * 1.4);
const h = w / 1.4;
await page.screenshot({ path: out, type: 'jpeg', quality: 92, clip: { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h } });
console.log('model picture', out, Math.round(w * 2), 'x', Math.round(h * 2));
await browser.close(); server.close();
