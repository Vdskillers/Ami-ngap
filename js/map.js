/* ════════════════════════════════════════════════
   map.js — AMI NGAP
   ────────────────────────────────────────────────
   Carte Leaflet & GPS
   ⚠️  Requiert Leaflet.js chargé AVANT ce fichier
   - initDepMap() — initialisation carte neutre (0 coord hardcodée)
   - getGPS() — position réelle au clic, messages d'erreur par code
   - reverseGeocode() — adresse depuis coordonnées (Nominatim)
   - geocodeAddress() — coordonnées depuis adresse (Nominatim)
   - setDepCoords() — met à jour APP.startPoint + inputs cachés
════════════════════════════════════════════════ */

/* ── Vérification de dépendance au chargement ─── */
if (typeof L === 'undefined') {
  console.error('map.js : Leaflet (L) non chargé. Vérifiez que leaflet.js est inclus AVANT map.js.');
}

let depMap = null, depMarker = null;

function initDepMap() {
  if (depMap) return;
  /* ✅ Carte monde neutre — aucune localisation par défaut */
  depMap = L.map('dep-map').setView([20, 10], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(depMap);

  /* Clic sur la carte → définit le point de départ */
  depMap.on('click', e => {
    const { lat, lng } = e.latlng;
    _setDepMarker(lat, lng);
    setDepCoords(lat, lng);
    reverseGeocode(lat, lng);
  });
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
  APP.startPoint = { lat, lng };           // store centralisé
  window.START_POINT = { lat, lng };       // rétrocompat
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

/* ── GPS propre — aucun fallback, messages par code ──
   Code 1 = PERMISSION_DENIED  → l'utilisateur a refusé
   Code 2 = POSITION_UNAVAILABLE → GPS indisponible
   Code 3 = TIMEOUT             → trop lent
─────────────────────────────────────────────────────── */
function getGPS() {
  const el = $('dep-coords');
  if (el) el.textContent = '📡 Localisation GPS en cours...';

  if (!navigator.geolocation) {
    if (el) el.textContent = '❌ GPS non supporté par ce navigateur (utilisez Chrome ou Safari)';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      console.log('📍 GPS réel :', lat, lng);
      _setDepMarker(lat, lng);
      setDepCoords(lat, lng);
      if (depMap) depMap.setView([lat, lng], 15);
      reverseGeocode(lat, lng);
      /* Feedback visuel bouton */
      const btn = document.querySelector('.map-btn.gps');
      if (btn) { btn.textContent = '📍 Position mise à jour'; setTimeout(() => btn.textContent = '📍 GPS', 3000); }
    },
    err => {
      console.error('GPS ERROR', err.code, err.message);
      /* ❌ Aucun fallback — message précis selon le code d'erreur */
      const msgs = {
        1: '❌ GPS refusé — autorise la localisation dans les réglages de ton navigateur',
        2: '❌ Position indisponible — vérifie que le GPS de ton appareil est activé',
        3: '❌ GPS trop lent — réessaie ou utilise la recherche d\'adresse'
      };
      if (el) el.textContent = msgs[err.code] || '❌ Erreur GPS : ' + err.message;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

/* Initialisation carte à l'ouverture de l'onglet tournée */
document.querySelectorAll('.ni[data-v="tur"]').forEach(n =>
  n.addEventListener('click', () => setTimeout(() => { initDepMap(); showCaFromImport(); }, 100))
);
