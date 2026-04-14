/* ════════════════════════════════════════════════
   tournee.js — AMI NGAP v5.0
   ────────────────────────────────────────────────
   Tournée IA + Import + Planning + Pilotage Live
   ⚠️  Requiert Leaflet.js, map.js, uber.js, ai-tournee.js
   v5.0 :
   ✅ optimiserTournee() — moteur IA local (VRPTW + 2-opt)
   ✅ Mode dégradé API si IA indisponible
   ✅ Affichage horaires calculés (arrivée, début soin)
   ✅ Score rentabilité €/h après optimisation
   ✅ startLiveOptimization() au démarrage journée
════════════════════════════════════════════════ */

/* ── Guards ──────────────────────────────────── */
(function checkDeps() {
  assertDep(typeof APP !== 'undefined',            'tournee.js : utils.js non chargé.');
  assertDep(typeof optimizeTour !== 'undefined',   'tournee.js : ai-tournee.js non chargé.');
  assertDep(typeof L !== 'undefined',              'tournee.js : Leaflet non chargé.');
})();

/* Fallback défensif si optimizeTour non disponible (ne devrait pas arriver) */
if (typeof optimizeTour === 'undefined') {
  window.optimizeTour = async function(patients) {
    return [...patients].sort((a,b) => (a.heure||'').localeCompare(b.heure||''));
  };
}

function storeImportedData(d){
  APP.importedData=d;
  // Mettre à jour le banner Planning
  const banner=$('pla-import-banner');
  const info=$('pla-import-info');
  if(banner&&d){
    const n=d.total||d.patients?.length||d.entries?.length||'?';
    if(info)info.innerHTML=`✅ <strong>${n}</strong> entrée(s) importée(s) disponibles pour générer un planning automatique.`;
    banner.style.display='block';
    const manual=$('pla-manual');
    if(manual)manual.style.display='none';
  }
  showCaFromImport();
}

/* ── Mode d'optimisation sélectionné dans le pilotage ── */
function getOptimMode() {
  const el = document.querySelector('input[name="live-optim-mode"]:checked');
  return el ? el.value : 'ia'; // 'ia' | 'heure' | 'mixte'
}

/* ── Style réactif des radio buttons du sélecteur de mode ── */
function _bindOptimModeUI() {
  document.querySelectorAll('input[name="live-optim-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const labels = { ia: 'live-mode-ia-lbl', heure: 'live-mode-heure-lbl', mixte: 'live-mode-mixte-lbl' };
      Object.entries(labels).forEach(([val, lblId]) => {
        const lbl = $(lblId);
        if (!lbl) return;
        if (radio.value === val && radio.checked) {
          lbl.style.border = '2px solid var(--a)';
          lbl.style.background = 'rgba(0,212,170,.06)';
        } else {
          lbl.style.border = '1px solid var(--b)';
          lbl.style.background = 'var(--s)';
        }
      });
    });
  });
}

/* Initialiser le binding UI au chargement de la section live */
document.addEventListener('app:nav', e => {
  if (e.detail?.view === 'live') setTimeout(_bindOptimModeUI, 100);
});

function showCaFromImport(){
  if(!APP.importedData)return;
  const patients=APP.importedData.patients||APP.importedData.entries||[];
  if(!patients.length)return;
  const ca=estimateRevenue(patients);
  const w=$('tur-ca-wrap'),v=$('tur-ca-val');
  if(w&&v){v.textContent=ca.toFixed(2)+' €';w.style.display='block';}
}

function estimateRevenue(patients){
  // Estimation CA par patient selon type de soin détecté dans description
  const RATES={injection:3.15*2,pansement:3.15*3,toilette:3.15*4,bsa:13,bsb:18.20,bsc:28.70,prelevement:3.15*1.5,perfusion:3.15*5,defaut:3.15*2};
  return patients.reduce((sum,p)=>{
    const d=(p.description||p.texte||p.summary||'').toLowerCase();
    let v=RATES.defaut;
    if(/toilette|bain/.test(d))v=RATES.toilette;
    else if(/perfusion/.test(d))v=RATES.perfusion;
    else if(/prél[eè]vement|prise de sang/.test(d))v=RATES.prelevement;
    else if(/pansement/.test(d))v=RATES.pansement;
    else if(/injection|insuline|piquer/.test(d))v=RATES.injection;
    // + IFD domicile
    if(/domicile/.test(d))v+=2.75;
    return sum+v;
  },0);
}

function showImportedPatients(){
  if(!APP.importedData){alert('Aucune donnée importée. Utilisez "Import calendrier" d\'abord.');return;}
  const patients=APP.importedData.patients||APP.importedData.entries||[];
  if(!patients.length){alert('Aucun patient dans les données importées.');return;}
  $('tbody').innerHTML=`<div class="card"><div class="ct">👥 Patients importés (${patients.length})</div>
    ${patients.map((p,i)=>`<div class="route-item"><div class="route-num">${i+1}</div><div class="route-info"><strong>${p.description||p.texte||p.summary||'Patient '+(i+1)}</strong><div style="font-size:11px;color:var(--m);margin-top:2px">${p.heure_soin||p.heure||''} ${p.patient_id?'· ID:'+p.patient_id:''}</div></div></div>`).join('')}
  </div>`;
  $('res-tur').classList.add('show');
}

/* ============================================================
   PLANNING DEPUIS IMPORT
   ============================================================ */
async function generatePlanningFromImport(){
  if(!APP.importedData){alert('Aucune donnée importée.');return;}
  const patients=APP.importedData.patients||APP.importedData.entries||[];
  if(!patients.length){alert('Aucun patient dans les données importées.');return;}
  // Construire un texte structuré depuis l'import
  const txt=patients.map((p,i)=>{
    const desc=p.description||p.texte||p.summary||'Soin infirmier';
    const freq=p.frequence||p.recurrence||'quotidien';
    return `Patient P${i+1} : ${desc} (${freq})`;
  }).join('\n');
  $('pl-txt').value=txt;
  ld('btn-pla',true);
  $('res-pla').classList.remove('show');
  try{
    const d=await apiCall('/webhook/ami-calcul',{mode:'planning',texte:txt});
    renderPlanning(d);
    $('perr').style.display='none';
  }catch(e){$('perr').style.display='flex';$('perr-m').textContent=e.message;}
  $('res-pla').classList.add('show');
  ld('btn-pla',false);
}

