// Entry point: loads the office record, the live 3D model, and wires the hash
// router to the views (welcome → 3D plan → room focus → photos / details).
import { parseHash, navigate, teamNameFromSearch } from './router.js';
import { createTwin3D } from './twin3d.js';
import { createPlan2D } from './plan2d.js';
import { createOverlay } from './overlay.js';
import { createRoom } from './room.js';
import { createDetails } from './details.js';
import { seatsLabel } from './format.js';

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
  const buildInfo = await fetchJson('build-info.json', { optional: true });
  const W = data.office.welcome;
  const roomsById = new Map(data.rooms.map((r) => [r.id, r]));

  const views = {
    welcome: document.getElementById('view-welcome'),
    plan: document.getElementById('view-plan'),
    photos: document.getElementById('view-room'),
    details: document.getElementById('view-details'),
  };

  // ---------- build sha ----------
  const sha = buildInfo && buildInfo.sha ? buildInfo.sha.slice(0, 7) : 'dev';
  document.getElementById('build-sha').textContent = buildInfo && buildInfo.branch ? `${buildInfo.branch} @ ${sha}` : sha;

  // ---------- welcome ----------
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
    title.textContent = W.title;
  }
  document.getElementById('welcome-subtitle').textContent = W.subtitle;
  document.getElementById('welcome-atmosphere').textContent = W.atmosphere;
  document.getElementById('btn-start').textContent = W.cta;
  const locEl = document.getElementById('welcome-location');
  locEl.textContent = W.location || '';
  locEl.hidden = !W.location;
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
  const plan2d = createPlan2D(plan2dStage, data, {});
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
    el.addEventListener('pointerdown', (e) => { down = onControl(e) ? null : { x: e.clientX, y: e.clientY, t: Date.now() }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || onControl(e)) { down = null; return; }
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

  function loadTwin() {
    if (twinPromise) return twinPromise;
    twinPromise = (async () => {
    try {
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
    if (room.hasPhotos) facts.push(['الصور', `${room.photos.length} صور حقيقية`]);
    cardEls.facts.replaceChildren(...facts.map(([k, v]) => { const li = el('li'); li.append(el('span', 'k', k), el('span', 'v', v)); return li; }));
    cardEls.photos.hidden = !room.hasPhotos;
    cardEls.photos.textContent = room.hasPhotos ? `الصور الحقيقية (${room.photos.length})` : '';
    cardEls.details.hidden = !(room.fixtures || room.capacity || room.hasPhotos);
    if (listItems.get(room.id)) listItems.get(room.id).scrollIntoView({ block: 'nearest' });
  }
  document.getElementById('btn-focus-back').addEventListener('click', () => navigate({ view: 'plan', scene: currentScene }));
  cardEls.photos.addEventListener('click', () => focusRoomId && navigate({ view: 'photos', roomId: focusRoomId }));
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
  document.getElementById('btn-back-plan').addEventListener('click', () => {
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
    const order = { welcome: 0, plan: 1, photos: 2, details: 3 };
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

    if (route.view === 'plan') {
      const asked = route.scene || 'current';
      const sceneId = asked === 'visitor-path' ? 'paths' : SCENE_ORDER.includes(asked) ? asked : 'current';
      if (sceneId !== asked) { navigate({ view: 'plan', scene: sceneId }, { replace: true }); return; }
      showView('plan');
      setNav(sceneId === 'paths' ? 'paths' : 'plan');
      if (sceneId !== currentScene || !from) applyScene(sceneId);
      showRoomCard(null);
      document.title = `${data.office.title} — المخطط ثلاثي الأبعاد`;
      ensureUnfocus(current);
      return;
    }

    if (route.view === 'room') {
      showView('plan');
      setNav('plan');
      showRoomCard(r);
      cardEls.title.focus({ preventScroll: true });
      document.title = `${r.name} — ${data.office.title}`;
      ensureFocus(r, !!from && (from.view === 'plan' || from.view === 'room'), current);
      return;
    }

    if (route.view === 'photos') {
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

// Satr's identity on the welcome page and in the header: wordmark text always, the logo file
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
  if (owner) owner.querySelector('.owner-name').textContent = brand.legalName || brand.name || 'شركة سطر العقارية';
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
    const more = block('footer-more', 'حسابات سطر');
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
