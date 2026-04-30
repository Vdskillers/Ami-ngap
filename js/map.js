// ─────────────────────────────────────────────────────────────
//  map.js
//  Carte Leaflet + système tap-to-correct
//  Correction manuelle de position : tap carte, drag marker
//  Reverse geocoding automatique après correction
// ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════
//  PATCH PERFORMANCE : willReadFrequently par défaut sur canvas 2D
//  ───────────────────────────────────────────────────────────
//  leaflet-heat.js (plugin tiers chargé via CDN) crée des canvas 2D
//  et y exécute plusieurs getImageData() sans le flag willReadFrequently,
//  ce qui déclenche le warning :
//    "Canvas2D: Multiple readback operations using getImageData are
//     faster with the willReadFrequently attribute set to true."
//
//  On patche HTMLCanvasElement.prototype.getContext pour ajouter
//  willReadFrequently:true par défaut sur les contexts 2D, UNIQUEMENT
//  quand l'appelant n'a pas fourni d'options. Aucun impact sur les
//  contexts WebGL/2D existants qui spécifient déjà leurs options.
//  Le flag est un simple hint de performance — aucune régression possible.
//  Idempotent : marqueur _amiPatched pour éviter une double-application.
// ═══════════════════════════════════════════════════════════════
(function patchCanvasGetContext() {
  if (typeof HTMLCanvasElement === 'undefined') return;
  const proto = HTMLCanvasElement.prototype;
  if (proto._amiPatched) return;
  const orig = proto.getContext;
  proto.getContext = function(type, attrs) {
    if (type === '2d' && (attrs == null || typeof attrs !== 'object')) {
      return orig.call(this, type, { willReadFrequently: true });
    }
    if (type === '2d' && typeof attrs === 'object' && attrs.willReadFrequently === undefined) {
      attrs.willReadFrequently = true;
    }
    return orig.call(this, type, attrs);
  };
  proto._amiPatched = true;
})();