function renderPlanning(d){
  const js=['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'],pl=d.planning||{};
  const ca=APP.importedData?estimateRevenue(APP.importedData.patients||APP.importedData.entries||[]):null;
  $('pbody').innerHTML=`<div class="card"><div class="ct">📅 Planning hebdomadaire</div>
    ${ca?`<div class="ca-pill">💶 CA semaine estimé : ${ca.toFixed(2)} €</div>`:''}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-top:14px">
      ${js.map(j=>`<div style="background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:12px"><div style="font-weight:600;text-transform:capitalize;margin-bottom:8px">${j}</div>${(pl[j]||[]).map(p=>`<div style="font-size:12px;padding:3px 0;border-bottom:1px solid var(--b)">${p}</div>`).join('')||'<div style="font-size:12px;color:var(--m)">—</div>'}</div>`).join('')}
    </div></div>`;
}

/* ============================================================
   ROUTING OSRM
   ============================================================ */
async function getOsrmRoute(waypoints){
  // waypoints = [{lat,lng}, ...]
  if(!waypoints||waypoints.length<2)return null;
  try{
    const coords=waypoints.map(w=>`${w.lng},${w.lat}`).join(';');
    const r=await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=false&steps=false`);
    const d=await r.json();
    if(d.code!=='Ok')return null;
    const route=d.routes[0];
    return{
      total_km:Math.round(route.distance/100)/10,
      total_min:Math.round(route.duration/60),
      legs:route.legs.map(l=>({km:Math.round(l.distance/100)/10,min:Math.round(l.duration/60)}))
    };
  }catch{return null;}
}

/* ============================================================
   TOURNÉE IA — Moteur local VRPTW + 2-opt + MAP PREMIUM
   ============================================================ */
async function optimiserTournee(){
  if(!requireAuth()) return;

  const rawPatients = APP.get('importedData')?.patients || APP.get('importedData')?.entries || [];
  if(!rawPatients.length){
    const tbody=$('tbody');
    if(tbody) tbody.innerHTML=`<div class="card">
      <div class="ct">⚠️ Aucune donnée importée</div>
      <div class="ai wa" style="margin-bottom:12px">Importez d'abord votre planning via <strong>📂 Import calendrier</strong> avant d'optimiser la tournée.</div>
      <button class="btn bp bsm" onclick="navTo('imp',null)"><span>📂</span> Aller à l'import</button>
    </div>`;
    $('res-tur').classList.add('show');
    return;
  }

  const startLat = parseFloat($('t-lat')?.value) || APP.get('startPoint')?.lat || null;
  const startLng = parseFloat($('t-lng')?.value) || APP.get('startPoint')?.lng || null;
  if(!startLat || !startLng){
    $('terr').style.display='flex';
    $('terr-m').textContent='📍 Définis ton point de départ (bouton GPS ou clic sur la carte)';
    $('res-tur').classList.add('show'); return;
  }

  ld('btn-tur',true); $('res-tur').classList.remove('show');
  _showOptimProgress('🧠 Calcul des temps de trajet réels…');

  /* ── Lire le mode d'optimisation choisi ── */
  const optimMode = getOptimMode();

  try {
    const startPoint = { lat: startLat, lng: startLng };

    /* ── MODE HEURES PRÉFÉRÉES : tri chronologique strict ── */
    if (optimMode === 'heure') {
      _showOptimProgress('🕐 Tri par heures préférées…');
      const withHeure  = rawPatients.filter(p => p.heure_preferee || p.heure_soin).sort((a,b)=>
        (a.heure_preferee||a.heure_soin||'99:99').localeCompare(b.heure_preferee||b.heure_soin||'99:99'));
      const withoutH   = rawPatients.filter(p => !p.heure_preferee && !p.heure_soin);
      const route      = [...withHeure, ...withoutH];
      const ca         = estimateRevenue(route);
      const pts        = route.filter(p=>p.lat&&p.lng).map(p=>({lat:p.lat,lng:p.lng}));
      let osrm = null;
      if(pts.length >= 2) osrm = await getOsrmRoute([startPoint,...pts]);
      $('tbody').innerHTML = _renderRouteHTML(route, osrm, ca, null, 'heure');
      $('terr').style.display = 'none';
      if(typeof renderPatientsOnMap === 'function')
        renderPatientsOnMap(route, startPoint).catch(()=>{});
      APP.set('uberPatients', route.map((p,i)=>({...p,id:p.patient_id||p.id||i,label:p.description||'Patient '+(i+1),done:false,absent:false,late:false,amount:0})));
      startLiveOptimization();
      $('res-tur').classList.add('show');
      ld('btn-tur',false);
      return;
    }

    /* ── 1. Moteur IA local — VRPTW greedy + cache OSRM ── */
    _showOptimProgress('⚡ Optimisation VRPTW en cours…');
    let route = await optimizeTour(rawPatients, startPoint, 480, optimMode);

    /* ── 2. 2-opt — amélioration du chemin (sauf si contraintes strictes) ── */
    _showOptimProgress('🔁 Optimisation 2-opt…');
    route = twoOpt(route);

    /* ── 3. Scoring rentabilité ───────────────────────── */
    const rentab = scoreTourneeRentabilite(route);
    const ca     = estimateRevenue(route);

    /* ── 4. OSRM route pour distances précises ────────── */
    let osrm = null;
    const pts = route.filter(p=>p.lat&&p.lng).map(p=>({lat:p.lat,lng:p.lng}));
    if(pts.length >= 2) {
      const wps = [startPoint, ...pts];
      osrm = await getOsrmRoute(wps);
    }

    /* ── 5. Rendu liste ───────────────────────────────── */
    $('tbody').innerHTML = _renderRouteHTML(route, osrm, ca, rentab, optimMode);
    $('terr').style.display = 'none';

    /* ── 6. Map premium — markers + route + timeline ──── */
    if(typeof renderPatientsOnMap === 'function') {
      renderPatientsOnMap(route, startPoint).catch(e=>logWarn('renderPatientsOnMap:',e.message));
    }

    /* ── 7. Préparer patients Uber pour mode live ─────── */
    APP.set('uberPatients', route.map((p,i) => ({
      ...p,
      id:      p.patient_id || p.id || i,
      label:   p.description || p.label || 'Patient '+(i+1),
      done:    false, absent: false, late: false,
      urgence: !!(p.urgent || p.urgence),
      time:    p.start_min ? p.start_min * 60000 : null,
      amount:  parseFloat(p.total || p.montant || 0) || 0,
    })));

    /* ── 8. Démarrer optimisation live ───────────────── */
    startLiveOptimization();

  } catch(e) {
    /* Fallback API backend si moteur local échoue */
    logWarn('Moteur IA local échoué, fallback API:', e.message);
    await _optimiserTourneeAPI(startLat, startLng);
  }

  $('res-tur').classList.add('show');
  ld('btn-tur',false);
}

/* Indicateur de progression optimisation */
function _showOptimProgress(msg) {
  const el = $('terr');
  if(!el) return;
  el.style.display = 'flex';
  const span = $('terr-m');
  if(span) span.textContent = msg;
}

/* Rendu HTML de la route optimisée */
function _renderRouteHTML(route, osrm, ca, rentab, mode) {
  const total = route.filter(p=>p.lat&&p.lng).length;
  const modeBadge = mode === 'heure'
    ? `<span style="font-family:var(--fm);font-size:10px;background:rgba(0,212,170,.12);color:var(--a);border:1px solid rgba(0,212,170,.3);padding:2px 10px;border-radius:20px;letter-spacing:1px">🕐 Heures préférées</span>`
    : mode === 'mixte'
    ? `<span style="font-family:var(--fm);font-size:10px;background:rgba(79,168,255,.1);color:var(--a2);border:1px solid rgba(79,168,255,.3);padding:2px 10px;border-radius:20px;letter-spacing:1px">⚡ Mode mixte</span>`
    : `<span style="font-family:var(--fm);font-size:10px;background:rgba(255,181,71,.1);color:var(--w);border:1px solid rgba(255,181,71,.25);padding:2px 10px;border-radius:20px;letter-spacing:1px">🧠 IA VRPTW</span>`;

  return `<div class="card">
    <div class="ct" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      🗺️ Tournée optimisée — ${total} patients ${modeBadge}
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;margin-top:10px">
      <div class="dreb">📍 ${total} patients</div>
      ${osrm?`<div class="dreb">🚗 ${osrm.total_km} km</div><div class="dreb">⏱ ~${osrm.total_min} min</div>`:''}
      <div class="ca-pill">💶 CA estimé : ${parseFloat(ca).toFixed(2)} €</div>
      ${rentab?`<div class="ca-pill" style="background:rgba(79,168,255,.1);border-color:rgba(79,168,255,.3);color:var(--a2)">📊 ${rentab.euro_heure}€/h</div>`:''}
    </div>
    ${route.map((p,i)=>{
      const sd  = encodeURIComponent(p.description||'');
      const leg = osrm?.legs?.[i];
      const hasTime = p.start_str && p.start_str !== '—';
      const heureAff = p.heure_preferee || p.heure_soin || '';
      const contrainteBadge = p.respecter_horaire
        ? `<span style="font-size:10px;background:rgba(0,212,170,.1);color:var(--a);border:1px solid rgba(0,212,170,.25);padding:1px 7px;border-radius:20px;font-family:var(--fm)">🔒 ${heureAff}</span>`
        : heureAff
        ? `<span style="font-size:10px;background:rgba(255,181,71,.08);color:var(--w);border:1px solid rgba(255,181,71,.2);padding:1px 7px;border-radius:20px;font-family:var(--fm)">⏰ ${heureAff}</span>`
        : '';
      return `<div class="route-item ${p.urgent?'route-urgent':''}">
        <div class="route-num">${i+1}</div>
        <div class="route-info">
          <strong style="font-size:13px">${p.description||'Patient'}</strong>
          <div style="font-size:11px;color:var(--m);margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${hasTime?`🕐 Arrivée ~${p.arrival_str} · Soin ${p.start_str}`:''}
            ${p.urgent?'<span style="color:#ff5f6d;font-weight:700">🚨 URGENT</span>':''}
            ${contrainteBadge}
          </div>
        </div>
        ${leg?`<div class="route-km">+${leg.km}km·${leg.min}min</div>`:(p.travel_min?`<div class="route-km">~${p.travel_min}min</div>`:'')}
        <button class="btn bp bsm" onclick="coterDepuisRoute(decodeURIComponent('${sd}'))">⚡ Coter</button>
      </div>`;
    }).join('')}
  </div>`;
}

/* Fallback API backend (ancien comportement) */
async function _optimiserTourneeAPI(startLat, startLng) {
  try {
    const d = await apiCall('/webhook/ami-tournee-ia',{start_lat:startLat,start_lng:startLng});
    if(!d.ok) throw new Error(d.error||'Erreur API');
    const ca = estimateRevenue(d.route||[]);
    $('tbody').innerHTML = _renderRouteHTML(d.route||[], null, ca, null);
    if(typeof renderPatientsOnMap==='function' && d.route?.length) {
      renderPatientsOnMap(d.route,{lat:startLat,lng:startLng}).catch(()=>{});
    }
  } catch(e) {
    $('terr').style.display='flex';
    $('terr-m').textContent=e.message;
  }
}

/* ============================================================
   PILOTAGE LIVE — ÉTENDU
   ============================================================ */
let LIVE_CA_TOTAL=0;
let LIVE_START_TIME=null;
let LIVE_TIMER_ID=null;

function startLiveTimer(){
  LIVE_START_TIME=Date.now();
  $('live-timer').style.display='block';
  $('live-ca-total').style.display='block';
  if(LIVE_TIMER_ID)clearInterval(LIVE_TIMER_ID);
  LIVE_TIMER_ID=setInterval(()=>{
    const elapsed=Math.floor((Date.now()-LIVE_START_TIME)/1000);
    const h=Math.floor(elapsed/3600),m=Math.floor((elapsed%3600)/60),s=elapsed%60;
    $('live-timer').textContent=`⏱ ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  },1000);
}

