/* sw.js — AMI NGAP Service Worker v3.8-TEST (SANDBOX)
   ⚠️ VERSION SANDBOX — NE PAS DIFFUSER
   ✅ Fix: ne cache JAMAIS les requêtes POST (crash "method unsupported")
   ✅ Chemins relatifs pour GitHub Pages /Ami-ngaptest/
   ✅ Cache uniquement GET
   ✅ Préfixe cache isolé (amitest-) pour ne pas entrer en conflit avec la PWA prod
*/

const CACHE_VERSION = 'amitest-v4.0';
const CACHE_STATIC  = CACHE_VERSION + '-static';
const CACHE_TILES   = CACHE_VERSION + '-tiles';

/* ⚠️ Les fichiers sont à la racine du projet (pas dans /css/ ou /js/).
   Les anciens chemins ./css/... et ./js/... échouaient silencieusement
   au précache → rien n'était caché → au prochain offline l'app ne se
   chargeait pas et Chrome affichait ERR_INTERNET_DISCONNECTED. */
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './mobile-premium.css',
  './desktop-premium.css',
  './notes.css',
  './manifest.json',
  './utils.js',
  './auth.js',
  './admin.js',
  './profil.js',
  './cotation.js',
  './voice.js',
  './dashboard.js',
  './ui.js',
  './map.js',
  './uber.js',
  './ai-tournee.js',
  './tournee.js',
  './ai-assistant.js',
  './pwa.js',
  './security.js',
  './offline-auth.js',
  './offline-queue.js',
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
          // Catch les anciens caches "ami-*" ET "amitest-*" (sandbox)
          // qui ne correspondent plus au CACHE_VERSION courant.
          // Sans cette suppression, caches.match() pouvait encore renvoyer
          // l'ancien index.html depuis un ancien cache "amitest-v3.8-static".
          var isAmi = k.startsWith('ami-') || k.startsWith('amitest-');
          return isAmi && k !== CACHE_STATIC && k !== CACHE_TILES;
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

  /* HTML (index.html, racine) → NETWORK-FIRST.
     CRITIQUE : sans ça, après chaque déploiement, le SW continue de servir
     l'ancien HTML caché et l'utilisateur ne voit JAMAIS les mises à jour
     (même avec Ctrl+Shift+R, car le SW intercepte avant le réseau).
     Network-first → essaie le réseau d'abord ; fallback cache si offline. */
  if (req.mode === 'navigate' ||
      url.pathname === '/' ||
      url.pathname.endsWith('/') ||
      url.pathname.endsWith('.html')) {
    e.respondWith(networkFirst(req, CACHE_STATIC));
    return;
  }

  /* Assets app (CSS, JS, fonts locaux) → cache-first avec fallback réseau */
  e.respondWith(cacheFirst(req, CACHE_STATIC));
});

async function networkFirst(req, cacheName) {
  try {
    var fresh = await fetch(req);
    if (fresh.ok) {
      var cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch(err) {
    // Offline → fallback cache
    var cached = await caches.match(req);
    if (cached) return cached;
    // ⚠️ CRITIQUE : pour toute navigation (PWA lancée hors-ligne,
    // URL avec hash #xxx, query params inattendus, etc.), on retombe
    // toujours sur l'index.html caché — sinon Chrome affiche sa page
    // dinosaure et l'utilisateur croit que l'app est cassée.
    if (req.mode === 'navigate') {
      var fallback = await caches.match('./index.html')
                  || await caches.match('./');
      if (fallback) return fallback;
    }
    return new Response('Hors ligne', { status: 503 });
  }
}

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
