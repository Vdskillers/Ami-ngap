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
               <div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${_escHtml(r.message)}</div>
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
      <div style="font-size:13px;color:var(--m);line-height:1.6;white-space:pre-wrap">${_escHtml(m.message)}</div>
      ${replyBloc}
    </div>`;
  }).join('');
}

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
