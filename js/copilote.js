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
  const isAdmin = (typeof S !== 'undefined') && S?.role === 'admin';

  // ── Mode admin : contexte limité — aucune donnée médicale patient ──
  if (isAdmin) {
    parts.push('Mode: administrateur (test fonctionnel — sans données patients)');
    const user = S?.user;
    if (user?.nom) parts.push('Admin: ' + (user.prenom||'') + ' ' + user.nom);
    return parts.join(' · ') || '';
  }

  // ── Mode infirmière : contexte complet (sans données nominatives patient) ──
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
   ────────────────────────────────────────────────
   v2 — robuste : monte l'UI dès que la section
   est visible, fonctionne pour nurses ET admins,
   réponses via API Claude (Anthropic) en direct.
════════════════════════════════════════════════ */
function openCopilotSection() {
  if (typeof navTo === 'function') navTo('copilote', null);
}

/* ── Initialisation du Copilote (HTML déjà dans le DOM via index.html) ── */
function initCopiloteSection() {
  _loadHistory();

  // ── Notice admin ──
  const isAdmin = typeof S !== 'undefined' && S?.role === 'admin';
  const notice  = document.getElementById('copilote-admin-notice');
  if (notice) notice.style.display = isAdmin ? 'flex' : 'none';

  // ── Remplir messages et suggestions (le HTML existe déjà) ──
  _renderFullHistory();
  _renderFullSuggestions();
  setTimeout(() => document.getElementById('copilote-input-full')?.focus(), 150);
}

/* ── Envoi message — réponse via API Claude (Anthropic) ── */
let _fullTyping = false;

