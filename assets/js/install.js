// «Add to the home screen» on phones (owner, 2026-11-11): the tour asks by itself when it is opened on a
// phone, and once added it opens from the home screen as an app (no browser bars).
//
// What a web page may do differs by phone, and no browser lets a page add itself without the visitor's tap:
//   - Chrome, Edge and Samsung Internet on Android tell the page when it can be installed
//     (`beforeinstallprompt`); the bar then has an «إضافة» button that opens the browser's own install dialog.
//   - iPhone and iPad give a page no such signal and no way to open the dialog: the bar says where the
//     visitor finds it (the Share button, then «إضافة إلى الشاشة الرئيسية»).
//   - an Android browser that sends no signal gets the same kind of hint for its menu.
// Closed with ×, the bar stays away for a week. Inside the installed app, on a computer, and inside the
// in-app browsers of social apps (they cannot add to the home screen) it never shows.

const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const KEY = 'install-bar-closed';
const SHARE = '<svg class="install-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M7.5 7.5 12 3l4.5 4.5M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
const TEXT = {
  prompt: 'أضف الجولة إلى شاشتك الرئيسية وافتحها كتطبيق',
  ios: `لفتح الجولة كتطبيق: اضغط زر المشاركة ${SHARE} ثم «إضافة إلى الشاشة الرئيسية»`,
  menu: 'لفتح الجولة كتطبيق: من قائمة المتصفح ⋮ اختر «إضافة إلى الشاشة الرئيسية»',
};

const read = () => { try { return Number(localStorage.getItem(KEY) || 0); } catch { return 0; } };
const write = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ } };

/** Which of the three bars this browser gets ('' = none). Kept apart so it can be tested without a phone. */
export function installMode({ userAgent, platform = '', touchPoints = 0, standalone = false, phone = true, signal = false }) {
  if (standalone || !phone) return '';
  if (/FBAN|FBAV|FB_IAB|Instagram|Snapchat|TikTok|musical_ly|Line\/|Twitter|LinkedInApp|; wv\)/i.test(userAgent)) return '';
  if (signal) return 'prompt';
  if (/iPhone|iPad|iPod/.test(userAgent) || (platform === 'MacIntel' && touchPoints > 1)) return 'ios';
  return /Android/.test(userAgent) ? 'menu' : '';
}

export function initInstall(app) {
  if (typeof window === 'undefined' || !app) return;
  // the service worker is only what Chrome asks of an installable site; it caches nothing (see sw.js)
  if ('serviceWorker' in navigator) {
    const register = () => { navigator.serviceWorker.register('sw.js').catch(() => {}); };
    if (document.readyState === 'complete') register(); // the page has usually finished loading by the time the app is ready
    else window.addEventListener('load', register, { once: true });
  }

  const env = (signal) => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    touchPoints: navigator.maxTouchPoints,
    standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    phone: matchMedia('(max-width: 720px)').matches,
    signal,
  });
  let offer = null; // the browser's install offer, when it gives one
  let bar = null;

  const hide = () => { if (bar) bar.hidden = true; app.classList.remove('has-install'); };
  function show(mode) {
    if (!mode || Date.now() - read() < SNOOZE_MS) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'install-bar';
      bar.id = 'install-bar';
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', 'إضافة الجولة إلى الشاشة الرئيسية');
      bar.innerHTML = '<img class="install-icon" src="assets/icons/app-192.png" alt="" width="34" height="34"><p class="install-text"></p>'
        + '<button class="btn btn-primary btn-sm install-go" type="button">إضافة</button>'
        + '<button class="install-close" type="button" aria-label="إخفاء">×</button>';
      bar.querySelector('.install-close').addEventListener('click', () => { write(); hide(); });
      bar.querySelector('.install-go').addEventListener('click', async () => {
        if (!offer) return;
        const asked = offer;
        offer = null; // an offer can be used once
        asked.prompt();
        try { await asked.userChoice; } catch { /* the dialog was closed */ }
        write();
        hide();
      });
      app.append(bar);
    }
    bar.dataset.mode = mode;
    bar.querySelector('.install-text').innerHTML = TEXT[mode];
    bar.querySelector('.install-go').hidden = mode !== 'prompt';
    bar.hidden = false;
    app.classList.add('has-install');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // the bar below is the site's own, in its own words
    offer = e;
    show(installMode(env(true)));
  });
  window.addEventListener('appinstalled', () => { write(); hide(); });
  // no signal from the browser: an iPhone gets its hint at once, an Android browser after giving the signal time
  const quiet = installMode(env(false));
  if (quiet === 'ios') setTimeout(() => show('ios'), 1200);
  else if (quiet === 'menu') setTimeout(() => { if (!offer && (!bar || bar.hidden)) show('menu'); }, 4000);
}
