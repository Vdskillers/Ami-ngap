/* ════════════════════════════════════════════════
   cotation.js — AMI NGAP
   ────────────────────────────────────────────────
   Cotation NGAP + Vérification IA
   - cotation() — appel API calcul NGAP
   - renderResult() — affiche la feuille de soins
   - printResult() — impression / export PDF
   - clrCot() — réinitialise le formulaire
   - coterDepuisRoute() — cotation depuis tournée
   - openVerify() / closeVM() / applyVerify()
   - verifyStandalone() — vérification indépendante
   - openVM() / renderVM()
════════════════════════════════════════════════ */
/* VERIFY MODAL */
let VM_DATA=null;
async function openVerify(){
  const txt=gv('f-txt');if(!txt){alert("Saisissez d'abord une description du soin.");return;}
  $('vm').classList.add('open');$('vm-loading').style.display='block';$('vm-result').style.display='none';
  $('vm-apply').style.display='none';$('vm-cotate').style.display='none';VM_DATA=null;
  try{
    const d=await apiCall('/webhook/ami-calcul',{mode:'verify',texte:txt,ddn:gv('f-ddn'),date_soin:gv('f-ds'),heure_soin:gv('f-hs'),exo:gv('f-exo'),regl:gv('f-regl')});
    VM_DATA=d;renderVM(d);
  }catch(e){$('vm-loading').style.display='none';$('vm-result').innerHTML=`<div class="vm-item warn">⚠️ Erreur : ${e.message}</div>`;$('vm-result').style.display='block';}
}
function renderVM(d){
  $('vm-loading').style.display='none';$('vm-result').style.display='block';
  const corrige=d.texte_corrige||'',fixes=d.corrections||[],alerts=d.alertes_urssaf||d.alertes||[],sugg=d.optimisations||d.suggestions||[];
  const hasChanges=corrige||fixes.length||alerts.length||sugg.length;
  if(corrige&&corrige!==gv('f-txt')){$('vm-corr-wrap').style.display='block';$('vm-corrected-text').textContent=corrige;$('vm-apply').style.display='flex';}else{$('vm-corr-wrap').style.display='none';}
  if(fixes.length){$('vm-fixes-wrap').style.display='block';$('vm-fixes').innerHTML=fixes.map(f=>`<div class="vm-item fix">✏️ ${f}</div>`).join('');}else{$('vm-fixes-wrap').style.display='none';}
  if(alerts.length){$('vm-alerts-wrap').style.display='block';$('vm-alerts').innerHTML=alerts.map(a=>`<div class="vm-item warn">⚠️ ${a}</div>`).join('');}else{$('vm-alerts-wrap').style.display='none';}
  if(sugg.length){$('vm-sugg-wrap').style.display='block';$('vm-sugg').innerHTML=sugg.map(s=>`<div class="vm-item sugg">💡 ${s}</div>`).join('');}else{$('vm-sugg-wrap').style.display='none';}
  $('vm-ok-wrap').style.display=hasChanges?'none':'block';
  $('vm-cotate').style.display='flex';
}
function applyVerify(){if(VM_DATA?.texte_corrige)$('f-txt').value=VM_DATA.texte_corrige;closeVM();}
function closeVM(){$('vm').classList.remove('open');}
async function verifyStandalone(){
  const txt=gv('v-txt');if(!txt){alert('Saisissez une description.');return;}
  ld('btn-ver',true);$('res-ver').classList.remove('show');
  try{
    const d=await apiCall('/webhook/ami-calcul',{mode:'verify',texte:txt,date_soin:gv('v-ds'),heure_soin:gv('v-hs'),exo:gv('v-exo')});
    const corrige=d.texte_corrige||'',fixes=d.corrections||[],alerts=d.alertes_urssaf||d.alertes||[],sugg=d.optimisations||d.suggestions||[];
    $('vbody').innerHTML=`<div class="card"><div class="ct">🔍 Résultat</div>
    ${corrige?`<div style="margin-bottom:16px"><div class="lbl" style="color:var(--ok)">Texte normalisé</div><div style="background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:14px;font-style:italic;font-size:14px;line-height:1.7">${corrige}</div></div>`:''}
    ${fixes.length?`<div class="aic" style="margin-bottom:14px">${fixes.map(f=>`<div class="ai su">✏️ ${f}</div>`).join('')}</div>`:''}
    ${alerts.length?`<div class="aic" style="margin-bottom:14px">${alerts.map(a=>`<div class="ai wa">⚠️ ${a}</div>`).join('')}</div>`:''}
    ${sugg.length?`<div class="aic">${sugg.map(s=>`<div class="ai in">💡 ${s}</div>`).join('')}</div>`:''}
    ${!corrige&&!fixes.length&&!alerts.length&&!sugg.length?'<div class="ai su">✅ Description correcte</div>':''}
    </div>`;
    $('verr').style.display='none';
  }catch(e){$('verr').style.display='flex';$('verr-m').textContent=e.message;}
  $('res-ver').classList.add('show');ld('btn-ver',false);
}

