/* ════════════════════════════════════════════════
   admin.js — AMI NGAP v5.0
   ────────────────────────────────────────────────
   Panel d'administration — architecture RGPD/HDS
   ────────────────────────────────────────────────
   ISOLATION DES DONNÉES (rappel architectural) :
   • Chaque utilisateur a sa propre base IndexedDB isolée par userId
     → ami_patients_db_<userId> / ami_sig_db_<userId>
   • Les admins ont LEUR PROPRE base IndexedDB (même mécanisme)
     → ils voient uniquement leurs propres données de test
   • Les infirmières ne voient que leurs propres données (isolation id)
   • Les admins ne voient pas les données des infirmières (RGPD/HDS)
   • Les admins ne voient pas les autres admins dans le panneau
   ────────────────────────────────────────────────
   PANNEAU ADMIN — 4 ONGLETS :
   1. Comptes       — liste nurses + actions (bloquer/réactiver/supprimer)
   2. Statistiques  — KPIs globaux anonymisés + stats par utilisateur
   3. Logs d'audit  — table audit_logs Supabase, filtres, export CSV
   4. Messages      — messages des infirmières, réponses
   ────────────────────────────────────────────────
   v5.0 :
   ⚠️ Aucune donnée patient n'est accessible ici (RGPD/HDS)
   Les admins voient : nom+prénom infirmiers, stats anonymisées,
   logs d'audit (sans données patient), alertes sécurité.
════════════════════════════════════════════════ */

/* ── Vérification de dépendances ─────────────── */
(function checkDeps(){
  if(typeof requireAuth==='undefined') console.error('admin.js : utils.js non chargé.');
})();

/* ════════════════════════════════════════════════
   NAVIGATION PAR ONGLETS DU PANNEAU ADMIN
════════════════════════════════════════════════ */
let _ADM_ACTIVE_TAB = 'comptes';

function admTab(tab) {
  _ADM_ACTIVE_TAB = tab;
  document.querySelectorAll('.adm-tab-btn').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.adm-tab-section').forEach(sec => {
    sec.style.display = sec.dataset.tab === tab ? 'block' : 'none';
  });
  if (tab === 'comptes')  { loadAdmComptes(); }
  if (tab === 'stats')    { loadAdmStats(); }
  if (tab === 'logs')     { loadAdmLogs(); }
  if (tab === 'sante')    { loadSystemHealth(); }
  if (tab === 'messages') { loadAdmMessages(); }
}

/* ════════════════════════════════════════════════
   CHARGEMENT PRINCIPAL (appelé par showAdm)
════════════════════════════════════════════════ */
let ACCS = [];

async function loadAdm() {
  if (!requireAuth()) return;
  admTab(_ADM_ACTIVE_TAB || 'comptes');
}

/* ── Onglet 1 : Gestion des comptes ─────────── */
async function loadAdmComptes() {
  const el = $('accs');
  if (!el) return;
  el.innerHTML = '<div class="empty"><div class="ei"><div class="spin spinw" style="width:28px;height:28px"></div></div><p style="margin-top:12px">Chargement...</p></div>';
  try {
    // 💎 Nouveau : endpoint enrichi qui retourne nom/prenom + tier + days_left
    // Fallback automatique sur /webhook/admin-liste si l'endpoint n'est pas déployé
    let d;
    try {
      d = await wpost('/webhook/admin-subscription-list', {});
    } catch (_) {
      d = await wpost('/webhook/admin-liste', {});
    }
    if (!d.ok) throw new Error(d.error || 'Erreur');
    // ⚠️ RGPD/HDS : les admins ne voient pas les autres admins
    ACCS = (d.comptes || []).filter(a => a.role !== 'admin');
    renderAccs(ACCS);
    // Charger aussi le mode app (switch TEST/PAYANT)
    loadAdmAppMode();
  } catch (e) {
    admAlert(e.message, 'e');
    el.innerHTML = '<div class="empty"><div class="ei">⚠️</div><p>Impossible de charger les comptes</p></div>';
  }
}

/* ── Onglet 2 : Statistiques globales + par infirmière ── */
let _ADM_PER_USER_DATA = []; // cache pour filtre/tri client

async function loadAdmStats() {
  const puEl = $('adm-per-user-stats');
  if (puEl) puEl.innerHTML = '<div class="ai in" style="font-size:12px">Chargement…</div>';
  try {
    const d = await wpost('/webhook/admin-stats', {});
    if (!d.ok) return;
    const s = d.stats;
    if ($('kpi-ca'))     $('kpi-ca').textContent     = (s.ca_total    || 0).toFixed(0) + '€';
    if ($('kpi-actes'))  $('kpi-actes').textContent  = s.nb_actes  || 0;
    if ($('kpi-panier')) $('kpi-panier').textContent = (s.panier_moyen || 0).toFixed(2) + '€';
    if ($('kpi-alertes'))$('kpi-alertes').textContent= s.nb_alertes || 0;
    if ($('kpi-dre'))    $('kpi-dre').textContent    = s.nb_dre    || 0;
    if ($('adm-top-actes') && s.top_actes?.length) {
      $('adm-top-actes').innerHTML = `
        <div class="lbl" style="margin-bottom:10px">Actes les plus fréquents (codes NGAP anonymisés)</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${s.top_actes.map(a => `<span style="background:var(--ad);color:var(--a);border:1px solid rgba(0,212,170,.2);padding:4px 12px;border-radius:20px;font-family:var(--fm);font-size:12px">${a.code} <span style="opacity:.6">(${a.count})</span></span>`).join('')}
        </div>`;
    }

    // ── Stocker + rendre les stats par infirmière ──────────────────────
    _ADM_PER_USER_DATA = d.per_user || [];
    _admRenderNurseStats(_ADM_PER_USER_DATA);
  } catch(e) {
    if (puEl) puEl.innerHTML = `<div class="ai er">⚠️ ${_escAdm(e.message)}</div>`;
  }
}

/* Filtre la liste par nom/prénom */
function _admFilterNurses(q) {
  const query = (q || '').toLowerCase().trim();
  const filtered = query
    ? _ADM_PER_USER_DATA.filter(u => ((u.prenom||'') + ' ' + (u.nom||'')).toLowerCase().includes(query))
    : _ADM_PER_USER_DATA;
  _admRenderNurseStats(filtered);
}

/* Tri client */
function _admSortNurses(mode) {
  const q = ($('adm-nurse-search')?.value || '').toLowerCase().trim();
  let list = q
    ? _ADM_PER_USER_DATA.filter(u => ((u.prenom||'') + ' ' + (u.nom||'')).toLowerCase().includes(q))
    : [..._ADM_PER_USER_DATA];
  if (mode === 'ca_desc')       list.sort((a,b) => b.ca_total - a.ca_total);
  else if (mode === 'ca_asc')   list.sort((a,b) => a.ca_total - b.ca_total);
  else if (mode === 'actes_desc') list.sort((a,b) => b.nb_actes - a.nb_actes);
  else if (mode === 'alpha')    list.sort((a,b) => (a.nom+a.prenom).localeCompare(b.nom+b.prenom,'fr'));
  else if (mode === 'last_activity') list.sort((a,b) => (b.last_activity||'') > (a.last_activity||'') ? 1 : -1);
  _admRenderNurseStats(list);
}

