// End-to-end visitor flow on desktop and mobile, with a screenshot per step.
//
//   node tests/e2e/flow.mjs            → docs/qa/<yyyy-mm-dd>/<device>-<nn>-<step>.jpg
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.js node tests/e2e/flow.mjs
//   E2E_FLOW=desktop|mobile|install runs one flow; E2E_UNTIL=2d-plan stops before the 3D steps (a fast loop, no WebGL)
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
  const ctx = await browser.newContext({ ...contextOptions, serviceWorkers: 'block' }); // the steps below intercept requests; installFlow() covers the worker
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000); // software WebGL (SwiftShader) can block the main thread for a while right after the model loads
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // Chrome's "Failed to load resource" message carries no URL; failed requests
    // are tracked through the response hook below instead.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  let expectRefusals = false; // the step that plays the host's verification page refuses requests on purpose
  page.on('response', (r) => {
    // build-info.json only exists in the assembled Pages deployment
    if (r.status() >= 400 && !expectRefusals && !/build-info\.json$/.test(r.url())) errors.push(`${r.status()} ${r.url()}`);
  });
  let n = 0;
  const shot = async (step) => {
    n += 1;
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(outDir, `${name}-${String(n).padStart(2, '0')}-${step}.jpg`), type: 'jpeg', quality: 82, animations: 'disabled', timeout: 60000 });
  };
  const hash = () => new URL(page.url()).hash;
  const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel); // toolbar buttons move while the model renders
  // how a visitor moves between sections: the header links on a computer, the bottom bar on a phone
  const NAV = mobile ? '.tabbar' : '.site-nav';
  const nav = (key) => click(`${NAV} a[data-nav="${key}"]`);
  const activeNav = async () => (await page.textContent(`${NAV} a.is-active`)).trim();
  // the room's panel: the card under the plan on a phone, the drawer beside it on a computer
  const panel = mobile ? '#room-card' : '#room-drawer';
  const panelTitle = mobile ? '#focus-title' : '#drawer-title';
  const panelFacts = mobile ? '#focus-facts' : '#drawer-facts';
  const panelPhotos = mobile ? '#btn-photos' : '#btn-drawer-photos';
  // the path bar: where the visitor is, and one step back
  const crumbs = () => page.$$eval('#crumb-list li', (els) => els.map((e) => e.textContent.trim()));
  const back = () => click('#crumb-back');
  const backLabel = () => page.getAttribute('#crumb-back', 'aria-label');
  // pictures the visitor can see that failed to load (the browser would draw its broken-picture mark)
  const brokenPictures = () => page.$$eval('img', (els) => els.filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0 && i.getClientRects().length && getComputedStyle(i).visibility !== 'hidden').map((i) => i.getAttribute('src').slice(0, 80)));
  // where a page must end: above the bottom bar on a phone, and above the «add to the home screen» bar when it is up
  const barTop = () => page.evaluate(() => {
    const top = (e) => (e && !e.hidden && getComputedStyle(e).display !== 'none' ? e.getBoundingClientRect().top : innerHeight);
    return Math.min(top(document.getElementById('tabbar')), top(document.getElementById('install-bar')));
  });
  // watch a page change frame by frame: two pages must never be on screen together (owner, 2026-11-08)
  const watchViews = () => page.evaluate(() => {
    window.__viewFrames = [];
    const t0 = performance.now();
    const tick = (now) => {
      // a page is on screen when the page itself or any of its blocks can be seen (a hidden page whose content
      // stayed visible is still "on screen" for the visitor)
      const vis = [...document.querySelectorAll('.view')].filter((v) => { const cs = getComputedStyle(v); return (cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.02) || [...v.children].some((c) => !c.hidden && getComputedStyle(c).visibility === 'visible'); }).map((v) => v.dataset.view);
      window.__viewFrames.push(vis);
      if (now - t0 < 900) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const assertOnePage = async (what) => {
    await page.waitForTimeout(950);
    const frames = await page.evaluate(() => window.__viewFrames);
    const both = frames.filter((f) => f.length > 1);
    assert.ok(frames.length > 3 && both.length === 0, `${what}: one page on screen per frame (${both.length} of ${frames.length} frames showed ${JSON.stringify(both[0] || [])})`);
  };
  // what is left on screen of the pages that are not the current one: visible elements, and points of the
  // viewport where the pointer would reach one of them ('' = nothing)
  const leftover = () => page.evaluate(() => {
    const out = [];
    for (const v of document.querySelectorAll('.view:not(.is-active)')) {
      const k = [...v.querySelectorAll('*')].filter((e) => getComputedStyle(e).visibility === 'visible' && e.getClientRects().length).length;
      if (k) out.push(`${v.dataset.view}: ${k} elements visible`);
    }
    const cur = document.getElementById('app').dataset.currentView;
    let wrong = 0;
    for (let x = 0.1; x < 1; x += 0.2) for (let y = 0.15; y < 1; y += 0.14) { const e = document.elementFromPoint(innerWidth * x, innerHeight * y); const v = e && e.closest('.view'); if (v && v.dataset.view !== cur) wrong += 1; }
    if (wrong) out.push(`the pointer reaches another page at ${wrong} points`);
    return out.join('; ');
  });
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
    assert.equal((await page.textContent(`${NAV} a[data-nav="welcome"]`)).trim(), 'الرئيسية');
    // a phone has the four sections in a bar at the bottom; a computer keeps them in the header. No path bar here
    assert.equal(await page.isVisible('#tabbar'), mobile, 'the bottom bar is for phones');
    assert.equal(await page.isVisible('.site-nav'), !mobile, 'the header links are for wider screens');
    if (mobile) assert.deepEqual(await page.$$eval('#tabbar a', (as) => as.map((a) => a.textContent.trim())), ['الرئيسية', 'المخطط', 'ثلاثي الأبعاد', 'الصور']);
    assert.ok(await page.isHidden('#crumbs'), 'the welcome page has no path bar');
    if (team) {
      assert.equal(await page.textContent('#welcome-team'), TEAM, 'team name from ?team=');
      assert.match(await page.textContent('#welcome-title'), /^مرحبًا بفريق/);
    } else {
      assert.equal((await page.textContent('#welcome-title')).trim(), 'فرصة استحواذ');
    }
    assert.equal((await page.textContent('#welcome-subtitle')).trim(), 'مساحة تليق بأعمالك');
    assert.match(await page.textContent('#welcome-atmosphere'), /مقر إداري مفروش ومجهّز يجمع فريقك في مكان واحد/);
    const body = await page.textContent('body');
    for (const banned of ['احجز معاينة', 'التوأم الرقمي للمكتب', 'محطة عمل', 'مكتبًا إداريًا', 'الوضع الحالي']) {
      assert.ok(!body.includes(banned), `welcome must not contain «${banned}»`);
    }
    // Satr identity on the welcome page: wordmark, general location, slogan; footer with both numbers
    assert.equal((await page.textContent('#welcome-brand-name')).trim(), 'سطر العقارية', 'Satr wordmark');
    assert.match(await page.textContent('#welcome-location'), /مكتب مجهّز في\s*واجهة روشن للأعمال/, 'the opportunity headline');
    const facts = await page.$$eval('#welcome-facts .fact', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    assert.equal(facts.length, 2, 'two figures');
    assert.match(facts[0], /890\s*م²\s*مساحة المكتب/);
    assert.match(facts[1], /72\s*مكتبًا/);
    assert.match(await page.textContent('#welcome-slogan'), /نفهم الأصل/, 'Satr slogan');
    const footerText = await page.textContent('#app-footer');
    for (const must of ['+966 55 585 5057', '+966 54 417 1356', 'واجهة روشن للأعمال', 'جميع الحقوق محفوظة']) assert.ok(footerText.includes(must), `footer has «${must}»`);
    // the numbers themselves open WhatsApp, and TikTok is the account the owner gave (2026-11-10)
    assert.deepEqual(await page.$$eval('#app-footer a.footer-phone-number', (as) => as.map((a) => a.getAttribute('href'))), ['https://wa.me/966555855057', 'https://wa.me/966544171356'], 'each number is a WhatsApp link');
    assert.ok(await page.$('#app-footer a[href="https://www.tiktok.com/@satrksa1"]'), 'TikTok: @satrksa1');
    assert.ok(!footerText.includes('@'), 'no e-mail in the footer');
    // «add to the home screen» (owner, 2026-11-11): a phone is asked by itself; a computer never is
    if (mobile) {
      await page.waitForSelector('#install-bar:not([hidden])', { timeout: 5000 });
      const bar = await page.evaluate(() => { const b = document.getElementById('install-bar'); const r = b.getBoundingClientRect(); const t = document.getElementById('tabbar').getBoundingClientRect(); return { mode: b.dataset.mode, text: b.querySelector('.install-text').textContent, button: !b.querySelector('.install-go').hidden, bottom: r.bottom, tabTop: t.top, h: r.height }; });
      assert.equal(bar.mode, 'ios', 'iPhone: the hint, since a page cannot open the install dialog there');
      assert.match(bar.text, /زر المشاركة[\s\S]*إضافة إلى الشاشة الرئيسية/, `the hint names the two taps (${bar.text})`);
      assert.ok(!bar.button, 'no «add» button on an iPhone (it could do nothing)');
      assert.ok(Math.abs(bar.bottom - bar.tabTop) < 1 && bar.h >= 44, `the bar sits on the bottom bar (${JSON.stringify(bar)})`);
    } else {
      await page.waitForTimeout(1500);
      assert.equal(await page.locator('#install-bar').count(), 0, 'no install bar on a computer');
    }
    const floorWelcome = await barTop();
    const ctaStyle = await page.$eval('#btn-start', (b, floor) => { const r = b.getBoundingClientRect(); return { inView: r.top >= 0 && r.bottom <= floor + 0.5, w: r.width, bottom: r.bottom, floor }; }, floorWelcome);
    const fit = await page.evaluate(() => { const v = document.getElementById('view-welcome'); const f = document.getElementById('app-footer'); return { scrollH: v.scrollHeight, h: v.clientHeight, overflow: getComputedStyle(v).overflowY, footerBottom: f ? f.getBoundingClientRect().bottom : 0 }; });
    assert.ok(fit.scrollH <= fit.h + 1 || fit.overflow === 'auto', `welcome: nothing is cut off — it fits or it scrolls (${JSON.stringify(fit)})`);
    if (!mobile) assert.ok(fit.footerBottom <= fit.h + 1, `welcome: the footer is on the first screen on a desktop (${JSON.stringify(fit)})`);
    assert.ok(ctaStyle.inView && ctaStyle.w > 90, `call to action visible on the first screen (${JSON.stringify(ctaStyle)})`);
    // a light first visit: no 3D library, no gallery photos, no plan tiles until they are wanted
    const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));
    assert.ok(!loaded.some((p) => p.includes('three-bundle') || p.includes('twin3d')), 'welcome: the 3D viewer is not downloaded');
    assert.ok(!loaded.some((p) => /\/media\/rooms\//.test(p)), `welcome: no room photos downloaded (${loaded.filter((p) => p.includes('/media/rooms/')).length})`);
    assert.ok(!loaded.some((p) => p.includes('/media/plan/tiles/')), 'welcome: no plan tiles downloaded');
    await shot('welcome');
    // 2. the 2D plan opens by default: view tabs, dots, sidebar, routes, focus, red dot -> details
    step = '2a plan 2D';
    await watchViews();
    await click('#btn-start');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForFunction(() => document.querySelector('.plan2d-image') && document.querySelector('.plan2d-image').naturalWidth > 0);
    await assertOnePage('welcome → plan');
    assert.equal(await page.$eval('#plan-stage-wrap', (w) => w.dataset.mode), '2d', '2D is the default view');
    assert.ok(await page.isHidden('#plan-stage'), '3D stage hidden in 2D mode');
    assert.equal(await page.getAttribute('#view-tabs [data-view="2d"]', 'aria-selected'), 'true', '2D tab selected');
    assert.equal(await activeNav(), mobile ? 'المخطط' : 'مخطط المكتب', 'the navigation highlights the plan');
    assert.deepEqual(await crumbs(), ['المخطط'], 'path bar: the plan');
    assert.equal(await backLabel(), 'رجوع إلى الرئيسية', 'from the plan «back» leads home');
    if (mobile) {
      // the path bar takes the header's place, the plan ends above the bottom bar, and nothing scrolls sideways
      const dock = await barTop();
      const lay = await page.evaluate((dockTop) => { const c = document.getElementById('crumbs').getBoundingClientRect(); const side = document.getElementById('room-sidebar').getBoundingClientRect(); const bar = document.getElementById('tabbar').getBoundingClientRect(); return { crumbTop: c.top, header: getComputedStyle(document.getElementById('site-header')).display, sideBottom: side.bottom, barTop: dockTop, barBottom: bar.bottom, vh: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth }; }, dock);
      assert.ok(lay.crumbTop === 0 && lay.header === 'none', `phone: the path bar is the top bar (${JSON.stringify(lay)})`);
      assert.ok(lay.sideBottom <= lay.barTop + 0.5 && Math.abs(lay.barBottom - lay.vh) < 1, `phone: the page ends above the bottom bar (${JSON.stringify(lay)})`);
      assert.ok(lay.overflow <= 0, `phone: no sideways scroll (${lay.overflow}px)`);
    }
    assert.equal((await page.textContent('#header-owner')).trim(), 'شركة سطر العقارية', 'owner name at the end of the header');
    // one blinking white dot per room on the plan (the icons that replaced it for a day were withdrawn by the
    // owner, 2026-11-11); the icons of the kinds of space stay in the room list, the room panel and the gallery
    assert.ok((await page.locator('#plan2d-stage .dot-room').count()) >= 20, '2D: one dot per room');
    assert.equal(await page.locator('#plan2d-stage .dot-blue, #plan2d-stage .dot-red, #plan2d-stage .pin, #plan2d-stage .room-marker img').count(), 0, '2D: no second dot and no icon on the plan');
    const dotStyle = await page.$eval('#plan2d-stage .dot-room', (d) => ({ bg: getComputedStyle(d).backgroundColor, anim: getComputedStyle(d).animationName }));
    assert.match(dotStyle.bg, /rgba\(255, 255, 255, 0\.6\)/, `2D: the dot is white at 60% (${dotStyle.bg})`);
    assert.equal(dotStyle.anim, 'dot-blink', '2D: the dot blinks');
    assert.ok(await page.$eval('#room-list .room-item-btn[data-id="meeting-large"] img.type-icon', (i) => i.complete && i.naturalWidth > 0), 'the room list shows the icon of the kind of space');
    const listed = await page.$$eval('#room-list .room-item-name', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(listed.filter((t) => /^مكتب \d/.test(t)), [1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => `مكتب ${k}`), 'the room list: offices 1 to 9 in order');
    assert.deepEqual(listed.filter((t) => /^مكاتب موظفين/.test(t)), [1, 2, 3, 4, 5, 6].map((k) => `مكاتب موظفين ${k}`), 'the room list: employee areas 1 to 6 in order');
    assert.deepEqual(listed.filter((t) => /اجتماعات/.test(t)), ['قاعة اجتماعات 1', 'قاعة اجتماعات 2'], 'the room list: meeting rooms 1 and 2');
    const tags2d = await page.$$eval('#plan2d-stage .room-tag:not(.is-outside)', (els) => els.map((e) => e.textContent));
    assert.ok(tags2d.includes('مكاتب موظفين 1') && tags2d.includes('قاعة اجتماعات 1') && tags2d.includes('مكتب 9'), '2D: labels are room names with their numbers from the door');
    assert.ok(tags2d.every((t) => !/[0-9]/.test(t) || /^(مكتب|مكاتب موظفين|قاعة اجتماعات) [1-9]$/.test(t)), `2D: the only digits on the labels are the numbers from the door, never plan codes (${tags2d.filter((t) => /[0-9]/.test(t) && !/^(مكتب|مكاتب موظفين|قاعة اجتماعات) [1-9]$/.test(t))})`);
    const vis2d = await page.$$eval('#plan2d-stage .dot-room', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.left >= 0 && r.right <= innerWidth; }).length);
    assert.ok(vis2d >= 20, `2D dots on screen (${vis2d})`);
    await shot('plan-2d');
    // routes on the 2D plan
    await click('.scene-tab[data-scene="paths"]');
    await page.waitForFunction(() => location.hash === '#/plan?scene=paths');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#plan2d-stage .route2d').count(), 3, '2D: three routes');
    assert.ok(await page.$eval('#plan2d-stage .plan2d-routes', (g) => getComputedStyle(g).display !== 'none'), '2D: routes shown on the paths tab');
    assert.deepEqual(await crumbs(), ['المخطط · المسارات'], 'path bar: the routes scene');
    await shot('paths-2d');
    await click('.scene-tab[data-scene="current"]');
    await page.waitForFunction(() => location.hash === '#/plan');
    assert.ok(await page.$eval('#plan2d-stage .plan2d-routes', (g) => getComputedStyle(g).display === 'none'), '2D: routes hidden on the layout tab');
    // focus a room on the 2D plan from the list: zoom-in, veil, card; the same item again returns to the plan
    await click('#room-list .room-item-btn[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');
    await page.waitForFunction(() => document.getElementById('plan2d-stage').dataset.focus === 'meeting-large');
    await page.waitForTimeout(900);
    assert.ok(await page.isVisible(panel), '2D: the room panel is shown');
    assert.equal((await page.textContent(panelTitle)).trim(), 'قاعة اجتماعات 1', '2D: the room by its name and number');
    assert.deepEqual(await crumbs(), ['المخطط', 'قاعة اجتماعات 1'], 'path bar: plan ‹ room');
    assert.equal(await backLabel(), 'رجوع إلى المخطط', '«back» names where it leads');
    if (!mobile) {
      // a computer: the right side stays the list of rooms, whole; everything about the room is in the drawer
      assert.ok(await page.isHidden('#room-card'), 'computer: no room card under the list');
      const list = await page.evaluate(() => { const l = document.getElementById('room-list').getBoundingClientRect(); const s = document.getElementById('room-sidebar').getBoundingClientRect(); return { h: l.height, side: s.height }; });
      assert.ok(list.h > list.side * 0.8, `computer: the list keeps the whole sidebar (${list.h.toFixed(0)} of ${list.side.toFixed(0)}px)`);
    }
    assert.ok(await page.$eval('#plan2d-stage .plan2d-veil', (v) => getComputedStyle(v).display !== 'none'), '2D: neighbours dimmed');
    const box2d = await page.evaluate(() => { const st = document.getElementById('plan2d-stage'); const b = st.__twin.roomScreenBox('meeting-large'); return { size: Math.max(b.w, b.h), stage: Math.min(st.clientWidth, st.clientHeight) }; });
    assert.ok(box2d.size > box2d.stage * 0.4, `2D: zoomed to the room (room ${box2d.size.toFixed(0)}px on ${box2d.stage.toFixed(0)}px)`);
    // zoomed in: the high-resolution tiles for the part in view arrive, and the settled plan is no
    // longer a frozen compositor layer (it is redrawn sharp at this zoom)
    // (when the screen shows more pixels than the light base image has; a 1x screen at a mild zoom doesn't)
    await page.waitForTimeout(400);
    const tinfo = await page.evaluate(() => document.getElementById('plan2d-stage').__twin.tileInfo());
    if (tinfo.need > tinfo.base * 1.05) await page.waitForFunction(() => document.getElementById('plan2d-stage').__twin.tileInfo().loaded > 0, null, { timeout: 15000 });
    const tiles2d = await page.evaluate(() => ({ ...document.getElementById('plan2d-stage').__twin.tileInfo(), moving: document.querySelector('.plan2d-world').classList.contains('is-moving'), wc: getComputedStyle(document.querySelector('.plan2d-world')).willChange }));
    if (tiles2d.need > tiles2d.base * 1.05) assert.ok(tiles2d.loaded >= 1 && tiles2d.requested <= 12, `2D: only the tiles in view are fetched (${JSON.stringify(tiles2d)})`);
    else assert.equal(tiles2d.requested, 0, `2D: the base image suffices at this zoom (${JSON.stringify(tiles2d)})`);
    assert.ok(!tiles2d.moving && tiles2d.wc === 'auto', `2D: settled plan is redrawn at the current zoom (${JSON.stringify(tiles2d)})`);
    await shot('focus-2d');
    await click('#room-list .room-item-btn[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForFunction(() => !document.getElementById('plan2d-stage').dataset.focus);
    // the room's dot opens the room details (photos included) — a real pointer click: the stage's pan
    // handler must not capture the pointer away from the dot. On a phone, zoom to the reception first.
    if (mobile) {
      await click('#room-list .room-item-btn[data-id="reception"]');
      await page.waitForFunction(() => document.getElementById('plan2d-stage').dataset.focus === 'reception');
      await page.waitForTimeout(900);
    }
    await page.locator('#plan2d-stage .room-marker[data-id="reception"] .dot-room').click();
    await page.waitForFunction(() => location.hash === '#/room/reception/details');
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'details');
    await page.waitForFunction(() => { const i = document.querySelector('#details-stage .details-render'); return i && i.complete && i.naturalWidth > 0; });
    assert.ok((await page.locator('#details-photos button').count()) >= 3, '2D dot -> details with photos');
    assert.deepEqual(await crumbs(), ['المخطط', 'الاستقبال', 'التفاصيل'], 'path bar: plan ‹ room ‹ details');
    // every part of the path is a link: the first one goes straight to the plan from anywhere
    assert.equal(await page.getAttribute('#crumb-list li[data-crumb="plan"] a', 'href'), '#/plan');
    assert.equal(await page.getAttribute('#crumb-list li[data-crumb="room"] a', 'href'), '#/room/reception');
    await back();
    await page.waitForFunction(() => location.hash === '#/room/reception');
    await page.goto(`${url}/#/room/reception/details`);
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'details');
    await click('#crumb-list li[data-crumb="plan"] a');
    await page.waitForFunction(() => location.hash === '#/plan' && document.getElementById('app').dataset.currentView === 'plan');
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
    // the +/− buttons are the visitor's framing like the wheel and the pinch: a resize afterwards (the
    // phone rotates, the browser chrome shows) keeps their zoom instead of re-framing the focused room
    step = '2b button zoom survives a resize (2D)';
    await click('#room-list .room-item-btn[data-id="meeting-large"]');
    await page.waitForFunction(() => document.getElementById('plan2d-stage').dataset.focus === 'meeting-large');
    await page.waitForTimeout(1200); // the focus flight (and, on phones, the re-frame once the card opens below the stage)
    // the visitor's zoom over the fitted plan: stage px per plan px, divided by the fit (the world's untransformed width / the plan's)
    const zoomOf2d = () => page.evaluate(() => {
      const st = document.getElementById('plan2d-stage');
      const fit = parseFloat(st.querySelector('.plan2d-world').style.width) / st.querySelector('.plan2d-image').naturalWidth;
      return (st.__twin.project(1, 0).x - st.__twin.project(0, 0).x) / fit;
    });
    const framed2d = await zoomOf2d();
    await click('.zoom-btn[data-zoom="in"]');
    await click('.zoom-btn[data-zoom="in"]');
    const zoomed2d = await zoomOf2d();
    assert.ok(zoomed2d > framed2d * 1.3, `2D: + twice zooms in on the focused room (${framed2d.toFixed(2)}x -> ${zoomed2d.toFixed(2)}x)`);
    const vp2d = page.viewportSize();
    await page.setViewportSize({ width: vp2d.width, height: Math.round(vp2d.height * 0.78) });
    await page.waitForTimeout(600); // ResizeObserver -> resize()
    const resized2d = await zoomOf2d();
    assert.ok(Math.abs(resized2d - zoomed2d) < zoomed2d * 0.01, `2D: the button zoom is kept across a resize (${zoomed2d.toFixed(2)}x -> ${resized2d.toFixed(2)}x; the room's own frame is ${framed2d.toFixed(2)}x)`);
    await page.setViewportSize(vp2d);
    await page.waitForTimeout(600);
    await click('#room-list .room-item-btn[data-id="meeting-large"]'); // the same item again: back to the plan
    await page.waitForFunction(() => location.hash === '#/plan' && !document.getElementById('plan2d-stage').dataset.focus);
    await page.waitForTimeout(800);
    // a list-only space (the corridors) opens its details straight from the list
    await click('#room-list .room-item-btn[data-id="corridors"]');
    await page.waitForFunction(() => location.hash === '#/room/corridors/details');
    assert.deepEqual(await crumbs(), ['المخطط', 'الممرات'], 'a list-only space: plan ‹ its details');
    // its picture is the office in the 3D model, like every other space: never a crop of the 2D plan
    await page.waitForFunction(() => { const i = document.querySelector('#details-stage .details-render'); return i && i.complete && i.naturalWidth > 0; });
    assert.match(await page.getAttribute('#details-stage .details-render', 'src'), /media\/twin\/rooms\/corridors\.webp\?v=[0-9a-f]{10}$/, 'corridors: the 3D picture of the office');
    await back();
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'plan');
    await page.goto(`${url}/#/plan`);
    await page.waitForFunction(() => !document.getElementById('plan2d-stage').dataset.focus);

    // 2c. the photos are easy to reach: header «الصور» -> gallery card -> the room's photos -> back to the gallery
    step = '2c gallery';
    assert.ok(await page.isVisible(`${NAV} a[data-nav="gallery"]`), 'the photos entry is on screen');
    await nav('gallery');
    await page.waitForFunction(() => location.hash === '#/gallery' && document.getElementById('app').dataset.currentView === 'gallery');
    const cards = await page.locator('#gallery-grid .gallery-card').count();
    assert.ok(cards >= 20, `a card per room with photos (${cards})`);
    assert.equal(await activeNav(), 'الصور', 'the navigation highlights the photos');
    assert.deepEqual(await crumbs(), ['المخطط', 'معرض الصور'], 'path bar: plan ‹ gallery');
    assert.ok(await page.$eval('#gallery-grid .gallery-card[data-id="bleachers"] .gallery-icon img', (i) => i.complete && i.naturalWidth > 0), 'gallery cards carry the icon of the kind of space');
    // the small copy is on the card at once (from the one-file pack), then the card-sized cover replaces it
    await page.locator('#gallery-grid .gallery-card[data-id="bleachers"]').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => { const i = document.querySelector('#gallery-grid .gallery-card[data-id="bleachers"] > img'); return i && i.dataset.sharp === '1' && i.complete && i.naturalWidth > 0; });
    assert.match(await page.textContent('#gallery-grid .gallery-card[data-id="bleachers"] .gallery-count'), /4 صور/);
    assert.match(await page.$eval('#gallery-grid .gallery-card[data-id="bleachers"] > img', (i) => i.getAttribute('src')), /\/cover\.webp$/, 'gallery: card-sized cover, not the full photo');
    await shot('gallery');
    await watchViews();
    await page.locator('#gallery-grid .gallery-card[data-id="bleachers"]').click();
    await page.waitForFunction(() => location.hash === '#/room/bleachers/photos' && document.getElementById('app').dataset.currentView === 'photos');
    await assertOnePage('gallery → photos');
    assert.deepEqual(await crumbs(), ['المخطط', 'معرض الصور', 'صور مدرج جلوس داخلي'], 'path bar: plan ‹ gallery ‹ the room\'s photos');
    assert.equal(await backLabel(), 'رجوع إلى معرض الصور');
    await back();
    await page.waitForFunction(() => location.hash === '#/gallery');
    // A quick visitor: back to the gallery, then straight on to a room while the gallery's content is still
    // fading in. Nothing of the gallery may stay visible or clickable over the plan. It did, in Chrome, in
    // roughly one visit out of two of exactly this kind (a real click on a card after a repaint, back, on):
    // the block that had been animating kept the "visible" it had inherited before its page was hidden.
    for (let round = 1; round <= 5; round++) {
      await page.goto(`${url}/#/room/meeting-large`);
      await page.waitForFunction(() => !document.getElementById('focus-thumbs').hidden);
      await page.waitForTimeout(350); // longer than the fade-in
      assert.equal(await leftover(), '', `leaving the gallery at once leaves nothing of it on screen (round ${round})`);
      await page.goto(`${url}/#/plan`);
      await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'plan' && location.hash === '#/plan');
      await nav('gallery');
      await page.waitForFunction(() => location.hash === '#/gallery' && document.getElementById('app').dataset.currentView === 'gallery');
      await page.waitForTimeout(250);
      await page.screenshot({ type: 'jpeg', quality: 30 }); // the repaint is part of the recipe (not saved)
      await page.locator('#gallery-grid .gallery-card[data-id="bleachers"]').click();
      await page.waitForFunction(() => location.hash === '#/room/bleachers/photos' && document.getElementById('app').dataset.currentView === 'photos');
      await page.waitForTimeout(950);
      await back();
      await page.waitForFunction(() => location.hash === '#/gallery');
    }
    // the room's panel shows its photos; a thumbnail opens the photos at that picture
    await page.goto(`${url}/#/room/meeting-large`);
    await page.waitForFunction(() => !document.getElementById('focus-thumbs').hidden);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.thumbs), 'pack', 'the small pictures came in one file');
    if (!mobile) {
      // a computer: the drawer is the room's only panel (cover, facts, every photo, two actions)
      await page.waitForFunction(() => !document.getElementById('room-drawer').hidden);
      assert.equal((await page.textContent('#drawer-title')).trim(), 'قاعة اجتماعات 1', 'drawer names the room');
      await page.waitForFunction(() => { const i = document.getElementById('drawer-image'); return i.complete && i.naturalWidth > 0; });
      assert.ok(await page.$eval('#drawer-hero', (f) => f.getBoundingClientRect().height > 120), 'the drawer cover image is visible (not collapsed)');
      assert.equal(await page.locator('#drawer-photos .drawer-photo').count(), 9, 'every photo of the room in the drawer');
      assert.ok(await page.$$eval('#drawer-photos .drawer-photo img', (is) => is.every((i) => i.getAttribute('src').startsWith('blob:'))), 'drawer thumbnails are drawn from memory, not fetched one by one');
      assert.match(await page.textContent('#btn-drawer-photos'), /الصور الحقيقية \(9\)/);
      await page.waitForTimeout(1000); // the stage narrowed: the focus re-frames for the new width
      const framed = await page.evaluate(() => { const st = document.getElementById('plan2d-stage'); const b = st.__twin.roomScreenBox('meeting-large'); return { inside: b.x >= 0 && b.y >= 0 && b.x + b.w <= st.clientWidth + 1 && b.y + b.h <= st.clientHeight + 1, stageW: st.clientWidth }; });
      assert.ok(framed.inside, `the room stays fully framed beside the drawer (${JSON.stringify(framed)})`);
      await shot('drawer');
      await page.locator('#drawer-photos .drawer-photo').nth(1).click();
    } else {
      assert.ok(await page.isHidden('#room-drawer'), 'no drawer on phones');
      assert.equal(await page.locator('#focus-thumbs .focus-thumb').count(), 4, 'four thumbnails in the card');
      assert.ok(await page.$$eval('#focus-thumbs .focus-thumb img', (is) => is.every((i) => i.getAttribute('src').startsWith('blob:'))), 'card thumbnails are drawn from memory, not fetched one by one');
      const card = { actionsBottom: await page.$eval('#room-card .focus-actions', (a) => a.getBoundingClientRect().bottom), barTop: await barTop() };
      assert.ok(card.actionsBottom <= card.barTop + 0.5, `phone: the card's buttons sit above the bottom bar and the install bar (${JSON.stringify(card)})`);
      await page.locator('#focus-thumbs .focus-thumb').nth(1).click();
    }
    await page.waitForFunction(() => location.hash === '#/room/meeting-large/photos');
    // the photo is on screen at once as its small copy, then sharp
    await page.waitForFunction(() => { const i = document.getElementById('room-photo'); return i.complete && i.naturalWidth > 0; });
    await page.waitForFunction(() => (document.getElementById('room-photo').getAttribute('src') || '').includes('/02.webp') && document.getElementById('room-photo').dataset.sharp === '1');
    assert.ok(!(await page.$eval('#room-photo', (i) => i.classList.contains('is-soft'))), 'the sharp photo replaced the soft copy');
    assert.deepEqual(await crumbs(), ['المخطط', 'قاعة اجتماعات 1', 'الصور'], 'path bar: plan ‹ room ‹ photos');
    assert.equal(await backLabel(), 'رجوع إلى قاعة اجتماعات 1');
    await back();
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');
    assert.ok(await page.isVisible(panel), 'back on the room');
    if (!mobile) {
      // closing the drawer leaves the room: back to the whole plan
      await click('#btn-drawer-close');
      await page.waitForFunction(() => location.hash === '#/plan' && document.getElementById('room-drawer').hidden && !document.getElementById('plan2d-stage').dataset.focus);
    } else {
      // a phone: the bottom bar's «plan» entry leaves the room from anywhere
      await nav('plan2d');
      await page.waitForFunction(() => location.hash === '#/plan?view=2d' && !document.getElementById('plan2d-stage').dataset.focus);
    }
    await page.goto(`${url}/#/plan`);
    await page.waitForFunction(() => location.hash === '#/plan' && !document.getElementById('plan2d-stage').dataset.focus);

    // 2d. pictures survive the host's verification page. On the live host (2026-11-10) the security service in
    // front of the site answered a photo's address with its «checking your browser» page (403, cf-mitigated:
    // challenge, text/html) once the visitor's clearance had run out, and the visitor saw broken pictures.
    step = '2d verification page';
    {
      let refusing = false;
      let documents = 0;
      const gate = async (route) => {
        const req = route.request();
        if (req.resourceType() === 'document') { documents += 1; refusing = false; return route.continue(); } // a page load renews the clearance
        if (refusing) return route.fulfill({ status: 403, contentType: 'text/html; charset=UTF-8', headers: { 'cf-mitigated': 'challenge' }, body: '<!DOCTYPE html><title>Just a moment...</title>' });
        return route.continue();
      };
      await page.route(`${url}/**`, gate);
      await page.goto(`${url}/#/room/lounge`);
      await page.waitForFunction(() => document.getElementById('plan2d-stage').dataset.focus === 'lounge' && document.documentElement.dataset.thumbs === 'pack');
      expectRefusals = true;
      refusing = true; // the clearance has run out: from now on every request gets the verification page
      const before = documents;
      await page.evaluate(() => { location.hash = '#/room/reception/photos'; });
      // at once: the strip and the photo's small copy come from memory; nothing shows a broken-picture mark
      await page.waitForFunction(() => { const i = document.getElementById('room-photo'); return location.hash === '#/room/reception/photos' && i.complete && i.naturalWidth > 0; });
      assert.deepEqual(await brokenPictures(), [], 'nothing on screen is a broken picture while the host refuses');
      // the site notices the verification page, reloads once on the same address, and the photo arrives sharp
      await page.waitForFunction(() => { const i = document.getElementById('room-photo'); return i && i.dataset.sharp === '1' && /reception\/01\.webp/.test(i.getAttribute('src') || ''); }, null, { timeout: 30000 });
      assert.equal(documents - before, 1, 'one reload renewed the clearance');
      assert.equal(new URL(page.url()).hash, '#/room/reception/photos', 'the visitor is back on the same room');
      assert.deepEqual(await brokenPictures(), [], 'no broken picture after the renewal');
      // refused again a moment later: no second reload (no loop); the visitor gets a plain notice with a button
      await page.waitForFunction(() => document.documentElement.dataset.thumbs === 'pack');
      refusing = true;
      // the third photo: not a neighbour of the first, so it was not fetched ahead while the host still answered
      await page.locator('#gallery-thumbs .thumb').nth(2).click();
      await page.waitForSelector('.gate-bar button', { timeout: 20000 });
      assert.equal(documents - before, 1, 'the site does not reload itself twice in a row');
      assert.match(await page.textContent('.gate-bar'), /التحقق الأمني/);
      assert.deepEqual(await brokenPictures(), [], 'still no broken picture: the soft copy stays');
      assert.ok(await page.$eval('#room-photo', (i) => i.complete && i.naturalWidth > 0 && i.getAttribute('src').startsWith('blob:')), 'the photo keeps its small copy on screen');
      refusing = false;
      await page.unroute(`${url}/**`, gate);
      await page.goto('about:blank');
      await page.goto(`${url}/#/plan`);
      await page.waitForFunction(() => location.hash === '#/plan' && document.getElementById('app').dataset.currentView === 'plan' && !document.getElementById('plan2d-stage').dataset.focus);
      await page.evaluate(() => sessionStorage.removeItem('gate-reload'));
      expectRefusals = false;
    }

    if (mobile) {
      // × puts the install bar away; the pages take the freed space, and it stays away after a reload
      step = '2e install bar';
      await page.waitForSelector('#install-bar:not([hidden])', { timeout: 8000 }); // it comes back with every page load until it is closed
      const before = await barTop();
      await click('#install-bar .install-close');
      await page.waitForFunction(() => document.getElementById('install-bar').hidden && !document.getElementById('app').classList.contains('has-install'));
      assert.ok((await barTop()) > before + 40, 'the pages get the bar\'s space back');
      await page.goto('about:blank');
      await page.goto(`${url}/#/plan`);
      await page.waitForFunction(() => location.hash === '#/plan' && document.getElementById('app').classList.contains('is-ready'));
      await page.waitForTimeout(1800); // longer than the bar waits before it shows
      assert.equal(await page.locator('#install-bar:not([hidden])').count(), 0, 'closed once, the install bar does not come back on the next visit');
      await page.waitForFunction(() => !document.getElementById('plan2d-stage').dataset.focus);
    }

    if (process.env.E2E_UNTIL === '2d-plan') { console.log(`✓ ${name}: 2D steps passed (E2E_UNTIL)`); return; } // quick loop over the steps that need no WebGL

    // 2. switch to the live 3D model: two scene tabs, sidebar list, dots legend
    step = '2 plan 3D';
    if (mobile) await nav('plan3d'); else await click('#view-tabs [data-view="3d"]'); // a phone switches the view from the bottom bar
    await modelReady();
    await page.waitForFunction(() => document.getElementById('plan-stage-wrap').dataset.mode === '3d');
    await page.waitForTimeout(1200);
    assert.ok(await page.isHidden('#plan2d-stage'), '2D stage hidden in 3D mode');
    assert.equal(await activeNav(), mobile ? 'ثلاثي الأبعاد' : 'المخطط ثلاثي الأبعاد', 'the navigation highlights the 3D plan');
    assert.equal(await page.locator('#scene-tabs .scene-tab').count(), 2, 'two scene tabs');
    assert.equal((await page.textContent('.scene-tab[data-scene="current"]')).trim(), 'توزيعات المكاتب');
    assert.ok(await page.$('#plan-stage canvas'), 'WebGL canvas present');
    assert.ok((await page.locator('#room-list .room-item-btn').count()) >= 20, 'sidebar lists the rooms');
    assert.ok((await page.locator('#overlay-dots .dot-room').count()) >= 20, 'one dot per room');
    assert.equal(await page.locator('#overlay-dots .dot-blue, #overlay-dots .dot-red, #overlay-dots .pin, #overlay-dots .room-marker img').count(), 0, 'no second dot and no icon on the model');
    const visibleBlue = await page.$$eval('#overlay-dots .dot-room', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && getComputedStyle(e).display !== 'none' && r.left >= 0 && r.right <= innerWidth; }).length);
    assert.ok(visibleBlue >= 20, `dots visible on screen at the default view (${visibleBlue})`);
    // dots sit inside the stage, never outside the model's screen box
    const stageBox = await page.locator('#plan-stage').boundingBox();
    const outside = await page.$$eval('#overlay-dots .room-marker .dot-room', (els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
    for (const [x, y] of outside) assert.ok(x >= stageBox.x && x <= stageBox.x + stageBox.width && y >= stageBox.y && y <= stageBox.y + stageBox.height, `dot inside the stage (${x.toFixed(0)},${y.toFixed(0)})`);
    if (!mobile) {
      const sb = await page.locator('#room-sidebar').boundingBox();
      assert.ok(sb.x + sb.width / 2 > stageBox.x + stageBox.width / 2, 'sidebar sits on the right (RTL)');
    }
    await shot('plan');

    // 2b. lighting toggle: day by default, evening on request, remembered
    step = '2b lighting';
    assert.equal(await page.getAttribute('#plan-stage', 'data-lighting'), 'day', 'daylight by default');
    assert.equal(await page.getAttribute('#plan-stage', 'data-lit'), 'day', 'the baked daylight is on the model');
    // mean brightness of the canvas: the baked evening is clearly darker than the baked day, and neither is black
    const meanLuma = () => page.evaluate(async () => {
      const url = document.getElementById('plan-stage').__twin.snapshot(0.8);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas');
      c.width = 96; c.height = 60;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 96, 60);
      const d = g.getImageData(24, 15, 48, 30).data; // the middle of the stage: the model
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return s / (d.length / 4);
    });
    const lumaDay = await meanLuma();
    await click('#btn-lighting');
    await page.waitForFunction(() => document.getElementById('plan-stage').dataset.lighting === 'night');
    await page.waitForFunction(() => document.getElementById('plan-stage').dataset.lit === 'night', null, { timeout: 60000 }); // the evening maps load on demand
    const lumaNight = await meanLuma();
    assert.ok(lumaDay > 55, `baked daylight lights the model (mean luma ${lumaDay.toFixed(0)})`);
    assert.ok(lumaNight > 14 && lumaNight < lumaDay * 0.8, `baked evening: darker than the day, not black (day ${lumaDay.toFixed(0)}, night ${lumaNight.toFixed(0)})`);
    await page.waitForTimeout(900);
    await shot('night');
    await click('#btn-lighting');
    await page.waitForFunction(() => document.getElementById('plan-stage').dataset.lighting === 'day');
    await page.waitForFunction(() => document.getElementById('plan-stage').dataset.lit === 'day');

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

    // 3. the room from the list -> the room in its 3D context; the card appears in the sidebar
    step = '3 focus';
    await click('#room-list .room-item-btn[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large', null, { timeout: 60000 });
    await focusedOn('meeting-large');
    await settled();
    assert.ok(await page.isVisible(panel), 'the room panel is shown');
    assert.equal((await page.textContent(panelTitle)).trim(), 'قاعة اجتماعات 1', 'room named with its number, not its plan code');
    assert.match(await page.textContent(panelFacts), /16 مقعدًا/);
    assert.match(await page.textContent(panelFacts), /قاعة اجتماعات بفرشها الحالي/);
    assert.ok(await page.evaluate((sel) => !!document.activeElement.closest(sel), panel), 'keyboard focus moved to the room panel');
    assert.ok(await page.$eval('#room-list .room-item-btn[data-id="meeting-large"]', (b) => b.classList.contains('is-active')), 'sidebar item highlighted');
    // the focused room must be a real close-up: its floor spans a good share of the stage
    const roomPx = await page.evaluate(() => {
      const st = document.getElementById('plan-stage');
      const b = st.__twin.roomScreenBox('meeting-large');
      return { size: Math.max(b.w, b.h), stage: Math.min(st.clientWidth, st.clientHeight) };
    });
    assert.ok(roomPx.size > roomPx.stage * (mobile ? 0.22 : 0.3), `focused room is a close-up (room ${roomPx.size.toFixed(0)}px on a ${roomPx.stage.toFixed(0)}px stage)`);
    const floor = await barTop();
    for (const sel of mobile ? ['#btn-photos', '#btn-focus-details', '#crumb-back'] : ['#btn-drawer-photos', '#btn-drawer-details', '#btn-drawer-close', '#crumb-back']) {
      const bb = await page.locator(sel).boundingBox();
      assert.ok(bb && bb.y >= 0 && bb.y + bb.height <= floor + 0.5, `${sel} on screen (above the bottom bar on a phone)`);
    }
    await shot('focus');

    // 3b. clicking the same room again returns to the plan; clicking another room switches
    step = '3b toggle';
    await click('#room-list .room-item-btn[data-id="meeting-large"]');
    await page.waitForFunction(() => location.hash === '#/plan');
    await page.waitForFunction(() => !document.getElementById('plan-stage').dataset.focus, null, { timeout: 60000 });
    assert.ok(await page.isHidden(panel), 'the room panel closes after the second click');
    await click('#room-list .room-item-btn[data-id="ceo"]');
    await page.waitForFunction(() => location.hash === '#/room/ceo');
    await focusedOn('ceo');

    // 4. photos button -> real photos, gallery, back to the model.
    // A quick visitor opens the photos while the camera is still flying to the room: hidden behind the photos,
    // the model must not keep drawing that flight (wasted GPU work; on a slow GPU the unseen frames piled up
    // and froze the page for a long while on the way back)
    step = '4 photos';
    await page.evaluate(() => {
      window.__hiddenFrames = 0;
      window.__stopCount = document.getElementById('plan-stage').__twin.onFrame(() => { if (document.getElementById('app').dataset.currentView !== 'plan') window.__hiddenFrames += 1; });
    });
    await page.evaluate((photosBtn) => new Promise((res) => {
      document.querySelector('#room-list .room-item-btn[data-id="meeting-large"]').click();
      setTimeout(() => { document.querySelector(photosBtn).click(); res(); }, 60); // the 1.1 s flight has only begun
    }), panelPhotos);
    await page.waitForFunction(() => location.hash === '#/room/meeting-large/photos');
    await page.waitForFunction(() => {
      const img = document.getElementById('room-photo');
      return img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    assert.equal((await page.textContent('#room-title')).trim(), 'قاعة اجتماعات 1');
    await shot('photos');
    await click('#gallery-next');
    await page.waitForFunction(() => (document.getElementById('room-photo').getAttribute('src') || '').includes('/02.webp'), null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__hiddenFrames), 0, 'the 3D model draws nothing behind the photos');
    await back();
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');
    await page.waitForTimeout(500);
    assert.ok(await page.isVisible(panel), 'back on the 3D view of the room');
    // the flight that was cut short landed on the room: the first frame back shows its close-up, at rest
    await focusedOn('meeting-large');
    await settled();
    await page.evaluate(() => window.__stopCount());
    const landed = await page.evaluate(() => {
      const st = document.getElementById('plan-stage');
      const b = st.__twin.roomScreenBox('meeting-large');
      return { size: Math.max(b.w, b.h), stage: Math.min(st.clientWidth, st.clientHeight) };
    });
    assert.ok(landed.size > landed.stage * (mobile ? 0.22 : 0.3), `back from the photos the camera rests on the room (room ${landed.size.toFixed(0)}px on a ${landed.stage.toFixed(0)}px stage)`);

    // 4b. a room with photos but no documented capacity still opens its photos (red dot)
    step = '4b other room photos';
    await page.goto(`${url}/#/room/reception/photos`);
    await page.waitForFunction(() => location.hash === '#/room/reception/photos');
    await page.waitForFunction(() => { const i = document.getElementById('room-photo'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 60000 });
    assert.equal((await page.textContent('#room-title')).trim(), 'الاستقبال');
    // a room without photos never shows a photo view
    await page.goto(`${url}/#/room/store/photos`);
    await page.waitForFunction(() => location.hash === '#/room/store');

    // 5b. details deep link for a room that has no real photos: no gallery crash, message + model snapshot
    step = '5b details without photos';
    await page.goto(`${url}/#/room/store/details`);
    await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'details', null, { timeout: 60000 });
    assert.ok((await page.textContent('#details-photos')).includes('لا توجد صور حقيقية'), 'no-photos message');
    await page.waitForFunction(() => { const i = document.querySelector('#details-stage .details-render'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 60000 });
    assert.ok(await page.isHidden('#btn-photos') && await page.isHidden('#btn-details-photos'), 'no photos button for a room without photos');
    // every space has its 3D picture now: the store shows its own close-up, not a crop of the plan
    assert.match(await page.getAttribute('#details-stage .details-render', 'src'), /media\/twin\/rooms\/store\.webp\?v=[0-9a-f]{10}$/, 'store: its 3D close-up');

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
    assert.match(detailsSrc, /media\/twin\/rooms\/meeting-large\.webp\?v=[0-9a-f]{10}$/, `room render shown at its fingerprinted address, got ${detailsSrc}`);
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
    // the details page leads to the photos in one tap, and the path leads back
    assert.match(await page.textContent('#btn-details-photos'), /الصور الحقيقية \(9\)/);
    await click('#btn-details-photos');
    await page.waitForFunction(() => location.hash === '#/room/meeting-large/photos');
    await back();
    await page.waitForFunction(() => location.hash === '#/room/meeting-large');

    // 6. home and browser history
    step = '6 navigation';
    if (mobile) await nav('welcome'); else await click('#nav-home');
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
    await back();
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
    assert.ok(await page.isHidden(panel), 'no stale room panel after a race');

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

    // 6d2. a wheel/drag during a 3D focus flight takes over: the flight must not finish on top of the gesture
    step = '6d2 interaction cancels the flight';
    const takeover = await page.evaluate(async () => {
      const twin = document.getElementById('plan-stage').__twin;
      await twin.focusRoom('ceo'); // a completed flight: the framing the flight would reach
      await twin.settled();
      const focused = twin.planPixelSize();
      await twin.unfocus({ animate: false });
      const home = twin.planPixelSize();
      twin.focusRoom('ceo'); // animated again, not awaited
      await new Promise((r) => setTimeout(r, 150));
      const canvas = document.querySelector('#plan-stage canvas');
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })); // the visitor zooms out
      await new Promise((r) => setTimeout(r, 2500)); // longer than the 1.1 s flight (and a few software-GL frames)
      await twin.settled();
      const after = twin.planPixelSize();
      await twin.unfocus({ animate: false });
      return { focused, home, after };
    });
    // with the flight cancelled the camera stays wherever the wheel left it (≤ 0.94× the flight's framing
    // for one notch); if the flight had finished on top of the gesture the size would equal `focused`
    assert.ok(takeover.after < takeover.focused * 0.96, `the flight did not override the wheel (after ${takeover.after.toFixed(0)}px, flight target ${takeover.focused.toFixed(0)}px, home ${takeover.home.toFixed(0)}px)`);

    // 6d3. the +/− buttons are the visitor's framing too: a resize keeps their zoom instead of re-fitting the
    // home view; the reset returns to the automatic framing, which the next resize fits to the new size again
    step = '6d3 button zoom survives a resize (3D)';
    // the camera's zoom independent of the stage size: with a fixed vertical field of view, what a still camera
    // projects scales with the stage height alone
    const zoomOf3d = () => page.evaluate(() => { const st = document.getElementById('plan-stage'); return st.__twin.planPixelSize() / st.clientHeight; });
    await page.evaluate(() => document.getElementById('plan-stage').__twin.resetView());
    await settled();
    const home3d = await zoomOf3d();
    await click('.zoom-btn[data-zoom="in"]');
    await settled();
    await click('.zoom-btn[data-zoom="in"]');
    await settled();
    const zoomed3d = await zoomOf3d();
    assert.ok(zoomed3d > home3d * 1.3, `3D: + twice zooms in (${home3d.toFixed(3)} -> ${zoomed3d.toFixed(3)})`);
    const vp3d = page.viewportSize();
    await page.setViewportSize({ width: vp3d.width, height: Math.round(vp3d.height * 0.78) });
    await page.waitForTimeout(600); // ResizeObserver -> resize()
    await settled();
    const resized3d = await zoomOf3d();
    assert.ok(Math.abs(resized3d - zoomed3d) < zoomed3d * 0.01, `3D: the button zoom is kept across a resize (${zoomed3d.toFixed(3)} -> ${resized3d.toFixed(3)}; home ${home3d.toFixed(3)})`);
    await page.setViewportSize(vp3d);
    await page.waitForTimeout(600);
    await settled();
    // after the reset a resize re-fits the home view: the same frame an explicit reset gives at the new size
    await page.evaluate(() => document.getElementById('plan-stage').__twin.resetView());
    await settled();
    await page.setViewportSize({ width: vp3d.width, height: Math.round(vp3d.height * 1.35) }); // a taller (narrower) stage: the horizontal fit tightens, so the fit distance moves
    await page.waitForTimeout(600);
    await settled();
    const refit3d = await zoomOf3d();
    await page.evaluate(() => document.getElementById('plan-stage').__twin.resetView());
    await settled();
    const explicit3d = await zoomOf3d();
    assert.ok(Math.abs(refit3d - explicit3d) < explicit3d * 0.01, `3D: after a reset the resize re-fits the home view (${refit3d.toFixed(3)} vs an explicit reset ${explicit3d.toFixed(3)})`);
    await page.setViewportSize(vp3d);
    await page.waitForTimeout(600);
    await settled();

    // 6e. details requested while the flight to the room is still in progress: the snapshot is taken at the end of the flight
    // Every room has its Cycles close-up now, so the live snapshot is only the fallback for a room added before
    // its render exists: the test plays such a room by serving the data without the CFO office's render.
    step = '6e details mid-flight';
    await page.route('**/data/office.json', async (route) => {
      const res = await route.fetch();
      const d = await res.json();
      for (const r of d.rooms) if (r.id === 'cfo') delete r.render;
      await route.fulfill({ response: res, json: d });
    });
    await page.goto('about:blank');
    await page.goto(`${url}/#/plan`); // layout scene: no animated routes, so two snapshots of a still camera are identical
    await modelReady();
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
    // Playwright's call log says why an action waited (covered by another element, not stable, ...)
    for (const line of err.message.split('\n').slice(1, 16)) console.error(`    ${line.trim()}`);
    const state = await page.evaluate(() => ({
      hash: location.hash,
      view: document.getElementById('app').dataset.currentView,
      // every page and whether anything of it can still be seen (a hidden page must hide its content too)
      pages: [...document.querySelectorAll('.view')].map((v) => {
        const shown = [...v.querySelectorAll('*')].filter((e) => getComputedStyle(e).visibility === 'visible' && e.getClientRects().length).length;
        return `${v.dataset.view}:${v.classList.contains('is-active') ? 'active' : 'off'}/${getComputedStyle(v).visibility}/${shown} shown`;
      }),
      centre: (() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return e ? `${e.tagName}.${String(e.className).slice(0, 40)} in ${e.closest('.view') ? e.closest('.view').dataset.view : '-'}` : null; })(),
    })).catch(() => null);
    console.error(`  state: ${JSON.stringify(state)}; page errors: ${JSON.stringify(errors)}`);
    await page.screenshot({ path: resolve(outDir, `${name}-FAILED.png`), timeout: 60000 }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

// «Add to the home screen» on Android, and the service worker that Chrome asks of an installable site.
async function installFlow() {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${url}/`);
    await page.waitForSelector('#app.is-ready');
    // the manifest the page links to is served and names icons that exist
    const man = await page.evaluate(async () => {
      const href = document.querySelector('link[rel="manifest"]').href;
      const m = await (await fetch(href)).json();
      const icons = await Promise.all(m.icons.map(async (i) => (await fetch(new URL(i.src, href))).status));
      return { display: m.display, start: m.start_url, icons };
    });
    assert.deepEqual(man, { display: 'standalone', start: './', icons: [200, 200, 200] }, 'manifest and its icons are served');
    // the service worker registers, controls the page, and the page still loads everything from the network
    const sw = await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; return { scope: new URL(reg.scope).pathname, active: !!reg.active }; });
    assert.deepEqual(sw, { scope: '/', active: true }, 'the service worker is active for the whole site');
    await page.reload();
    await page.waitForSelector('#app.is-ready');
    assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the reloaded page is under the worker');
    await page.evaluate(() => { location.hash = '#/room/lounge'; });
    await page.waitForFunction(() => document.getElementById('plan2d-stage').dataset.focus === 'lounge' && document.documentElement.dataset.thumbs === 'pack');
    assert.ok(await page.$eval('#focus-thumbs img', (i) => i.complete && i.naturalWidth > 0), 'pictures load as before under the worker');
    // no offer from the browser yet: after a while, the hint for the browser's menu
    await page.waitForSelector('#install-bar:not([hidden])', { timeout: 8000 });
    assert.equal(await page.getAttribute('#install-bar', 'data-mode'), 'menu');
    assert.match(await page.textContent('#install-bar .install-text'), /قائمة المتصفح[\s\S]*إضافة إلى الشاشة الرئيسية/);
    // the browser's offer arrives: the bar gets its button, and the button opens the browser's own dialog once
    await page.evaluate(() => {
      window.__prompts = 0;
      const e = new Event('beforeinstallprompt', { cancelable: true });
      e.prompt = () => { window.__prompts += 1; return Promise.resolve(); };
      e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
      window.__prevented = e.defaultPrevented;
    });
    assert.ok(await page.evaluate(() => window.__prevented), 'the browser\'s own mini-bar is held back: the site asks in its own words');
    assert.equal(await page.getAttribute('#install-bar', 'data-mode'), 'prompt');
    assert.ok(await page.isVisible('#install-bar .install-go'), 'the «إضافة» button is shown');
    await page.locator('#install-bar .install-go').click();
    await page.waitForFunction(() => document.getElementById('install-bar').hidden);
    assert.equal(await page.evaluate(() => window.__prompts), 1, 'one tap opened the install dialog');
    assert.deepEqual(errors, [], 'no page errors');
    console.log('✓ install: manifest, service worker, Android hint and offer');
  } catch (err) {
    failures += 1;
    console.error(`✗ install: ${err.message.split('\n')[0]}`);
    await page.screenshot({ path: resolve(outDir, 'install-FAILED.png') }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

const only = process.env.E2E_FLOW; // "desktop" or "mobile": run one of the two flows
if (!only || only === 'desktop') await flow('desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, { mobile: false, team: true });
if (!only || only === 'mobile') await flow('mobile', { ...devices['iPhone 13'], deviceScaleFactor: 1 }, { mobile: true, team: false });
if (!only || only === 'install') await installFlow();

await browser.close();
server.close();
console.log(`screenshots: ${outDir}`);
process.exit(failures ? 1 : 0);
