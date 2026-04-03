/* ════════════════════════════════════════════════
   map.js — AMI NGAP v5.0
   ────────────────────────────────────────────────
   Carte Leaflet & GPS — MAP PREMIUM
   ⚠️  Requiert Leaflet.js chargé AVANT ce fichier
   - initDepMap() — init + APP.map.register()
   - getGPS() — GPS réel avec contrôle précision
   - reverseGeocode() / geocodeAddress() — Nominatim
   - setDepCoords() — met à jour APP.startPoint
   ── FONCTIONS PREMIUM ────────────────────────────
   - createPatientMarker() — markers style Uber/Doctolib
   - addNumberedMarkers() — numérotation patients
   - drawRoute() — tracé OSRM couleur #00d4aa
   - renderTimeline() — timeline tournée sous la carte
   - focusPatient() — flyTo style Uber
   - toggleMapFullscreen() — mode plein écran
   - renderPatientsOnMap() — affichage complet tournée
   ── v5.0 ─────────────────────────────────────────
   ✅ assertDep() guard strict Leaflet
   ✅ APP.map.register() — instance partagée
   ✅ APP.map.setUserMarker / centerMap exposés
   ✅ depMap = APP.map.instance (alias rétrocompat)
════════════════════════════════════════════════ */

/* ── Guards stricts ──────────────────────────── */
(function checkDeps() {
  assertDep(typeof L !== 'undefined',   'map.js : Leaflet non chargé avant map.js.');
  assertDep(typeof APP !== 'undefined', 'map.js : utils.js non chargé.');
})();

/* depMap reste accessible globalement pour rétrocompat (uber.js, tournee.js) */
let depMap = null, depMarker = null;
let _routeLayer = null;
let _patientMarkers = [];
let _fullscreenActive = false;

function initDepMap() {
  if (depMap) return;
  depMap = L.map('dep-map').setView([20, 10], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(depMap);

  depMap.on('click', e => {
    const { lat, lng } = e.latlng;
    _setDepMarker(lat, lng);
    setDepCoords(lat, lng);
    reverseGeocode(lat, lng);
  });

  /* ✅ Enregistrer dans APP.map — accessible par uber.js et ui.js */
  APP.map.register(depMap);

  /* Exposer les helpers dans APP.map */
  APP.map.setUserMarker = (lat, lng) => {
    if (window._liveMarker) {
      window._liveMarker.setLatLng([lat, lng]);
    } else {
      window._liveMarker = L.circleMarker([lat, lng], {
        radius: 10, fillColor: '#00d4aa', color: '#00b891', weight: 2, fillOpacity: 0.9
      }).addTo(depMap).bindPopup('📍 Vous êtes ici');
    }
  };
  APP.map.centerMap = (lat, lng, zoom=15) => depMap.setView([lat, lng], zoom);

  /* ✅ invalidateSize après init */
  setTimeout(() => depMap.invalidateSize(), 300);
}

/* Place ou déplace le marker draggable de départ */
function _setDepMarker(lat, lng) {
  if (depMarker) {
    depMarker.setLatLng([lat, lng]);
  } else {
    depMarker = L.marker([lat, lng], { draggable: true, title: '📍 Point de départ' }).addTo(depMap);
    depMarker.on('dragend', e => {
      const ll = e.target.getLatLng();
      setDepCoords(ll.lat, ll.lng);
      reverseGeocode(ll.lat, ll.lng);
    });
  }
}

/* Met à jour APP.startPoint + les inputs cachés */
function setDepCoords(lat, lng) {
  const tLat = $('t-lat'), tLng = $('t-lng');
  if (tLat) tLat.value = lat.toFixed(6);
  if (tLng) tLng.value = lng.toFixed(6);
  /* ✅ APP.set() → déclenche l'event 'app:update' */
  APP.set('startPoint', { lat, lng });
  const el = $('dep-coords');
  if (el) el.textContent = `📌 Départ défini : ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/* Géocodage inverse : coordonnées → adresse lisible */
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { 'Accept-Language': 'fr' } }
    );
    const d = await r.json();
    if (d.display_name) {
      const label = d.display_name.split(',').slice(0, 3).join(', ');
      const el = $('dep-coords');
      if (el) el.textContent = `📌 Départ : ${label}`;
      const addr = $('dep-addr');
      if (addr) addr.value = label;
    }
  } catch { /* Nominatim optionnel — pas bloquant */ }
}

/* Géocodage : adresse → coordonnées */
async function geocodeAddress() {
  const addr = gv('dep-addr').trim();
  if (!addr) return;
  const el = $('dep-coords');
  if (el) el.textContent = '🔍 Recherche en cours...';
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addr)}&format=json&limit=1`,
      { headers: { 'Accept-Language': 'fr' } }
    );
    const d = await r.json();
    if (!d.length) { if (el) el.textContent = '❌ Adresse non trouvée'; return; }
    const lat = parseFloat(d[0].lat), lng = parseFloat(d[0].lon);
    _setDepMarker(lat, lng);
    setDepCoords(lat, lng);
    if (depMap) depMap.setView([lat, lng], 15);
  } catch (e) {
    if (el) el.textContent = '❌ Erreur : ' + e.message;
  }
}

