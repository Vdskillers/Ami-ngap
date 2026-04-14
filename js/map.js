// ─────────────────────────────────────────────────────────────
//  map.js
//  Carte Leaflet + système tap-to-correct
//  Correction manuelle de position : tap carte, drag marker
//  Reverse geocoding automatique après correction
// ─────────────────────────────────────────────────────────────

let correctionMode   = false;
let correctionMarker = null;

// ─────────────────────────────────────────────────────────────
//  ACTIVER le mode correction pour un patient
// ─────────────────────────────────────────────────────────────
function enableCorrectionMode(lat, lng) {
  correctionMode = true;

  // supprimer l'ancien marker de correction s'il existe
  if (correctionMarker) {
    APP.map.removeLayer(correctionMarker);
    correctionMarker = null;
  }

  // créer un marker draggable vert
  correctionMarker = L.marker([lat, lng], {
    draggable: true,
    icon: L.divIcon({
      className: '',
      html: `<div style="
        width:28px;height:28px;
        background:#1D9E75;
        border:3px solid white;
        border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        box-shadow:0 2px 6px rgba(0,0,0,0.3);">
      </div>`,
      iconSize:   [28, 28],
      iconAnchor: [14, 28],
    }),
  })
  .addTo(APP.map)
  .bindPopup('Glissez pour affiner la position')
  .openPopup();

  APP.map.setView([lat, lng], 18);
  APP.map.getContainer().style.cursor = 'crosshair';

  // tap sur la carte → déplace le marker
  APP.map.on('click', _onMapClickCorrection);

  // drag du marker → mise à jour adresse
  correctionMarker.on('dragend', e => {
    const { lat: la, lng: lo } = e.target.getLatLng();
    _reverseAndUpdate(la, lo);
    if (navigator.vibrate) navigator.vibrate(40);
  });

  correctionMarker.on('drag', e => {
    const { lat: la, lng: lo } = e.target.getLatLng();
    APP.set('tempCoords', { lat: la, lng: lo });
  });

  showToast('Tapez sur la carte pour repositionner');
}

// ─────────────────────────────────────────────────────────────
//  Clic carte en mode correction
// ─────────────────────────────────────────────────────────────
function _onMapClickCorrection(e) {
  if (!correctionMode) return;

  const { lat, lng } = e.latlng;
  if (correctionMarker) correctionMarker.setLatLng([lat, lng]);

  _reverseAndUpdate(lat, lng);
  if (navigator.vibrate) navigator.vibrate(40);
}

// ─────────────────────────────────────────────────────────────
//  Reverse geocoding après déplacement
// ─────────────────────────────────────────────────────────────
async function _reverseAndUpdate(lat, lng) {
  APP.set('tempCoords', { lat, lng });

  try {
    const addr = await reverseGeocode(lat, lng);

    const input = document.getElementById('patient-address')
               || document.getElementById('f-rue');
    if (input) input.value = addr;

    const preview = document.getElementById('addr-preview');
    if (preview) {
      const span = preview.querySelector('#preview-text') || preview;
      span.textContent = addr + ', France';
      preview.style.display = 'block';
    }

    showToast('Adresse mise à jour');
  } catch (_) {
    // silencieux — les coords sont quand même sauvegardées
  }
}

// ─────────────────────────────────────────────────────────────
//  VALIDER la position corrigée
// ─────────────────────────────────────────────────────────────
async function confirmCorrectedPosition(patientId) {
  const coords = APP.get('tempCoords');
  if (!coords) {
    showToast('Aucune position sélectionnée');
    return;
  }

  // snapper sur la route la plus proche
  let finalCoords = coords;
  try {
    finalCoords = await snapToRoad(coords.lat, coords.lng);
  } catch (_) {}

  // injecter dans les champs cachés du formulaire
  const latInput = document.getElementById('t-lat');
  const lngInput = document.getElementById('t-lng');
  if (latInput) latInput.value = finalCoords.lat;
  if (lngInput) lngInput.value = finalCoords.lng;

  // sauvegarder correction apprise si on a l'adresse d'origine
  const origAddr = document.getElementById('f-rue')?.value
                || document.getElementById('patient-address')?.value || '';
  if (origAddr && patientId) {
    const correctedAddr = await reverseGeocode(finalCoords.lat, finalCoords.lng);
    await saveLearnedCorrection(origAddr, correctedAddr);
  }

  // mettre à jour le patient en base si patientId fourni
  if (patientId) {
    const patients = await loadSecure('patients', 'list') || [];
    const patient  = patients.find(p => p.id === patientId);
    if (patient) {
      patient.lat      = finalCoords.lat;
      patient.lng      = finalCoords.lng;
      patient.geoScore = 95; // correction manuelle = très fiable
      await saveSecure('patients', 'list', patients);
    }
  }

  disableCorrectionMode();
  showToast('Position validée et sauvegardée ✓');
}

