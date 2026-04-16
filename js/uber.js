/* ════════════════════════════════════════════════
   uber.js — AMI NGAP v5.0
   ────────────────────────────────────────────────
   Mode Uber Médical — Tournée temps réel
   ⚠️  Requiert Leaflet.js et map.js
   v5.0 :
   ✅ Guards stricts (assertDep)
   ✅ GPS throttlé (3s minimum entre updates)
   ✅ maximumAge:10000 + timeout:10000 (économie batterie)
   ✅ getNextPatient() via APP.on('userPos') réactif
   ✅ Lecture via APP.get() / écriture via APP.set()
   ✅ _updateMapLive / _renderNextPatient exposés
     pour les listeners réactifs de utils.js
════════════════════════════════════════════════ */

/* ── Guards stricts ──────────────────────────── */
(function checkDeps() {
  assertDep(typeof APP !== 'undefined',    'uber.js : utils.js non chargé.');
  assertDep(typeof APP.map !== 'undefined','uber.js : namespace APP.map manquant (map.js requis).');
  assertDep(typeof L !== 'undefined',      'uber.js : Leaflet non chargé.');
})();

let _watchId     = null;
let _uberInterval= null;

/* ── Distance euclidienne rapide ─────────────── */
function _dist(a, b) {
  return Math.sqrt(Math.pow(a.lat-b.lat,2) + Math.pow(a.lng-b.lng,2));
}

/* ── ETA réel via OSRM ───────────────────────── */
async function getETA(from, to) {
  if (!to.lat || !to.lng) return 999;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const r = await fetch(url);
    const d = await r.json();
    return d.routes?.[0]?.duration / 60 || 999;
  } catch { return _dist(from, to) * 1000; }
}

/* ── Score Uber : plus petit = meilleur ──────── */
async function _computeScore(p) {
  const pos = APP.get('userPos') || APP.get('startPoint');
  if (!pos) return 999;
  const eta = await getETA(pos, p);
  let score = eta * 2;
  if (p.urgence)               score -= 50;
  if (p.late)                  score -= 30;
  if (p.time && Date.now() > p.time) score -= 20;
  if (p.amount)                score -= parseFloat(p.amount) * 0.5;
  return score;
}

/* ── Sélection intelligente du prochain patient ─
   Utilise APP.set() pour déclencher _renderNextPatient
   automatiquement via le listener dans utils.js.
─────────────────────────────────────────────── */
async function selectBestPatient() {
  const patients = APP.get('uberPatients');
  const remaining = patients.filter(p => !p.done && !p.absent);
  if (!remaining.length) { APP.set('nextPatient', null); return; }

  const userPos = APP.get('userPos');
  if (userPos) remaining.sort((a,b) => _dist(userPos,a) - _dist(userPos,b));

  const top5 = remaining.slice(0, 5);
  let best = null, bestScore = Infinity;
  for (const p of top5) {
    const s = await _computeScore(p);
    if (s < bestScore) { bestScore = s; best = p; }
  }
  APP.set('nextPatient', best || remaining[0]);
}

