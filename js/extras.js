/* ════════════════════════════════════════════════
   extras.js — AMI NGAP
   ────────────────────────────────────────────────
   Fonctions présentes dans ami-ngap.html
   non encore couvertes par le projet modulaire.

   ✅ Carte tournée dédiée (tur-map)
      - initTurMap()         — init carte tournée tur-map
      - setDepartPoint()     — point de départ sur tur-map
      - searchAddress()      — géocodage via Nominatim (tur-map)
      - useMyLocation()      — GPS → tur-map
      - drawRouteOSRM()      — tracé geojson sur tur-map
      - renderTourneeOSRM()  — rendu waypoints OSRM triés + fraude

   ✅ Intelligence métier front
      - fraudeScore()           — score fraude par patient
      - suggestOptimizationsFront() — suggestions depuis IMPORTED_DATA
      - updateCAEstimate()      — box CA dans onglet tournée
      - showNextPatientLocal()  — prochain patient mode local

   ✅ Pilotage live local
      - detectDelayLocal()      — retard via IMPORTED_DATA + badge
      - startDayLocal()         — démarrage journée mode IMPORTED_DATA

   ✅ Planning local
      - generatePlanningLocal() — planning hebdo direct depuis IMPORTED_DATA

   ✅ FAQ
      - filterFaq()             — recherche dans la FAQ

   ✅ Voix enrichie
      - normalizeMedicalFull()  — normalisation médicale + chiffres écrits
════════════════════════════════════════════════ */

/* ── Guard ───────────────────────────────────── */
(function checkDeps(){
  if(typeof APP==='undefined') console.error('[AMI] extras.js : utils.js non chargé.');
})();

/* ════════════════════════════════════════════════
   CARTE TOURNÉE DÉDIÉE — tur-map
   Distincte de dep-map (carte départ)
════════════════════════════════════════════════ */
let _turMap=null, _turMarker=null, _turRouteLine=null, _turLiveMarker=null;

