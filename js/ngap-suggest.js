/* ════════════════════════════════════════════════════════════════
   ngap-suggest.js — AMI NGAP v1.0
   ────────────────────────────────────────────────────────────────
   Workflow infirmière → suggestion → admin
   Fonctions exposées :
     - ngapSuggestSubmit()   → envoie le textarea
     - ngapSuggestLoadMy()   → charge l'historique de l'infirmière
   Backend :
     POST /webhook/ngap-suggest-submit
     GET  /webhook/ngap-suggest-my
   Dépendances : utils.js (wpost, $), ui.js (showToast)
════════════════════════════════════════════════════════════════ */

(function(){
'use strict';

function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function _toast(t,h,m){if(typeof showToast==='function')showToast(t,h,m);}
function _fmtDate(iso){try{return new Date(iso).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}catch(e){return iso||'—';}}

window.ngapSuggestSubmit = async function() {
  const inp = document.getElementById('ngap-sugg-input');
  const cmt = document.getElementById('ngap-sugg-comment');
  const status = document.getElementById('ngap-sugg-status');
  const fb = document.getElementById('ngap-sugg-feedback');
  if (!inp || !fb) return;

  const instruction = (inp.value || '').trim();
  const comment = (cmt ? cmt.value : '').trim();

  if (instruction.length < 3) {
    _toast('warn', 'Suggestion trop courte', 'Au moins 3 caractères.');
    return;
  }

  if (status) status.textContent = '⏳ Envoi en cours…';
  fb.innerHTML = '';

  try {
    const d = await wpost('/webhook/ngap-suggest-submit', { instruction, comment });
    if (!d.ok) throw new Error(d.error || 'Envoi échoué');

    if (status) status.textContent = '';
    inp.value = '';
    if (cmt) cmt.value = '';

    // Affichage du retour : parse OK ? doublon ? commentaire libre ?
    const src = d.parse_source || 'unparseable';
    const dup = d.duplicate_check || {};
    let badgeColor = '#10b981', badgeText = '✅ Suggestion enregistrée';
    let detail = '';

    if (src === 'comment') {
      badgeColor = '#4fa8ff';
      badgeText = '💬 Enregistré comme commentaire';
      detail = 'L\'admin lira votre message et y répondra.';
    } else if (d.parsed_patch && dup.exists) {
      if (dup.same_value) {
        badgeColor = '#6b7280';
        badgeText = 'ℹ️ Règle déjà présente';
        detail = 'Cette règle est déjà dans le référentiel avec la même valeur. Votre suggestion sera quand même visible par l\'admin.';
      } else {
        badgeColor = '#f59e0b';
        badgeText = '✏️ Règle existe avec valeur différente';
        detail = `L'admin verra que la règle existe déjà (valeur actuelle : ${JSON.stringify(dup.current).slice(0, 80)}) et pourra l\'éditer.`;
      }
    } else if (d.parsed_patch) {
      detail = 'L\'admin va examiner et appliquer si validée.';
    } else {
      badgeColor = '#f59e0b';
      badgeText = '⚠️ Suggestion non parsée';
      detail = 'L\'instruction n\'a pas pu être interprétée automatiquement. L\'admin la traitera manuellement.';
    }

    fb.innerHTML = `
      <div style="padding:12px;background:rgba(${badgeColor === '#10b981' ? '16,185,129' : (badgeColor === '#f59e0b' ? '245,158,11' : (badgeColor === '#4fa8ff' ? '79,168,255' : '107,114,128'))},.08);border:1px solid ${badgeColor}55;border-radius:8px">
        <div style="font-weight:600;color:${badgeColor};margin-bottom:4px">${badgeText}</div>
        <div style="font-size:12px;color:var(--t);line-height:1.5">${_esc(detail)}</div>
      </div>`;

    // Recharger l'historique automatiquement
    setTimeout(() => window.ngapSuggestLoadMy(), 300);
  } catch(e) {
    if (status) status.textContent = '';
    fb.innerHTML = `<div class="ai er">⚠️ ${_esc(e.message)}</div>`;
  }
};

window.ngapSuggestLoadMy = async function() {
  const list = document.getElementById('ngap-sugg-my-list');
  if (!list) return;
  list.innerHTML = '<div class="empty" style="padding:20px 0"><div class="spin spinw" style="width:20px;height:20px;margin:0 auto"></div></div>';

  try {
    const d = await wpost('/webhook/ngap-suggest-my', {});
    if (!d.ok) throw new Error(d.error || 'Chargement échoué');
    const arr = Array.isArray(d.suggestions) ? d.suggestions : [];

    if (arr.length === 0) {
      list.innerHTML = '<div class="empty" style="padding:20px 0;font-size:12px;color:var(--m);text-align:center">Aucune suggestion pour le moment. Envoyez votre première !</div>';
      return;
    }

    const statusBadge = (s) => {
      const map = {
        pending:  ['#f59e0b', '⏳ En attente'],
        applied:  ['#10b981', '✅ Appliquée'],
        edited:   ['#4fa8ff', '✏️ Appliquée (éditée par admin)'],
        rejected: ['#ef4444', '🗑️ Rejetée']
      };
      const [c, t] = map[s] || ['#6b7280', s || '?'];
      return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;background:${c};color:#fff;font-size:10px;font-family:var(--fm);letter-spacing:.5px">${t}</span>`;
    };

    list.innerHTML = arr.map(s => `
      <div style="padding:10px 12px;background:var(--ad,#0f172a);border:1px solid var(--b);border-radius:8px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:10px;flex-wrap:wrap">
          <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${_fmtDate(s.created_at)}</div>
          ${statusBadge(s.status)}
        </div>
        <div style="font-size:13px;color:var(--t);line-height:1.5;margin-bottom:4px">${_esc(s.raw_instruction)}</div>
        ${s.parse_source && s.parse_source !== 'comment' ? `<div style="font-size:10px;color:var(--m);margin-top:4px">Méthode : ${s.parse_source === 'regex' ? '🔧 regex' : (s.parse_source === 'llm' ? '🤖 IA' : '⚠️ non parsée')}</div>` : ''}
        ${s.admin_decision && (s.status === 'rejected' || s.status === 'edited') ? `
          <div style="margin-top:6px;padding:6px 8px;background:rgba(${s.status === 'rejected' ? '239,68,68' : '79,168,255'},.06);border-left:2px solid ${s.status === 'rejected' ? '#ef4444' : '#4fa8ff'};border-radius:4px;font-size:11px;color:var(--t);line-height:1.4">
            <strong>${s.status === 'rejected' ? 'Raison du rejet' : 'Décision admin'} :</strong> ${_esc(s.admin_decision)}
          </div>` : ''}
      </div>
    `).join('');
  } catch(e) {
    list.innerHTML = `<div class="ai er">⚠️ ${_esc(e.message)}</div>`;
  }
};

// Auto-load au premier affichage de l'onglet (si dispo)
document.addEventListener('ui:navigate', (e) => {
  if (e.detail && e.detail.view === 'ngap-ref') {
    setTimeout(() => { if (typeof window.ngapSuggestLoadMy === 'function') window.ngapSuggestLoadMy(); }, 200);
  }
});

})();
