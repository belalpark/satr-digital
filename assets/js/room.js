// Room view: the real photos of one room with a thumbnail strip, keyboard and
// swipe navigation, and the summary/capacity chips.
import { seatsLabel } from './format.js';
import { setThumb, thumbSrc, progressive } from './media.js';

export function createRoom(view, data) {
  const el = {
    title: view.querySelector('#room-title'),
    photo: view.querySelector('#room-photo'),
    backdrop: view.querySelector('#room-backdrop'),
    thumbs: view.querySelector('#gallery-thumbs'),
    caption: view.querySelector('#gallery-caption'),
    summary: view.querySelector('#room-summary'),
    capacity: view.querySelector('#room-capacity'),
    pano: view.querySelector('#btn-pano'),
    prev: view.querySelector('#gallery-prev'),
    next: view.querySelector('#gallery-next'),
    stage: view.querySelector('#room-stage'),
  };

  let room = null;
  let index = 0;

  function select(i, { preloadNeighbours = true } = {}) {
    if (!room || !room.photos.length) return; // rooms without photos are shown via details/3D only
    const n = room.photos.length;
    index = ((i % n) + n) % n;
    const photo = room.photos[index];
    el.photo.classList.remove('is-loaded');
    el.photo.alt = `${room.name} — ${photo.caption}`;
    // the small copy is on screen at once (from memory); the sharp photo replaces it when it has arrived
    el.photo.classList.add('is-soft');
    progressive(el.photo, photo.thumb, photo.src, { onSharp: () => el.photo.classList.remove('is-soft') });
    el.backdrop.style.backgroundImage = `url("${thumbSrc(photo.thumb)}")`;
    el.caption.textContent = photo.caption;
    for (const b of el.thumbs.children) {
      const active = Number(b.dataset.index) === index;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
      if (active) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
    if (preloadNeighbours) {
      for (const j of [index + 1, index - 1]) {
        const p = room.photos[((j % n) + n) % n];
        const pre = new Image();
        pre.src = p.src;
      }
    }
  }

  el.photo.addEventListener('load', () => el.photo.classList.add('is-loaded'));

  function show(roomId, { photoIndex = 0 } = {}) {
    room = data.rooms.find((r) => r.id === roomId);
    if (!room) return false;
    el.title.textContent = room.name;
    el.summary.textContent = room.summary || '';
    el.capacity.textContent = room.capacity ? `السعة: ${seatsLabel(room.capacity.seats)}` : '';
    el.capacity.hidden = !room.capacity;
    el.pano.hidden = !room.pano;
    const photos = room.photos || [];
    if (!photos.length) {
      // empty set (e.g. a details deep link for a room that has no real photos yet)
      index = 0;
      el.photo.dataset.ticket = String((Number(el.photo.dataset.ticket) || 0) + 1); // drop a swap still on its way
      delete el.photo.dataset.thumb;
      delete el.photo.dataset.sharp;
      el.photo.removeAttribute('src');
      el.photo.alt = '';
      el.photo.classList.remove('is-loaded');
      el.backdrop.style.backgroundImage = '';
      el.caption.textContent = 'لا توجد صور حقيقية لهذه الغرفة بعد.';
      el.thumbs.replaceChildren();
      return true;
    }
    el.thumbs.replaceChildren(
      ...photos.map((p, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'thumb';
        b.dataset.index = String(i);
        b.setAttribute('role', 'option');
        b.setAttribute('aria-label', p.caption);
        const im = document.createElement('img');
        setThumb(im, p.thumb);
        im.alt = '';
        im.loading = 'lazy';
        b.append(im);
        b.addEventListener('click', () => select(i));
        return b;
      }),
    );
    select(photoIndex, { preloadNeighbours: true });
    return true;
  }

  el.prev.addEventListener('click', () => select(index - 1));
  el.next.addEventListener('click', () => select(index + 1));

  // Keyboard: in RTL "previous" is to the right.
  document.addEventListener('keydown', (e) => {
    if (!view.classList.contains('is-active')) return;
    if (e.key === 'ArrowRight') select(index - 1);
    if (e.key === 'ArrowLeft') select(index + 1);
  });

  // Swipe
  let swipe = null;
  el.stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    swipe = { x: e.clientX, y: e.clientY };
  });
  el.stage.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) select(dx < 0 ? index + 1 : index - 1);
  });
  el.stage.addEventListener('pointercancel', () => { swipe = null; });

  return { show, select, currentIndex: () => index, currentRoom: () => room };
}
