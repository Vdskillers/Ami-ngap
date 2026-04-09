/* ════════════════════════════════════════════════
   admin.js — AMI NGAP v4.0
   ────────────────────────────────────────────────
   Panel d'administration
   - loadAdm() — charge la liste des comptes
   - loadAdmStats() — KPIs globaux (anonymisés)
   - loadAdmLogs() — journal d'audit
   - loadAdmSecurityStats() — stats sécurité temps réel
   - filterAccs() / renderAccs() — recherche
   - admAct() — bloquer / débloquer / supprimer
   - admAlert() — notifications admin
   ────────────────────────────────────────────────
   v4.0 :
   ⚠️ Aucune donnée patient n'est accessible ici (RGPD/HDS)
   Les admins voient : nom+prénom infirmiers, stats anonymisées,
   logs d'audit (sans données patient), alertes sécurité.
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
    // ⚠️ RGPD/HDS : les admins ne voient pas les autres admins — nurses uniquement
    ACCS=(d.comptes||[]).filter(a=>a.role!=='admin');renderAccs(ACCS);
  }catch(e){admAlert(e.message,'e');$('accs').innerHTML='<div class="empty"><div class="ei">⚠️</div><p>Impossible de charger les comptes</p></div>';}
  // Charger aussi logs + stats sécurité + messages
  loadAdmSecurityStats();
  loadAdmMessages();
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

/* ── Journal d'audit (sans données patient) ───── */
async function loadAdmLogs(){
  const el=$('adm-logs');
  if(!el) return;
  el.innerHTML='<div class="spin spinw" style="width:20px;height:20px;margin:12px auto"></div>';
  try{
    const d=await wpost('/webhook/admin-logs',{});
    if(!d.ok) throw new Error(d.error||'Erreur');
    const logs=d.logs||[];
    if(!logs.length){el.innerHTML='<div class="ai in">Aucun log disponible</div>';return;}
    el.innerHTML=logs.map(l=>{
      const evtIcon={LOGIN_FAIL:'🔴',LOGIN_SUCCESS:'🟢',COTATION_FRAUD_ALERT:'🚨',ADMIN_BLOCK_USER:'⏸',ADMIN_DELETE_USER:'🗑️',REGISTER:'✨',PASSWORD_CHANGE:'🔑',COTATION_NGAP:'⚡'}[l.event]||'📋';
      const d=new Date(l.created_at).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
      return`<div class="audit-log-row"><span class="log-icon">${evtIcon}</span><span class="log-event">${l.event||'—'}</span><span class="log-date">${d}</span>${l.score!=null?`<span class="log-score ${l.score>=70?'high':l.score>=40?'med':'low'}">${l.score}</span>`:''}</div>`;
    }).join('');
  }catch(e){el.innerHTML=`<div class="ai er">⚠️ ${e.message}</div>`;}
}