function detectDelay(currentPatient){
  if(!currentPatient?.heure_soin)return;
  const now=new Date();
  const [hh,mm]=(currentPatient.heure_soin||'00:00').split(':').map(Number);
  const planned=new Date(now);planned.setHours(hh,mm,0,0);
  const diffMin=Math.round((now-planned)/60000);
  const alertEl=$('live-delay-alert'),msgEl=$('live-delay-msg');
  if(diffMin>15&&alertEl&&msgEl){
    msgEl.textContent=`Retard de ${diffMin} min sur ${currentPatient.heure_soin||'l\'horaire prévu'}. Souhaitez-vous recalculer ?`;
    alertEl.style.display='block';
  }else if(alertEl){
    alertEl.style.display='none';
  }
}

async function autoFacturation(patient){
  // Cotation automatique en arrière-plan quand patient terminé
  if(!patient?.description)return;
  try{
    const u=S?.user||{};
    const d=await apiCall('/webhook/ami-calcul',{
      mode:'ngap',texte:patient.description,
      infirmiere:((u.prenom||'')+' '+(u.nom||'')).trim(),
      adeli:u.adeli||'',rpps:u.rpps||'',structure:u.structure||'',
      date_soin:new Date().toISOString().split('T')[0],
      heure_soin:patient.heure_soin||'',
      _live_auto:true
    });
    if(d.total){
      LIVE_CA_TOTAL+=parseFloat(d.total)||0;
      $('live-ca-total').textContent=`💶 CA du jour : ${LIVE_CA_TOTAL.toFixed(2)} €`;
      updateLiveCaCard(patient,d);
    }
    return d;
  }catch(e){console.warn('Auto-facturation: ',e.message);}
}

