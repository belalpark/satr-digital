// Entry point: loads the office record, the live 3D model, and wires the hash
// router to the views (welcome → 3D plan → room focus → photos / details).
import { parseHash, navigate, buildHash, teamNameFromSearch } from './router.js';
import { createPlan2D } from './plan2d.js';
import { createOverlay } from './overlay.js';
import { createRoom } from './room.js';
import { createDetails } from './details.js';
import { seatsLabel, photosLabel } from './format.js';

const SCENE_ORDER = ['current', 'paths'];
const VIEW_FADE_MS = 380;

async function fetchJson(url, { optional = false } = {}) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return await res.json();
  } catch (err) {
    if (optional) return null;
    throw err;
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function readPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: ignore */ }
}

export async function init() {
  const app = document.getElementById('app');
  const data = await fetchJson('data/office.json');
  // the version badge (and its build-info.json) exists only in the client-branded build
  const buildInfo = document.getElementById('build-sha') ? await fetchJson('build-info.json', { optional: true }) : null;
  const W = data.office.welcome;
  const roomsById = new Map(data.rooms.map((r) => [r.id, r]));

  const views = {
    welcome: document.getElementById('view-welcome'),
    plan: document.getElementById('view-plan'),
    photos: document.getElementById('view-room'),
    details: document.getElementById('view-details'),
    gallery: document.getElementById('view-gallery'),
  };

  // ---------- build sha ----------
  // the badge is absent from the neutral (unbranded) build
  const shaEl = document.getElementById('build-sha');
  if (shaEl) {
    const sha = buildInfo && buildInfo.sha ? buildInfo.sha.slice(0, 7) : 'dev';
    shaEl.textContent = buildInfo && buildInfo.branch ? `${buildInfo.branch} @ ${sha}` : sha;
  }

  // ---------- welcome ----------
  // the opportunity first: a small eyebrow («فرصة استحواذ», or the team greeting with ?team=), the
  // headline «مكتب مجهّز في» + the business front in large gold, the key figures, then the tour
  const team = teamNameFromSearch(location.search, '');
  const title = document.getElementById('welcome-title');
  if (team) {
    title.textContent = `${W.teamTitle} `;
    const span = el('span', '', team);
    span.id = 'welcome-team';
    title.append(span);
    const chip = document.getElementById('plan-team-chip');
    chip.textContent = team;
    chip.hidden = false;
  } else {
    title.textContent = W.eyebrow || W.title;
  }
  document.getElementById('welcome-subtitle').textContent = W.subtitle;
  document.getElementById('welcome-atmosphere').textContent = W.atmosphere;
  document.getElementById('btn-start').textContent = W.cta;
  const galleryBtn = document.getElementById('btn-gallery');
  if (galleryBtn && W.galleryCta) galleryBtn.textContent = W.galleryCta;
  const locEl = document.getElementById('welcome-location');
  locEl.textContent = '';
  if (W.location) {
    const [main, ...rest] = W.location.split('·').map((t) => t.trim());
    if (rest.length) locEl.append(el('span', 'loc-city', rest.join(' · ')));
    if (W.headlineLead) locEl.append(el('span', 'loc-lead', W.headlineLead));
    locEl.append(el('strong', 'loc-main', main));
  } else {
    locEl.textContent = data.office.title;
  }
  const factsEl = document.getElementById('welcome-facts');
  factsEl.replaceChildren();
  factsEl.hidden = !(W.facts && W.facts.length);
  for (const f of W.facts || []) {
    const item = el('div', 'fact');
    const dd = el('dd', 'fact-value');
    dd.append(el('span', 'fact-num', f.value));
    if (f.unit) dd.append(el('span', 'fact-unit', f.unit));
    const dt = el('dt', 'fact-label', f.label);
    item.append(dd, dt);
    if (f.note) item.append(el('span', 'fact-note', f.note));
    factsEl.append(item);
  }
  renderBrand(data.office.brand || {});
  renderFooter(document.getElementById('app-footer'), data.office.footer);
  const hero = document.getElementById('welcome-photo');
  hero.src = data.office.heroImage;
  hero.addEventListener('error', () => { if (data.office.heroFallback && hero.src.indexOf(data.office.heroFallback) < 0) hero.src = data.office.heroFallback; }, { once: true });

  // ---------- header nav state ----------
  const navLinks = [...document.querySelectorAll('.site-nav a')];
  function setNav(key) {
    if (key === 'plan') key = mode === '3d' ? 'plan3d' : 'plan2d';
    for (const a of navLinks) a.classList.toggle('is-active', a.dataset.nav === key);
  }

  // ---------- view mode: the 2D plan (default) or the live 3D model ----------
  const stageWrap = document.getElementById('plan-stage-wrap');
  const plan2dStage = document.getElementById('plan2d-stage');
  const viewTabs = [...document.querySelectorAll('#view-tabs [data-view]')];
  let mode = readPref('view', (data.office.defaultView === '3d' ? '3d' : '2d'));
  const plan2d = createPlan2D(plan2dStage, data, { priority: parseHash(location.hash).view === 'welcome' ? 'low' : 'high' });
  plan2dStage.__twin = plan2d; // test hook
  let overlay2d = null;

  // ---------- 3D plan ----------
  const planStage = document.getElementById('plan-stage');
  const loading = document.getElementById('twin-loading');
  let twin = null;
  let overlay = null;
  let twinError = null;
  let twinPromise = null;
  // click on a stage: once = focus, again on the same room = back to the plan; hover shows the name
  function wireStage(el, eng, tipText) {
    let down = null;
    // the overlay's dots and labels have their own handlers: a press on them is not a plan click
    const onControl = (e) => !!(e.target && e.target.closest && e.target.closest('.room-marker, .room-tag, button, a'));
    // a tap is one pointer down and up in place; once a second pointer joins (pinch), nothing in
    // that gesture picks a room, whichever finger lifts first
    const active = new Set();
    let multi = false;
    el.addEventListener('pointerdown', (e) => {
      active.add(e.pointerId);
      if (active.size > 1) { multi = true; down = null; return; }
      down = onControl(e) ? null : { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    const release = (e) => { active.delete(e.pointerId); const wasMulti = multi; if (active.size === 0) multi = false; return wasMulti; };
    el.addEventListener('pointercancel', (e) => { release(e); if (active.size === 0) down = null; });
    el.addEventListener('pointerup', (e) => {
      const wasMulti = release(e);
      if (wasMulti || !down || onControl(e)) { if (active.size === 0) down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || Date.now() - down.t > 600;
      down = null;
      if (moved) return;
      const id = eng.roomAt(e.clientX, e.clientY);
      if (id) toggleRoom(id);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const id = eng.roomAt(e.clientX, e.clientY);
      const r = id ? roomsById.get(id) : null;
      const ok = r && r.status === 'ready' && r.hasModel !== false;
      el.style.cursor = ok ? 'pointer' : '';
      showTip(ok ? `${r.name} — ${tipText}` : '', e.clientX, e.clientY);
    });
    el.addEventListener('pointerleave', () => showTip(''));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const dotHandlers = {
    onModel: (id) => toggleRoom(id),
    onPhotos: (id) => navigate({ view: 'details', roomId: id }), // the red dot opens the room details (photos included)
  };

  // the 3D viewer (three.js, ~200 KB compressed) is fetched only when the 3D view is wanted: a hover or
  // touch on a 3D link/tab starts the download early, the 2D plan and the other pages never pay for it
  let twinModule = null;
  function warm3d() {
    if (!twinModule) twinModule = import('./twin3d.js').catch((err) => { twinModule = null; throw err; });
    return twinModule;
  }
  for (const a of document.querySelectorAll('[data-nav="plan3d"], .scene-tab[data-view="3d"]')) {
    for (const ev of ['pointerenter', 'touchstart', 'focus']) a.addEventListener(ev, () => { warm3d().catch(() => {}); }, { once: true, passive: true });
  }

  function loadTwin() {
    if (twinPromise) return twinPromise;
    twinPromise = (async () => {
    try {
      const { createTwin3D } = await warm3d();
      twin = await createTwin3D(planStage, data, { base: data.office.model.base, lighting: readPref('lighting', 'day'), idleSpin: true, active: currentView === 'plan' && mode === '3d' });
      twin.setActive(currentView === 'plan' && mode === '3d'); // the view may have changed while the model was loading
      overlay = createOverlay(planStage, twin, data, dotHandlers);
      overlay.setOutside(readPref('labels', 'inside') === 'outside');
      loading.hidden = true;
      planStage.classList.add('is-ready');
      planStage.__twin = twin; // test hook (read-only use by the e2e suite)
      wireStage(twin.element, twin, 'انقر للمنظور القريب');
      updateLightingButton();
      syncSceneToTwin();
    } catch (err) {
      twinError = err;
      console.error(err);
      loading.textContent = 'تعذّر تشغيل النموذج ثلاثي الأبعاد في هذا المتصفح. جرّب متصفحًا حديثًا أو فعّل تسريع الرسوميات.';
    }
    })();
    return twinPromise;
  }

  // the engine behind the visible stage; the 3D model loads on first use
  function engine() { return mode === '3d' ? twin : plan2d; }
  async function ensureEngine() {
    if (mode === '3d') { await loadTwin(); return twin; }
    await plan2d.ready; // a cold details deep link snapshots the plan image: wait until it has pixels
    return plan2d;
  }
  function applyMode() {
    stageWrap.dataset.mode = mode;
    planStage.hidden = mode !== '3d';
    plan2dStage.hidden = mode !== '2d';
    for (const b of viewTabs) {
      const on = b.dataset.view === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    }
    lightingBtn.hidden = mode !== '3d';
    document.getElementById('btn-focus-mode').textContent = mode === '3d' ? 'المخطط ثنائي الأبعاد' : 'العرض ثلاثي الأبعاد';
    if (twin) twin.setActive(currentView === 'plan' && mode === '3d');
    if (overlay2d) overlay2d.layout();
    if (overlay) overlay.layout();
  }
  async function switchMode(next, { replace = true } = {}) {
    if (next !== '2d' && next !== '3d') return;
    if (next === mode) return;
    mode = next;
    writePref('view', mode);
    applyMode();
    if (lastRoute && (lastRoute.view === 'plan' || lastRoute.view === 'room')) setNav(lastRoute.view === 'plan' && currentScene === 'paths' ? 'paths' : 'plan');
    // carry the current state (focused room or the full plan) into the newly shown engine
    const seq = ++routeSeq;
    const current = () => seq === routeSeq;
    const eng = await ensureEngine();
    if (!eng || !current()) return;
    syncSceneToTwin();
    const r = focusRoomId ? roomsById.get(focusRoomId) : null;
    if (r && r.hasModel !== false) { eng.stopIdle(); if (eng.getFocus() !== r.id) await eng.focusRoom(r.id, { animate: false }); }
    else if (eng.getFocus()) await eng.unfocus({ animate: false });
    const ov = mode === '3d' ? overlay : overlay2d;
    if (ov && current()) ov.setFocus(r ? r.id : null);
    if (replace && lastRoute && lastRoute.mode && current()) navigate({ ...lastRoute, mode }, { replace: true });
  }
  for (const b of viewTabs) b.addEventListener('click', () => switchMode(b.dataset.view));
  document.getElementById('btn-focus-mode').addEventListener('click', () => switchMode(mode === '3d' ? '2d' : '3d'));

  const tip = document.getElementById('plan-tip');
  function showTip(text, x, y) {
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.hidden = false;
  }

  function toggleRoom(id) {
    const r = roomsById.get(id);
    if (!r || r.status !== 'ready') return;
    if (r.hasModel === false) { if (r.hasPhotos) navigate({ view: 'details', roomId: id }); return; } // list-only spaces (corridors)
    const route = parseHash(location.hash);
    if (route.view === 'room' && route.roomId === id) navigate({ view: 'plan', scene: currentScene });
    else navigate({ view: 'room', roomId: id });
  }

  for (const b of document.querySelectorAll('.zoom-btn')) {
    b.addEventListener('click', () => {
      const eng = engine();
      if (!eng) return;
      eng.stopIdle();
      if (b.dataset.zoom === 'in') eng.zoom(1.35);
      else if (b.dataset.zoom === 'out') eng.zoom(1 / 1.35);
      else eng.resetView(); // one click: back to the default view (or the room's close-up)
    });
  }

  // lighting + labels tools
  const lightingBtn = document.getElementById('btn-lighting');
  function updateLightingButton() {
    const night = twin && twin.getLighting() === 'night';
    lightingBtn.setAttribute('aria-pressed', String(!!night)); // pressed = evening lighting is on
    lightingBtn.querySelector('.tool-icon').textContent = night ? '☀' : '☾';
  }
  lightingBtn.addEventListener('click', () => {
    if (!twin) return;
    twin.stopIdle();
    const next = twin.getLighting() === 'night' ? 'day' : 'night';
    twin.setLighting(next);
    writePref('lighting', next);
    updateLightingButton();
  });
  const labelsBtn = document.getElementById('btn-labels');
  labelsBtn.addEventListener('click', () => {
    const next = readPref('labels', 'inside') !== 'outside';
    if (overlay) overlay.setOutside(next);
    if (overlay2d) overlay2d.setOutside(next);
    labelsBtn.setAttribute('aria-pressed', String(next));
    writePref('labels', next ? 'outside' : 'inside');
  });
  labelsBtn.setAttribute('aria-pressed', String(readPref('labels', 'inside') === 'outside'));

  // scene tabs + route legend
  const tabs = document.getElementById('scene-tabs');
  const badge = document.getElementById('plan-badge');
  const legend = document.getElementById('route-legend');
  let currentScene = 'current';
  for (const id of SCENE_ORDER) {
    const b = el('button', 'scene-tab', data.scenes[id].name);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.scene = id;
    b.addEventListener('click', () => navigate({ view: 'plan', scene: id }, { replace: true }));
    tabs.append(b);
  }
  const routeState = new Map(data.scenes.paths.routes.map((r) => [r.id, true]));
  legend.replaceChildren(
    ...data.scenes.paths.routes.map((r) => {
      const li = el('li');
      const b = el('button', 'route-chip');
      b.type = 'button';
      b.dataset.route = r.id;
      b.setAttribute('aria-pressed', 'true');
      b.style.setProperty('--route', r.color);
      b.append(el('i', 'swatch'), document.createTextNode(r.name));
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        routeState.set(r.id, on);
        for (const eng of [plan2d, twin]) if (eng) eng.setRouteVisible(r.id, on);
      });
      li.append(b);
      return li;
    }),
  );
  function syncSceneToTwin() {
    for (const eng of [plan2d, twin]) {
      if (!eng) continue;
      eng.setRoutesVisible(currentScene === 'paths');
      for (const [id, on] of routeState) eng.setRouteVisible(id, on);
    }
  }
  function applyScene(id) {
    currentScene = SCENE_ORDER.includes(id) ? id : 'current';
    for (const b of tabs.children) {
      const active = b.dataset.scene === currentScene;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    }
    legend.hidden = currentScene !== 'paths';
    badge.textContent = data.scenes[currentScene].badge;
    badge.classList.toggle('is-path', currentScene === 'paths');
    views.plan.classList.toggle('scene-paths', currentScene === 'paths');
    syncSceneToTwin();
  }
  applyScene('current');

  // ---------- right sidebar: room list + room card ----------
  const list = document.getElementById('room-list');
  const card = document.getElementById('room-card');
  const sidebar = document.getElementById('room-sidebar');
  const cardEls = {
    title: document.getElementById('focus-title'),
    summary: document.getElementById('focus-summary'),
    facts: document.getElementById('focus-facts'),
    photos: document.getElementById('btn-photos'),
    details: document.getElementById('btn-focus-details'),
    thumbs: document.getElementById('focus-thumbs'),
  };
  const KIND_NAMES = { office: 'مكاتب إدارية', open: 'مكاتب مفتوحة', meeting: 'قاعات الاجتماعات', social: 'جلسات واستقبال', service: 'مرافق', circulation: 'الحركة' };
  const KIND_MODEL = { office: 'مكتب إداري بفرشه الحالي', open: 'محطات عمل بفرشها الحالي', meeting: 'قاعة اجتماعات بفرشها الحالي', social: 'جلسة بفرشها الحالي', service: 'مرفق خدمي', circulation: 'منطقة حركة' };
  const listItems = new Map();
  const groups = new Map();
  for (const r of data.rooms.filter((x) => x.status !== 'info')) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind).push(r);
  }
  for (const [kind, rs] of groups) {
    const head = el('li', 'room-group', KIND_NAMES[kind] || kind);
    list.append(head);
    for (const r of rs) {
      const li = el('li', 'room-item');
      const b = el('button', 'room-item-btn');
      b.type = 'button';
      b.dataset.id = r.id;
      b.append(el('i', 'dot dot-blue mini'), el('span', 'room-item-name', r.name));
      if (r.hasPhotos) b.append(el('i', 'dot dot-red mini', ''));
      b.addEventListener('click', () => toggleRoom(r.id));
      li.append(b);
      list.append(li);
      listItems.set(r.id, b);
    }
  }
  document.getElementById('sidebar-count').textContent = `${listItems.size} غرفة`;

  let focusRoomId = null;
  function showRoomCard(room) {
    const leaving = focusRoomId && !room ? focusRoomId : null;
    focusRoomId = room ? room.id : null;
    if (leaving && listItems.get(leaving) && document.activeElement && document.activeElement.closest('#room-card')) listItems.get(leaving).focus({ preventScroll: true });
    sidebar.classList.toggle('is-focus', !!room);
    card.hidden = !room;
    for (const [id, b] of listItems) b.classList.toggle('is-active', !!room && id === room.id);
    if (!room) return;
    cardEls.title.textContent = room.name;
    cardEls.summary.textContent = room.summary || '';
    const facts = [];
    if (room.capacity) facts.push(['السعة', seatsLabel(room.capacity.seats)]);
    facts.push(['النموذج', KIND_MODEL[room.kind] || 'الفرش الحالي في النموذج ثلاثي الأبعاد']);
    if (room.use && room.use.current) facts.push(['الاستخدام', room.use.current]);
    if (room.hasPhotos) facts.push(['الصور', photosLabel(room.photos.length)]);
    cardEls.facts.replaceChildren(...facts.map(([k, v]) => { const li = el('li'); li.append(el('span', 'k', k), el('span', 'v', v)); return li; }));
    // the photos are one tap away: the first few as a strip right in the card
    const shots = room.hasPhotos ? room.photos.slice(0, 4) : [];
    cardEls.thumbs.hidden = !shots.length;
    cardEls.thumbs.replaceChildren(...shots.map((ph, i) => {
      const b = el('button', 'focus-thumb');
      b.type = 'button';
      b.setAttribute('aria-label', `${ph.caption || room.name} — صورة ${i + 1}`);
      const img = document.createElement('img');
      img.src = ph.thumb;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      b.append(img);
      const extra = room.photos.length - shots.length;
      if (i === shots.length - 1 && extra > 0) { const more = el('span', 'focus-thumb-more', `+${extra}`); more.dir = 'ltr'; b.append(more); }
      b.addEventListener('click', () => { pendingPhoto = i; navigate({ view: 'photos', roomId: room.id }); });
      return b;
    }));
    cardEls.photos.hidden = !room.hasPhotos;
    cardEls.photos.textContent = room.hasPhotos ? `الصور الحقيقية (${room.photos.length})` : '';
    cardEls.details.hidden = !(room.fixtures || room.capacity || room.hasPhotos);
    if (listItems.get(room.id)) listItems.get(room.id).scrollIntoView({ block: 'nearest' });
  }

  // ---------- left drawer: the room's details beside the plan (desktop; a single click opens it) ----------
  const planLayout = document.querySelector('.plan-layout');
  const drawer = document.getElementById('room-drawer');
  const dEls = {
    title: document.getElementById('drawer-title'),
    hero: document.getElementById('drawer-hero'),
    image: document.getElementById('drawer-image'),
    caption: document.getElementById('drawer-caption'),
    summary: document.getElementById('drawer-summary'),
    facts: document.getElementById('drawer-facts'),
    fixtures: document.getElementById('drawer-fixtures'),
    photosBlock: document.getElementById('drawer-photos-block'),
    photosTitle: document.getElementById('drawer-photos-title'),
    photos: document.getElementById('drawer-photos'),
  };
  let drawerRoomId = null;
  let drawerDismissed = null; // the room whose drawer the visitor closed (re-opens on another room)
  function showDrawer(room) {
    const open = !!room && drawerDismissed !== room.id;
    drawer.hidden = !open;
    planLayout.classList.toggle('has-drawer', open);
    if (!room) drawerDismissed = null;
    if (!open || drawerRoomId === room.id) { if (!open) drawerRoomId = null; return; }
    drawerRoomId = room.id;
    dEls.title.textContent = room.name;
    const render = room.render && room.render.image;
    const cover = render || (room.focus && room.focus.image) || (room.hasPhotos && room.photos[0] && room.photos[0].src);
    dEls.hero.hidden = !cover;
    if (cover) {
      dEls.image.src = cover;
      dEls.image.alt = render ? `${room.name} في النموذج ثلاثي الأبعاد` : (room.photos[0].caption || room.name);
      dEls.caption.textContent = render ? 'لقطة من النموذج ثلاثي الأبعاد للغرفة بفرشها' : (room.photos[0].caption || '');
    }
    dEls.summary.textContent = room.summary || '';
    dEls.summary.hidden = !room.summary;
    const facts = [];
    if (room.capacity) facts.push(['السعة', seatsLabel(room.capacity.seats)]);
    facts.push(['النموذج', KIND_MODEL[room.kind] || 'الفرش الحالي في النموذج ثلاثي الأبعاد']);
    if (room.use && room.use.current) facts.push(['الاستخدام', room.use.current]);
    if (room.hasPhotos) facts.push(['الصور', photosLabel(room.photos.length)]);
    dEls.facts.replaceChildren(...facts.map(([k, v]) => { const li = el('li'); li.append(el('span', 'k', k), el('span', 'v', v)); return li; }));
    const items = room.fixtures && room.fixtures.items ? room.fixtures.items : [];
    dEls.fixtures.hidden = !items.length;
    dEls.fixtures.replaceChildren();
    if (items.length) {
      dEls.fixtures.append(el('h4', 'drawer-sub', 'التجهيزات'));
      const ul = el('ul');
      for (const it of items) ul.append(el('li', '', it));
      dEls.fixtures.append(ul);
    }
    const photos = room.hasPhotos ? room.photos : [];
    dEls.photosBlock.hidden = !photos.length;
    dEls.photosTitle.textContent = `الصور الحقيقية (${photos.length})`;
    dEls.photos.replaceChildren(...photos.map((ph, i) => {
      const b = el('button', 'drawer-photo');
      b.type = 'button';
      b.setAttribute('aria-label', `${ph.caption || room.name} — صورة ${i + 1}`);
      const img = document.createElement('img');
      img.src = ph.thumb;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      b.append(img);
      b.addEventListener('click', () => { pendingPhoto = i; navigate({ view: 'photos', roomId: room.id }); });
      return b;
    }));
    drawer.querySelector('.drawer-scroll').scrollTop = 0;
  }
  document.getElementById('btn-drawer-close').addEventListener('click', () => {
    drawerDismissed = drawerRoomId;
    showDrawer(roomsById.get(drawerRoomId));
  });
  document.getElementById('btn-drawer-details').addEventListener('click', () => drawerRoomId && navigate({ view: 'details', roomId: drawerRoomId }));
  document.getElementById('btn-focus-back').addEventListener('click', () => navigate({ view: 'plan', scene: currentScene }));
  // the main button always opens the photos from the first one (a thumbnail opens at its own picture)
  cardEls.photos.addEventListener('click', () => { if (!focusRoomId) return; pendingPhoto = 0; navigate({ view: 'photos', roomId: focusRoomId }); });
  cardEls.details.addEventListener('click', () => focusRoomId && navigate({ view: 'details', roomId: focusRoomId }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lastRoute && lastRoute.view === 'room') navigate({ view: 'plan', scene: currentScene });
  });

  // ---------- photos & details ----------
  const room = createRoom(views.photos, data);
  let pendingPhoto = null;
  const details = createDetails(views.details, data, {
    onOpenPhoto: (roomId, index) => { pendingPhoto = index; navigate({ view: 'photos', roomId }); },
    snapshot: () => { const eng = engine(); return eng ? eng.snapshot() : ''; },
  });
  // ---------- gallery: a card per room with photos (cover, name, count) ----------
  const galleryRooms = data.rooms.filter((r) => r.status === 'ready' && r.hasPhotos && r.photos && r.photos.length);
  const galleryGrid = document.getElementById('gallery-grid');
  const totalPhotos = galleryRooms.reduce((n, r) => n + r.photos.length, 0);
  document.getElementById('gallery-sub').textContent = `${galleryRooms.length} مساحة · ${photosLabel(totalPhotos)} حقيقية — اختر مساحة لعرض صورها`;
  // built on the first visit only: two dozen cover photos are not fetched for visitors who never open it
  let galleryBuilt = false;
  const buildGallery = () => { if (galleryBuilt) return; galleryBuilt = true; galleryGrid.replaceChildren(...galleryRooms.map((r) => {
    const a = el('a', 'gallery-card');
    a.href = buildHash({ view: 'photos', roomId: r.id });
    a.dataset.id = r.id;
    const img = document.createElement('img');
    img.src = r.cover || r.photos[0].src;
    img.alt = r.photos[0].caption || r.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    const meta = el('span', 'gallery-meta');
    meta.append(el('strong', 'gallery-name', r.name), el('span', 'gallery-count', photosLabel(r.photos.length)));
    a.append(img, meta);
    return a;
  })); };
  let photosFromGallery = false;
  const backBtn = document.getElementById('btn-back-plan');
  const backLabel = (fromGallery) => { backBtn.lastChild.textContent = fromGallery ? ' العودة للمعرض ' : ' العودة للمنظور '; };
  backBtn.addEventListener('click', () => {
    if (photosFromGallery) { navigate({ view: 'gallery' }); return; }
    const r = room.currentRoom();
    navigate(r && r.hasModel !== false ? { view: 'room', roomId: r.id } : { view: 'plan', scene: currentScene });
  });
  document.getElementById('btn-details').addEventListener('click', () => {
    const r = room.currentRoom();
    if (r) navigate({ view: 'details', roomId: r.id });
  });
  document.getElementById('btn-close-details').addEventListener('click', () => {
    const id = details.currentRoom();
    const r = id ? roomsById.get(id) : null;
    if (r && r.hasModel !== false) navigate({ view: 'room', roomId: id });
    else navigate({ view: 'plan', scene: currentScene }); // list-only spaces have no close-up to return to
  });

  // ---------- view switching ----------
  let currentView = null;
  function showView(name) {
    if (currentView === name) return;
    const prev = currentView;
    currentView = name;
    app.dataset.currentView = name;
    if (twin) twin.setActive(name === 'plan' && mode === '3d'); // no rendering or turntable behind the photos/details/welcome views
    const order = { welcome: 0, plan: 1, gallery: 1, photos: 2, details: 3 };
    const goingUp = !prev || order[name] > order[prev];
    for (const [key, v] of Object.entries(views)) {
      v.classList.toggle('is-active', key === name);
      v.classList.toggle('is-under', goingUp && key === prev);
      v.classList.toggle('is-leaving-fast', !goingUp && key === prev);
    }
    if (prev) setTimeout(() => views[prev].classList.remove('is-under', 'is-leaving-fast'), VIEW_FADE_MS);
  }

  function openableRoom(id, { needPhotos = false } = {}) {
    const r = data.rooms.find((x) => x.id === id);
    if (!r || r.status !== 'ready') return null;
    if (needPhotos && !r.hasPhotos) return null;
    return r;
  }

  async function ensureFocus(r, animate, current = () => true) {
    const eng = await ensureEngine();
    if (!eng || !current()) return;
    eng.stopIdle();
    if (eng.getFocus() !== r.id) await eng.focusRoom(r.id, { animate });
    else await eng.settled(); // the flight to this room may still be in progress (e.g. details opened mid-flight)
    const ov = mode === '3d' ? overlay : overlay2d;
    if (ov && current()) ov.setFocus(r.id);
  }
  async function ensureUnfocus(current = () => true) {
    const eng = await ensureEngine();
    if (!eng || !current()) return;
    const ov = mode === '3d' ? overlay : overlay2d;
    if (ov) ov.setFocus(null);
    if (eng.getFocus()) await eng.unfocus({ animate: true });
  }

  let lastRoute = null;
  let routeSeq = 0;
  async function render() {
    const route = parseHash(location.hash);
    const from = lastRoute;
    lastRoute = route;
    const seq = ++routeSeq;
    const current = () => seq === routeSeq;

    if (route.view === 'plan' && !/^#\/plan(\?|$)/.test(location.hash)) {
      navigate({ view: 'plan', scene: route.scene }, { replace: true });
      return;
    }
    if (route.mode && route.mode !== mode) { mode = route.mode; writePref('view', mode); applyMode(); } // deep link chose the 2D / 3D view
    if (route.view === 'room' && !openableRoom(route.roomId)) { navigate({ view: 'plan' }, { replace: true }); return; }
    if (route.view === 'room' && roomsById.get(route.roomId).hasModel === false) { navigate({ view: 'details', roomId: route.roomId }, { replace: true }); return; }
    if (route.view === 'photos' && !openableRoom(route.roomId, { needPhotos: true })) {
      navigate(openableRoom(route.roomId) ? { view: 'room', roomId: route.roomId } : { view: 'plan' }, { replace: true });
      return;
    }
    if (route.view === 'details' && !openableRoom(route.roomId)) { navigate({ view: 'plan' }, { replace: true }); return; }
    const r = route.roomId ? roomsById.get(route.roomId) : null;

    if (route.view === 'welcome') {
      showView('welcome');
      setNav('welcome');
      document.title = data.office.title;
      return;
    }

    if (route.view === 'gallery') {
      buildGallery();
      showView('gallery');
      setNav('gallery');
      document.title = `معرض الصور — ${data.office.title}`;
      return;
    }

    if (route.view === 'plan') {
      const asked = route.scene || 'current';
      const sceneId = asked === 'visitor-path' ? 'paths' : SCENE_ORDER.includes(asked) ? asked : 'current';
      if (sceneId !== asked) { navigate({ view: 'plan', scene: sceneId }, { replace: true }); return; }
      showView('plan');
      setNav(sceneId === 'paths' ? 'paths' : 'plan');
      if (sceneId !== currentScene || !from) applyScene(sceneId);
      showRoomCard(null);
      showDrawer(null);
      document.title = `${data.office.title} — المخطط ثلاثي الأبعاد`;
      ensureUnfocus(current);
      return;
    }

    if (route.view === 'room') {
      showView('plan');
      setNav('plan');
      showRoomCard(r);
      showDrawer(r);
      cardEls.title.focus({ preventScroll: true });
      document.title = `${r.name} — ${data.office.title}`;
      ensureFocus(r, !!from && (from.view === 'plan' || from.view === 'room'), current);
      return;
    }

    if (route.view === 'photos') {
      // came from the gallery (or a gallery link): «back» returns there; from the plan it returns to the room
      if (from) photosFromGallery = from.view === 'gallery' || (photosFromGallery && from.view === 'photos' && from.roomId === r.id);
      backLabel(photosFromGallery);
      if (room.currentRoom() !== r || pendingPhoto !== null) room.show(r.id, { photoIndex: pendingPhoto ?? 0 });
      pendingPhoto = null;
      showView('photos');
      showRoomCard(r);
      ensureFocus(r, false, current);
      document.title = `صور ${r.name} — ${data.office.title}`;
      return;
    }

    if (route.view === 'details') {
      if (room.currentRoom() !== r) room.show(r.id);
      showView('details');
      showRoomCard(r);
      if (r.hasModel === false) {
        // a list-only space: the centre shows the whole plan, with nothing highlighted
        details.show(r.id, { deferImage: true });
        ensureUnfocus(current).then(() => { if (current() && details.currentRoom() === r.id) details.refreshImage(); });
      } else if (r.focus && r.focus.image) {
        details.show(r.id); // the pre-rendered view exists: no need to wait for the model
        ensureFocus(r, false, current);
      } else {
        details.show(r.id, { deferImage: true });
        ensureFocus(r, false, current).then(() => { if (current() && details.currentRoom() === r.id) details.refreshImage(); });
      }
      document.title = `تفاصيل ${r.name} — ${data.office.title}`;
    }
  }

  overlay2d = createOverlay(plan2dStage, plan2d, data, dotHandlers);
  overlay2d.setOutside(readPref('labels', 'inside') === 'outside');
  wireStage(plan2dStage, plan2d, 'انقر لعرض الغرفة');
  applyMode();
  window.addEventListener('hashchange', () => { render(); });
  await render();
  app.classList.add('is-ready');
  // warm the 3D model while the visitor reads the welcome — only when the 3D view is the chosen one
  if (mode === '3d') setTimeout(loadTwin, 600);
}