/* Rendu principal : cards par infirmière */
function _admRenderNurseStats(list) {
  const puEl = $('adm-per-user-stats');
  if (!puEl) return;

  if (!list.length) {
    puEl.innerHTML = '<p style="color:var(--m);font-size:13px;text-align:center;padding:20px 0">Aucune infirmière correspondante.</p>';
    return;
  }

  // Calcul max CA pour les barres de progression
  const maxCA = Math.max(...list.map(u => u.ca_total), 1);

  // Compteurs globaux de la liste affichée
  const totalCA     = list.reduce((s,u) => s + u.ca_total, 0);
  const totalActes  = list.reduce((s,u) => s + u.nb_actes, 0);
  const actives     = list.filter(u => u.is_active !== false && u.nb_actes > 0).length;

  puEl.innerHTML = `
    <!-- Résumé cohorte -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:18px">
      <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px 14px;text-align:center">
        <div style="font-size:20px;margin-bottom:2px">👩‍⚕️</div>
        <div style="font-family:var(--fs);font-size:22px;color:var(--a)">${list.length}</div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">Infirmier(e)s</div>
      </div>
      <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px 14px;text-align:center">
        <div style="font-size:20px;margin-bottom:2px">✅</div>
        <div style="font-family:var(--fs);font-size:22px;color:var(--a)">${actives}</div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">Actives (actes)</div>
      </div>
      <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px 14px;text-align:center">
        <div style="font-size:20px;margin-bottom:2px">💰</div>
        <div style="font-family:var(--fs);font-size:22px;color:var(--a)">${totalCA.toFixed(0)}€</div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">CA cumulé</div>
      </div>
      <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px 14px;text-align:center">
        <div style="font-size:20px;margin-bottom:2px">⚡</div>
        <div style="font-family:var(--fs);font-size:22px;color:var(--a)">${totalActes}</div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">Actes totaux</div>
      </div>
    </div>

    <!-- Notice RGPD -->
    <div class="adm-notice" style="margin-bottom:14px;font-size:11px">
      <span style="font-size:14px;flex-shrink:0">🔐</span>
      <span>Seuls nom, prénom et métriques NGAP agrégées sont affichés. Aucune donnée patient (noms, DDN, pathologies) n'est accessible — stockage local chiffré AES-256 sur l'appareil de chaque infirmière.</span>
    </div>

    <!-- Cards par infirmière -->
    <div style="display:flex;flex-direction:column;gap:10px">
      ${list.map(u => _admNurseCard(u, maxCA)).join('')}
    </div>`;
}

