/* ════════════════════════════════════════════════════════════════════════
   ngap-correction-hints.js — AMI v1.0
   ────────────────────────────────────────────────────────────────────────
   Hook côté INFIRMIÈRE qui affiche les suggestions de correction NGAP
   envoyées par l'admin (via le bouton "🔧 Corriger automatiquement").
   
   Les suggestions arrivent sous forme de messages dans contact_messages
   avec categorie='ngap_correction'. L'infirmière peut :
     • Voir le détail : codes actuels, codes suggérés, gain potentiel
     • Accepter  → l'infirmière corrigera elle-même sa cotation dans l'historique
     • Refuser   → message archivé
   
   Fonctions globales exposées :
     • loadNgapHints()       — charge les suggestions non-traitées
     • renderNgapHintsBadge  — badge dans le dashboard (compteur)
     • ngapHintAction(id,action) — accepter/refuser une suggestion
   
   Dépendances : wpost (global), S/APP pour détecter le rôle infirmière
═══════════════════════════════════════════════════════════════════════ */

(function(){
'use strict';

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ── Gardes : ce module ne tourne QUE pour les infirmières connectées ── */
function _isNurse() {
  if (typeof S === 'undefined' || !S || !S.user) return false;
  if (S.role === 'admin') return false;
  return true;
}

/* ── Charger les suggestions pending depuis contact_messages ── */
async function _loadPendingHints() {
  // Gardes : module infirmière uniquement + wpost disponible
  if (!_isNurse() || typeof wpost !== 'function') return [];
  try {
    const d = await wpost('/webhook/contact-mes-messages', {});
    if (!d || !d.ok) return [];
    const all = Array.isArray(d.messages) ? d.messages : [];
    return all.filter(m => m.categorie === 'ngap_correction' && m.status === 'sent');
  } catch(e) {
    // Session expirée / non connecté : silencieux (pas de pollution console)
    const msg = String(e.message || '');
    if (msg.includes('Session') || msg.includes('401') || msg.includes('403') || msg.includes('Accès')) return [];
    console.warn('[ngap-hints] load KO:', msg);
    return [];
  }
}

/* ── Rendre le badge dans le dashboard ── */
async function renderNgapHintsBadge(containerId) {
  const el = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
  if (!el) return;

  const hints = await _loadPendingHints();
  if (hints.length === 0) {
    el.innerHTML = '';  // rien à afficher
    return;
  }

  const totalGain = hints.reduce((sum, h) => {
    const m = (h.message || '').match(/\+([\d.,]+)\s*€/);
    return sum + (m ? parseFloat(m[1].replace(',', '.')) : 0);
  }, 0);

  el.innerHTML = `
    <div style="padding:12px 16px;margin-bottom:14px;background:linear-gradient(135deg,rgba(0,212,170,.08),rgba(79,168,255,.04));border:1px solid rgba(0,212,170,.3);border-radius:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="font-size:22px;flex-shrink:0">💡</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;color:#00d4aa;margin-bottom:2px">
          ${hints.length} suggestion${hints.length > 1 ? 's' : ''} de correction disponible${hints.length > 1 ? 's' : ''}
        </div>
        <div style="font-size:11px;color:var(--m);line-height:1.4">
          Gain potentiel : <strong style="color:#00d4aa">+${totalGain.toFixed(2)} €</strong> · Proposées par l'équipe AMI (aucune donnée patient n'a été transmise).
        </div>
      </div>
      <button class="btn bp bsm" onclick="openNgapHintsModal()" style="font-size:12px;white-space:nowrap">Voir les détails</button>
    </div>
  `;
}

/* ── Ouvrir la modale détaillée avec toutes les suggestions ── */
window.openNgapHintsModal = async function() {
  const hints = await _loadPendingHints();
  if (hints.length === 0) {
    if (typeof showToast === 'function') showToast('info', 'Aucune suggestion', 'Plus rien à traiter.');
    return;
  }

  // Construire la modale
  let modal = document.getElementById('ngap-hints-modal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'ngap-hints-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:var(--c);border:1px solid var(--b);border-radius:16px;max-width:700px;width:100%;max-height:85vh;overflow:hidden;display:flex;flex-direction:column">
      <div style="padding:16px 20px;border-bottom:1px solid var(--b);display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div style="font-size:16px;font-weight:700;color:var(--t)">💡 Suggestions de correction AMI</div>
          <div style="font-size:11px;color:var(--m);margin-top:2px">${hints.length} proposition(s) en attente</div>
        </div>
        <button onclick="document.getElementById('ngap-hints-modal').remove()" style="background:var(--ad,#0f172a);border:1px solid var(--b);color:var(--t);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:16px">✕</button>
      </div>
      <div style="overflow-y:auto;padding:14px 20px;flex:1" id="ngap-hints-list">
        ${hints.map(h => _renderHintCard(h)).join('')}
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--b);font-size:11px;color:var(--m);text-align:center;background:var(--ad,#0f172a)">
        🔒 Aucune donnée patient n'a été transmise à l'administrateur. Les suggestions sont basées uniquement sur les codes NGAP.
      </div>
    </div>
  `;
  document.body.appendChild(modal);
};

function _renderHintCard(h) {
  const lines = (h.message || '').split('\n').filter(Boolean);
  // Parser les infos clés de la description
  const invoice = (h.message.match(/#(F\d{4}-[A-Z0-9]+-\d+)/) || [])[1] || null;
  const codesAct = (h.message.match(/Codes actuels\s*:\s*([^\n]+)/) || [])[1] || '—';
  const codesOpt = (h.message.match(/Codes suggérés\s*:\s*([^\n]+)/) || [])[1] || '—';
  const gainMatch = h.message.match(/\+([\d.,]+)\s*€/);
  const gain = gainMatch ? parseFloat(gainMatch[1].replace(',', '.')) : 0;
  const dt = h.created_at ? new Date(h.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'short', year:'numeric' }) : '';

  return `
    <div style="padding:14px;margin-bottom:10px;background:var(--ad,#0f172a);border:1px solid var(--b);border-radius:10px" data-hint-id="${_esc(h.id)}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px;flex-wrap:wrap">
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--t)">
            ${invoice ? `Facture <code style="background:rgba(79,168,255,.15);color:#4fa8ff;padding:2px 7px;border-radius:4px;font-family:var(--fm);font-size:11px">${_esc(invoice)}</code>` : _esc(h.sujet)}
          </div>
          <div style="font-size:11px;color:var(--m);margin-top:2px">Proposé le ${dt}</div>
        </div>
        <div style="font-family:var(--fm);font-weight:700;color:#00d4aa;font-size:16px;white-space:nowrap">+${gain.toFixed(2)} €</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;padding:10px;background:var(--c);border-radius:8px;margin-bottom:10px">
        <div>
          <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-bottom:3px">ACTUEL</div>
          <div style="font-size:12px;font-weight:600;color:#f59e0b">${_esc(codesAct)}</div>
        </div>
        <div style="font-size:18px;color:var(--m)">→</div>
        <div>
          <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-bottom:3px">SUGGÉRÉ</div>
          <div style="font-size:12px;font-weight:600;color:#00d4aa">${_esc(codesOpt)}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn bp bsm" onclick="ngapHintAction('${_esc(h.id)}','accept')" style="flex:1;min-width:140px;background:#00d4aa;color:#fff;font-size:12px">
          ✅ Accepter
        </button>
        <button class="btn bs bsm" onclick="ngapHintAction('${_esc(h.id)}','reject')" style="flex:1;min-width:140px;font-size:12px">
          ✕ Refuser
        </button>
      </div>
      <div style="font-size:10px;color:var(--m);margin-top:8px;line-height:1.4;font-style:italic">
        💡 En acceptant, vous confirmez l'intention de corriger. Rendez-vous dans votre historique pour modifier la facture (la signature FSE reste sous votre contrôle).
      </div>
    </div>
  `;
}

/* ── Accepter/refuser une suggestion ── */
window.ngapHintAction = async function(msgId, action) {
  if (!msgId || !['accept','reject'].includes(action)) return;
  try {
    const d = await wpost('/webhook/ngap-correction-action', { message_id: msgId, action });
    if (!d || !d.ok) throw new Error(d?.error || 'Action impossible');

    // Retirer visuellement la carte
    const card = document.querySelector(`[data-hint-id="${CSS.escape(msgId)}"]`);
    if (card) {
      card.style.opacity = '.4';
      card.style.pointerEvents = 'none';
      const replacement = document.createElement('div');
      replacement.style.cssText = 'padding:10px 14px;margin-bottom:10px;background:var(--ad,#0f172a);border:1px dashed var(--b);border-radius:10px;text-align:center;font-size:12px;color:var(--m)';
      replacement.textContent = action === 'accept' ? '✅ Acceptée — rendez-vous dans votre historique pour corriger la facture.' : '✕ Refusée.';
      card.parentNode.insertBefore(replacement, card.nextSibling);
      setTimeout(() => { card.remove(); }, 400);
    }

    // Actualiser le badge global
    setTimeout(() => { if (typeof renderNgapHintsBadge === 'function') renderNgapHintsBadge('ngap-hints-badge'); }, 800);

    if (typeof showToast === 'function') {
      if (action === 'accept') showToast('success', 'Suggestion acceptée', 'Corrigez la facture dans votre historique.');
      else                     showToast('info',    'Suggestion refusée', 'Message archivé.');
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast('error', 'Action KO', e.message);
    console.warn('[ngap-hint-action]', e);
  }
};

/* ── Exposer pour usage extérieur ── */
window.renderNgapHintsBadge = renderNgapHintsBadge;
window.loadNgapHints        = _loadPendingHints;

/* ── Auto-init : afficher le badge dans le dashboard si présent (infirmière uniquement) ── */
function _autoInit() {
  if (!_isNurse()) return;  // skip silencieux en admin ou non connecté
  const target = document.getElementById('ngap-hints-badge');
  if (target) renderNgapHintsBadge(target);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _autoInit);
} else {
  setTimeout(_autoInit, 100);
}
// Aussi : recharger quand l'infirmière se connecte ou navigue
document.addEventListener('ami:login', () => setTimeout(_autoInit, 500));
document.addEventListener('ui:navigate', (e) => {
  if (e.detail && (e.detail.view === 'das' || e.detail.view === 'his')) setTimeout(_autoInit, 200);
});

console.info('[NGAP-Hints] v1.0 prêt');
})();
