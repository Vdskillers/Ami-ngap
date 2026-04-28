/* ════════════════════════════════════════════════
   contact.js — AMI NGAP
   ────────────────────────────────────────────────
   Messagerie infirmière → admin
   - sendContactMessage() — envoi d'un message
   - loadMyMessages()     — historique nurse
   - loadAdmMessages()    — lecture admin (dans admin.js)
   - markMessageRead()    — marquer lu (admin)
   - replyToMessage()     — réponse admin (dans admin.js)
════════════════════════════════════════════════ */

/* ── Compteur de caractères ──────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('contact-msg');
  const counter = document.getElementById('contact-count');
  if (ta && counter) {
    ta.addEventListener('input', () => {
      counter.textContent = ta.value.length;
      counter.style.color = ta.value.length > 1800 ? 'var(--d)' : 'var(--m)';
    });
  }
});

/* ════════════════════════════════════════════════
   ENVOI MESSAGE (infirmière → admin)
════════════════════════════════════════════════ */
async function sendContactMessage() {
  const sujet = (document.getElementById('contact-sujet')?.value || '').trim();
  const msg   = (document.getElementById('contact-msg')?.value || '').trim();
  const cat   = document.getElementById('contact-cat')?.value || 'autre';

  if (!sujet) { _contactErr('Veuillez renseigner un sujet.'); return; }
  if (msg.length < 10) { _contactErr('Le message est trop court (minimum 10 caractères).'); return; }

  ld('btn-contact-send', true);
  _contactErr('');
  _contactOk('');

  try {
    const d = await apiCall('/webhook/contact-send', { sujet, message: msg, categorie: cat });
    if (!d.ok) throw new Error(d.error || 'Erreur lors de l\'envoi');
    _contactOk('✅ Message envoyé ! L\'équipe vous répondra dès que possible.');
    // Réinitialiser
    if (document.getElementById('contact-sujet')) document.getElementById('contact-sujet').value = '';
    if (document.getElementById('contact-msg'))   document.getElementById('contact-msg').value   = '';
    if (document.getElementById('contact-count')) document.getElementById('contact-count').textContent = '0';
    // Recharger l'historique
    setTimeout(() => loadMyMessages(), 600);
  } catch (e) {
    _contactErr('❌ ' + e.message);
  }
  ld('btn-contact-send', false);
}

/* ════════════════════════════════════════════════
   CHARGEMENT MESSAGES NURSE
════════════════════════════════════════════════ */
async function loadMyMessages() {
  const el = document.getElementById('contact-history');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:20px"><div class="spin spinw" style="width:24px;height:24px;margin:0 auto"></div></div>';
  try {
    const d = await apiCall('/webhook/contact-mes-messages', {});
    if (!d.ok) throw new Error(d.error || 'Erreur');
    _renderMyMessages(d.messages || []);
  } catch (e) {
    el.innerHTML = `<div class="ai er" style="margin:0">⚠️ ${e.message}</div>`;
  }
}

