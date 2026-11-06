// Room details: photos | plan (room highlighted) | features. Three columns on
// desktop, plan on top with two tabs on mobile.
import { createPlan } from './plan.js';
import { seatsLabel } from './format.js';

export function createDetails(view, data, { onOpenPhoto } = {}) {
  const el = {
    title: view.querySelector('#details-title'),
    photos: view.querySelector('#details-photos'),
    features: view.querySelector('#details-features'),
    stage: view.querySelector('#details-stage'),
    tabs: [...view.querySelectorAll('.details-tabs .tab')],
  };

  const plan = createPlan(el.stage, data, { static: true });
  let roomId = null;

  function setTab(name) {
    for (const t of el.tabs) {
      const active = t.dataset.tab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    }
    el.photos.classList.toggle('is-active', name === 'photos');
    el.features.classList.toggle('is-active', name === 'features');
  }
  for (const t of el.tabs) t.addEventListener('click', () => setTab(t.dataset.tab));

  function card(title, body) {
    const c = document.createElement('section');
    c.className = 'card';
    const h = document.createElement('h3');
    h.textContent = title;
    c.append(h, ...body);
    return c;
  }

  function text(tag, cls, value) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    n.textContent = value;
    return n;
  }

  function renderFeatures(room) {
    const cards = [];
    if (room.capacity) {
      cards.push(card('السعة حسب الفرش المقترح', [
        text('p', 'big', seatsLabel(room.capacity.seats)),
        text('p', 'basis', room.capacity.basis),
      ]));
    }
    if (room.fixtures && room.fixtures.items.length) {
      const ul = document.createElement('ul');
      for (const item of room.fixtures.items) ul.append(text('li', '', item));
      cards.push(card('التجهيزات', [ul, text('p', 'source', `المصدر: ${room.fixtures.source}`)]));
    }
    const uses = document.createElement('div');
    uses.className = 'use-row';
    const cur = document.createElement('div');
    cur.className = 'use-item is-current';
    cur.append(text('span', 'tag', 'الوضع الحالي'), text('span', '', room.use.current));
    const pro = document.createElement('div');
    pro.className = 'use-item is-proposed';
    pro.append(text('span', 'tag', 'تصوّر مقترح'), text('span', '', room.use.proposed));
    uses.append(cur, pro);
    cards.push(card('الاستخدام', [uses]));
    el.features.replaceChildren(...cards);
  }

  function renderPhotos(room) {
    el.photos.replaceChildren(
      ...room.photos.map((p, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', `افتح الصورة: ${p.caption}`);
        const im = document.createElement('img');
        im.src = p.thumb;
        im.alt = p.caption;
        im.loading = 'lazy';
        b.append(im);
        b.addEventListener('click', () => onOpenPhoto && onOpenPhoto(room.id, i));
        return b;
      }),
    );
  }

  function show(id) {
    const room = data.rooms.find((r) => r.id === id);
    if (!room) return false;
    roomId = id;
    el.title.textContent = `تفاصيل: ${room.name}`;
    renderPhotos(room);
    renderFeatures(room);
    setTab('photos');
    plan.highlight(id);
    // The stage may have been hidden (display:none) while measuring; relayout
    // after the view is visible.
    requestAnimationFrame(() => {
      plan.relayout();
      plan.zoomToRoom(id, { animate: false });
    });
    return true;
  }

  return { show, plan, currentRoom: () => roomId };
}
