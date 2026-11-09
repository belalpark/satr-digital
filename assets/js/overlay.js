// Screen-space overlay on top of the plan / live 3D model: one blinking dot per room (semi-transparent
// white; a click opens the room details), the room's name above it, and an optional "labels outside"
// mode that places every name in a column at the edge of the stage with a leader line to its dot.
const SVG_NS = 'http://www.w3.org/2000/svg';

export function createOverlay(stage, twin, data, opts = {}) {
  const svg = stage.querySelector('#overlay-svg') || stage.querySelector('.overlay-svg');
  const dotsEl = stage.querySelector('#overlay-dots') || stage.querySelector('.overlay-dots');
  const rooms = data.rooms.filter((r) => r.status !== 'info' && r.hasModel !== false); // list-only spaces have no dot
  const items = new Map();
  let outside = false;
  let focusId = null;
  let hidden = false;

  for (const room of rooms) {
    const wrap = document.createElement('div');
    wrap.className = 'room-marker';
    wrap.dataset.id = room.id;

    // one dot per room (owner, 2026-11-10): it opens the room details; a click on the room itself
    // still opens its close-up view
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'dot dot-room';
    dot.setAttribute('aria-label', `${room.name} — تفاصيل الغرفة`);
    dot.addEventListener('click', (e) => { e.stopPropagation(); opts.onPhotos && opts.onPhotos(room.id); });
    wrap.append(dot);

    const label = document.createElement('span');
    label.className = 'room-tag';
    label.textContent = room.name;
    // names instead of codes (owner, 2026-11-10): offices show «مكتب» at the whole-plan view too; only the
    // small service rooms in the core wait for a closer zoom, where their names fit
    if (room.kind === 'service') label.classList.add('is-minor');
    wrap.append(label);
    dotsEl.append(wrap);

    const leader = document.createElementNS(SVG_NS, 'path');
    leader.setAttribute('class', 'leader');
    svg.append(leader);
    const outLabel = document.createElement('span');
    outLabel.className = 'room-tag is-outside';
    outLabel.textContent = room.name;
    outLabel.hidden = true;
    outLabel.tabIndex = 0;
    outLabel.setAttribute('role', 'button');
    outLabel.addEventListener('click', () => opts.onModel && opts.onModel(room.id));
    outLabel.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onModel && opts.onModel(room.id); } });
    dotsEl.append(outLabel);

    items.set(room.id, { room, wrap, label, outLabel, leader });
  }

  // runs every animation frame while the plan moves: only touch the DOM where a value actually
  // changed (each needless style write costs a style recalc of the label, and on a phone that adds up)
  let lastBox = '';
  const setDisplay = (node, v) => { if (node.style.display !== v) node.style.display = v; };
  const setHidden = (node, v) => { if (node.hidden !== v) node.hidden = v; };
  const clearLeader = (it) => { if (it.leaderOn) { it.leader.setAttribute('d', ''); it.leaderOn = false; } };
  function layout() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const box = `0 0 ${w} ${h}`;
    if (box !== lastBox) { svg.setAttribute('viewBox', box); lastBox = box; }
    const placed = [];
    const zoomNow = (twin.planPixelSize ? twin.planPixelSize() : 0) / Math.max(1, Math.max(w, h));
    const closeNow = zoomNow > 1.6;
    stage.classList.toggle('is-close', closeNow);
    // overlay focus follows the model's own state (never stale after a route race)
    focusId = twin.getFocus ? twin.getFocus() : focusId;
    for (const it of items.values()) {
      const a = twin.anchorFor(it.room.id);
      if (!a || !a.visible || hidden) { setDisplay(it.wrap, 'none'); setHidden(it.outLabel, true); clearLeader(it); continue; }
      const on = a.x > -40 && a.x < w + 40 && a.y > -40 && a.y < h + 40;
      setDisplay(it.wrap, on ? '' : 'none');
      if (on) it.wrap.style.transform = `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px)`;
      const dim = focusId && it.room.id !== focusId;
      it.wrap.classList.toggle('is-dim', !!dim);
      it.wrap.classList.toggle('is-focus', it.room.id === focusId);
      // depth-based scale so far dots look smaller; clamp to keep them tappable
      const s = Math.min(1, Math.max(0.72, 0.55 + 0.45 * Math.min(1.5, zoomNow / 1.6)));
      const sv = s.toFixed(3);
      if (it.s !== sv) { it.wrap.style.setProperty('--s', sv); it.s = sv; }
      // labels: major rooms always; minor rooms only when the camera is close (large on-screen plan)
      const close = closeNow;
      setHidden(it.label, outside || (it.label.classList.contains('is-minor') && !close && it.room.id !== focusId));
      placed.push({ it, a, on });
    }
    // outside labels: sort by screen y, lay out in two columns (right for right half, left for left half)
    for (const { it } of placed) { setHidden(it.outLabel, true); clearLeader(it); }
    if (!outside || hidden) return;
    const cols = { left: [], right: [] };
    for (const p of placed) {
      if (!p.on || (focusId && p.it.room.id !== focusId)) continue;
      (p.a.x < w / 2 ? cols.left : cols.right).push(p);
    }
    const rowH = 24;
    for (const [side, list] of Object.entries(cols)) {
      list.sort((p, q) => p.a.y - q.a.y);
      const total = list.length * rowH;
      let y = Math.max(rowH, Math.min(h - total, (list.reduce((s, p) => s + p.a.y, 0) / Math.max(1, list.length)) - total / 2));
      for (const p of list) {
        const x = side === 'left' ? 12 : w - 12;
        p.it.outLabel.hidden = false;
        p.it.outLabel.style.left = `${x}px`;
        p.it.outLabel.style.top = `${y}px`;
        p.it.outLabel.classList.toggle('is-left', side === 'left');
        if (!p.it.outWidth) p.it.outWidth = p.it.outLabel.offsetWidth; // measured once: text never changes
        const lx = side === 'left' ? x + p.it.outWidth + 6 : x - p.it.outWidth - 6;
        const mx = (lx + p.a.x) / 2;
        p.it.leader.setAttribute('d', `M${lx} ${y}C${mx} ${y},${mx} ${p.a.y},${p.a.x} ${p.a.y}`);
        p.it.leaderOn = true;
        y += rowH;
      }
    }
  }

  const off = twin.onFrame(layout);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(layout).observe(stage);

  return {
    layout,
    setOutside(on) { outside = !!on; stage.classList.toggle('labels-outside', outside); layout(); },
    isOutside: () => outside,
    setFocus(id) { focusId = id || null; layout(); },
    setHidden(on) { hidden = !!on; layout(); },
    dispose: off,
  };
}