// ─────────────────────────────────────────────────────────────
//  DÉSACTIVER le mode correction
// ─────────────────────────────────────────────────────────────
function disableCorrectionMode() {
  correctionMode = false;
  APP.map.off('click', _onMapClickCorrection);
  APP.map.getContainer().style.cursor = '';

  if (correctionMarker) {
    APP.map.removeLayer(correctionMarker);
    correctionMarker = null;
  }
}

// ─────────────────────────────────────────────────────────────
//  TAP-TO-CORRECT PATIENT — correction position dans la tournée
//  Branché sur IDB patients.js ET APP.importedData (tournée live)
//  Appelé depuis les popups markers de la carte tournée IA.
// ─────────────────────────────────────────────────────────────

let _patCorrectMode    = false;
let _patCorrectMarker  = null;
let _patCorrectData    = null; // { patientId, idx, originalLat, originalLng }

/**
 * Active le mode correction tactile pour un patient de la tournée.
 * @param {string|number} patientId  - id du patient (IDB)
 * @param {number}        idx        - index dans APP.importedData.patients
 * @param {number}        lat
 * @param {number}        lng
 * @param {string}        nom        - nom affiché dans le toast
 */
function enablePatientCorrection(patientId, idx, lat, lng, nom) {
  const _map = (APP.map && typeof APP.map.invalidateSize === 'function')
    ? APP.map : APP.map?.instance;
  if (!_map) { if (typeof showToast === 'function') showToast('Carte non disponible'); return; }

  // Désactiver un mode précédent
  _disablePatientCorrection();

  _patCorrectMode = true;
  _patCorrectData = { patientId, idx, originalLat: lat, originalLng: lng, nom: nom || 'Patient' };

  // Bannière flottante sur la carte
  _showCorrectBanner(nom || 'Patient', _map);

  // Marker draggable rouge pulsant
  _patCorrectMarker = L.marker([lat, lng], {
    draggable: true,
    zIndexOffset: 1000,
    icon: L.divIcon({
      className: '',
      html: `<div style="
        width:38px;height:38px;
        background:#ff5f6d;
        border:3px solid white;
        border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        font-size:16px;
        box-shadow:0 0 0 0 rgba(255,95,109,0.6);
        animation:pulse-red 1.5s infinite;">✎</div>
      <style>
        @keyframes pulse-red {
          0%   { box-shadow: 0 0 0 0 rgba(255,95,109,0.6); }
          70%  { box-shadow: 0 0 0 10px rgba(255,95,109,0); }
          100% { box-shadow: 0 0 0 0 rgba(255,95,109,0); }
        }
      </style>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    }),
  }).addTo(_map);

  _map.setView([lat, lng], Math.max(_map.getZoom(), 17));
  _map.getContainer().style.cursor = 'crosshair';

  // Tap sur carte → déplace le marker
  _map.on('click', _onPatCorrectClick);

  // Drag → feedback vibration
  _patCorrectMarker.on('drag', e => {
    const { lat: la, lng: lo } = e.target.getLatLng();
    _updateCorrectBannerCoords(la, lo);
    if (navigator.vibrate) navigator.vibrate(20);
  });

  _patCorrectMarker.on('dragend', e => {
    const { lat: la, lng: lo } = e.target.getLatLng();
    _updateCorrectBannerCoords(la, lo);
    if (navigator.vibrate) navigator.vibrate(40);
  });

  if (typeof showToast === 'function')
    showToast(`✏️ Tapez ou glissez pour corriger la position de ${nom || 'ce patient'}`);
}

function _onPatCorrectClick(e) {
  if (!_patCorrectMode || !_patCorrectMarker) return;
  const { lat, lng } = e.latlng;
  _patCorrectMarker.setLatLng([lat, lng]);
  _updateCorrectBannerCoords(lat, lng);
  if (navigator.vibrate) navigator.vibrate(40);
}

function _showCorrectBanner(nom, mapInstance) {
  // Supprimer bannière existante
  const old = document.getElementById('pat-correct-banner');
  if (old) old.remove();

  const banner = document.createElement('div');
  banner.id = 'pat-correct-banner';
  banner.style.cssText = `
    position:absolute;bottom:70px;left:50%;transform:translateX(-50%);
    background:rgba(20,20,30,0.92);color:#fff;border-radius:14px;
    padding:10px 16px;font-size:13px;font-family:var(--fm,monospace);
    z-index:9999;display:flex;flex-direction:column;align-items:center;gap:8px;
    white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,0.4);
    border:1px solid rgba(255,95,109,0.4);min-width:220px;`;
  banner.innerHTML = `
    <div style="font-weight:600;color:#ff5f6d">✏️ Correction position : ${nom}</div>
    <div id="pat-correct-coords" style="font-size:11px;color:rgba(255,255,255,0.6)">Tapez ou glissez le marqueur</div>
    <div style="display:flex;gap:8px;margin-top:2px">
      <button onclick="_confirmPatientCorrection()" style="
        background:#00d4aa;color:#fff;border:none;border-radius:8px;
        padding:7px 16px;font-size:13px;cursor:pointer;font-weight:600;">✅ Valider</button>
      <button onclick="_disablePatientCorrection()" style="
        background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);
        border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;">Annuler</button>
    </div>`;

  // Insérer dans le container de la carte
  const mapContainer = (APP.map && typeof APP.map.getContainer === 'function')
    ? APP.map.getContainer()
    : document.getElementById('dep-map');
  if (mapContainer) {
    mapContainer.style.position = 'relative';
    mapContainer.appendChild(banner);
  } else {
    document.body.appendChild(banner);
  }
}

function _updateCorrectBannerCoords(lat, lng) {
  const el = document.getElementById('pat-correct-coords');
  if (el) el.textContent = `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

async function _confirmPatientCorrection() {
  if (!_patCorrectMarker || !_patCorrectData) return;

  const { lat, lng } = _patCorrectMarker.getLatLng();
  const { patientId, idx, nom } = _patCorrectData;

  // 1. Snap sur la route la plus proche (OSRM)
  let finalLat = lat, finalLng = lng;
  try {
    const snapped = await snapToRoad(lat, lng);
    if (snapped) { finalLat = snapped.lat; finalLng = snapped.lng; }
  } catch (_) {}

  // 2. Mettre à jour APP.importedData (tournée en cours)
  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  if (idx != null && patients[idx]) {
    patients[idx].lat      = finalLat;
    patients[idx].lng      = finalLng;
    patients[idx].geoScore = 95; // correction manuelle = très fiable
    if (typeof storeImportedData === 'function') {
      storeImportedData({ ...APP.importedData, patients });
    }
  }

  // 3. Sauvegarder dans l'IDB patients (carnet) si patientId fourni
  if (patientId && typeof _idbGetAll === 'function') {
    try {
      const rows = await _idbGetAll('ami_patients');
      const row  = rows.find(r => r.id === patientId);
      if (row) {
        const p = { id: row.id, nom: row.nom, prenom: row.prenom,
                    ...(typeof _dec === 'function' ? (_dec(row._data) || {}) : {}) };
        p.lat      = finalLat;
        p.lng      = finalLng;
        p.geoScore = 95;
        const toStore = {
          id:         p.id,
          nom:        p.nom,
          prenom:     p.prenom,
          _data:      typeof _enc === 'function' ? _enc(p) : row._data,
          updated_at: new Date().toISOString(),
        };
        if (typeof _idbPut === 'function') await _idbPut('ami_patients', toStore);
      }
    } catch (_) {}
  }

  // 4. Vider le cache géo pour cette adresse (évite de recharger les mauvaises coords)
  if (patients[idx]?.adresse && typeof saveSecure === 'function' && typeof hashAddr === 'function') {
    try { await saveSecure('geocache', hashAddr(patients[idx].adresse), null); } catch (_) {}
  }

  // 5. Fermer le mode correction
  _disablePatientCorrection();

  // 6. Rafraîchir la carte avec les nouvelles positions
  const startPoint = APP.get('startPoint');
  if (typeof renderPatientsOnMap === 'function' && patients.length) {
    renderPatientsOnMap(patients, startPoint).catch(() => {});
  }

  if (typeof showToast === 'function')
    showToast(`✅ Position de ${nom} corrigée et sauvegardée`);
}

function _disablePatientCorrection() {
  const _map = (APP.map && typeof APP.map.invalidateSize === 'function')
    ? APP.map : APP.map?.instance;

  _patCorrectMode = false;
  _patCorrectData = null;

  if (_patCorrectMarker && _map) {
    try { _map.removeLayer(_patCorrectMarker); } catch (_) {}
    _patCorrectMarker = null;
  }
  if (_map) {
    _map.off('click', _onPatCorrectClick);
    _map.getContainer().style.cursor = '';
  }

  const banner = document.getElementById('pat-correct-banner');
  if (banner) banner.remove();
}


//  Utilisé dans Tournée IA et Pilotage Live
//  Marker "maison" draggable sur dep-map ou live-dep-map
// ─────────────────────────────────────────────────────────────

let _startPtMarker  = null;
let _startPtMode    = false;
let _startPtMapInst = null; // référence à la carte active (dep-map ou live-dep-map)

/**
 * Active le mode correction du point de départ sur la carte passée en argument.
 * @param {L.Map} mapInstance   - instance Leaflet de la carte cible
 * @param {number} lat
 * @param {number} lng
 * @param {Function} onConfirm  - callback(lat, lng, addrStr) appelé à la validation
 */
function enableStartPointCorrection(mapInstance, lat, lng, onConfirm) {
  _startPtMode    = true;
  _startPtMapInst = mapInstance;

  // Supprimer l'ancien marker s'il existe
  if (_startPtMarker) {
    try { mapInstance.removeLayer(_startPtMarker); } catch(_) {}
    _startPtMarker = null;
  }

  _startPtMarker = L.marker([lat, lng], {
    draggable: true,
    icon: L.divIcon({
      className: '',
      html: `<div style="
        width:38px;height:38px;
        background:#00d4aa;
        border:3px solid white;
        border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        font-size:18px;
        box-shadow:0 3px 12px rgba(0,212,170,0.55);
        cursor:grab;">🏠</div>`,
      iconSize:   [38, 38],
      iconAnchor: [19, 19],
    }),
  })
  .addTo(mapInstance)
  .bindPopup('<strong>Point de départ</strong><br><small>Glissez pour ajuster</small>')
  .openPopup();

  mapInstance.setView([lat, lng], 17);
  mapInstance.getContainer().style.cursor = 'crosshair';

  // Tap sur la carte → déplace le marker
  mapInstance.on('click', _onStartPtClick);

  // Drag terminé → reverse geocode
  _startPtMarker.on('dragend', async e => {
    const { lat: la, lng: lo } = e.target.getLatLng();
    if (navigator.vibrate) navigator.vibrate(40);
    await _updateStartPtDisplay(la, lo);
  });

  // Drag en cours → stocker coords temps réel
  _startPtMarker.on('drag', e => {
    const { lat: la, lng: lo } = e.target.getLatLng();
    APP.set('startPtTemp', { lat: la, lng: lo, onConfirm });
  });

  // Stocker le callback pour la validation
  APP.set('startPtTemp', { lat, lng, onConfirm });

  showToast('📍 Tapez ou glissez le marqueur pour ajuster le départ');
}

function _onStartPtClick(e) {
  if (!_startPtMode || !_startPtMarker) return;
  const { lat, lng } = e.latlng;
  _startPtMarker.setLatLng([lat, lng]);
  if (navigator.vibrate) navigator.vibrate(40);
  _updateStartPtDisplay(lat, lng);
}

async function _updateStartPtDisplay(lat, lng) {
  const stored = APP.get('startPtTemp') || {};
  APP.set('startPtTemp', { ...stored, lat, lng });

  try {
    const addr = await reverseGeocode(lat, lng);
    // Mettre à jour les champs visibles dep-addr et live-dep-addr
    const depAddr  = document.getElementById('dep-addr');
    const liveAddr = document.getElementById('live-dep-addr');
    if (depAddr)  depAddr.value  = addr;
    if (liveAddr) liveAddr.value = addr;

    // Mettre à jour le texte de coordonnées
    const coordsTxt = document.getElementById('dep-coords');
    const liveTxt   = document.getElementById('live-dep-coords');
    const txt = `📍 ${addr}`;
    if (coordsTxt) { coordsTxt.textContent = txt; coordsTxt.style.display = 'block'; }
    if (liveTxt)   { liveTxt.textContent   = txt; liveTxt.style.display   = 'block'; }

    APP.set('startPtTemp', { ...APP.get('startPtTemp'), addr });
    showToast('Adresse mise à jour');
  } catch (_) {}
}

/**
 * Valide la position du point de départ corrigée.
 * Snape sur route → injecte t-lat/t-lng → appelle onConfirm.
 */
async function confirmStartPointCorrection() {
  const stored = APP.get('startPtTemp');
  if (!stored || !stored.lat || !stored.lng) {
    showToast('Aucune position sélectionnée');
    return;
  }

  // Snap sur route
  let coords = stored;
  try {
    coords = await snapToRoad(stored.lat, stored.lng);
    coords.addr = stored.addr;
  } catch(_) {}

  // Injecter dans les champs cachés (communs aux deux sections)
  const latEl = document.getElementById('t-lat');
  const lngEl = document.getElementById('t-lng');
  if (latEl) latEl.value = coords.lat;
  if (lngEl) lngEl.value = coords.lng;

  // Persister le point de départ dans APP
  APP.set('startPoint', { lat: coords.lat, lng: coords.lng });

  // Afficher les coords
  const txt = `✅ Départ confirmé — ${coords.addr || coords.lat.toFixed(5) + ', ' + coords.lng.toFixed(5)}`;
  const coordsTxt = document.getElementById('dep-coords');
  const liveTxt   = document.getElementById('live-dep-coords');
  if (coordsTxt) { coordsTxt.textContent = txt; coordsTxt.style.display = 'block'; }
  if (liveTxt)   { liveTxt.textContent   = txt; liveTxt.style.display   = 'block'; }

  // Callback optionnel
  if (typeof stored.onConfirm === 'function') stored.onConfirm(coords.lat, coords.lng, coords.addr);

  disableStartPointCorrection();

  // Fermer les panneaux d'édition (Tournée IA + Pilotage Live)
  const editorTur  = document.getElementById('start-editor');
  const editorLive = document.getElementById('live-start-editor');
  if (editorTur)  editorTur.style.display  = 'none';
  if (editorLive) editorLive.style.display = 'none';

  showToast('🏠 Point de départ enregistré ✓');
}

function disableStartPointCorrection() {
  _startPtMode = false;
  if (_startPtMapInst) {
    try { _startPtMapInst.off('click', _onStartPtClick); } catch(_) {}
    try { _startPtMapInst.getContainer().style.cursor = ''; } catch(_) {}
    if (_startPtMarker) {
      try { _startPtMapInst.removeLayer(_startPtMarker); } catch(_) {}
      _startPtMarker = null;
    }
  }
  _startPtMapInst = null;
}

/**
 * Point d'entrée appelé par les boutons "Ajuster sur la carte".
 * Détermine les coordonnées initiales (GPS ou t-lat/t-lng ou centre France)
 * et initialise la carte cible (dep-map pour Tournée, live-dep-map pour Pilotage).
 * @param {'tur'|'live'} context - quelle section appelle la correction
 */
async function openStartPointEditor(context) {
  // Récupérer les coords actuelles
  let lat = parseFloat(document.getElementById('t-lat')?.value) || APP.get('startPoint')?.lat;
  let lng = parseFloat(document.getElementById('t-lng')?.value) || APP.get('startPoint')?.lng;

  // Fallback : position GPS de l'appareil
  if (!lat || !lng) {
    showToast('Récupération de votre position GPS…');
    try {
      const pos = await new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 6000 })
      );
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
    } catch (_) {
      // Fallback : centre de la France
      lat = 46.5; lng = 2.3;
      showToast('GPS indisponible — centré sur la France');
    }
  }

  const mapContainerId = context === 'live' ? 'live-dep-map' : 'dep-map';
  const panelId        = context === 'live' ? 'live-start-editor' : 'start-editor';

  // Afficher le panneau d'édition
  const panel = document.getElementById(panelId);
  if (panel) panel.style.display = 'block';

  // Obtenir ou créer l'instance Leaflet pour le conteneur cible
  let mapInst;
  const appMapEl = document.getElementById('dep-map');

  if (context === 'live') {
    // Pour le pilotage live : créer une carte dédiée si pas encore init
    if (!APP._liveDepMap) {
      const container = document.getElementById('live-dep-map');
      if (!container) return;
      APP._liveDepMap = L.map('live-dep-map', { zoomControl: true }).setView([lat, lng], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19,
      }).addTo(APP._liveDepMap);
    }
    mapInst = APP._liveDepMap;
    setTimeout(() => { try { mapInst.invalidateSize(); } catch(_){} }, 150);
  } else {
    // Section Tournée : utiliser APP.map (dep-map, déjà init par extras.js)
    mapInst = (APP.map && typeof APP.map.invalidateSize === 'function') ? APP.map : APP.map?.instance;
    if (!mapInst) {
      showToast('Carte non disponible');
      return;
    }
  }

  enableStartPointCorrection(mapInst, lat, lng, (la, lo, addr) => {
    // Synchroniser les deux champs
    const latEl = document.getElementById('t-lat');
    const lngEl = document.getElementById('t-lng');
    if (latEl) latEl.value = la;
    if (lngEl) lngEl.value = lo;
    APP.set('startPoint', { lat: la, lng: lo });
    if (typeof showToast === 'function') showToast('✅ Départ mis à jour');
  });
}

