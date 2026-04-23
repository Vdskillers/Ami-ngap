/* ═══════════════════════════════════════════════════════════════════════
   notif-messages.js — AMI v1.0
   ───────────────────────────────────────────────────────────────────────
   Enrichit le panneau de notifications (#notif-panel) pour afficher :
     • ONGLET "Alertes"    — les toasts récents (comportement existant)
     • ONGLET "Messages"   — échanges Contact Administrateur + suggestions NGAP
   
   Côté infirmière     → /webhook/contact-mes-messages (ses propres messages)
   Côté admin          → /webhook/admin-messages      (tous les messages reçus)
   
   Compatible avec le système existant (ne casse pas showToast ni les toasts).
═══════════════════════════════════════════════════════════════════════ */

(function(){
'use strict';

const POLL_MS = 60_000; // rafraîchir toutes les 60s

let _currentTab     = 'notif';  // 'notif' ou 'msg'
let _cachedMessages = [];
let _lastPoll       = 0;

function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function _isAdmin(){ return (typeof S !== 'undefined' && S?.role === 'admin'); }

/* ── Chargement des messages Contact Admin ── */
async function _fetchMessages() {
  if (typeof wpost !== 'function') return [];
  // Cache simple : ne pas re-poll si < 10s
  if (Date.now() - _lastPoll < 10_000 && _cachedMessages.length) return _cachedMessages;
  try {
    const route = _isAdmin() ? '/webhook/admin-messages' : '/webhook/contact-mes-messages';
    const d = await wpost(route, {});
    if (!d || !d.ok) return [];
    _cachedMessages = Array.isArray(d.messages) ? d.messages : [];
    _lastPoll = Date.now();
    return _cachedMessages;
  } catch(e) {
    console.warn('[notif-messages] fetch KO:', e.message);
    return [];
  }
}

/* ── Compteur des messages non lus (pour le dot rouge) ── */
async function _unreadCount() {
  const msgs = await _fetchMessages();
  if (_isAdmin()) {
    // Admin : status==='sent' = non lu
    return msgs.filter(m => m.status === 'sent').length;
  } else {
    // Infirmière : messages avec réponse admin non lue (replied_at > lu_par_infirmiere)
    // OU suggestions NGAP pending (categorie='ngap_correction' + status='sent')
    const ngapPending = msgs.filter(m => m.categorie === 'ngap_correction' && m.status === 'sent').length;
    const newReplies  = msgs.filter(m => m.status === 'replied' && !m._read_by_nurse).length;
    return ngapPending + newReplies;
  }
}

/* ── HTML d'un message (compatible infirmière + admin) ── */
function _renderMessage(m) {
  const dt = m.created_at ? new Date(m.created_at).toLocaleString('fr-FR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
  const catIcon = {
    bug:              '🐛',
    amelioration:     '💡',
    question:         '❓',
    ngap:             '⚖️',
    ngap_correction:  '🔧',
    autre:            '💬',
  }[m.categorie] || '💬';
  const catColor = {
    bug:              '#ef4444',
    amelioration:     '#4fa8ff',
    question:         '#a78bfa',
    ngap:             '#00d4aa',
    ngap_correction:  '#00d4aa',
    autre:            'var(--m)',
  }[m.categorie] || 'var(--m)';

  const statusBadge = {
    sent:     '<span style="font-size:9px;padding:2px 6px;background:rgba(245,158,11,.15);color:#f59e0b;border-radius:4px;font-family:var(--fm)">EN ATTENTE</span>',
    read:     '<span style="font-size:9px;padding:2px 6px;background:rgba(79,168,255,.15);color:#4fa8ff;border-radius:4px;font-family:var(--fm)">LU</span>',
    replied:  '<span style="font-size:9px;padding:2px 6px;background:rgba(0,212,170,.15);color:#00d4aa;border-radius:4px;font-family:var(--fm)">RÉPONDU</span>',
    accepted: '<span style="font-size:9px;padding:2px 6px;background:rgba(0,212,170,.15);color:#00d4aa;border-radius:4px;font-family:var(--fm)">ACCEPTÉE</span>',
    rejected: '<span style="font-size:9px;padding:2px 6px;background:rgba(107,114,128,.15);color:var(--m);border-radius:4px;font-family:var(--fm)">REFUSÉE</span>',
  }[m.status] || '';

  // Nom/prénom : pour admin on affiche l'infirmière qui a envoyé
  const from = _isAdmin() && (m.infirmiere_nom || m.infirmiere_prenom)
    ? `${_esc((m.infirmiere_prenom || '') + ' ' + (m.infirmiere_nom || '')).trim()} · `
    : '';

  const replies = Array.isArray(m.replies) ? m.replies : [];
  const lastReply = replies.length ? replies[replies.length - 1] : (m.reply_message ? { message: m.reply_message, at: m.replied_at } : null);

  // Action spéciale pour ngap_correction côté infirmière
  const isNgapCorr = m.categorie === 'ngap_correction' && !_isAdmin() && m.status === 'sent';

  return `
    <div style="padding:12px 14px;border-bottom:1px solid rgba(30,45,61,.5)">
      <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:4px">
        <span style="font-size:16px;flex-shrink:0;width:20px;text-align:center">${catIcon}</span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;flex-wrap:wrap">
            <div style="font-size:12px;font-weight:600;color:${catColor};line-height:1.3">${_esc(m.sujet || '(sans sujet)')}</div>
            ${statusBadge}
          </div>
          <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-top:2px">${from}${dt}</div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--t);line-height:1.5;margin:6px 0 0 30px;white-space:pre-line">${_esc((m.message || '').slice(0, 300))}${(m.message || '').length > 300 ? '…' : ''}</div>
      ${lastReply ? `
        <div style="margin:8px 0 0 30px;padding:8px 10px;background:rgba(0,212,170,.04);border-left:2px solid #00d4aa;border-radius:0 6px 6px 0">
          <div style="font-size:9px;color:#00d4aa;font-family:var(--fm);letter-spacing:.5px;margin-bottom:2px">RÉPONSE ADMIN</div>
          <div style="font-size:11px;color:var(--t);line-height:1.4;white-space:pre-line">${_esc(String(lastReply.message || '').slice(0, 250))}</div>
        </div>
      ` : ''}
      ${isNgapCorr ? `
        <div style="margin:8px 0 0 30px;display:flex;gap:6px">
          <button class="btn bp bsm" onclick="event.stopPropagation();ngapHintAction('${_esc(m.id)}','accept')" style="flex:1;font-size:11px;padding:4px 8px">✅ Accepter</button>
          <button class="btn bs bsm" onclick="event.stopPropagation();ngapHintAction('${_esc(m.id)}','reject')" style="flex:1;font-size:11px;padding:4px 8px">✕ Refuser</button>
        </div>
      ` : ''}
    </div>`;
}

/* ── Réécriture du panel avec onglets ── */
function _rewriteNotifPanel() {
  const panel = document.getElementById('notif-panel');
  if (!panel || panel.dataset.enriched === '1') return;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--b)">
      <div style="font-family:var(--fm);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--m)">Centre de notifications</div>
      <button onclick="clearAllNotifs()" style="background:none;border:none;color:var(--m);font-size:10px;font-family:var(--fm);cursor:pointer;transition:color .15s" onmouseenter="this.style.color='var(--t)'" onmouseleave="this.style.color='var(--m)'">Tout effacer</button>
    </div>
    <div style="display:flex;border-bottom:1px solid var(--b);background:var(--ad,#0f172a)">
      <button id="notif-tab-notif" onclick="window._switchNotifTab('notif')" style="flex:1;padding:10px;background:none;border:none;border-bottom:2px solid #00d4aa;color:var(--t);font-size:11px;font-family:var(--fm);cursor:pointer;transition:all .15s">
        🔔 Alertes <span id="notif-tab-count-notif" style="font-size:9px;color:var(--m);margin-left:4px"></span>
      </button>
      <button id="notif-tab-msg" onclick="window._switchNotifTab('msg')" style="flex:1;padding:10px;background:none;border:none;border-bottom:2px solid transparent;color:var(--m);font-size:11px;font-family:var(--fm);cursor:pointer;transition:all .15s">
        💬 Messages <span id="notif-tab-count-msg" style="font-size:9px;color:#ef4444;margin-left:4px"></span>
      </button>
    </div>
    <div id="notif-list" style="max-height:400px;overflow-y:auto"></div>
    <div style="padding:8px 14px;border-top:1px solid var(--b);text-align:center;font-size:10px;color:var(--m);background:var(--ad,#0f172a)">
      ${_isAdmin() 
        ? '<a href="#" onclick="navTo(\'admin\',null);setTimeout(()=>document.querySelector(\'[data-tab=\\\'messages\\\']\')?.click(),200);toggleNotifPanel();return false" style="color:#4fa8ff;text-decoration:none">Ouvrir la messagerie complète →</a>'
        : '<a href="#" onclick="navTo(\'contact\',null);toggleNotifPanel();return false" style="color:#4fa8ff;text-decoration:none">Ouvrir la messagerie complète →</a>'}
    </div>
  `;
  panel.dataset.enriched = '1';
}

/* ── Switch d'onglet ── */
window._switchNotifTab = function(tab) {
  _currentTab = tab;
  const tN = document.getElementById('notif-tab-notif');
  const tM = document.getElementById('notif-tab-msg');
  if (tN) {
    tN.style.color = tab === 'notif' ? 'var(--t)' : 'var(--m)';
    tN.style.borderBottomColor = tab === 'notif' ? '#00d4aa' : 'transparent';
  }
  if (tM) {
    tM.style.color = tab === 'msg' ? 'var(--t)' : 'var(--m)';
    tM.style.borderBottomColor = tab === 'msg' ? '#00d4aa' : 'transparent';
  }
  _renderActiveTab();
};

/* ── Rendu du contenu actif (appelé après switch ou ouverture) ── */
async function _renderActiveTab() {
  const list = document.getElementById('notif-list');
  if (!list) return;

  if (_currentTab === 'notif') {
    // Alertes : utiliser _notifs existant (variable globale du index.html)
    const notifs = window._notifs || [];
    const countN = document.getElementById('notif-tab-count-notif');
    if (countN) countN.textContent = notifs.length ? `(${notifs.length})` : '';
    if (notifs.length === 0) {
      list.innerHTML = '<div style="padding:36px 24px;text-align:center;color:var(--m);font-size:12px"><div style="font-size:28px;margin-bottom:10px;opacity:.4">🔔</div>Aucune alerte récente</div>';
      return;
    }
    const colors = { success: 'var(--ok,#00d4aa)', warning: 'var(--w,#f59e0b)', error: 'var(--d,#ef4444)', info: 'var(--a2,#4fa8ff)' };
    list.innerHTML = notifs.slice(0, 20).map((n, i) => `
      <div style="display:flex;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(30,45,61,.5);${i===0?'background:rgba(0,212,170,.02)':''}">
        <div style="width:3px;border-radius:3px;background:${colors[n.type]||'var(--m)'};flex-shrink:0;align-self:stretch"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:${colors[n.type]||'var(--t)'};margin-bottom:2px">${_esc(n.title || '')}</div>
          ${n.msg ? `<div style="font-size:11px;color:var(--m);line-height:1.4">${_esc(n.msg)}</div>` : ''}
          <div style="font-size:10px;color:var(--m);margin-top:4px;font-family:var(--fm)">${new Date(n.time).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</div>
        </div>
      </div>`).join('');
  } else {
    // Messages Contact Admin
    list.innerHTML = '<div style="padding:36px 24px;text-align:center;color:var(--m);font-size:12px">Chargement…</div>';
    const msgs = await _fetchMessages();
    // Trier par date décroissante
    msgs.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const countM = document.getElementById('notif-tab-count-msg');
    const unread = await _unreadCount();
    if (countM) countM.textContent = unread > 0 ? `(${unread})` : '';
    if (msgs.length === 0) {
      list.innerHTML = `<div style="padding:36px 24px;text-align:center;color:var(--m);font-size:12px">
        <div style="font-size:28px;margin-bottom:10px;opacity:.4">💬</div>
        Aucun message
        ${!_isAdmin() ? '<div style="font-size:11px;margin-top:8px">Contactez un administrateur depuis la page <a href="#" onclick="navTo(\'contact\',null);toggleNotifPanel();return false" style="color:#4fa8ff;text-decoration:none">Contact</a></div>' : ''}
      </div>`;
      return;
    }
    list.innerHTML = msgs.slice(0, 20).map(_renderMessage).join('');
  }
}

/* ── Hook sur toggleNotifPanel existant ── */
const _origToggle = window.toggleNotifPanel;
window.toggleNotifPanel = function() {
  _rewriteNotifPanel(); // 1. enrichir si pas déjà fait
  // 2. appeler l'ouverture/fermeture d'origine
  if (typeof _origToggle === 'function') {
    _origToggle();
  } else {
    const panel = document.getElementById('notif-panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }
  // 3. quand on ouvre, rendre l'onglet actif
  const panel = document.getElementById('notif-panel');
  if (panel && panel.style.display !== 'none') {
    _renderActiveTab();
    // Réinitialiser le dot rouge (géré par existant)
  }
};

/* ── Polling périodique pour mettre à jour le badge ── */
async function _updateBadge() {
  const dot = document.getElementById('top-notif-dot');
  if (!dot) return;
  const unread = await _unreadCount();
  const hasNotifs = (window._notifs || []).length > 0;
  if (unread > 0 || hasNotifs) {
    dot.classList.add('show');
  }
}

/* ── Auto-init au login + polling ── */
function _autoInit() {
  setTimeout(() => {
    _updateBadge();
    setInterval(_updateBadge, POLL_MS);
  }, 2000);
}
document.addEventListener('ami:login', _autoInit);
if (typeof S !== 'undefined' && S?.user) _autoInit();

console.info('[notif-messages] v1.0 prêt — cloche enrichie avec messages Contact Admin');
})();
