/* ════════════════════════════════════════════════
   sw-version-check.js — AMI NGAP v1.0
   ────────────────────────────────────────────────
   Purge forcée du cache PWA déclenchée par un admin.
   
   Fonctionnement :
   - Au démarrage de l'app, vérifie /webhook/sw-version
   - Compare avec la version stockée dans localStorage
   - Si différent → purge complète (caches + SW) + reload
   
   Déclenchement : quand un admin clique sur le bouton
   "Forcer la purge pour tous les utilisateurs" dans
   le tableau de bord Santé système, le worker incrémente
   la version → tous les clients purgent à leur
   prochaine visite (ou recheck périodique).
════════════════════════════════════════════════ */

(function() {
  'use strict';

  const LS_KEY            = 'ami_sw_ver_ack';    // version reconnue par ce client
  const LS_LAST_CHECK     = 'ami_sw_last_check'; // timestamp dernier check
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;       // re-check toutes les 5 min si l'onglet reste ouvert
  const WORKER_URL        = window.__AMI_WORKER_URL__ || '';

  /**
   * Récupère l'URL du worker — compatible avec la config existante du projet.
   * Essaie plusieurs sources dans l'ordre.
   */
  function getWorkerBase() {
    if (WORKER_URL) return WORKER_URL.replace(/\/+$/, '');
    if (window.API_URL)    return String(window.API_URL).replace(/\/+$/, '');
    if (window.WORKER_URL) return String(window.WORKER_URL).replace(/\/+$/, '');
    // Valeur par défaut projet AMI (production)
    return 'https://ami-worker.vdskillers.workers.dev';
  }

  /**
   * Fetch silencieux de la version serveur.
   * Timeout court pour ne JAMAIS bloquer le boot de l'app.
   */
  async function fetchServerVersion() {
    const base = getWorkerBase();
    if (!base) return null;
    const url  = base + '/webhook/sw-version';
    const ctrl = new AbortController();
    const to   = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(url, {
        method: 'GET',
        cache:  'no-store',
        signal: ctrl.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(to);
      if (!r.ok) return null;
      const d = await r.json();
      return d && typeof d.version !== 'undefined' ? String(d.version) : null;
    } catch (_) {
      clearTimeout(to);
      return null; // offline / worker KO → on ne purge rien
    }
  }

  /**
   * Purge complète : tous les caches + tous les SW enregistrés.
   * Préserve le localStorage (credentials, préférences, tokens) — ce n'est
   * PAS un logout. Seuls les fichiers statiques cachés (JS/CSS/HTML) sont
   * invalidés pour forcer le prochain reload à récupérer la version fraîche.
   */
  async function purgeAll() {
    console.warn('[SW-CHECK] Purge cache PWA en cours…');

    // 1. Vider tous les caches HTTP
    try {
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n).catch(() => {})));
        console.log('[SW-CHECK] Caches supprimés :', names.length);
      }
    } catch (e) {
      console.warn('[SW-CHECK] Échec purge caches :', e.message);
    }

    // 2. Désenregistrer tous les Service Workers
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister().catch(() => {})));
        console.log('[SW-CHECK] Service Workers désenregistrés :', regs.length);
      }
    } catch (e) {
      console.warn('[SW-CHECK] Échec unregister SW :', e.message);
    }
  }

  /**
   * Reload avec cache-bust (force le navigateur à re-télécharger
   * tous les assets statiques sans utiliser son cache HTTP).
   */
  function hardReload() {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('_swpurge', Date.now().toString());
      window.location.replace(url.toString());
    } catch (_) {
      window.location.reload();
    }
  }

  /**
   * Cycle complet de vérification.
   * @param {Object} [opts]
   * @param {boolean} [opts.silent=false] — si true, n'affiche pas de banner à l'utilisateur
   */
  async function checkAndPurgeIfNeeded(opts = {}) {
    // Mémoriser timestamp pour éviter trop d'appels répétés
    try { localStorage.setItem(LS_LAST_CHECK, String(Date.now())); } catch (_) {}

    const serverVer = await fetchServerVersion();
    if (!serverVer) return; // serveur injoignable → on ne fait rien (safe)

    const localVer = (() => {
      try { return localStorage.getItem(LS_KEY) || ''; }
      catch (_) { return ''; }
    })();

    // Premier lancement : on aligne sans purger
    if (!localVer) {
      try { localStorage.setItem(LS_KEY, serverVer); } catch (_) {}
      return;
    }

    if (localVer === serverVer) return; // à jour, rien à faire

    console.warn(`[SW-CHECK] Bump détecté : local=${localVer} → serveur=${serverVer}`);

    // Afficher un petit banner discret (sauf si silent)
    if (!opts.silent) showPurgeBanner();

    await purgeAll();

    // Enregistrer la nouvelle version AVANT reload pour ne pas re-purger en boucle
    try { localStorage.setItem(LS_KEY, serverVer); } catch (_) {}

    // Petit délai pour laisser le banner s'afficher
    setTimeout(hardReload, 800);
  }

  /**
   * Banner informatif pendant la purge (3s max avant reload).
   */
  function showPurgeBanner() {
    try {
      const el = document.createElement('div');
      el.id = 'sw-purge-banner';
      el.style.cssText = `
        position:fixed;top:0;left:0;right:0;z-index:99999;
        background:linear-gradient(90deg,#00d4aa,#00b891);color:#000;
        padding:10px 16px;text-align:center;
        font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;
        box-shadow:0 2px 12px rgba(0,0,0,.2);
      `;
      el.innerHTML = '🔄 Mise à jour de l\'application — rechargement automatique…';
      document.body.appendChild(el);
    } catch (_) {}
  }

  /**
   * API publique exposée sur window.AMI_SW_CHECK pour usage manuel
   * (notamment le bouton "Purger mon cache local" côté admin).
   */
  window.AMI_SW_CHECK = {
    /** Purge locale immédiate (bouton admin — n'affecte que l'utilisateur courant) */
    purgeLocal: async function() {
      await purgeAll();
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      hardReload();
    },
    /** Force un check immédiat (après un bump serveur) */
    checkNow: function(silent = false) { return checkAndPurgeIfNeeded({ silent }); },
    /** Renvoie la version locale et serveur (diagnostic) */
    getInfo: async function() {
      let localVer = '';
      try { localVer = localStorage.getItem(LS_KEY) || ''; } catch(_) {}
      const serverVer = await fetchServerVersion();
      return { local: localVer, server: serverVer, synced: localVer === serverVer };
    },
  };

  /**
   * Déclenchement automatique :
   * - Après l'événement 'load' (pour ne pas ralentir le first paint)
   * - Puis re-check toutes les 5 min tant que l'onglet est actif
   * - Et aussi sur retour au premier plan après absence > 5 min
   */
  function startAutoCheck() {
    // Check initial avec un léger délai (après le boot de l'app)
    setTimeout(() => { checkAndPurgeIfNeeded().catch(() => {}); }, 3000);

    // Re-check périodique
    setInterval(() => { checkAndPurgeIfNeeded({ silent: true }).catch(() => {}); }, CHECK_INTERVAL_MS);

    // Re-check au retour visible (l'utilisateur revient sur l'onglet)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      let last = 0;
      try { last = parseInt(localStorage.getItem(LS_LAST_CHECK) || '0', 10); } catch (_) {}
      if (Date.now() - last > CHECK_INTERVAL_MS) {
        checkAndPurgeIfNeeded({ silent: true }).catch(() => {});
      }
    });
  }

  if (document.readyState === 'complete') {
    startAutoCheck();
  } else {
    window.addEventListener('load', startAutoCheck, { once: true });
  }
})();