function _renderMyMessages(messages) {
  const el = document.getElementById('contact-history');
  if (!el) return;

  if (!messages.length) {
    el.innerHTML = '<div class="empty" style="padding:24px 0"><div class="ei" style="font-size:32px">📭</div><p style="margin-top:8px;color:var(--m);font-size:13px">Aucun message envoyé pour l\'instant.<br>Utilisez le formulaire ci-dessus pour contacter l\'administration.</p></div>';
    return;
  }

  const catLabel  = { bug:'🐛 Bug', amelioration:'💡 Amélioration', question:'❓ Question', ngap:'📋 Cotation NGAP', ngap_correction:'🔧 Suggestion AMI', ngap_auto_applied:'✅ Correction auto', autre:'📩 Autre' };
  const catColors = { bug:'var(--d)', amelioration:'#f59e0b', question:'var(--a)', ngap:'#8b5cf6', ngap_correction:'#00d4aa', ngap_auto_applied:'#10b981', autre:'var(--m)' };

  el.innerHTML = messages.map(m => {
    const date    = new Date(m.created_at).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });

    // Reconstruction du fil de réponses (rétro-compat : replies[] moderne ou reply_message unique)
    let thread = [];
    if (Array.isArray(m.replies) && m.replies.length) {
      thread = m.replies.map(r => ({
        message: String(r.message || r.text || ''),
        at: r.at || r.created_at || m.replied_at
      })).filter(r => r.message);
    } else if (m.reply_message) {
      thread = [{ message: m.reply_message, at: m.replied_at || m.updated_at }];
    }

    const replyCount = thread.length;
    const statut  = m.status === 'replied' ? `<span style="color:#00d4aa;font-size:11px;font-family:var(--fm)">✅ ${replyCount>1?replyCount+' réponses':'Répondu'}</span>` :
                    m.status === 'read'    ? '<span style="color:#f59e0b;font-size:11px;font-family:var(--fm)">👁️ Lu</span>' :
                                             '<span style="color:var(--m);font-size:11px;font-family:var(--fm)">📤 Envoyé</span>';

    const replyBloc = thread.length
      ? `<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
           ${thread.map((r, i) => {
             const rd = r.at ? new Date(r.at).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
             return `<div style="padding:12px;background:rgba(0,212,170,.06);border:1px solid rgba(0,212,170,.2);border-radius:8px">
               <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
                 <span style="font-size:11px;color:var(--a);font-family:var(--fm)">💬 ADMIN${thread.length>1?` · RÉPONSE ${i+1}/${thread.length}`:''}</span>
                 ${rd ? `<span style="font-size:10px;color:var(--m);font-family:var(--fm)">${rd}</span>` : ''}
               </div>
               <div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${_autolinkInvoices(_escHtml(r.message))}</div>
             </div>`;
           }).join('')}
         </div>`
      : '';
    return `<div style="border:1px solid var(--b);border-radius:12px;padding:16px;margin-bottom:12px;background:var(--s)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap">
        <div>
          <span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-family:var(--fm);background:rgba(255,255,255,.05);color:${catColors[m.categorie]||'var(--m)'};border:1px solid currentColor;margin-bottom:6px">${catLabel[m.categorie]||m.categorie}</span>
          <div style="font-weight:600;font-size:14px">${_escHtml(m.sujet)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:11px;color:var(--m);font-family:var(--fm);margin-bottom:4px">${date}</div>
          ${statut}
        </div>
      </div>
      <div style="font-size:13px;color:var(--m);line-height:1.6;white-space:pre-wrap">${_autolinkInvoices(_escHtml(_stripMeta(m.message)))}</div>
      ${replyBloc}
      ${_renderMessageActions(m)}
    </div>`;
  }).join('');
}

/* Retire le bloc de métadonnées AMI_META (invisible côté infirmière) */
function _stripMeta(s) {
  if (!s) return '';
  return String(s).replace(/\n*<!--AMI_META:[^]*?-->\n*/g, '').trim();
}

/* ────────────────────────────────────────────────────────────────
   🔗 AUTO-LIEN DES NUMÉROS DE FACTURE
   ────────────────────────────────────────────────────────────────
   Convertit chaque occurrence de F2026-XXXXXX-NNNNNN dans le texte
   échappé en un lien cliquable qui appelle openCotationByInvoice().
   Format géré : F + 4 chiffres + - + 1-8 alphanumériques + - + 4-8 chiffres,
   avec ou sans préfixe `#`. Le préfixe # est conservé hors du lien.
   ⚠️ Doit être appliqué APRÈS _escHtml — la regex ne matche que des
   caractères safe (lettres/chiffres/tirets), pas de risque d'XSS.
──────────────────────────────────────────────────────────────── */
function _autolinkInvoices(html) {
  if (!html) return '';
  return String(html).replace(
    /(#?)(F\d{4}-[A-Z0-9]+-\d{4,8})\b/g,
    (full, prefix, invoice) =>
      `${prefix}<a href="javascript:void(0)" onclick="event.preventDefault();event.stopPropagation();(window.openCotationByInvoice||function(){})('${invoice}')" title="Ouvrir cette cotation dans le carnet patient" style="color:var(--a);font-family:var(--fm);font-weight:600;text-decoration:underline;cursor:pointer">${invoice}</a>`
  );
}

/* Extrait la liste des invoice_numbers présents dans un message
   (utilisé pour ajouter un bouton d'action global "Ouvrir les cotations") */
function _extractInvoiceNumbers(text) {
  if (!text) return [];
  const found = new Set();
  const re = /\bF\d{4}-[A-Z0-9]+-\d{4,8}\b/g;
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[0]);
  return [...found];
}