// ═══════════════════════════════════════════════════════════════
//  v9.4 — Décodeur de polyline encodée (format Google/OSRM)
//  ───────────────────────────────────────────────────────────
//  OSRM peut renvoyer geometry sous forme de string polyline encodée
//  (précision 5 par défaut) au lieu de GeoJSON, même quand on demande
//  `geometries=geojson` — observé sur le serveur public router.project-osrm.org
//  selon les versions / charges.
//  Ce décodeur convertit la string en tableau [[lat,lng], ...] pour Leaflet.
// ═══════════════════════════════════════════════════════════════
function decodeOsrmPolyline(str, precision) {
  if (typeof str !== 'string' || !str.length) return [];
  precision = precision || 5;
  const factor = Math.pow(10, precision);
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < str.length) {
    let result = 1, shift = 0, b;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    result = 1; shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;

    coords.push([lat / factor, lng / factor]); // [lat, lng] — direct pour Leaflet
  }
  return coords;
}
window.decodeOsrmPolyline = decodeOsrmPolyline;

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
//  v9.2 — Suppression de la version legacy `function renderPatientsOnMap`
//  qui prenait la priorité sur la version IIFE moderne via hoisting,
//  empêchant l'affichage du tracé OSRM et du marker point de départ.
//  La seule définition active est désormais `window.renderPatientsOnMap`
//  ci-dessous (lignes ~720+).
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
//  v9.2 — Sortie de l'IIFE (la déclaration legacy a été supprimée plus haut),
//  assignation directe à window.renderPatientsOnMap pour éviter toute
//  ambiguïté de hoisting / shadowing.
// ─────────────────────────────────────────────────────────────
window.renderPatientsOnMap = function(patients, startPoint) {
    return new Promise((resolve, reject) => {
      try {
        // Résoudre l'instance Leaflet réelle — APP.map peut être l'instance directe
        // (assignée par extras.js) ou APP.map.instance (namespace utils.js)
        const _map = (APP.map && typeof APP.map.invalidateSize === 'function')
          ? APP.map
          : APP.map?.instance;
        if (!_map || typeof _map.invalidateSize !== 'function') {
          resolve(); return;
        }
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

        // ── Tracé de la route sur route réelle (OSRM) ──────────────────────
        var allPts = [];
        if (startPoint && startPoint.lat && startPoint.lng) allPts.push([startPoint.lat, startPoint.lng]);
        withCoords.forEach(function(p) { allPts.push([p.lat, p.lng]); });

        if (allPts.length >= 2) {
          // ⚠️ MOBILE FIX : sur mobile, le conteneur Leaflet a souvent
          // une taille 0×0 au premier paint (layout pas stabilisé).
          // Sans invalidateSize() AVANT fitBounds, la map calcule ses
          // bounds contre un viewport nul → la polyline OSRM atterrit
          // hors-champ et l'utilisateur ne voit que les markers.
          try { APP.map.invalidateSize(); } catch(_) {}

          // Cadrer la vue sur les markers connus immédiatement
          // (avant le fetch OSRM, pour que la map soit déjà bien positionnée).
          APP.map.fitBounds(L.latLngBounds(allPts), { padding: [40, 40], maxZoom: 15 });

          // v9.3 — Plus de polyline droite pointillée temporaire.
          // On attend la vraie géométrie OSRM puis on l'affiche directement.
          // OSRM répond généralement en 200-500ms → perception instantanée.
          // Si OSRM échoue → pas de tracé du tout (UX préférée à un pointillé).
          (async function() {
            try {
              const coords = allPts.map(function(pt) { return pt[1] + ',' + pt[0]; }).join(';');

              // v9.6 — Bug du SW corrigé (cache des API externes désactivé).
              // OSRM honore correctement `geometries=geojson` quand on bypass
              // le cache du Service Worker. Le décodeur polyline reste en
              // fallback au cas où le serveur retournerait du polyline string.
              const url = 'https://router.project-osrm.org/route/v1/driving/' + coords
                + '?overview=full&geometries=geojson&steps=false';

              const data = (typeof window._osrmFetchSafe === 'function')
                ? await window._osrmFetchSafe(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined })
                : await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined }).then(r => r.json()).catch(() => null);

              if (!data || data.code !== 'Ok' || !data.routes || !data.routes[0]) return;
              const geom = data.routes[0].geometry;

              // Décodage adaptatif : objet GeoJSON OU string polyline encodée
              let latlngs = null;
              if (geom && typeof geom === 'object' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
                latlngs = geom.coordinates.map(function(c) { return [c[1], c[0]]; });
              }
              else if (typeof geom === 'string' && geom.length > 0
                       && typeof window.decodeOsrmPolyline === 'function') {
                latlngs = window.decodeOsrmPolyline(geom, 5);
              }

              if (!latlngs || latlngs.length < 2) return;

              // ⚠️ Re-invalidateSize JUSTE AVANT d'ajouter la route :
              // sur mobile, le container peut avoir été redimensionné
              // entre le premier rendu et l'arrivée de la réponse OSRM.
              try { APP.map.invalidateSize(); } catch(_) {}

              // Dessiner la vraie route routière (turquoise plein)
              APP._routePolyline = L.polyline(latlngs, {
                color:   '#00d4aa',
                weight:  4,
                opacity: 0.85,
              }).addTo(APP.map);

              // Ré-ajuster la vue sur la vraie géométrie (englobe tous les détours)
              APP.map.fitBounds(APP._routePolyline.getBounds(), { padding: [40, 40], maxZoom: 15 });

            } catch(e) {
              // Silencieux — pas de tracé visible si OSRM KO
              console.warn('[MAP-OSRM] OSRM fetch/draw KO:', e?.message || e);
            }
          })();
        }

        // Dernier filet de sécurité : repaint forcé après stabilisation
        // du layout (surtout mobile). Si la route est arrivée entre-temps,
        // on re-cale la vue dessus.
        setTimeout(function() {
          try {
            APP.map.invalidateSize();
            if (APP._routePolyline) {
              APP.map.fitBounds(APP._routePolyline.getBounds(), { padding: [40, 40], maxZoom: 15 });
            }
          } catch(_){}
        }, 400);

        resolve();
      } catch(e) {
        reject(e);
      }
    });
};

/* ════════════════════════════════════════════════
   HEATMAP DES ZONES RENTABLES — v1.0
   ────────────────────────────────────────────────
   computeHeatmap(cotations) — agrège les données par grille géo
   renderHeatmap(grid)       — affiche le calque Leaflet heatmap
   showHeatmapPanel()        — ouvre le panneau zones rentables
   hideHeatmapPanel()        — ferme le panneau
════════════════════════════════════════════════ */

