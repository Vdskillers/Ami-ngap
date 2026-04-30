/* sw.js — AMI NGAP Service Worker v5.12.0-paths-fix
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
   ✅ v5.10.7-incident — Module Plan d'incident RGPD/CNIL <72h finalisé
   ✅ v5.11.0 — Précache COMPLET de tous les modules JS (~50 fichiers)
   ✅ v5.12.0 — 🚨 FIX MAJEUR : chemins de précache CASSÉS depuis l'origine
              ────────────────────────────────────────────────────────────
              PROBLÈME (audit live de 62 chemins → 58 en 404) :
                Le sw.js listait tous les modules avec préfixe './X.js' (racine)
                alors que GitHub Pages les sert depuis 'js/X.js' et 'css/X.css'
                (cf <script src="js/auth.js?v=3.8"> dans index.html).
                Conséquence : 58/62 fichiers échouaient au précache (404),
                et le .catch() global de cache.addAll() masquait l'erreur.
                Effet réel : AUCUN module JS/CSS n'était caché → l'app ne
                fonctionnait PAS en mode offline. Toutes les routes vers
                cotation, tournée, carnet, etc. cassaient hors-ligne.

              SECONDE FAILLE :
                caches.match(req) sans option matche l'URL EXACTE, query
                comprise. Or les <script src> utilisent '?v=3.8'/'?v=4.1'.
                Donc même les rares fichiers cachés (index.html, manifest)
                ne matchaient pas les requêtes runtime. Maintenant tous les
                match() utilisent { ignoreSearch: true }.

              CORRECTIFS APPLIQUÉS v5.12.0 :
                • STATIC_ASSETS : chemins corrects (js/X.js, css/X.css,
                  ngap-engine/X)
                • cache.addAll() → Promise.all(STATIC_ASSETS.map(cache.add))
                  pour avoir un diagnostic individuel et pas un échec global
                • caches.match(req, { ignoreSearch: true }) sur cacheFirst
                  ET networkFirst pour absorber les query strings de version
                • CACHE_VERSION bump → invalide tous les caches existants
                  (les 58 fichiers absents seront re-précachés au prochain
                  install)
*/

const CACHE_VERSION = 'ami-v5.12.1-osrm-bypass';
const CACHE_STATIC  = CACHE_VERSION + '-static';
const CACHE_TILES   = CACHE_VERSION + '-tiles';

