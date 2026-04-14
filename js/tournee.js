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
    // Supprimer les anciens listeners pour éviter les doublons
    radio.removeEventListener('change', _onOptimModeChange);
    radio.addEventListener('change', _onOptimModeChange);
  });
  // Appliquer l'état visuel immédiatement au chargement
  _applyOptimModeStyle();
}

function _onOptimModeChange() {
  _applyOptimModeStyle();
}

function _applyOptimModeStyle() {
  const labels = { ia: 'live-mode-ia-lbl', heure: 'live-mode-heure-lbl', mixte: 'live-mode-mixte-lbl' };
  // Trouver le radio coché parmi tous les radios
  const checked = document.querySelector('input[name="live-optim-mode"]:checked');
  const checkedVal = checked ? checked.value : 'ia';
  Object.entries(labels).forEach(([val, lblId]) => {
    const lbl = $(lblId);
    if (!lbl) return;
    if (val === checkedVal) {
      lbl.style.border = '2px solid var(--a)';
      lbl.style.background = 'rgba(0,212,170,.06)';
    } else {
      lbl.style.border = '1px solid var(--b)';
      lbl.style.background = 'var(--s)';
    }
  });
}

/* Écouter les deux events de navigation */
const _onNavLive = e => {
  if (e.detail?.view === 'live') setTimeout(_bindOptimModeUI, 100);
};
document.addEventListener('app:nav',     _onNavLive);
document.addEventListener('ui:navigate', _onNavLive);

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
  $('tbody').innerHTML=`<div class="card">
    <div class="ct">👥 Patients importés (${patients.length})</div>
    ${patients.map((p,i)=>`<div class="route-item"><div class="route-num">${i+1}</div><div class="route-info">
      <strong>${p.description||p.texte||p.summary||'Patient '+(i+1)}</strong>
      <div style="font-size:11px;color:var(--m);margin-top:2px">${p.heure_soin||p.heure||''} ${p.patient_id?'· ID:'+p.patient_id:''}</div>
    </div></div>`).join('')}
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
  // Source de données : APP.importedData en priorité (données réelles),
  // sinon d.planning retourné par l'API (peut être vide ou mal structuré)
  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  const ca = patients.length ? estimateRevenue(patients) : null;

  // Jours de la semaine français
  const JOURS = ['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'];
  const JOUR_IDX = { lundi:1, mardi:2, mercredi:3, jeudi:4, vendredi:5, samedi:6, dimanche:0 };

  // Grouper les patients par jour
  // Chaque patient peut avoir : date (ISO), heure_soin, description, texte, nom, prenom
  const byDay = {};
  JOURS.forEach(j => { byDay[j] = []; });

  patients.forEach((p, idx) => {
    // Extraire le jour depuis la date ISO, ou depuis le champ "jour" si présent
    let jourKey = null;
    const dateStr = p.date || p.date_soin || p.date_prevue || '';
    if (dateStr) {
      try {
        const d2 = new Date(dateStr);
        if (!isNaN(d2)) {
          const nomJour = d2.toLocaleDateString('fr-FR', { weekday: 'long' }).toLowerCase();
          jourKey = JOURS.find(j => nomJour.startsWith(j)) || null;
        }
      } catch {}
    }
    // Fallback : chercher un nom de jour dans la description
    if (!jourKey) {
      const desc = (p.description || p.texte || '').toLowerCase();
      jourKey = JOURS.find(j => desc.includes(j)) || null;
    }
    // Fallback final : distribuer dans l'ordre
    if (!jourKey) {
      jourKey = JOURS[idx % JOURS.length];
    }
    byDay[jourKey].push({ ...p, _planIdx: idx });
  });

  // Rendu d'une carte patient dans le planning
  function renderPatientCard(p) {
    const nom = [p.prenom, p.nom].filter(Boolean).join(' ')
      || p.patient_nom || p.patient_name
      || (p.description || p.texte || 'Patient').split(' ').slice(0,3).join(' ');

    // Date formatée
    const dateStr = p.date || p.date_soin || p.date_prevue || '';
    let dateAff = '';
    if (dateStr) {
      try {
        const d2 = new Date(dateStr);
        if (!isNaN(d2)) dateAff = d2.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
      } catch {}
    }

    // Heure
    const heure = p.heure_soin || p.heure_preferee || p.heure || '';

    // Description courte du soin
    const soin = (p.description || p.texte || '').slice(0, 60);

    // Cotation déjà validée ?
    const cot = p._cotation?.validated;

    return `
    <div style="background:var(--c);border:1px solid var(--b);border-radius:10px;padding:10px 12px;margin-bottom:8px;position:relative">

      <!-- En-tête : nom + badges date/heure -->
      <div style="display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap;margin-bottom:4px">
        <div style="font-size:13px;font-weight:600;color:var(--t);flex:1;min-width:0;word-break:break-word">${nom}</div>
        ${dateAff
          ? `<span style="font-size:10px;font-family:var(--fm);background:rgba(79,168,255,.1);color:var(--a2);border:1px solid rgba(79,168,255,.2);padding:1px 7px;border-radius:20px;flex-shrink:0">${dateAff}</span>`
          : ''}
        ${heure
          ? `<span style="font-size:10px;font-family:var(--fm);background:rgba(255,181,71,.08);color:var(--w);border:1px solid rgba(255,181,71,.2);padding:1px 7px;border-radius:20px;flex-shrink:0">⏰ ${heure}</span>`
          : ''}
      </div>

      <!-- Description du soin -->
      ${soin ? `<div style="font-size:11px;color:var(--m);margin-bottom:6px;line-height:1.4">${soin}</div>` : ''}

      <!-- Cotation validée -->
      ${cot
        ? `<div style="font-size:10px;color:var(--a);font-family:var(--fm);margin-bottom:6px">✅ Cotation : ${p._cotation.total?.toFixed(2)} €</div>`
        : ''}

      <!-- Actions -->
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
        <button onclick="openCotationPatient(${p._planIdx})"
          style="font-size:10px;font-family:var(--fm);padding:3px 9px;border-radius:20px;border:1px solid rgba(0,212,170,.3);background:rgba(0,212,170,.06);color:var(--a);cursor:pointer">
          ${cot ? '✏️ Modifier' : '⚡ Coter'}
        </button>
        ${cot ? `
        <button onclick="_planningDeleteCotation(${p._planIdx})"
          style="font-size:10px;font-family:var(--fm);padding:3px 9px;border-radius:20px;border:1px solid rgba(255,95,109,.3);background:rgba(255,95,109,.05);color:var(--d);cursor:pointer">
          🗑️ Supprimer cotation
        </button>` : ''}
        <button onclick="_planningRemovePatient(${p._planIdx})"
          style="font-size:10px;font-family:var(--fm);padding:3px 9px;border-radius:20px;border:1px solid var(--b);background:none;color:var(--m);cursor:pointer">
          ✕ Retirer
        </button>
      </div>
    </div>`;
  }

  // Total cotations validées
  const totalCot = patients.reduce((s, p) => s + (p._cotation?.validated ? (p._cotation.total||0) : 0), 0);
  const nbCot = patients.filter(p => p._cotation?.validated).length;

  $('pbody').innerHTML = `
    <div class="card">
      <!-- En-tête planning -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">
        <div>
          <div class="ct" style="margin-bottom:4px">📅 Planning hebdomadaire</div>
          <div style="font-size:12px;color:var(--m);font-family:var(--fm)">${patients.length} patient(s) · ${nbCot} cotation(s) validée(s)</div>
        </div>
        <button onclick="_planningResetAll()" style="font-family:var(--fm);font-size:11px;padding:6px 14px;border-radius:20px;border:1px solid rgba(255,95,109,.35);background:rgba(255,95,109,.06);color:var(--d);cursor:pointer;white-space:nowrap">
          🗑️ Effacer tout le planning
        </button>
      </div>

      <!-- KPI bande -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        ${ca ? `<div style="background:rgba(0,212,170,.08);border:1px solid rgba(0,212,170,.2);border-radius:10px;padding:8px 14px;font-size:12px"><div style="color:var(--m);font-family:var(--fm);font-size:10px;margin-bottom:2px">CA ESTIMÉ</div><div style="color:var(--a);font-weight:700">${ca.toFixed(2)} €</div></div>` : ''}
        ${nbCot > 0 ? `<div style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:10px;padding:8px 14px;font-size:12px"><div style="color:var(--m);font-family:var(--fm);font-size:10px;margin-bottom:2px">COTATIONS VALIDÉES</div><div style="color:#22c55e;font-weight:700">${totalCot.toFixed(2)} €</div></div>` : ''}
      </div>

      <!-- Grille des jours -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
        ${JOURS.map(j => `
          <div style="background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:12px">
            <div style="font-weight:600;text-transform:capitalize;margin-bottom:10px;font-size:13px;display:flex;align-items:center;justify-content:space-between">
              ${j}
              ${byDay[j].length ? `<span style="font-size:10px;font-family:var(--fm);background:rgba(0,212,170,.1);color:var(--a);padding:1px 8px;border-radius:20px">${byDay[j].length}</span>` : ''}
            </div>
            ${byDay[j].length
              ? byDay[j].map(p => renderPatientCard(p)).join('')
              : '<div style="font-size:12px;color:var(--m);text-align:center;padding:12px 0">—</div>'}
          </div>
        `).join('')}
      </div>
    </div>`;
}

/* Supprimer la cotation d'un patient du planning sans le retirer */
function _planningDeleteCotation(idx) {
  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  const p = patients[idx];
  if (!p) return;
  if (!confirm(`Supprimer la cotation de ${[p.prenom, p.nom].filter(Boolean).join(' ') || 'ce patient'} ?`)) return;
  delete p._cotation;
  // Ré-afficher le planning
  renderPlanning({});
  if (typeof showToast === 'function') showToast('🗑️ Cotation supprimée.');
}

/* Retirer un patient du planning */
function _planningRemovePatient(idx) {
  if (!APP.importedData) return;
  const arr = APP.importedData.patients || APP.importedData.entries || [];
  const p = arr[idx];
  const nom = [p?.prenom, p?.nom].filter(Boolean).join(' ') || p?.description?.split(' ').slice(0,3).join(' ') || 'ce patient';
  if (!confirm(`Retirer ${nom} du planning ?`)) return;
  const key = APP.importedData.patients ? 'patients' : 'entries';
  APP.importedData[key] = arr.filter((_, i) => i !== idx);
  APP.importedData.total = APP.importedData[key].length;
  renderPlanning({});
  if (typeof showToast === 'function') showToast('✅ Patient retiré du planning.');
}

/* Effacer tout le planning hebdomadaire */
function _planningResetAll() {
  const n = (APP.importedData?.patients || APP.importedData?.entries || []).length;
  if (!confirm(`Effacer tout le planning ?\n\n${n} patient(s) seront supprimés du planning.\nCette action ne supprime PAS les fiches du carnet patient.`)) return;
  APP.importedData = null;
  $('pbody').innerHTML = '<div class="ai in" style="margin-top:12px">Planning effacé. Importez de nouvelles données depuis "Import calendrier".</div>';
  const banner = $('pla-import-banner');
  if (banner) banner.style.display = 'none';
  if (typeof showToast === 'function') showToast('🗑️ Planning effacé.');
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
    /* Heure de départ = heure actuelle en minutes depuis minuit (pas 8h00 fixe) */
    const _now = new Date();
    const startTimeMin = _now.getHours() * 60 + _now.getMinutes();
    let route = await optimizeTour(rawPatients, startPoint, startTimeMin, optimMode);

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
      <button class="btn bs bsm" style="margin-left:auto;color:var(--d);border-color:rgba(255,95,109,.3);font-size:11px" onclick="clearTournee()">🗑️ Vider</button>
    </div>
    ${route.map((p,i)=>{
      const sd  = encodeURIComponent(p.acte || p.texte || p.description || '');
      const spn = encodeURIComponent(((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.patient || '');
      const nomAff = ((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.description || p.label || 'Patient ' + (i+1);
      const pId = encodeURIComponent(p.id || p.patient_id || String(i));
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
          <strong style="font-size:13px">${nomAff}</strong>
          <div style="font-size:11px;color:var(--m);margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${hasTime?`🕐 Arrivée ~${p.arrival_str} · Soin ${p.start_str}`:''}
            ${p.urgent?'<span style="color:#ff5f6d;font-weight:700">🚨 URGENT</span>':''}
            ${contrainteBadge}
          </div>
        </div>
        ${leg?`<div class="route-km">+${leg.km}km·${leg.min}min</div>`:(p.travel_min?`<div class="route-km">~${p.travel_min}min</div>`:'')}
        ${(p.lat && p.lng) || p.adresse || p.addressFull ? `<button class="btn bv bsm" onclick="openNavigation(${JSON.stringify({lat:p.lat||null,lng:p.lng||null,address:p.adresse||p.addressFull||p.address||'',addressFull:p.addressFull||p.adresse||'',adresse:p.adresse||p.addressFull||'',geoScore:p.geoScore||0}).replace(/"/g,'&quot;')})" title="Naviguer vers ce patient">🗺️</button>` : ''}
        <button class="btn bp bsm" onclick="coterDepuisRoute(decodeURIComponent('${sd}'),decodeURIComponent('${spn}'))">⚡ Coter</button>
        <button class="btn bs bsm" style="padding:6px 8px;color:var(--d)" onclick="removeFromTournee('${pId}',${i})" title="Retirer de la tournée">✕</button>
      </div>`;
    }).join('')}
  </div>`;
}

