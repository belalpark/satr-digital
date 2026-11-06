// Entry point: loads the office record, wires the hash router and the views.
import { parseHash, navigate, teamNameFromSearch } from './router.js';
import { saveViewState, loadViewState } from './state.js';
import { createPlan } from './plan.js';
import { createRoom } from './room.js';
import { createDetails } from './details.js';

const SCENE_ORDER = ['current', 'visitor-path', 'team-layout'];
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

export async function init() {
  const app = document.getElementById('app');
  const data = await fetchJson('data/office.json');
  const buildInfo = await fetchJson('build-info.json', { optional: true });

  const views = {
    welcome: document.getElementById('view-welcome'),
    plan: document.getElementById('view-plan'),
    room: document.getElementById('view-room'),
    details: document.getElementById('view-details'),
  };
  const tip = document.getElementById('plan-tip');

  // ---------- build sha ----------
  const sha = buildInfo && buildInfo.sha ? buildInfo.sha.slice(0, 7) : 'dev';
  const shaEl = document.getElementById('build-sha');
  shaEl.textContent = buildInfo && buildInfo.branch ? `${buildInfo.branch} @ ${sha}` : sha;

  // ---------- welcome ----------
  const team = teamNameFromSearch(location.search, data.office.defaultTeamName);
  const personalised = team !== data.office.defaultTeamName;
  // «مرحبًا بفريق شركة نور» with ?team=, plain «مرحبًا بفريقكم» without it
  document.getElementById('welcome-title').textContent = personalised ? 'مرحبًا بفريق ' : 'مرحبًا بفريقكم';
  if (personalised) {
    const span = document.createElement('span');
    span.id = 'welcome-team';
    span.textContent = team;
    document.getElementById('welcome-title').append(span);
  }
  document.getElementById('welcome-subtitle').textContent = data.office.subtitle;
  document.getElementById('welcome-eyebrow').textContent = data.office.title;
  const hero = document.getElementById('welcome-photo');
  hero.src = data.office.heroImage;
  const teamChip = document.getElementById('plan-team-chip');
  if (personalised) {
    teamChip.textContent = team;
    teamChip.hidden = false;
  }
  // documented inventory as compact chips (what the office includes)
  const inventory = document.getElementById('welcome-inventory');
  if (inventory && data.office.inventory) {
    inventory.setAttribute('aria-label', data.office.inventory.label);
    inventory.replaceChildren(
      ...data.office.inventory.items.map((item) => {
        const li = document.createElement('li');
        li.textContent = `${item.count} ${item.name}`;
        return li;
      }),
    );
  }

  // ---------- booking (placeholder until the destination is approved) ----------
  const modal = document.getElementById('booking-modal');
  const modalClose = document.getElementById('booking-close');
  let modalOpener = null;
  document.getElementById('booking-note').textContent = data.office.booking.note;
  const closeModal = () => {
    if (modal.hidden) return;
    modal.hidden = true;
    if (modalOpener) modalOpener.focus();
  };
  for (const b of document.querySelectorAll('[data-book]')) {
    b.textContent = data.office.booking.label;
    b.addEventListener('click', () => {
      modalOpener = b;
      modal.hidden = false;
      modalClose.focus();
    });
  }
  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // ---------- plan ----------
  const planStage = document.getElementById('plan-stage');
  let preZoom = null; // where the visitor was before entering a room
  let opening = false; // a zoom-in is in flight: ignore the second tap of a double-tap
  const plan = createPlan(planStage, data, {
    tip,
    onRoomOpen: async (roomId) => {
      if (opening) return;
      opening = true;
      try {
        preZoom = plan.getState();
        saveViewState({ roomId, preZoom });
        await plan.zoomToRoom(roomId);
        navigate({ view: 'room', roomId });
      } finally {
        opening = false;
      }
    },
  });
  for (const b of document.querySelectorAll('.zoom-btn')) {
    b.addEventListener('click', () => {
      if (b.dataset.zoom === 'in') plan.zoomIn();
      else if (b.dataset.zoom === 'out') plan.zoomOut();
      else plan.fit();
    });
  }

  // scene tabs
  const tabs = document.getElementById('scene-tabs');
  const badge = document.getElementById('plan-badge');
  const extra = document.getElementById('scene-extra');
  const legend = document.getElementById('scene-legend');
  const hint = document.getElementById('scene-hint');
  const modeToggle = document.getElementById('mode-toggle');
  for (const id of SCENE_ORDER) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scene-tab';
    b.setAttribute('role', 'tab');
    b.dataset.scene = id;
    b.textContent = data.scenes[id].name;
    b.addEventListener('click', () => navigate({ view: 'plan', scene: id }, { replace: true }));
    tabs.append(b);
  }
  legend.replaceChildren(
    ...data.scenes['team-layout'].groups.map((g) => {
      const li = document.createElement('li');
      const sw = document.createElement('i');
      sw.style.setProperty('--swatch', g.color);
      li.append(sw, document.createTextNode(g.name));
      return li;
    }),
  );
  modeToggle.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    plan.setProposed(b.dataset.mode === 'proposed');
    updateBadge();
  });

  function updateBadge() {
    const scene = plan.getScene();
    const proposed = plan.isProposed();
    for (const b of modeToggle.querySelectorAll('.seg')) b.classList.toggle('is-active', (b.dataset.mode === 'proposed') === proposed);
    badge.className = 'plan-badge';
    if (scene === 'team-layout') {
      badge.textContent = proposed ? data.scenes['team-layout'].badge : data.scenes.current.badge;
      if (proposed) badge.classList.add('is-proposed');
    } else if (scene === 'visitor-path') {
      badge.textContent = data.scenes['visitor-path'].badge;
      badge.classList.add('is-path');
    } else {
      badge.textContent = data.scenes.current.badge;
    }
    legend.hidden = !(scene === 'team-layout' && proposed);
  }

  function applyScene(id) {
    const scene = data.scenes[id] ? id : 'current';
    plan.setScene(scene);
    for (const b of tabs.children) {
      const active = b.dataset.scene === scene;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    }
    extra.hidden = scene !== 'team-layout';
    hint.textContent = data.scenes[scene].description || '';
    updateBadge();
  }
  // Initialise tabs/badge/hint once; render() only re-applies when the scene changes.
  applyScene('current');

  // ---------- room & details ----------
  const room = createRoom(views.room, data);
  const details = createDetails(views.details, data, {
    onOpenPhoto: (roomId, index) => {
      room.select(index);
      navigate({ view: 'room', roomId });
    },
  });
  document.getElementById('btn-back-plan').addEventListener('click', () => {
    const saved = loadViewState();
    navigate({ view: 'plan', scene: saved && saved.preZoom ? saved.preZoom.scene : plan.getScene() });
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
    // Going "up" (plan → room → details) the previous view stays visible under the
    // fade-in. Going "down" (details → room → plan) it must get out of the way at
    // once so the plan's glide-back is not hidden behind the room photo.
    const order = { welcome: 0, plan: 1, room: 2, details: 3 };
    const goingUp = !prev || order[name] > order[prev];
    for (const [key, v] of Object.entries(views)) {
      v.classList.toggle('is-active', key === name);
      v.classList.toggle('is-under', goingUp && key === prev);
      v.classList.toggle('is-leaving-fast', !goingUp && key === prev);
    }
    if (prev) setTimeout(() => views[prev].classList.remove('is-under', 'is-leaving-fast'), VIEW_FADE_MS);
    document.title = data.office.title;
  }

  function roomIsOpenable(id) {
    const r = data.rooms.find((x) => x.id === id);
    return !!r && r.status === 'ready';
  }

  let lastRoute = null;
  async function render() {
    const route = parseHash(location.hash);
    const from = lastRoute;
    lastRoute = route;

    if ((route.view === 'room' || route.view === 'details') && !roomIsOpenable(route.roomId)) {
      navigate({ view: 'plan' }, { replace: true });
      return;
    }

    if (route.view === 'welcome') {
      showView('welcome');
      return;
    }

    if (route.view === 'plan') {
      const saved = loadViewState();
      const cameBackFromRoom = from && (from.view === 'room' || from.view === 'details');
      // No ?scene= means "current" — except when returning from a room, where the
      // saved scene wins so the visitor lands where they left.
      const sceneId = route.scene || (cameBackFromRoom && saved && saved.preZoom ? saved.preZoom.scene : 'current');
      showView('plan');
      if (sceneId !== plan.getScene() || !from) applyScene(sceneId);
      if (saved && saved.preZoom && typeof saved.preZoom.proposed === 'boolean' && cameBackFromRoom) {
        plan.setProposed(saved.preZoom.proposed);
        updateBadge();
      }
      if (cameBackFromRoom) {
        preZoom = null; // reset before awaiting so a click during the glide is not wiped out
        plan.relayout();
        // start from the zoomed-in room and glide back to where the visitor was
        if (saved && saved.roomId) await plan.zoomToRoom(saved.roomId, { animate: false });
        await plan.animateTo(saved ? saved.preZoom : null);
      } else if (!from) {
        plan.relayout();
      }
      document.title = `${data.office.title} — المخطط`;
      return;
    }

    if (route.view === 'room') {
      const r = data.rooms.find((x) => x.id === route.roomId);
      if (!from || from.view === 'welcome' || (from.view === 'plan' && !preZoom)) {
        // Deep link / refresh / browser history (not via onRoomOpen): remember where the
        // plan is — its live state when we come from the plan, otherwise the saved state
        // for this same room — then park the plan on the room so "back" animates nicely.
        const stale = loadViewState();
        const live = from && from.view === 'plan' ? plan.getState() : null;
        saveViewState({
          roomId: route.roomId,
          preZoom: live && live.mode !== 'room' ? live : stale && stale.roomId === route.roomId ? stale.preZoom : null,
        });
        plan.relayout();
        await plan.zoomToRoom(route.roomId, { animate: false });
      }
      if (!(from && from.view === 'details' && details.currentRoom() === route.roomId)) {
        room.show(route.roomId, { photoIndex: from && from.view === 'details' ? room.currentIndex() : 0 });
      }
      showView('room');
      document.title = `${r.name} — ${data.office.title}`;
      return;
    }

    if (route.view === 'details') {
      const r = data.rooms.find((x) => x.id === route.roomId);
      if (room.currentRoom() !== r) room.show(route.roomId);
      details.show(route.roomId);
      showView('details');
      document.title = `تفاصيل ${r.name} — ${data.office.title}`;
    }
  }

  window.addEventListener('hashchange', () => { render(); });
  await render();
  app.classList.add('is-ready');
}

init().catch((err) => {
  console.error(err);
  const el = document.createElement('p');
  el.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;padding:12px 16px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);font-family:sans-serif';
  el.textContent = 'تعذّر تحميل بيانات المكتب. أعد تحميل الصفحة أو تحقق من الاتصال.';
  document.body.append(el);
});