function initTurMap(){
  const depMapEl = document.getElementById('dep-map');

  // ── Cas 1 : carte déjà créée — juste invalider + rebind ──
  if (_turMap) {
    setTimeout(() => { try { _turMap.invalidateSize(); } catch(_){} }, 100);
    setTimeout(() => { try { _turMap.invalidateSize(); } catch(_){} }, 400);
    _rebindMapClick(_turMap);
    return;
  }

  // ── Cas 2 : APP.map est déjà une instance Leaflet (a une méthode invalidateSize) ──
  // map.js assigne directement à APP.map, pas APP.map.instance
  if (APP.map && typeof APP.map.invalidateSize === 'function') {
    _turMap = APP.map;
    APP.map.instance = _turMap; // synchroniser le namespace aussi
    window._tourMap  = _turMap;
    _rebindMapClick(_turMap);
    setTimeout(() => { try { _turMap.invalidateSize(); } catch(_){} }, 150);
    return;
  }

  // ── Cas 3 : APP.map.instance est une instance Leaflet valide ──
  if (APP.map?.instance && typeof APP.map.instance.invalidateSize === 'function') {
    _turMap = APP.map.instance;
    window._tourMap = _turMap;
    _rebindMapClick(_turMap);
    setTimeout(() => { try { _turMap.invalidateSize(); } catch(_){} }, 150);
    return;
  }

  // ── Cas 4 : rien n'existe encore — créer la carte sur dep-map ──
  if (!depMapEl) return;

  // Vérifier que Leaflet est chargé
  if (typeof L === 'undefined') {
    setTimeout(initTurMap, 200);
    return;
  }

  // Vérifier que dep-map n'a pas déjà été initialisé par Leaflet
  if (depMapEl._leaflet_id) {
    // Leaflet a déjà un ID sur cet élément mais APP.map n'a pas été enregistré
    // Récupérer via le registre Leaflet interne
    const existingMap = Object.values(L.map._instances || {}).find(m => m.getContainer() === depMapEl);
    if (existingMap) {
      _turMap = existingMap;
      APP.map = _turMap;
      APP.map.instance = _turMap;
      window._tourMap  = _turMap;
      _rebindMapClick(_turMap);
      setTimeout(() => { try { _turMap.invalidateSize(); } catch(_){} }, 150);
      return;
    }
  }

  // Créer une instance Leaflet fraîche sur dep-map
  try {
    _turMap = L.map('dep-map', { zoomControl: true, attributionControl: true })
               .setView([46.603354, 1.888334], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(_turMap);

    // Enregistrer dans APP.map des deux façons (compatibilité map.js ET ui.js)
    APP.map          = _turMap;       // map.js utilise APP.map directement
    APP.map.instance = _turMap;       // ui.js / extras.js utilisent APP.map.instance
    window._tourMap  = _turMap;

    _rebindMapClick(_turMap);
    setTimeout(() => { try { _turMap.invalidateSize(); } catch(_){} }, 150);
    setTimeout(() => { try { _turMap.invalidateSize(); } catch(_){} }, 500);
  } catch(e) {
    console.warn('[AMI] initTurMap : erreur création carte :', e.message);
  }
}

/* ── Restaure le marker de départ sur la carte si startPoint déjà défini ── */
function _restoreStartPointMarker() {
  const sp = APP.get('startPoint');
  if (!sp || !sp.lat || !sp.lng) return;
  const map = _turMap || APP.map;
  if (!map || typeof map.setView !== 'function') return;

  // Centrer sur le startPoint
  map.setView([sp.lat, sp.lng], 15);

  // Replacer le marker via les fonctions de map.js si dispo
  if (typeof _setDepMarker === 'function') {
    _setDepMarker(sp.lat, sp.lng);
  }

  // Mettre à jour le champ texte dep-coords
  const depCoords = document.getElementById('dep-coords');
  const depAddr   = document.getElementById('dep-addr');
  if (depCoords && depCoords.textContent.startsWith('📌')) {
    // Pas encore d'adresse affichée — faire un reverse geocoding discret
    if (depAddr && !depAddr.value) {
      if (typeof reverseGeocode === 'function') {
        reverseGeocode(sp.lat, sp.lng).then(addr => {
          if (depAddr) depAddr.value = addr;
          if (depCoords) { depCoords.textContent = '✅ ' + addr; depCoords.style.display = 'block'; }
        }).catch(() => {});
      } else {
        depCoords.textContent = `✅ Départ défini — ${sp.lat.toFixed(5)}, ${sp.lng.toFixed(5)}`;
        depCoords.style.display = 'block';
      }
    }
  }
}

/* ── initDepMap — alias pour compatibilité avec ui.js qui l'appelle ── */
window.initDepMap = initTurMap;

/* ─── Branche le handler de clic carte pour le point de départ ───────
   Conserve TOUS les comportements de map.js (_setDepMarker, setDepCoords,
   reverseGeocode) ET y ajoute setDepartPoint pour extras.js.
   On ne supprime PLUS le handler existant — on l'augmente.
──────────────────────────────────────────────────────────────────── */
function _rebindMapClick(map){
  if(!map) return;

  // Retirer l'éventuel handler précédent d'extras.js uniquement
  if(_turMapClickHandler) {
    map.off('click', _turMapClickHandler);
  }

  // Curseur crosshair sur la carte pour indiquer qu'on peut cliquer
  const container = map.getContainer();
  if(container) container.style.cursor = 'crosshair';

  // Hint visuel sur dep-coords si pas encore de point défini
  const coordsEl = document.getElementById('dep-coords');
  if(coordsEl && !APP.get('startPoint')) {
    coordsEl.textContent = '👆 Cliquez sur la carte pour définir votre départ';
    coordsEl.style.display = 'block';
  }

  _turMapClickHandler = function(e){
    const {lat, lng} = e.latlng;

    // Appeler map.js si disponible (marker draggable + geocodage inverse)
    if(typeof _setDepMarker === 'function') _setDepMarker(lat, lng);
    if(typeof setDepCoords  === 'function') setDepCoords(lat, lng);
    if(typeof reverseGeocode=== 'function') reverseGeocode(lat, lng);

    // Puis setDepartPoint d'extras.js (synchro APP.startPoint + inputs cachés)
    setDepartPoint(lat, lng, '📍 Sélectionné sur la carte');

    // Remettre curseur normal après sélection
    if(container) container.style.cursor = '';
  };

  map.on('click', _turMapClickHandler);
}
let _turMapClickHandler = null;

/* ── Attend que _turMap soit prêt (initTurMap peut nécessiter quelques ms) ── */
function _waitTurMap(cb, attempts) {
  attempts = attempts || 0;
  const map = _turMap
    || (APP.map && typeof APP.map.invalidateSize === 'function' ? APP.map : null)
    || (APP.map && APP.map.instance && typeof APP.map.instance.invalidateSize === 'function' ? APP.map.instance : null);
  if (map) { _turMap = map; cb(map); return; }
  if (attempts > 20) { console.warn('[AMI] _waitTurMap : carte non disponible'); return; }
  setTimeout(() => _waitTurMap(cb, attempts + 1), 100);
}

function _placeDepMarker(map, lat, lng, label) {
  if (_turMarker) { try { map.removeLayer(_turMarker); } catch(_) {} }
  const icon = L.divIcon({
    className: '',
    html: `<div style="background:#00d4aa;border:3px solid #fff;border-radius:50%;width:18px;height:18px;box-shadow:0 0 12px rgba(0,212,170,.8)"></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9]
  });
  _turMarker = L.marker([lat, lng], { icon })
    .addTo(map)
    .bindPopup(`<b>📍 Départ</b><br>${label}`)
    .openPopup();
  map.setView([lat, lng], 15);
  setTimeout(() => { try { map.invalidateSize(); } catch(_) {} }, 50);
  setTimeout(() => { try { map.invalidateSize(); } catch(_) {} }, 300);
}

function setDepartPoint(lat, lng, label){
  /* Mettre à jour les inputs et APP.startPoint */
  const tLat = $('t-lat'), tLng = $('t-lng');
  if(tLat) tLat.value = lat.toFixed(6);
  if(tLng) tLng.value = lng.toFixed(6);
  APP.set('startPoint', {lat, lng});

  /* Affichage coordonnées — immédiat, pas besoin d'attendre la carte */
  const coordsEl = $('dep-coords') || $('tur-coords-txt');
  if(coordsEl) {
    coordsEl.textContent = `📌 Départ : ${label} — ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    coordsEl.style.display = 'block';
  }

  /* Initialiser la carte si pas encore fait, puis attendre qu'elle soit prête */
  if(!_turMap) initTurMap();
  /* _waitTurMap retente toutes les 100ms jusqu'à ce que _turMap soit disponible
     → le marker s'affiche même si initTurMap() est en cours d'initialisation */
  _waitTurMap(map => _placeDepMarker(map, lat, lng, label));

  updateCAEstimate();
}

/* Géocodage adresse via Nominatim pour tur-map */
async function searchAddress(){
  // Lire depuis dep-addr (input visible) ou t-address
  const depAddr = document.getElementById('dep-addr');
  const tAddr   = document.getElementById('t-address');
  const q = ((depAddr?.value || tAddr?.value) || '').trim();
  if(!q){ alert('Saisissez une adresse.'); return; }

  const coordsTxt = $('dep-coords') || $('tur-coords-txt');
  if(coordsTxt) coordsTxt.textContent = '🔍 Recherche en cours…';

  try{
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`,
      { headers: {'Accept-Language':'fr'} }
    );
    const data = await r.json();
    if(!data.length){
      if(coordsTxt) coordsTxt.textContent = '❌ Adresse introuvable. Essayez avec plus de précision.';
      return;
    }
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    const label = data[0].display_name.split(',').slice(0,2).join(', ');
    setDepartPoint(lat, lng, label);
  } catch(e){
    const coordsTxt = $('dep-coords') || $('tur-coords-txt');
    if(coordsTxt) coordsTxt.textContent = '⚠️ Erreur géocodage : ' + e.message;
  }
}

/* GPS position actuelle → tur-map / dep-map */
function useMyLocation(){
  /* Déléguer à getGPS() de map.js si disponible — gère dep-map + précision */
  if(typeof getGPS === 'function') { getGPS(); return; }

  if(!navigator.geolocation){
    alert('Géolocalisation non supportée par votre navigateur.');
    return;
  }
  const coordsEl = $('dep-coords') || $('tur-coords-txt');
  if(coordsEl) coordsEl.textContent = '📡 Localisation en cours…';

  navigator.geolocation.getCurrentPosition(
    pos => setDepartPoint(pos.coords.latitude, pos.coords.longitude, '📍 Ma position GPS'),
    err => {
      if(coordsEl) coordsEl.textContent = '⚠️ GPS refusé ou indisponible. Saisissez une adresse.';
      console.warn('GPS err:', err.code, err.message);
    },
    { enableHighAccuracy:true, timeout:15000, maximumAge:0 }
  );
}

/* Dessiner le trajet OSRM (geojson) sur tur-map */
function drawRouteOSRM(data){
  if(!_turMap) return;
  const geom = data?.trips?.[0]?.geometry || data?.routes?.[0]?.geometry;
  if(!geom) return;

  if(_turRouteLine) _turMap.removeLayer(_turRouteLine);

  const coords = geom.coordinates.map(c => [c[1], c[0]]);
  _turRouteLine = L.polyline(coords, {
    color: '#00d4aa', weight: 4, opacity: 0.8, dashArray: '8,4'
  }).addTo(_turMap);
  _turMap.fitBounds(_turRouteLine.getBounds(), {padding:[20,20]});
}

/* Tracking GPS live sur tur-map */
function trackPositionTur(){
  if(!navigator.geolocation || !_turMap) return;
  navigator.geolocation.watchPosition(pos => {
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    if(!_turLiveMarker){
      const icon = L.divIcon({
        className:'',
        html:`<div style="background:#4fa8ff;border:3px solid #fff;border-radius:50%;width:16px;height:16px;box-shadow:0 0 16px rgba(79,168,255,.9)"></div>`,
        iconSize:[16,16]
      });
      _turLiveMarker = L.marker([lat,lng],{icon}).addTo(_turMap).bindPopup('📍 Votre position');
    }else{
      _turLiveMarker.setLatLng([lat,lng]);
    }
    APP.set('userPos', {lat, lng});
  }, err => console.warn('trackPositionTur:', err.message));
}

/* Rendu tournée OSRM trip (waypoints triés + fraude inline) */
function renderTourneeOSRM(data, patients, startLat, startLng){
  const trip  = data.trips[0];
  const wps   = data.waypoints;
  const totalMin = Math.round(trip.duration/60);
  const totalKm  = (trip.distance/1000).toFixed(1);
  const ca    = estimateRevenue(patients || APP.get('importedData')?.patients || []);

  drawRouteOSRM(data);

  /* Markers numérotés patients */
  patients.filter(p=>p.lat&&p.lng).forEach((p,i)=>{
    if(_turMap){
      const icon = L.divIcon({
        className:'',
        html:`<div style="background:var(--a2,#4fa8ff);color:#fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5)">${i+1}</div>`,
        iconSize:[26,26]
      });
      L.marker([p.lat,p.lng],{icon}).addTo(_turMap)
        .bindPopup(`<b>${p.acte||p.description||'Soin'}</b><br>${p.time||p.heure||''}`);
    }
  });

  /* Rendu HTML */
  const ordered = wps.slice(1).sort((a,b) => a.waypoint_index - b.waypoint_index);
  let html = `<div class="card"><div class="ct">🗺️ Tournée OSRM — ${ordered.length} patients</div>
    <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">
      <div class="dreb">⏱️ ${totalMin} min</div>
      <div class="dreb">📏 ${totalKm} km</div>
      <div class="ca-pill">💰 CA estimé : ${ca.toFixed(2)} €</div>
    </div>`;

  const opts = suggestOptimizationsFront();
  ordered.forEach((wp,i)=>{
    const p = patients[wp.waypoint_index-1] || patients[i] || {};
    const fs = fraudeScore(p);
    const sd  = encodeURIComponent(p.acte || p.texte || p.description || "");
    const spn = encodeURIComponent(((p.prenom||"") + " " + (p.nom||"")).trim() || p.patient || "");
    html += `<div class="route-item">
      <div class="route-num">${i+1}</div>
      <div class="route-info">
        <strong style="font-size:13px">${p.acte||p.description||'Patient'}</strong>
        ${p.time||p.heure?`<div style="font-size:11px;color:var(--m)">${p.time||p.heure}</div>`:''}
      </div>
      ${p.distance_km||wp.distance ? `<div class="route-km">+${p.distance_km||(wp.distance/1000).toFixed(1)}km</div>` : ''}
      ${fs>40 ? `<div style="color:var(--d);font-size:11px;font-weight:600;margin-right:4px">⚠️ Fraude</div>` : ''}
      <button class="btn bp bsm" onclick="coterDepuisRoute(decodeURIComponent('${sd}'),decodeURIComponent('${spn}'))">⚡ Coter</button>
    </div>`;
  });

  if(opts.length) html += `<div class="aic" style="margin-top:16px">${opts.map(o=>`<div class="ai wa">💡 ${o}</div>`).join('')}</div>`;
  html += `</div>`;

  const tbody = $('tbody');
  if(tbody) tbody.innerHTML = html;
  const resTur = $('res-tur');
  if(resTur) resTur.classList.add('show');
}

/* ════════════════════════════════════════════════
   INTELLIGENCE MÉTIER FRONT
════════════════════════════════════════════════ */

/* Score fraude par patient (côté front, pour affichage tournée) */
function fraudeScore(p){
  let s = 0;
  const acte = (p.acte || p.description || '').toLowerCase();
  if(acte.includes('nuit') && !(p.time||p.heure)) s += 30;
  if((p.km || p.distance_km || 0) > 50) s += 20;
  if(acte.includes('double')) s += 50;
  if(acte.split('+').length > 4) s += 15; // trop d'actes
  return s;
}

/* Suggestions d'optimisation depuis IMPORTED_DATA (front, sans API) */
function suggestOptimizationsFront(){
  const data = APP.get('importedData')?.patients || window.IMPORTED_DATA || [];
  const seen = new Set();
  const suggestions = [];
  data.forEach(p => {
    const acte = (p.acte || p.description || '').toLowerCase();
    if(!p.time && !p.heure) {
      const k='time'; if(!seen.has(k)){seen.add(k);suggestions.push('Ajouter une heure → majorations nuit/dimanche possibles');}
    }
    if((acte.includes('domicile')||acte.includes('chez')) && !(p.km||p.distance_km)) {
      const k='ik'; if(!seen.has(k)){seen.add(k);suggestions.push('Ajouter la distance → IK non facturés (0,35 €/km)');}
    }
    if(acte.includes('toilette') && acte.includes('ais')) {
      const k='bsc'; if(!seen.has(k)){seen.add(k);suggestions.push('Toilette + AIS → BSA/BSB/BSC plus rentable (+10 € et +)');}
    }
    if(acte.includes('insuline') && !acte.includes('ami')) {
      const k='ami'; if(!seen.has(k)){seen.add(k);suggestions.push('Injection insuline → AMI1 (3,15 €) + IFD si domicile');}
    }
  });
  return suggestions;
}

/* Box CA dans l'onglet tournée (utilise l'élément ca-box) */
function updateCAEstimate(){
  const box = $('ca-box');
  if(!box) return;
  const data = APP.get('importedData')?.patients || window.IMPORTED_DATA || [];
  if(!data.length){ box.style.display='none'; return; }
  const ca = estimateRevenue(data);
  box.style.display='block';
  box.innerHTML=`💰 <strong>CA estimé journée : ${ca.toFixed(2)} €</strong> · ${data.length} patients · Moy. ${(ca/data.length).toFixed(2)} €/patient`;
}

/* ════════════════════════════════════════════════
   PILOTAGE LIVE LOCAL (mode IMPORTED_DATA)
════════════════════════════════════════════════ */

/* Affiche le prochain patient dans le mode pilotage local */
function showNextPatientLocal(){
  const data = APP.get('importedData')?.patients || window.IMPORTED_DATA || [];
  const idx  = window._liveIndex || 0;
  const p    = data[idx];

  const nameEl = $('live-patient-name');
  const infoEl = $('live-info');

  if(!p){
    if(nameEl) nameEl.textContent = 'Tournée terminée ✅';
    if(infoEl) infoEl.textContent = 'Tous les patients ont été pris en charge';
    // Mettre à jour la liste unifiée
    if(typeof renderLivePatientList === 'function') renderLivePatientList();
    return;
  }

  if(nameEl) nameEl.textContent = p.acte || p.description || 'Patient suivant';
  // Afficher uniquement l'heure — le compteur restant(s) est dans renderLivePatientList
  if(infoEl) infoEl.textContent = `Heure prévue : ${p.heure_soin||p.heure_preferee||p.time||p.heure||'—'}`;

  // Déléguer l'affichage de la liste à renderLivePatientList (source unique)
  if(typeof renderLivePatientList === 'function') renderLivePatientList();
}

/* Détection retard via IMPORTED_DATA + badge */
function detectDelayLocal(){
  const data = APP.get('importedData')?.patients || window.IMPORTED_DATA || [];
  const idx  = window._liveIndex || 0;
  const p    = data[idx];
  if(!p?.heure_soin && !p?.heure_preferee && !p?.time && !p?.heure) return;

  const heure = p.heure_soin || p.heure_preferee || p.time || p.heure;
  const [h,m] = heure.split(':').map(Number);
  const target = new Date();
  target.setHours(h, m, 0, 0);

  if(new Date() > target){
    const badge = $('live-badge');
    if(badge){
      badge.textContent = 'RETARD';
      badge.style.background = 'var(--dd)';
      badge.style.color = 'var(--d)';
    }
    const alertEl = $('live-delay-alert');
    const msgEl   = $('live-delay-msg');
    if(alertEl && msgEl){
      const diffMin = Math.round((Date.now() - target.getTime()) / 60000);
      msgEl.textContent = `Retard de ${diffMin} min sur ${heure}. Souhaitez-vous recalculer ?`;
      alertEl.style.display = 'block';
    }
  }
}

/* Démarrage journée en mode local (IMPORTED_DATA) */
function startDayLocal(){
  if(!APP.get('importedData') && !window.IMPORTED_DATA?.length) return false;

  window._liveIndex = 0;
  const data = APP.get('importedData')?.patients || window.IMPORTED_DATA || [];

  /* Tri priorité médicale */
  data.sort((a,b) => {
    let sa=0, sb=0;
    const aa=(a.acte||a.description||'').toLowerCase();
    const bb=(b.acte||b.description||'').toLowerCase();
    if(aa.includes('insuline')) sa+=10; if(bb.includes('insuline')) sb+=10;
    if(aa.includes('perfusion')) sa+=8;  if(bb.includes('perfusion')) sb+=8;
    if(aa.includes('pansement')) sa+=6;  if(bb.includes('pansement')) sb+=6;
    if(aa.includes('toilette'))  sa+=4;  if(bb.includes('toilette'))  sb+=4;
    const ta=a.time||a.heure||'99', tb=b.time||b.heure||'99';
    if(ta<'10:00') sa+=8; if(tb<'10:00') sb+=8;
    return sb - sa;
  });

  showNextPatientLocal();

  /* Détecter retards toutes les 2 minutes */
  if(window._delayInterval) clearInterval(window._delayInterval);
  window._delayInterval = setInterval(detectDelayLocal, 120000);

  return true; // signale que le mode local a été activé
}

/* ════════════════════════════════════════════════
   PLANNING LOCAL DEPUIS IMPORT (sans appel API)
   Version directe qui n'a pas besoin du worker
════════════════════════════════════════════════ */
function generatePlanningLocal(){
  const data = APP.get('importedData')?.patients || window.IMPORTED_DATA || [];
  if(!data.length){
    const pbody = $('pbody');
    if(pbody) pbody.innerHTML = '<div class="ai wa">⚠️ Aucune donnée importée. Importez votre planning via "Import calendrier" d\'abord.</div>';
    const resPla = $('res-pla');
    if(resPla) resPla.classList.add('show');
    return;
  }

  /* Regrouper par jour */
  const days = {};
  data.forEach(ev => {
    const day = ev.date || ev.day || ev.date_soin || 'Non daté';
    if(!days[day]) days[day] = [];
    days[day].push(ev);
  });

  const ordre = ['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'];
  const sortedKeys = Object.keys(days).sort((a,b)=>{
    const ai = ordre.indexOf(a.toLowerCase());
    const bi = ordre.indexOf(b.toLowerCase());
    if(ai>=0 && bi>=0) return ai-bi;
    return a.localeCompare(b);
  });

  let html = `<div class="card"><div class="ct">📅 Planning hebdomadaire — ${data.length} patients</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:12px">`;

  sortedKeys.forEach(day=>{
    const pts = days[day];
    /* CA estimé par jour */
    const ca = pts.reduce((s,p)=>{
      const a=(p.actes_recurrents||p.acte||p.description||'').toLowerCase();
      if(a.includes('insuline')) return s+26.35;
      if(a.includes('pansement complexe')) return s+22;
      if(a.includes('pansement')) return s+19;
      if(a.includes('toilette')||a.includes('bsc')) return s+31.45;
      if(a.includes('bsb')) return s+20.95;
      if(a.includes('bsa')) return s+15.75;
      if(a.includes('perfusion')) return s+28;
      return s+15;
    }, 0);
    html += `<div style="background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:14px">
      <div style="font-weight:600;text-transform:capitalize;margin-bottom:4px;font-size:14px">${day}</div>
      <div style="font-size:11px;color:var(--a);margin-bottom:10px">${pts.length} patient(s) · ~${ca.toFixed(0)} €</div>
      ${pts.map(p=>{
        const soinAff = p.actes_recurrents || p.acte || p.description || 'Patient';
        const isActes = !!p.actes_recurrents;
        return `<div class="route-item" style="padding:6px 0;border-bottom:1px solid var(--b)">
          <div class="route-info" style="font-size:12px">${p.patient||[p.prenom,p.nom].filter(Boolean).join(' ')||'Patient'}</div>
          ${isActes ? `<div style="font-size:11px;color:var(--a);font-family:var(--fm);margin-top:2px">💊 ${soinAff.slice(0,60)}</div>` : (soinAff !== 'Patient' ? `<div style="font-size:11px;color:var(--m);margin-top:2px">${soinAff.slice(0,60)}</div>` : '')}
          ${p.time||p.heure?`<div class="route-time" style="font-size:11px">⏰ ${p.time||p.heure}</div>`:''}
        </div>`;
      }).join('')}
    </div>`;
  });

  html += `</div></div>`;
  const pbody = $('pbody');
  if(pbody) pbody.innerHTML = html;
  const perr = $('perr');
  if(perr) perr.style.display = 'none';
  const resPla = $('res-pla');
  if(resPla) resPla.classList.add('show');
}

/* ════════════════════════════════════════════════
   FAQ — RECHERCHE FILTRANTE
════════════════════════════════════════════════ */
function filterFaq(){
  const q = ($('faq-search')?.value || '').toLowerCase().trim();
  let anyVisible = false;

  document.querySelectorAll('#view-aide .accord').forEach(item=>{
    const text = item.textContent.toLowerCase();
    const match = !q || text.includes(q);
    item.style.display = match ? '' : 'none';
    if(match){
      anyVisible = true;
      if(q) item.classList.add('open');
      else  item.classList.remove('open');
    }
  });

  document.querySelectorAll('#view-aide .faq-section').forEach(section=>{
    const visible = [...section.querySelectorAll('.accord')].some(a=>a.style.display!=='none');
    section.style.display = visible ? '' : 'none';
  });

  const noRes = $('faq-no-result');
  if(noRes) noRes.style.display = anyVisible ? 'none' : 'block';
}

/* ════════════════════════════════════════════════
   NORMALISATION MÉDICALE ÉTENDUE
   (avec conversion chiffres écrits → chiffres)
   Version complète issue de ami-ngap.html
════════════════════════════════════════════════ */
function normalizeMedicalFull(txt){
  let t = txt.toLowerCase();

  /* Chiffres écrits → numériques */
  const nums = {
    'zéro':0,'un':1,'une':1,'deux':2,'trois':3,'quatre':4,'cinq':5,
    'six':6,'sept':7,'huit':8,'neuf':9,'dix':10,'onze':11,'douze':12,
    'treize':13,'quatorze':14,'quinze':15,'seize':16,'vingt':20,
    'vingt-deux':22,'vingt-trois':23,'trente':30,'quarante':40,
    'cinquante':50,'soixante':60,'soixante-dix':70,'quatre-vingt':80,'quatre-vingt-dix':90
  };
  Object.entries(nums)
    .sort((a,b) => b[0].length - a[0].length)
    .forEach(([w,n]) => { t = t.replace(new RegExp(w,'g'), n); });

  /* Heures */
  t = t.replace(/(\d+)\s*heures?/g,'$1h').replace(/\bmidi\b/g,'12h').replace(/\bminuit\b/g,'0h');

  /* Kilomètres */
  t = t.replace(/(\d+)\s*kilomètres?/g,'$1 km');

  /* Termes médicaux */
  const med = [
    [/\b(piquer|piqûre|injecter)\b/g,           'injection SC'],
    [/\badministrer insuline\b/g,                'injection insuline SC'],
    [/\bprise de sang\b|\bbilan sanguin\b/g,     'prélèvement sanguin'],
    [/\b(toilette totale|bain complet)\b/g,      'toilette complète'],
    [/\b(grabataire|alité|immobilisé)\b/g,       'patient grabataire'],
    [/\b(chez le patient|au domicile|à domicile)\b/g, 'domicile'],
  ];
  med.forEach(([rx,rep]) => { t = t.replace(rx, rep); });

  return t.trim();
}

/* ════════════════════════════════════════════════
   HOOKS D'INITIALISATION
════════════════════════════════════════════════ */

/* initTurMap au clic sur l'onglet tournée (en complément de initDepMap) */
document.addEventListener('DOMContentLoaded', ()=>{
  /* Écouter l'event réel émis par ui.js (ui:navigate) */
  document.addEventListener('ui:navigate', e=>{
    if(e.detail?.view === 'tur'){
      setTimeout(()=>{
        initTurMap();
        updateCAEstimate();
        // Restaurer le marker startPoint sur la carte si déjà défini
        _restoreStartPointMarker();
      }, 300);
    }
    if(e.detail?.view === 'live'){
      startDayLocal();
    }
    if((e.detail?.view === 'dash' || e.detail?.view === 'stats') && typeof loadStatsAvancees === 'function'){
      setTimeout(loadStatsAvancees, 300);
    }
  });

  /* Compatibilité app:nav (dispatché par certains modules) */
  document.addEventListener('app:nav', e=>{
    if(e.detail?.view === 'tur'){
      setTimeout(()=>{ initTurMap(); updateCAEstimate(); }, 150);
    }
    // Mettre à jour l'heure courante à chaque retour sur la vue cotation
    if(e.detail?.view === 'cot'){
      const fhs = document.getElementById('f-hs');
      if(fhs && !fhs._userEdited) {
        const now = new Date();
        fhs.value = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
      }
      const fds = document.getElementById('f-ds');
      if(fds && !fds.value) fds.value = new Date().toISOString().split('T')[0];
    }
  });

  /* Écouteur sur startDay pour tenter le mode local en priorité */
  const _origStartDay = window.startDay;
  window.startDay = async function(){
    /* Tenter mode local d'abord */
    const usedLocal = startDayLocal();
    if(!usedLocal){
      /* Pas de données locales → déléguer au startDay existant */
      if(typeof _origStartDay === 'function') await _origStartDay();
    }else{
      /* Mode local activé, démarrer le timer */
      if(typeof startLiveTimer === 'function') startLiveTimer();
      const badge = $('live-badge');
      if(badge){ badge.textContent='EN COURS'; badge.style.background='var(--ad)'; badge.style.color='var(--a)'; }
      const btnStart = $('btn-live-start'), btnStop = $('btn-live-stop');
      if(btnStart) btnStart.style.display='none';
      if(btnStop)  btnStop.style.display='inline-flex';
      const liveCtrls = $('live-controls');
      if(liveCtrls) liveCtrls.style.display='block';
    }
  };

  /* Patch liveAction pour mode local */
  const _origLiveAction = window.liveAction;
  window.liveAction = async function(action){
    const data = APP.get('importedData')?.patients || window.IMPORTED_DATA || [];
    if(data.length && window._liveIndex !== undefined){
      const p = data[window._liveIndex];
      if(!p){
        $('live-patient-name').textContent='Journée terminée ✅';
        $('live-info').textContent='Tous les patients ont été vus';
        return;
      }
      if(action==='patient_done'){
        p.done=true;
        /* Auto-cotation */
        try{
          const u=S?.user||{};
          const texteForCot = (p.actes_recurrents || p.acte || p.description || 'soin infirmier')
            + (p.time||p.heure?' à '+(p.time||p.heure):'');
          await apiCall('/webhook/ami-calcul',{
            mode:'ngap',
            texte: texteForCot,
            heure_soin:p.time||p.heure||'',
            infirmiere:((u.prenom||'')+' '+(u.nom||'')).trim(),
            adeli:u.adeli||'',rpps:u.rpps||'',structure:u.structure||'',
            date_soin:new Date().toISOString().split('T')[0],
          });
        }catch(err){ console.warn('Auto-cotation locale:', err.message); }
        window._liveIndex++;
      }
      if(action==='patient_absent'){ p.absent=true; window._liveIndex++; }
      showNextPatientLocal();
      return;
    }
    /* Fallback : ancien comportement */
    if(typeof _origLiveAction==='function') await _origLiveAction(action);
  };

  /* generatePlanningFromImport — si non présente, utiliser la version locale */
  if(typeof generatePlanningFromImport === 'function'){
    const _origGenPlanning = generatePlanningFromImport;
    window.generatePlanningFromImport = function(){
      /* Essayer d'abord la version locale (plus rapide, sans réseau) */
      const data = APP.get('importedData')?.patients || window.IMPORTED_DATA || [];
      if(data.length){
        generatePlanningLocal();
      }else{
        _origGenPlanning();
      }
    };
  } else {
    window.generatePlanningFromImport = generatePlanningLocal;
  }

  /* normalizeMedical — enrichir avec la version full si voice.js l'utilise */
  if(typeof normalizeMedical==='function'){
    const _origNormalize = normalizeMedical;
    window.normalizeMedical = function(txt){
      /* Passer d'abord par la version full, puis l'originale comme fallback */
      try{ return normalizeMedicalFull(txt); }catch{ return _origNormalize(txt); }
    };
  }

  /* importCalendar — enrichir pour afficher boutons navigation après import */
  const _origImportCalendar = window.importCalendar;
  if(typeof _origImportCalendar==='function'){
    window.importCalendar = async function(){
      await _origImportCalendar();
      /* Mettre à jour box CA après import */
      setTimeout(updateCAEstimate, 300);
      /* Ajouter boutons de navigation si import réussi */
      const result = $('imp-result');
      if(result && result.innerHTML.includes('Import réussi') || result?.innerHTML.includes('✅')){
        const nav = document.createElement('div');
        nav.style.cssText='display:flex;gap:10px;flex-wrap:wrap;margin-top:14px';
        nav.innerHTML=`
          <button class="btn bv bsm" onclick="navTo('tur',null)">🗺️ Optimiser la tournée</button>
          <button class="btn bp bsm" onclick="navTo('pla',null);setTimeout(generatePlanningFromImport,300)">📅 Voir le planning</button>
          <button class="btn bs bsm" onclick="navTo('live',null)">▶️ Démarrer le pilotage</button>`;
        result.querySelector('.ai.su, .card')?.appendChild(nav);
      }
    };
  }
});

/* Exposer toutes les nouvelles fonctions globalement */
window.initTurMap           = initTurMap;
window.setDepartPoint       = setDepartPoint;
window.searchAddress        = searchAddress;
window.useMyLocation        = useMyLocation;
window.drawRouteOSRM        = drawRouteOSRM;
window.trackPositionTur     = trackPositionTur;
window.renderTourneeOSRM    = renderTourneeOSRM;
window.fraudeScore          = fraudeScore;
window.suggestOptimizationsFront = suggestOptimizationsFront;
window.updateCAEstimate     = updateCAEstimate;
window.showNextPatientLocal = showNextPatientLocal;
window.detectDelayLocal     = detectDelayLocal;
window.startDayLocal        = startDayLocal;
window.generatePlanningLocal = generatePlanningLocal;
window.filterFaq            = filterFaq;
window.normalizeMedicalFull = normalizeMedicalFull;
