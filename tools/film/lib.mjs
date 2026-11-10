// Shared helpers for filming a built variant of the site in a phone layout: 432x768 CSS px at 2.5x = 1080x1920.
//   SITE=<dir with index.html> (a variant built by tools/variant.mjs); PLAYWRIGHT_MODULE as in tests/e2e/flow.mjs
import { readFileSync } from 'node:fs';
const pwMod = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
export const { chromium } = pwMod.default || pwMod;
export const SITE = process.env.SITE;
if (!SITE) throw new Error('SITE=<built site directory> is required');
export const W = 432, H = 768, DSF = 2.5;
const { serve } = await import('../../tests/e2e/serve.mjs');

export async function open({ reducedMotion = 'reduce', pixelRatio = null } = {}) {
  const { server, url } = await serve(SITE);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--font-render-hinting=none'] });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: DSF, isMobile: true, hasTouch: true,
    screen: { width: 1080, height: 1920 }, // a large "screen": the viewer keeps its full-size light maps
    reducedMotion, locale: 'ar-SA', colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  page.on('console', (m) => m.type() === 'error' && !/404|Failed to load resource/.test(m.text()) && console.log('ERR', m.text().slice(0, 300)));
  // the viewer as shipped, plus a handle on its camera so the film can place it frame by frame
  await page.route('**/twin3d.js', async (route) => {
    const file = new URL(route.request().url()).pathname;
    let js = readFileSync(`${SITE}${file}`, 'utf8');
    const hook = '  return {\n    element: renderer.domElement,';
    if (!js.includes(hook)) throw new Error('viewer hook point not found');
    js = js.replace(hook, '  window.__t3 = { camera, controls, renderer, scene, placeCamera, requestRender, T };\n' + hook);
    if (pixelRatio) {
      const pr = 'let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);';
      if (!js.includes(pr)) throw new Error('pixel ratio line not found');
      js = js.replace(pr, `let pixelRatio = ${pixelRatio};`);
    }
    await route.fulfill({ body: js, contentType: 'text/javascript' });
  });
  const close = async () => { await browser.close(); server.close(); };
  return { page, url, close, ctx };
}
// things that belong to a development build, not to the film
export const FILM_CSS = '#build-sha{display:none!important}';
export const shot = (page, path) => page.screenshot({ path, type: 'jpeg', quality: 92 });
// camera state of the live model: target, azimuth, polar, distance
export const camState = (page) => page.evaluate(() => {
  const { camera, controls } = window.__t3;
  const t = controls.target, p = camera.position;
  const d = p.distanceTo(t);
  return { x: t.x, y: t.y, z: t.z, az: Math.atan2(p.x - t.x, p.z - t.z), polar: Math.acos(Math.min(1, Math.max(-1, (p.y - t.y) / d))), d };
});
// place the camera and wait until the viewer has drawn that frame and the labels have followed
export const place = (page, s) => page.evaluate((c) => new Promise((res) => {
  const { placeCamera, requestRender, T } = window.__t3;
  const twin = document.getElementById('plan-stage').__twin;
  const off = twin.onFrame(() => { off(); requestAnimationFrame(() => res()); });
  placeCamera(new T.Vector3(c.x, c.y, c.z), c.az, c.polar, c.d);
  requestRender();
}), s);