/* Retirer un patient de la tournée optimisée */
function removeFromTournee(encodedId, fallbackIndex) {
  const id = decodeURIComponent(encodedId);
  const data = APP.get('importedData') || APP.importedData;
  if (!data) return;
  const patients = data.patients || data.entries || [];
  const idx = patients.findIndex((p, i2) =>
    String(p.id || p.patient_id) === String(id) || i2 === Number(fallbackIndex)
  );
  if (idx === -1) return;
  patients.splice(idx, 1);
  data.total = patients.length;
  if (typeof storeImportedData === 'function') storeImportedData(data);
  else APP.importedData = data;
  if (typeof showToast === 'function') showToast('Patient retiré de la tournée');
  optimiserTournee();
}

/* Vider entièrement la tournée */
function clearTournee() {
  if (!confirm('Vider la tournée ? Tous les patients importés seront retirés.')) return;
  APP.importedData = null;
  APP.uberPatients = [];
  if (typeof storeImportedData === 'function') storeImportedData(null);
  const tbody = $('tbody');
  if (tbody) tbody.innerHTML = '';
  const resTur = $('res-tur');
  if (resTur) resTur.classList.remove('show');
  if (typeof showToast === 'function') showToast('🗑️ Tournée vidée');
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
  // Génère la cotation automatique — ne met plus à jour le CA directement
  // (c'est la modale de vérification qui l'incrémente après validation)
  if(!patient?.description)return;
  try{
    const u=S?.user||{};
    const d=await apiCall('/webhook/ami-calcul',{
      mode:'ngap',texte:patient.description,
      infirmiere:((u.prenom||'')+' '+(u.nom||'')).trim(),
      adeli:u.adeli||'',rpps:u.rpps||'',structure:u.structure||'',
      date_soin:new Date().toISOString().split('T')[0],
      heure_soin:patient.heure_soin||patient.heure_preferee||new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}),
      _live_auto:true
    });
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
  const _isAdminSD = false; // unused, kept for reference
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

      /* Chercher l'heure dans les données locales si l'API ne la retourne pas
         (cas migration SQL incomplète — colonne heure_soin absente en base) */
      const patients = APP.importedData?.patients || APP.importedData?.entries || [];
      const localP = patients.find(p => p.patient_id === d.prochain.patient_id || p.id === d.prochain.patient_id);
      const heure = d.prochain.heure_soin || localP?.heure_soin || localP?.heure_preferee || localP?.heure || '';
      const nomPatient = ((localP?.nom||'') + ' ' + (localP?.prenom||'')).trim() || localP?.description || desc;

      $('live-patient-name').textContent = nomPatient;
      $('live-info').textContent = heure ? `Prochain patient · ⏰ ${heure}` : 'Prochain patient';
      $('live-next').innerHTML=`<div class="card"><div class="ct">📋 Patients restants</div><div class="ai in">📍 ${d.patients_restants} patient(s) restant(s) aujourd'hui</div></div>`;
      detectDelay({...d.prochain, heure_soin: heure});
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
      const desc = ((p.nom||'') + ' ' + (p.prenom||'')).trim() || p.description || p.texte || `Patient ${i+1}`;
      const statusIcon = p._done ? '✅' : p._absent ? '❌' : '⏳';
      const statusColor = p._done ? 'rgba(34,197,94,.08)' : p._absent ? 'rgba(255,95,109,.05)' : 'var(--s)';
      const heure = p.heure_soin || p.heure_preferee || p.heure || '';
      return `<div class="route-item" style="background:${statusColor};border:1px solid var(--b);border-radius:10px;margin-bottom:6px;padding:10px 12px;align-items:center">
        <div class="route-num" style="font-size:16px">${statusIcon}</div>
        <div class="route-info" style="flex:1;min-width:0">
          <strong style="font-size:13px">${desc}</strong>
          ${heure ? `<div style="font-size:11px;color:var(--m);margin-top:2px">🕐 ${heure}</div>` : ''}
          ${p._cotation?.validated ? `<div style="font-size:10px;color:var(--a);margin-top:2px;font-family:var(--fm)">✅ ${p._cotation.total?.toFixed(2)} € validés</div>` : ''}
        </div>
        ${(p.lat && p.lng) || p.adresse || p.addressFull ? `<button class="btn bv bsm" onclick="openNavigation(${JSON.stringify({lat:p.lat,lng:p.lng,address:p.adresse||p.addressFull||p.address||'',addressFull:p.addressFull||p.adresse||'',adresse:p.adresse||p.addressFull||'',geoScore:p.geoScore||0}).replace(/"/g,'&quot;')})" style="font-size:11px;padding:4px 8px;flex-shrink:0" title="Naviguer vers ce patient">🗺️</button>` : ''}
        <button class="btn bp bsm" onclick="openCotationPatient(${i})" style="font-size:11px;padding:4px 8px;flex-shrink:0" title="Voir / modifier la cotation">📋</button>
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
   MODALE COTATION — Vérification / modification après soin
   ============================================================
   Appelée :
   - automatiquement quand patient marqué "terminé"
   - manuellement via bouton "📋 Cotation" dans la liste
   Permet de voir, modifier et valider chaque acte.