/* ════════════════════════════════════════════════
   GPS — position réelle avec contrôle précision
   ────────────────────────────────────────────────
   ✅ enableHighAccuracy:true  → puce GPS réelle
   ✅ timeout:15000            → 15s (au lieu de 10)
   ✅ maximumAge:0             → jamais de cache
   ✅ accuracy check           → alerte si > 500m (IP fallback)
   ✅ messages par code d'erreur
   
   ⚠️  IMPORTANT :
   - Fonctionne uniquement en HTTPS
   - Sur ordinateur sans GPS : accuracy ≈ 50000m (localisation IP)
     → l'utilisateur voit un avertissement et peut entrer son adresse
   - Sur mobile avec GPS activé : accuracy < 20m
════════════════════════════════════════════════ */
function getGPS() {
  const el = $('dep-coords');
  const btn = document.querySelector('.map-btn.gps');

  if (!navigator.geolocation) {
    if (el) el.textContent = '❌ GPS non supporté — entrez votre adresse manuellement';
    return;
  }

  if (el) el.textContent = '📡 Localisation GPS en cours…';
  if (btn) btn.textContent = '📡 En cours…';

  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = pos.coords.accuracy; // précision en mètres

      console.log(`📍 GPS : ${lat}, ${lng} — précision ±${acc}m`);

      /* ─────────────────────────────────────────────
         Contrôle de précision :
         < 100m  → GPS réel ✅
         100-500m → WiFi positioning ⚠️
         > 500m  → localisation IP ❌ (pas fiable pour une tournée)
      ───────────────────────────────────────────── */
      if (acc > 5000) {
        /* Localisation IP — inutilisable pour une tournée */
        if (el) el.innerHTML = `
          ⚠️ Position imprécise (±${Math.round(acc/1000)}km) — probablement votre adresse IP, pas votre position réelle.<br>
          <strong>Entrez votre adresse de départ manuellement</strong> dans le champ ci-dessus.`;
        if (btn) { btn.textContent = '📍 GPS'; }
        /* On affiche quand même la position approximative sur la carte */
        if (depMap) depMap.setView([lat, lng], 8);
        return;
      }

      if (acc > 500) {
        /* Précision WiFi — utilisable avec avertissement */
        const warnEl = $('dep-coords');
        if (warnEl) warnEl.textContent = `⚠️ Position approx. (±${Math.round(acc)}m) — active la localisation précise sur ton appareil`;
      }

      /* Position suffisamment précise → on l'utilise */
      _setDepMarker(lat, lng);
      setDepCoords(lat, lng);
      if (depMap) depMap.setView([lat, lng], 15);
      reverseGeocode(lat, lng);

      if (btn) {
        btn.textContent = acc < 100 ? '📍 GPS OK ✅' : '📍 Position mise à jour';
        setTimeout(() => btn.textContent = '📍 GPS', 3000);
      }
    },
    err => {
      console.error('GPS ERROR code', err.code, ':', err.message);

      /* Messages précis par code d'erreur GPS */
      const msgs = {
        1: `❌ GPS refusé — clique sur 🔒 dans la barre d'adresse et autorise la localisation`,
        2: `❌ Position indisponible — vérifie que le GPS est activé sur ton appareil`,
        3: `❌ GPS trop lent — réessaie ou entre ton adresse manuellement`
      };
      if (el) el.textContent = msgs[err.code] || `❌ Erreur GPS (code ${err.code})`;
      if (btn) btn.textContent = '📍 GPS';
    },
    {
      enableHighAccuracy: true,  // force la puce GPS réelle
      timeout: 15000,            // 15s (augmenté pour mobile en intérieur)
      maximumAge: 0              // jamais de position en cache
    }
  );
}