function updateLiveCaCard(patient,cot){
  const card=$('live-ca-card');
  const detail=$('live-ca-detail');
  if(!card||!detail)return;
  card.style.display='block';
  const existing=detail.innerHTML;
  detail.innerHTML+=`<div class="route-item"><div class="route-num">✅</div><div class="route-info" style="font-size:12px">${patient.description?.slice(0,40)||'Soin'}</div><div class="route-km" style="color:var(--a)">${(cot.total||0).toFixed(2)} €</div></div>`;
}

async function recalculTournee(){
  try{
    const d=await apiCall('/webhook/ami-live',{action:'recalcul'});
    if(d.ok)await liveStatus();
  }catch(e){alert('Erreur recalcul: '+e.message);}
}

/* ============================================================
   IMPORT CALENDRIER
   ============================================================ */
function importCalendar() {
  const fileEl  = $('imp-file');
  const textEl  = $('imp-text');
  const result  = $('imp-result');
  const text    = textEl ? textEl.value.trim() : '';

  if (!result) return;

  if (fileEl && fileEl.files && fileEl.files.length > 0) {
    const file   = fileEl.files[0];
    const reader = new FileReader();
    reader.onload = e => _processImportData(e.target.result, file.name);
    reader.onerror = () => {
      result.innerHTML = '<div class="ai er">❌ Impossible de lire le fichier.</div>';
      result.classList.add('show');
    };
    reader.readAsText(file, 'UTF-8');
    return;
  }

  if (text) {
    _processImportData(text, 'texte collé');
    return;
  }

  result.innerHTML = '<div class="ai er">⚠️ Aucun fichier ou texte fourni. Déposez un fichier ou collez votre planning.</div>';
  result.classList.add('show');
}

function _processImportData(content, source) {
  const result = $('imp-result');
  if (!result) return;

  let parsed    = null;
  let patients  = [];

  // Tentative JSON
  try {
    parsed = JSON.parse(content);
    const found = parsed.patients || parsed.entries || (Array.isArray(parsed) ? parsed : null);
    if (found) patients = found;
  } catch { /* pas JSON */ }

  // Tentative ICS / texte libre
  if (!patients.length) {
    const lines = content.split('\n').filter(l => l.trim().length > 3);
    patients = lines.map((l, i) => {
      // Essayer d'extraire une adresse depuis la ligne (format : "Nom — 12 rue X, Ville")
      const addrMatch = l.match(/(?:—|-|:)\s*(\d+[^,\n]+(?:rue|avenue|bd|boulevard|allée|impasse|chemin|place|villa|résidence)[^,\n]+(?:,\s*\d{5}[^,\n]*)?)/i);
      return {
        id:          'imp_' + i,
        description: l.trim().replace(/^[-*•→]+\s*/, ''),
        texte:       l.trim(),
        heure_soin:  (l.match(/(\d{1,2})[hH:](\d{2})/) || [])[0] || '',
        adresse:     addrMatch ? addrMatch[1].trim() : '',
      };
    });
  }

  storeImportedData({ patients, total: patients.length, source });

  // Compter les patients avec adresse pour proposer le géocodage
  const withAddr = patients.filter(p => p.adresse && p.adresse.trim()).length;
  const missingGPS = patients.filter(p => (!p.lat || !p.lng) && p.adresse && p.adresse.trim()).length;

  result.innerHTML = `
    <div class="ai su">
      ✅ Import réussi depuis <strong>${source}</strong><br>
      📋 <strong>${patients.length}</strong> entrée(s) chargée(s)
      ${missingGPS > 0
        ? `<br><span style="font-size:12px;color:var(--w)">⚠️ ${missingGPS} adresse(s) sans coordonnées GPS</span>`
        : withAddr > 0
          ? `<br><span style="font-size:12px;color:var(--a)">📍 ${withAddr} adresse(s) détectée(s)</span>`
          : ''}
      <span style="font-size:11px;color:var(--m);margin-top:4px;display:block">Allez dans <strong>Planning</strong> ou <strong>Tournée IA</strong> pour utiliser ces données.</span>
    </div>
    ${missingGPS > 0 ? `
    <div style="margin-top:10px">
      <button class="btn bv bsm" id="btn-geocode-import" onclick="geocodeImportedPatients()">
        <span>📡</span> Résoudre ${missingGPS} adresse(s) GPS
      </button>
      <span style="font-size:11px;color:var(--m);margin-left:8px">Recommandé pour optimiser la tournée</span>
    </div>` : ''}`;
  result.classList.add('show');
}

