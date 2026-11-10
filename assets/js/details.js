// Room details: photos | the room in the 3D model | features. Three columns on
// desktop, the 3D view on top with two tabs on mobile. The centre image is the
// evening Cycles render of the room when one exists, otherwise a snapshot of
// the live model taken when the room was focused.
import { seatsLabel } from './format.js';
import { setThumb } from './media.js';

export function createDetails(view, data, { onOpenPhoto, snapshot } = {}) {
  const el = {
    title: view.querySelector('#details-title'),
    photos: view.querySelector('#details-photos'),
    features: view.querySelector('#details-features'),
    stage: view.querySelector('#details-stage'),
    tabs: [...view.querySelectorAll('.details-tabs .tab')],
  };
  // a soft, blurred copy of the picture fills the stage behind it, so a landscape Cycles
  // render can be shown whole (letterboxed) inside the tall desktop column
  const bg = document.createElement('img');
  bg.className = 'details-render-bg';
  bg.alt = '';
  bg.decoding = 'async';
  bg.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.className = 'details-render';
  img.alt = '';
  img.decoding = 'async';
  el.stage.append(bg, img);
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
      cards.push(card('السعة حسب الفرش الحالي', [
        text('p', 'big', seatsLabel(room.capacity.seats)),
        text('p', 'basis', room.capacity.basis),
      ]));
    }
    if (room.fixtures && room.fixtures.items.length) {
      const ul = document.createElement('ul');
      for (const item of room.fixtures.items) ul.append(text('li', '', item));
      cards.push(card('التجهيزات', [ul, text('p', 'source', `المصدر: ${room.fixtures.source}`)]));
    }
    if (room.use && room.use.current) {
      const cur = document.createElement('div');
      cur.className = 'use-item is-current';
      cur.append(text('span', 'tag', 'الاستخدام الحالي'), text('span', '', room.use.current));
      cards.push(card('الاستخدام', [cur]));
    }
    cards.push(card('النموذج الرقمي', [text('p', '', 'الفرش في النموذج ثلاثي الأبعاد يحاكي التوزيع والمواد الظاهرة في الصور الميدانية ومخطط الفرش المعتمد.')]));
    if (!cards.length) cards.push(card('المميزات', [text('p', 'basis', 'تفاصيل هذه الغرفة تُوثَّق في الجولة القادمة.')]));
    el.features.replaceChildren(...cards);
  }

  function renderPhotos(room) {
    if (!room.hasPhotos) {
      el.photos.replaceChildren(text('p', 'basis', 'لا توجد صور حقيقية لهذه الغرفة بعد.'));
      return;
    }
    el.photos.replaceChildren(
      ...room.photos.map((p, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', `افتح الصورة: ${p.caption}`);
        const im = document.createElement('img');
        setThumb(im, p.thumb);
        im.alt = p.caption;
        im.loading = 'lazy';
        b.append(im);
        b.addEventListener('click', () => onOpenPhoto && onOpenPhoto(room.id, i));
        return b;
      }),
    );
  }

  const caption = view.querySelector('.details-plan-caption');
  function refreshImage() {
    const room = data.rooms.find((r) => r.id === roomId);
    if (!room) return;
    // a rendered close perspective of the room (Cycles) when one exists, else the pre-rendered
    // focus crop, else a snapshot of whichever plan view is showing
    const render = room.render && room.render.image;
    const shot = render || (room.focus && room.focus.image ? room.focus.image : (snapshot ? snapshot() : ''));
    if (shot) img.src = shot;
    img.hidden = !shot;
    // the whole render is shown (contain) over its blurred copy; snapshots keep filling the stage
    el.stage.classList.toggle('is-render', !!render);
    if (render) bg.src = render;
    bg.hidden = !render;
    // a space with no room of its own in the model (the corridors) shows the whole office in the model
    const whole = !!render && room.render.scope === 'office';
    if (render) img.alt = whole ? 'المكتب كاملًا في النموذج ثلاثي الأبعاد' : `لقطة من النموذج ثلاثي الأبعاد: ${room.name}`;
    else img.alt = '';
    if (caption) caption.textContent = whole ? 'المكتب كاملًا في النموذج ثلاثي الأبعاد' : render ? 'لقطة من النموذج ثلاثي الأبعاد للغرفة بفرشها' : 'الغرفة وما حولها في المخطط';
  }

  function show(id, { deferImage = false } = {}) {
    const room = data.rooms.find((r) => r.id === id);
    if (!room) return false;
    roomId = id;
    el.title.textContent = `تفاصيل: ${room.name}`;
    renderPhotos(room);
    renderFeatures(room);
    setTab('photos');
    if (deferImage) { img.hidden = true; } else refreshImage();
    return true;
  }

  return { show, refreshImage, currentRoom: () => roomId };
}