/* COTATION */
async function cotation(){
  const txt=gv('f-txt');if(!txt){alert('Veuillez saisir une description.');return;}
  ld('btn-cot',true);$('res-cot').classList.remove('show');$('cerr').style.display='none';
  const u=S?.user||{};
  try{
    const d=await apiCall('/webhook/ami-calcul',{mode:'ngap',texte:txt,infirmiere:((u.prenom||'')+' '+(u.nom||'')).trim(),adeli:u.adeli||'',rpps:u.rpps||'',structure:u.structure||'',ddn:gv('f-ddn'),amo:gv('f-amo'),amc:gv('f-amc'),exo:gv('f-exo'),regl:gv('f-regl'),date_soin:gv('f-ds'),heure_soin:gv('f-hs')});
    if(d.error)throw new Error(d.error);
    $('cbody').innerHTML=renderCot(d);$('res-cot').classList.add('show');
  }catch(e){$('cerr').style.display='flex';$('cerr-m').textContent=e.message;$('res-cot').classList.add('show');}
  ld('btn-cot',false);
}
function renderCot(d){
  const a=d.actes||[],al=d.alerts||[],op=d.optimisations||[];
  return`<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
    <div><div class="lbl">Total cotation</div>
    <div style="display:flex;align-items:baseline;gap:6px"><div class="ta">${(d.total||0).toFixed(2)}</div><div class="tu">€</div></div>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">${d.dre_requise?'<div class="dreb">📋 DRE requise</div>':''}</div></div>
    <button class="btn bs bsm" onclick='printInv(${JSON.stringify(d).replace(/'/g,"&#39;")})'>🖨️ Imprimer</button>
  </div>
  <div class="rg">
    <div class="rc am"><div class="rl">Part AMO (SS)</div><div class="ra">${fmt(d.part_amo)}</div><div class="rp">${d.taux_amo?Math.round(d.taux_amo*100)+'%':'60%'}</div></div>
    <div class="rc mc"><div class="rl">Part AMC</div><div class="ra">${fmt(d.part_amc)}</div><div class="rp">Complémentaire</div></div>
    <div class="rc pa"><div class="rl">Part Patient</div><div class="ra">${fmt(d.part_patient)}</div><div class="rp">Ticket modérateur</div></div>
  </div>
  <div class="lbl" style="margin-bottom:10px">Détail des actes</div>
  <div class="al">${a.length?a.map(x=>`<div class="ar"><div class="ac ${cc(x.code)}">${x.code||'?'}</div><div class="an">${x.nom||''}</div><div class="ao">×${(x.coefficient||1).toFixed(1)}</div><div class="at">${fmt(x.total)}</div></div>`).join(''):'<div class="ai wa">⚠️ Aucun acte retourné</div>'}</div>
  ${al.length?`<div class="aic">${al.map(x=>`<div class="ai er">❌ ${x}</div>`).join('')}</div>`:'<div class="ai su">✅ Aucune alerte NGAP</div>'}
  ${op.length?`<div style="margin-top:16px"><div class="aic">${op.map(x=>`<div class="ai in">💡 ${x}</div>`).join('')}</div></div>`:''}
  </div>`;
}
function printInv(d){
  const u=S?.user||{},ac=d.actes||[];
  const num='F'+new Date().getFullYear()+'-'+String(Date.now()).slice(-6);
  const inf=((u.prenom||'')+' '+(u.nom||'')).trim()||'Infirmier(ère) libéral(e)';
  const w=window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${num}</title><style>body{font-family:sans-serif;margin:0;padding:40px;font-size:14px;color:#1a1a2e}table{width:100%;border-collapse:collapse;margin:20px 0}th{background:#f0f4fa;padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7a99}td{padding:10px 12px;border-bottom:1px solid #e8edf5}tfoot td{font-weight:700;border-top:2px solid #ccd5e0}.hdr{display:flex;justify-content:space-between;margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid #e0e7ef}.rep{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:20px}.rc{background:#f7f9fc;padding:14px;border-radius:8px;text-align:center}.rl{font-size:11px;text-transform:uppercase;color:#6b7a99;margin-bottom:4px}.rv{font-size:22px;font-weight:700}@media print{button{display:none}}</style></head><body>
  <div class="hdr"><div><h1 style="margin:0 0 6px;font-size:26px;color:#0b3954">Facture de soins</h1><div style="font-size:12px;color:#6b7a99">N° ${num} · ${new Date().toLocaleDateString('fr-FR')}</div></div><div style="text-align:right"><strong>${inf}</strong>${u.adeli?'<br>ADELI '+u.adeli:''}${u.rpps?'<br>RPPS '+u.rpps:''}</div></div>
  <table><thead><tr><th>Code</th><th>Acte</th><th style="text-align:right">Coef.</th><th style="text-align:right">Montant</th></tr></thead>
  <tbody>${ac.map(x=>`<tr><td>${x.code||''}</td><td>${x.nom||''}</td><td style="text-align:right">×${(x.coefficient||1).toFixed(1)}</td><td style="text-align:right">${fmt(x.total)}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="3" style="text-align:right">TOTAL</td><td style="text-align:right">${fmt(d.total)}</td></tr></tfoot></table>
  <div class="rep"><div class="rc"><div class="rl">AMO (SS)</div><div class="rv">${fmt(d.part_amo)}</div></div><div class="rc"><div class="rl">AMC</div><div class="rv">${fmt(d.part_amc)}</div></div><div class="rc"><div class="rl">Patient</div><div class="rv">${fmt(d.part_patient)}</div></div></div>
  ${d.dre_requise?'<p style="margin-top:16px;padding:10px;background:#e8f4ff;border-radius:6px;font-size:13px;color:#2563eb">📋 <strong>DRE requise</strong></p>':''}
  <script>window.onload=()=>window.print()<\/script></body></html>`);w.document.close();
}
function clrCot(){['f-pr','f-pr-rp','f-pr-dt','f-pt','f-ddn','f-sec','f-amo','f-amc','f-txt','f-ds','f-hs'].forEach(id=>{const e=$(id);if(e)e.value='';});['f-exo','f-regl'].forEach(id=>{const e=$(id);if(e)e.selectedIndex=0;});$('res-cot').classList.remove('show');}

/* IMPORT CALENDRIER */
function handleFileSelect(input){
  const f=input.files[0];if(!f)return;
  $('drop-zone').style.borderColor='var(--a)';
  const reader=new FileReader();
  reader.onload=e=>{$('imp-text').value=e.target.result;};
  reader.readAsText(f,'UTF-8');
}
// Drag & drop
const dz=$('drop-zone');
if(dz){
  dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('drag');});
  dz.addEventListener('dragleave',()=>dz.classList.remove('drag'));
  dz.addEventListener('drop',e=>{
    e.preventDefault();dz.classList.remove('drag');
    const f=e.dataTransfer.files[0];if(!f)return;
    const reader=new FileReader();
    reader.onload=ev=>{$('imp-text').value=ev.target.result;};
    reader.readAsText(f,'UTF-8');
    $('drop-zone').style.borderColor='var(--a)';
  });
}
async function importCalendar(){
  const content=gv('imp-text');
  if(!content){alert('Aucun contenu à importer. Sélectionnez un fichier ou collez du texte.');return;}
  ld('btn-imp',true);
  try{
    const fileInput=$('imp-file');
    const filename=fileInput.files[0]?.name||'';
    const type=fileInput.files[0]?.type||'';
    const d=await apiCall('/webhook/import-calendar',{content,type,filename});
    if(!d.ok)throw new Error(d.error||'Erreur import');
    // Stocker les données importées globalement
    storeImportedData(d);
    $('imp-result').innerHTML=`<div class="card"><div class="ct">✅ Import réussi</div>
    <div class="ai su" style="margin-bottom:12px">✅ ${d.total} entrée(s) importée(s) · ${d.stored||0} sauvegardée(s)</div>
    ${d.alerts?.length?`<div class="lbl" style="margin-bottom:8px">⚠️ Avertissements</div><div class="aic">${d.alerts.map(a=>`<div class="ai wa">⚠️ ${a}</div>`).join('')}</div>`:''}
    <div style="margin-top:16px;display:flex;gap:10px">
      <button class="btn bv bsm" onclick="document.querySelector('[data-v=tur]').click()">🗺️ Optimiser la tournée</button>
      <button class="btn bp bsm" onclick="document.querySelector('[data-v=live]').click()">▶️ Démarrer le pilotage</button>
    </div></div>`;
    $('imp-result').classList.add('show');
  }catch(e){
    $('imp-result').innerHTML=`<div class="errb">⚠️ ${e.message}</div>`;
    $('imp-result').classList.add('show');
  }
  ld('btn-imp',false);
}