/* ── Stats sécurité temps réel ─────────────────── */
async function loadAdmSecurityStats(){
  try{
    const d=await wpost('/webhook/admin-security-stats',{});
    if(!d.ok) return;
    const s=d.security;
    if($('kpi-login-fails'))  $('kpi-login-fails').textContent=s.login_fails||0;
    if($('kpi-fraud-alerts')) $('kpi-fraud-alerts').textContent=s.fraud_alerts||0;
    // Alertes récentes dans le panneau sécurité
    const el=$('adm-recent-alerts');
    if(el&&s.recent_alerts?.length){
      el.innerHTML=s.recent_alerts.map(a=>{
        const icon=a.event==='LOGIN_FAIL'?'🔴':a.event==='COTATION_FRAUD_ALERT'?'🚨':'⚠️';
        const d=new Date(a.created_at).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
        return`<div class="ai ${a.score>=70?'er':'wa'}" style="font-size:12px;margin-bottom:4px">${icon} ${a.event} — ${d}${a.score!=null?' · score '+a.score:''}</div>`;
      }).join('');
    }else if(el){
      el.innerHTML='<div class="ai su">✅ Aucune alerte récente</div>';
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
    // ⚠️ toAdminView côté worker : seuls id, nom, prenom, is_blocked sont présents — jamais d'email ni de données patient
    return`<div class="acc ${a.is_blocked?'blk':''}"><div class="avat ${a.is_blocked?'blk':''}">${ini}</div><div class="acc-name">${name}</div><div class="acc-st ${a.is_blocked?'blk':'on'}">${a.is_blocked?'⏸ Suspendu':'● Actif'}</div><div class="acc-acts">${a.is_blocked?`<button class="bxs b-unblk" onclick="admAct('debloquer','${a.id}','${safe}')">▶ Réactiver</button>`:`<button class="bxs b-blk" onclick="admAct('bloquer','${a.id}','${safe}')">⏸ Suspendre</button>`}<button class="bxs b-del" onclick="admAct('supprimer','${a.id}','${safe}')">🗑️</button></div></div>`;
  }).join('');
}
function admAlert(msg,type='o'){const el=$('adm-alert');el.className='adm-alert '+type;el.textContent=msg;el.style.display='block';setTimeout(()=>el.style.display='none',5000);}
async function admAct(action,id,name){
  const msgs={bloquer:`Suspendre ${name} ?`,debloquer:`Réactiver ${name} ?`,supprimer:`⚠️ SUPPRIMER DÉFINITIVEMENT ${name} ?`};
  if(!confirm(msgs[action]))return;
  if(action==='supprimer'&&!confirm(`Confirmer la suppression définitive de ${name} ?`))return;
  try{
    const d=await wpost(`/webhook/admin-${action}`,{id});
    if(!d.ok)throw new Error(d.error||'Erreur');
    const labels={bloquer:'suspendu',debloquer:'réactivé',supprimer:'supprimé'};
    admAlert(`✅ ${name} ${labels[action]}.`,'o');
    if(action==='supprimer')ACCS=ACCS.filter(a=>a.id!==id);
    else{const a=ACCS.find(a=>a.id===id);if(a)a.is_blocked=(action==='bloquer');}
    renderAccs(ACCS);
    loadAdmSecurityStats();
  }catch(e){admAlert(e.message,'e');}
}

/* NAV — handled by navTo() and mobile bottom nav */

/* ════════════════════════════════════════════════
   MESSAGERIE ADMIN — Messages des infirmières
════════════════════════════════════════════════ */
let ADM_MESSAGES = [];

async function loadAdmMessages() {
  const el  = $('adm-messages');
  if (!el) return;
  const filter = $('adm-msg-filter')?.value || 'all';
  el.innerHTML = '<div style="text-align:center;padding:20px"><div class="spin spinw" style="width:24px;height:24px;margin:0 auto"></div></div>';
  try {
    const d = await wpost('/webhook/admin-messages', { filter });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    ADM_MESSAGES = d.messages || [];
    _renderAdmMessages(ADM_MESSAGES);
    // Badge non-lus
    const unread = ADM_MESSAGES.filter(m => m.status === 'sent').length;
    const badge  = $('adm-msg-badge');
    if (badge) {
      badge.textContent = unread + ' non lu(s)';
      badge.style.display = unread > 0 ? 'inline' : 'none';
    }
  } catch (e) {
    el.innerHTML = `<div class="ai er">⚠️ ${e.message}</div>`;
  }
}

