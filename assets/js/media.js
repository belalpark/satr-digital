// Pictures that survive a bad moment on the network.
//
// Measured on the live host (2026-11-10): the security service in front of the site answered the address of a
// photo with its own «checking your browser» page (HTTP 403, `cf-mitigated: challenge`, text/html). An <img>
// cannot show that page, so the visitor saw a broken-picture mark. A visitor's clearance lasts a limited time and
// this site never reloads itself, so pictures opened later in the visit were the ones that failed.
//
// Three defences, all here:
//   1. every small picture travels in ONE file, fetched once on arrival and drawn from memory afterwards;
//   2. a large photo is shown as its small copy first, then swapped for the sharp one when that has arrived;
//   3. when a picture fails, the site asks the host one question; if the answer is the verification page it
//      reloads once (same address, so the visitor lands on the same room) to renew the clearance.
// A failed picture is hidden until it loads: the broken-picture mark is never shown.

const RETRY_WAITS = [700, 1800, 4000];
const RELOAD_EVERY_MS = 3 * 60 * 1000; // never reload by ourselves more often than this
const PACK_GRACE_MS = 1500; // how long a small picture waits for the pack before it is fetched by itself
const thumbs = new Map(); // thumb path → blob: address
let packPromise = null;
let packPending = false;

/** Split the pack: uint32 LE header length, a JSON header {files: [[path, offset, length], …]}, then the bytes. */
export function readPack(buffer) {
  const view = new DataView(buffer);
  const headLen = view.getUint32(0, true);
  if (headLen <= 0 || 4 + headLen > buffer.byteLength) throw new Error('thumb pack: bad header');
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headLen)));
  const base = 4 + headLen;
  return head.files.map(([path, offset, length]) => {
    if (base + offset + length > buffer.byteLength) throw new Error(`thumb pack: ${path} runs past the end`);
    return { path, bytes: new Uint8Array(buffer, base + offset, length) };
  });
}

const isChallenge = (res) => res.headers.get('cf-mitigated') === 'challenge'
  || (res.status === 403 && /text\/html/i.test(res.headers.get('content-type') || ''));

/** Fetch the one-file pack of small pictures. Safe to call more than once; never rejects. */
export function loadThumbPack(url) {
  if (!url || typeof fetch !== 'function') return Promise.resolve(false);
  if (packPromise) return packPromise;
  packPending = true;
  packPromise = fetch(url).then(async (res) => {
    if (isChallenge(res)) { suspectGate(); throw new Error('thumb pack: verification page'); }
    if (!res.ok) throw new Error(`thumb pack: ${res.status}`);
    for (const { path, bytes } of readPack(await res.arrayBuffer())) {
      thumbs.set(path, URL.createObjectURL(new Blob([bytes], { type: 'image/webp' })));
    }
    packPending = false;
    // pictures put on the page before the pack arrived: the ones still waiting, or failed, switch to it
    for (const img of document.querySelectorAll('img[data-thumb]')) {
      const blob = thumbs.get(img.dataset.thumb);
      if (blob && img.dataset.sharp !== '1' && !(img.getAttribute('src') && img.complete && img.naturalWidth > 0)) img.src = blob;
    }
    document.documentElement.dataset.thumbs = 'pack';
    return true;
  }).catch((err) => {
    console.warn(err.message || err);
    packPending = false;
    packPromise = null; // the next call may try again
    // the pictures that were waiting for the pack ask for their own files
    for (const img of document.querySelectorAll('img[data-thumb]:not([src])')) img.src = img.dataset.thumb;
    return false;
  });
  return packPromise;
}

/** The address to draw a small picture from: memory when the pack has it, its own file otherwise. */
export const thumbSrc = (path) => thumbs.get(path) || path;

/**
 * Put a small picture in an <img>: from memory when the pack has it. While the pack is on its way the picture
 * waits a moment for it (one request for all of them instead of one each), then asks for its own file.
 */
export function setThumb(img, path) {
  img.dataset.thumb = path;
  const blob = thumbs.get(path);
  if (blob || !packPending) { img.src = blob || path; return img; }
  img.removeAttribute('src'); // CSS keeps a waiting picture invisible (no alt text flashing in its place)
  setTimeout(() => { if (img.dataset.thumb === path && !img.getAttribute('src')) img.src = thumbSrc(path); }, PACK_GRACE_MS);
  return img;
}

/**
 * Show `full` in `img`, with its small copy on screen until the sharp one has arrived.
 * `lazy` waits until the picture is near the screen. Returns a function that cancels the swap.
 */