// The client's identity on the welcome page and in the header: wordmark text always, the logo file
// (brand.logo) when the client supplies it — nothing is requested from the server otherwise
function renderBrand(brand) {
  const name = document.getElementById('welcome-brand-name');
  const en = document.getElementById('welcome-brand-en');
  if (name && brand.name) name.textContent = brand.name;
  if (en) { en.textContent = brand.nameEn || ''; en.hidden = !brand.nameEn; }
  const slogan = document.getElementById('welcome-slogan');
  if (slogan) { slogan.textContent = brand.slogan || ''; slogan.hidden = !brand.slogan; }
  const owner = document.getElementById('header-owner');
  if (owner && brand.website) owner.href = brand.website;
  if (owner && (brand.legalName || brand.name)) owner.querySelector('.owner-name').textContent = brand.legalName || brand.name;
  if (brand.logo) {
    for (const [mark, cls] of [[document.querySelector('.welcome-brand-mark'), 'welcome-brand-logo'], [document.querySelector('.owner-mark'), 'owner-logo']]) {
      if (!mark) continue;
      const img = document.createElement('img');
      img.src = brand.logo;
      img.alt = '';
      img.decoding = 'async';
      img.className = cls;
      img.addEventListener('error', () => { img.remove(); mark.classList.remove('has-logo'); }, { once: true });
      mark.classList.add('has-logo');
      mark.replaceChildren(img);
    }
  }
}

