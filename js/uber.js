/* ════════════════════════════════════════════════
   uber.js — AMI NGAP
   ────────────────────────────────────────────────
   Mode Uber Médical — Tournée temps réel
   ⚠️  Requiert Leaflet.js et map.js
   - startLiveTracking() / stopLiveTracking()
   - selectBestPatient() — dispatch intelligent
   - _computeScore() — ETA + urgence + retard + CA
   - getETA() — durée réelle OSRM
   - detectDelaysUber() — retards > 15min
   - markUberDone() / markUberAbsent()
   - recalcRouteUber() — recalcul OSRM complet
   - loadUberPatients() — charge depuis IMPORTED_DATA
   - openNavigation() — Google Maps direct

/* 🚗 MODE UBER MÉDICAL — TOURNÉE TEMPS RÉEL
   GPS continu · Dispatch intelligent · ETA live · Score priorité
   ============================================================ */


/* ── Vérification de dépendances ─────────────── */
(function checkDeps() {
  if (typeof APP === 'undefined')   console.error('uber.js : APP store (utils.js) non chargé.');
  if (typeof depMap === 'undefined') console.warn('uber.js : map.js non chargé — fonctions carte indisponibles.');
  if (typeof L === 'undefined')      console.warn('uber.js : Leaflet non chargé.');
})();

let _watchId=null;
window.UBER_PATIENTS=[];   // liste patients avec done/absent
window.USER_POS=null;       // position live
window.NEXT_PATIENT=null;   // prochain recommandé
let _uberInterval=null;

/* Distance euclidienne rapide (pour tri temps réel) */
function _dist(a,b){
  return Math.sqrt(Math.pow(a.lat-b.lat,2)+Math.pow(a.lng-b.lng,2));
}

/* ETA réel via OSRM */
async function getETA(from,to){
  if(!to.lat||!to.lng)return 999;
  try{
    const url=`https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const r=await fetch(url);
    const d=await r.json();
    return d.routes?.[0]?.duration/60||999; // minutes
  }catch{return _dist(from,to)*1000;} // fallback euclidien
}

/* Score Uber : plus petit = meilleur prochain */
async function _computeScore(p){
  const pos=APP.userPos||APP.startPoint;
  if(!pos) return 999;
  const eta=await getETA(pos,p);            // minutes de trajet réel (OSRM)
  let score=eta*2;                          // distance (moins = mieux)
  if(p.urgence)         score-=50;          // urgence médicale → priorité absolue
  if(p.late)            score-=30;          // déjà en retard → remonte
  if(p.time&&Date.now()>p.time) score-=20;  // heure passée → priorité
  if(p.amount)          score-=parseFloat(p.amount)*0.5; // rentabilité CA
  return score;
}

/* Sélectionne le meilleur prochain patient */
async function selectBestPatient(){
  const remaining=window.UBER_PATIENTS.filter(p=>!p.done&&!p.absent);
  if(!remaining.length){window.NEXT_PATIENT=null;_renderNextPatient();return;}
  // Tri rapide par distance d'abord
  if(window.USER_POS) remaining.sort((a,b)=>_dist(window.USER_POS,a)-_dist(window.USER_POS,b));
  // Score complet sur les 5 premiers (ETA OSRM)
  const top5=remaining.slice(0,5);
  let best=null,bestScore=Infinity;
  for(const p of top5){
    const s=await _computeScore(p);
    if(s<bestScore){bestScore=s;best=p;}
  }
  window.NEXT_PATIENT=best||remaining[0];
  _renderNextPatient();
}

/* Affiche le prochain patient dans la live card */
function _renderNextPatient(){
  const el=$('uber-next-patient');
  if(!el)return;
  const p=window.NEXT_PATIENT;
  if(!p){
    el.innerHTML='<div class="ai su">✅ Tous les patients ont été vus !</div>';
    return;
  }
  const dist=window.USER_POS&&p.lat?(_dist(window.USER_POS,p)*111).toFixed(1)+'km':'—';
  el.innerHTML=`
    <div style="font-size:15px;font-weight:600;margin-bottom:6px">${p.description||p.label||'Patient'}</div>
    <div style="font-size:12px;color:var(--m);margin-bottom:10px">
      ${p.heure_soin?'⏰ '+p.heure_soin:''} ${p.urgence?'🚨 URGENT':''} · 📍 ~${dist}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn bp bsm" onclick="markUberDone()"><span>✅</span> Terminé</button>
      <button class="btn bs bsm" onclick="markUberAbsent()"><span>❌</span> Absent</button>
      ${p.lat?`<button class="btn bv bsm" onclick="openNavigation(window.NEXT_PATIENT)"><span>🗺️</span> Naviguer</button>`:''}
    </div>`;
}

/* Met à jour la position sur la carte live */
function _updateMapLive(lat,lng){
  if(!depMap)return;
  if(window._liveMarker){
    window._liveMarker.setLatLng([lat,lng]);
  }else{
    window._liveMarker=L.circleMarker([lat,lng],{
      radius:10,fillColor:'#00d4aa',color:'#00b891',weight:2,fillOpacity:0.9
    }).addTo(depMap).bindPopup('📍 Vous êtes ici');
  }
}

/* Détecte les retards (15min de dépassement) */
function detectDelaysUber(){
  const now=Date.now();
  window.UBER_PATIENTS.forEach(p=>{
    if(p.time&&!p.done&&now>p.time+15*60*1000)p.late=true;
  });
}

/* GPS CONTINU — watchPosition */
function startLiveTracking(){
  if(!navigator.geolocation){alert('GPS non supporté');return;}
  if(_watchId!==null){console.log('GPS déjà actif');return;}
  const el=$('uber-tracking-status');
  if(el)el.textContent='📡 GPS actif — suivi continu';
  _watchId=navigator.geolocation.watchPosition(
    pos=>{
      const lat=pos.coords.latitude,lng=pos.coords.longitude;
      APP.userPos={lat,lng};          // store centralisé
      APP.startPoint=APP.startPoint||{lat,lng}; // startPoint seulement si pas encore défini
      _updateMapLive(lat,lng);
    },
    err=>{
      console.error('GPS LIVE ERROR',err);
      if(el)el.textContent='❌ GPS perdu — '+err.message;
    },
    {enableHighAccuracy:true,maximumAge:2000,timeout:8000}
  );
  // Recalcul auto toutes les 15s
  _uberInterval=setInterval(()=>{
    detectDelaysUber();
    selectBestPatient();
  },15000);
}

function stopLiveTracking(){
  if(_watchId!==null){navigator.geolocation.clearWatch(_watchId);_watchId=null;}
  if(_uberInterval){clearInterval(_uberInterval);_uberInterval=null;}
  const el=$('uber-tracking-status');
  if(el)el.textContent='⏹️ Suivi GPS arrêté';
}

/* Actions patient */
function markUberDone(){
  const p=window.NEXT_PATIENT;if(!p)return;
  p.done=true;
  selectBestPatient();
  _updateUberProgress();
}
function markUberAbsent(){
  const p=window.NEXT_PATIENT;if(!p)return;
  p.absent=true;
  selectBestPatient();
  _updateUberProgress();
}

/* Barre de progression */
function _updateUberProgress(){
  const total=window.UBER_PATIENTS.length;
  const done=window.UBER_PATIENTS.filter(p=>p.done||p.absent).length;
  const el=$('uber-progress');
  if(el)el.textContent=`${done} / ${total} patients · ${total-done} restant(s)`;
}

/* Navigation Google Maps directe */
function openNavigation(p){
  if(!p?.lat||!p?.lng){alert('Adresse GPS du patient non disponible.');return;}
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`,'_blank');
}