export function progressive(img, thumbPath, full, { lazy = false, onSharp = null } = {}) {
  const ticket = String((Number(img.dataset.ticket) || 0) + 1);
  img.dataset.ticket = ticket;
  img.dataset.full = full;
  delete img.dataset.sharp;
  delete img.dataset.broken;
  if (thumbPath) setThumb(img, thumbPath); else { delete img.dataset.thumb; img.src = full; }
  let cancelled = false;
  const live = () => !cancelled && img.dataset.ticket === ticket;
  const start = () => {
    if (!thumbPath || !live()) return;
    let tries = 0;
    const attempt = () => {
      if (!live()) return;
      const probe = new Image();
      probe.decoding = 'async';
      probe.onload = () => {
        const swap = () => {
          if (!live()) return;
          img.src = probe.src; // already in the browser's cache: no second download
          img.dataset.sharp = '1';
          if (onSharp) onSharp();
        };
        // decoded first, so the sharp photo replaces the soft one without an empty frame in between
        if (typeof probe.decode === 'function') probe.decode().then(swap, swap); else swap();
      };
      probe.onerror = () => {
        if (!live()) return;
        suspectGate();
        if (tries < RETRY_WAITS.length) setTimeout(attempt, RETRY_WAITS[tries++]);
        // after the last try the small copy simply stays: a soft picture, never a broken one
      };
      probe.src = tries ? `${full}${full.includes('?') ? '&' : '?'}retry=${tries}` : full;
    };
    attempt();
  };
  if (lazy && typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
    }, { rootMargin: '300px' });
    io.observe(img);
  } else start();
  return () => { cancelled = true; };
}

// ---------- the verification page ----------
let gateCheck = null;
let gateBar = null;

function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    sessionStorage.setItem(key, value);
    return value;
  } catch { return null; } // private mode
}

function showGateBar(text, withButton) {
  if (!gateBar) {
    gateBar = document.createElement('div');
    gateBar.className = 'gate-bar';
    gateBar.setAttribute('role', 'status');
    document.body.append(gateBar);
  }
  gateBar.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }));
  if (withButton) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-primary btn-sm', textContent: 'تحديث الصفحة' });
    b.addEventListener('click', () => location.reload());
    gateBar.append(b);
  }
  gateBar.hidden = false;
}

function renewClearance() {
  const last = Number(session('gate-reload') || 0);
  const canRecord = session('gate-reload-test', '1') === '1';
  if (canRecord && Date.now() - last > RELOAD_EVERY_MS) {
    session('gate-reload', String(Date.now()));
    showGateBar('جارٍ تجديد التحقق الأمني للموقع…', false);
    setTimeout(() => location.reload(), 600); // same address: the visitor comes back to the same room
  } else {
    // we reloaded moments ago and the host still asks: do not loop, let the visitor decide
    showGateBar('تعذّر تحميل بعض الصور: انتهت مهلة التحقق الأمني للموقع.', true);
  }
}

/** Something failed to load: ask the host whether it is showing its verification page, and renew if so. */
export function suspectGate() {
  if (gateCheck || typeof fetch !== 'function') return gateCheck || Promise.resolve(false);
  gateCheck = fetch(`data/office.json?gate=${Date.now()}`, { method: 'HEAD', cache: 'no-store' })
    .then((res) => isChallenge(res))
    .catch(() => false) // offline or a dropped connection is not the verification page
    .then((blocked) => {
      setTimeout(() => { gateCheck = null; }, 8000);
      if (blocked) renewClearance();
      return blocked;
    });
  return gateCheck;
}

/** Page-wide care for <img>: a failed one is hidden, asked for again a few times, and shown when it loads. */
export function watchImages(root = document) {
  root.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    const src = img.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) return;
    img.dataset.broken = '1'; // CSS hides it: the frame keeps its background instead of the broken-picture mark
    if (src.startsWith('blob:')) return;
    // a small picture whose own file failed: the pack may have it by now
    const packed = img.dataset.thumb && thumbs.get(img.dataset.thumb);
    if (packed) { img.src = packed; return; }
    suspectGate();
    const base = img.dataset.retrySrc && src.startsWith(img.dataset.retrySrc) ? img.dataset.retrySrc : src;
    const n = img.dataset.retrySrc === base ? Number(img.dataset.retry || 0) : 0;
    if (n >= RETRY_WAITS.length) { img.dataset.failed = '1'; return; }
    img.dataset.retrySrc = base;
    img.dataset.retry = String(n + 1);
    setTimeout(() => {
      // still the same picture? (the page may have moved on to another one meanwhile)
      if ((img.getAttribute('src') || '').startsWith(base)) img.src = `${base}${base.includes('?') ? '&' : '?'}retry=${n + 1}`;
    }, RETRY_WAITS[n]);
  }, true);
  root.addEventListener('load', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.dataset.broken) { delete img.dataset.broken; delete img.dataset.failed; }
  }, true);
}
