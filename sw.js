/* sw.js — AMI NGAP Service Worker v5.10.7-incident
   ✅ Fix: ne cache JAMAIS les requêtes POST (crash "method unsupported")
   ✅ Chemins relatifs pour GitHub Pages /Ami-ngap/
   ✅ Cache uniquement GET
   ✅ v5.10.0 — Couches IA terrain (no-show, difficulté, météo, autopilot opt-in,
              vocal, simulation) — module ai-smart-tour.js
   ✅ v5.10.1 — Suppression "Éviter autoroutes / péages"
   ✅ v5.10.2 — UI dédiée IA terrain
   ✅ v5.10.3 — Fix anti-spam vocal partiel
   ✅ v5.10.4 — Auto-apprentissage + 1 annonce/patient + heatmap close
   ✅ v5.10.5 — Polling défensif + rattrapage historique + heatmap résumé
   ✅ v5.10.6 — Mode GPS plein écran : auto-clôture du dernier patient
              • Désactivation du bouton "Terminer" pendant le flow
                (anti double-clic → anti double signature)
              • Garde anti-réentrance dans markUberDone et _uberAfterDoneFlow
              • Suppression du délai 600ms inutile avant l'auto-clôture
              • terminerTourneeAvecBilan exclut désormais les patients dont
                _afterDoneFlowDone est vrai (pas de re-cotation parasite)
              • Bilan de fin de tournée s'affiche immédiatement après le
                dernier patient, sans intervention manuelle
   ✅ v5.10.7-incident — Module Plan d'incident RGPD/CNIL <72h finalisé
              • Inclusion incident.js dans index.html
              • Onglet "🚨 Incidents" dans le panneau admin (filtres + stats)
              • 3 modales DOM ajoutées : signalement, notif CNIL, résolution
              • Carte d'entrée "Signaler un incident" dans view-contact (nurse)
              • Génération automatique du pré-remplissage CNIL (téléservice)
              • Export PDF du rapport d'incident (window.print A4 stylé)
              • Notification art.34 RGPD aux personnes concernées (template
                courrier + impression + marquage automatique)
              • Badge dynamique du nb d'incidents ouverts dans la nav admin
*/

const CACHE_VERSION = 'ami-v5.10.10-cot-patnom-fix';
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
  './ngap-engine/ngap_engine.js',                      // ⚙️ moteur NGAP local (cotation offline) — colocalisé avec le référentiel
  './ngap-engine/ngap_referentiel_2026.json',          // 📚 référentiel NGAP — requis par le moteur offline
  './voice.js',
  './dashboard.js',
  './ui.js',
  './map.js',
  './uber.js',
  './ai-tournee.js',
  './ai-smart-tour.js',
  './ai-smart-ui.js',
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
    Promise.all([
      // Activer navigation preload : accélère le 1er chargement après install/reset.
      // Sans ça, la PWA met 1-2s à démarrer car le SW doit booter avant la nav.
      (self.registration.navigationPreload
        ? self.registration.navigationPreload.enable().catch(function(){})
        : Promise.resolve()),
      caches.keys().then(function(keys) {
        return Promise.all(
          keys.filter(function(k) {
            // Catch les anciens caches "ami-*" ET "amitest-*" (ancienne sandbox)
            // qui ne correspondent plus au CACHE_VERSION courant.
            // Sans cette suppression, caches.match() pouvait encore renvoyer
            // l'ancien index.html depuis un ancien cache "amitest-v3.8-static".
            var isAmi = k.startsWith('ami-') || k.startsWith('amitest-');
            return isAmi && k !== CACHE_STATIC && k !== CACHE_TILES;
          }).map(function(k) { return caches.delete(k); })
        );
      })
    ]).then(function() { return self.clients.claim(); })
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
    e.respondWith(networkFirst(req, CACHE_STATIC, e));
    return;
  }

  /* Assets app (CSS, JS, fonts locaux) → cache-first avec fallback réseau */
  e.respondWith(cacheFirst(req, CACHE_STATIC));
});

async function networkFirst(req, cacheName) {
  try {
    // 1) Si navigation preload est dispo, on récupère sa réponse en priorité
    //    (déjà lancée en parallèle par le navigateur dès l'événement fetch).
    //    Ça réduit drastiquement le TTFB sur cold start de PWA.
    var event = arguments[2]; // optionnel, passé par fetch handler
    if (event && event.preloadResponse) {
      try {
        var preload = await event.preloadResponse;
        if (preload && preload.ok) {
          var cache0 = await caches.open(cacheName);
          cache0.put(req, preload.clone());
          return preload;
        }
      } catch(_) { /* preload pas dispo, on continue */ }
    }

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
                  || await caches.match('./')
                  || await caches.match('/Ami-ngap/index.html')
                  || await caches.match('/Ami-ngap/');
      if (fallback) return fallback;

      // ⚠️ FILET DE DERNIER RECOURS : si même l'index.html n'est pas en cache
      // (cas du tout premier lancement post "Effacer les données" sans réseau),
      // on renvoie une page minimale qui tente de relancer correctement.
      // Sans ça, Chrome affichait sa page d'erreur "page inexistante".
      var html = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>AMI — Reconnexion…</title>'
        + '<style>body{margin:0;background:#0b0f14;color:#e8eef5;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.b{max-width:340px}h1{color:#00d4aa;font-size:22px;margin:0 0 12px}p{font-size:14px;line-height:1.5;opacity:.85;margin:0 0 18px}a{display:inline-block;background:#00d4aa;color:#0b0f14;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600}</style>'
        + '</head><body><div class="b"><h1>AMI</h1><p>Reconnexion en cours…<br>Si rien ne se passe, tape sur le bouton ci-dessous.</p>'
        + '<a href="/Ami-ngap/index.html">Relancer AMI</a></div>'
        + '<script>setTimeout(function(){location.replace("/Ami-ngap/index.html"+(location.hash||""));},800);</script>'
        + '</body></html>';
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
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
