/* ════════════════════════════════════════════════
   copilote.js — AMI NGAP
   ────────────────────────────────────────────────
   Copilote IA intégré — interface chat conversationnelle
   Utilise la route /webhook/ami-copilot du worker
   ✅ Chat persistant (session)
   ✅ Raccourcis questions rapides NGAP
   ✅ Contexte automatique (cotation active, patient)
   ✅ Suggestions proactives
   ✅ Mode vocal (écoute + réponse TTS)
   ✅ Flottant ou section dédiée
════════════════════════════════════════════════ */

const COPILOT_HISTORY_KEY = 'ami_copilot_history';
let _copilotHistory = [];
let _copilotOpen    = false;
let _copilotTyping  = false;

/* ── Charger l'historique de session ── */
function _loadHistory() {
  try {
    _copilotHistory = JSON.parse(sessionStorage.getItem(COPILOT_HISTORY_KEY) || '[]');
  } catch { _copilotHistory = []; }
}
function _saveHistory() {
  try { sessionStorage.setItem(COPILOT_HISTORY_KEY, JSON.stringify(_copilotHistory.slice(-20))); } catch {}
}

/* ════════════════════════════════════════════════
   TOGGLE — bouton flottant
════════════════════════════════════════════════ */
function toggleCopilot() {
  _copilotOpen = !_copilotOpen;
  const panel = document.getElementById('copilot-panel');
  const btn   = document.getElementById('copilot-fab');
  if (!panel) { openCopilotSection(); return; }
  panel.style.display = _copilotOpen ? 'flex' : 'none';
  if (btn) btn.innerHTML = _copilotOpen ? '✕' : '🤖';
  if (_copilotOpen) {
    _renderHistory();
    document.getElementById('copilot-input')?.focus();
  }
}

/* ════════════════════════════════════════════════
   CRÉATION DU PANEL FLOTTANT
════════════════════════════════════════════════ */
function _createCopilotPanel() {
  if (document.getElementById('copilot-panel')) return;

  // Bouton flottant
  const fab = document.createElement('button');
  fab.id = 'copilot-fab';
  fab.innerHTML = '🤖';
  fab.title = 'Copilote IA AMI';
  fab.style.cssText = `
    position:fixed;bottom:90px;right:20px;z-index:900;
    width:52px;height:52px;border-radius:50%;
    background:linear-gradient(135deg,var(--a),var(--a2));
    border:none;cursor:pointer;font-size:22px;
    box-shadow:0 4px 20px rgba(0,212,170,.4);
    transition:all .2s;display:flex;align-items:center;justify-content:center`;
  fab.onclick = toggleCopilot;
  fab.onmouseenter = () => fab.style.transform = 'scale(1.1)';
  fab.onmouseleave = () => fab.style.transform = 'scale(1)';
  document.body.appendChild(fab);

  // Panel chat
  const panel = document.createElement('div');
  panel.id = 'copilot-panel';
  panel.style.cssText = `
    position:fixed;bottom:154px;right:20px;z-index:900;
    width:360px;max-width:calc(100vw - 40px);
    height:480px;max-height:calc(100vh - 200px);
    background:var(--c);border:1px solid var(--b);
    border-radius:20px;box-shadow:0 8px 40px rgba(0,0,0,.6);
    display:none;flex-direction:column;overflow:hidden`;
  panel.innerHTML = `
    <!-- Header -->
    <div style="padding:14px 18px;border-bottom:1px solid var(--b);
      display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
      background:linear-gradient(135deg,rgba(0,212,170,.08),rgba(79,168,255,.05))">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:32px;height:32px;background:linear-gradient(135deg,var(--a),var(--a2));
          border-radius:10px;display:grid;place-items:center;font-size:16px">🤖</div>
        <div>
          <div style="font-size:14px;font-weight:600">Copilote IA</div>
          <div style="font-size:10px;color:var(--a);font-family:var(--fm)">NGAP Expert · Disponible</div>
        </div>
      </div>
      <button onclick="clearCopilotHistory()" title="Effacer l'historique"
        style="background:none;border:none;color:var(--m);cursor:pointer;font-size:13px;padding:4px 8px;
        border-radius:6px;transition:background .15s" onmouseenter="this.style.background='var(--s)'"
        onmouseleave="this.style.background='none'">🗑️</button>
    </div>

    <!-- Messages -->
    <div id="copilot-messages" style="flex:1;overflow-y:auto;padding:14px;display:flex;
      flex-direction:column;gap:10px;scroll-behavior:smooth"></div>

    <!-- Suggestions rapides -->
    <div id="copilot-suggestions" style="padding:8px 14px;border-top:1px solid var(--b);
      display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0"></div>

    <!-- Input -->
    <div style="padding:12px 14px;border-top:1px solid var(--b);flex-shrink:0;
      display:flex;gap:8px;align-items:flex-end">
      <textarea id="copilot-input" placeholder="Posez votre question NGAP…"
        style="flex:1;resize:none;min-height:40px;max-height:100px;
        background:var(--s);border:1px solid var(--b);color:var(--t);
        border-radius:10px;padding:10px 12px;font-size:13px;font-family:var(--ff);
        line-height:1.5;transition:border .15s"
        rows="1"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendCopilotMessage();}"
        oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'">
      </textarea>
      <button onclick="sendCopilotMessage()" id="copilot-send"
        style="background:linear-gradient(135deg,var(--a),#00b891);
        color:#000;border:none;border-radius:10px;padding:10px 14px;
        font-size:16px;cursor:pointer;flex-shrink:0;transition:all .15s"
        onmouseenter="this.style.transform='translateY(-1px)'"
        onmouseleave="this.style.transform='none'">↑</button>
    </div>`;
  document.body.appendChild(panel);

  _loadHistory();
  _renderSuggestions();
  _renderHistory();
}

