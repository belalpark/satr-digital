// Film the real site (a built variant, phone layout) frame by frame: 1080x1920 JPEG screenshots at quality 92.
//   SITE=dist/satr/public_html node tools/film/cap_all.mjs <outDir> [welcome,plan,rooms,photos]
// Live 3D moves are stepped by placing the viewer's camera for every frame, so the film does not depend
// on how fast this machine draws (software GL here: about two seconds per frame).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { open, FILM_CSS, shot, camState, place } from './lib.mjs';

const out = process.argv[2];
const parts = (process.argv[3] || 'welcome,plan,rooms,photos').split(',');
const content = JSON.parse(readFileSync(new URL('./content.json', import.meta.url), 'utf8'));
const FPS = 30;
const t0 = Date.now();
const lap = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
const pad = (n, w = 3) => String(n).padStart(w, '0');
const manifestPath = `${out}/manifest.json`;
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
const box = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }, sel);
const twoFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const lerpCam = (a, b, e) => {
  let dAz = b.az - a.az;
  while (dAz > Math.PI) dAz -= 2 * Math.PI;
  while (dAz < -Math.PI) dAz += 2 * Math.PI;
  const m = (k) => a[k] + (b[k] - a[k]) * e;
  return { x: m('x'), y: m('y'), z: m('z'), az: a.az + dAz * e, polar: m('polar'), d: m('d') };
};

// ---------- 1. the welcome page builds in: its own CSS animations, stepped to each frame's time ----------
if (parts.includes('welcome')) {
  const dir = `${out}/welcome`; mkdirSync(dir, { recursive: true });
  const { page, url, close } = await open({ reducedMotion: 'no-preference' });
  await page.goto(`${url}/#/`);
  await page.waitForSelector('#app.is-ready');
  await page.addStyleTag({ content: FILM_CSS });
  await page.waitForFunction(() => { const i = document.querySelector('.welcome-photo'); return i && i.complete && i.naturalWidth > 0; });
  await page.evaluate(() => document.fonts.ready);
  const n = await page.evaluate(() => {
    window.__film = document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.closest('.view-welcome, .app-header'));
    for (const a of window.__film) a.pause();
    return window.__film.length;
  });
  lap(`welcome: ${n} animations under the film's clock`);
  const frames = 5 * FPS;
  for (let i = 0; i < frames; i++) {
    await page.evaluate((ms) => { for (const a of window.__film) a.currentTime = ms; }, (i * 1000) / FPS);
    await twoFrames(page);
    await shot(page, `${dir}/f${pad(i)}.jpg`);
  }
  manifest.welcome = { frames, cta: await box(page, '.welcome-actions .btn-primary') };
  save(); lap('welcome done');
  await close();
}

// ---------- 2. the plan: 2D, then the live 3D model turning into its home view; 3. the flight to every room ----------
if (parts.includes('plan') || parts.includes('rooms') || parts.includes('photos')) {
  const { page, url, close } = await open({ reducedMotion: 'reduce' });
  await page.goto(`${url}/#/`);
  await page.waitForSelector('#app.is-ready');
  await page.addStyleTag({ content: FILM_CSS + '#room-summary,#room-capacity{display:none!important}' }); // the film writes each room's features itself
  await page.evaluate(() => document.querySelector('.welcome-actions .btn-primary').click());
  await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'plan');
  await page.waitForTimeout(1800);
  if (parts.includes('plan')) {
    await shot(page, `${out}/plan2d.jpg`);
    manifest.plan2d = { tab3d: await box(page, '#view-tabs [data-view="3d"]') };
    save(); lap('plan 2D');
  }
  if (parts.includes('plan') || parts.includes('rooms')) {
    await page.evaluate(() => document.querySelector('#view-tabs [data-view="3d"]').click());
    await page.waitForSelector('#plan-stage.is-ready');
    await page.waitForFunction(() => document.getElementById('plan-stage').dataset.lit === 'day');
    await page.waitForTimeout(3000);
    const home = await camState(page);
    await place(page, home);
    if (parts.includes('plan')) {
      const dir = `${out}/enter`; mkdirSync(dir, { recursive: true });
      const frames = 63;
      const start = { ...home, az: home.az + 0.95, polar: home.polar + 0.2, d: home.d * 1.22 };
      for (let i = 0; i < frames; i++) {
        await place(page, lerpCam(start, home, easeOut(i / (frames - 1))));
        await shot(page, `${dir}/f${pad(i)}.jpg`);
        if (i % 16 === 0) lap(`enter ${i}/${frames}`);
      }
      manifest.enter = { frames, home };
      save(); lap('enter done');
    }
    if (parts.includes('rooms')) {
      manifest.rooms = manifest.rooms || {};
      await place(page, home);
      const frames = 24;
      for (const [k, sp] of content.spaces.entries()) {
        const dir = `${out}/room-${pad(k, 2)}`; mkdirSync(dir, { recursive: true });
        const from = await camState(page);
        await page.evaluate((id) => { location.hash = `#/room/${id}`; }, sp.id);
        await page.waitForFunction((id) => document.getElementById('plan-stage').dataset.focus === id && !document.getElementById('room-card').hidden, sp.id);
        await page.waitForTimeout(900); // the stage re-frames when the room card changes its height
        const to = await camState(page);
        for (let i = 1; i <= frames; i++) {
          await place(page, lerpCam(from, to, easeInOut(i / frames)));
          await shot(page, `${dir}/f${pad(i - 1, 2)}.jpg`);
        }
        manifest.rooms[sp.id] = { frames, photosBtn: await box(page, '#btn-photos'), title: await page.textContent('#focus-title') };
        save(); lap(`room ${k + 1}/12 ${sp.id}`);
      }
    }
  }
  // ---------- 4. the photos page of every room, at the two chosen pictures ----------
  if (parts.includes('photos')) {
    manifest.photos = manifest.photos || {};
    for (const sp of content.spaces) {
      // from the room's close-up, as a visitor would: «back» then reads "to the perspective"
      await page.evaluate((id) => { location.hash = `#/room/${id}`; }, sp.id);
      await page.waitForFunction((id) => location.hash === `#/room/${id}` && !document.getElementById('room-card').hidden, sp.id);
      await page.evaluate((id) => { location.hash = `#/room/${id}/photos`; }, sp.id);
      await page.waitForFunction(() => document.getElementById('app').dataset.currentView === 'photos');
      const rec = { title: null, shots: [] };
      for (const [j, n] of sp.photos.entries()) {
        await page.evaluate((idx) => document.querySelectorAll('#gallery-thumbs .thumb')[idx].click(), n - 1);
        await page.waitForFunction((idx) => { const i = document.getElementById('room-photo'); return i.complete && i.naturalWidth > 0 && i.classList.contains('is-loaded') && (i.getAttribute('src') || '').includes(`/${String(idx).padStart(2, '0')}.webp`); }, n);
        await page.waitForTimeout(700);
        await shot(page, `${out}/photos-${sp.id}-${j + 1}.jpg`);
        rec.shots.push({ n, caption: await page.textContent('#gallery-caption'), img: await page.evaluate(() => { const i = document.getElementById('room-photo'); const s = i.getBoundingClientRect(); return { stage: [s.x, s.y, s.width, s.height], nat: [i.naturalWidth, i.naturalHeight] }; }) });
      }
      rec.title = (await page.textContent('#room-title')).trim();
      manifest.photos[sp.id] = rec;
      save(); lap(`photos ${sp.id}`);
    }
  }
  await close();
}
lap('capture finished');
