// 3D dollhouse plan: the Blender render of the office (tools/twin) with an SVG
// overlay. Room outlines, labels and routes are stored in plan coordinates
// (data/office.json) and projected onto the render through the camera's
// floor / wall-top homographies, so the overlay always matches the image.
//
// "Focus" is the second shot: the camera frames a ready room at the focus
// frame (60% of the full view by default), a sharper render of exactly that
// crop fades in, and every other room is dimmed.
import { bboxOf, zoomTransform, pointsAttr, pathData, applyHomography, projectPoints, convexHull } from './geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const PHONE_MAX = 720;

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function svgText(x, y, text, className) {
  const t = svgEl('text', { x: +x.toFixed(1), y: +y.toFixed(1) });
  t.setAttribute('class', className);
  t.textContent = text;
  return t;
}

/**
 * @param {HTMLElement} stage   container (position: relative/absolute, overflow hidden)
 * @param {object} data         office.json
 * @param {object} opts
 *   onRoomOpen(roomId)         a ready room was activated
 *   tip                        shared tooltip element
 *   static                     true = non-interactive (details panel)
 */
export function createPlan(stage, data, opts = {}) {
  const P = data.office.plan;
  const planW = P.width;
  const planH = P.height;
  const rooms = data.rooms;
  const roomsById = new Map(rooms.map((r) => [r.id, r]));
  const isStatic = !!opts.static;

  // ---------- projected geometry ----------
  const geo = new Map();
  for (const r of rooms) {
    const floor = projectPoints(P.homography.floor, r.polygon);
    const top = projectPoints(P.homography.top, r.polygon);
    geo.set(r.id, {
      floor,
      hull: convexHull([...floor, ...top]),
      box: bboxOf(floor, top),
      label: applyHomography(P.homography.floor, [r.label.x, r.label.y]),
    });
  }

  // ---------- DOM ----------
  const world = document.createElement('div');
  world.className = 'plan-world';
  const img = document.createElement('img');
  img.className = 'plan-image';
  img.src = P.image;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  world.append(img);

  const shots = new Map();
  for (const r of rooms) {
    if (!r.focus) continue;
    const s = document.createElement('img');
    s.className = 'focus-shot';
    s.alt = '';
    s.decoding = 'async';
    s.draggable = false;
    s.dataset.id = r.id;
    const [x, y, w, h] = r.focus.rect;
    Object.assign(s.style, {
      left: `${(x / planW) * 100}%`, top: `${(y / planH) * 100}%`,
      width: `${(w / planW) * 100}%`, height: `${(h / planH) * 100}%`,
    });
    s.addEventListener('load', () => s.classList.add('is-loaded'));
    shots.set(r.id, s);
    world.append(s);
  }

  const svg = svgEl('svg', { viewBox: `0 0 ${planW} ${planH}`, preserveAspectRatio: 'none' });
  svg.classList.add('plan-svg');
  const maskLayer = svgEl('g', { class: 'layer-mask' });
  const roomsLayer = svgEl('g', { class: 'layer-rooms' });
  const routesLayer = svgEl('g', { class: 'layer-routes' });
  const labelsLayer = svgEl('g', { class: 'layer-labels' });
  svg.append(maskLayer, roomsLayer, routesLayer, labelsLayer);
  world.append(svg);
  stage.append(world);

  const mask = svgEl('path', { class: 'focus-mask', 'fill-rule': 'evenodd', d: '' });
  const focusGlow = svgEl('path', { class: 'focus-glow', d: '' });
  const focusRing = svgEl('path', { class: 'focus-ring', d: '' });
  maskLayer.append(mask, focusGlow, focusRing);

  const polys = new Map();
  const labels = new Map();
  for (const room of rooms) {
    const g = geo.get(room.id);
    const poly = svgEl('polygon', { points: pointsAttr(g.floor), 'data-id': room.id });
    poly.setAttribute('class', `room is-${room.status}`);
    if (!isStatic && room.status === 'ready') {
      // only openable rooms are tab stops; "soon" rooms stay reachable by pointer (tooltip)
      poly.setAttribute('role', 'button');
      poly.setAttribute('tabindex', '0');
      poly.setAttribute('aria-label', `${room.name} — اعرض الغرفة`);
    } else if (!isStatic && room.status === 'soon') {
      poly.setAttribute('aria-label', `${room.name} — قريبًا`);
    }
    const title = svgEl('title');
    title.textContent = room.name;
    poly.append(title);
    roomsLayer.append(poly);
    polys.set(room.id, poly);

    const [lx, ly] = g.label;
    const label = svgEl('g', { class: 'room-label' });
    if (room.status === 'ready') {
      label.classList.add('is-ready');
      // drawn at the label point and lifted by CSS so it keeps its on-screen size and gap
      const mark = svgEl('g', { class: 'ready-mark' });
      mark.append(svgEl('circle', { class: 'ready-pulse', cx: lx.toFixed(1), cy: ly.toFixed(1), r: 13 }));
      mark.append(svgEl('circle', { class: 'ready-dot', cx: lx.toFixed(1), cy: ly.toFixed(1), r: 9 }));
      label.append(mark);
    }
    if (room.kind === 'office' || room.kind === 'service') label.classList.add('is-minor');
    if (room.status === 'info') label.classList.add('is-info');
    label.append(svgText(lx, ly, room.short || room.name, 'label-text'));
    labelsLayer.append(label);
    labels.set(room.id, label);
  }

  // ---------- routes (paths scene) ----------
  const routes = new Map();
  const pathsScene = data.scenes && data.scenes.paths;
  if (pathsScene) {
    const startLabels = new Set();
    for (const route of pathsScene.routes) {
      const pts = projectPoints(P.homography.floor, route.points);
      const g = svgEl('g', { class: 'route', 'data-route': route.id });
      g.style.setProperty('--route', route.color);
      g.append(svgEl('polyline', { class: 'route-glow', points: pointsAttr(pts) }));
      g.append(svgEl('polyline', { class: 'route-line', points: pointsAttr(pts) }));
      route.stops.forEach((stop, i) => {
        const [sx, sy] = applyHomography(P.homography.floor, stop.at);
        if (i === 0) {
          if (startLabels.has(stop.label)) return;
          startLabels.add(stop.label);
          const s = svgEl('g', { class: 'route-start' });
          s.append(svgEl('circle', { cx: sx.toFixed(1), cy: sy.toFixed(1), r: 16 }));
          s.append(svgText(sx, sy + 48, stop.label, 'stop-name'));
          routesLayer.append(s);
          return;
        }
        const s = svgEl('g', { class: 'route-stop' });
        s.append(svgEl('circle', { cx: sx.toFixed(1), cy: sy.toFixed(1), r: 15 }));
        s.append(svgText(sx, sy - 30, stop.label, 'stop-name'));
        g.append(s);
      });
      routesLayer.prepend(g);
      routes.set(route.id, g);
    }
  }

  // ---------- view state ----------
  let stageW = 0;
  let stageH = 0;
  let fitScale = 1;
  let current = { scale: 1, tx: 0, ty: 0 };
  let mode = 'fit'; // 'fit' | 'focus' | 'free'
  let focusId = null;
  let scene = 'current';

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
    // SVG units per CSS pixel at this zoom: labels keep a constant on-screen size
    svg.style.setProperty('--px', (1 / (t.scale * fitScale)).toFixed(4));
    // small rooms' labels only once the plan is large enough to read them
    svg.classList.toggle('is-zoomed', t.scale * fitScale >= 0.62 || isStatic);
  }

  function waitTransition(ms = 900) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (e) => {
        // transitionend bubbles: ignore the overlay's own transitions
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

  /** Second shot: the focus frame (desktop) or a tighter frame around the room (phones). */
  function focusTransform(roomId) {
    const room = roomsById.get(roomId);
    const g = geo.get(roomId);
    // keep the room clear of overlays at the bottom of the stage (phone bottom sheet)
    const inset = opts.focusInset ? opts.focusInset() : 0;
    const viewport = { w: stageW, h: Math.max(stageH - inset, stageH * 0.3) };
    const frame = room.focus
      ? { x: room.focus.rect[0], y: room.focus.rect[1], w: room.focus.rect[2], h: room.focus.rect[3] }
      : (() => {
        const k = P.focusFrame || 0.6;
        const cx = g.box.x + g.box.w / 2;
        const cy = g.box.y + g.box.h / 2;
        const w = planW * k;
        const h = planH * k;
        return { x: Math.min(Math.max(cx - w / 2, 0), planW - w), y: Math.min(Math.max(cy - h / 2, 0), planH - h), w, h };
      })();
    // details panel: the room with a ring of its neighbours, whatever the column width
    if (isStatic) return clamp(zoomTransform(g.box, viewport, { fitScale, padding: 0.22, maxScale: MAX_SCALE }));
    const byFrame = zoomTransform(frame, viewport, { fitScale, padding: 0, maxScale: MAX_SCALE });
    if (stageW > PHONE_MAX) return clamp(byFrame);
    const byRoom = zoomTransform(g.box, viewport, { fitScale, padding: 0.1, maxScale: MAX_SCALE });
    return clamp(byRoom.scale > byFrame.scale ? byRoom : byFrame);
  }

  function setMask(roomId) {
    if (!roomId) {
      mask.setAttribute('d', '');
      focusGlow.setAttribute('d', '');
      focusRing.setAttribute('d', '');
      svg.classList.remove('is-focus');
      return;
    }
    const hull = geo.get(roomId).hull;
    mask.setAttribute('d', `M0 0H${planW}V${planH}H0Z${pathData(hull)}`);
    focusRing.setAttribute('d', pathData(hull));
    focusGlow.setAttribute('d', pathData(hull));
    svg.classList.add('is-focus');
  }

  function showShot(roomId) {
    for (const [id, s] of shots) {
      const on = id === roomId;
      if (on && !s.src) s.src = roomsById.get(id).focus.image;
      s.classList.toggle('is-visible', on);
    }
  }

  function highlight(roomId) {
    for (const [id, poly] of polys) {
      poly.classList.toggle('is-highlight', id === roomId);
      // the focused room is not a tab stop (activating it does nothing)
      if (poly.hasAttribute('tabindex')) poly.setAttribute('tabindex', id === roomId ? '-1' : '0');
      labels.get(id).classList.toggle('is-current', id === roomId);
      labels.get(id).classList.toggle('is-dim', !!roomId && id !== roomId);
    }
  }

  async function focusRoom(roomId, { animate = true } = {}) {
    if (!roomsById.has(roomId)) return;
    focusId = roomId;
    mode = 'focus';
    hideTip();
    highlight(roomId);
    setMask(roomId);
    apply(focusTransform(roomId), animate);
    if (animate) await waitTransition();
    if (focusId === roomId) showShot(roomId);
  }

  async function unfocus({ animate = true, to = null } = {}) {
    focusId = null;
    showShot(null);
    highlight(null);
    setMask(null);
    if (to && to.mode === 'free' && to.transform) {
      mode = 'free';
      apply(clamp(to.transform), animate);
      if (current.scale <= MIN_SCALE + 1e-6) mode = 'fit';
    } else {
      mode = 'fit';
      apply(fitTransform(), animate);
    }
    if (animate) await waitTransition();
  }

  async function resetZoom(animate = true) {
    if (focusId) return unfocus({ animate });
    mode = 'fit';
    apply(fitTransform(), animate);
    if (animate) await waitTransition();
  }

  function zoomAround(point, factor, animate = false) {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
    const k = scale / current.scale;
    const t = clamp({ scale, tx: point.x - (point.x - current.tx) * k, ty: point.y - (point.y - current.ty) * k });
    if (focusId) {
      apply(t, animate); // free look around the focused room; the focus stays
      return;
    }
    mode = scale <= MIN_SCALE + 1e-6 ? 'fit' : 'free';
    apply(mode === 'fit' ? fitTransform() : t, animate);
  }

  function relayout() {
    measure();
    if (mode === 'focus' && focusId) apply(focusTransform(focusId), false);
    else if (mode === 'fit') apply(fitTransform(), false);
    else apply(clamp(current), false);
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => relayout()).observe(stage);
  } else {
    window.addEventListener('resize', relayout);
  }
  relayout();

  // Warm the cache for the focus renders once the plan itself is on screen.
  if (!isStatic) {
    const prefetch = () => setTimeout(() => {
      for (const [id] of shots) {
        const pre = new Image();
        pre.src = roomsById.get(id).focus.image;
      }
    }, 1200);
    if (img.complete) prefetch();
    else img.addEventListener('load', prefetch, { once: true });
  }

  // ---------- scenes ----------
  function setScene(id) {
    scene = id === 'paths' && pathsScene ? 'paths' : 'current';
    svg.classList.toggle('scene-paths', scene === 'paths');
  }

  function setRouteVisible(id, visible) {
    const g = routes.get(id);
    if (g) g.classList.toggle('is-hidden', !visible);
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
        const factor = Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist;
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStart.scale * factor));
        const k = scale / pinchStart.scale;
        const rect = stage.getBoundingClientRect();
        const m0 = { x: pinchStart.mid.x - rect.left, y: pinchStart.mid.y - rect.top };
        const m1 = mid(a, b);
        if (!focusId) mode = 'free';
        dragged = true;
        apply(clamp({ scale, tx: m1.x - rect.left - (m0.x - pinchStart.tx) * k, ty: m1.y - rect.top - (m0.y - pinchStart.ty) * k }), false);
        return;
      }
      if (pointers.size === 1 && dragStart && pointers.has(e.pointerId)) {
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        if (!dragged && Math.hypot(dx, dy) < 6) return;
        dragged = true; // moved too far to count as a tap, even when there is nothing to pan
        if (current.scale <= MIN_SCALE + 1e-6) return;
        stage.classList.add('is-dragging');
        if (!focusId) mode = 'free';
        apply(clamp({ scale: current.scale, tx: dragStart.tx + dx, ty: dragStart.ty + dy }), false);
        return;
      }
      if (pointers.size === 0 && e.pointerType === 'mouse') {
        const room = roomFromEvent(e);
        if (room && room.id !== focusId) {
          const hint = room.status === 'ready' ? `${room.name} — انقر لعرضها` : room.status === 'soon' ? `${room.name} — قريبًا` : room.name;
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
      zoomAround({ x: e.clientX - rect.left, y: e.clientY - rect.top }, Math.exp(-e.deltaY * 0.0015), false);
    }, { passive: false });

    const activate = (poly, e) => {
      if (dragged) return;
      const room = roomsById.get(poly.dataset.id);
      if (!room || room.status === 'info' || room.id === focusId) return;
      if (room.status === 'soon') {
        const box = poly.getBoundingClientRect();
        showTip(e.clientX || box.left + box.width / 2, e.clientY || box.top, `${room.name} — قريبًا`, 1600);
        return;
      }
      hideTip();
      if (opts.onRoomOpen) opts.onRoomOpen(room.id);
    };

    roomsLayer.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const poly = e.target.closest('.room');
      if (!poly) return;
      e.preventDefault();
      activate(poly, e);
    });
  }

  function roomFromEvent(e) {
    const el = e.target.closest ? e.target.closest('.room') : null;
    return el ? roomsById.get(el.dataset.id) : null;
  }

  function mid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  return {
    setScene,
    getScene: () => scene,
    setRouteVisible,
    focusRoom,
    unfocus,
    getFocus: () => focusId,
    resetZoom,
    highlight,
    relayout,
    zoomIn: () => zoomAround({ x: stageW / 2, y: stageH / 2 }, 1.5, true),
    zoomOut: () => zoomAround({ x: stageW / 2, y: stageH / 2 }, 1 / 1.5, true),
    fit: () => resetZoom(true),
    getState: () => ({ mode, focus: focusId, transform: { ...current }, scene }),
    hideTip,
    roomBox: (id) => (geo.has(id) ? { ...geo.get(id).box } : null),
    element: world,
  };
}

