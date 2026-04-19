/* ════════════════════════════════════════════════
   transmissions.js — AMI v2.0
   ────────────────────────────────────────────────
   Module Transmissions Infirmières — Cabinet enrichi
   ────────────────────────────────────────────────
   Fonctionnalités :
   1. Transmissions SOAP / DAR par patient
   2. Sélection du destinataire parmi les membres du cabinet
   3. Transmission "Toutes les IDEs" ou à une IDE spécifique
   4. Historique filtrable : reçues / envoyées / urgentes / cabinet
   5. Badge de transmissions non lues
   6. Horodatage, signature, urgence, catégorie
   7. Export PDF fiche de liaison
   8. 100% local IDB
   ────────────────────────────────────────────────
   Dépendances : utils.js, patients.js, cabinet.js
════════════════════════════════════════════════ */

/* ── IDB version 2 ───────────────────────────── */
const TRANS_STORE = 'transmissions';

async function _transDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ami_transmissions', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(TRANS_STORE)) {
        const s = db.createObjectStore(TRANS_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('patient_id',      'patient_id',      { unique: false });
        s.createIndex('user_id',         'user_id',         { unique: false });
        s.createIndex('destinataire_id', 'destinataire_id', { unique: false });
        s.createIndex('cabinet_id',      'cabinet_id',      { unique: false });
        s.createIndex('date',            'date',            { unique: false });
      } else {
        const s = e.target.transaction.objectStore(TRANS_STORE);
        if (!s.indexNames.contains('destinataire_id'))
          s.createIndex('destinataire_id', 'destinataire_id', { unique: false });
        if (!s.indexNames.contains('cabinet_id'))
          s.createIndex('cabinet_id', 'cabinet_id', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _transGetAll(patientId) {
  const db  = await _transDb();
  const uid = APP?.user?.id || '';
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(TRANS_STORE, 'readonly');
    const idx = tx.objectStore(TRANS_STORE).index('patient_id');
    const req = idx.getAll(patientId);
    req.onsuccess = e => {
      const all = (e.target.result || [])
        .filter(t => t.user_id === uid || t.destinataire_id === uid || t.destinataire_id === 'all')
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      resolve(all);
    };
    req.onerror = e => reject(e.target.error);
  });
}

