/* ════════════════════════════════════════════════
   sw.js — AMI NGAP Service Worker v1.0
   ────────────────────────────────────────────────
   PWA offline-first :
   ✅ Cache statique (assets app)
   ✅ Cache tiles Leaflet (cartes offline)
   ✅ Network-first pour API, cache-first pour assets
   ✅ Stratégie stale-while-revalidate pour tiles
   ✅ Sync offline queue au retour réseau
════════════════════════════════════════════════ */

const CACHE_VERSION  = 'ami-v1.0';
const CACHE_STATIC   = `${CACHE_VERSION}-static`;
const CACHE_TILES    = `${CACHE_VERSION}-tiles`;
const CACHE_API      = `${CACHE_VERSION}-api`;

/* Assets statiques à précacher au premier install */
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/utils.js',
  '/js/auth.js',
  '/js/admin.js',
  '/js/profil.js',
  '/js/cotation.js',
  '/js/voice.js',
  '/js/dashboard.js',
  '/js/ui.js',
  '/js/map.js',
  '/js/uber.js',
  '/js/ai-tournee.js',
  '/js/tournee.js',
  '/js/ai-assistant.js',
  '/js/pwa.js',
  '/manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
];

/* ── Install — précache statique ─────────────── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll(STATIC_ASSETS.filter(u => !u.startsWith('http') || u.includes('leaflet'))))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate — nettoyage anciens caches ─────── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k.startsWith('ami-') && k !== CACHE_STATIC && k !== CACHE_TILES && k !== CACHE_API)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch — stratégie par type de ressource ─── */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  /* 1. Tiles OpenStreetMap → stale-while-revalidate */
  if (isTileRequest(url)) {
    e.respondWith(tileStrategy(e.request));
    return;
  }

  /* 2. API backend (Worker Cloudflare) → network-first, pas de cache */
  if (isAPIRequest(url)) {
    e.respondWith(networkFirst(e.request, CACHE_API, 8000));
    return;
  }

  /* 3. Polices Google / Leaflet CDN → cache-first */
  if (isCDNRequest(url)) {
    e.respondWith(cacheFirst(e.request, CACHE_STATIC));
    return;
  }

  /* 4. Assets app (HTML, CSS, JS) → cache-first avec fallback */
  e.respondWith(cacheFirst(e.request, CACHE_STATIC));
});

/* ── Stratégies de cache ─────────────────────── */

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    return new Response('Ressource non disponible en mode hors ligne', { status: 503 });
  }
}

async function networkFirst(request, cacheName, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const fresh = await fetch(request, { signal: ctrl.signal });
    clearTimeout(timer);
    if (fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    clearTimeout(timer);
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ ok: false, error: 'Hors ligne' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

/* Stale-while-revalidate pour tiles (offline + fraîcheur) */
async function tileStrategy(request) {
  const cache  = await caches.open(CACHE_TILES);
  const cached = await cache.match(request);
  /* Revalider en arrière-plan */
  const fetchPromise = fetch(request).then(fresh => {
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  }).catch(() => null);
  return cached || fetchPromise || new Response('', { status: 503 });
}

/* ── Helpers détection type ──────────────────── */
function isTileRequest(url) {
  return url.hostname.includes('tile.openstreetmap') ||
         url.hostname.includes('tile.osm') ||
         url.pathname.match(/\/\d+\/\d+\/\d+\.png$/);
}
function isAPIRequest(url) {
  return url.hostname.includes('workers.dev') ||
         url.hostname.includes('vdskillers') ||
         url.hostname.includes('n8n-');
}
function isCDNRequest(url) {
  return url.hostname.includes('fonts.google') ||
         url.hostname.includes('fonts.gstatic') ||
         url.hostname.includes('unpkg.com');
}

/* ── Sync offline queue (Background Sync) ────── */
self.addEventListener('sync', e => {
  if (e.tag === 'ami-offline-sync') {
    e.waitUntil(flushOfflineQueue());
  }
});

async function flushOfflineQueue() {
  /* Les clients envoient les données à synchroniser via postMessage */
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'SYNC_REQUESTED' }));
}