function renderFooter(root, footer) {
  if (!root) return;
  if (!footer) { root.hidden = true; return; }
  root.replaceChildren();
  const link = (href, label, external = /^https?:/.test(href)) => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    if (external) { a.target = '_blank'; a.rel = 'noopener'; }
    return a;
  };
  const block = (cls, heading) => {
    const d = document.createElement('div');
    d.className = `footer-block ${cls}`;
    if (heading) { const h = document.createElement('h3'); h.className = 'footer-heading'; h.textContent = heading; d.append(h); }
    return d;
  };
  // 1. the company
  const brand = block('footer-brand');
  const name = document.createElement('strong');
  name.className = 'footer-name';
  name.textContent = footer.name || '';
  brand.append(name);
  if (footer.nameEn) brand.append(el('span', 'footer-name-en', footer.nameEn));
  if (footer.tagline) brand.append(el('p', 'footer-tagline', footer.tagline));
  if (footer.about) brand.append(el('p', 'footer-about', footer.about));
  root.append(brand);
  // 2. contact: phones (tel: links, LTR digits), location, website
  const contact = block('footer-contact', 'للتواصل');
  const ul = document.createElement('ul');
  ul.className = 'footer-contacts';
  for (const p of footer.phones || []) {
    const li = document.createElement('li');
    li.className = 'footer-phone';
    if (p.label) li.append(el('span', 'footer-phone-label', p.label));
    const a = link(`tel:${p.tel}`, p.display, false);
    a.dir = 'ltr';
    a.className = 'footer-phone-number';
    li.append(a);
    if (p.whatsapp) { const w = link(p.whatsapp, 'واتساب'); w.className = 'footer-whatsapp'; li.append(w); }
    ul.append(li);
  }
  if (footer.location) { const li = document.createElement('li'); li.className = 'footer-location'; li.textContent = footer.location; ul.append(li); }
  if (footer.website) { const li = document.createElement('li'); li.className = 'footer-website'; li.append(link(footer.website.href, footer.website.label)); ul.append(li); }
  contact.append(ul);
  root.append(contact);
  // 3. social accounts + legal links
  if ((footer.social && footer.social.length) || (footer.links && footer.links.length)) {
    const more = block('footer-more', footer.socialHeading || 'حساباتنا');
    if (footer.social && footer.social.length) {
      const nav = document.createElement('nav');
      nav.className = 'footer-social';
      nav.setAttribute('aria-label', 'حسابات التواصل');
      for (const sItem of footer.social) nav.append(link(sItem.href, sItem.label));
      more.append(nav);
    }
    if (footer.links && footer.links.length) {
      const nav = document.createElement('nav');
      nav.className = 'footer-links';
      nav.setAttribute('aria-label', 'روابط');
      for (const l of footer.links) nav.append(link(l.href, l.label));
      more.append(nav);
    }
    root.append(more);
  }
  if (footer.copyright) root.append(el('p', 'footer-copy', footer.copyright));
  root.hidden = false;
}

init().catch((err) => {
  console.error(err);
  const msg = document.createElement('p');
  msg.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;padding:12px 16px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);font-family:sans-serif';
  msg.textContent = 'تعذّر تحميل بيانات المكتب. أعد تحميل الصفحة أو تحقق من الاتصال.';
  document.body.append(msg);
});