async function _transSave(trans) {
  const db = await _transDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(TRANS_STORE, 'readwrite');
    const req = tx.objectStore(TRANS_STORE).put(trans);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _transDelete(id) {
  const db = await _transDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(TRANS_STORE, 'readwrite');
    const req = tx.objectStore(TRANS_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function _transCountUnread() {
  const db  = await _transDb();
  const uid = APP?.user?.id || '';
  return new Promise(resolve => {
    const tx  = db.transaction(TRANS_STORE, 'readonly');
    const req = tx.objectStore(TRANS_STORE).getAll();
    req.onsuccess = e => {
      const n = (e.target.result || []).filter(t =>
        (t.destinataire_id === uid || t.destinataire_id === 'all') &&
        t.user_id !== uid && !t.lu
      ).length;
      resolve(n);
    };
    req.onerror = () => resolve(0);
  });
}

async function _transMarkRead(id) {
  const db = await _transDb();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(TRANS_STORE, 'readwrite');
    const store = tx.objectStore(TRANS_STORE);
    const get   = store.get(id);
    get.onsuccess = e => {
      const rec = e.target.result;
      if (!rec) { resolve(); return; }
      rec.lu = true;
      store.put(rec);
      resolve();
    };
    get.onerror = e => reject(e.target.error);
  });
}

/* ── État ────────────────────────────────────── */
let _transCurrentPatient = null;
let _transMode           = 'SOAP';
let _transFilter         = 'all';
let _transDestId         = 'all';
let _transDestNom        = 'Toutes les IDEs';

/* ── Helpers cabinet ─────────────────────────── */
function _transCabinet()    { return APP?.get?.('cabinet') || APP?.cabinet || null; }
function _transMembers()    {
  const cab = _transCabinet();
  if (!cab?.members?.length) return [];
  return cab.members.filter(m => m.id !== (APP?.user?.id || ''));
}
function _transIsInCabinet() { return !!(_transCabinet()?.id); }

/* ════════════════════════════════════════════════
   RENDU PRINCIPAL
════════════════════════════════════════════════ */
async function renderTransmissions() {
  const wrap = document.getElementById('transmissions-root');
  if (!wrap) return;

  let patients = [];
  try {
    if (typeof getAllPatients === 'function') patients = await getAllPatients();
  } catch (_) {}

  const cab     = _transCabinet();
  const members = _transMembers();
  const inCab   = _transIsInCabinet();
  const unread  = await _transCountUnread();

  /* ── Statut cabinet ── */
  const cabinetStatusHTML = inCab ? `
    <div style="background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.2);border-radius:12px;padding:14px 16px;margin-bottom:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:22px">🏥</span>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--a)">${cab.nom}</div>
            <div style="font-size:11px;color:var(--m);font-family:var(--fm);margin-top:2px">${cab.members?.length || 1} membre(s) · Cabinet actif</div>
          </div>
        </div>
        ${unread > 0
          ? `<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:20px;padding:5px 14px;font-size:12px;font-weight:700;color:#ef4444;font-family:var(--fm)">🔔 ${unread} non lue(s)</div>`
          : `<div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);border-radius:20px;padding:5px 14px;font-size:11px;color:#22c55e;font-family:var(--fm)">✅ Tout à jour</div>`}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${(cab.members || []).map(m => {
          const isMe = m.id === (APP?.user?.id || '');
          return `<div style="display:flex;align-items:center;gap:6px;background:var(--s);border:1px solid ${isMe?'rgba(0,212,170,.3)':'var(--b)'};border-radius:20px;padding:5px 12px;font-size:12px">
            <span>${m.role === 'titulaire' ? '👑' : '👤'}</span>
            <span style="color:${isMe?'var(--a)':'var(--t)'};font-weight:${isMe?700:400}">${m.prenom||''} ${m.nom||''}${isMe?' (moi)':''}</span>
          </div>`;
        }).join('')}
      </div>
    </div>` : `
    <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="font-size:20px">🏥</span>
      <div style="flex:1;font-size:12px;color:var(--m);line-height:1.5">
        Vous n'êtes pas dans un cabinet — les transmissions restent locales.<br>
        <span style="color:var(--t)">Rejoignez un cabinet pour partager vos transmissions avec vos collègues.</span>
      </div>
      <button class="btn bs bsm" onclick="navTo('cabinet',null)">Rejoindre un cabinet →</button>
    </div>`;

  /* ── Sélecteur destinataire ── */
  const destHTML = inCab && members.length ? `
    <div style="margin-bottom:16px">
      <div class="lbl" style="margin-bottom:10px">👩‍⚕️ Destinataire de la transmission</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label id="dest-lbl-all" style="display:flex;align-items:center;gap:7px;cursor:pointer;padding:8px 16px;border-radius:22px;border:1px solid rgba(0,212,170,.3);background:rgba(0,212,170,.08);font-size:12px;font-weight:600;color:var(--a);transition:all .15s">
          <input type="radio" name="trans-dest" value="all" checked onchange="transSetDest(this.value)"
            style="accent-color:var(--a);width:14px;height:14px">
          📢 Toutes les IDEs
        </label>
        ${members.map(m => `
          <label id="dest-lbl-${m.id}" style="display:flex;align-items:center;gap:7px;cursor:pointer;padding:8px 16px;border-radius:22px;border:1px solid var(--b);background:var(--s);font-size:12px;color:var(--t);transition:all .15s">
            <input type="radio" name="trans-dest" value="${m.id}" onchange="transSetDest('${m.id}')"
              style="accent-color:var(--a);width:14px;height:14px">
            ${m.role === 'titulaire' ? '👑' : '👤'} ${m.prenom||''} ${m.nom||''}
          </label>`).join('')}
      </div>
    </div>` : '';

  wrap.innerHTML = `
    <h1 class="pt">Transmissions <em>infirmières</em></h1>
    <p class="ps">Cahier de liaison · SOAP / DAR · Cabinet multi-IDE · Horodaté · Local</p>

    ${cabinetStatusHTML}

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">🔒</span><p><strong>Données locales :</strong> Les transmissions restent sur votre appareil. Elles ne transitent jamais par nos serveurs.</p></div>

      <div class="lbl" style="margin-bottom:8px">Patient concerné</div>
      <select id="trans-patient-sel" onchange="transSelectPatient(this.value)"
        style="width:100%;margin-bottom:16px;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
        <option value="">— Sélectionner un patient —</option>
        ${patients.map(p => `<option value="${p.id}">${p.nom||''} ${p.prenom||''}</option>`).join('')}
      </select>

      ${destHTML}

      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button id="trans-btn-soap" class="btn bp bsm" onclick="transSetMode('SOAP')" style="flex:1">📋 Format SOAP</button>
        <button id="trans-btn-dar"  class="btn bs bsm" onclick="transSetMode('DAR')"  style="flex:1">📝 Format DAR</button>
      </div>

      <div id="trans-form-soap">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div class="f"><label>🔵 S — Situation / Données subjectives</label><textarea id="trans-s" placeholder="Ce que le patient dit, ressent, exprime..." style="min-height:80px;resize:vertical"></textarea></div>
          <div class="f"><label>🟢 O — Objectif / Données objectives</label><textarea id="trans-o" placeholder="Constantes, observations, résultats mesurés..." style="min-height:80px;resize:vertical"></textarea></div>
          <div class="f"><label>🟡 A — Analyse / Évaluation infirmière</label><textarea id="trans-a" placeholder="Votre analyse clinique, problèmes identifiés..." style="min-height:80px;resize:vertical"></textarea></div>
          <div class="f"><label>🔴 P — Plan / Actions à prévoir</label><textarea id="trans-p" placeholder="Soins à réaliser, transmissions à faire, à surveiller..." style="min-height:80px;resize:vertical"></textarea></div>
        </div>
      </div>

      <div id="trans-form-dar" style="display:none">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
          <div class="f"><label>📊 D — Données</label><textarea id="trans-d" placeholder="Données recueillies, constatations..." style="min-height:100px;resize:vertical"></textarea></div>
          <div class="f"><label>⚡ A — Action</label><textarea id="trans-aa" placeholder="Actions infirmières réalisées..." style="min-height:100px;resize:vertical"></textarea></div>
          <div class="f"><label>✅ R — Résultat</label><textarea id="trans-r" placeholder="Résultat obtenu, évolution..." style="min-height:100px;resize:vertical"></textarea></div>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
          <input type="checkbox" id="trans-urgent" style="accent-color:#ef4444;width:16px;height:16px">
          <span style="color:#ef4444;font-weight:700">🚨 Transmission urgente</span>
        </label>
        <div class="f" style="margin:0;flex:1;min-width:140px">
          <select id="trans-categorie" style="padding:8px 12px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:13px;font-family:var(--fm);width:100%">
            <option value="general">Général</option>
            <option value="douleur">Douleur</option>
            <option value="plaie">Plaie / Pansement</option>
            <option value="medicament">Médicament</option>
            <option value="alimentation">Alimentation / Hydratation</option>
            <option value="chute">Risque chute</option>
            <option value="psycho">État psychologique</option>
            <option value="famille">Famille / Entourage</option>
            <option value="medecin">À signaler au médecin</option>
          </select>
        </div>
      </div>

      <div class="ar-row">
        <button class="btn bp" onclick="transSaveNew()"><span>💾</span> Enregistrer la transmission</button>
        <button class="btn bs" onclick="transResetForm()">↺ Effacer</button>
      </div>
    </div>

    <div id="trans-history" class="card" style="display:none">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div class="lbl">📋 Historique des transmissions</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn bs bsm" onclick="transExportPDF()">⬇ PDF</button>
          <select id="trans-filter-dest" onchange="_transFilter=this.value;transLoadHistory()"
            style="padding:6px 10px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:12px;font-family:var(--fm)">
            <option value="all">Toutes</option>
            <option value="sent">📤 Envoyées</option>
            <option value="received">📥 Reçues</option>
            <option value="urgent">🚨 Urgentes</option>
            ${inCab ? '<option value="cabinet">🏥 Cabinet</option>' : ''}
          </select>
          <select id="trans-filter-cat" onchange="transLoadHistory()"
            style="padding:6px 10px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:12px;font-family:var(--fm)">
            <option value="">Toutes catégories</option>
            <option value="general">Général</option>
            <option value="douleur">Douleur</option>
            <option value="plaie">Plaie</option>
            <option value="medicament">Médicament</option>
            <option value="medecin">À signaler médecin</option>
          </select>
        </div>
      </div>
      <div id="trans-list"></div>
    </div>
  `;

  _transUpdateModeUI();
}

/* ── Destinataire ────────────────────────────── */
function transSetDest(val) {
  _transDestId = val;
  if (val === 'all') {
    _transDestNom = 'Toutes les IDEs';
  } else {
    const m = _transMembers().find(x => x.id === val);
    _transDestNom = m ? `${m.prenom||''} ${m.nom||''}`.trim() : val;
  }
  document.querySelectorAll('[id^="dest-lbl-"]').forEach(lbl => {
    const sel = lbl.id === `dest-lbl-${val}`;
    lbl.style.borderColor = sel ? 'rgba(0,212,170,.4)' : 'var(--b)';
    lbl.style.background  = sel ? 'rgba(0,212,170,.08)' : 'var(--s)';
    lbl.style.color       = sel ? 'var(--a)' : 'var(--t)';
    lbl.style.fontWeight  = sel ? '600' : '400';
  });
}

function transSetMode(mode) {
  _transMode = mode;
  _transUpdateModeUI();
}

function _transUpdateModeUI() {
  const soap = document.getElementById('trans-form-soap');
  const dar  = document.getElementById('trans-form-dar');
  const btnS = document.getElementById('trans-btn-soap');
  const btnD = document.getElementById('trans-btn-dar');
  if (!soap) return;
  const isSoap = _transMode === 'SOAP';
  soap.style.display = isSoap ? 'block' : 'none';
  dar.style.display  = isSoap ? 'none'  : 'block';
  if (btnS) { btnS.className = isSoap ? 'btn bp bsm' : 'btn bs bsm'; btnS.style.flex = '1'; }
  if (btnD) { btnD.className = isSoap ? 'btn bs bsm' : 'btn bp bsm'; btnD.style.flex = '1'; }
}

async function transSelectPatient(patientId) {
  _transCurrentPatient = patientId || null;
  await transLoadHistory();
}

/* ── Historique avec filtres ─────────────────── */
async function transLoadHistory() {
  if (!_transCurrentPatient) {
    const h = document.getElementById('trans-history');
    if (h) h.style.display = 'none';
    return;
  }
  const h = document.getElementById('trans-history');
  if (h) h.style.display = 'block';

  const list = document.getElementById('trans-list');
  if (!list) return;
  list.innerHTML = '<div class="ai in" style="font-size:12px">Chargement…</div>';

  try {
    let all = await _transGetAll(_transCurrentPatient);
    const uid       = APP?.user?.id || '';
    const fDest     = document.getElementById('trans-filter-dest')?.value || _transFilter || 'all';
    const fCat      = document.getElementById('trans-filter-cat')?.value || '';

    if (fDest === 'sent')     all = all.filter(t => t.user_id === uid);
    if (fDest === 'received') all = all.filter(t => t.user_id !== uid && (t.destinataire_id === uid || t.destinataire_id === 'all'));
    if (fDest === 'urgent')   all = all.filter(t => t.urgent);
    if (fDest === 'cabinet')  all = all.filter(t => !!t.cabinet_id);
    if (fCat)                 all = all.filter(t => t.categorie === fCat);

    if (!all.length) {
      list.innerHTML = '<div class="empty"><p>Aucune transmission pour ce filtre.</p></div>';
      return;
    }

    const catIcons = { general:'📋', douleur:'😣', plaie:'🩹', medicament:'💊', alimentation:'🍽️', chute:'⚠️', psycho:'🧠', famille:'👨‍👩‍👧', medecin:'👨‍⚕️' };

    list.innerHTML = all.map(t => {
      const dateStr  = new Date(t.date).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
      const isMine   = t.user_id === uid;
      const isUnread = !isMine && !t.lu;
      const catIcon  = catIcons[t.categorie] || '📋';

      /* Ligne de routage émetteur → destinataire */
      const destLabel = t.destinataire_id === 'all'
        ? '📢 Toutes les IDEs'
        : t.destinataire_id === uid ? '📥 Moi' : (t.destinataire_nom || '—');

      const routeHTML = t.cabinet_id ? `
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--m);font-family:var(--fm);margin-top:4px;flex-wrap:wrap">
          <span style="color:${isMine?'var(--a)':'var(--m)'};font-weight:${isMine?700:400}">
            ${isMine ? '📤 Moi' : `👤 ${t.inf_nom||'IDE'}`}
          </span>
          <span style="color:var(--m)">→</span>
          <span style="color:${(!isMine&&(t.destinataire_id===uid||t.destinataire_id==='all'))?'#22c55e':'var(--m)'}">
            ${destLabel}
          </span>
          <span style="background:rgba(0,212,170,.1);color:var(--a);border-radius:20px;padding:1px 8px;font-size:10px;font-family:var(--fm)">🏥 ${t.cabinet_nom||'Cabinet'}</span>
        </div>` : `
        <div style="font-size:11px;color:var(--m);font-family:var(--fm);margin-top:4px">✍️ ${t.inf_nom||'Infirmière'}</div>`;

      /* Contenu */
      let contenu = '';
      if (t.mode === 'SOAP') {
        contenu = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;font-size:12px">
          ${t.s?`<div style="background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.2);border-radius:6px;padding:8px"><strong style="color:#60a5fa">S</strong> — ${t.s}</div>`:''}
          ${t.o?`<div style="background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:6px;padding:8px"><strong style="color:#4ade80">O</strong> — ${t.o}</div>`:''}
          ${t.a?`<div style="background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.2);border-radius:6px;padding:8px"><strong style="color:#fbbf24">A</strong> — ${t.a}</div>`:''}
          ${t.p?`<div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:6px;padding:8px"><strong style="color:#f87171">P</strong> — ${t.p}</div>`:''}
        </div>`;
      } else {
        contenu = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:8px;font-size:12px">
          ${t.d ?`<div style="background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.2);border-radius:6px;padding:8px"><strong style="color:#60a5fa">D</strong> — ${t.d}</div>`:''}
          ${t.aa?`<div style="background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:6px;padding:8px"><strong style="color:#4ade80">A</strong> — ${t.aa}</div>`:''}
          ${t.r ?`<div style="background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.2);border-radius:6px;padding:8px"><strong style="color:#fbbf24">R</strong> — ${t.r}</div>`:''}
        </div>`;
      }

      return `
        <div style="background:${isUnread?'rgba(0,212,170,.04)':'var(--s)'};border:1px solid ${isUnread?'rgba(0,212,170,.35)':'var(--b)'};${t.urgent?'border-left:3px solid #ef4444;':''}border-radius:10px;padding:14px;margin-bottom:10px;cursor:${isUnread?'pointer':'default'}"
          onclick="${isUnread?`_transMarkReadUI(${t.id})`:'void(0)'}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:4px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span>${catIcon}</span>
              <span style="font-size:12px;font-family:var(--fm);color:var(--m)">${dateStr}</span>
              <span style="font-size:11px;font-family:var(--fm);background:var(--dd);padding:2px 8px;border-radius:20px;color:var(--m)">${t.mode||'SOAP'}</span>
              ${t.urgent?`<span style="background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3);border-radius:20px;font-size:10px;padding:1px 8px;font-family:var(--fm)">🚨 URGENT</span>`:''}
              ${isUnread?`<span style="background:rgba(0,212,170,.15);color:var(--a);border-radius:20px;font-size:10px;padding:1px 8px;font-family:var(--fm);font-weight:700">● NOUVEAU</span>`:''}
            </div>
            <button onclick="event.stopPropagation();transDelete(${t.id})"
              style="background:none;border:none;color:var(--d);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px;font-family:var(--fm)"
              onmouseenter="this.style.background='rgba(239,68,68,.1)'" onmouseleave="this.style.background='none'">🗑</button>
          </div>
          ${routeHTML}
          ${contenu}
        </div>`;
    }).join('');

    /* Marquer les reçues comme lues après 2s */
    setTimeout(async () => {
      for (const t of all.filter(t => !t.lu && t.user_id !== uid))
        await _transMarkRead(t.id);
    }, 2000);

  } catch (err) {
    if (list) list.innerHTML = `<div class="msg e">Erreur : ${err.message}</div>`;
  }
}