/* ════════════════════════════════════════════════
   ENVOI DE MESSAGE
════════════════════════════════════════════════ */
async function sendCopilotMessage(text) {
  const input  = document.getElementById('copilot-input');
  const question = text || (input?.value || '').trim();
  if (!question || _copilotTyping) return;

  if (input) { input.value = ''; input.style.height = 'auto'; }

  // Ajouter le message utilisateur
  _copilotHistory.push({ role: 'user', content: question, ts: Date.now() });
  _renderHistory();

  // Cacher suggestions
  const sugg = document.getElementById('copilot-suggestions');
  if (sugg) sugg.style.display = 'none';

  // Indicateur de frappe
  _copilotTyping = true;
  _appendTypingIndicator();

  try {
    // Enrichir la question avec le contexte actuel
    const ctx = _buildContext();
    const fullQuestion = ctx ? `[Contexte: ${ctx}]\n${question}` : question;

    const d = await apiCall('/webhook/ami-copilot', { question: fullQuestion });
    _removeTypingIndicator();

    const answer = d.answer || 'Je n\'ai pas pu répondre à cette question.';
    _copilotHistory.push({ role: 'assistant', content: answer, ts: Date.now() });
    _saveHistory();
    _renderHistory();

    // Réponse vocale optionnelle si voix active
    if (typeof window.safeSpeak === 'function' && answer.length < 200) {
      window.safeSpeak(answer);
    }

  } catch (e) {
    _removeTypingIndicator();
    _copilotHistory.push({
      role: 'error',
      content: '⚠️ ' + (e.message || 'Service temporairement indisponible.'),
      ts: Date.now()
    });
    _renderHistory();
  }

  _copilotTyping = false;
}

/* ── Contexte automatique ── */
function _buildContext() {
  const parts = [];
  const txt = document.getElementById('f-txt')?.value?.trim();
  if (txt) parts.push('Description soin en cours: "' + txt.slice(0, 80) + '"');
  const exo = document.getElementById('f-exo')?.value;
  if (exo) parts.push('Exonération: ' + exo);
  const heure = document.getElementById('f-hs')?.value;
  if (heure) parts.push('Heure soin: ' + heure);
  const user = typeof S !== 'undefined' ? S?.user : null;
  if (user?.nom) parts.push('Infirmière: ' + (user.prenom||'') + ' ' + user.nom);
  return parts.join(' · ') || '';
}