/* ============================================================
   GÉOCODAGE POST-IMPORT
   Résout les adresses manquantes après un import ICS/CSV/texte.
   Utilise Nominatim (OpenStreetMap) — 1 req/s max.
   ============================================================ */
async function geocodeImportedPatients() {
  const btn = $('btn-geocode-import');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳</span> Géocodage…'; }

  const data     = APP.importedData;
  if (!data || !data.patients || !data.patients.length) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span>📡</span> Résoudre les adresses GPS'; }
    return;
  }

  const patients = [...data.patients];
  let geocoded = 0, failed = 0;

  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    // Sauter si déjà géocodé ou pas d'adresse
    if ((p.lat && p.lng) || !p.adresse || !p.adresse.trim()) continue;

    if (btn) btn.innerHTML = `<span>📡</span> ${i + 1}/${patients.length}…`;

    try {
      const q   = encodeURIComponent(p.adresse.trim());
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
        headers: { 'Accept-Language': 'fr', 'User-Agent': 'AMI-NGAP/6.1' },
      });
      const data = await res.json();
      if (data && data[0]) {
        patients[i] = { ...p, lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        geocoded++;
      } else {
        failed++;
      }
    } catch { failed++; }

    // Respecter rate-limit Nominatim : 1 req/s
    if (i < patients.length - 1) await new Promise(r => setTimeout(r, 1100));
  }

  storeImportedData({ ...APP.importedData, patients, total: patients.length });

  const msg = `✅ ${geocoded} GPS résolu(s)${failed > 0 ? ` · ⚠️ ${failed} non trouvé(s)` : ''}`;
  showToastSafe(msg);

  if (btn) {
    btn.disabled  = false;
    btn.innerHTML = `<span>✅</span> ${msg}`;
    btn.style.background = 'var(--a)';
  }
}

/* ============================================================
   MODE IA PLANNING
   ============================================================ */
function modeAI(mode) {
  if (mode === 'planning') {
    const txtEl = $('pl-txt');
    const texte = txtEl ? txtEl.value.trim() : '';

    // Masquer erreur précédente
    const perr = $('perr');
    if (perr) perr.style.display = 'none';

    if (!texte) {
      if (perr) { $('perr-m').textContent = 'Saisissez des informations patients avant de générer le planning (ex: "Patient A : injection 2x/jour").'; perr.style.display = 'flex'; }
      return;
    }

    // Parser le texte comme des patients
    const lines = texte.split('\n').filter(l => l.trim());
    const patients = lines.map((l, i) => ({
      id: 'manual_' + i,
      description: l.trim(),
      texte: l.trim(),
    }));

    // Stocker temporairement et générer
    if (!APP.importedData) {
      APP.importedData = { patients, total: patients.length, source: 'saisie manuelle' };
    } else {
      // Fusionner avec import existant
      APP.importedData.patients = [...(APP.importedData.patients || []), ...patients];
    }

    generatePlanningFromImport();
  }
}

/* ============================================================
   STOP JOURNÉE (terminer la tournée)
   ============================================================ */
function stopDay() {
  if (!confirm('Terminer la tournée du jour ?\n\nLe chronomètre sera arrêté et la journée sera clôturée.')) return;

  // Arrêter le timer
  if (LIVE_TIMER_ID) { clearInterval(LIVE_TIMER_ID); LIVE_TIMER_ID = null; }

  // Reset badge
  const badge = $('live-badge');
  if (badge) { badge.textContent = 'TERMINÉE'; badge.style.background = 'rgba(34,197,94,.15)'; badge.style.color = '#22c55e'; }

  $('live-patient-name').textContent = 'Tournée terminée ✅';
  $('live-info').textContent = '🏁 Bonne fin de journée ! CA total : ' + LIVE_CA_TOTAL.toFixed(2) + ' €';
  $('live-controls').style.display = 'none';

  // Afficher bouton démarrer, cacher bouton terminer
  const btnStart = $('btn-live-start');
  const btnStop  = $('btn-live-stop');
  if (btnStart) btnStart.style.display = 'inline-flex';
  if (btnStop)  btnStop.style.display  = 'none';

  // Résumé CA
  const caEl = $('live-ca-total');
  if (caEl) { caEl.textContent = '💶 CA journée clôturée : ' + LIVE_CA_TOTAL.toFixed(2) + ' €'; caEl.style.display = 'block'; }

  // Reset CA pour prochaine journée
  LIVE_CA_TOTAL = 0;

  if (typeof showToast === 'function') showToast('🏁 Tournée terminée — bonne journée !');
}

/* ============================================================
   RECOMMANDATIONS NGAP TEMPS RÉEL (live input)
   ============================================================ */