async function sendCopilotFull() {
  if (_fullTyping) return;
  const input = document.getElementById('copilote-input-full');
  const q = (input?.value || '').trim();
  if (!q) return;
  if (input) { input.value = ''; input.style.height = 'auto'; }

  _copilotHistory.push({ role: 'user', content: q, ts: Date.now() });
  _renderFullHistory();
  _fullTyping = true;

  // Désactiver bouton
  const btn = document.getElementById('copilote-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  // Typing indicator
  const msgEl = document.getElementById('copilote-messages-full');
  if (msgEl) {
    const t = document.createElement('div');
    t.id = 'copilote-typing-full';
    t.style.cssText = 'display:flex;gap:10px;align-items:flex-start';
    t.innerHTML = \`<div style="width:32px;height:32px;background:linear-gradient(135deg,var(--a),var(--a2));border-radius:10px;display:grid;place-items:center;font-size:16px;flex-shrink:0">🤖</div>
    <div style="background:var(--s);border:1px solid var(--b);border-radius:4px 14px 14px 14px;padding:12px 16px;display:flex;gap:5px;align-items:center">
      <span style="width:7px;height:7px;background:var(--a);border-radius:50%;animation:dotbounce .9s infinite 0s"></span>
      <span style="width:7px;height:7px;background:var(--a);border-radius:50%;animation:dotbounce .9s infinite .15s"></span>
      <span style="width:7px;height:7px;background:var(--a);border-radius:50%;animation:dotbounce .9s infinite .3s"></span>
    </div>\`;
    msgEl.appendChild(t);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  try {
    const answer = await _askClaude(q);
    document.getElementById('copilote-typing-full')?.remove();
    _copilotHistory.push({ role: 'assistant', content: answer, ts: Date.now() });
    _saveHistory();
    _renderFullHistory();
    if (typeof window.safeSpeak === 'function' && answer.length < 250) window.safeSpeak(answer);
  } catch (e) {
    document.getElementById('copilote-typing-full')?.remove();
    _copilotHistory.push({ role: 'error', content: '⚠️ ' + (e.message || 'Service indisponible.'), ts: Date.now() });
    _renderFullHistory();
  }

  _fullTyping = false;
  if (btn) { btn.disabled = false; btn.textContent = '↑'; }
  document.getElementById('copilote-input-full')?.focus();
}


/* ── Appel via worker Cloudflare → xAI Grok (clé sécurisée côté serveur) ── */
async function _askClaude(question) {
  const ctx = _buildContext();

  // Transmettre l'historique au worker pour conversation continue
  const history = _copilotHistory
    .slice(-10)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 500) }));

  const fullQuestion = ctx ? `[Contexte: ${ctx}]
${question}` : question;

  // Le worker appelle xAI Grok côté serveur (clé API jamais exposée au client)
  const d = await apiCall('/webhook/ami-copilot', {
    question: fullQuestion,
    history,
  });

  if (!d.ok) throw new Error(d.error || 'Service indisponible.');
  return d.answer || "Je n'ai pas pu répondre. Réessayez.";
}


/* ── Render history section dédiée ── */
function _renderFullHistory() {
  const el = document.getElementById('copilote-messages-full');
  if (!el) return;

  if (!_copilotHistory.length) {
    el.innerHTML = \`
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  height:100%;text-align:center;color:var(--m);padding:40px 20px">
        <div style="font-size:52px;margin-bottom:16px;filter:drop-shadow(0 0 20px rgba(0,212,170,.3))">🤖</div>
        <div style="font-family:var(--fs);font-size:20px;margin-bottom:10px;color:var(--t)">Copilote <em style="color:var(--a)">NGAP</em></div>
        <div style="font-size:13px;line-height:1.8;max-width:320px">
          Expert NGAP disponible 24h/24.<br>
          Posez vos questions sur la <strong>cotation</strong>,<br>
          les <strong>règles CPAM</strong>, les <strong>majorations</strong>…<br>
          <span style="font-size:11px;opacity:.6;margin-top:8px;display:block">Utilisez les suggestions ci-dessous ou écrivez librement.</span>
        </div>
      </div>\`;
    return;
  }

  el.innerHTML = _copilotHistory.map(msg => {
    if (msg.role === 'user') {
      return \`<div style="display:flex;justify-content:flex-end">
        <div style="background:linear-gradient(135deg,var(--a),#00b891);color:#000;
          border-radius:14px 14px 4px 14px;padding:12px 16px;max-width:75%;
          font-size:14px;line-height:1.5;word-break:break-word">\${_esc(msg.content)}</div>
      </div>\`;
    }
    if (msg.role === 'error') {
      return \`<div style="background:rgba(255,95,109,.08);border:1px solid rgba(255,95,109,.3);
        border-radius:10px;padding:10px 14px;font-size:13px;color:var(--d)">\${msg.content}</div>\`;
    }
    return \`<div style="display:flex;gap:10px;align-items:flex-start">
      <div style="width:32px;height:32px;background:linear-gradient(135deg,var(--a),var(--a2));
        border-radius:10px;display:grid;place-items:center;font-size:16px;flex-shrink:0">🤖</div>
      <div style="background:var(--c);border:1px solid var(--b);
        border-radius:4px 14px 14px 14px;padding:12px 16px;max-width:82%;
        font-size:14px;line-height:1.7;word-break:break-word">\${_formatAnswer(msg.content)}</div>
    </div>\`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

/* ── Suggestions section dédiée ── */
function _renderFullSuggestions() {
  const el = document.getElementById('copilote-sugg-full');
  if (!el) return;
  el.innerHTML = QUICK_SUGGESTIONS.map(s =>
    \`<button onclick="sendCopilotFull_q('\${s.q.replace(/'/g,"\\'")}')"
      style="background:var(--s);border:1px solid var(--b);color:var(--m);
             border-radius:20px;padding:5px 14px;font-size:12px;cursor:pointer;
             white-space:nowrap;font-family:var(--ff);transition:all .15s"
      onmouseenter="this.style.borderColor='var(--a)';this.style.color='var(--a)'"
      onmouseleave="this.style.borderColor='var(--b)';this.style.color='var(--m)'">\${s.label}</button>\`
  ).join('');
}

async function sendCopilotFull_q(q) {
  const input = document.getElementById('copilote-input-full');
  if (input) { input.value = q; input.dispatchEvent(new Event('input')); }
  await sendCopilotFull();
}

/* ════════════════════════════════════════════════
   INIT — robuste (multiples déclencheurs)
════════════════════════════════════════════════ */
function _tryInitCopilote() {
  const target = document.getElementById('copilote-chat-area');
  if (!target) return;
  const section = document.getElementById('view-copilote');
  const visible = section?.classList.contains('on') ||
                  (section && getComputedStyle(section).display !== 'none');
  if (visible) initCopiloteSection();
}

document.addEventListener('DOMContentLoaded', () => {

  /* ── Panneau flottant : créé après login selon le rôle ── */
  function _setupByRole() {
    const role = typeof S !== 'undefined' ? S?.role : null;
    if (role === 'nurse' && !document.getElementById('copilot-panel')) {
      _createCopilotPanel();
    }
    /* Admin ou rôle inconnu : pas de panneau flottant, mais Copilote section pleine */
  }

  /* Tenter immédiatement si déjà connecté (rechargement page) */
  _setupByRole();

  /* ── Écouter le login — S est hydraté à ce moment ── */
  document.addEventListener('ami:login', () => {
    _setupByRole();
    /* Réinitialiser le flag pour forcer un remontage propre */
    const target = document.getElementById('copilote-chat-area');
    if (target) { target.dataset.ok = ''; target.innerHTML = ''; }
    /* Si on est déjà sur la page copilote, monter immédiatement */
    setTimeout(_tryInitCopilote, 100);
  });

  /* ── Déclencheur principal : ui:navigate (événement réel de navTo dans ui.js) ── */
  document.addEventListener('ui:navigate', e => {
    if (e.detail?.view !== 'copilote') return;
    const target = document.getElementById('copilote-chat-area');
    if (target && !document.getElementById('copilote-messages-full')) {
      target.dataset.ok = '';
    }
    setTimeout(initCopiloteSection, 80);
  });

  /* ── Compatibilité : app:nav (ancien nom) ── */
  document.addEventListener('app:nav', e => {
    if (e.detail?.view !== 'copilote') return;
    const target = document.getElementById('copilote-chat-area');
    if (target && !document.getElementById('copilote-messages-full')) target.dataset.ok = '';
    setTimeout(initCopiloteSection, 80);
  });

  /* ── Déclencheur secondaire : MutationObserver sur la section ── */
  const section = document.getElementById('view-copilote');
  if (section) {
    const obs = new MutationObserver(() => _tryInitCopilote());
    obs.observe(section, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  /* ── Déclencheur tertiaire : section déjà visible au chargement ── */
  setTimeout(_tryInitCopilote, 300);
});

/* Exports */
window.toggleCopilot         = toggleCopilot;
window.sendCopilotMessage    = sendCopilotMessage;
window.clearCopilotHistory   = clearCopilotHistory;
window.openCopilotSection    = openCopilotSection;
window.sendCopilotFull       = sendCopilotFull;
window.sendCopilotFull_q     = sendCopilotFull_q;
window.initCopiloteSection   = initCopiloteSection;