let _heatmapLayer    = null;
let _heatmapVisible  = false;
let _heatmapPanelOpen = false;   // v5.10.4 : état "panneau ouvert" indépendant du layer
let _heatmapMarkers  = [];       // ⚡ FIX zones-sur-carte : markers visibles superposés au heatmap

/**
 * gridKey — clé de grille géographique (précision ~110m par défaut)
 */
function gridKey(lat, lng, precision = 3) {
  return `${parseFloat(lat).toFixed(precision)}_${parseFloat(lng).toFixed(precision)}`;
}

/**
 * computeHeatmap — agrège les cotations par zone géographique
 * @param {Array} cotations — [ { lat, lng, total, km?, duration? }, … ]
 * @returns {Object} grid — { "lat_lng": { revenue, count, km, time, … } }
 */
function computeHeatmap(cotations) {
  const grid = {};

  for (const c of (cotations || [])) {
    if (!c.lat || !c.lng) continue;

    const key = gridKey(c.lat, c.lng);

    if (!grid[key]) {
      grid[key] = { revenue: 0, count: 0, km: 0, time: 0, lat: +c.lat, lng: +c.lng };
    }

    grid[key].revenue += parseFloat(c.total  || 0);
    grid[key].count   += 1;
    grid[key].km      += parseFloat(c.km     || 0);
    grid[key].time    += parseFloat(c.duration || 0); // en secondes
  }

  // KPIs dérivés
  for (const k in grid) {
    const g = grid[k];
    g.revenue_per_visit = g.count  > 0 ? g.revenue / g.count          : g.revenue;
    g.revenue_per_km    = g.km     > 0 ? g.revenue / g.km              : g.revenue;
    g.revenue_per_hour  = g.time   > 0 ? g.revenue / (g.time / 3600)   : g.revenue;
  }

  return grid;
}

/**
 * renderHeatmap — affiche la heatmap sur la carte Leaflet + markers visibles
 * Nécessite le plugin Leaflet.heat (chargé si absent)
 * ⚡ FIX zones-sur-carte (v5.10.6) : ajoute des markers cerclés visibles pour
 *    chaque zone rentable, en plus du heatmap diffus. Avant ce fix, le heatmap
 *    Leaflet était bien ajouté mais à faible opacité, peu lisible et souvent
 *    hors écran si la vue était centrée ailleurs. Désormais chaque zone se voit
 *    par un cercle coloré (vert→orange→rouge selon le €/h) qui s'affiche
 *    **sans perturber** le routage ni la tournée actuelle.
 */
async function renderHeatmap(grid, metric = 'revenue_per_hour') {
  if (!APP.map) return;

  // Supprimer la couche précédente
  if (_heatmapLayer) {
    try { APP.map.removeLayer(_heatmapLayer); } catch(_) {}
    _heatmapLayer = null;
  }
  // Supprimer les markers visibles précédents
  _clearHeatmapMarkers();

  const entries = Object.values(grid).filter(g => g.lat && g.lng);
  if (!entries.length) return;

  // Normaliser les valeurs pour Leaflet.heat (0..1)
  const values = entries.map(g => g[metric] || g.revenue || 0);
  const maxVal = Math.max(...values, 1);

  const points = entries.map(g => [
    g.lat,
    g.lng,
    Math.min(1, (g[metric] || g.revenue || 0) / maxVal)
  ]);

  // Charger Leaflet.heat si absent
  if (typeof L.heatLayer !== 'function') {
    await _loadLeafletHeat();
  }

  if (typeof L.heatLayer === 'function') {
    _heatmapLayer = L.heatLayer(points, {
      radius:  35,
      blur:    25,
      maxZoom: 17,
      minOpacity: 0.45,
      gradient: { 0.2: '#3b82f6', 0.5: '#f59e0b', 0.8: '#ef4444', 1.0: '#7c3aed' },
    }).addTo(APP.map);
    _heatmapVisible = true;
  }

  // ⚡ FIX zones-sur-carte : markers cerclés visibles, indépendants du plugin heat
  // (fonctionnent même si Leaflet.heat n'a pas pu être chargé)
  _renderHeatmapMarkers(entries, metric, maxVal);

  return grid;
}

/**
 * _clearHeatmapMarkers — supprime tous les markers de zones rentables
 */
