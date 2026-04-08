/* sw.js — AMI NGAP Service Worker v2.1
   ✅ Fix: ne cache JAMAIS les requêtes POST (crash "method unsupported")
   ✅ Chemins relatifs pour GitHub Pages /Ami-ngap/
   ✅ Cache uniquement GET
   ✅ v2.1 — bump version pour forcer rechargement des fichiers corrigés
*/

const CACHE_VERSION = 'ami-v2.1';
const CACHE_STATIC  = CACHE_VERSION + '-static';
const CACHE_TILES   = CACHE_VERSION + '-tiles';

const STATIC_ASSETS = [
  './index.html',
  './css/style.css',
  './js/utils.js',
  './js/auth.js',
  './js/admin.js',
  './js/profil.js',
  './js/cotation.js',
  './js/voice.js',
  './js/dashboard.js',
  './js/ui.js',
  './js/map.js',
  './js/uber.js',
  './js/ai-tournee.js',
  './js/tournee.js',
  './js/ai-assistant.js',
  './js/pwa.js',
  './js/security.js',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then(function(cache) {
        return cache.addAll(STATIC_ASSETS).catch(function(err) {
          console.warn('[SW] Précache partiel:', err.message);
        });
      })
      .then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) {
          return k.startsWith('ami-') && k !== CACHE_STATIC && k !== CACHE_TILES;
        }).map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  var req = e.request;

  /* ✅ CRITIQUE : ne jamais intercepter les POST — crash garanti */
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  /* Tiles OpenStreetMap → stale-while-revalidate */
  if (url.hostname.includes('tile.openstreetmap') || url.pathname.match(/\/\d+\/\d+\/\d+\.png$/)) {
    e.respondWith(tileStrategy(req));
    return;
  }

  /* API Cloudflare Worker → network only, pas de cache */
  if (url.hostname.includes('workers.dev') || url.hostname.includes('vdskillers.workers')) {
    return; /* laisser passer normalement */
  }

  /* CDN (Leaflet, Google Fonts) → cache-first */
  if (url.hostname.includes('unpkg.com') || url.hostname.includes('fonts.google') || url.hostname.includes('fonts.gstatic')) {
    e.respondWith(cacheFirst(req, CACHE_STATIC));
    return;
  }

  /* Assets app (HTML, CSS, JS) → cache-first avec fallback réseau */
  e.respondWith(cacheFirst(req, CACHE_STATIC));
});

async function cacheFirst(req, cacheName) {
  var cached = await caches.match(req);
  if (cached) return cached;
  try {
    var fresh = await fetch(req);
    if (fresh.ok) {
      var cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch(err) {
    return new Response('Ressource indisponible hors ligne', { status: 503 });
  }
}

async function tileStrategy(req) {
  var cache  = await caches.open(CACHE_TILES);
  var cached = await cache.match(req);
  var fetchPromise = fetch(req).then(function(fresh) {
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  }).catch(function() { return null; });
  return cached || fetchPromise || new Response('', { status: 503 });
}

self.addEventListener('sync', function(e) {
  if (e.tag === 'ami-offline-sync') {
    e.waitUntil(self.clients.matchAll().then(function(clients) {
      clients.forEach(function(c) { c.postMessage({ type: 'SYNC_REQUESTED' }); });
    }));
  }
});
