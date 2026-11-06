// Entry point: loads the office record, wires the hash router and the views.
import { parseHash, navigate, teamNameFromSearch } from './router.js';
import { saveViewState, loadViewState } from './state.js';
import { createPlan } from './plan.js';
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

export async function init() {
  const app = document.getElementById('app');
  const data = await fetchJson('data/office.json');
  const buildInfo = await fetchJson('build-info.json', { optional: true });
  const W = data.office.welcome;

  const views = {
    welcome: document.getElementById('view-welcome'),
    plan: document.getElementById('view-plan'),
    photos: document.getElementById('view-room'),
    details: document.getElementById('view-details'),
  };
  const tip = document.getElementById('plan-tip');

  // ---------- build sha ----------
  const sha = buildInfo && buildInfo.sha ? buildInfo.sha.slice(0, 7) : 'dev';
  document.getElementById('build-sha').textContent = buildInfo && buildInfo.branch ? `${buildInfo.branch} @ ${sha}` : sha;

  // ---------- welcome ----------
  const team = teamNameFromSearch(location.search, '');
  const title = document.getElementById('welcome-title');
  if (team) {
    // «مرحبًا بفريق شركة نور» with ?team=, plain «مرحبًا بكم» without it
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
  document.getElementById('welcome-photo').src = data.office.heroImage;
  const highlights = document.getElementById('welcome-highlights');
  const items = [];
  const plus = () => {
    const p = el('span', 'plus', '+ ');
    p.setAttribute('aria-hidden', 'true');
    return p;
  };
  W.highlights.forEach((h, i) => {
    const li = el('li', 'highlight');
    if (i > 0) li.append(plus());
    // Arabic duals already carry the number («قاعتا اجتماعات» = two meeting rooms)
    if (!h.dual) li.append(el('strong', '', String(h.value)), document.createTextNode(' '));
    li.append(document.createTextNode(h.label));
    items.push(li);
  });
  const more = el('li', 'highlight is-more');
  more.append(plus(), document.createTextNode(W.more));
  items.push(more);
  highlights.replaceChildren(...items);

  // ---------- plan ----------
  const planStage = document.getElementById('plan-stage');
  let opening = false; // a navigation into a room is in flight: ignore a second tap
  const focusPanelEl = document.getElementById('focus-panel');
  const plan = createPlan(planStage, data, {
    tip,
    focusInset: () => (window.innerWidth <= 720 && window.innerHeight > 500 && !focusPanelEl.hidden ? focusPanelEl.offsetHeight + 16 : 0),
    onRoomOpen: (roomId) => {
      if (opening) return;
      opening = true;
      const state = plan.getState();
      saveViewState({ roomId, preZoom: state.focus ? null : state });
      navigate({ view: 'room', roomId });
      setTimeout(() => { opening = false; }, 400);
    },
  });
  for (const b of document.querySelectorAll('.zoom-btn')) {
    b.addEventListener('click', () => {
      if (b.dataset.zoom === 'in') plan.zoomIn();
      else if (b.dataset.zoom === 'out') plan.zoomOut();
      else if (plan.getFocus()) navigate({ view: 'plan', scene: plan.getScene() });
      else plan.fit();
    });
  }

  // scene tabs + route legend
  const tabs = document.getElementById('scene-tabs');
  const badge = document.getElementById('plan-badge');
  const legend = document.getElementById('route-legend');
  const hint = document.getElementById('scene-hint');
  for (const id of SCENE_ORDER) {
    const b = el('button', 'scene-tab', data.scenes[id].name);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.scene = id;
    b.addEventListener('click', () => navigate({ view: 'plan', scene: id }, { replace: true }));
    tabs.append(b);
  }
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
        plan.setRouteVisible(r.id, on);
      });
      li.append(b);
      return li;
    }),
  );

  function applyScene(id) {
    const scene = SCENE_ORDER.includes(id) ? id : 'current';
    plan.setScene(scene);
    for (const b of tabs.children) {
      const active = b.dataset.scene === scene;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    }
    legend.hidden = scene !== 'paths';
    hint.textContent = data.scenes[scene].description || '';
    badge.textContent = data.scenes[scene].badge;
    badge.classList.toggle('is-path', scene === 'paths');
  }
  applyScene('current');

  // ---------- focus panel (second shot) ----------
  const focusPanel = document.getElementById('focus-panel');
  const focusEls = {
    title: document.getElementById('focus-title'),
    summary: document.getElementById('focus-summary'),
    capacity: document.getElementById('focus-capacity'),
    photos: document.getElementById('btn-photos'),
  };
  let focusRoomId = null;
  function showFocusPanel(room) {
    focusRoomId = room ? room.id : null;
    views.plan.classList.toggle('is-focus', !!room);
    focusPanel.hidden = !room;
    if (!room) return;
    focusEls.title.textContent = room.name;
    focusEls.summary.textContent = room.summary || '';
    focusEls.capacity.textContent = room.capacity ? seatsLabel(room.capacity.seats) : '';
    focusEls.capacity.hidden = !room.capacity;
    focusEls.photos.textContent = `الصور الحقيقية (${room.photos.length})`;
  }
  document.getElementById('btn-focus-back').addEventListener('click', () => navigate({ view: 'plan', scene: plan.getScene() }));
  focusEls.photos.addEventListener('click', () => focusRoomId && navigate({ view: 'photos', roomId: focusRoomId }));
  document.getElementById('btn-focus-details').addEventListener('click', () => focusRoomId && navigate({ view: 'details', roomId: focusRoomId }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lastRoute && lastRoute.view === 'room') navigate({ view: 'plan', scene: plan.getScene() });
  });

  // ---------- photos & details ----------
  const room = createRoom(views.photos, data);
  let pendingPhoto = null;
  const details = createDetails(views.details, data, {
    onOpenPhoto: (roomId, index) => {
      pendingPhoto = index;
      navigate({ view: 'photos', roomId });
    },
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
    // Going "up" (plan → photos → details) the previous view stays visible under the
    // fade-in. Going "down" it gets out of the way at once.
    const order = { welcome: 0, plan: 1, photos: 2, details: 3 };
    const goingUp = !prev || order[name] > order[prev];
    for (const [key, v] of Object.entries(views)) {
      v.classList.toggle('is-active', key === name);
      v.classList.toggle('is-under', goingUp && key === prev);
      v.classList.toggle('is-leaving-fast', !goingUp && key === prev);
    }
    if (prev) setTimeout(() => views[prev].classList.remove('is-under', 'is-leaving-fast'), VIEW_FADE_MS);
  }

  function openableRoom(id) {
    const r = data.rooms.find((x) => x.id === id);
    return r && r.status === 'ready' ? r : null;
  }

  // The plan underneath every room view stays focused on that room, so "back"
  // always lands on the room's second shot.
  async function ensureFocus(r, animate) {
    if (plan.getFocus() === r.id) return;
    if (!animate) plan.relayout();
    await plan.focusRoom(r.id, { animate });
  }

  let lastRoute = null;
  async function render() {
    const route = parseHash(location.hash);
    const from = lastRoute;
    lastRoute = route;
    const r = route.roomId ? openableRoom(route.roomId) : null;

    if ((route.view === 'room' || route.view === 'photos' || route.view === 'details') && !r) {
      navigate({ view: 'plan' }, { replace: true });
      return;
    }

    if (route.view === 'welcome') {
      showView('welcome');
      document.title = data.office.title;
      return;
    }

    if (route.view === 'plan' && !/^#\/plan(\?|$)/.test(location.hash)) {
      // unknown route (e.g. #/room/x/typo): show the plan under its own URL
      navigate({ view: 'plan', scene: route.scene }, { replace: true });
      return;
    }

    if (route.view === 'plan') {
      // links from the first preview used ?scene=visitor-path; anything unknown means "current"
      const asked = route.scene || 'current';
      const sceneId = asked === 'visitor-path' ? 'paths' : SCENE_ORDER.includes(asked) ? asked : 'current';
      if (sceneId !== asked) {
        navigate({ view: 'plan', scene: sceneId }, { replace: true });
        return;
      }
      showView('plan');
      if (sceneId !== plan.getScene() || !from) applyScene(sceneId);
      showFocusPanel(null);
      if (plan.getFocus()) {
        const saved = loadViewState();
        await plan.unfocus({ animate: true, to: saved && saved.preZoom });
      } else if (!from) {
        plan.relayout();
      }
      document.title = `${data.office.title} — المخطط ثلاثي الأبعاد`;
      return;
    }

    if (route.view === 'room') {
      showView('plan');
      showFocusPanel(r);
      // keyboard and screen-reader users land on the room they opened
      focusEls.title.focus({ preventScroll: true });
      // reached from the plan through browser history: remember where the plan was
      if (from && from.view === 'plan' && !plan.getFocus()) saveViewState({ roomId: r.id, preZoom: plan.getState() });
      await ensureFocus(r, !!from && from.view === 'plan');
      document.title = `${r.name} — ${data.office.title}`;
      return;
    }

    if (route.view === 'photos') {
      if (room.currentRoom() !== r || pendingPhoto !== null) room.show(r.id, { photoIndex: pendingPhoto ?? 0 });
      pendingPhoto = null;
      showView('photos');
      showFocusPanel(r);
      ensureFocus(r, false);
      document.title = `صور ${r.name} — ${data.office.title}`;
      return;
    }

    if (route.view === 'details') {
      if (room.currentRoom() !== r) room.show(r.id);
      details.show(r.id);
      showView('details');
      showFocusPanel(r);
      ensureFocus(r, false);
      document.title = `تفاصيل ${r.name} — ${data.office.title}`;
    }
  }

  window.addEventListener('hashchange', () => { render(); });
  await render();
  app.classList.add('is-ready');
}

init().catch((err) => {
  console.error(err);
  const msg = document.createElement('p');
  msg.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;padding:12px 16px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);font-family:sans-serif';
  msg.textContent = 'تعذّر تحميل بيانات المكتب. أعد تحميل الصفحة أو تحقق من الاتصال.';
  document.body.append(msg);
});