/* Initialisation carte à l'ouverture de l'onglet tournée */
document.querySelectorAll('.ni[data-v="tur"]').forEach(n =>
  n.addEventListener('click', () => setTimeout(() => { initDepMap(); showCaFromImport(); }, 100))
);

/* ════════════════════════════════════════════════
   MAP PREMIUM — Markers, Route, Timeline, Plein écran
   Style Uber / Doctolib
════════════════════════════════════════════════ */

/* ── 1. MARKER PREMIUM (style carte Uber) ────────
   Affiche heure + description dans une card noire
   avec bordure verte AMI.
─────────────────────────────────────────────── */
function createPatientMarker(p) {
  const heure = p.heure_soin || p.heure || '';
  const label = (p.description || p.label || 'Patient').slice(0, 22);
  const icon = L.divIcon({
    className: 'patient-marker',
    html: `<div class="marker-card">
      ${heure ? `<div class="marker-time">${heure}</div>` : ''}
      <div class="marker-name">${label}</div>
    </div>`,
    iconSize: [130, heure ? 44 : 30],
    iconAnchor: [65, heure ? 44 : 30]
  });
  return L.marker([p.lat, p.lng], { icon });
}

/* ── 2. NUMÉROTATION DES PATIENTS ────────────────
   Cercles numérotés verts (Doctolib style)
─────────────────────────────────────────────── */
function addNumberedMarkers(patients) {
  // Nettoyer les anciens markers
  _patientMarkers.forEach(m => depMap.removeLayer(m));
  _patientMarkers = [];

  patients.forEach((p, i) => {
    if (!p.lat || !p.lng) return;

    // Marker numéroté
    const numIcon = L.divIcon({
      html: `<div class="num-marker">${i + 1}</div>`,
      className: '',
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    const m = L.marker([p.lat, p.lng], { icon: numIcon })
      .addTo(depMap)
      .on('click', () => focusPatient(p));

    // Popup au clic
    const heure = p.heure_soin || p.heure || '—';
    const desc  = p.description || p.label || 'Soin';
    m.bindPopup(`
      <div style="font-family:sans-serif;min-width:160px">
        <div style="font-weight:700;font-size:13px;margin-bottom:4px">#${i+1} · ${heure}</div>
        <div style="font-size:12px;color:#444">${desc}</div>
        ${p.actes ? `<div style="font-size:11px;color:#00b891;margin-top:4px">${Array.isArray(p.actes)?p.actes.join(', '):p.actes}</div>` : ''}
      </div>
    `, { maxWidth: 220 });

    _patientMarkers.push(m);
  });
}

/* ── 3. TRACÉ ROUTE OSRM ─────────────────────────
   Ligne couleur AMI sur la carte depuis l'API OSRM.
   Remplace l'ancienne couche si elle existe.
─────────────────────────────────────────────── */
async function drawRoute(points) {
  if (!depMap || points.length < 2) return;

  // Supprimer l'ancienne route
  if (_routeLayer) { depMap.removeLayer(_routeLayer); _routeLayer = null; }

  const coords = points
    .filter(p => p.lat && p.lng)
    .map(p => `${p.lng},${p.lat}`)
    .join(';');

  if (!coords) return;

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.code !== 'Ok' || !d.routes?.[0]) return;

    _routeLayer = L.geoJSON(d.routes[0].geometry, {
      style: { color: '#00d4aa', weight: 4, opacity: 0.85, dashArray: null }
    }).addTo(depMap);

    // Zoom sur la route
    depMap.fitBounds(_routeLayer.getBounds(), { padding: [32, 32] });
  } catch (e) {
    console.warn('drawRoute OSRM:', e.message);
  }
}