/* ── Rendu carte prochain patient ────────────── */
function _renderNextPatient() {
  const el = $('uber-next-patient');
  if (!el) return;
  const p = APP.get('nextPatient');
  if (!p) { el.innerHTML = '<div class="ai su">✅ Tous les patients ont été vus !</div>'; return; }
  const userPos = APP.get('userPos');
  const rawDist = userPos && p.lat ? _dist(userPos, p) * 111 : null;
  /* Afficher la distance seulement si GPS actif et distance plausible (<150km) */
  const dist = (rawDist !== null && rawDist < 150) ? rawDist.toFixed(1) + ' km' : (userPos ? rawDist.toFixed(1) + ' km' : '—');
  const nomAff = ((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.description || p.label || 'Patient';
  el.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:6px">${nomAff}</div>
    <div style="font-size:12px;color:var(--m);margin-bottom:10px">
      ${p.heure_soin ? '⏰ '+p.heure_soin : ''} ${p.urgence ? '🚨 URGENT' : ''}${dist !== '—' ? ' · 📍 ~'+dist : ''}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn bp bsm" onclick="markUberDone()"><span>✅</span> Terminé</button>
      <button class="btn bs bsm" onclick="markUberAbsent()"><span>❌</span> Absent</button>
      ${p.lat ? `<button class="btn bv bsm" onclick="openNavigation(APP.get('nextPatient'))"><span>🗺️</span> Naviguer</button>` : ''}
    </div>`;
}

/* ── Marker live position infirmière ─────────── */
function _updateMapLive(lat, lng) {
  const map = APP.map.instance;
  if (!map) return;
  if (window._liveMarker) {
    window._liveMarker.setLatLng([lat, lng]);
  } else {
    window._liveMarker = L.circleMarker([lat, lng], {
      radius: 10, fillColor: '#00d4aa', color: '#00b891', weight: 2, fillOpacity: 0.9
    }).addTo(map).bindPopup('📍 Vous êtes ici');
  }
}

/* ── Détection retards ───────────────────────── */
function detectDelaysUber() {
  const now = Date.now();
  APP.get('uberPatients').forEach(p => {
    if (p.time && !p.done && now > p.time + 15 * 60 * 1000) p.late = true;
  });
}

/* ── GPS CONTINU — throttlé 3s ───────────────────
   ✅ maximumAge:10000 → évite requêtes GPS inutiles
   ✅ timeout:10000    → plus tolérant en intérieur
   ✅ throttle 3s      → économise la batterie
─────────────────────────────────────────────── */
const _onGPSUpdate = throttle((lat, lng) => {
  APP.set('userPos', { lat, lng });
  /* startPoint seulement si pas encore défini */
  if (!APP.get('startPoint')) APP.set('startPoint', { lat, lng });
  log('GPS live →', lat.toFixed(4), lng.toFixed(4));
}, 3000);

function startLiveTracking() {
  if (!navigator.geolocation) { alert('GPS non supporté'); return; }
  if (_watchId !== null) { log('GPS déjà actif'); return; }
  const el = $('uber-tracking-status');
  if (el) el.textContent = '📡 GPS actif — suivi continu';
  _watchId = navigator.geolocation.watchPosition(
    pos => _onGPSUpdate(pos.coords.latitude, pos.coords.longitude),
    err => { logErr('GPS LIVE ERROR', err); if (el) el.textContent = '❌ GPS perdu — ' + err.message; },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
  );
  /* Recalcul auto toutes les 15s */
  _uberInterval = setInterval(() => { detectDelaysUber(); selectBestPatient(); }, 15000);
}

function stopLiveTracking() {
  if (_watchId !== null) { navigator.geolocation.clearWatch(_watchId); _watchId = null; }
  if (_uberInterval) { clearInterval(_uberInterval); _uberInterval = null; }
  const el = $('uber-tracking-status');
  if (el) el.textContent = '⏹️ Suivi GPS arrêté';
}

/* ── Actions patient ─────────────────────────── */
function markUberDone() {
  const p = APP.get('nextPatient'); if (!p) return;
  p.done = true;
  selectBestPatient();
  _updateUberProgress();
  if (typeof _updateLiveCADisplay === 'function') _updateLiveCADisplay();
}
function markUberAbsent() {
  const p = APP.get('nextPatient'); if (!p) return;
  p.absent = true;
  selectBestPatient();
  _updateUberProgress();
  if (typeof _updateLiveCADisplay === 'function') _updateLiveCADisplay();
}

function _updateUberProgress() {
  // Déléguer à renderLivePatientList pour un affichage unifié (évite le doublon uber-progress)
  if (typeof renderLivePatientList === 'function') {
    renderLivePatientList();
  } else {
    // Fallback si tournee.js pas encore chargé
    const pts = APP.get('uberPatients');
    const total = pts.length;
    const done  = pts.filter(p => p.done || p.absent).length;
    const el = $('uber-progress');
    if (el) el.textContent = `${done} / ${total} patients · ${total - done} restant(s)`;
  }
}

/* ── Navigation Google Maps ──────────────────────────────────
   Point de départ = startPoint choisi dans la tournée (ou position
   GPS live si disponible). Si aucun point de départ n'est défini,
   Google Maps utilise la position de l'appareil.
─────────────────────────────────────────────────────────────── */
function openNavigation(p) {
  if (!p?.lat && !p?.adresse && !p?.addressFull) { alert('Adresse du patient non disponible.'); return; }

  /* Destination : préférer l'adresse TEXTE exacte si disponible
     → Google Maps utilise sa propre base pour trouver le bon numéro
     → évite le reverse geocoding approximatif sur les coordonnées IGN
     Fallback sur coordonnées GPS si pas d'adresse texte */
  const addrText = p.addressFull || p.adresse || p.address || '';
  const dest = addrText
    ? encodeURIComponent(addrText)
    : `${p.lat},${p.lng}`;

  /* Origin = startPoint défini dans Tournée IA */
  const origin = APP.get('startPoint');

  let url;
  const destParam = addrText ? `destination=${dest}` : `destination=${dest}`;
  if (origin && origin.lat && origin.lng) {
    url = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&${destParam}&travelmode=driving`;
  } else {
    url = `https://www.google.com/maps/dir/?api=1&${destParam}&travelmode=driving`;
  }

  window.open(url, '_blank');
}

/* ── Recalcul OSRM complet ───────────────────── */
async function recalcRouteUber() {
  const pos = APP.get('userPos') || APP.get('startPoint');
  if (!pos) { alert("Active le GPS d'abord."); return; }
  const remaining = APP.get('uberPatients').filter(p => !p.done && !p.absent && p.lat && p.lng);
  if (!remaining.length) { alert('Aucun patient restant avec coordonnées GPS.'); return; }
  const coords = [[pos.lng, pos.lat], ...remaining.map(p => [p.lng, p.lat])];
  try {
    const url = `https://router.project-osrm.org/trip/v1/driving/${coords.map(c=>c.join(',')).join(';')}?source=first&roundtrip=false`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.code === 'Ok') {
      const totalMin = Math.round(d.trips[0].duration / 60);
      const totalKm  = (d.trips[0].distance / 1000).toFixed(1);
      const el = $('uber-route-info');
      if (el) el.innerHTML = `🗺️ Route optimisée : <strong>${totalKm} km</strong> · <strong>${totalMin} min</strong>`;
    }
  } catch (e) { logWarn('OSRM recalc:', e.message); }
}