/* Rendu d'une card infirmière */
function _admNurseCard(u, maxCA) {
  const ini     = (((u.prenom||'?')[0]) + ((u.nom||'?')[0])).toUpperCase();
  const name    = (_escAdm((u.prenom||'') + ' ' + (u.nom||'')).trim()) || '—';
  const pct     = maxCA > 0 ? Math.round((u.ca_total / maxCA) * 100) : 0;
  const panier  = u.panier_moyen ? u.panier_moyen.toFixed(2) : '0.00';
  const active  = u.is_active !== false;
  const hasData = u.nb_actes > 0;

  const lastAct = u.last_activity
    ? new Date(u.last_activity).toLocaleDateString('fr-FR', { day:'2-digit', month:'short', year:'numeric' })
    : '—';
  const inscription = u.date_inscription
    ? new Date(u.date_inscription).toLocaleDateString('fr-FR', { day:'2-digit', month:'short', year:'numeric' })
    : '—';

  const statusDot = active
    ? '<span style="width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;flex-shrink:0" title="Compte actif"></span>'
    : '<span style="width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block;flex-shrink:0" title="Compte bloqué"></span>';

  const alertBadge = u.nb_alertes > 0
    ? `<span style="background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.3);padding:2px 8px;border-radius:20px;font-size:10px;font-family:var(--fm)">⚠️ ${u.nb_alertes} alerte${u.nb_alertes>1?'s':''}</span>`
    : '';
  const dreBadge = u.taux_dre > 0
    ? `<span style="background:rgba(245,158,11,.1);color:#f59e0b;border:1px solid rgba(245,158,11,.25);padding:2px 8px;border-radius:20px;font-size:10px;font-family:var(--fm)">🏥 DRE ${u.taux_dre}%</span>`
    : '';
  const topCodeBadge = u.top_code
    ? `<span style="background:var(--ad);color:var(--a);border:1px solid rgba(0,212,170,.2);padding:2px 8px;border-radius:20px;font-size:10px;font-family:var(--fm)">🏆 ${u.top_code}</span>`
    : '';

  return `<div style="background:var(--s);border:1px solid var(--b);border-radius:12px;padding:14px 16px;${!active?'opacity:.6':''}">
    <!-- Ligne 1 : avatar + nom + statut + CA -->
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <div style="width:36px;height:36px;border-radius:50%;background:${hasData?'var(--ad)':'var(--s)'};border:1px solid ${hasData?'rgba(0,212,170,.35)':'var(--b)'};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:${hasData?'var(--a)':'var(--m)'};flex-shrink:0">${ini}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${statusDot}
          <span style="font-size:13px;font-weight:600;color:var(--t)">${name}</span>
        </div>
        <div style="font-size:11px;color:var(--m);margin-top:1px">
          ${u.nb_actes} acte${u.nb_actes!==1?'s':''} · panier ${panier}€
          ${u.last_activity ? ' · Dernière activité : ' + lastAct : ' · Aucune activité'}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-family:var(--fs);font-size:18px;color:${hasData?'var(--a)':'var(--m)'};font-weight:700">${u.ca_total.toFixed(0)}€</div>
        <div style="font-size:10px;color:var(--m)">CA total</div>
      </div>
    </div>

    <!-- Barre CA relative -->
    <div style="height:5px;background:rgba(0,212,170,.08);border-radius:3px;overflow:hidden;margin-bottom:10px">
      <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#00d4aa,#4fa8ff);border-radius:3px;transition:width .5s ease"></div>
    </div>

    <!-- Ligne 2 : métriques KPI -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin-bottom:${alertBadge||dreBadge||topCodeBadge?'10px':'0'}">
      <div style="background:var(--c);border:1px solid var(--b);border-radius:8px;padding:7px 10px;text-align:center">
        <div style="font-size:14px;font-weight:700;color:var(--a);font-family:var(--fm)">${u.nb_actes}</div>
        <div style="font-size:10px;color:var(--m)">Actes</div>
      </div>
      <div style="background:var(--c);border:1px solid var(--b);border-radius:8px;padding:7px 10px;text-align:center">
        <div style="font-size:14px;font-weight:700;color:var(--a);font-family:var(--fm)">${panier}€</div>
        <div style="font-size:10px;color:var(--m)">Panier moy.</div>
      </div>
      <div style="background:var(--c);border:1px solid var(--b);border-radius:8px;padding:7px 10px;text-align:center">
        <div style="font-size:14px;font-weight:700;color:${u.nb_dre>0?'#f59e0b':'var(--m)'};font-family:var(--fm)">${u.nb_dre}</div>
        <div style="font-size:10px;color:var(--m)">DRE</div>
      </div>
      <div style="background:var(--c);border:1px solid var(--b);border-radius:8px;padding:7px 10px;text-align:center">
        <div style="font-size:14px;font-weight:700;color:${u.nb_alertes>0?'#ef4444':'var(--m)'};font-family:var(--fm)">${u.nb_alertes}</div>
        <div style="font-size:10px;color:var(--m)">Alertes</div>
      </div>
      <div style="background:var(--c);border:1px solid var(--b);border-radius:8px;padding:7px 10px;text-align:center">
        <div style="font-size:11px;font-weight:600;color:var(--m);font-family:var(--fm)">${u.first_activity ? new Date(u.first_activity).toLocaleDateString('fr-FR',{day:'2-digit',month:'short'}) : '—'}</div>
        <div style="font-size:10px;color:var(--m)">1ère activité</div>
      </div>
    </div>

    <!-- Badges -->
    ${alertBadge || dreBadge || topCodeBadge ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${topCodeBadge}${dreBadge}${alertBadge}</div>` : ''}
  </div>`;
}

window._admFilterNurses = _admFilterNurses;
window._admSortNurses   = _admSortNurses;

/* ════════════════════════════════════════════════
   ONGLET 3 : JOURNAL D'AUDIT — audit_logs Supabase
   Filtres : événement, score, date
   Pagination côté client (50 par page)
   Export CSV (RGPD-compliant — sans données patient)
════════════════════════════════════════════════ */
let _ALL_AUDIT_LOGS  = [];   // tous les logs bruts
let _FILT_AUDIT_LOGS = [];   // après filtrage
let _AUDIT_PAGE      = 1;
const _AUDIT_PAGE_SIZE = 50;

// Icônes et libellés pour chaque type d'événement
const AUDIT_EVENT_META = {
  LOGIN_SUCCESS:          { icon:'🟢', label:'Connexion réussie',        color:'#00d4aa' },
  LOGIN_FAIL:             { icon:'🔴', label:'Échec de connexion',        color:'#ef4444' },
  REGISTER:               { icon:'✨', label:'Création de compte',        color:'#00d4aa' },
  LOGOUT:                 { icon:'🚪', label:'Déconnexion',               color:'var(--m)' },
  PASSWORD_CHANGE:        { icon:'🔑', label:'Changement de mot de passe',color:'#f59e0b' },
  PROFIL_UPDATE:          { icon:'👤', label:'Mise à jour du profil',     color:'var(--m)' },
  ACCOUNT_DELETED_SELF:   { icon:'🗑️', label:'Suppression de compte',    color:'#ef4444' },
  COTATION_NGAP:          { icon:'⚡', label:'Cotation NGAP',             color:'#00d4aa' },
  COTATION_FRAUD_ALERT:   { icon:'🚨', label:'Alerte fraude cotation',    color:'#ef4444' },
  COTATION_DELETE:        { icon:'🗑️', label:'Suppression cotation',     color:'#f59e0b' },
  COTATIONS_SYNC:         { icon:'🔄', label:'Sync cotations',            color:'var(--m)' },
  CALENDAR_IMPORT:        { icon:'📂', label:'Import calendrier',         color:'#00d4aa' },
  PATIENTS_PUSH:          { icon:'📤', label:'Sync patients',             color:'var(--m)' },
  PLANNING_PUSH:          { icon:'📅', label:'Sync planning',             color:'var(--m)' },
  KM_PUSH:                { icon:'🚗', label:'Sync kilométrique',         color:'var(--m)' },
  HEURE_CACHE_PUSH:       { icon:'⏱️', label:'Sync cache heures',         color:'var(--m)' },
  PRESCRIPTEUR_ADD:       { icon:'🩺', label:'Ajout prescripteur',        color:'#00d4aa' },
  CONTACT_MESSAGE_SENT:   { icon:'💬', label:'Message envoyé',            color:'var(--m)' },
  CONTACT_MESSAGE_READ:   { icon:'👁️', label:'Message lu',               color:'var(--m)' },
  CONTACT_MESSAGE_REPLIED:{ icon:'📤', label:'Message répondu',           color:'#00d4aa' },
  COPILOT_QUERY:          { icon:'🤖', label:'Requête Copilote IA',       color:'var(--m)' },
  ADMIN_BLOCK_USER:       { icon:'⏸',  label:'Admin : suspension compte', color:'#f59e0b' },
  ADMIN_UNBLOCK_USER:     { icon:'▶️', label:'Admin : réactivation',      color:'#00d4aa' },
  ADMIN_DELETE_USER:      { icon:'🗑️', label:'Admin : suppression',      color:'#ef4444' },
  ADMIN_SYSTEM_RESET:     { icon:'🔁', label:'Admin : reset system logs', color:'#f59e0b' },
};

function _auditEventMeta(event) {
  return AUDIT_EVENT_META[event] || { icon:'📋', label: event || '—', color:'var(--m)' };
}

async function loadAdmLogs() {
  const el = $('adm-logs-body');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:32px"><div class="spin spinw" style="width:28px;height:28px;margin:0 auto"></div><p style="margin-top:12px;color:var(--m);font-size:13px">Chargement du journal d\'audit...</p></div>';
  try {
    const d = await wpost('/webhook/admin-logs', {});
    if (!d.ok) throw new Error(d.error || 'Erreur');
    _ALL_AUDIT_LOGS = d.logs || [];
    _AUDIT_PAGE = 1;
    _renderAuditFilters();
    _applyAuditFilters();
    // KPIs sécurité
    _renderAuditKPIs(d.stats || {}, _ALL_AUDIT_LOGS);
  } catch (e) {
    el.innerHTML = `<div class="ai er">⚠️ ${e.message}</div>`;
  }
}

function _renderAuditKPIs(stats, logs) {
  const el = $('adm-audit-kpis');
  if (!el) return;
  const loginFails  = logs.filter(l => l.event === 'LOGIN_FAIL').length;
  const fraudAlerts = logs.filter(l => l.event === 'COTATION_FRAUD_ALERT').length;
  const highScore   = logs.filter(l => (l.score || 0) >= 70).length;
  const adminActs   = logs.filter(l => l.event?.startsWith('ADMIN_')).length;
  el.innerHTML = `
    <div class="adm-kpi-row" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px">
      <div class="adm-kpi-card" style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px 14px">
        <div style="font-size:20px;margin-bottom:4px">📋</div>
        <div style="font-family:var(--fs);font-size:22px;color:var(--a)">${logs.length}</div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">Logs totaux</div>
      </div>
      <div class="adm-kpi-card" style="background:var(--s);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:12px 14px">
        <div style="font-size:20px;margin-bottom:4px">🔴</div>
        <div style="font-family:var(--fs);font-size:22px;color:#ef4444">${loginFails}</div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">Échecs connexion</div>
      </div>
      <div class="adm-kpi-card" style="background:var(--s);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:12px 14px">
        <div style="font-size:20px;margin-bottom:4px">🚨</div>
        <div style="font-family:var(--fs);font-size:22px;color:#ef4444">${fraudAlerts}</div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">Alertes fraude</div>
      </div>
      <div class="adm-kpi-card" style="background:var(--s);border:1px solid rgba(245,158,11,.3);border-radius:10px;padding:12px 14px">
        <div style="font-size:20px;margin-bottom:4px">⚠️</div>
        <div style="font-family:var(--fs);font-size:22px;color:#f59e0b">${highScore}</div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">Score risque ≥70</div>
      </div>
      <div class="adm-kpi-card" style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px 14px">
        <div style="font-size:20px;margin-bottom:4px">⚙️</div>
        <div style="font-family:var(--fs);font-size:22px;color:var(--a)">${adminActs}</div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">Actions admin</div>
      </div>
    </div>`;
}

function _renderAuditFilters() {
  const sel = $('adm-log-event-filter');
  if (!sel) return;
  // Collecter les événements uniques présents dans les logs
  const events = [...new Set(_ALL_AUDIT_LOGS.map(l => l.event).filter(Boolean))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="">Tous les événements</option>' +
    events.map(e => {
      const m = _auditEventMeta(e);
      return `<option value="${e}">${m.icon} ${m.label}</option>`;
    }).join('');
  if (current) sel.value = current;
}

function _applyAuditFilters() {
  const evtFilter   = ($('adm-log-event-filter')?.value || '').trim();
  const scoreFilter = ($('adm-log-score-filter')?.value || '').trim();
  const dateFrom    = ($('adm-log-date-from')?.value || '').trim();
  const dateTo      = ($('adm-log-date-to')?.value || '').trim();
  const searchQ     = ($('adm-log-search')?.value || '').toLowerCase().trim();

  _FILT_AUDIT_LOGS = _ALL_AUDIT_LOGS.filter(l => {
    if (evtFilter && l.event !== evtFilter) return false;
    if (scoreFilter === 'high'   && (l.score || 0) < 70) return false;
    if (scoreFilter === 'med'    && ((l.score || 0) < 40 || (l.score || 0) >= 70)) return false;
    if (scoreFilter === 'low'    && (l.score || 0) >= 40) return false;
    if (scoreFilter === 'scored' && l.score == null) return false;
    if (dateFrom && new Date(l.created_at) < new Date(dateFrom)) return false;
    if (dateTo   && new Date(l.created_at) > new Date(dateTo + 'T23:59:59')) return false;
    if (searchQ) {
      const hay = (l.event + ' ' + (l.user_id || '') + ' ' + (l.ip || '')).toLowerCase();
      if (!hay.includes(searchQ)) return false;
    }
    return true;
  });

  _AUDIT_PAGE = 1;
  _renderAuditLogs();
}

function _renderAuditLogs() {
  const el = $('adm-logs-body');
  if (!el) return;
  const total  = _FILT_AUDIT_LOGS.length;
  const pages  = Math.max(1, Math.ceil(total / _AUDIT_PAGE_SIZE));
  _AUDIT_PAGE  = Math.min(_AUDIT_PAGE, pages);
  const start  = (_AUDIT_PAGE - 1) * _AUDIT_PAGE_SIZE;
  const slice  = _FILT_AUDIT_LOGS.slice(start, start + _AUDIT_PAGE_SIZE);

  // Compteur
  const cntEl = $('adm-logs-count');
  if (cntEl) cntEl.textContent = `${total} entrée${total > 1 ? 's' : ''}${total !== _ALL_AUDIT_LOGS.length ? ' (filtrées)' : ''}`;

  if (!slice.length) {
    el.innerHTML = '<div class="empty" style="padding:24px 0"><div class="ei">🔍</div><p style="margin-top:8px;color:var(--m)">Aucun log ne correspond aux filtres.</p></div>';
    _renderAuditPagination(0, 1);
    return;
  }

  el.innerHTML = `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px;font-family:var(--fm)">
        <thead>
          <tr style="border-bottom:2px solid var(--b)">
            <th style="padding:8px 10px;text-align:left;color:var(--m);font-weight:500;white-space:nowrap">Événement</th>
            <th style="padding:8px 10px;text-align:left;color:var(--m);font-weight:500;white-space:nowrap">Date & Heure</th>
            <th style="padding:8px 10px;text-align:left;color:var(--m);font-weight:500">User ID</th>
            <th style="padding:8px 10px;text-align:center;color:var(--m);font-weight:500">Score</th>
            <th style="padding:8px 10px;text-align:left;color:var(--m);font-weight:500">IP</th>
            <th style="padding:8px 10px;text-align:left;color:var(--m);font-weight:500">Détails</th>
          </tr>
        </thead>
        <tbody>
          ${slice.map((l, i) => {
            const m  = _auditEventMeta(l.event);
            const dt = new Date(l.created_at).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
            const scoreClass = l.score >= 70 ? 'high' : l.score >= 40 ? 'med' : 'low';
            const isAlert = l.event === 'COTATION_FRAUD_ALERT' || l.event === 'LOGIN_FAIL';
            // Extraire infos utiles du meta pour affichage
            const meta = l.meta || {};
            const metaBits = [];
            if (meta.role)       metaBits.push(`<span style="color:${meta.role==='admin'?'#f59e0b':'var(--a)'}">@${meta.role}</span>`);
            if (meta.count != null) metaBits.push(`${meta.count} éléments`);
            if (meta.email)      metaBits.push(`📧 ${_escAdm(meta.email.slice(0,20))}`);
            if (meta.target_id)  metaBits.push(`cible: ${meta.target_id.slice(0,8)}…`);
            return `<tr style="border-bottom:1px solid var(--b);${isAlert ? 'background:rgba(239,68,68,.04)' : i % 2 === 0 ? 'background:rgba(255,255,255,.01)' : ''}">
              <td style="padding:8px 10px">
                <span style="display:inline-flex;align-items:center;gap:6px">
                  <span>${m.icon}</span>
                  <span style="color:${m.color};font-weight:500">${_escAdm(m.label)}</span>
                </span>
              </td>
              <td style="padding:8px 10px;white-space:nowrap;color:var(--m)">${dt}</td>
              <td style="padding:8px 10px;color:var(--m);font-size:10px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_escAdm(l.user_id||'—')}">${l.user_id ? l.user_id.slice(0,8)+'…' : '—'}</td>
              <td style="padding:8px 10px;text-align:center">
                ${l.score != null ? `<span class="log-score ${scoreClass}" style="font-family:var(--fm);font-size:11px;padding:2px 8px;border-radius:20px">${l.score}</span>` : '<span style="color:var(--m)">—</span>'}
              </td>
              <td style="padding:8px 10px;color:var(--m);font-size:11px;white-space:nowrap">${_escAdm(l.ip || '—')}</td>
              <td style="padding:8px 10px;color:var(--m);font-size:11px">${metaBits.join(' · ') || '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  _renderAuditPagination(total, pages);
}

function _renderAuditPagination(total, pages) {
  const el = $('adm-logs-pagination');
  if (!el) return;
  if (pages <= 1) { el.innerHTML = ''; return; }
  const btns = [];
  if (_AUDIT_PAGE > 1)  btns.push(`<button class="bs bsm" onclick="_auditGo(${_AUDIT_PAGE - 1})">← Précédent</button>`);
  btns.push(`<span style="font-size:12px;color:var(--m);font-family:var(--fm);padding:0 8px">Page ${_AUDIT_PAGE} / ${pages}</span>`);
  if (_AUDIT_PAGE < pages) btns.push(`<button class="bs bsm" onclick="_auditGo(${_AUDIT_PAGE + 1})">Suivant →</button>`);
  el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:16px;flex-wrap:wrap">${btns.join('')}</div>`;
}

function _auditGo(page) {
  _AUDIT_PAGE = page;
  _renderAuditLogs();
  $('adm-logs-body')?.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

/* ── Export CSV des logs (RGPD — sans données patient) ── */
function exportAuditCSV() {
  const data = _FILT_AUDIT_LOGS.length ? _FILT_AUDIT_LOGS : _ALL_AUDIT_LOGS;
  if (!data.length) { admAlert('Aucun log à exporter.', 'e'); return; }
  const header = ['Date', 'Événement', 'Libellé', 'Score', 'User ID (partiel)', 'IP'];
  const rows = data.map(l => {
    const m  = _auditEventMeta(l.event);
    const dt = new Date(l.created_at).toLocaleString('fr-FR');
    const uid = l.user_id ? l.user_id.slice(0, 8) + '…' : '—';
    return [dt, l.event || '—', m.label, l.score ?? '—', uid, l.ip || '—'];
  });
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `audit_logs_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  admAlert(`✅ Export CSV : ${data.length} entrée(s) exportée(s).`, 'o');
}

/* ── Reset filtres logs ── */
function resetAuditFilters() {
  ['adm-log-event-filter','adm-log-score-filter','adm-log-date-from','adm-log-date-to','adm-log-search'].forEach(id => {
    const el = $(id); if (el) el.value = '';
  });
  _applyAuditFilters();
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

  // Palette tier → couleur (miroir de SUB.TIERS)
  const TIER_COLORS = {
    TRIAL:'#00d4aa', ESSENTIEL:'#4fa8ff', PRO:'#00d4aa',
    CABINET:'#ffb547', PREMIUM:'#c678dd', COMPTABLE:'#ff5f6d',
    LOCKED:'#6a8099', UNKNOWN:'#6a8099'
  };
  const TIER_LABELS = {
    TRIAL:'Essai', ESSENTIEL:'Essentiel', PRO:'Pro',
    CABINET:'Cabinet', PREMIUM:'Premium', COMPTABLE:'Comptable',
    LOCKED:'Verrouillé', UNKNOWN:'—'
  };

  $('accs').innerHTML=list.map(a=>{
    const ini=((a.prenom||'?')[0]+(a.nom||'?')[0]).toUpperCase();
    const name=((a.prenom||'')+' '+(a.nom||'')).trim()||'—';
    const safe=name.replace(/'/g,"\\'");

    // 💎 Abonnement : infos (ne sont présentes que si admin-subscription-list a réussi)
    const tier = a.tier || 'UNKNOWN';
    const tierColor = TIER_COLORS[tier] || '#6a8099';
    const tierLabel = TIER_LABELS[tier] || tier;
    const daysLeft  = a.days_left;
    const isTrial   = !!a.is_trial;
    const hasOverride = !!a.override;

    // Pill abonnement (affiché seulement si on a les infos)
    let subPill = '';
    if (a.tier) {
      let sub = '';
      if (isTrial && daysLeft != null) {
        const urgent = daysLeft <= 7;
        sub = `<span class="acc-sub-days ${urgent?'urgent':''}">${daysLeft}j restant${daysLeft>1?'s':''}</span>`;
      } else if (tier === 'LOCKED') {
        // Différencier : essai expiré vs abo payant expiré
        sub = a.expired
          ? `<span class="acc-sub-days urgent">Abo expiré</span>`
          : `<span class="acc-sub-days urgent">Essai expiré</span>`;
      } else if (['ESSENTIEL','PRO','CABINET','PREMIUM','COMPTABLE'].includes(tier) && a.paid_until) {
        const daysRem = Math.max(0, Math.ceil((new Date(a.paid_until) - Date.now())/(1000*60*60*24)));
        const lowStock = daysRem <= 7;
        sub = `<span class="acc-sub-days ${lowStock?'urgent':''}">${daysRem}j payé${daysRem>1?'s':''}</span>`;
      }
      const ovrIcon = hasOverride ? ' 🛠️' : '';
      // Rôle cabinet : afficher un marqueur selon le rôle
      let cabIcon = '';
      if (a.cabinet_member) {
        const roleLabels = { titulaire: '⭐ Titulaire', gestionnaire: '🛠️ Gestionnaire', membre: 'Membre' };
        const roleLabel = roleLabels[a.cabinet_role] || 'Membre';
        const tooltip = `Cabinet ${a.cabinet_size} IDE — ${roleLabel}`;
        // Icône différenciée : 🏥 pour membre standard, ⭐ pour titulaire, 🛠️ pour gestionnaire
        const icon = a.cabinet_role === 'titulaire' ? '⭐' : (a.cabinet_role === 'gestionnaire' ? '🛠️' : '🏥');
        cabIcon = ` <span title="${tooltip}" style="cursor:help">${icon}</span>`;
      }
      subPill = `<div class="acc-sub-pill" style="background:${tierColor}22;border-color:${tierColor}55;color:${tierColor}">
        <span class="acc-sub-label">${tierLabel}${ovrIcon}${cabIcon}</span>
        ${sub}
      </div>`;
    }

    // ⚠️ toAdminView côté worker : seuls id, nom, prenom, is_blocked, tier, days_left, trial_end, paid_until sont exposés
    return `<div class="acc ${a.is_blocked?'blk':''}">
      <div class="avat ${a.is_blocked?'blk':''}">${ini}</div>
      <div class="acc-info-col">
        <div class="acc-name">${name}</div>
        ${subPill}
      </div>
      <div class="acc-st ${a.is_blocked?'blk':'on'}">${a.is_blocked?'⏸ Suspendu':'● Actif'}</div>
      <div class="acc-acts">
        ${a.tier ? `<button class="bxs b-sub" onclick="openSubOverrideModal('${a.id}','${safe}','${tier}',${daysLeft==null?'null':daysLeft})" title="Gérer l'abonnement">💎</button>` : ''}
        ${a.is_blocked
          ? `<button class="bxs b-unblk" onclick="admAct('debloquer','${a.id}','${safe}')">▶ Réactiver</button>`
          : `<button class="bxs b-blk" onclick="admAct('bloquer','${a.id}','${safe}')">⏸ Suspendre</button>`}
        <button class="bxs b-del" onclick="admAct('supprimer','${a.id}','${safe}')">🗑️</button>
      </div>
    </div>`;
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
    // Badge non-lus dans le bouton d'onglet
    const unread = ADM_MESSAGES.filter(m => m.status === 'sent').length;
    const badge  = $('adm-msg-badge');
    if (badge) {
      badge.textContent = unread;
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

    // ═══ Reconstruction du fil de réponses (rétro-compat) ═══
    // Priorité : m.replies (array JSONB moderne) ; fallback : m.reply_message (ancien format unique).
    let thread = [];
    if (Array.isArray(m.replies) && m.replies.length) {
      thread = m.replies.map(r => ({
        message: String(r.message || r.text || ''),
        at: r.at || r.created_at || m.replied_at
      })).filter(r => r.message);
    } else if (m.reply_message) {
      thread = [{ message: m.reply_message, at: m.replied_at }];
    }

    const threadBloc = thread.length
      ? `<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
           ${thread.map((r, i) => {
             const rd = r.at ? new Date(r.at).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
             return `<div style="padding:10px 14px;background:rgba(0,212,170,.06);border-left:3px solid var(--a);border-radius:0 8px 8px 0;font-size:12px;color:var(--m)">
               <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px;flex-wrap:wrap">
                 <span style="color:var(--a);font-weight:600;font-size:11px;font-family:var(--fm)">💬 RÉPONSE #${i+1}${thread.length>1?' / '+thread.length:''}</span>
                 ${rd ? `<span style="font-size:10px;color:var(--m);font-family:var(--fm)">${rd}</span>` : ''}
               </div>
               <div style="color:var(--t);line-height:1.5;white-space:pre-wrap">${_escAdm(r.message)}</div>
             </div>`;
           }).join('')}
         </div>`
      : '';

    // Formulaire TOUJOURS affiché — permet d'ajouter autant de réponses que nécessaire.
    const btnLabel   = thread.length ? '➕ Ajouter une réponse' : '📤 Répondre';
    const placeholder = thread.length ? `Ajouter une réponse à ${nurseName}…` : `Répondre à ${nurseName}…`;
    const replyForm = `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
           <textarea id="reply-${m.id}" placeholder="${placeholder}" style="flex:1;min-width:200px;padding:8px 12px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:12px;font-family:var(--fi);resize:vertical;min-height:60px" maxlength="1000"></textarea>
           <div style="display:flex;flex-direction:column;gap:6px">
             <button class="btn bp bsm" style="white-space:nowrap" onclick="replyToMessage('${m.id}','${_escAdm(nurseName)}')">${btnLabel}</button>
             ${isUnread ? `<button class="btn bs bsm" style="font-size:11px" onclick="markMessageRead('${m.id}')">👁️ Marquer lu</button>` : ''}
           </div>
         </div>`;

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
          <span style="padding:3px 10px;border-radius:20px;font-size:11px;font-family:var(--fm);color:${statusColor[m.status]||'var(--m)'};">${statusLabel[m.status]||m.status}${thread.length>1?` · ${thread.length} réponses`:''}</span>
        </div>
      </div>
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">${_escAdm(m.sujet)}</div>
      <div style="font-size:13px;color:var(--m);line-height:1.6;white-space:pre-wrap;background:var(--dd);padding:10px 14px;border-radius:8px">${_escAdm(m.message)}</div>
      ${threadBloc}
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
  const ta    = document.getElementById('reply-' + id);
  const reply = (ta?.value || '').trim();
  if (!reply) { admAlert('Rédigez une réponse avant d\'envoyer.', 'e'); return; }
  if (reply.length < 5) { admAlert('Réponse trop courte.', 'e'); return; }
  try {
    const d = await wpost('/webhook/admin-message-reply', { id, reply });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    const m = ADM_MESSAGES.find(x => x.id === id);
    if (m) {
      const now = new Date().toISOString();
      if (!Array.isArray(m.replies)) m.replies = [];
      // Si l'ancien champ reply_message existait et que replies est vide → migrer localement pour l'affichage.
      if (!m.replies.length && m.reply_message) {
        m.replies.push({ message: m.reply_message, at: m.replied_at || now });
      }
      m.replies.push({ message: reply, at: now });
      // Rétro-compat : la 1ère réponse reste dans reply_message
      if (!m.reply_message) { m.reply_message = reply; m.replied_at = now; }
      m.status = 'replied';
      const count = m.replies.length;
      admAlert(count > 1 ? `✅ Réponse #${count} envoyée à ${nurseName}.` : `✅ Réponse envoyée à ${nurseName}.`, 'o');
    } else {
      admAlert(`✅ Réponse envoyée à ${nurseName}.`, 'o');
    }
    _renderAdmMessages(ADM_MESSAGES);
  } catch (e) { admAlert(e.message, 'e'); }
}

function _escAdm(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


/* ══════════════════════════════════════════════════════
   MAINTENANCE — Corriger les noms patients manquants
   Appelle /webhook/admin-fix-patient-nom pour rétropatcher
   toutes les cotations admin sans patient_nom en base
══════════════════════════════════════════════════════ */
async function adminFixPatientNom() {
  const btn    = document.getElementById('btn-fix-patient-nom');
  const result = document.getElementById('fix-patient-nom-result');
  if (!btn || !result) return;

  btn.disabled = true;
  btn.textContent = '⏳ Correction en cours…';
  result.textContent = '';
  result.style.color = 'var(--m)';

  try {
    const d = await wpost('/webhook/admin-fix-patient-nom', {});
    if (d.ok) {
      result.textContent = `✅ ${d.message}`;
      result.style.color = 'var(--ok)';
      // Recharger l'historique si visible
      if (typeof hist === 'function') {
        const histView = document.getElementById('view-his');
        if (histView && histView.classList.contains('on')) hist();
      }
    } else {
      result.textContent = '❌ ' + (d.error || 'Erreur inconnue');
      result.style.color = 'var(--d)';
    }
  } catch(e) {
    result.textContent = '❌ ' + e.message;
    result.style.color = 'var(--d)';
  } finally {
    btn.disabled = false;
    btn.textContent = '👤 Corriger les noms manquants';
  }
}

/* ════════════════════════════════════════════════
   💎 SUBSCRIPTION — Outils admin (simulation tier)
   ────────────────────────────────────────────────
   Le panneau de simulation est rendu dans la page #view-mon-abo
   par SUB.renderAbonnementPage() quand isAdmin.
   Ce bouton ferme le panneau admin et y redirige directement.
════════════════════════════════════════════════ */

/**
 * Ouvre le simulateur de tier (accessible depuis le bouton "Simuler tier"
 * dans la barre d'actions du panneau admin).
 * Redirige vers la page "Mon abonnement" de l'app qui contient le panneau
 * de simulation pour admin.
 */
function openTierSimulator() {
  if (typeof SUB === 'undefined') {
    alert('Module SUB non chargé. Rechargez la page.');
    return;
  }
  // Fermer le panneau admin → revenir à l'app
  const adm = document.getElementById('adm');
  const app = document.getElementById('app');
  if (adm) adm.classList.remove('show');
  if (app) app.style.display = 'grid';
  if (typeof updateNavMode === 'function') updateNavMode();
  // Naviguer vers la page abonnement
  setTimeout(() => {
    if (typeof navTo === 'function') navTo('mon-abo');
    if (typeof SUB.renderAbonnementPage === 'function') {
      setTimeout(() => SUB.renderAbonnementPage(), 100);
    }
  }, 50);
}

/**
 * Met à jour la carte de statut simulation dans le tab Comptes.
 * Appelée après chaque setAdminSim / clearAdminSim.
 */
function updateAdmSimStatus() {
  const card = document.getElementById('adm-sim-status');
  const txt  = document.getElementById('adm-sim-status-text');
  if (!card || !txt || typeof SUB === 'undefined') return;

  const st = SUB.getState();
  if (st.isAdmin && st.isAdminSim && st.simTier) {
    const tinfo = SUB.TIERS[st.simTier];
    const tierLabel = tinfo?.label || st.simTier;
    txt.textContent = `Vous testez l'application comme une IDEL au tier « ${tierLabel} ». Les verrous et paywalls correspondants sont actifs sur toutes les pages.`;
    card.style.display = 'flex';
  } else {
    card.style.display = 'none';
  }
}

/* Auto-refresh du statut quand l'admin ouvre le tab "comptes" */
(function() {
  const _origAdmTab = typeof admTab === 'function' ? admTab : null;
  if (!_origAdmTab) return;
  window.admTab = function(tab) {
    const r = _origAdmTab.apply(this, arguments);
    if (tab === 'comptes') setTimeout(updateAdmSimStatus, 100);
    return r;
  };
})();

/* Refresh aussi quand l'admin ouvre le panel (loadAdm) */
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(updateAdmSimStatus, 500);
});