async function _transMarkReadUI(id) {
  await _transMarkRead(id);
  await transLoadHistory();
}

/* ── Enregistrement ──────────────────────────── */
async function transSaveNew() {
  if (!_transCurrentPatient) {
    showToast('warning', 'Patient requis', 'Sélectionnez un patient avant d\'enregistrer.'); return;
  }

  const urgent    = document.getElementById('trans-urgent')?.checked || false;
  const categorie = document.getElementById('trans-categorie')?.value || 'general';
  const userId    = APP?.user?.id || '';
  const infNom    = APP?.user?.prenom ? `${APP.user.prenom} ${APP.user.nom||''}`.trim() : 'Infirmière';
  const cab       = _transCabinet();
  const inCab     = _transIsInCabinet();

  let trans = {
    patient_id:      _transCurrentPatient,
    user_id:         userId,
    inf_nom:         infNom,
    mode:            _transMode,
    date:            new Date().toISOString(),
    urgent,
    categorie,
    lu:              false,
    destinataire_id:  inCab ? (_transDestId || 'all') : userId,
    destinataire_nom: inCab ? _transDestNom : infNom,
    cabinet_id:       cab?.id   || null,
    cabinet_nom:      cab?.nom  || null,
  };

  if (_transMode === 'SOAP') {
    trans.s = document.getElementById('trans-s')?.value.trim() || '';
    trans.o = document.getElementById('trans-o')?.value.trim() || '';
    trans.a = document.getElementById('trans-a')?.value.trim() || '';
    trans.p = document.getElementById('trans-p')?.value.trim() || '';
    if (!trans.s && !trans.o && !trans.a && !trans.p) {
      showToast('warning', 'Transmission vide', 'Renseignez au moins un champ SOAP.'); return;
    }
  } else {
    trans.d  = document.getElementById('trans-d')?.value.trim()  || '';
    trans.aa = document.getElementById('trans-aa')?.value.trim() || '';
    trans.r  = document.getElementById('trans-r')?.value.trim()  || '';
    if (!trans.d && !trans.aa && !trans.r) {
      showToast('warning', 'Transmission vide', 'Renseignez au moins un champ DAR.'); return;
    }
  }

  try {
    await _transSave(trans);
    const destMsg = inCab
      ? `→ ${_transDestNom}${urgent?' 🚨':''}`
      : (urgent ? '🚨 Urgente' : 'Horodatée');
    showToast('success', 'Transmission enregistrée', destMsg);
    transResetForm();
    await transLoadHistory();
  } catch (err) {
    showToast('error', 'Erreur', err.message);
  }
}