/* Boutons d'action contextuels selon la catégorie du message */
function _renderMessageActions(m) {
  const actions = [];

  // Suggestion de correction en attente → Accepter / Refuser
  if (m.categorie === 'ngap_correction' && m.status === 'sent') {
    actions.push(`<button class="btn bp bsm" onclick="contactAcceptSuggestion('${_escHtml(m.id)}')" style="background:#00d4aa;color:#fff">✅ Accepter la correction</button>`);
    actions.push(`<button class="btn bs bsm" onclick="contactRejectSuggestion('${_escHtml(m.id)}')">✕ Refuser</button>`);
  }
  // Correction auto déjà appliquée → info seulement, pas d'action
  if (m.categorie === 'ngap_auto_applied' && m.status === 'sent') {
    actions.push(`<span style="font-size:11px;color:#10b981;font-family:var(--fm);padding:6px 12px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:6px">✓ Correction déjà appliquée dans votre historique</span>`);
  }

  // 🔗 Bouton "Ouvrir cotations" pour les messages contenant des numéros de facture
  //    (alertes pending, suggestions, corrections auto). Dispo seulement pour
  //    les catégories "actionnables" pour ne pas polluer les autres conversations.
  const linkableCats = ['ngap_alerts_pending','ngap_correction','ngap_auto_applied'];
  if (linkableCats.includes(m.categorie)) {
    const invoices = _extractInvoiceNumbers(_stripMeta(m.message || ''));
    if (invoices.length === 1) {
      // Une seule cotation → bouton direct
      actions.push(`<button class="btn bs bsm" onclick="(window.openCotationByInvoice||function(){})('${invoices[0]}')" title="Ouvrir la cotation ${invoices[0]} dans le carnet patient" style="color:var(--a);border-color:rgba(0,212,170,.3);background:rgba(0,212,170,.06)">🔗 Ouvrir la cotation</button>`);
    } else if (invoices.length > 1) {
      // Plusieurs → bouton qui ouvre la première et signale qu'il y a un menu
      const ids = invoices.map(i => `'${i}'`).join(',');
      actions.push(`<button class="btn bs bsm" onclick="contactOpenInvoicesMenu([${ids}], event)" title="Choisir parmi ${invoices.length} cotation(s)" style="color:var(--a);border-color:rgba(0,212,170,.3);background:rgba(0,212,170,.06)">🔗 Ouvrir cotation (${invoices.length})</button>`);
    }
  }

  // Bouton supprimer pour TOUS les messages
  actions.push(`<button class="btn bs bsm" onclick="contactDeleteMessage('${_escHtml(m.id)}')" title="Supprimer ce message définitivement" style="color:var(--d)">🗑️ Supprimer</button>`);

  if (actions.length === 0) return '';
  return `
    <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--b);flex-wrap:wrap">
      ${actions.join('')}
    </div>`;
}

/* Ouvre un mini-menu avec la liste des cotations à choisir
   (pour les messages contenant plusieurs numéros de facture) */
window.contactOpenInvoicesMenu = function(invoices, ev) {
  if (!Array.isArray(invoices) || invoices.length === 0) return;
  // Si 1 seule → ouvre direct (sécurité)
  if (invoices.length === 1) {
    if (typeof window.openCotationByInvoice === 'function') window.openCotationByInvoice(invoices[0]);
    return;
  }
  // Sinon : popup léger ancré au bouton
  const btn = ev?.currentTarget || ev?.target;
  // Retire un menu existant
  const existing = document.getElementById('contact-inv-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'contact-inv-menu';
  menu.style.cssText = 'position:absolute;z-index:9999;background:var(--c,#0f172a);border:1px solid var(--b);border-radius:10px;padding:6px;box-shadow:0 12px 28px rgba(0,0,0,.4);max-height:300px;overflow:auto;min-width:240px';
  menu.innerHTML = invoices.map(inv =>
    `<div style="padding:8px 12px;font-family:var(--fm);font-size:12px;cursor:pointer;border-radius:6px;color:var(--a)" onmouseover="this.style.background='rgba(0,212,170,.08)'" onmouseout="this.style.background=''" onclick="document.getElementById('contact-inv-menu')?.remove();(window.openCotationByInvoice||function(){})('${inv}')">🔗 ${inv}</div>`
  ).join('');

  if (btn) {
    const r = btn.getBoundingClientRect();
    menu.style.top  = (window.scrollY + r.bottom + 4) + 'px';
    menu.style.left = (window.scrollX + r.left) + 'px';
  } else {
    menu.style.top  = '50%';
    menu.style.left = '50%';
    menu.style.transform = 'translate(-50%,-50%)';
  }
  document.body.appendChild(menu);
  // Auto-close sur click extérieur
  setTimeout(() => {
    const off = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', off, true);
      }
    };
    document.addEventListener('click', off, true);
  }, 50);
};

