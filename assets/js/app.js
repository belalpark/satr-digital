// Entry point: loads the office record, the live 3D model, and wires the hash
// router to the views (welcome → 3D plan → room focus → photos / details).
import { parseHash, navigate, teamNameFromSearch } from './router.js';
import { createTwin3D } from './twin3d.js';
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
  const hero = document.getElementById('welcome-photo');
  hero.src = data.office.heroImage;
  hero.addEventListener('error', () => { if (data.office.heroFallback && hero.src.indexOf(data.office.heroFallback) < 0) hero.src = data.office.heroFallback; }, { once: true });

  // ---------- header nav state ----------
  const navLinks = [...document.querySelectorAll('.site-nav a')];
  function setNav(key) {
    for (const a of navLinks) a.classList.toggle('is-active', a.dataset.nav === key);
  }

  // ---------- 3D plan ----------
  const planStage = document.getElementById('plan-stage');
  const loading = document.getElementById('twin-loading');
  let twin = null;
  let overlay = null;
  let twinError = null;
  let twinPromise = null;
  function loadTwin() {
    if (twinPromise) return twinPromise;
    twinPromise = (async () => {
    try {
      twin = await createTwin3D(planStage, data, { base: data.office.model.base, lighting: readPref('lighting', 'day'), idleSpin: true, active: currentView === 'plan' });
      twin.setActive(currentView === 'plan'); // the view may have changed while the model was loading
      overlay = createOverlay(planStage, twin, data, {
        onModel: (id) => toggleRoom(id),
        onPhotos: (id) => navigate({ view: 'photos', roomId: id }),
      });
      overlay.setOutside(readPref('labels', 'inside') === 'outside');
      loading.hidden = true;
      planStage.classList.add('is-ready');
      planStage.__twin = twin; // test hook (read-only use by the e2e suite)
      // click on the model itself: once = focus, again on the same room = back to the plan
      let down = null;
      twin.element.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
      twin.element.addEventListener('pointerup', (e) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || Date.now() - down.t > 600;
        down = null;
        if (moved) return;
        const id = twin.roomAt(e.clientX, e.clientY);
        if (id) toggleRoom(id);
      });
      twin.element.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        const id = twin.roomAt(e.clientX, e.clientY);
        const r = id ? roomsById.get(id) : null;
        twin.element.style.cursor = r && r.status === 'ready' ? 'pointer' : '';
        showTip(r && r.status === 'ready' ? `${r.name} — انقر للمنظور القريب` : '', e.clientX, e.clientY);
      });
      twin.element.addEventListener('pointerleave', () => showTip(''));
      twin.element.addEventListener('contextmenu', (e) => e.preventDefault());
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
    if (!r || r.status !== 'ready' || !r.hasModel) return;
    const route = parseHash(location.hash);
    if (route.view === 'room' && route.roomId === id) navigate({ view: 'plan', scene: currentScene });
    else navigate({ view: 'room', roomId: id });
  }

  for (const b of document.querySelectorAll('.zoom-btn')) {
    b.addEventListener('click', () => {
      if (!twin) return;
      twin.stopIdle();
      if (b.dataset.zoom === 'in') twin.zoom(1.35);
      else if (b.dataset.zoom === 'out') twin.zoom(1 / 1.35);
      else twin.resetView();
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
    if (!overlay) return;
    const next = !overlay.isOutside();
    overlay.setOutside(next);
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
        if (twin) twin.setRouteVisible(r.id, on);
      });
      li.append(b);
      return li;
    }),
  );
  function syncSceneToTwin() {
    if (!twin) return;
    twin.setRoutesVisible(currentScene === 'paths');
    for (const [id, on] of routeState) twin.setRouteVisible(id, on);
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
    snapshot: () => (twin ? twin.snapshot() : ''),
  });
  document.getElementById('btn-back-plan').addEventListener('click', () => {
    const r = room.currentRoom();
    navigate(r ? { view: 'room', roomId: r.id } : { view: 'plan' });
  });
  document.getElementById('btn-details').addEventListener('click', () => {
    const r = room.currentRoom();
    if (r) navigate({ view: 'details', roomId: r.id });
  });
  document.getElementById('btn-close-details').addEventListener('click', () => {
    const id = details.currentRoom();
    if (id) navigate({ view: 'room', roomId: id });
  });

  // ---------- view switching ----------
  let currentView = null;
  function showView(name) {
    if (currentView === name) return;
    const prev = currentView;
    currentView = name;
    app.dataset.currentView = name;
    if (twin) twin.setActive(name === 'plan'); // no rendering or turntable behind the photos/details/welcome views
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
    await loadTwin();
    if (!twin || !current()) return;
    twin.stopIdle();
    if (twin.getFocus() !== r.id) await twin.focusRoom(r.id, { animate });
    else await twin.settled(); // the flight to this room may still be in progress (e.g. details opened mid-flight)
    if (overlay && current()) overlay.setFocus(r.id);
  }
  async function ensureUnfocus(current = () => true) {
    await loadTwin();
    if (!twin || !current()) return;
    if (overlay) overlay.setFocus(null);
    if (twin.getFocus()) await twin.unfocus({ animate: true });
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
    if (route.view === 'room' && !openableRoom(route.roomId)) { navigate({ view: 'plan' }, { replace: true }); return; }
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
      if (r.focus && r.focus.image) {
        details.show(r.id); // the pre-rendered view exists: no need to wait for the model
        ensureFocus(r, false, current);
      } else {
        details.show(r.id, { deferImage: true });
        ensureFocus(r, false, current).then(() => { if (current() && details.currentRoom() === r.id) details.refreshImage(); });
      }
      document.title = `تفاصيل ${r.name} — ${data.office.title}`;
    }
  }

  window.addEventListener('hashchange', () => { render(); });
  await render();
  app.classList.add('is-ready');
  // warm the model while the visitor reads the welcome
  setTimeout(loadTwin, 600);
}

init().catch((err) => {
  console.error(err);
  const msg = document.createElement('p');
  msg.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;padding:12px 16px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);font-family:sans-serif';
  msg.textContent = 'تعذّر تحميل بيانات المكتب. أعد تحميل الصفحة أو تحقق من الاتصال.';
  document.body.append(msg);
});