/* ════════════════════════════════════════════════
   RENDU
════════════════════════════════════════════════ */
function _renderHistory() {
  const el = document.getElementById('copilot-messages');
  if (!el) return;

  if (!_copilotHistory.length) {
    el.innerHTML = `
      <div style="text-align:center;padding:20px;color:var(--m)">
        <div style="font-size:32px;margin-bottom:10px">🤖</div>
        <div style="font-size:13px;line-height:1.6">
          Je suis votre copilote NGAP.<br>
          Posez-moi vos questions sur la cotation,<br>
          les règles CPAM, les majorations…
        </div>
      </div>`;
    return;
  }

  el.innerHTML = _copilotHistory.map(msg => {
    if (msg.role === 'user') {
      return `<div style="display:flex;justify-content:flex-end">
        <div style="background:linear-gradient(135deg,var(--a),#00b891);color:#000;
          border-radius:14px 14px 4px 14px;padding:10px 14px;max-width:80%;
          font-size:13px;line-height:1.5">${_esc(msg.content)}</div>
      </div>`;
    }
    if (msg.role === 'error') {
      return `<div style="background:var(--dd);border:1px solid rgba(255,95,109,.3);
        border-radius:10px;padding:10px 14px;font-size:12px;color:var(--d)">${msg.content}</div>`;
    }
    // assistant
    return `<div style="display:flex;gap:8px;align-items:flex-start">
      <div style="width:28px;height:28px;background:linear-gradient(135deg,var(--a),var(--a2));
        border-radius:8px;display:grid;place-items:center;font-size:13px;flex-shrink:0">🤖</div>
      <div style="background:var(--s);border:1px solid var(--b);
        border-radius:4px 14px 14px 14px;padding:10px 14px;max-width:85%;
        font-size:13px;line-height:1.6;color:var(--t)">${_formatAnswer(msg.content)}</div>
    </div>`;
  }).join('');

  // Scroll en bas
  el.scrollTop = el.scrollHeight;
}