============================================================ */

/* Stockage temporaire des actes en cours d'édition dans la modale */
let _cotModalState = { actes: [], patient: null, onValidate: null };

function showCotationModal(patient, cotation, onValidate) {
  const existing = document.getElementById('cot-modal-live');
  if (existing) existing.remove();

  _cotModalState = {
    actes: (cotation?.actes || []).map((a, i) => ({ ...a, _idx: i })),
    patient,
    onValidate: onValidate || null,
  };

  _renderCotModal(patient, cotation);
}

/* Rendu (appelé aussi après modification d'un acte) */
function _renderCotModal(patient, cotationOriginal) {
  const existing = document.getElementById('cot-modal-live');
  if (existing) existing.remove();

  const actes = _cotModalState.actes;
  const total = actes.reduce((s, a) => s + (parseFloat(a.total) || 0), 0);
  const heure = patient.heure_soin || patient.heure_preferee || patient.heure || '';
  const desc  = (patient.description || patient.texte || 'Soin infirmier').slice(0, 100);

  /* Catalogue d'actes courants pour ajout rapide */
  const ACTES_RAPIDES = [
    { code:'AMI1',  nom:'Soin infirmier',        total: 3.15 },
    { code:'AMI2',  nom:'Acte infirmier ×2',     total: 6.30 },
    { code:'AMI3',  nom:'Acte infirmier ×3',     total: 9.45 },
    { code:'AMI4',  nom:'Pansement complexe',    total:12.60 },
    { code:'BSA',   nom:'Bilan soins A',         total:13.00 },
    { code:'BSB',   nom:'Bilan soins B',         total:18.20 },
    { code:'BSC',   nom:'Bilan soins C',         total:28.70 },
    { code:'IFD',   nom:'Indemnité déplacement', total: 2.75 },
    { code:'IK5',   nom:'Indemnité km (5 km)',   total: 1.75 },
    { code:'MAU',   nom:'Majoration urgence',    total: 9.15 },
    { code:'MN',    nom:'Majoration nuit',       total: 9.15 },
    { code:'MDD',   nom:'Majoration dim./férié', total: 9.15 },
  ];

  const modal = document.createElement('div');
  modal.id = 'cot-modal-live';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.8);display:flex;align-items:flex-end;justify-content:center;padding:0;box-sizing:border-box';

  modal.innerHTML = `
    <div id="cot-modal-inner" style="background:var(--bg,#0b0f14);border:1px solid rgba(0,212,170,.3);border-radius:20px 20px 0 0;padding:20px 20px 32px;width:100%;max-width:580px;max-height:90vh;overflow-y:auto;box-shadow:0 -12px 50px rgba(0,0,0,.6)">

      <!-- En-tête -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px">
        <div>
          <div style="font-family:var(--fs);font-size:20px;color:var(--t)">📋 Cotation du soin</div>
          <div style="font-size:11px;color:var(--m);font-family:var(--fm);margin-top:2px">Vérifiez et corrigez avant validation</div>
        </div>
        <button onclick="document.getElementById('cot-modal-live').remove()" style="background:none;border:1px solid var(--b);border-radius:50%;width:32px;height:32px;color:var(--m);font-size:18px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center">✕</button>
      </div>

      <!-- Résumé patient -->
      <div style="padding:10px 12px;background:var(--s);border:1px solid var(--b);border-radius:10px;margin-bottom:16px">
        <div style="font-size:13px;color:var(--t);font-weight:600">${desc}</div>
        ${heure ? `<div style="font-size:11px;color:var(--m);margin-top:3px;font-family:var(--fm)">🕐 Heure de soin : ${heure}</div>` : ''}
      </div>

      <!-- Liste des actes modifiables -->
      <div style="font-family:var(--fm);font-size:10px;color:var(--m);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px">Actes — cliquez pour modifier</div>
      <div id="cot-actes-list">
        ${actes.length ? actes.map((a, i) => `
          <div id="cot-acte-${i}" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(0,212,170,.04);border:1px solid rgba(0,212,170,.15);border-radius:10px;margin-bottom:8px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <input id="cot-code-${i}" value="${a.code||''}" oninput="_cotUpdateTotal()" style="font-family:var(--fm);font-size:11px;background:var(--ad);color:var(--a);border:1px solid rgba(0,212,170,.3);border-radius:20px;padding:2px 10px;width:70px;text-align:center">
                <input id="cot-nom-${i}" value="${(a.nom||'').replace(/"/g,'&quot;')}" oninput="_cotUpdateTotal()" style="font-size:12px;color:var(--t);background:transparent;border:none;border-bottom:1px solid var(--b);flex:1;min-width:80px;padding:2px 0" placeholder="Description acte">
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
              <input id="cot-total-${i}" type="number" step="0.01" value="${(parseFloat(a.total)||0).toFixed(2)}" oninput="_cotUpdateTotal()" style="font-family:var(--fm);font-size:13px;color:var(--a);font-weight:700;background:transparent;border:1px solid rgba(0,212,170,.2);border-radius:6px;padding:4px 6px;width:72px;text-align:right">
              <span style="font-size:12px;color:var(--m)">€</span>
            </div>
            <button onclick="_cotRemoveActe(${i})" style="background:none;border:none;color:rgba(255,95,109,.6);font-size:16px;cursor:pointer;flex-shrink:0;padding:2px 4px" title="Supprimer cet acte">✕</button>
          </div>
        `).join('') : `<div class="ai wa" style="margin-bottom:12px">⚠️ Aucun acte détecté — ajoutez-en manuellement ci-dessous.</div>`}
      </div>

      <!-- Ajout rapide d'acte -->
      <div style="margin-bottom:16px">
        <div style="font-family:var(--fm);font-size:10px;color:var(--m);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px">Ajouter un acte</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          ${ACTES_RAPIDES.map(a => `
            <button onclick="_cotAddActe('${a.code}','${a.nom.replace(/'/g,"\\'")}',${a.total})"
              style="font-size:11px;font-family:var(--fm);background:var(--s);border:1px solid var(--b);border-radius:20px;padding:4px 10px;cursor:pointer;color:var(--t);white-space:nowrap">
              ${a.code} <span style="color:var(--m)">${a.total.toFixed(2)}€</span>
            </button>
          `).join('')}
        </div>
        <div style="display:flex;gap:6px">
          <input id="cot-add-code" placeholder="Code (ex: AMI1)" style="width:90px;font-size:12px;font-family:var(--fm)">
          <input id="cot-add-nom" placeholder="Description" style="flex:1;font-size:12px">
          <input id="cot-add-total" type="number" step="0.01" placeholder="€" style="width:70px;font-size:12px">
          <button class="btn bp bsm" onclick="_cotAddCustomActe()">+ Ajouter</button>
        </div>
      </div>

      <!-- Total -->
      <div id="cot-total-display" style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;background:rgba(0,212,170,.08);border:1px solid rgba(0,212,170,.3);border-radius:12px;margin-bottom:18px">
        <span style="font-size:15px;color:var(--t);font-weight:600">Total</span>
        <span id="cot-total-val" style="font-family:var(--fs);font-size:26px;color:var(--a)">${total.toFixed(2)} €</span>
      </div>

      <!-- Actions -->
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn bp" style="flex:2;min-width:160px" onclick="_validateCotationLive()">
          ✅ Valider cette cotation
        </button>
        <button class="btn bv" style="flex:1;min-width:120px" onclick="_openCotationComplete()">
          🖊️ Cotation complète
        </button>
        <button class="btn bs" style="flex:none" onclick="document.getElementById('cot-modal-live').remove()">
          Plus tard
        </button>
      </div>
      <p style="font-size:11px;color:var(--m);margin-top:12px;font-family:var(--fm);text-align:center;line-height:1.5">
        💡 Cotation basée sur la description du soin · Modifiez les actes si nécessaire avant de valider
      </p>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

/* Met à jour le total affiché en lisant tous les inputs */
function _cotUpdateTotal() {
  const actes = _cotModalState.actes;
  let total = 0;
  actes.forEach((a, i) => {
    const codeEl  = document.getElementById(`cot-code-${i}`);
    const nomEl   = document.getElementById(`cot-nom-${i}`);
    const totalEl = document.getElementById(`cot-total-${i}`);
    if (codeEl)  a.code  = codeEl.value;
    if (nomEl)   a.nom   = nomEl.value;
    if (totalEl) { a.total = parseFloat(totalEl.value) || 0; total += a.total; }
  });
  const display = document.getElementById('cot-total-val');
  if (display) display.textContent = total.toFixed(2) + ' €';
}

/* Ajoute un acte rapide */
function _cotAddActe(code, nom, montant) {
  _cotUpdateTotal(); // sauvegarder l'état courant
  _cotModalState.actes.push({ code, nom, total: montant, _idx: _cotModalState.actes.length });
  _renderCotModal(_cotModalState.patient, null);
}

/* Ajoute un acte personnalisé */
function _cotAddCustomActe() {
  const code  = (document.getElementById('cot-add-code')?.value  || '').trim().toUpperCase();
  const nom   = (document.getElementById('cot-add-nom')?.value   || '').trim();
  const total = parseFloat(document.getElementById('cot-add-total')?.value) || 0;
  if (!code && !nom) { if (typeof showToast === 'function') showToast('Remplissez au moins le code ou la description'); return; }
  _cotUpdateTotal();
  _cotModalState.actes.push({ code: code || 'AMI', nom: nom || 'Acte infirmier', total });
  _renderCotModal(_cotModalState.patient, null);
}

/* Supprime un acte par index */
function _cotRemoveActe(idx) {
  _cotUpdateTotal();
  _cotModalState.actes.splice(idx, 1);
  _renderCotModal(_cotModalState.patient, null);
}

/* Valide la cotation et met à jour le CA */
function _validateCotationLive() {
  _cotUpdateTotal();
  const actes  = _cotModalState.actes;
  const total  = actes.reduce((s, a) => s + (parseFloat(a.total) || 0), 0);
  const patient = _cotModalState.patient;

  // Mettre à jour le CA de la journée
  LIVE_CA_TOTAL += total;
  const caEl = $('live-ca-total');
  if (caEl) { caEl.textContent = `💶 CA du jour : ${LIVE_CA_TOTAL.toFixed(2)} €`; caEl.style.display = 'block'; }

  // Ajouter au récap CA
  updateLiveCaCard(patient, { actes, total });

  // Marquer la cotation sur le patient en mémoire
  if (patient) patient._cotation = { actes, total, validated: true };

  // Sauvegarder la cotation dans le carnet patient (IDB) si la fiche existe
  (async () => {
    try {
      const pid = patient?.patient_id || patient?.id;
      if (!pid || typeof _idbGetAll !== 'function') return;
      const rows = await _idbGetAll(PATIENTS_STORE);
      const row  = rows.find(r => r.id === pid);
      if (!row) return;
      const p = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };
      if (!p.cotations) p.cotations = [];
      p.cotations.push({
        date:   new Date().toISOString(),
        actes,
        total,
        soin:   patient.description || patient.texte || '',
        source: 'tournee',
      });
      p.updated_at = new Date().toISOString();
      await _idbPut(PATIENTS_STORE, {
        id:         p.id,
        nom:        p.nom,
        prenom:     p.prenom,
        _data:      _enc(p),
        updated_at: p.updated_at,
      });
    } catch(e) {
      console.warn('[AMI] Sauvegarde cotation IDB KO:', e.message);
    }
  })();

  // Callback optionnel
  if (typeof _cotModalState.onValidate === 'function') _cotModalState.onValidate(actes, total);

  const modal = document.getElementById('cot-modal-live');
  if (modal) modal.remove();

  if (typeof showToast === 'function') showToast(`✅ Cotation validée — ${total.toFixed(2)} € ajoutés au CA`);
  renderLivePatientList();
}

/* Ouvre la section cotation complète en pré-remplissant le texte */
function _openCotationComplete() {
  const patient = _cotModalState.patient;
  const modal   = document.getElementById('cot-modal-live');
  if (modal) modal.remove();

  // Pré-remplir le textarea de cotation si disponible
  const textarea = document.getElementById('f-txt');
  if (textarea && patient) textarea.value = patient.texte || patient.description || '';

  if (typeof navTo === 'function') navTo('cot', null);
  if (typeof showToast === 'function') showToast('💡 Description pré-remplie — ajustez et cotez');
}

/* Ouvre la modale de cotation pour un patient spécifique depuis la liste tournée */
async function openCotationPatient(patientIndex) {
  const patients = APP.importedData?.patients || APP.importedData?.entries || [];
  const patient  = patients[patientIndex];
  if (!patient) return;

  // Si cotation déjà validée, proposer de la re-consulter
  if (patient._cotation?.validated) {
    showCotationModal(patient, patient._cotation, null);
    return;
  }

  // Sinon générer une cotation automatique via API ou fallback local
  if (typeof showToast === 'function') showToast('⚡ Génération de la cotation…');
  let cotation = null;
  try {
    const u = S?.user || {};
    const d = await apiCall('/webhook/ami-calcul', {
      mode: 'ngap',
      texte: patient.texte || patient.description || '',
      infirmiere: ((u.prenom||'') + ' ' + (u.nom||'')).trim(),
      adeli: u.adeli || '', rpps: u.rpps || '', structure: u.structure || '',
      date_soin: new Date().toISOString().split('T')[0],
      heure_soin: patient.heure_soin || patient.heure_preferee || '',
      _live_auto: true
    });
    cotation = d;
  } catch (_) {
    if (typeof autoCotationLocale === 'function') cotation = autoCotationLocale(patient.description || patient.texte || '');
  }

  showCotationModal(patient, cotation || { actes: [], total: 0 }, null);
}

/* ============================================================
   RÉINITIALISATION TOURNÉE DU JOUR
   Efface tous les patients importés, remet le pilotage à zéro.
   Accessible depuis Tournée IA ET Pilotage de journée.
   ============================================================ */
function resetTourneeJour() {
  const n = (APP.importedData?.patients || APP.importedData?.entries || []).length;
  const msg = n > 0
    ? `Réinitialiser la tournée du jour ?\n\n${n} patient(s) seront effacés de la Tournée IA et du Pilotage de journée.\nCette action ne supprime PAS les fiches du carnet patient.`
    : 'Réinitialiser la tournée du jour ?\n\nLe pilotage sera remis à zéro.';
  if (!confirm(msg)) return;

  // Reset données importées
  APP.importedData  = null;
  APP.uberPatients  = [];
  APP.nextPatient   = null;

  // Arrêter le timer live
  if (LIVE_TIMER_ID) { clearInterval(LIVE_TIMER_ID); LIVE_TIMER_ID = null; }
  LIVE_START_TIME = null;
  LIVE_CA_TOTAL   = 0;

  // Reset badge statut
  const badge = $('live-badge');
  if (badge) {
    badge.textContent = 'EN ATTENTE';
    badge.style.background = '';
    badge.style.color = '';
  }

  // Reset textes pilotage
  const patName = $('live-patient-name');
  if (patName) patName.textContent = 'Démarrez votre journée';
  const liveInfo = $('live-info');
  if (liveInfo) liveInfo.textContent = 'Cliquez sur "Démarrer" pour activer le pilotage automatique';

  // Reset timer + CA
  const timerEl = $('live-timer');
  if (timerEl) { timerEl.textContent = ''; timerEl.style.display = 'none'; }
  const caTotal = $('live-ca-total');
  if (caTotal) { caTotal.textContent = ''; caTotal.style.display = 'none'; }

  // Cacher bloc contrôles live + reset boutons démarrer/arrêter
  const liveControls = $('live-controls');
  if (liveControls) liveControls.style.display = 'none';
  const btnStart = $('btn-live-start');
  if (btnStart) btnStart.style.display = 'inline-flex';
  const btnStop = $('btn-live-stop');
  if (btnStop) btnStop.style.display = 'none';

  // Vider la liste patients du pilotage
  const liveNext = $('live-next');
  if (liveNext) liveNext.innerHTML = '';

  // Vider la tournée IA
  const tbody = $('tbody');
  if (tbody) tbody.innerHTML = '';
  const resTur = $('res-tur');
  if (resTur) resTur.classList.remove('show');

  // Cacher CA estimé
  const caWrap = $('tur-ca-wrap');
  if (caWrap) caWrap.style.display = 'none';
  const caBox = $('ca-box');
  if (caBox) caBox.style.display = 'none';

  // Cacher banner planning
  const banner = $('pla-import-banner');
  if (banner) banner.style.display = 'none';

  // Cacher CA journée
  const caCard = $('live-ca-card');
  if (caCard) caCard.style.display = 'none';
  const caDetail = $('live-ca-detail');
  if (caDetail) caDetail.innerHTML = '';

  // Arrêter GPS Uber si actif
  if (typeof stopLiveTracking === 'function') stopLiveTracking();

  // Reset affichage Mode Uber Médical
  const uberNext = $('uber-next-patient');
  if (uberNext) uberNext.innerHTML = '<div style="color:var(--m);font-size:13px">Démarrez la journée pour charger vos patients.</div>';
  const uberStatus = $('uber-tracking-status');
  if (uberStatus) uberStatus.textContent = '⏸️ GPS non démarré — cliquez sur "Démarrer la journée"';
  const uberProg = $('uber-progress');
  if (uberProg) uberProg.textContent = '';
  const uberRoute = $('uber-route-info');
  if (uberRoute) uberRoute.textContent = '';

  LIVE_PATIENT_ID = null;

  if (typeof showToast === 'function') showToast('🗑️ Tournée du jour réinitialisée.');
}

/* Patch liveStatus global — affiche TOUJOURS l'état local d'abord */
window.liveStatus = function() {
  // Affichage local immédiat (toujours disponible, même hors ligne)
  renderLivePatientList();
  // Tentative de synchronisation API en arrière-plan (non bloquant)
  liveStatusCore().catch(() => {});
};