/* ⚠️ STRUCTURE GITHUB PAGES : les modules sont servis avec préfixes :
     /Ami-ngap/js/*.js
     /Ami-ngap/css/*.css
     /Ami-ngap/ngap-engine/ngap_engine.js
     /Ami-ngap/ngap-engine/ngap_referentiel_2026.json
   La racine /Ami-ngap/ N'A PAS de fichiers .js / .css à plat.

   Liste vérifiée fichier par fichier en live (curl HEAD) au moment du
   bump v5.12.0. Toute régression de chemin sera désormais visible dans
   le log d'install : "[SW] Précache partiel — N/T fichier(s) en échec".
*/
const STATIC_ASSETS = [
  // ── Racine / shell ────────────────────────────────────────────────
  './',
  './index.html',
  './manifest.json',
  // ── Styles ────────────────────────────────────────────────────────
  'css/style.css',
  'css/mobile-premium.css',
  'css/desktop-premium.css',
  'css/notes.css',
  // ── Modules core ──────────────────────────────────────────────────
  'js/utils.js',
  'js/auth.js',
  'js/ui.js',
  'js/navigation.js',
  'js/security.js',
  'js/offline-auth.js',
  'js/offline-queue.js',
  'js/pwa.js',
  'js/sw-version-check.js',
  // ── Données / patients ────────────────────────────────────────────
  'js/patients.js',
  'js/patient-form.js',
  'js/notes.js',
  // ── Cotation / NGAP ───────────────────────────────────────────────
  'js/cotation.js',
  'js/ngap-analyzer.js',
  'js/ngap-correction-hints.js',
  'js/ngap-ref-explorer.js',
  'js/ngap-suggest.js',
  'js/ngap-update-manager.js',
  'ngap-engine/ngap_engine.js',                        // ⚙️ moteur NGAP local (cotation offline)
  'ngap-engine/ngap_referentiel_2026.json',            // 📚 référentiel NGAP — requis par le moteur
  // ── Tournée / planification ───────────────────────────────────────
  'js/tournee.js',
  'js/uber.js',
  'js/ai-tournee.js',
  'js/ai-smart-tour.js',
  'js/ai-smart-ui.js',
  'js/ai-assistant.js',
  'js/ai-layer.js',
  'js/map.js',
  'js/geocode.js',
  // ── Cabinet / multi-IDE ───────────────────────────────────────────
  'js/cabinet.js',
  'js/consentements.js',
  'js/signature.js',
  'js/infirmiere-tools.js',
  // ── Soins cliniques ───────────────────────────────────────────────
  'js/bsi.js',
  'js/bsi-engine.js',
  'js/pilulier.js',
  'js/alertes-medicaments.js',
  'js/constantes.js',
  'js/transmissions.js',
  'js/cr-passage.js',
  'js/copilote.js',
  // ── Tableaux de bord / reporting ──────────────────────────────────
  'js/dashboard.js',
  'js/rapport.js',
  'js/tresorerie.js',
  // ── Admin / compliance / sécurité ─────────────────────────────────
  'js/admin.js',
  'js/admin-ngap.js',
  'js/audit-cpam.js',
  'js/compliance-engine.js',
  'js/incident.js',                                    // 🚨 module Plan d'incident RGPD/CNIL
  'js/notif-messages.js',
  // ── Profil / abonnement / contact / onboarding ────────────────────
  'js/profil.js',
  'js/subscription.js',
  'js/contact.js',
  'js/onboarding.js',
  'js/extras.js',
  // ── Voix ──────────────────────────────────────────────────────────
  'js/voice.js',
  // ── CDN ───────────────────────────────────────────────────────────
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then(function(cache) {
        // ⚡ Précache résilient avec diagnostic.
        //   Avant, cache.addAll() plantait globalement si UN SEUL fichier
        //   échouait → tout l'install était perdu. C'est ce qui masquait
        //   les 58 chemins en 404 depuis la v5.11.0.
        //   Maintenant chaque fichier est tenté individuellement et les
        //   échecs sont listés explicitement.
        var failed = [];
        return Promise.all(STATIC_ASSETS.map(function(url) {
          return cache.add(url).catch(function(err) {
            failed.push({ url: url, error: err && err.message ? err.message : String(err) });
          });
        })).then(function() {
          if (failed.length) {
            console.warn(
              '[SW] Précache partiel — ' + failed.length + '/' + STATIC_ASSETS.length +
              ' fichier(s) en échec :',
              failed
            );
          } else {
            console.info('[SW] Précache complet : ' + STATIC_ASSETS.length + ' fichiers cachés.');
          }
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

  /* ✅ v5.12.1 — APIs EXTERNES : NE JAMAIS CACHER (let pass through).
     ────────────────────────────────────────────────────────────────
     Le bug v9.x du tracé OSRM disparu venait d'ici : les requêtes vers
     router.project-osrm.org tombaient dans `cacheFirst` (cache générique
     ci-dessous) avec `ignoreSearch: true`, donc la PREMIÈRE réponse cachée
     (typiquement un appel avec `overview=false` qui ne renvoie PAS de
     geometry) était servie indéfiniment pour TOUS les appels suivants —
     même avec `overview=full&geometries=polyline`. Résultat : `geometry`
     était `undefined` et le tracé invisible.
     Solution : bypass complet pour ces hosts. Chaque requête va toujours
     en direct au réseau, jamais dans le cache du SW. */
  if (url.hostname.includes('router.project-osrm.org') ||
      url.hostname.includes('nominatim.openstreetmap.org') ||
      url.hostname.includes('api-adresse.data.gouv.fr') ||
      url.hostname.includes('data.geopf.fr') ||
      url.hostname.includes('wxs.ign.fr')) {
    return; /* laisser passer normalement, pas de cache SW */
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
    // ⚡ ignoreSearch : matche '?v=3.8' avec la version cachée sans query.
    var cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    // ⚠️ CRITIQUE : pour toute navigation (PWA lancée hors-ligne,
    // URL avec hash #xxx, query params inattendus, etc.), on retombe
    // toujours sur l'index.html caché — sinon Chrome affiche sa page
    // dinosaure et l'utilisateur croit que l'app est cassée.
    if (req.mode === 'navigate') {
      var fallback = await caches.match('./index.html', { ignoreSearch: true })
                  || await caches.match('./',           { ignoreSearch: true })
                  || await caches.match('/Ami-ngap/index.html', { ignoreSearch: true })
                  || await caches.match('/Ami-ngap/',           { ignoreSearch: true });
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
  // ⚡ ignoreSearch : matche les requêtes 'js/auth.js?v=3.8' avec la version
  //   cachée 'js/auth.js' (sans query). C'est ce qui rend l'app vraiment
  //   utilisable offline malgré les query strings de cache-busting des
  //   <script src> et <link href>.
  var cached = await caches.match(req, { ignoreSearch: true });
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