/* ════════════════════════════════════════════════
   💎 SUBSCRIPTION — Pilotage admin (v2.0)
   ────────────────────────────────────────────────
   ✅ Switch global TEST ↔ PAYANT
   ✅ Override manuel du tier par user (avec prolongation essai)
   ✅ Synchronisé avec le worker (/webhook/admin-subscription-*)
════════════════════════════════════════════════ */

let _ADM_APP_MODE = null;   // 'TEST' | 'PAYANT'

/** Charge le mode actuel depuis le worker et met à jour l'UI du switch */
async function loadAdmAppMode() {
  const wrap = $('adm-app-mode-card');
  if (!wrap) return;
  try {
    const d = await wpost('/webhook/admin-subscription-mode', {});
    if (!d.ok) throw new Error(d.error || 'Erreur');
    _ADM_APP_MODE = d.mode || 'TEST';
    _renderAdmAppMode(d);
  } catch (e) {
    wrap.innerHTML = `
      <div style="color:var(--d);font-size:12px">
        ⚠️ Endpoint non disponible : <code>${e.message}</code>.
        Vérifiez que le worker est à jour (v2.0 avec endpoints subscription).
      </div>`;
  }
}

/** Rendu de la carte de pilotage du mode app */
function _renderAdmAppMode(d) {
  const wrap = $('adm-app-mode-card');
  if (!wrap) return;
  const mode = d.mode || 'TEST';
  const paidSince = d.paid_since ? new Date(d.paid_since).toLocaleDateString('fr-FR') : null;

  wrap.innerHTML = `
    <div class="adm-appmode-head">
      <div>
        <div class="adm-appmode-label">Mode application</div>
        <div class="adm-appmode-value ${mode.toLowerCase()}">
          ${mode === 'TEST' ? '🧪 MODE TEST' : '💳 MODE PAYANT'}
        </div>
        <div class="adm-appmode-sub">
          ${mode === 'TEST'
            ? 'Aucune limitation pour personne. Toutes les fonctionnalités sont accessibles à tous les utilisateurs.'
            : `Abonnements actifs${paidSince ? ` depuis le ${paidSince}` : ''}. Les infirmières voient les verrous et paywalls selon leur tier.`}
        </div>
      </div>
      <div class="adm-appmode-toggle-wrap">
        <label class="adm-appmode-toggle">
          <input type="checkbox" id="adm-appmode-switch" ${mode==='PAYANT'?'checked':''} onchange="toggleAppMode(this.checked)">
          <span class="adm-appmode-slider"></span>
        </label>
        <div class="adm-appmode-toggle-label">${mode==='PAYANT'?'Payant':'Test'}</div>
      </div>
    </div>
    ${mode === 'TEST' ? `
      <div class="adm-appmode-warn">
        ⚠️ <strong>Attention :</strong> passer en <b>mode payant</b> démarrera un essai gratuit de 30 jours pour toutes les infirmières actuellement sans abonnement. Cette action est irréversible par simple toggle (il faut recompter 30 jours pour revenir à l'état équivalent).
      </div>
    ` : `
      <div class="adm-appmode-info">
        💡 Les abonnements sont actifs. Vous pouvez revenir en mode test à tout moment (l'état des abonnements est conservé dans la BDD).
      </div>
    `}
  `;
}

/** Toggle entre TEST et PAYANT */
async function toggleAppMode(toPayant) {
  const newMode = toPayant ? 'PAYANT' : 'TEST';
  const currentMode = _ADM_APP_MODE || 'TEST';
  if (newMode === currentMode) return;

  const msg = newMode === 'PAYANT'
    ? `⚠️ Basculer l'application en MODE PAYANT ?\n\n• Toutes les infirmières sans abonnement recevront un essai gratuit de 30 jours\n• Les verrous et paywalls deviendront actifs\n• Les infirmières en essai verront le compte à rebours\n\nContinuer ?`
    : `Revenir en MODE TEST ?\n\n• Toutes les limitations sont désactivées\n• Tous les utilisateurs retrouvent un accès complet\n• Les abonnements sont conservés en BDD (réactivables)\n\nContinuer ?`;

  if (!confirm(msg)) {
    // Annuler : remettre le switch dans son état précédent
    const sw = $('adm-appmode-switch');
    if (sw) sw.checked = currentMode === 'PAYANT';
    return;
  }

  try {
    const d = await wpost('/webhook/admin-subscription-mode', { mode: newMode });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    _ADM_APP_MODE = d.mode;
    admAlert(`✓ Mode basculé en ${d.mode === 'PAYANT' ? 'PAYANT' : 'TEST'}. ${d.mode === 'PAYANT' ? 'Essai 30j activé pour toutes les infirmières.' : 'Accès illimité pour tous.'}`, 'o');
    _renderAdmAppMode(d);
    // Recharger la liste pour voir les nouveaux tiers
    loadAdmComptes();
  } catch (e) {
    admAlert(e.message, 'e');
    // Remettre le switch
    const sw = $('adm-appmode-switch');
    if (sw) sw.checked = currentMode === 'PAYANT';
  }
}

/** Ouvre la modale d'override tier pour un user */
function openSubOverrideModal(userId, userName, currentTier, daysLeft) {
  let modal = $('adm-sub-override-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'adm-sub-override-modal';
    modal.className = 'adm-sub-ovr-overlay';
    modal.addEventListener('click', e => { if (e.target === modal) closeSubOverrideModal(); });
    document.body.appendChild(modal);
  }

  const TIERS_LIST = [
    { key:'TRIAL',     label:'Essai gratuit (30j)',   color:'#00d4aa' },
    { key:'ESSENTIEL', label:'AMI Essentiel',          color:'#4fa8ff' },
    { key:'PRO',       label:'AMI Pro',                color:'#00d4aa' },
    { key:'CABINET',   label:'AMI Cabinet',            color:'#ffb547' },
    { key:'PREMIUM',   label:'AMI Premium',            color:'#c678dd' },
    { key:'COMPTABLE', label:'AMI Comptable',          color:'#ff5f6d' },
    { key:'LOCKED',    label:'Verrouiller (aucun accès)', color:'#6a8099' }
  ];

  const currentLabel = TIERS_LIST.find(t => t.key === currentTier)?.label || currentTier;

  modal.innerHTML = `
    <div class="adm-sub-ovr-card">
      <div class="adm-sub-ovr-close" onclick="closeSubOverrideModal()">×</div>
      <h2 class="adm-sub-ovr-title">💎 Gérer l'abonnement</h2>
      <div class="adm-sub-ovr-user">${userName}</div>
      <div class="adm-sub-ovr-current">
        <span>Abonnement actuel :</span>
        <b style="color:${TIERS_LIST.find(t => t.key === currentTier)?.color || '#6a8099'}">${currentLabel}</b>
        ${daysLeft != null && daysLeft !== 'null' ? ` · <span style="font-family:var(--fm);font-size:11px">${daysLeft}j restant${daysLeft>1?'s':''}</span>` : ''}
      </div>

      <div class="adm-sub-ovr-section-title">Définir un nouveau tier</div>
      <div class="adm-sub-ovr-tiers">
        ${TIERS_LIST.map(t => `
          <button class="adm-sub-ovr-tier-btn ${t.key===currentTier?'current':''}"
                  style="border-color:${t.color}55;color:${t.color}"
                  ${t.key===currentTier?'disabled':''}
                  onclick="applySubOverride('${userId}','${t.key}')">
            ${t.label}${t.key===currentTier?' (actuel)':''}
          </button>
        `).join('')}
      </div>

      <div class="adm-sub-ovr-section-title">Actions rapides</div>
      <div class="adm-sub-ovr-quick">
        <button class="adm-sub-ovr-quick-btn" onclick="extendSubTrial('${userId}',7)">+7 jours d'essai</button>
        <button class="adm-sub-ovr-quick-btn" onclick="extendSubTrial('${userId}',30)">+30 jours d'essai</button>
        <button class="adm-sub-ovr-quick-btn" onclick="extendSubTrial('${userId}',90)">+90 jours d'essai</button>
        <button class="adm-sub-ovr-quick-btn danger" onclick="resetSubToTrial('${userId}')">↺ Réinitialiser (essai 30j)</button>
      </div>

      <div class="adm-sub-ovr-section-title">💎 Add-on PREMIUM (+15 € HT/mois)</div>
      <div class="adm-sub-ovr-note" style="margin-bottom:10px">
        S'ajoute à Pro ou Cabinet. Débloque : optimisation CA avancée, détection CA sous-déclaré, protection médico-légale+, certificats forensiques, SLA < 2h, rapport juridique mensuel.
      </div>
      <div class="adm-sub-ovr-quick">
        <button class="adm-sub-ovr-quick-btn" style="background:rgba(198,120,221,.12);border-color:rgba(198,120,221,.4);color:#c678dd" onclick="enablePremiumAddon('${userId}',1)">+ Activer 1 mois</button>
        <button class="adm-sub-ovr-quick-btn" style="background:rgba(198,120,221,.12);border-color:rgba(198,120,221,.4);color:#c678dd" onclick="enablePremiumAddon('${userId}',6)">+ Activer 6 mois</button>
        <button class="adm-sub-ovr-quick-btn" style="background:rgba(198,120,221,.12);border-color:rgba(198,120,221,.4);color:#c678dd" onclick="enablePremiumAddon('${userId}',12)">+ Activer 12 mois</button>
        <button class="adm-sub-ovr-quick-btn danger" onclick="disablePremiumAddon('${userId}')">✕ Désactiver add-on</button>
      </div>

      <div class="adm-sub-ovr-note">
        <b>ℹ️ Note :</b> Ces modifications sont appliquées immédiatement en base. L'infirmière verra le nouveau statut à sa prochaine connexion (ou après rafraîchissement).
      </div>
    </div>
  `;
  modal.classList.add('open');
  setTimeout(() => modal.classList.add('visible'), 10);
}

function closeSubOverrideModal() {
  const modal = $('adm-sub-override-modal');
  if (!modal) return;
  modal.classList.remove('visible');
  setTimeout(() => modal.classList.remove('open'), 200);
}

/** Applique un override tier (set) */
async function applySubOverride(userId, tier) {
  if (!confirm(`Définir le tier "${tier}" pour cet utilisateur ?`)) return;
  try {
    const d = await wpost('/webhook/admin-subscription-override', {
      infirmiere_id: userId,
      action: 'set',
      tier: tier
    });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    console.info('[admin-subscription-override] OK', { userId, tier, response: d });
    admAlert(`✓ Tier "${tier}" appliqué avec succès.`, 'o');
    closeSubOverrideModal();
    loadAdmComptes();
  } catch (e) {
    console.error('[admin-subscription-override] FAILED', { userId, tier, error: e.message });
    admAlert(`Échec override : ${e.message}. Vérifiez que les tables "subscriptions" et "app_config" existent dans Supabase (exécutez migration_subscriptions.sql).`, 'e');
  }
}

/** Prolonge l'essai de N jours */
async function extendSubTrial(userId, days) {
  if (!confirm(`Prolonger l'essai de ${days} jours ?`)) return;
  try {
    const d = await wpost('/webhook/admin-subscription-override', {
      infirmiere_id: userId,
      action: 'extend_trial',
      days: days
    });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    admAlert(`✓ Essai prolongé de ${days} jours. Nouvelle fin : ${new Date(d.trial_end).toLocaleDateString('fr-FR')}.`, 'o');
    closeSubOverrideModal();
    loadAdmComptes();
  } catch (e) {
    admAlert(e.message, 'e');
  }
}

/** Réinitialise au trial 30j */
async function resetSubToTrial(userId) {
  if (!confirm(`Réinitialiser cet utilisateur à un essai gratuit de 30 jours ?\n\nCela écrase son abonnement actuel.`)) return;
  try {
    const d = await wpost('/webhook/admin-subscription-override', {
      infirmiere_id: userId,
      action: 'clear'
    });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    admAlert(`✓ Essai réinitialisé. Fin prévue : ${new Date(d.trial_end).toLocaleDateString('fr-FR')}.`, 'o');
    closeSubOverrideModal();
    loadAdmComptes();
  } catch (e) {
    admAlert(e.message, 'e');
  }
}

/* ══════════════════════════════════════════════════════════
   💎 ADD-ON PREMIUM (+15€ HT/mois)
   ──────────────────────────────────────────────────────────
   S'ajoute à un abonnement Pro ou Cabinet pour débloquer :
     - Optimisation CA avancée
     - Détection CA sous-déclaré
     - Protection médico-légale renforcée
     - Certificats forensiques horodatés
     - SLA support prioritaire < 2h
     - Rapport juridique mensuel
══════════════════════════════════════════════════════════ */

/** Active l'add-on PREMIUM pour N mois (défaut 1) */
async function enablePremiumAddon(userId, months) {
  months = months || 1;
  const label = months === 1 ? '1 mois' : `${months} mois`;
  if (!confirm(`Activer l'add-on PREMIUM pour ${label} sur cet utilisateur ?\n\n(Débloque les 6 fonctionnalités PREMIUM en plus de son forfait actuel.)`)) return;
  try {
    const d = await wpost('/webhook/admin-subscription-override', {
      infirmiere_id: userId,
      action: 'premium_addon_on',
      months: months
    });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    const until = d.premium_addon_until
      ? new Date(d.premium_addon_until).toLocaleDateString('fr-FR')
      : 'sans limite';
    admAlert(`✓ Add-on PREMIUM activé jusqu'au ${until}.`, 'o');
    closeSubOverrideModal();
    loadAdmComptes();
  } catch (e) {
    console.error('[admin-premium-addon-on] FAILED', { userId, error: e.message });
    admAlert(`Échec activation add-on : ${e.message}`, 'e');
  }
}

/** Désactive l'add-on PREMIUM */
async function disablePremiumAddon(userId) {
  if (!confirm(`Désactiver l'add-on PREMIUM pour cet utilisateur ?\n\n(Les 6 fonctionnalités PREMIUM ne seront plus accessibles.)`)) return;
  try {
    const d = await wpost('/webhook/admin-subscription-override', {
      infirmiere_id: userId,
      action: 'premium_addon_off'
    });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    admAlert(`✓ Add-on PREMIUM désactivé.`, 'o');
    closeSubOverrideModal();
    loadAdmComptes();
  } catch (e) {
    console.error('[admin-premium-addon-off] FAILED', { userId, error: e.message });
    admAlert(`Échec désactivation : ${e.message}`, 'e');
  }
}

/* Expose globalement pour onclick inline */
window.loadAdmAppMode = loadAdmAppMode;
window.toggleAppMode = toggleAppMode;
window.openSubOverrideModal = openSubOverrideModal;
window.closeSubOverrideModal = closeSubOverrideModal;
window.applySubOverride = applySubOverride;
window.extendSubTrial = extendSubTrial;
window.resetSubToTrial = resetSubToTrial;
window.enablePremiumAddon = enablePremiumAddon;
window.disablePremiumAddon = disablePremiumAddon;