function analyzeLive(texte) {
  const t = texte.toLowerCase();
  const recos = [];

  if ((t.includes('domicile') || t.includes('chez')) && !t.includes('ifd'))
    recos.push({ type: 'gain', msg: 'Ajouter IFD — indemnité déplacement (+2,75 €)', gain: 2.75 });

  const kmMatch = t.match(/(\d+)\s*km/);
  if (kmMatch && !t.includes(' ik'))
    recos.push({ type: 'gain', msg: `Ajouter IK — ${kmMatch[1]} km (+${(parseInt(kmMatch[1])*0.35).toFixed(2)} €)`, gain: parseInt(kmMatch[1])*0.35 });

  if ((t.includes('22h') || t.includes('23h') || t.includes('0h') || t.includes('1h') || t.includes('2h') || t.includes('3h') || t.includes('4h') || t.includes('5h') || t.includes('6h') || t.includes('7h')) && !t.includes('nuit') && !t.includes('mn'))
    recos.push({ type: 'gain', msg: 'Majoration nuit possible (+9,15 €)', gain: 9.15 });

  if (t.includes('dimanche') && !t.includes('md'))
    recos.push({ type: 'gain', msg: 'Majoration dimanche possible (+9,15 €)', gain: 9.15 });

  if (t.includes('injection') && !t.includes('ami'))
    recos.push({ type: 'info', msg: 'Acte AMI1 probable (injection SC/IM — 3,15 €)', gain: 0 });

  if (t.includes('ald') && !t.includes('exo'))
    recos.push({ type: 'warn', msg: 'Patient ALD détecté — penser à cocher exonération', gain: 0 });

  return recos;
}

function renderLiveReco(texte) {
  const el = $('live-reco');
  if (!el) return;
  const recos = analyzeLive(texte);
  if (!recos.length) { el.innerHTML = ''; el.style.display = 'none'; return; }

  const totalGain = recos.reduce((s, r) => s + (r.gain||0), 0);
  el.style.display = 'block';
  el.innerHTML = `
    <div style="font-family:var(--fm);font-size:10px;color:var(--m);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px">💡 Suggestions NGAP</div>
    ${recos.map(r => `<div style="padding:5px 8px;border-radius:6px;margin:3px 0;font-size:12px;background:${r.type==='gain'?'rgba(34,197,94,.08)':r.type==='warn'?'rgba(255,180,0,.1)':'rgba(79,168,255,.08)'};border:1px solid ${r.type==='gain'?'rgba(34,197,94,.2)':r.type==='warn'?'rgba(255,180,0,.2)':'rgba(79,168,255,.2)'}">
      ${r.type==='gain'?'💰':r.type==='warn'?'⚠️':'💡'} ${r.msg}
    </div>`).join('')}
    ${totalGain > 0 ? `<div style="font-size:11px;color:var(--a);margin-top:6px;font-family:var(--fm)">💶 Gain potentiel : +${totalGain.toFixed(2)} €</div>` : ''}
  `;
}

/* ============================================================
   AUTO-COTATION LOCALE (réponse immédiate sans réseau)
   ============================================================ */
function autoCotationLocale(texte) {
  const t = texte.toLowerCase();
  const actes = []; let total = 0;

  if (t.includes('injection') || t.includes('insuline') || t.includes('piquer')) {
    actes.push({ code:'AMI1', nom:'Injection SC/IM', total:3.15 }); total += 3.15;
  }
  if (t.includes('pansement complexe') || t.includes('escarre') || t.includes('plaie')) {
    actes.push({ code:'AMI4', nom:'Pansement complexe', total:12.60 }); total += 12.60;
  } else if (t.includes('pansement')) {
    actes.push({ code:'AMI1', nom:'Pansement simple', total:3.15 }); total += 3.15;
  }
  if (t.includes('prélèvement') || t.includes('prise de sang')) {
    actes.push({ code:'AMI1', nom:'Prélèvement sanguin', total:3.15 }); total += 3.15;
  }
  if (t.includes('toilette')) {
    actes.push({ code:'BSC', nom:'Bilan soins infirmiers C', total:28.00 }); total += 28.00;
  }
  if (t.includes('domicile') || t.includes('chez')) {
    actes.push({ code:'IFD', nom:'Déplacement domicile', total:2.75 }); total += 2.75;
  }
  const kmM = t.match(/(\d+)\s*km/);
  if (kmM) {
    const ik = parseInt(kmM[1]) * 0.35;
    actes.push({ code:'IK', nom:`${kmM[1]} km`, total: Math.round(ik*100)/100 }); total += ik;
  }
  return { actes, total: Math.round(total*100)/100, source:'local' };
}

/* Patch startDay pour démarrer timer + optimisation live */
const _origStartDay=window.startDay||(()=>{});
window.startDay=async function(){
  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  if (!patients.length) {
    if(typeof showToast==='function') showToast('⚠️ Importez des patients avant de démarrer la journée.');
    return;
  }
  // Reset état des patients pour une nouvelle journée
  patients.forEach(p => { p._done=false; p._absent=false; });

  startLiveTimer();
  const el=$('live-badge');
  if(el){el.textContent='EN COURS';el.style.background='var(--ad)';el.style.color='var(--a)';}
  const btnStart=$('btn-live-start');
  if(btnStart) btnStart.style.display='none';
  // Afficher bouton "Terminer la tournée"
  const btnStop = $('btn-live-stop');
  if (btnStop) btnStop.style.display = 'inline-flex';
  $('live-controls').style.display='block';

  // Initialiser le premier patient actif
  const firstP = patients[0];
  if(firstP){
    LIVE_PATIENT_ID = firstP.patient_id || firstP.id || null;
    $('live-patient-name').textContent = firstP.description||firstP.texte||'Premier patient';
    $('live-info').textContent = `Soin 1/${patients.length}${firstP.heure_soin?' · '+firstP.heure_soin:''}`;
  }

  /* ── Démarrer le moteur IA temps réel ── */
  if(typeof startLiveOptimization==='function') startLiveOptimization();

  // Afficher la liste des patients
  renderLivePatientList();

  // Tenter appel API, mais ne pas bloquer si indisponible
  liveStatusCore().catch(()=>{});
};