function transResetForm() {
  ['trans-s','trans-o','trans-a','trans-p','trans-d','trans-aa','trans-r'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const urg = document.getElementById('trans-urgent');
  if (urg) urg.checked = false;
  _transDestId = 'all'; _transDestNom = 'Toutes les IDEs';
  const radio = document.querySelector('input[name="trans-dest"][value="all"]');
  if (radio) { radio.checked = true; transSetDest('all'); }
}

async function transDelete(id) {
  if (!confirm('Supprimer cette transmission ?')) return;
  try {
    await _transDelete(id);
    showToast('info', 'Transmission supprimée');
    await transLoadHistory();
  } catch (err) {
    showToast('error', 'Erreur', err.message);
  }
}

async function transExportPDF() {
  if (!_transCurrentPatient) return;
  try {
    const all = await _transGetAll(_transCurrentPatient);
    if (!all.length) { showToast('warning', 'Aucune transmission à exporter'); return; }
    const rows = all.map(t => {
      const d    = new Date(t.date).toLocaleString('fr-FR');
      const dest = t.destinataire_id === 'all' ? 'Toutes les IDEs' : (t.destinataire_nom || t.destinataire_id || '—');
      const hdr  = `[${d}] ${t.mode}${t.urgent?' 🚨 URGENT':''} · De: ${t.inf_nom||'—'} → ${dest}`;
      return t.mode === 'SOAP'
        ? `${hdr}\nS: ${t.s||'-'}\nO: ${t.o||'-'}\nA: ${t.a||'-'}\nP: ${t.p||'-'}`
        : `${hdr}\nD: ${t.d||'-'}\nA: ${t.aa||'-'}\nR: ${t.r||'-'}`;
    }).join('\n\n---\n\n');
    const blob = new Blob([`FICHE DE LIAISON INFIRMIÈRE — AMI\nExport : ${new Date().toLocaleString('fr-FR')}\n\n${rows}`], { type:'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `transmissions_${Date.now()}.txt`; a.click();
    URL.revokeObjectURL(url);
    showToast('success', 'Export réussi');
  } catch (err) {
    showToast('error', 'Erreur export', err.message);
  }
}

/* ── Navigation ──────────────────────────────── */
document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'transmissions') {
    _transDestId = 'all'; _transDestNom = 'Toutes les IDEs';
    renderTransmissions();
  }
});
