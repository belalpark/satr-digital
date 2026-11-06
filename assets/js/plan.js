// Interactive dollhouse plan: the rendered plan image with an SVG overlay of
// clickable room polygons, zoom/pan, and the Home-Assistant-style scenes.
import { bbox, zoomTransform, pointsAttr } from './geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_SCALE = 1;
const MAX_SCALE = 5;
const ROOM_ZOOM_MAX = 3.2;
const ROOM_ZOOM_PADDING = 0.12;

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function svgText(x, y, text, className) {
  const t = svgEl('text', { x, y });
  t.classList.add(className);
  t.textContent = text;
  return t;
}

/**
 * @param {HTMLElement} stage   container (position: relative/absolute, overflow hidden)
 * @param {object} data         office.json
 * @param {object} opts
 *   onRoomOpen(roomId)         called after the zoom-in animation of a ready room
 *   tip                        shared tooltip element
 *   static                     true = non-interactive (details panel)
 */
export function createPlan(stage, data, opts = {}) {
  const { width: planW, height: planH } = data.office.plan;
  const rooms = data.rooms;
  const roomsById = new Map(rooms.map((r) => [r.id, r]));
  const isStatic = !!opts.static;

  // ---------- DOM ----------
  const world = document.createElement('div');
  world.className = 'plan-world';
  const img = document.createElement('img');
  img.src = data.office.plan.image;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  const svg = svgEl('svg', { viewBox: `0 0 ${planW} ${planH}`, preserveAspectRatio: 'none' });
  svg.classList.add('plan-svg');
  const roomsLayer = svgEl('g', { class: 'layer-rooms' });
  const sceneLayer = svgEl('g', { class: 'scene-layer' });
  const labelsLayer = svgEl('g', { class: 'layer-labels' });
  svg.append(roomsLayer, sceneLayer, labelsLayer);
  world.append(img, svg);
  stage.append(world);

  const paths = new Map();
  const labels = new Map();
  const sublabels = new Map();

  for (const room of rooms) {
    const path = svgEl('polygon', { points: pointsAttr(room.polygon), 'data-id': room.id });
    path.classList.add('room', `is-${room.status}`);
    if (!isStatic && room.status === 'ready') {
      // only openable rooms are tab stops; "soon" rooms stay reachable by pointer (tooltip)
      path.setAttribute('role', 'button');
      path.setAttribute('tabindex', '0');
      path.setAttribute('aria-label', `${room.name} — ادخل الغرفة`);
    } else if (!isStatic && room.status === 'soon') {
      path.setAttribute('aria-label', `${room.name} — قريبًا`);
    }
    const title = svgEl('title');
    title.textContent = room.name;
    path.append(title);
    roomsLayer.append(path);
    paths.set(room.id, path);

    const label = svgText(room.label.x, room.label.y, room.short || room.name, 'room-label');
    if (room.status === 'ready') label.classList.add('is-ready');
    if (room.kind === 'office' || room.kind === 'service') label.classList.add('is-minor');
    labelsLayer.append(label);
    labels.set(room.id, label);

    const sub = svgText(room.label.x, room.label.y + 20, '', 'room-sublabel');
    sub.setAttribute('hidden', '');
    if (room.kind === 'office' || room.kind === 'service') sub.classList.add('is-minor');
    labelsLayer.append(sub);
    sublabels.set(room.id, sub);
  }

  // ---------- view state ----------
  let stageW = 0;
  let stageH = 0;
  let fitScale = 1;
  let current = { scale: 1, tx: 0, ty: 0 };
  let mode = 'fit'; // 'fit' | 'room' | 'free'
  let zoomedRoom = null;
  let scene = 'current';
  let proposed = true;

  function measure() {
    const r = stage.getBoundingClientRect();
    stageW = r.width;
    stageH = r.height;
    fitScale = Math.min(stageW / planW, stageH / planH) || 1;
    world.style.width = `${planW * fitScale}px`;
    world.style.height = `${planH * fitScale}px`;
  }

  function fitTransform() {
    return { scale: 1, tx: (stageW - planW * fitScale) / 2, ty: (stageH - planH * fitScale) / 2 };
  }

  function clamp(t) {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale));
    const worldW = planW * fitScale * scale;
    const worldH = planH * fitScale * scale;
    let { tx, ty } = t;
    if (worldW <= stageW) tx = (stageW - worldW) / 2;
    else tx = Math.min(0, Math.max(stageW - worldW, tx));
    if (worldH <= stageH) ty = (stageH - worldH) / 2;
    else ty = Math.min(0, Math.max(stageH - worldH, ty));
    return { scale, tx, ty };
  }

  function apply(t, animate = false) {
    current = t;
    world.classList.toggle('is-animating', !!animate);
    world.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`;
    // minor labels (small offices, services) only when zoomed in enough to read them
    svg.classList.toggle('is-zoomed', t.scale * fitScale >= 0.95 || isStatic);
  }

  function waitTransition(ms = 760) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (e) => {
        // transitionend bubbles: ignore the polygons' hover fill transitions
        if (e && e.target !== world) return;
        if (done) return;
        done = true;
        world.removeEventListener('transitionend', finish);
        resolve();
      };
      world.addEventListener('transitionend', finish);
      setTimeout(finish, ms);
    });
  }

  function roomTransform(roomId) {
    const room = roomsById.get(roomId);
    const box = bbox(room.polygon);
    const padding = isStatic ? 0.2 : ROOM_ZOOM_PADDING;
    const maxScale = isStatic ? 2.4 : ROOM_ZOOM_MAX;
    return zoomTransform(box, { w: stageW, h: stageH }, { fitScale, padding, maxScale });
  }

  async function zoomToRoom(roomId, { animate = true } = {}) {
    zoomedRoom = roomId;
    mode = 'room';
    apply(roomTransform(roomId), animate);
    if (animate) await waitTransition();
  }

  async function resetZoom(animate = true) {
    mode = 'fit';
    zoomedRoom = null;
    apply(fitTransform(), animate);
    if (animate) await waitTransition();
  }

  function zoomAround(point, factor, animate = false) {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
    const k = scale / current.scale;
    const t = clamp({ scale, tx: point.x - (point.x - current.tx) * k, ty: point.y - (point.y - current.ty) * k });
    mode = scale <= MIN_SCALE + 1e-6 ? 'fit' : 'free';
    zoomedRoom = null;
    apply(mode === 'fit' ? fitTransform() : t, animate);
  }

  function relayout() {
    measure();
    if (mode === 'room' && zoomedRoom) apply(roomTransform(zoomedRoom), false);
    else if (mode === 'fit') apply(fitTransform(), false);
    else apply(clamp(current), false);
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => relayout()).observe(stage);
  } else {
    window.addEventListener('resize', relayout);
  }
  relayout();

  // ---------- highlight ----------
  function highlight(roomId) {
    for (const [id, path] of paths) {
      path.classList.toggle('is-highlight', id === roomId);
      path.classList.toggle('is-dim', !!roomId && id !== roomId);
      labels.get(id).classList.toggle('is-current', id === roomId);
    }
  }

  // ---------- scenes ----------
  function clearScene() {
    sceneLayer.replaceChildren();
    for (const [id, path] of paths) {
      path.style.fill = '';
      path.style.stroke = '';
      path.style.strokeDasharray = '';
      path.classList.remove('is-scene');
      sublabels.get(id).setAttribute('hidden', '');
    }
  }

  function renderVisitorPath() {
    const sc = data.scenes['visitor-path'];
    const pts = pointsAttr(sc.waypoints);
    sceneLayer.append(svgEl('polyline', { points: pts, class: 'path-glow' }));
    sceneLayer.append(svgEl('polyline', { points: pts, class: 'path-line' }));
    sc.stops.forEach((stop, i) => {
      const g = svgEl('g', { class: 'path-stop' });
      g.append(svgEl('circle', { cx: stop.at[0], cy: stop.at[1], r: 20 }));
      g.append(svgText(stop.at[0], stop.at[1], String(i + 1), 'stop-number'));
      const name = svgText(stop.at[0], stop.at[1] + 44, stop.label, 'stop-name');
      g.append(name);
      sceneLayer.append(g);
    });
  }

  function renderTeamLayout() {
    const sc = data.scenes['team-layout'];
    const colorByRoom = new Map();
    for (const g of sc.groups) for (const id of g.rooms) colorByRoom.set(id, g.color);
    for (const room of rooms) {
      const path = paths.get(room.id);
      const color = proposed ? colorByRoom.get(room.id) : null;
      if (color) {
        path.style.fill = hexToRgba(color, 0.34);
        path.style.stroke = color;
        path.style.strokeDasharray = '10 7';
        path.classList.add('is-scene');
      } else if (!proposed && room.kind !== 'circulation' && room.kind !== 'service') {
        path.style.fill = 'rgba(91, 100, 114, 0.22)';
        path.style.stroke = 'rgba(91, 100, 114, 0.8)';
        path.style.strokeDasharray = '';
        path.classList.add('is-scene');
      }
      const sub = sublabels.get(room.id);
      const text = proposed ? room.use.proposed : room.use.current;
      if (text && room.kind !== 'service' && room.kind !== 'circulation') {
        sub.textContent = text;
        sub.removeAttribute('hidden');
      }
    }
    for (const cluster of sc.seatClusters) {
      const g = svgEl('g', { class: `seat-marker${proposed ? '' : ' is-current'}` });
      g.append(svgEl('circle', { cx: cluster.at[0], cy: cluster.at[1], r: 17 }));
      g.append(svgText(cluster.at[0], cluster.at[1], String(cluster.seats), 'seat-count'));
      sceneLayer.append(g);
    }
  }

  function setScene(id) {
    scene = data.scenes[id] ? id : 'current';
    clearScene();
    if (scene === 'visitor-path') renderVisitorPath();
    if (scene === 'team-layout') renderTeamLayout();
  }

  function setProposed(value) {
    proposed = !!value;
    if (scene === 'team-layout') setScene('team-layout');
  }

  // ---------- interaction ----------
  const tip = opts.tip;
  let tipTimer = 0;
  function showTip(x, y, text, autoHide = 0) {
    if (!tip) return;
    tip.textContent = text;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.hidden = false;
    clearTimeout(tipTimer);
    if (autoHide) tipTimer = setTimeout(hideTip, autoHide);
  }
  function hideTip() {
    if (tip) tip.hidden = true;
  }

  if (!isStatic) {
    const pointers = new Map();
    let dragStart = null;
    let dragged = false;
    let pinchStart = null;
    let pressed = null; // room polygon under the pointer at pointerdown

    stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return; // right/middle click never opens a room
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      stage.setPointerCapture(e.pointerId);
      if (pointers.size === 1) {
        dragStart = { x: e.clientX, y: e.clientY, tx: current.tx, ty: current.ty };
        dragged = false;
        pressed = e.target.closest ? e.target.closest('.room') : null;
      } else if (pointers.size === 2) {
        pressed = null;
        const [a, b] = [...pointers.values()];
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: current.scale, tx: current.tx, ty: current.ty, mid: mid(a, b) };
        dragStart = null;
      }
    });

    stage.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchStart) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const factor = dist / pinchStart.dist;
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStart.scale * factor));
        const k = scale / pinchStart.scale;
        const rect = stage.getBoundingClientRect();
        const m0 = { x: pinchStart.mid.x - rect.left, y: pinchStart.mid.y - rect.top };
        const m1 = mid(a, b);
        const mx = m1.x - rect.left;
        const my = m1.y - rect.top;
        mode = 'free';
        zoomedRoom = null;
        dragged = true;
        apply(clamp({ scale, tx: mx - (m0.x - pinchStart.tx) * k, ty: my - (m0.y - pinchStart.ty) * k }), false);
        return;
      }
      if (pointers.size === 1 && dragStart && pointers.has(e.pointerId)) {
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        if (!dragged && Math.hypot(dx, dy) < 6) return;
        dragged = true; // moved too far to count as a tap, even when there is nothing to pan
        if (current.scale <= MIN_SCALE + 1e-6) return;
        stage.classList.add('is-dragging');
        mode = 'free';
        zoomedRoom = null;
        apply(clamp({ scale: current.scale, tx: dragStart.tx + dx, ty: dragStart.ty + dy }), false);
        return;
      }
      if (pointers.size === 0 && e.pointerType === 'mouse') {
        const room = roomFromEvent(e);
        if (room) {
          const hint = room.status === 'ready' ? `${room.name} — انقر للدخول` : room.status === 'soon' ? `${room.name} — قريبًا` : room.name;
          showTip(e.clientX, e.clientY, hint);
        } else hideTip();
      }
    });

    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (pointers.size === 0) {
        const target = pressed;
        pressed = null;
        dragStart = null;
        stage.classList.remove('is-dragging');
        // With pointer capture on the stage the browser's click lands on the
        // stage, not the polygon, so activation happens here on pointerup.
        if (!dragged && target && e.type === 'pointerup') activate(target, e);
        if (dragged) setTimeout(() => { dragged = false; }, 0);
      }
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('pointerleave', () => { if (pointers.size === 0) hideTip(); });

    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAround({ x: e.clientX - rect.left, y: e.clientY - rect.top }, factor, false);
    }, { passive: false });

    const activate = (path, e) => {
      if (dragged) return;
      const room = roomsById.get(path.dataset.id);
      if (!room || room.status === 'info') return;
      if (room.status === 'soon') {
        const x = e.clientX || (path.getBoundingClientRect().left + path.getBoundingClientRect().width / 2);
        const y = e.clientY || path.getBoundingClientRect().top;
        showTip(x, y, `${room.name} — قريبًا`, 1600);
        return;
      }
      hideTip();
      opts.onRoomOpen && opts.onRoomOpen(room.id);
    };

    roomsLayer.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const path = e.target.closest('.room');
      if (!path) return;
      e.preventDefault();
      activate(path, e);
    });
  }

  function roomFromEvent(e) {
    const el = e.target.closest ? e.target.closest('.room') : null;
    return el ? roomsById.get(el.dataset.id) : null;
  }

  function mid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  return {
    setScene,
    getScene: () => scene,
    setProposed,
    isProposed: () => proposed,
    zoomToRoom,
    resetZoom,
    highlight,
    relayout,
    zoomIn: () => zoomAround({ x: stageW / 2, y: stageH / 2 }, 1.5, true),
    zoomOut: () => zoomAround({ x: stageW / 2, y: stageH / 2 }, 1 / 1.5, true),
    fit: () => resetZoom(true),
    getState: () => ({ mode, zoomedRoom, transform: { ...current }, scene, proposed }),
    setTransform: (t, animate = false) => {
      mode = 'free';
      zoomedRoom = null;
      apply(clamp(t), animate);
      if (current.scale <= MIN_SCALE + 1e-6) mode = 'fit';
    },
    async animateTo(state) {
      if (!state || state.mode === 'fit') return resetZoom(true);
      if (state.mode === 'room' && state.zoomedRoom) return zoomToRoom(state.zoomedRoom, { animate: true });
      mode = 'free';
      zoomedRoom = null;
      apply(clamp(state.transform), true);
      await waitTransition();
    },
    hideTip,
    element: world,
  };
}
