/* ════════════════════════════════════════════════
   admin.js — AMI NGAP
   ────────────────────────────────────────────────
   Panel d'administration
   - loadAdm() — charge la liste des comptes
   - loadAdmStats() — KPIs globaux
   - filterAccs() / renderAccs() — recherche
   - admAct() — bloquer / débloquer / supprimer
   - admAlert() — notifications admin
════════════════════════════════════════════════ */

/* ── Vérification de dépendances ─────────────── */
(function checkDeps(){
  if(typeof requireAuth==='undefined') console.error('admin.js : utils.js non chargé.');
})();

/* ADMIN */
let ACCS=[];
async function loadAdm(){
  if(!requireAuth()) return;
  $('accs').innerHTML='<div class="empty"><div class="ei"><div class="spin spinw" style="width:28px;height:28px"></div></div><p style="margin-top:12px">Chargement...</p></div>';
  try{
    const d=await wpost('/webhook/admin-liste',{});
    if(!d.ok)throw new Error(d.error||'Erreur');
    ACCS=d.comptes||[];renderAccs(ACCS);
  }catch(e){admAlert(e.message,'e');$('accs').innerHTML='<div class="empty"><div class="ei">⚠️</div><p>Impossible de charger les comptes</p></div>';}
}
async function loadAdmStats(){
  try{
    const d=await wpost('/webhook/admin-stats',{});
    if(!d.ok)return;
    const s=d.stats;
    if($('kpi-ca'))$('kpi-ca').textContent=(s.ca_total||0).toFixed(0)+'€';
    if($('kpi-actes'))$('kpi-actes').textContent=s.nb_actes||0;
    if($('kpi-panier'))$('kpi-panier').textContent=(s.panier_moyen||0).toFixed(2)+'€';
    if($('kpi-alertes'))$('kpi-alertes').textContent=s.nb_alertes||0;
    if($('kpi-dre'))$('kpi-dre').textContent=s.nb_dre||0;
    if($('adm-top-actes')&&s.top_actes?.length){
      $('adm-top-actes').innerHTML=`<div class="lbl" style="margin-bottom:10px">Actes les plus fréquents</div><div style="display:flex;gap:8px;flex-wrap:wrap">${s.top_actes.map(a=>`<span style="background:var(--ad);color:var(--a);border:1px solid rgba(0,212,170,.2);padding:4px 12px;border-radius:20px;font-family:var(--fm);font-size:12px">${a.code} <span style="opacity:.6">(${a.count})</span></span>`).join('')}</div>`;
    }
  }catch{}
}
function filterAccs(){const q=gv('adm-q').toLowerCase();renderAccs(q?ACCS.filter(a=>(a.nom||'').toLowerCase().includes(q)||(a.prenom||'').toLowerCase().includes(q)):ACCS);}
function renderAccs(list){
  if(!list.length){$('accs').innerHTML='<div class="empty"><div class="ei">👥</div><p>Aucun compte trouvé</p></div>';return;}
  $('accs').innerHTML=list.map(a=>{
    const ini=((a.prenom||'?')[0]+(a.nom||'?')[0]).toUpperCase();
    const name=((a.prenom||'')+' '+(a.nom||'')).trim()||'—';
    const safe=name.replace(/'/g,"\\'");
    return`<div class="acc ${a.is_blocked?'blk':''}"><div class="avat ${a.is_blocked?'blk':''}">${ini}</div><div class="acc-name">${name}</div><div class="acc-st ${a.is_blocked?'blk':'on'}">${a.is_blocked?'⏸ Suspendu':'● Actif'}</div><div class="acc-acts">${a.is_blocked?`<button class="bxs b-unblk" onclick="admAct('debloquer',${a.id},'${safe}')">▶ Réactiver</button>`:`<button class="bxs b-blk" onclick="admAct('bloquer',${a.id},'${safe}')">⏸ Suspendre</button>`}<button class="bxs b-del" onclick="admAct('supprimer',${a.id},'${safe}')">🗑️</button></div></div>`;
  }).join('');
}
function admAlert(msg,type='o'){const el=$('adm-alert');el.className='adm-alert '+type;el.textContent=msg;el.style.display='block';setTimeout(()=>el.style.display='none',5000);}
async function admAct(action,id,name){
  const msgs={bloquer:`Suspendre ${name} ?`,debloquer:`Réactiver ${name} ?`,supprimer:`⚠️ SUPPRIMER DÉFINITIVEMENT ${name} ?`};
  if(!confirm(msgs[action]))return;
  if(action==='supprimer'&&!confirm(`Confirmer la suppression de ${name} ?`))return;
  try{
    const d=await wpost(`/webhook/admin-${action}`,{id});
    if(!d.ok)throw new Error(d.error||'Erreur');
    const labels={bloquer:'suspendu',debloquer:'réactivé',supprimer:'supprimé'};
    admAlert(`✅ ${name} ${labels[action]}.`,'o');
    if(action==='supprimer')ACCS=ACCS.filter(a=>a.id!==id);
    else{const a=ACCS.find(a=>a.id===id);if(a)a.is_blocked=(action==='bloquer');}
    renderAccs(ACCS);
  }catch(e){admAlert(e.message,'e');}
}

/* NAV — handled by navTo() and mobile bottom nav */