// ─────────────────────────────────────────────────────────────
//  Utiliser la position GPS de l'appareil
// ─────────────────────────────────────────────────────────────
function useMyLocation(patientId) {
  if (!navigator.geolocation) {
    showToast('Géolocalisation non disponible');
    return;
  }

  showToast('Récupération de votre position…');

  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      enableCorrectionMode(lat, lng);
      await _reverseAndUpdate(lat, lng);
      APP.set('tempCoords', { lat, lng });
    },
    err => {
      console.warn('[GPS]', err.message);
      showToast('Impossible d\'obtenir la position GPS');
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

// ─────────────────────────────────────────────────────────────
//  Afficher tous les patients sur la carte
// ─────────────────────────────────────────────────────────────
function renderPatientsOnMap(patients) {
  if (!APP.map) return;

  // supprimer les markers existants
  if (APP.markers) {
    APP.markers.forEach(m => APP.map.removeLayer(m));
  }
  APP.markers = [];

  patients.forEach((p, idx) => {
    if (!p.lat || !p.lng) return;

    const color = p.geoScore >= 70 ? '#1D9E75'
                : p.geoScore >= 50 ? '#EF9F27'
                : '#E24B4A';

    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div style="
          width:32px;height:32px;
          background:${color};
          border:2px solid white;
          border-radius:50%;
          display:flex;align-items:center;justify-content:center;
          font-size:12px;font-weight:600;color:white;
          box-shadow:0 2px 6px rgba(0,0,0,0.25);">
          ${idx + 1}
        </div>`,
        iconSize:   [32, 32],
        iconAnchor: [16, 16],
      }),
    });

    // Construire les champs d'affichage proprement
    const _name    = ((p.nom||'') + ' ' + (p.prenom||'')).trim()
                   || p.name || p.patient || p.label || p.description || ('Patient ' + (idx+1));
    const _addr    = (p.adresse || p.addressFull || p.address || '').replace(/🕐[^,]*/g,'').trim().replace(/,\s*$/, '');
    const _heure   = p.heure_preferee || p.heure_soin || p.heure || '';
    const _score   = typeof p.geoScore === 'number' ? p.geoScore : (p.geoScore ? parseInt(p.geoScore) : 0);
    const _navData = JSON.stringify({
      lat: p.lat, lng: p.lng,
      address: _addr, addressFull: _addr, adresse: _addr,
      geoScore: _score
    }).replace(/"/g, '&quot;');

    marker.bindPopup(`
      <strong>${_name}</strong><br>
      ${_addr ? `<span style="font-size:12px">${_addr}</span><br>` : ''}
      ${_heure ? `<span style="font-size:11px;color:#888">🕐 ${_heure}</span><br>` : ''}
      <small style="color:${_score>=70?'#1D9E75':_score>=50?'#EF9F27':'#E24B4A'}">Score géo : ${_score}/100</small><br>
      <a href="#" onclick="openNavigation(${_navData})">Naviguer</a> |
      <a href="#" onclick="enableCorrectionMode(${p.lat}, ${p.lng})">Corriger position</a>
    `);

    marker.addTo(APP.map);
    APP.markers.push(marker);
  });
}

// ─────────────────────────────────────────────────────────────
//  Recherche d'adresse pour le point de départ du Pilotage Live
// ─────────────────────────────────────────────────────────────

async function searchLiveStartPoint() {
  const input = document.getElementById('live-dep-addr');
  if (!input || !input.value.trim()) return;

  showToast('Recherche en cours…');
  try {
    const processed = await processAddressBeforeGeocode(input.value.trim(), null);
    const geo = await smartGeocode(processed);
    if (!geo) throw new Error('Adresse introuvable');

    // Injecter dans les champs partagés
    const latEl = document.getElementById('t-lat');
    const lngEl = document.getElementById('t-lng');
    if (latEl) latEl.value = geo.lat;
    if (lngEl) lngEl.value = geo.lng;
    APP.set('startPoint', { lat: geo.lat, lng: geo.lng });

    // Mettre à jour l'affichage coords
    const liveTxt = document.getElementById('live-dep-coords');
    if (liveTxt) {
      liveTxt.textContent = `✅ Départ — ${input.value.trim()} (score: ${computeGeoScore(input.value.trim(), geo)}/100)`;
      liveTxt.style.display = 'block';
    }

    showToast('Point de départ mis à jour');

    // Ouvrir l'éditeur carte pour permettre l'ajustement fin
    await openStartPointEditor('live');

  } catch(e) {
    showToast('❌ Adresse introuvable — essayez d\'ajuster sur la carte');
  }
}

async function useLiveMyLocation() {
  if (!navigator.geolocation) { showToast('GPS non disponible'); return; }
  showToast('Récupération de votre position…');
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      const latEl = document.getElementById('t-lat');
      const lngEl = document.getElementById('t-lng');
      if (latEl) latEl.value = lat;
      if (lngEl) lngEl.value = lng;
      APP.set('startPoint', { lat, lng });

      const addr = await reverseGeocode(lat, lng);
      const inputEl = document.getElementById('live-dep-addr');
      if (inputEl) inputEl.value = addr;
      const liveTxt = document.getElementById('live-dep-coords');
      if (liveTxt) { liveTxt.textContent = `📍 ${addr}`; liveTxt.style.display = 'block'; }

      showToast('Position GPS obtenue ✓');
      await openStartPointEditor('live');
    },
    err => showToast('Impossible d\'obtenir la position GPS'),
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

//  Accepte (patients, startPoint?) — retourne une Promise
//  Compatible avec tournee.js qui appelle .catch()
// ─────────────────────────────────────────────────────────────
(function() {
  // Remplacement dynamique pour éviter les problèmes de redéclaration
  window.renderPatientsOnMap = function(patients, startPoint) {
    return new Promise((resolve, reject) => {
      try {
        // Résoudre l'instance Leaflet réelle — APP.map peut être l'instance directe
        // (assignée par extras.js) ou APP.map.instance (namespace utils.js)
        const _map = (APP.map && typeof APP.map.invalidateSize === 'function')
          ? APP.map
          : APP.map?.instance;
        if (!_map || typeof _map.invalidateSize !== 'function') { resolve(); return; }
        // Réassigner APP.map à l'instance pour que le reste du code fonctionne
        APP.map = _map;

        // Supprimer layers existants
        if (APP.markers) APP.markers.forEach(m => { try { APP.map.removeLayer(m); } catch(_){} });
        APP.markers = [];
        if (APP._routePolyline) { try { APP.map.removeLayer(APP._routePolyline); } catch(_){} APP._routePolyline = null; }
        if (APP._startMarker)   { try { APP.map.removeLayer(APP._startMarker);   } catch(_){} APP._startMarker = null; }

        const withCoords = patients.filter(p => p.lat && p.lng);
        if (!withCoords.length) { resolve(); return; }

        // Marker point de départ
        if (startPoint && startPoint.lat && startPoint.lng) {
          APP._startMarker = L.marker([startPoint.lat, startPoint.lng], {
            icon: L.divIcon({
              className: '',
              html: '<div style="width:36px;height:36px;background:#00d4aa;border:3px solid white;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 3px 10px rgba(0,212,170,0.5);">🏠</div>',
              iconSize: [36,36], iconAnchor: [18,18],
            }),
          }).addTo(APP.map);
          APP._startMarker.bindPopup('<strong>Point de départ</strong>');
        }

        patients.forEach((p, idx) => {
          if (!p.lat || !p.lng) return;
          const isUrgent = !!(p.urgent || p.urgence);
          const color = isUrgent ? '#E24B4A'
                      : (p.geoScore >= 70) ? '#1D9E75'
                      : (p.geoScore >= 50) ? '#EF9F27'
                      : '#00d4aa';

          const marker = L.marker([p.lat, p.lng], {
            icon: L.divIcon({
              className: '',
              html: '<div style="width:32px;height:32px;background:' + color + ';border:2px solid white;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:white;box-shadow:0 2px 8px rgba(0,0,0,0.3);">' + (idx+1) + '</div>',
              iconSize: [32,32], iconAnchor: [16,16],
            }),
          });

          const nomAff     = p.description || p.name || p.texte || ('Patient ' + (idx+1));
          const adresseAff = p.adresse || p.address || p.addressFull || '';
          const heure      = p.heure_soin || p.heure_preferee || p.heure || '';
          const patId      = p.id || p.patient_id || '';

          var popupContent = '<strong style="font-size:13px">' + nomAff + '</strong>';
          if (adresseAff) popupContent += '<br><span style="font-size:11px;color:#666">' + adresseAff + '</span>';
          if (heure)      popupContent += '<br><span style="font-size:11px">🕐 ' + heure + '</span>';
          if (isUrgent)   popupContent += '<br><span style="color:#E24B4A;font-size:11px">🚨 URGENT</span>';
          if (p.geoScore != null) popupContent += '<br><small style="color:#999">Score géo : ' + p.geoScore + '/100</small>';
          popupContent += '<br><div style="display:flex;gap:6px;margin-top:6px">'
            + '<a href="#" style="font-size:11px;background:#ff5f6d;color:#fff;padding:3px 8px;border-radius:6px;text-decoration:none" '
            + 'onclick="enablePatientCorrection(\'' + patId + '\',' + idx + ',' + p.lat + ',' + p.lng + ',\'' + nomAff.replace(/'/g,'\\'+'\'') + '\');return false;">✏️ Corriger position</a>'
            + '</div>';

          marker.bindPopup(popupContent);
          marker.addTo(APP.map);
          APP.markers.push(marker);
        });

        // Polyline de la route
        var allPts = [];
        if (startPoint && startPoint.lat && startPoint.lng) allPts.push([startPoint.lat, startPoint.lng]);
        withCoords.forEach(function(p) { allPts.push([p.lat, p.lng]); });
        if (allPts.length >= 2) {
          APP._routePolyline = L.polyline(allPts, { color:'#00d4aa', weight:3, opacity:0.7, dashArray:'6,8' }).addTo(APP.map);
        }

        // Ajuster la vue
        APP.map.fitBounds(L.latLngBounds(allPts), { padding:[40,40], maxZoom:15 });

        // Forcer recalcul taille Leaflet (évite la carte grise après navigation)
        setTimeout(function() { try { APP.map.invalidateSize(); } catch(_){} }, 150);
        setTimeout(function() { try { APP.map.invalidateSize(); } catch(_){} }, 400);

        resolve();
      } catch(e) {
        reject(e);
      }
    });
  };
})();