function coterDepuisRoute(desc){
  $('f-txt').value=desc;
  document.querySelector('[data-v=cot]')?.click();
}

/* PILOTAGE LIVE */
async function startDay(){
  $('live-badge').textContent='EN COURS';
  $('live-badge').style.background='var(--ad)';$('live-badge').style.color='var(--a)';
  $('btn-live-start').style.display='none';
  $('live-controls').style.display='block';
  await liveStatus();
}
async function liveStatus(){
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
    }else{
      $('live-patient-name').textContent='Tournée terminée ✅';
      $('live-info').textContent='Tous les patients ont été vus';
      $('live-next').innerHTML='<div class="card"><div class="ai su">✅ Journée terminée ! Tous les patients ont été pris en charge.</div></div>';
    }
  }catch(e){console.error(e);}
}
async function liveAction(action){
  if(!LIVE_PATIENT_ID&&action!=='get_status'){alert('Aucun patient actif.');return;}
  try{
    const d=await apiCall('/webhook/ami-live',{action,patient_id:LIVE_PATIENT_ID||''});
    if(d.suggestion)alert('💡 '+d.suggestion);
    await liveStatus();
  }catch(e){alert('Erreur : '+e.message);}
}

/* PLANNING */
async function modeAI(m){
  const txt=gv('pl-txt');if(!txt){alert('Saisissez la liste.');return;}
  ld('btn-pla',true);$('res-pla').classList.remove('show');
  try{
    const d=await apiCall('/webhook/ami-calcul',{mode:m,texte:txt});
    renderPlanning(d);
    $('perr').style.display='none';
  }catch(e){$('perr').style.display='flex';$('perr-m').textContent=e.message;}
  $('res-pla').classList.add('show');ld('btn-pla',false);
}

