// 2D office plan («مخطط المكتب»): the first-version top-down plan render with
// an SVG overlay (room hit areas, focus dimming, the three routes) and free
// pan / zoom. It exposes the same small interface as the live 3D viewer
// (twin3d.js) — anchorFor, planPixelSize, focusRoom, roomAt, onFrame, … — so
// the dots/labels overlay and the page logic drive both views the same way.
import { bbox, pointInPolygon, pathLength, pointsAttr } from './geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_SCALE = 1;
const MAX_SCALE = 7;

function svgEl(name, attrs = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

export function createPlan2D(container, data, opts = {}) {
  const P = data.office.plan2d;
  const ref = data.office.plan.reference; // plan px grid of office.json (1309 x 1201)
  const planW = ref.width;
  const planH = ref.height;
  const rooms = data.rooms.filter((r) => r.polygon);
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- DOM ----------
  const world = document.createElement('div');
  world.className = 'plan2d-world';
  const img = document.createElement('img');
  img.className = 'plan2d-image';
  img.src = P.image;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  const svg = svgEl('svg', { class: 'plan2d-svg', viewBox: `0 0 ${planW} ${planH}`, preserveAspectRatio: 'none' });
  world.append(img, svg);
  container.prepend(world);

  // dimming veil (everything but the focused room), drawn with an even-odd hole
  const veil = svgEl('path', { class: 'plan2d-veil', 'fill-rule': 'evenodd' });
  veil.style.display = 'none';
  svg.append(veil);

  // routes: outline + coloured dashed line per route, hidden until the paths scene
  const routeGroup = svgEl('g', { class: 'plan2d-routes' });
  routeGroup.style.display = 'none';
  const routeEls = new Map();
  if (data.scenes && data.scenes.paths) {
    for (const route of data.scenes.paths.routes) {
      const g = svgEl('g', { class: 'route2d', 'data-route': route.id });
      const pts = pointsAttr(route.points);
      g.append(svgEl('polyline', { class: 'route2d-outline', points: pts }));
      const line = svgEl('polyline', { class: 'route2d-line', points: pts, stroke: route.color });
      line.style.setProperty('--len', pathLength(route.points).toFixed(0));
      g.append(line);
      for (const [i, s] of route.stops.entries()) {
        g.append(svgEl('circle', { class: `route2d-stop${i === 0 ? ' is-start' : ''}`, cx: s.at[0], cy: s.at[1], r: i === 0 ? 7 : 9, stroke: route.color }));
        const t = svgEl('text', { class: 'route2d-label', x: s.at[0], y: s.at[1] - 14 });
        t.textContent = s.label;
        g.append(t);
      }
      routeGroup.append(g);
      routeEls.set(route.id, g);
    }
  }
  svg.append(routeGroup);

  // room hit areas (transparent; highlighted on hover / focus)
  const roomEls = new Map();
  for (const r of rooms) {
    const el = svgEl('polygon', { class: 'room2d', points: pointsAttr(r.polygon), 'data-id': r.id });
    if (r.status !== 'ready' || r.hasModel === false) el.classList.add('is-off');
    svg.append(el);
    roomEls.set(r.id, el);
  }

  // ---------- view transform ----------
  // world is laid out at `fit` px per plan unit (fills the stage), then translate(tx,ty) scale(s)
  let viewW = 1;
  let viewH = 1;
  let fit = 1;
  let userMoved = false; // after a drag / wheel the visitor's own framing is kept on resize
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let focusId = null;
  const listeners = new Set();
  let raf = 0;
  function apply() {
    world.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; for (const fn of listeners) fn(); });
  }
  function clampPan() {
    // keep the plan from leaving the stage: at least a third of it stays visible
    const w = planW * fit * scale;
    const h = planH * fit * scale;
    const minX = Math.min(0, viewW - w) - w * 0.35;
    const maxX = Math.max(0, viewW - w) + w * 0.35;
    const minY = Math.min(0, viewH - h) - h * 0.35;
    const maxY = Math.max(0, viewH - h) + h * 0.35;
    tx = Math.min(maxX, Math.max(minX, tx));
    ty = Math.min(maxY, Math.max(minY, ty));
  }
  function home() {
    scale = 1;
    tx = (viewW - planW * fit) / 2;
    ty = (viewH - planH * fit) / 2;
  }
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    const keep = viewW > 1 ? { cx: (viewW / 2 - tx) / (fit * scale), cy: (viewH / 2 - ty) / (fit * scale) } : null;
    viewW = w;
    viewH = h;
    fit = Math.min(w / planW, h / planH);
    world.style.width = `${planW * fit}px`;
    world.style.height = `${planH * fit}px`;
    const focused = focusId ? rooms.find((x) => x.id === focusId) : null;
    // a flight computed for the old stage size would keep steering toward a frame that no longer
    // fits (the room card opens below the stage right as a focus flight starts): end it and
    // continue toward the frame for the new size
    const wasFlying = !!tween;
    if (wasFlying) cancelTween();
    if (focused && !userMoved) {
      // the stage changed size (e.g. the room card opened below it): re-frame the focused room
      const short = viewH < 420 || viewH < viewW * 0.6;
      const target = boxTarget(bbox(focused.polygon), short ? 0.1 : 0.16);
      if (wasFlying) { animateTo(target, 350); return; }
      ({ scale, tx, ty } = target);
    } else if (keep && scale > 1) {
      tx = viewW / 2 - keep.cx * fit * scale;
      ty = viewH / 2 - keep.cy * fit * scale;
      clampPan();
    } else {
      home();
    }
    apply();
  }

  // ---------- animation (zoom to a box / back home) ----------
  let tween = null;
  let tweenDone = Promise.resolve();
  let tweenResolve = null;
  function cancelTween() {
    if (tween) cancelAnimationFrame(tween);
    tween = null;
    if (tweenResolve) { const r = tweenResolve; tweenResolve = null; r(); }
  }
  function animateTo(target, ms = 700) {
    cancelTween();
    if (reducedMotion || ms <= 0) { ({ scale, tx, ty } = target); apply(); return Promise.resolve(); }
    const from = { scale, tx, ty };
    const t0 = performance.now();
    tweenDone = new Promise((resolve) => {
      tweenResolve = resolve;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / ms);
        const e = 1 - Math.pow(1 - k, 3);
        scale = from.scale + (target.scale - from.scale) * e;
        tx = from.tx + (target.tx - from.tx) * e;
        ty = from.ty + (target.ty - from.ty) * e;
        apply();
        if (k < 1) tween = requestAnimationFrame(step);
        else { tween = null; tweenResolve = null; resolve(); }
      };
      tween = requestAnimationFrame(step);
    });
    return tweenDone;
  }
  function boxTarget(box, padding = 0.18, maxScale = 4.5) {
    const availW = viewW * (1 - padding * 2);
    const availH = viewH * (1 - padding * 2);
    let s = Math.min(availW / (box.w * fit), availH / (box.h * fit));
    s = Math.max(MIN_SCALE, Math.min(maxScale, s));
    const cx = (box.x + box.w / 2) * fit;
    const cy = (box.y + box.h / 2) * fit;
    return { scale: s, tx: viewW / 2 - cx * s, ty: viewH / 2 - cy * s };
  }

  function setVeil(id) {
    const r = rooms.find((x) => x.id === id);
    if (!r) { veil.style.display = 'none'; return; }
    const outer = `M0 0H${planW}V${planH}H0Z`;
    const hole = 'M' + r.polygon.map(([x, y]) => `${x} ${y}`).join('L') + 'Z';
    veil.setAttribute('d', outer + hole);
    veil.style.display = '';
  }

  async function focusRoom(id, { animate = true } = {}) {
    const r = rooms.find((x) => x.id === id);
    if (!r) return;
    focusId = id;
    userMoved = false;
    container.dataset.focus = id;
    for (const [rid, el] of roomEls) el.classList.toggle('is-focus', rid === id);
    setVeil(id);
    const short = viewH < 420 || viewH < viewW * 0.6;
    await animateTo(boxTarget(bbox(r.polygon), short ? 0.1 : 0.16), animate ? 700 : 0);
  }
  async function unfocus({ animate = true } = {}) {
    focusId = null;
    delete container.dataset.focus;
    for (const el of roomEls.values()) el.classList.remove('is-focus');
    veil.style.display = 'none';
    const saved = { scale, tx, ty };
    home();
    const target = { scale, tx, ty };
    ({ scale, tx, ty } = saved);
    await animateTo(target, animate ? 700 : 0);
  }

  // ---------- pointer: drag to pan, wheel / pinch to zoom ----------
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  // the overlay's dots and labels sit inside the stage: a press on them is theirs (capturing the
  // pointer here would retarget their click to the stage and swallow it)
  const onControl = (e) => !!(e.target && e.target.closest && e.target.closest('.room-marker, .room-tag, button, a'));
  container.addEventListener('pointerdown', (e) => {
    if (onControl(e)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale };
      drag = null;
    }
    try { container.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events have no active pointer */ }
  });
  container.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      // like drag and wheel: the gesture takes over from any flight in progress, and the framing is
      // the visitor's from now on (a later resize keeps it instead of re-framing the focused room)
      if (!pinch.live) { pinch.live = true; cancelTween(); userMoved = true; }
      // the midpoint in stage-local coordinates, like the wheel handler: zoomAt() works in the stage's frame
      const r = container.getBoundingClientRect();
      zoomAt(pinch.scale * (d / pinch.d) / scale, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; userMoved = true; cancelTween(); container.classList.add('is-panning'); }
      if (drag.moved) { tx = drag.tx + dx; ty = drag.ty + dy; clampPan(); apply(); }
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { drag = null; container.classList.remove('is-panning'); }
  };
  container.addEventListener('pointerup', endPointer);
  container.addEventListener('pointercancel', endPointer);
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    userMoved = true;
    cancelTween();
    const r = container.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  function zoomAt(factor, px, py) {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    const k = next / scale;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    scale = next;
    clampPan();
    apply();
  }

  // ---------- geometry helpers for the overlay / page ----------
  function project(x, y) {
    return { x: tx + x * fit * scale, y: ty + y * fit * scale, depth: 0, visible: true };
  }
  function anchorFor(id) {
    const r = rooms.find((x) => x.id === id);
    if (!r) return null;
    return project(r.label.x, r.label.y);
  }
  function roomAt(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    const x = (clientX - rect.left - tx) / (fit * scale);
    const y = (clientY - rect.top - ty) / (fit * scale);
    for (const r of rooms) if (pointInPolygon([x, y], r.polygon)) return r.id;
    return null;
  }
  function roomScreenBox(id) {
    const r = rooms.find((x) => x.id === id);
    if (!r) return null;
    const b = bbox(r.polygon);
    const a = project(b.x, b.y);
    const c = project(b.x + b.w, b.y + b.h);
    return { x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y };
  }

  // ---------- details snapshot: the plan around the focused room ----------
  function snapshot(quality = 0.86) {
    const r = rooms.find((x) => x.id === focusId);
    const nat = img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null;
    if (!nat) return '';
    const kx = nat.w / planW;
    const ky = nat.h / planH;
    let box = r ? bbox(r.polygon) : { x: 0, y: 0, w: planW, h: planH };
    if (r) {
      const pad = Math.max(box.w, box.h) * 0.6;
      box = { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
    }
    const ar = 4 / 3;
    if (box.w / box.h < ar) { const w = box.h * ar; box.x -= (w - box.w) / 2; box.w = w; } else { const h = box.w / ar; box.y -= (h - box.h) / 2; box.h = h; }
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 900;
    const g = c.getContext('2d');
    g.fillStyle = '#efe9e1';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, box.x * kx, box.y * ky, box.w * kx, box.h * ky, 0, 0, c.width, c.height);
    if (r) {
      const sx = c.width / box.w;
      const sy = c.height / box.h;
      g.fillStyle = 'rgba(12, 14, 18, 0.42)';
      g.beginPath();
      g.rect(0, 0, c.width, c.height);
      const poly = r.polygon;
      g.moveTo((poly[0][0] - box.x) * sx, (poly[0][1] - box.y) * sy);
      for (let i = poly.length - 1; i >= 0; i--) g.lineTo((poly[i][0] - box.x) * sx, (poly[i][1] - box.y) * sy);
      g.closePath();
      g.fill('evenodd');
      g.strokeStyle = '#5fd3ff';
      g.lineWidth = 4;
      g.beginPath();
      poly.forEach(([x, y], i) => (i ? g.lineTo((x - box.x) * sx, (y - box.y) * sy) : g.moveTo((x - box.x) * sx, (y - box.y) * sy)));
      g.closePath();
      g.stroke();
    }
    try { return c.toDataURL('image/jpeg', quality); } catch { return ''; }
  }

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(container);
  else window.addEventListener('resize', resize);
  resize();
  const ready = img.complete && img.naturalWidth ? Promise.resolve() : new Promise((res) => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); });

  return {
    element: container,
    ready,
    focusRoom,
    unfocus,
    settled: () => (tween ? tweenDone : Promise.resolve()),
    getFocus: () => focusId,
    setActive() {},
    setLighting() {},
    getLighting: () => 'day',
    setRoutesVisible: (on) => { routeGroup.style.display = on ? '' : 'none'; },
    setRouteVisible: (id, on) => { const g = routeEls.get(id); if (g) g.style.display = on ? '' : 'none'; },
    roomAt,
    anchorFor,
    project,
    roomScreenBox,
    planPixelSize: () => Math.max(planW, planH) * fit * scale,
    onFrame: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    requestRender: apply,
    resetView: () => { userMoved = false; return focusId ? focusRoom(focusId) : unfocus(); },
    // the +/− buttons are the visitor's input like the wheel and the pinch: the framing is theirs from
    // now on, so a later resize keeps it instead of re-framing the focused room
    zoom: (factor) => { cancelTween(); userMoved = true; zoomAt(factor, viewW / 2, viewH / 2); },
    stopIdle() {},
    snapshot,
    dispose: () => { world.remove(); },
  };
}