/* ── Chargement patients Uber ────────────────── */
function loadUberPatients() {
  if (!requireAuth()) return;
  const data = APP.get('importedData');
  if (!data || data._planningOnly) {
    const el = $('uber-next-patient');
    if (el) el.innerHTML = '<div class="ai wa" style="margin-bottom:10px">⚠️ Aucune donnée importée.</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn bp bsm" onclick="navTo(\'patients\',null)"><span>👤</span> Carnet patients</button>' +
        '<button class="btn bs bsm" onclick="navTo(\'imp\',null)"><span>📂</span> Import calendrier</button>' +
        '</div>';
    return;
  }
  const raw = data?.patients || data?.entries || [];
  APP.set('uberPatients', raw.map((p, i) => {
    const amountBase = parseFloat(p.total || p.montant || p.amount || 0);
    // estimateRevenue si pas de montant réel
    const amount = amountBase > 0 ? amountBase
      : (typeof estimateRevenue === 'function' ? estimateRevenue([p]) : 6.30);
    return {
      ...p,
      id:      p.patient_id || p.id || i,
      label:   p.description || p.texte || p.summary || 'Patient ' + (i+1),
      done:    false, absent: false, late: false,
      urgence: !!(p.urgence || p.priorite === 'urgent'),
      time:    p.heure_soin ? _parseTime(p.heure_soin) : null,
      amount,
      lat:     parseFloat(p.lat || p.latitude) || null,
      lng:     parseFloat(p.lng || p.longitude || p.lon) || null,
    };
  }));
  _updateUberProgress();
  selectBestPatient();
}

function _parseTime(h) {
  if (!h) return null;
  const [hh, mm] = (h||'').split(':').map(Number);
  const t = new Date(); t.setHours(hh||0, mm||0, 0, 0);
  return t.getTime();
}
