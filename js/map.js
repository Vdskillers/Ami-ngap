/* ════════════════════════════════════════════════
   map.js — AMI NGAP
   ────────────────────────────────────────────────
   Carte Leaflet & GPS
   ⚠️  Requiert Leaflet.js chargé AVANT ce fichier
   - initDepMap() — initialisation carte neutre (0 coord hardcodée)
   - getGPS() — GPS réel avec contrôle précision + messages par code
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

  /* ✅ Correction hauteur responsive après init
     Nécessaire quand la map est initialisée dans un onglet caché */
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
  APP.startPoint = { lat, lng };
  window.START_POINT = { lat, lng };
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