function _renderAdmMessages(messages) {
  const el = $('adm-messages');
  if (!el) return;
  if (!messages.length) {
    el.innerHTML = '<div class="empty" style="padding:24px 0"><div class="ei">📭</div><p style="margin-top:8px;color:var(--m)">Aucun message pour l\'instant.</p></div>';
    return;
  }
  const catLabel  = { bug:'🐛 Bug', amelioration:'💡 Amélioration', question:'❓ Question', ngap:'📋 Cotation NGAP', autre:'📩 Autre' };
  const statusColor = { sent:'#ef4444', read:'#f59e0b', replied:'#00d4aa' };
  const statusLabel = { sent:'🔴 Non lu', read:'👁️ Lu', replied:'✅ Répondu' };

  el.innerHTML = messages.map(m => {
    const date     = new Date(m.created_at).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const nurseName = ((m.infirmiere_prenom||'') + ' ' + (m.infirmiere_nom||'')).trim() || 'Infirmier(ère)';
    const ini      = (nurseName.substring(0,1) + (nurseName.split(' ')[1]||'').substring(0,1)).toUpperCase();
    const isUnread = m.status === 'sent';
    const replyBloc = m.reply_message
      ? `<div style="margin-top:10px;padding:10px 14px;background:rgba(0,212,170,.06);border-left:3px solid var(--a);border-radius:0 8px 8px 0;font-size:12px;color:var(--m)"><span style="color:var(--a);font-weight:600">Votre réponse :</span> ${_escAdm(m.reply_message)}</div>`
      : '';
    const replyForm = m.status !== 'replied'
      ? `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
           <textarea id="reply-${m.id}" placeholder="Répondre à ${nurseName}…" style="flex:1;min-width:200px;padding:8px 12px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:12px;font-family:var(--fi);resize:vertical;min-height:60px" maxlength="1000"></textarea>
           <div style="display:flex;flex-direction:column;gap:6px">
             <button class="btn bp bsm" style="white-space:nowrap" onclick="replyToMessage('${m.id}','${_escAdm(nurseName)}')">📤 Répondre</button>
             ${isUnread ? `<button class="btn bs bsm" style="font-size:11px" onclick="markMessageRead('${m.id}')">👁️ Marquer lu</button>` : ''}
           </div>
         </div>`
      : '';
    return `<div style="border:1px solid ${isUnread ? '#ef4444' : 'var(--b)'};border-radius:12px;padding:16px;margin-bottom:12px;background:var(--s);${isUnread ? 'box-shadow:0 0 0 1px rgba(239,68,68,.2)' : ''}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:36px;height:36px;border-radius:50%;background:var(--ad);color:var(--a);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">${ini}</div>
          <div>
            <div style="font-weight:600;font-size:14px">${_escAdm(nurseName)}</div>
            <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${date}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="padding:3px 10px;border-radius:20px;font-size:11px;font-family:var(--fm);background:rgba(255,255,255,.05);border:1px solid var(--b)">${catLabel[m.categorie]||m.categorie}</span>
          <span style="padding:3px 10px;border-radius:20px;font-size:11px;font-family:var(--fm);color:${statusColor[m.status]||'var(--m)'};">${statusLabel[m.status]||m.status}</span>
        </div>
      </div>
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">${_escAdm(m.sujet)}</div>
      <div style="font-size:13px;color:var(--m);line-height:1.6;white-space:pre-wrap;background:var(--dd);padding:10px 14px;border-radius:8px">${_escAdm(m.message)}</div>
      ${replyBloc}
      ${replyForm}
    </div>`;
  }).join('');
}

async function markMessageRead(id) {
  try {
    await wpost('/webhook/admin-message-read', { id });
    const m = ADM_MESSAGES.find(x => x.id === id);
    if (m) { m.status = 'read'; _renderAdmMessages(ADM_MESSAGES); }
  } catch (e) { admAlert(e.message, 'e'); }
}

async function replyToMessage(id, nurseName) {
  const ta   = document.getElementById('reply-' + id);
  const reply = (ta?.value || '').trim();
  if (!reply) { admAlert('Rédigez une réponse avant d\'envoyer.', 'e'); return; }
  if (reply.length < 5) { admAlert('Réponse trop courte.', 'e'); return; }
  try {
    const d = await wpost('/webhook/admin-message-reply', { id, reply });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    admAlert(`✅ Réponse envoyée à ${nurseName}.`, 'o');
    const m = ADM_MESSAGES.find(x => x.id === id);
    if (m) { m.status = 'replied'; m.reply_message = reply; m.replied_at = new Date().toISOString(); }
    _renderAdmMessages(ADM_MESSAGES);
  } catch (e) { admAlert(e.message, 'e'); }
}

function _escAdm(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

