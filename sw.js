// The tour can be added to a phone's home screen and opened as an app (manifest.webmanifest).
// Chrome has offered its install prompt only to sites whose service worker handles `fetch`, so this file
// exists for that alone: it answers nothing itself. Every request goes to the network exactly as it would
// without it: nothing is cached here, so a new release, the host's cache rules and the host's verification
// page all behave as before.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