/* liveStatusCore = contenu de liveStatus original */
async function liveStatusCore(){
  try{
    const d=await apiCall('/webhook/ami-live',{action:'get_status'});
    if(!d.ok)return;
    if(d.prochain){
      let actes=[];try{actes=JSON.parse(d.prochain.actes||'[]');}catch{}
      const desc=actes[0]?.nom||'Soin';
      LIVE_PATIENT_ID=d.prochain.patient_id;
      $('live-patient-name').textContent=desc;
      $('live-info').textContent=`Prochain patient · ${d.prochain.heure_soin||'horaire non défini'}`;
      $('live-next').innerHTML=`<div class="card"><div class="ct">📋 Patients restants</div><div class="ai in">📍 ${d.patients_restants} patient(s) restant(s) aujourd'hui</div></div>`;
      detectDelay(d.prochain);
    }else{
      $('live-patient-name').textContent='Tournée terminée ✅';
      $('live-info').textContent='Tous les patients ont été vus';
      $('live-next').innerHTML='<div class="card"><div class="ai su">✅ Journée terminée ! Tous les patients ont été pris en charge.</div></div>';
    }
    if(LIVE_START_TIME){
      $('live-ca-total').textContent=`💶 CA du jour : ${LIVE_CA_TOTAL.toFixed(2)} €`;
      $('live-ca-total').style.display='block';
    }
  }catch(e){console.error(e);}
}

/* Patch liveAction pour auto-facturation + modale cotation */
const _origLiveActionFn=window.liveAction;
window.liveAction=async function(action){
  const patients=APP.importedData?.patients||APP.importedData?.entries||[];

  if(action==='patient_done'){
    /* ── Trouver le patient actif ── */
    let activeP = null;
    if(LIVE_PATIENT_ID){
      activeP = patients.find(x=>x.patient_id===LIVE_PATIENT_ID||(String(x.id)===String(LIVE_PATIENT_ID)));
    }
    if(!activeP){
      // Prendre le premier patient non-traité
      activeP = patients.find(x => !x._done && !x._absent);
    }
    if(activeP){
      // Marquer comme fait
      activeP._done = true;
      // Auto-facturation CA
      const cot = await autoFacturation(activeP);
      // Cotation locale en fallback si API indisponible
      const cotLocal = autoCotationLocale(activeP.description||activeP.texte||'');
      const cotAffichee = (cot && cot.actes?.length) ? cot : cotLocal;
      // Afficher la modale de cotation
      showCotationModal(activeP, cotAffichee);
      // Avancer au patient suivant
      const nextP = patients.find(x => !x._done && !x._absent);
      if(nextP){
        LIVE_PATIENT_ID = nextP.patient_id || nextP.id || null;
        $('live-patient-name').textContent = nextP.description||nextP.texte||'Prochain patient';
        $('live-info').textContent = `Prochain soin${nextP.heure_soin?' à '+nextP.heure_soin:''}`;
      }else{
        $('live-patient-name').textContent = 'Tournée terminée ✅';
        $('live-info').textContent = 'Tous les patients ont été pris en charge';
      }
      renderLivePatientList();
    }else{
      if(typeof showToast==='function') showToast('ℹ️ Aucun patient actif.');
    }
    return;
  }

  if(action==='patient_absent'){
    let activeP = patients.find(x=>x.patient_id===LIVE_PATIENT_ID||(String(x.id)===String(LIVE_PATIENT_ID)));
    if(!activeP) activeP = patients.find(x => !x._done && !x._absent);
    if(activeP){
      activeP._absent = true;
      const nextP = patients.find(x => !x._done && !x._absent);
      if(nextP){
        LIVE_PATIENT_ID = nextP.patient_id || nextP.id || null;
        $('live-patient-name').textContent = nextP.description||nextP.texte||'Prochain patient';
        $('live-info').textContent = `Prochain soin${nextP.heure_soin?' à '+nextP.heure_soin:''}`;
      }
      renderLivePatientList();
      if(typeof showToast==='function') showToast('❌ Patient absent noté.');
    }
    return;
  }

  // Appel API pour autres actions (get_status, recalcul…)
  try{
    const d=await apiCall('/webhook/ami-live',{action,patient_id:LIVE_PATIENT_ID||''});
    if(d.suggestion)showToast?showToast('💡 '+d.suggestion):alert('💡 '+d.suggestion);
    await liveStatusCore();
  }catch(e){
    // Pas d'alert bloquant si API indisponible — afficher le statut local
    renderLivePatientList();
  }
};

/* ============================================================
   LISTE PATIENTS PILOTAGE — Affichage local avec état
   ============================================================ */
