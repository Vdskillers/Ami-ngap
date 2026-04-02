/* ════════════════════════════════════════════════
   tournee.js — AMI NGAP
   ────────────────────────────────────────────────
   Tournée IA + Import + Planning + Pilotage Live
   ⚠️  Requiert Leaflet.js, map.js, uber.js
   - storeImportedData() / showCaFromImport()
   - estimateRevenue() / showImportedPatients()
   - importCalendar() / handleFileSelect()
   - generatePlanningFromImport() / renderPlanning()
   - getOsrmRoute() — routing réel OSRM
   - optimiserTournee() — appel API + affichage route
   - startLiveTimer() / detectDelay()
   - autoFacturation() — cotation arrière-plan
   - liveStatusCore() — état tournée live
   - Patches: window.startDay, window.liveAction, window.liveStatus

/* IMPORTED DATA — stockage centralisé
   ============================================================ */


/* ── Vérification de dépendances ─────────────── */
(function checkDeps() {
  if (typeof APP === 'undefined') console.error('tournee.js : APP store (utils.js) non chargé.');
  if (typeof L === 'undefined')   console.warn('tournee.js : Leaflet non chargé.');
})();

APP.importedData=null;

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
   TOURNÉE AVEC OSRM
   ============================================================ */
async function optimiserTournee(){
  if(!requireAuth()) return;

  /* ── Guards préventifs — évite les appels API inutiles ─────
     Sans données importées → Supabase reçoit une requête vide
     et renvoie 400/500. On bloque AVANT l'appel API.
  ─────────────────────────────────────────────────────────── */
  const patients=APP.importedData?.patients||APP.importedData?.entries||[];
  if(!patients.length){
    const tbody=$('tbody');
    if(tbody) tbody.innerHTML=`<div class="card">
      <div class="ct">⚠️ Aucune donnée importée</div>
      <div class="ai wa" style="margin-bottom:12px">Importez d'abord votre planning via <strong>📂 Import calendrier</strong> avant d'optimiser la tournée.</div>
      <button class="btn bp bsm" onclick="navTo('imp',null)"><span>📂</span> Aller à l'import</button>
    </div>`;
    $('res-tur').classList.add('show');
    return;
  }

  ld('btn-tur',true);$('res-tur').classList.remove('show');
  try{
    const startLat=parseFloat($('t-lat').value)||APP.startPoint?.lat||null;
    const startLng=parseFloat($('t-lng').value)||APP.startPoint?.lng||null;
    if(!startLat||!startLng){
      $('terr').style.display='flex';
      $('terr-m').textContent='📍 Définis ton point de départ (bouton GPS ou clic sur la carte)';
      $('res-tur').classList.add('show');ld('btn-tur',false);return;
    }
    const d=await apiCall('/webhook/ami-tournee-ia',{start_lat:startLat,start_lng:startLng});
    if(!d.ok)throw new Error(d.error||'Erreur');
    if(!d.route?.length){
      $('tbody').innerHTML='<div class="card"><div class="ai wa">⚠️ Aucun patient importé. Utilisez l\'import calendrier d\'abord.</div></div>';
    }else{
      // Tentative OSRM si on a des coords
      let osrm=null;
      const pts=d.route.filter(p=>p.lat&&p.lng).map(p=>({lat:p.lat,lng:p.lng}));
      if(pts.length>=2){
        const wps=[{lat:startLat,lng:startLng},...pts];
        osrm=await getOsrmRoute(wps);
      }
      const ca=estimateRevenue(d.route);
      $('tbody').innerHTML=`<div class="card">
        <div class="ct">🗺️ Tournée optimisée — ${d.total_patients} patients</div>
        <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
          <div class="dreb">📍 ${d.total_patients} patients</div>
          ${osrm?`<div class="dreb">🚗 ${osrm.total_km} km réels (OSRM)</div><div class="dreb">⏱ ~${osrm.total_min} min</div>`:(d.total_km?`<div class="dreb">🚗 ~${d.total_km} km estimés</div>`:'')}
          <div class="ca-pill">💶 CA estimé : ${ca.toFixed(2)} €</div>
        </div>
        ${d.route.map((p,i)=>{
          const sd=encodeURIComponent(p.description||'');
          const leg=osrm?.legs?.[i];
          return`<div class="route-item">
            <div class="route-num">${i+1}</div>
            <div class="route-info"><strong style="font-size:13px">${p.description||'Patient'}</strong>
              <div style="font-size:11px;color:var(--m);margin-top:2px">ID: ${p.patient_id||'—'}</div>
            </div>
            ${p.heure?`<div class="route-time">⏱ ${p.heure}</div>`:''}
            ${leg?`<div class="route-km">+${leg.km}km·${leg.min}min</div>`:(p.distance_km?`<div class="route-km">+${p.distance_km}km</div>`:'')}
            <button class="btn bp bsm" onclick="coterDepuisRoute(decodeURIComponent('${sd}'))">⚡ Coter</button>
          </div>`;}).join('')}
        ${d.alerts?.length?`<div class="aic" style="margin-top:16px">${d.alerts.map(a=>`<div class="ai wa">⚠️ ${a}</div>`).join('')}</div>`:''}
      </div>`;
    }
    $('terr').style.display='none';
  }catch(e){$('terr').style.display='flex';$('terr-m').textContent=e.message;}
  $('res-tur').classList.add('show');ld('btn-tur',false);
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

/* Patch startDay pour démarrer le timer */
const _origStartDay=window.startDay||(()=>{});
window.startDay=async function(){
  startLiveTimer();
  // appel direct du code original
  const el=$('live-badge');
  if(el){el.textContent='EN COURS';el.style.background='var(--ad)';el.style.color='var(--a)';}
  $('btn-live-start').style.display='none';
  $('live-controls').style.display='block';
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