function _clearHeatmapMarkers() {
  if (!APP.map) return;
  for (const m of _heatmapMarkers) {
    try { APP.map.removeLayer(m); } catch(_) {}
  }
  _heatmapMarkers = [];
}

/**
 * _renderHeatmapMarkers — dessine un cercle visible par zone rentable.
 * Couleur : vert si €/h ≥ 35, orange si ≥ 20, rouge sinon.
 * Rayon : proportionnel au revenu de la zone (8..18 px).
 * Le marker NE remplace PAS les markers de tournée — il s'ajoute en couche
 * inférieure (zIndexOffset négatif) pour ne pas perturber l'interaction GPS.
 */
function _renderHeatmapMarkers(entries, metric, maxVal) {
  if (!APP.map || !entries.length) return;

  for (const g of entries) {
    const v = g[metric] || g.revenue || 0;
    const ratio = Math.min(1, v / maxVal);
    const radius = 8 + Math.round(ratio * 10); // 8..18 px

    // Couleur basée sur le €/h (revenue_per_hour)
    const eph = g.revenue_per_hour || 0;
    const color = eph >= 35 ? '#22c55e'
               : eph >= 20 ? '#f59e0b'
               : eph > 0   ? '#ef4444'
               : '#7c3aed';

    const circle = L.circleMarker([g.lat, g.lng], {
      radius,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.35,
      pane: 'overlayPane',
      interactive: true
    });

    const popupHtml = `
      <div style="font-family:system-ui,sans-serif;font-size:12px;line-height:1.5;min-width:160px">
        <div style="font-weight:700;color:${color};margin-bottom:4px">🔥 Zone rentable</div>
        <div><strong>${(g.revenue || 0).toFixed(2)} €</strong> · ${g.count || 0} cotation${(g.count||0)>1?'s':''}</div>
        ${eph > 0 ? `<div>⚡ <strong>${eph.toFixed(1)} €/h</strong></div>` : ''}
        ${g.revenue_per_visit ? `<div>👤 ${g.revenue_per_visit.toFixed(1)} €/visite</div>` : ''}
        <div style="font-size:10px;color:#888;margin-top:4px">${(+g.lat).toFixed(3)}, ${(+g.lng).toFixed(3)}</div>
      </div>`;
    circle.bindPopup(popupHtml);

    try {
      circle.addTo(APP.map);
      _heatmapMarkers.push(circle);
    } catch(e) {
      console.warn('[heatmap marker]', e.message);
    }
  }
}

/**
 * _loadLeafletHeat — charge dynamiquement Leaflet.heat
 */