/* HISTORIQUE */
async function hist(){
  const tb=$('htb');
  tb.innerHTML='<tr><td colspan="7" style="text-align:center;padding:20px"><div class="spin spinw" style="margin:0 auto;width:24px;height:24px"></div></td></tr>';
  try{
    const params=new URLSearchParams({patient:gv('hq'),period:gv('hp')});
    const r=await fetch(W+'/webhook/ami-historique?'+params,{headers:{'Authorization':'Bearer '+ss.tok()}});
    const rows=await r.json(),arr=Array.isArray(rows)?rows:[];
    const tot=arr.reduce((s,x)=>s+(parseFloat(x.total)||0),0);
    $('hstats').innerHTML=`<div class="sc g"><div class="si">🧾</div><div class="sv">${arr.length}</div><div class="sn">Soins cotés</div></div><div class="sc b"><div class="si">💶</div><div class="sv">${tot.toFixed(0)}</div><div class="sn">Total € facturé</div></div><div class="sc o"><div class="si">📋</div><div class="sv">${arr.filter(x=>x.dre_requise).length}</div><div class="sn">DRE requises</div></div><div class="sc r"><div class="si">⚠️</div><div class="sv">${arr.filter(x=>{try{return JSON.parse(x.alerts||'[]').length>0}catch{return false}}).length}</div><div class="sn">Alertes NGAP</div></div>`;
    if(!arr.length){tb.innerHTML='<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--m)">Aucune donnée</td></tr>';return;}
    tb.innerHTML=arr.map(row=>{
      const ac=typeof row.actes==='string'?JSON.parse(row.actes||'[]'):(row.actes||[]);
      const al=typeof row.alerts==='string'?JSON.parse(row.alerts||'[]'):(row.alerts||[]);
      return`<tr><td style="font-family:var(--fm);font-size:12px;color:var(--m)">#${row.id}</td><td>${row.date_soin?new Date(row.date_soin).toLocaleDateString('fr-FR'):'—'}</td><td><div class="tg">${ac.map(x=>x.code?`<span class="tgt">${x.code}</span>`:'').join('')||'—'}</div></td><td style="font-family:var(--fm);font-weight:600;color:var(--a)">${fmt(row.total)}</td><td style="font-family:var(--fm);font-size:11px;${row.dre_requise?'color:var(--a2)':'color:var(--m)'}">${row.dre_requise?'OUI':'non'}</td><td>${al.length?`<span style="font-size:11px;color:var(--w)">⚠️ ${al.length}</span>`:'<span style="font-size:11px;color:var(--ok)">✅</span>'}</td><td><button class="btn bd bsm" onclick="qDel(${row.id})">🗑️</button></td></tr>`;
    }).join('');
  }catch(e){tb.innerHTML=`<tr><td colspan="7"><div class="errb">⚠️ ${e.message}</div></td></tr>`;}
}
async function qDel(id){if(!confirm(`Supprimer #${id} (RGPD) ?`))return;const r=await fetch(W+'/webhook/ami-supprimer',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+ss.tok()},body:JSON.stringify({action:'delete_one',id})});const d=await r.json();if(d.ok)hist();}
async function delById(){const id=gv('del-id');if(!id||!confirm(`Supprimer #${id} ?`))return;await doD({action:'delete_one',id});}
async function delByPt(){const p=gv('del-pt');if(!p||!confirm(`Purger "${p}" ?`))return;await doD({action:'delete_patient',patient:p});}
async function doD(payload){
  try{const r=await fetch(W+'/webhook/ami-supprimer',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+ss.tok()},body:JSON.stringify(payload)});const d=await r.json();$('del-r').innerHTML=d.ok?`<div class="ai su">✅ ${d.deleted||0} supprimée(s).</div>`:`<div class="ai er">❌ ${d.error}</div>`;}
  catch(e){$('del-r').innerHTML=`<div class="ai er">❌ ${e.message}</div>`;}
}