/* Recalcul OSRM complet de la tournée */
async function recalcRouteUber(){
  const pos=APP.userPos||APP.startPoint;
  if(!pos){alert('Active le GPS d\'abord.');return;}
  const remaining=window.UBER_PATIENTS.filter(p=>!p.done&&!p.absent&&p.lat&&p.lng);
  if(!remaining.length){alert('Aucun patient restant avec coordonnées GPS.');return;}
  const coords=[[pos.lng,pos.lat],...remaining.map(p=>[p.lng,p.lat])];
  try{
    const url=`https://router.project-osrm.org/trip/v1/driving/${coords.map(c=>c.join(',')).join(';')}?source=first&roundtrip=false`;
    const r=await fetch(url);
    const d=await r.json();
    if(d.code==='Ok'){
      const totalMin=Math.round(d.trips[0].duration/60);
      const totalKm=(d.trips[0].distance/1000).toFixed(1);
      const el=$('uber-route-info');
      if(el)el.innerHTML=`🗺️ Route optimisée : <strong>${totalKm} km</strong> · <strong>${totalMin} min</strong>`;
    }
  }catch(e){console.warn('OSRM recalc:',e.message);}
}

/* Charge les patients importés dans le moteur Uber */
function loadUberPatients(){
  if(!requireAuth()) return;
  if(!APP.importedData){
    const el=$('uber-next-patient');
    if(el) el.innerHTML=`<div class=\"ai wa\">⚠️ Aucune donnée importée. Utilisez d'abord \"Import calendrier\".</div>`;
    return;
  }
  const raw=APP.importedData?.patients||APP.importedData?.entries||[];
  window.UBER_PATIENTS=raw.map((p,i)=>({
    ...p,
    id:p.patient_id||p.id||i,
    label:p.description||p.texte||p.summary||'Patient '+(i+1),
    done:false,
    absent:false,
    late:false,
    urgence:!!(p.urgence||p.priorite==='urgent'),
    time:p.heure_soin?_parseTime(p.heure_soin):null,
    amount:parseFloat(p.total||p.montant||0)||0,
    lat:parseFloat(p.lat||p.latitude)||null,
    lng:parseFloat(p.lng||p.longitude||p.lon)||null
  }));
  _updateUberProgress();
  selectBestPatient();
}
function _parseTime(h){
  if(!h)return null;
  const [hh,mm]=(h||'').split(':').map(Number);
  const t=new Date();t.setHours(hh||0,mm||0,0,0);
  return t.getTime();
}

/* ============================================================
