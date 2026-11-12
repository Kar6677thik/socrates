// Socrates service worker: installable app, instant loads, and a read-only fallback when the
// server can't be reached. Hashed assets and media are cache-first (their names change when
// their content does); pages and API reads go to the network first.
const VERSION = 'socrates-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];
// API reads kept for the offline fallback: small, and enough to show where you stand.
const API_CACHE = new Set(['/api/home', '/api/tags', '/api/meta', '/api/settings', '/api/recommendations', '/api/presets']);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const put = (req, res) => {
  if (res.ok && res.type === 'basic') caches.open(VERSION).then((c) => c.put(req, res));
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/mcp') || url.pathname.startsWith('/api/export')) return;

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/media/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => (put(req, res.clone()), res))));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const keep = API_CACHE.has(url.pathname);
    e.respondWith(fetch(req).then((res) => (keep && put(req, res.clone()), res)).catch(() => (keep ? caches.match(req) : Promise.resolve(null)).then((hit) => hit || offline())));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => (put('/', res.clone()), res)).catch(() => caches.match('/')));
  }
});

function offline() {
  return new Response(JSON.stringify({ error: 'Socrates server is not running. Start it with npm start.' }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  });
}