/* ── 4. TIMELINE TOURNÉE ─────────────────────────
   Affichée sous la carte dans #map-timeline.
   Clic sur un item → flyTo patient.
─────────────────────────────────────────────── */
function renderTimeline(patients) {
  const el = $('map-timeline');
  if (!el) return;
  if (!patients || !patients.length) { el.style.display = 'none'; return; }

  el.style.display = 'block';
  el.innerHTML = patients.map((p, i) => {
    const heure = p.heure_soin || p.heure || '—';
    const desc  = (p.description || p.label || 'Patient').slice(0, 35);
    const actes = Array.isArray(p.actes)
      ? p.actes.map(a => a.code || a).join(', ')
      : (p.actes || '');
    const hasCoords = p.lat && p.lng;
    return `<div class="tl-item ${p.done ? 'tl-done' : ''}" onclick="${hasCoords ? `focusPatient(window._tlPatients[${i}])` : ''}">
      <div class="tl-num">${i + 1}</div>
      <div class="tl-time">${heure}</div>
      <div class="tl-body">
        <div class="tl-name">${desc}</div>
        ${actes ? `<div class="tl-actes">${actes}</div>` : ''}
      </div>
      ${p.done ? '<div class="tl-check">✅</div>' : ''}
    </div>`;
  }).join('');

  // Stocker pour les callbacks onclick
  window._tlPatients = patients;
}

/* ── 5. FOCUS PATIENT (flyTo style Uber) ─────────
   Animation fluide vers le patient + ouverture popup.
─────────────────────────────────────────────── */
function focusPatient(p) {
  if (!depMap || !p?.lat || !p?.lng) return;
  depMap.flyTo([p.lat, p.lng], 16, { animate: true, duration: 0.8 });
  // Ouvrir le popup du marker correspondant
  const idx = (window._tlPatients || []).indexOf(p);
  if (idx >= 0 && _patientMarkers[idx]) {
    _patientMarkers[idx].openPopup();
  }
}

/* ── 6. MODE PLEIN ÉCRAN ─────────────────────────
   Bascule la carte en position fixed plein écran
   (style Google Maps / Uber).
─────────────────────────────────────────────── */
function toggleMapFullscreen() {
  const mapEl = $('dep-map');
  const btn   = $('btn-map-fullscreen');
  if (!mapEl) return;

  _fullscreenActive = !_fullscreenActive;
  mapEl.classList.toggle('fullscreen', _fullscreenActive);

  if (btn) {
    btn.textContent = _fullscreenActive ? '✕ Réduire' : '⛶ Plein écran';
    btn.classList.toggle('active', _fullscreenActive);
  }

  // Fermer avec Échap
  if (_fullscreenActive) {
    document.addEventListener('keydown', _escFullscreen, { once: true });
  }

  setTimeout(() => { if (depMap) depMap.invalidateSize(); }, 200);
}

function _escFullscreen(e) {
  if (e.key === 'Escape' && _fullscreenActive) toggleMapFullscreen();
}

/* ── 7. AFFICHAGE COMPLET TOURNÉE SUR CARTE ──────
   Fonction principale appelée après optimiserTournee().
   Affiche markers numérotés + route OSRM + timeline.
   Appelable depuis tournee.js avec les données de route.
─────────────────────────────────────────────── */
async function renderPatientsOnMap(patients, startPoint) {
  if (!depMap) initDepMap();
  if (!patients || !patients.length) return;

  const validPts = patients.filter(p => p.lat && p.lng);
  if (!validPts.length) return;

  // Markers numérotés
  addNumberedMarkers(patients);

  // Route OSRM (départ + patients avec coords)
  const waypoints = [];
  if (startPoint?.lat && startPoint?.lng) waypoints.push(startPoint);
  waypoints.push(...validPts);
  if (waypoints.length >= 2) await drawRoute(waypoints);

  // Timeline
  renderTimeline(patients);

  // Zoom auto sur tous les patients
  if (!waypoints.length) return;
  const bounds = L.latLngBounds(validPts.map(p => [p.lat, p.lng]));
  if (startPoint?.lat) bounds.extend([startPoint.lat, startPoint.lng]);
  depMap.fitBounds(bounds, { padding: [40, 40] });
}
