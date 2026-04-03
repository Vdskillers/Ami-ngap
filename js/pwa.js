/* ════════════════════════════════════════════════
   pwa.js — AMI NGAP v1.0
   ────────────────────────────────────────────────
   PWA : Service Worker + Install + Offline UX
   + Cartes offline (tiles téléchargées)
   + Sync queue offline
   + IndexedDB (logs + patients)
════════════════════════════════════════════════ */

/* ── 1. ENREGISTREMENT SERVICE WORKER ────────── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    log('SW enregistré:', reg.scope);
    /* Écouter les messages du SW (sync offline) */
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'SYNC_REQUESTED') _flushOfflineQueue();
    });
  }).catch(e => logErr('SW échec:', e.message));
}

/* ── 2. BANNIÈRE OFFLINE / ONLINE ─────────────── */
function _showNetworkBanner(online) {
  let el = document.getElementById('network-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'network-banner';
    el.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:9999;
      text-align:center;font-family:monospace;font-size:12px;
      padding:6px 14px;font-weight:600;transition:all .3s;
    `;
    document.body.prepend(el);
  }
  if (online) {
    el.textContent = '✅ Connexion rétablie — synchronisation…';
    el.style.background = '#00d4aa'; el.style.color = '#000';
    setTimeout(() => el.style.display = 'none', 3000);
  } else {
    el.textContent = '📡 Mode hors ligne — données locales actives';
    el.style.background = '#f59e0b'; el.style.color = '#000';
    el.style.display = 'block';
  }
}

window.addEventListener('online',  () => { _showNetworkBanner(true);  _flushOfflineQueue(); });
window.addEventListener('offline', () => { _showNetworkBanner(false); });

/* ── 3. INSTALL PROMPT ────────────────────────── */
let _installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _installPrompt = e;
  _showInstallButton();
});

function _showInstallButton() {
  const existing = document.getElementById('btn-install-pwa');
  if (existing) return;
  const btn = document.createElement('button');
  btn.id = 'btn-install-pwa';
  btn.innerHTML = '📱 Installer AMI';
  btn.className = 'btn bs bsm';
  btn.style.cssText = 'position:fixed;bottom:90px;right:16px;z-index:800;box-shadow:0 4px 20px rgba(0,0,0,.4)';
  btn.onclick = installApp;
  document.body.appendChild(btn);
}

async function installApp() {
  if (!_installPrompt) { alert('Installation non disponible sur cet appareil.'); return; }
  _installPrompt.prompt();
  const { outcome } = await _installPrompt.userChoice;
  log('Install prompt:', outcome);
  _installPrompt = null;
  const btn = document.getElementById('btn-install-pwa');
  if (btn) btn.remove();
}

window.addEventListener('appinstalled', () => {
  log('AMI installée comme PWA ✅');
  const btn = document.getElementById('btn-install-pwa');
  if (btn) btn.remove();
});

/* ── 4. INDEXEDDB — stockage offline robuste ──── */
const IDB_NAME    = 'ami-offline';
const IDB_VERSION = 1;

function _openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('patients'))
        db.createObjectStore('patients', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sync_queue'))
        db.createObjectStore('sync_queue', { autoIncrement: true });
      if (!db.objectStoreNames.contains('logs'))
        db.createObjectStore('logs', { autoIncrement: true });
    };
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

/* Sauvegarder patients en local (offline) */
async function saveOfflinePatients(patients) {
  try {
    const db = await _openIDB();
    const tx = db.transaction('patients', 'readwrite');
    const store = tx.objectStore('patients');
    store.clear();
    patients.forEach(p => store.put({ ...p, id: p.patient_id || p.id || String(Math.random()) }));
    log('Patients sauvegardés offline:', patients.length);
  } catch (e) { logWarn('saveOfflinePatients:', e.message); }
}

/* Charger patients depuis IDB (mode offline) */
async function loadOfflinePatients() {
  try {
    const db = await _openIDB();
    return await new Promise((res, rej) => {
      const tx  = db.transaction('patients', 'readonly');
      const req = tx.objectStore('patients').getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  } catch { return []; }
}

/* Log offline → file d'attente sync */
async function queueOfflineSync(data) {
  try {
    const db = await _openIDB();
    const tx = db.transaction('sync_queue', 'readwrite');
    tx.objectStore('sync_queue').add({ ...data, timestamp: Date.now() });
    /* Demander Background Sync si supporté */
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('ami-offline-sync');
    }
  } catch (e) { logWarn('queueOfflineSync:', e.message); }
}

/* Vider la file offline quand le réseau revient */
async function _flushOfflineQueue() {
  if (!navigator.onLine) return;
  try {
    const db    = await _openIDB();
    const items = await new Promise(res => {
      const tx = db.transaction('sync_queue', 'readonly');
      const req = tx.objectStore('sync_queue').getAll();
      req.onsuccess = () => res(req.result || []);
    });
    if (!items.length) return;
    log(`Sync offline: ${items.length} élément(s) à envoyer`);
    for (const item of items) {
      try {
        await fetch(W + '/webhook/ami-calcul', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ss.tok() },
          body: JSON.stringify(item)
        });
      } catch { break; } /* Arrêter si réseau instable */
    }
    /* Vider la queue */
    const db2 = await _openIDB();
    const tx  = db2.transaction('sync_queue', 'readwrite');
    tx.objectStore('sync_queue').clear();
    log('Sync offline terminée ✅');
  } catch (e) { logWarn('_flushOfflineQueue:', e.message); }
}

/* ── 5. CARTES OFFLINE — téléchargement de zone ─
   Convertit lat/lng → tile x/y pour un zoom donné
   puis précache toutes les tiles de la zone.
─────────────────────────────────────────────── */
function _latLngToTile(lat, lng, zoom) {
  const x = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
  const y = Math.floor(
    (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI)
    / 2 * Math.pow(2, zoom)
  );
  return { x, y };
}

/* Télécharge toutes les tiles d'une zone pour les niveaux de zoom donnés */
async function downloadMapArea(bounds, zoomLevels = [12, 13, 14]) {
  const cache    = await caches.open('ami-v1.0-tiles');
  let downloaded = 0;
  let total      = 0;

  /* Compter d'abord */
  for (const z of zoomLevels) {
    const tMin = _latLngToTile(bounds.maxLat, bounds.minLng, z);
    const tMax = _latLngToTile(bounds.minLat, bounds.maxLng, z);
    total += (tMax.x - tMin.x + 1) * (tMax.y - tMin.y + 1);
  }

  const elProg = document.getElementById('map-download-progress');
  const elMsg  = document.getElementById('map-download-msg');

  if (elMsg) elMsg.textContent = `📥 Téléchargement de ~${total} tiles…`;

  for (const z of zoomLevels) {
    const tMin = _latLngToTile(bounds.maxLat, bounds.minLng, z);
    const tMax = _latLngToTile(bounds.minLat, bounds.maxLng, z);

    for (let x = tMin.x; x <= tMax.x; x++) {
      for (let y = tMin.y; y <= tMax.y; y++) {
        const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
        try {
          const res = await fetch(url, { mode: 'no-cors' });
          await cache.put(url, res);
          downloaded++;
          if (elProg) elProg.style.width = `${Math.round(downloaded / total * 100)}%`;
        } catch { /* tile non disponible → ignorer */ }
      }
    }
  }

  if (elMsg) elMsg.textContent = `✅ ${downloaded} tiles téléchargées — zone disponible offline`;
  log(`Cartes offline: ${downloaded}/${total} tiles`);
}

/* Télécharge la zone autour du point de départ actuel */
async function downloadCurrentArea() {
  const sp = APP.get('startPoint');
  if (!sp) { alert('Définis d\'abord ton point de départ sur la carte.'); return; }

  /* Zone ~15km autour du point de départ */
  const delta = 0.15;
  const bounds = {
    minLat: sp.lat - delta, maxLat: sp.lat + delta,
    minLng: sp.lng - delta, maxLng: sp.lng + delta,
  };

  const panel = document.getElementById('map-download-panel');
  if (panel) panel.style.display = 'block';

  await downloadMapArea(bounds, [12, 13, 14]);
}

/* ── 6. FALLBACK ROUTING OFFLINE ─────────────── */
function estimateRouteOffline(a, b) {
  /* Distance euclidienne → km → minutes à 40km/h avec facteur route 1.3 */
  const dx = (a.lat - b.lat) * 111;
  const dy = (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180);
  const distKm = Math.sqrt(dx*dx + dy*dy) * 1.3;
  return distKm / 40 * 60; /* minutes */
}