function renderLivePatientList() {
  const isAdmin = (typeof S !== 'undefined') && S?.role === 'admin';
  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  const el = $('live-next');
  if (!el) return;

  if (!patients.length) {
    el.innerHTML = `<div class="card">
      <div class="ai wa">⚠️ Aucun patient importé. Allez dans <strong>Import calendrier</strong> ou <strong>Tournée IA</strong> pour importer des patients.</div>
      <button class="btn bp bsm" style="margin-top:10px" onclick="navTo('imp',null)"><span>📂</span> Importer des patients</button>
    </div>`;
    return;
  }

  const done   = patients.filter(p => p._done).length;
  const absent = patients.filter(p => p._absent).length;
  const reste  = patients.length - done - absent;

  el.innerHTML = `<div class="card">
    <div class="ct" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <span>📋 Patients de la journée (${patients.length})</span>
      <button class="btn bs bsm" onclick="removeAllImportedPatients()" style="font-size:11px;padding:4px 10px">🗑️ Tout supprimer</button>
    </div>
    <div style="display:flex;gap:8px;margin:10px 0 14px;flex-wrap:wrap">
      <span class="dreb" style="background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.3);color:#22c55e">✅ ${done} fait(s)</span>
      <span class="dreb" style="background:rgba(255,95,109,.08);border-color:rgba(255,95,109,.2);color:var(--d)">❌ ${absent} absent(s)</span>
      <span class="dreb">⏳ ${reste} restant(s)</span>
    </div>
    ${patients.map((p, i) => {
      const desc = isAdmin ? `Patient #${i+1} <span style="font-size:10px;background:rgba(255,181,71,.1);color:var(--w);border:1px solid rgba(255,181,71,.2);padding:1px 7px;border-radius:20px;margin-left:6px">Admin — données masquées</span>` : (p.description || p.texte || `Patient ${i+1}`);
      const statusIcon = p._done ? '✅' : p._absent ? '❌' : '⏳';
      const statusColor = p._done ? 'rgba(34,197,94,.08)' : p._absent ? 'rgba(255,95,109,.05)' : 'var(--s)';
      const heure = p.heure_soin || p.heure_preferee || p.heure || '';
      return `<div class="route-item" style="background:${statusColor};border:1px solid var(--b);border-radius:10px;margin-bottom:6px;padding:10px 12px;align-items:center">
        <div class="route-num" style="font-size:16px">${statusIcon}</div>
        <div class="route-info" style="flex:1;min-width:0">
          <strong style="font-size:13px">${desc}</strong>
          ${heure ? `<div style="font-size:11px;color:var(--m);margin-top:2px">🕐 ${heure}</div>` : ''}
        </div>
        <button class="btn bs bsm" onclick="removeImportedPatient(${i})" style="font-size:11px;padding:3px 8px;flex-shrink:0;color:var(--d);border-color:rgba(255,95,109,.2);background:rgba(255,95,109,.05)" title="Supprimer ce patient">✕</button>
      </div>`;
    }).join('')}
  </div>`;
}

function removeImportedPatient(index) {
  if (!APP.importedData?.patients) return;
  const p = APP.importedData.patients[index];
  const desc = (p?.description || p?.texte || `Patient ${index+1}`).slice(0, 30);
  if (!confirm(`Supprimer "${desc}" de la tournée ?`)) return;
  APP.importedData.patients.splice(index, 1);
  APP.importedData.total = APP.importedData.patients.length;
  storeImportedData(APP.importedData);
  renderLivePatientList();
  if (typeof showToast === 'function') showToast(`🗑️ Patient supprimé de la tournée.`);
}

function removeAllImportedPatients() {
  const n = APP.importedData?.patients?.length || 0;
  if (!n) return;
  if (!confirm(`Supprimer tous les ${n} patients de la tournée ?`)) return;
  APP.importedData = null;
  const banner = $('pla-import-banner');
  if (banner) banner.style.display = 'none';
  const caWrap = $('tur-ca-wrap');
  if (caWrap) caWrap.style.display = 'none';
  renderLivePatientList();
  if (typeof showToast === 'function') showToast(`🗑️ Tous les patients supprimés.`);
}

/* ============================================================
   MODALE COTATION — Affichage après "Patient terminé"
   ============================================================ */
function showCotationModal(patient, cotation) {
  // Supprimer modale précédente
  const existing = document.getElementById('cot-modal-live');
  if (existing) existing.remove();

  const isAdmin = (typeof S !== 'undefined') && S?.role === 'admin';
  if (isAdmin) return; // Les admins ne voient pas les données patients

  const actes = cotation?.actes || [];
  const total = cotation?.total || 0;

  const modal = document.createElement('div');
  modal.id = 'cot-modal-live';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.75);display:flex;align-items:flex-end;justify-content:center;padding:16px;box-sizing:border-box';

  modal.innerHTML = `
    <div style="background:var(--bg,#0b0f14);border:1px solid rgba(0,212,170,.25);border-radius:20px 20px 16px 16px;padding:24px;width:100%;max-width:520px;max-height:80vh;overflow-y:auto;box-shadow:0 -8px 40px rgba(0,0,0,.5)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="font-family:var(--fs);font-size:18px;color:var(--t)">⚡ Cotation automatique</div>
        <button onclick="document.getElementById('cot-modal-live').remove()" style="background:none;border:none;color:var(--m);font-size:22px;cursor:pointer;line-height:1">✕</button>
      </div>
      <div style="font-size:13px;color:var(--m);margin-bottom:14px;padding:8px 12px;background:var(--s);border-radius:8px;font-family:var(--fm)">
        📋 ${(patient.description || patient.texte || 'Soin infirmier').slice(0, 80)}
      </div>

      ${actes.length ? `
      <div style="margin-bottom:14px">
        <div style="font-family:var(--fm);font-size:10px;color:var(--m);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px">Actes détectés</div>
        ${actes.map(a => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.15);border-radius:8px;margin-bottom:6px">
            <div>
              <span style="font-family:var(--fm);font-size:12px;background:var(--ad);color:var(--a);padding:2px 8px;border-radius:20px;margin-right:8px">${a.code}</span>
              <span style="font-size:13px;color:var(--t)">${a.nom}</span>
            </div>
            <span style="font-family:var(--fm);font-size:13px;color:var(--a);font-weight:700">${(a.total||0).toFixed(2)} €</span>
          </div>
        `).join('')}
      </div>
      ` : `<div class="ai wa" style="margin-bottom:14px">Aucun acte détecté automatiquement. Vous pouvez coter manuellement.</div>`}

      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:rgba(0,212,170,.08);border:1px solid rgba(0,212,170,.25);border-radius:10px;margin-bottom:16px">
        <span style="font-size:14px;color:var(--t);font-weight:600">Total estimé</span>
        <span style="font-family:var(--fs);font-size:22px;color:var(--a)">${total.toFixed(2)} €</span>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn bp" style="flex:1" onclick="_validateCotationLive(${JSON.stringify(patient).replace(/'/g,"&apos;")})">
          ✅ Valider
        </button>
        <button class="btn bv" style="flex:1" onclick="document.getElementById('cot-modal-live').remove();navTo('cot',null)">
          ✏️ Modifier dans la cotation
        </button>
        <button class="btn bs" style="flex:none" onclick="document.getElementById('cot-modal-live').remove()">
          Ignorer
        </button>
      </div>
      <p style="font-size:11px;color:var(--m);margin-top:10px;font-family:var(--fm);text-align:center">
        💡 Source locale · Basé sur la description du soin · Vérifiez avant facturation officielle
      </p>
    </div>
  `;

  document.body.appendChild(modal);
  // Fermer en cliquant hors de la modale
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function _validateCotationLive(patient) {
  const modal = document.getElementById('cot-modal-live');
  if (modal) modal.remove();
  if (typeof showToast === 'function') showToast('✅ Cotation validée — ajoutée au CA de la journée.');
}

/* Patch liveStatus global */
window.liveStatus = function() {
  renderLivePatientList();
  liveStatusCore();
};
