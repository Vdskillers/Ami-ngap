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

    marker.bindPopup(`
      <strong>${p.name}</strong><br>
      ${p.address || p.addressFull || ''}<br>
      <small>Score géo : ${p.geoScore}/100</small><br>
      <a href="#" onclick="openNavigation(${JSON.stringify(p).replace(/"/g,'&quot;')})">
        Naviguer
      </a> |
      <a href="#" onclick="enableCorrectionMode(${p.lat}, ${p.lng})">
        Corriger position
      </a>
    `);

    marker.addTo(APP.map);
    APP.markers.push(marker);
  });
}

// ─────────────────────────────────────────────────────────────
//  renderPatientsOnMap — VERSION TOURNÉE (remplace la précédente)
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

          var popupContent = '<strong style="font-size:13px">' + nomAff + '</strong>';
          if (adresseAff) popupContent += '<br><span style="font-size:11px;color:#666">' + adresseAff + '</span>';
          if (heure)      popupContent += '<br><span style="font-size:11px">🕐 ' + heure + '</span>';
          if (isUrgent)   popupContent += '<br><span style="color:#E24B4A;font-size:11px">🚨 URGENT</span>';
          if (p.geoScore != null) popupContent += '<br><small style="color:#999">Score géo : ' + p.geoScore + '/100</small>';
          popupContent += '<br><a href="#" style="font-size:11px" onclick="enableCorrectionMode(' + p.lat + ',' + p.lng + ');return false;">Corriger position</a>';

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
