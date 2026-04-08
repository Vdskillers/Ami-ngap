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

  try {
    const startPoint = { lat: startLat, lng: startLng };

    /* ── 1. Moteur IA local — VRPTW greedy + cache OSRM ── */
    _showOptimProgress('⚡ Optimisation VRPTW en cours…');
    let route = await optimizeTour(rawPatients, startPoint);

    /* ── 2. 2-opt — amélioration du chemin ────────────── */
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
    $('tbody').innerHTML = _renderRouteHTML(route, osrm, ca, rentab);
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
function _renderRouteHTML(route, osrm, ca, rentab) {
  const total = route.filter(p=>p.lat&&p.lng).length;
  return `<div class="card">
    <div class="ct">🧠 Tournée IA optimisée — ${total} patients</div>
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <div class="dreb">📍 ${total} patients</div>
      ${osrm?`<div class="dreb">🚗 ${osrm.total_km} km</div><div class="dreb">⏱ ~${osrm.total_min} min</div>`:''}
      <div class="ca-pill">💶 CA estimé : ${parseFloat(ca).toFixed(2)} €</div>
      ${rentab?`<div class="ca-pill" style="background:rgba(79,168,255,.1);border-color:rgba(79,168,255,.3);color:var(--a2)">📊 ${rentab.euro_heure}€/h</div>`:''}
    </div>
    ${route.map((p,i)=>{
      const sd  = encodeURIComponent(p.description||'');
      const leg = osrm?.legs?.[i];
      const hasTime = p.start_str && p.start_str !== '—';
      return `<div class="route-item ${p.urgent?'route-urgent':''}">
        <div class="route-num">${i+1}</div>
        <div class="route-info">
          <strong style="font-size:13px">${p.description||'Patient'}</strong>
          <div style="font-size:11px;color:var(--m);margin-top:2px">
            ${hasTime?`🕐 Arrivée ~${p.arrival_str} · Soin ${p.start_str}`:''}
            ${p.urgent?'<span style="color:#ff5f6d;font-weight:700;margin-left:6px">🚨 URGENT</span>':''}
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

  let parsed = null;
  let patientsFound = 0;

  // Tentative JSON
  try {
    parsed = JSON.parse(content);
    const patients = parsed.patients || parsed.entries || (Array.isArray(parsed) ? parsed : null);
    if (patients) {
      patientsFound = patients.length;
      storeImportedData({ patients, total: patientsFound, source });
    }
  } catch { /* pas JSON */ }

  // Tentative ICS / texte
  if (!parsed) {
    const lines = content.split('\n').filter(l => l.trim().length > 3);
    patientsFound = lines.length;
    const patients = lines.map((l, i) => ({
      id: 'imp_' + i,
      description: l.trim().replace(/^[-*•→]+\s*/, ''),
      texte: l.trim(),
      heure_soin: (l.match(/(\d{1,2})[hH:](\d{2})/) || [])[0] || '',
    }));
    storeImportedData({ patients, total: patientsFound, source });
  }

  result.innerHTML = `
    <div class="ai su">
      ✅ Import réussi depuis <strong>${source}</strong><br>
      📋 <strong>${patientsFound}</strong> entrée(s) chargée(s)<br>
      <span style="font-size:11px;color:var(--m);margin-top:4px;display:block">Allez dans <strong>Planning</strong> ou <strong>Tournée IA</strong> pour utiliser ces données.</span>
    </div>`;
  result.classList.add('show');
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
  startLiveTimer();
  const el=$('live-badge');
  if(el){el.textContent='EN COURS';el.style.background='var(--ad)';el.style.color='var(--a)';}
  $('btn-live-start').style.display='none';
  // Afficher bouton "Terminer la tournée"
  const btnStop = $('btn-live-stop');
  if (btnStop) btnStop.style.display = 'inline-flex';
  $('live-controls').style.display='block';
  /* ── Démarrer le moteur IA temps réel ── */
  if(typeof startLiveOptimization==='function') startLiveOptimization();
  await liveStatusCore();
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

/* Patch liveAction pour auto-facturation */
const _origLiveActionFn=window.liveAction;
window.liveAction=async function(action){
  if(action==='patient_done'&&LIVE_PATIENT_ID){
    const patients=APP.importedData?.patients||APP.importedData?.entries||[];
    const p=patients.find(x=>x.patient_id===LIVE_PATIENT_ID||(String(x.id)===String(LIVE_PATIENT_ID)));
    if(p)await autoFacturation(p);
  }
  // appel original
  if(!LIVE_PATIENT_ID&&action!=='get_status'){alert('Aucun patient actif.');return;}
  try{
    const d=await apiCall('/webhook/ami-live',{action,patient_id:LIVE_PATIENT_ID||''});
    if(d.suggestion)alert('💡 '+d.suggestion);
    await liveStatusCore();
  }catch(e){alert('Erreur : '+e.message);}
};

/* Patch liveStatus global */
window.liveStatus=liveStatusCore;