/* ──────────────────────────────────────────────────────────────
   ACTIONS SUR LES MESSAGES (Accepter / Refuser / Supprimer)
────────────────────────────────────────────────────────────── */

window.contactAcceptSuggestion = async function(msgId) {
  try {
    const d = await apiCall('/webhook/ngap-correction-action', { message_id: msgId, action: 'accept' });
    if (!d || !d.ok) throw new Error(d?.error || 'Action impossible');

    if (d.applied) {
      // Correction appliquée côté serveur → resync immédiat de l'IDB
      if (typeof syncCotationsFromServer === 'function') {
        try { await syncCotationsFromServer(); } catch(_) {}
      }
      if (typeof showToast === 'function') {
        const gain = d.detail?.gain ? ` (+${Number(d.detail.gain).toFixed(2)} €)` : '';
        showToast('success', 'Correction appliquée' + gain, 'Historique et carnet patient mis à jour.');
      }
    } else {
      // Accept enregistré mais PATCH non appliqué (raison retournée par le serveur)
      const reasons = {
        'meta_absent':          'Message ancien sans métadonnées — à ignorer.',
        'meta_incomplet':       'Métadonnées incomplètes — à ignorer.',
        'cotation_introuvable': 'La cotation concernée a été supprimée.',
        'deja_corrigee':        'Cette cotation a déjà été corrigée par AMI.',
        'deja_equivalente':     'Cette cotation est déjà à jour (rien à changer).',
        'engine_ko':            'Moteur NGAP indisponible — réessayez plus tard.',
        'safety_total_degrade': 'Sécurité : correction annulée (le total aurait diminué).',
        'safety_acte_perdu':    'Sécurité : correction annulée (acte technique manquant).',
        'safety_resultat_court':'Sécurité : correction annulée (résultat incohérent).',
      };
      const humanReason = reasons[d.skip_reason] || 'Aucune modification appliquée.';
      if (typeof showToast === 'function') {
        const isSafety = String(d.skip_reason || '').startsWith('safety_');
        showToast(isSafety ? 'warning' : 'info', 'Suggestion enregistrée', humanReason);
      }
    }
    if (typeof loadMyMessages === 'function') loadMyMessages();
  } catch(e) {
    if (typeof showToast === 'function') showToast('error', 'Erreur', e.message);
  }
};

window.contactRejectSuggestion = async function(msgId) {
  if (!confirm('Refuser cette suggestion de correction ?\n\nElle sera marquée comme refusée dans votre historique.')) return;
  try {
    const d = await apiCall('/webhook/ngap-correction-action', { message_id: msgId, action: 'reject' });
    if (!d || !d.ok) throw new Error(d?.error || 'Action impossible');
    if (typeof showToast === 'function') showToast('info', 'Suggestion refusée', 'Message archivé.');
    if (typeof loadMyMessages === 'function') loadMyMessages();
  } catch(e) {
    if (typeof showToast === 'function') showToast('error', 'Erreur', e.message);
  }
};

window.contactDeleteMessage = async function(msgId) {
  if (!confirm('Supprimer définitivement ce message ?\n\nCette action est irréversible.')) return;
  try {
    const d = await apiCall('/webhook/contact-message-delete', { message_id: msgId });
    if (!d || !d.ok) throw new Error(d?.error || 'Suppression impossible');
    if (typeof showToast === 'function') showToast('success', 'Message supprimé', '');
    if (typeof loadMyMessages === 'function') loadMyMessages();
  } catch(e) {
    if (typeof showToast === 'function') showToast('error', 'Erreur', e.message);
  }
};

/* ════════════════════════════════════════════════
   UTILITAIRES INTERNES
════════════════════════════════════════════════ */
function _contactOk(msg) {
  const el = document.getElementById('contact-ok');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}
function _contactErr(msg) {
  const el = document.getElementById('contact-err');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}
function _escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* Charger les messages quand on navigue vers l'onglet contact */
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('app:nav', e => {
    if (e.detail?.view === 'contact') {
      loadMyMessages();
    }
  });
});