function _loadLeafletHeat() {
  return new Promise(resolve => {
    if (typeof L.heatLayer === 'function') { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.heat/0.2.0/leaflet-heat.js';
    s.onload  = resolve;
    s.onerror = resolve; // ne pas bloquer si indisponible
    document.head.appendChild(s);
  });
}

/**
 * toggleHeatmap — bascule le panneau "🔥 Zones rentables".
 * v5.10.4 : la fermeture est garantie même si la heatmap n'a pas pu être
 * affichée (Leaflet.heat indisponible) ou qu'il n'y a pas de données
 * (cas typique : compte admin / nouvel utilisateur). Le panneau s'ouvre
 * toujours et affiche un message contextuel si vide.
 */
async function toggleHeatmap() {
  if (_heatmapPanelOpen) {
    closeHeatmap();
    return;
  }
  await openHeatmap();
}

/**
 * closeHeatmap — ferme proprement le panneau ET retire la layer Leaflet.
 * Appelable directement depuis le bouton "×" du panneau.
 */
function closeHeatmap() {
  _heatmapPanelOpen = false;
  _heatmapVisible   = false;
  if (_heatmapLayer) {
    try { APP.map.removeLayer(_heatmapLayer); } catch(_) {}
    _heatmapLayer = null;
  }
  // ⚡ FIX zones-sur-carte : nettoyer aussi les markers cerclés visibles
  _clearHeatmapMarkers();
  _hideHeatmapPanel();
}

/**
 * openHeatmap — ouvre le panneau et tente d'afficher la heatmap.
 * Le panneau est affiché même sans données (message contextuel).
 * v5.10.5 — Hydrate les coords manquantes depuis IDB patients quand
 * possible. Affiche un résumé de rentabilité globale même sans GPS.
 */
async function openHeatmap() {
  _heatmapPanelOpen = true;

  // 1. Charger les cotations depuis le cache dashboard ou l'API
  let cotations = [];
  let isAdmin = false;
  try {
    isAdmin = !!(window.S?.user?.is_admin || window.S?.user?.role === 'admin');
  } catch(_) {}

  try {
    const key = typeof _dashCacheKey === 'function' ? _dashCacheKey() : '';
    const raw = key ? localStorage.getItem(key) : null;
    if (raw) cotations = JSON.parse(raw).data || [];
  } catch {}

  if (!cotations.length) {
    try {
      const d  = await fetchAPI('/webhook/ami-historique?period=3month');
      cotations = Array.isArray(d?.data) ? d.data : [];
    } catch {}
  }

  // 2. Affiche le panneau systématiquement (avec ou sans données)
  if (!cotations.length) {
    _showHeatmapEmpty(isAdmin);
    return;
  }

  // 3. v5.10.5 — Hydrater les coords manquantes depuis IDB patients
  await _hydrateCotationsCoords(cotations);

  // 4. Calcule la grille et tente le rendu Leaflet
  const grid = computeHeatmap(cotations);
  await renderHeatmap(grid);
  _showHeatmapPanel(grid, cotations);
}

/**
 * _hydrateCotationsCoords — complète les lat/lng manquants en allant
 * chercher dans IDB patients (clé patient_id). Évite "Aucune donnée GPS"
 * quand l'API renvoie des cotations sans coords mais que le fichier
 * patient en a.
 *
 * ⚡ FIX zones rentables — Avant ce fix :
 *    1) `idbGetAll('patients')` était utilisé alors que le store réel s'appelle
 *       'ami_patients' (cf. patients.js, PATIENTS_STORE) → 0 résultat.
 *    2) Même avec le bon nom de store, les rows IDB ont la forme
 *       { id, nom, prenom, _data } où _data est un blob CHIFFRÉ qui contient
 *       lat/lng. Aucune tentative de déchiffrement n'était faite → lat/lng
 *       restaient introuvables.
 *    3) APP.get('myFiches') n'est défini nulle part dans le code → fallback
 *       inutilisable.
 *    Désormais : on consomme window._AMI_INTERNAL.patient (helpers déchiffrés
 *    et namespaceés exposés par patients.js) pour récupérer ET déchiffrer
 *    les fiches sans dupliquer la logique d'ouverture IDB.
 */
async function _hydrateCotationsCoords(cotations) {
  const missing = cotations.filter(c => (!c.lat || !c.lng) && c.patient_id);
  if (!missing.length) return;

  /* Source 1 : IDB patients déchiffré via helpers exposés par patients.js
     sous window._AMI_INTERNAL (namespace dédié, pas de pollution globale). */
  let patients = [];
  try {
    const _internal = (typeof window !== 'undefined' && window._AMI_INTERNAL) || null;
    const _patHelpers = _internal?.patient || null;
    const _idbGetAll  = (typeof _internal?.idbGetAll === 'function') ? _internal.idbGetAll : null;
    const _dec        = (typeof _patHelpers?.dec === 'function')     ? _patHelpers.dec    : null;
    const _store      = _patHelpers?.store || 'ami_patients';

    if (_idbGetAll) {
      const rows = await _idbGetAll(_store) || [];
      // Déchiffrer chaque row pour récupérer lat/lng (stockés dans _data)
      // ⚡ RGPD/HDS — _dec est désormais async (AES-GCM réel via S.dataKey),
      //   donc on utilise Promise.all pour préserver l'ordre et déchiffrer en parallèle.
      patients = await Promise.all(rows.map(async r => {
        let body = {};
        if (_dec && r?._data) {
          try { body = (await _dec(r._data)) || {}; } catch(_) {}
        }
        return { id: r.id, nom: r.nom, prenom: r.prenom, ...body };
      }));
    }
  } catch {}

  /* Source 2 : APP.get('myFiches') si dispo (carnet patient en mémoire) */
  if (!patients.length && typeof APP !== 'undefined' && typeof APP.get === 'function') {
    try {
      const f = APP.get('myFiches');
      if (Array.isArray(f)) patients = f;
    } catch {}
  }

  if (!patients.length) return;

  const byId = {};
  for (const p of patients) {
    if (p?.id) byId[String(p.id)] = p;
    if (p?.patient_id) byId[String(p.patient_id)] = p;
  }

  for (const c of missing) {
    const p = byId[String(c.patient_id)];
    if (p?.lat && p?.lng) {
      c.lat = +p.lat;
      c.lng = +p.lng;
    }
  }
}

/**
 * _showHeatmapPanel — affiche le panneau de résumé des zones.
 * v5.10.5 — Affiche TOUJOURS un résumé rentabilité (CA, €/h moyen, nb cotations)
 * même si aucune zone GPS, pour ne plus avoir un panneau "Aucune donnée GPS".
 */
function _showHeatmapPanel(grid, cotations) {
  let panel = document.getElementById('heatmap-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'heatmap-panel';
    panel.style.cssText = 'position:absolute;top:80px;right:12px;z-index:1000;background:var(--s);border:1px solid var(--b);border-radius:10px;padding:14px;width:240px;box-shadow:0 4px 20px rgba(0,0,0,.3)';
    const mapEl = document.getElementById('dep-map');
    if (mapEl) mapEl.appendChild(panel);
    else document.body.appendChild(panel);
    // ⚡ FIX click-through "Centrer sur zones" — sans cette double désactivation,
    //    tout clic sur le panneau (boutons Centrer / Fermer / etc.) bubble
    //    jusqu'au handler `map.on('click', ...)` d'extras.js qui appelle
    //    setDepartPoint(lat, lng) avec les coords du clic à TRAVERS le panel.
    //    Résultat : le bouton centre la carte ET déplace le point de départ
    //    sur l'endroit du clic. disableClickPropagation arrête le bubble
    //    Leaflet ; disableScrollPropagation évite aussi les conflits de zoom.
    if (typeof L !== 'undefined' && L.DomEvent) {
      try {
        L.DomEvent.disableClickPropagation(panel);
        L.DomEvent.disableScrollPropagation(panel);
      } catch(_) {}
    }
  }

  const entries = Object.values(grid || {})
    .sort((a, b) => (b.revenue_per_hour || 0) - (a.revenue_per_hour || 0))
    .slice(0, 5);

  const rows = entries.map(g => {
    const rph = (g.revenue_per_hour || g.revenue || 0).toFixed(1);
    const color = rph > 35 ? '#22c55e' : rph > 20 ? '#f59e0b' : '#ef4444';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--b);font-size:12px">
      <span style="color:var(--m)">${g.lat.toFixed(2)}, ${g.lng.toFixed(2)}</span>
      <strong style="color:${color}">${rph} €/h</strong>
    </div>`;
  }).join('');

  /* Résumé global (toujours affiché) — utile même sans GPS */
  let summaryHtml = '';
  if (Array.isArray(cotations) && cotations.length) {
    const totalRevenue = cotations.reduce((s, c) => s + (parseFloat(c.total) || 0), 0);
    const totalTime    = cotations.reduce((s, c) => s + (parseFloat(c.duration) || 0), 0); // sec
    const avgPerVisit  = cotations.length ? totalRevenue / cotations.length : 0;
    const avgPerHour   = totalTime > 0 ? totalRevenue / (totalTime / 3600) : 0;

    summaryHtml = `
      <div style="background:rgba(124,77,255,.08);border:1px solid rgba(124,77,255,.25);border-radius:8px;padding:8px 10px;margin-bottom:10px">
        <div style="font-size:11px;color:var(--m);margin-bottom:4px">📊 Résumé global (3 mois)</div>
        <div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0">
          <span style="color:var(--m)">CA</span><strong>${totalRevenue.toFixed(0)} €</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0">
          <span style="color:var(--m)">Moyenne / visite</span><strong>${avgPerVisit.toFixed(1)} €</strong>
        </div>
        ${avgPerHour > 0 ? `
        <div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0">
          <span style="color:var(--m)">€ / heure</span><strong style="color:${avgPerHour > 35 ? '#22c55e' : avgPerHour > 20 ? '#f59e0b' : '#ef4444'}">${avgPerHour.toFixed(1)} €/h</strong>
        </div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--m);padding:2px 0">
          <span>Cotations</span><span>${cotations.length}</span>
        </div>
      </div>
    `;
  }

  let zonesHtml;
  if (entries.length) {
    zonesHtml = `<div style="font-size:11px;color:var(--m);margin-bottom:4px">🗺️ Top zones GPS</div>${rows}`;
  } else if (Array.isArray(cotations) && cotations.length) {
    /* Données présentes mais sans coords GPS exploitables */
    zonesHtml = `<div style="font-size:11px;color:var(--m);line-height:1.5">⚠️ Tes cotations n'ont pas encore de coordonnées GPS.<br>La carte des zones rentables se construit à partir des patients géolocalisés.</div>`;
  } else {
    zonesHtml = '<div style="font-size:12px;color:var(--m)">Aucune donnée GPS.</div>';
  }

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-weight:700;font-size:13px">🔥 Zones rentables</div>
      <button onclick="closeHeatmap()" style="background:none;border:none;cursor:pointer;color:var(--m);font-size:18px;padding:0;line-height:1" title="Fermer">×</button>
    </div>
    ${summaryHtml}
    ${zonesHtml}
    ${entries.length ? `<div style="margin-top:8px;font-size:10px;color:var(--m)">Basé sur ${Object.keys(grid).length} zone(s)</div>` : ''}
    ${entries.length ? `<button onclick="centerMapOnHeatmapZones()" style="margin-top:8px;width:100%;background:rgba(0,212,170,.12);border:1px solid rgba(0,212,170,.35);color:var(--a);border-radius:8px;padding:6px 10px;font-size:11px;cursor:pointer;font-family:var(--fm)" title="Recentre la carte pour englober toutes les zones rentables">🎯 Centrer sur zones</button>` : ''}`;

  panel.style.display = 'block';
}

/**
 * centerMapOnHeatmapZones — recadre la carte pour englober tous les markers
 * de zones rentables. Action explicite (clic utilisateur) → ne perturbe jamais
 * automatiquement l'affichage en cours.
 */
function centerMapOnHeatmapZones() {
  if (!APP.map || !_heatmapMarkers.length) return;
  try {
    const grp = L.featureGroup(_heatmapMarkers);
    APP.map.fitBounds(grp.getBounds(), { padding: [40, 40], maxZoom: 14 });
  } catch(e) {
    console.warn('[centerMapOnHeatmapZones]', e.message);
  }
}

/**
 * _showHeatmapEmpty — affiche le panneau avec message contextuel
 * quand il n'y a pas encore de cotations à exploiter.
 * v5.10.4 — utile pour les comptes admin / les nouveaux utilisateurs.
 */
function _showHeatmapEmpty(isAdmin) {
  let panel = document.getElementById('heatmap-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'heatmap-panel';
    panel.style.cssText = 'position:absolute;top:80px;right:12px;z-index:1000;background:var(--s);border:1px solid var(--b);border-radius:10px;padding:14px;width:240px;box-shadow:0 4px 20px rgba(0,0,0,.3)';
    const mapEl = document.getElementById('dep-map');
    if (mapEl) mapEl.appendChild(panel);
    else document.body.appendChild(panel);
    // ⚡ FIX click-through (cf. _showHeatmapPanel) — empêche les clics sur le
    //    panneau de bubbler jusqu'au handler de la carte qui déplacerait le
    //    point de départ.
    if (typeof L !== 'undefined' && L.DomEvent) {
      try {
        L.DomEvent.disableClickPropagation(panel);
        L.DomEvent.disableScrollPropagation(panel);
      } catch(_) {}
    }
  }

  const msg = isAdmin
    ? `Cette vue se remplit avec vos propres cotations test. Crée des patients de démo et leurs cotations pour voir la heatmap.`
    : `Pas encore de cotations géolocalisées sur les 3 derniers mois. Le calque se remplira automatiquement à mesure que tu valides tes tournées.`;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-weight:700;font-size:13px">🔥 Zones rentables</div>
      <button onclick="closeHeatmap()" style="background:none;border:none;cursor:pointer;color:var(--m);font-size:18px;padding:0;line-height:1" title="Fermer">×</button>
    </div>
    <div style="font-size:12px;color:var(--m);line-height:1.5">${msg}</div>
  `;
  panel.style.display = 'block';
}

if (typeof window !== 'undefined') {
  window.toggleHeatmap            = toggleHeatmap;
  window.closeHeatmap             = closeHeatmap;
  window.openHeatmap              = openHeatmap;
  window.centerMapOnHeatmapZones  = centerMapOnHeatmapZones;
}

function _hideHeatmapPanel() {
  const p = document.getElementById('heatmap-panel');
  if (p) p.style.display = 'none';
}