function _formatAnswer(text) {
  return _esc(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code style="font-family:var(--fm);font-size:11px;background:var(--b);padding:1px 5px;border-radius:3px">$1</code>')
    .replace(/\n/g, '<br>');
}

function _esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _appendTypingIndicator() {
  const el = document.getElementById('copilot-messages');
  if (!el) return;
  const div = document.createElement('div');
  div.id = 'copilot-typing';
  div.style.cssText = 'display:flex;gap:8px;align-items:flex-start';
  div.innerHTML = `
    <div style="width:28px;height:28px;background:linear-gradient(135deg,var(--a),var(--a2));
      border-radius:8px;display:grid;place-items:center;font-size:13px;flex-shrink:0">🤖</div>
    <div style="background:var(--s);border:1px solid var(--b);border-radius:4px 14px 14px 14px;
      padding:12px 16px;display:flex;gap:4px;align-items:center">
      <span style="width:7px;height:7px;background:var(--a);border-radius:50%;
        animation:dotbounce .9s infinite 0s"></span>
      <span style="width:7px;height:7px;background:var(--a);border-radius:50%;
        animation:dotbounce .9s infinite .15s"></span>
      <span style="width:7px;height:7px;background:var(--a);border-radius:50%;
        animation:dotbounce .9s infinite .3s"></span>
    </div>`;

  // Ajouter l'animation si pas encore présente
  if (!document.getElementById('copilot-style')) {
    const style = document.createElement('style');
    style.id = 'copilot-style';
    style.textContent = `@keyframes dotbounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}`;
    document.head.appendChild(style);
  }

  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function _removeTypingIndicator() {
  document.getElementById('copilot-typing')?.remove();
}

/* ════════════════════════════════════════════════
   SUGGESTIONS RAPIDES
════════════════════════════════════════════════ */
const QUICK_SUGGESTIONS = [
  { label: 'IFD oublié ?',         q: 'Quand faut-il coter l\'IFD ?' },
  { label: 'Majoration nuit',       q: 'Quelles sont les majorations applicables la nuit ?' },
  { label: 'ALD → taux rembours.', q: 'Comment fonctionne l\'exonération ALD pour le ticket modérateur ?' },
  { label: 'Cumul actes NGAP',     q: 'Quels actes NGAP peut-on cumuler ?' },
  { label: 'AMI vs AIS',           q: 'Quelle est la différence entre AMI et AIS en NGAP ?' },
  { label: 'BSA BSB BSC',          q: 'Comment choisir entre BSA, BSB et BSC pour la toilette ?' },
  { label: 'Optimiser mon CA',     q: 'Comment optimiser mes revenus avec les majorations NGAP ?' },
  { label: 'DRE — comment ?',      q: 'Quand et comment faire une Demande de Remboursement Exceptionnel ?' },
];

function _renderSuggestions() {
  const el = document.getElementById('copilot-suggestions');
  if (!el) return;
  el.style.display = 'flex';
  el.innerHTML = QUICK_SUGGESTIONS.slice(0, 4).map(s =>
    `<button onclick="sendCopilotMessage('${s.q.replace(/'/g,"\\'")}')"
      style="background:var(--s);border:1px solid var(--b);color:var(--t);
      border-radius:20px;padding:4px 12px;font-size:11px;cursor:pointer;
      white-space:nowrap;font-family:var(--ff);transition:all .15s"
      onmouseenter="this.style.borderColor='var(--a)';this.style.color='var(--a)'"
      onmouseleave="this.style.borderColor='var(--b)';this.style.color='var(--t)'">${s.label}</button>`
  ).join('');
}

/* Effacer l'historique */
function clearCopilotHistory() {
  _copilotHistory = [];
  _saveHistory();
  _renderHistory();
  _renderSuggestions();
}

/* ════════════════════════════════════════════════
   SECTION COPILOTE DÉDIÉE (vue /copilote)
════════════════════════════════════════════════ */
function openCopilotSection() {
  if (typeof navTo === 'function') navTo('copilote', null);
}

function initCopiloteSection() {
  _loadHistory();
  const section = document.getElementById('view-copilote');
  if (!section) return;
  // Injecter l'interface dans la section
  const target = document.getElementById('copilote-chat-area');
  if (!target || target.dataset.initialized) return;
  target.dataset.initialized = '1';
  target.style.cssText = 'display:flex;flex-direction:column;height:calc(100vh - 220px);min-height:400px';
  target.innerHTML = `
    <div id="copilote-messages-full" style="flex:1;overflow-y:auto;padding:16px;
      display:flex;flex-direction:column;gap:10px;background:var(--s);
      border:1px solid var(--b);border-radius:var(--r) var(--r) 0 0"></div>
    <div id="copilote-sugg-full" style="padding:10px 14px;background:var(--c);
      border:1px solid var(--b);border-top:none;display:flex;gap:6px;flex-wrap:wrap"></div>
    <div style="display:flex;gap:8px;padding:12px 14px;background:var(--c);
      border:1px solid var(--b);border-top:none;border-radius:0 0 var(--r) var(--r)">
      <textarea id="copilote-input-full" placeholder="Posez votre question NGAP…"
        rows="2" style="flex:1;resize:none;background:var(--s);border:1px solid var(--b);
        color:var(--t);border-radius:10px;padding:10px 12px;font-size:14px;font-family:var(--ff)"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendCopilotFull();}">
      </textarea>
      <button onclick="sendCopilotFull()"
        style="background:linear-gradient(135deg,var(--a),#00b891);color:#000;
        border:none;border-radius:10px;padding:12px 18px;font-size:18px;cursor:pointer">↑</button>
    </div>`;

  _renderFullHistory();
  _renderFullSuggestions();
}

async function sendCopilotFull() {
  const input = document.getElementById('copilote-input-full');
  const q = (input?.value||'').trim();
  if (!q) return;
  if (input) input.value = '';

  _copilotHistory.push({ role:'user', content:q, ts:Date.now() });
  _renderFullHistory();

  const msgEl = document.getElementById('copilote-messages-full');
  if (msgEl) {
    const typing = document.createElement('div');
    typing.id = 'copilote-typing-full';
    typing.innerHTML = `<div style="color:var(--m);font-size:12px;font-style:italic">🤖 Réflexion en cours…</div>`;
    msgEl.appendChild(typing);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  try {
    const d = await apiCall('/webhook/ami-copilot', { question: _buildContext() ? `[${_buildContext()}]\n${q}` : q });
    document.getElementById('copilote-typing-full')?.remove();
    const answer = d.answer || 'Aucune réponse disponible.';
    _copilotHistory.push({ role:'assistant', content:answer, ts:Date.now() });
    _saveHistory();
    _renderFullHistory();
  } catch (e) {
    document.getElementById('copilote-typing-full')?.remove();
    _copilotHistory.push({ role:'error', content:'⚠️ '+e.message, ts:Date.now() });
    _renderFullHistory();
  }
}

function _renderFullHistory() {
  const el = document.getElementById('copilote-messages-full');
  if (!el) return;
  if (!_copilotHistory.length) {
    el.innerHTML = `<div style="text-align:center;padding:40px;color:var(--m)">
      <div style="font-size:40px;margin-bottom:12px">🤖</div>
      <div style="font-size:14px;line-height:1.8">Je suis votre expert NGAP.<br>Posez-moi n'importe quelle question sur la cotation,<br>les règles CPAM, ou l'optimisation de vos revenus.</div>
    </div>`;
    return;
  }
  el.innerHTML = _copilotHistory.map(msg => {
    if (msg.role === 'user') return `<div style="display:flex;justify-content:flex-end"><div style="background:linear-gradient(135deg,var(--a),#00b891);color:#000;border-radius:14px 14px 4px 14px;padding:12px 16px;max-width:75%;font-size:14px;line-height:1.5">${_esc(msg.content)}</div></div>`;
    if (msg.role === 'error') return `<div class="ai er" style="font-size:13px">${msg.content}</div>`;
    return `<div style="display:flex;gap:10px"><div style="width:32px;height:32px;background:linear-gradient(135deg,var(--a),var(--a2));border-radius:10px;display:grid;place-items:center;font-size:16px;flex-shrink:0">🤖</div><div style="background:var(--c);border:1px solid var(--b);border-radius:4px 14px 14px 14px;padding:12px 16px;max-width:82%;font-size:14px;line-height:1.7">${_formatAnswer(msg.content)}</div></div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function _renderFullSuggestions() {
  const el = document.getElementById('copilote-sugg-full');
  if (!el) return;
  el.innerHTML = QUICK_SUGGESTIONS.map(s =>
    `<button onclick="sendCopilotFull_q('${s.q.replace(/'/g,"\\'")}')" style="background:var(--s);border:1px solid var(--b);color:var(--m);border-radius:20px;padding:5px 14px;font-size:12px;cursor:pointer;white-space:nowrap;font-family:var(--ff);transition:all .15s" onmouseenter="this.style.borderColor='var(--a)';this.style.color='var(--a)'" onmouseleave="this.style.borderColor='var(--b)';this.style.color='var(--m)'">${s.label}</button>`
  ).join('');
}

async function sendCopilotFull_q(q) {
  const input = document.getElementById('copilote-input-full');
  if (input) input.value = q;
  await sendCopilotFull();
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  // Créer le bouton flottant (sauf si on est admin)
  if (typeof S === 'undefined' || S?.role !== 'admin') {
    _createCopilotPanel();
  }

  // Afficher le bouton flottant après login
  document.addEventListener('ami:login', () => {
    if (S?.role === 'nurse') _createCopilotPanel();
  });

  // Init section dédiée quand on navigue
  document.addEventListener('app:nav', e => {
    if (e.detail?.view === 'copilote') {
      setTimeout(initCopiloteSection, 50);
    }
  });
});

/* Exports */
window.toggleCopilot         = toggleCopilot;
window.sendCopilotMessage    = sendCopilotMessage;
window.clearCopilotHistory   = clearCopilotHistory;
window.openCopilotSection    = openCopilotSection;
window.sendCopilotFull       = sendCopilotFull;
window.sendCopilotFull_q     = sendCopilotFull_q;
