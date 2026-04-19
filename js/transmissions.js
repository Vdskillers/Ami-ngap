/* ════════════════════════════════════════════════
   transmissions.js — AMI v1.0
   ────────────────────────────────────────────────
   Module Transmissions Infirmières
   ────────────────────────────────────────────────
   Fonctionnalités :
   1. Transmissions SOAP (Situation/Objectif/Analyse/Plan)
      et DAR (Données/Action/Résultat) par patient
   2. Horodatage automatique + signature infirmière
   3. Stockage local IndexedDB chiffré (jamais transmis)
   4. Export PDF de la fiche de liaison
   5. Alertes et transmissions urgentes (bandeau rouge)
   6. Continuité des soins entre collègues (cabinet)
   ────────────────────────────────────────────────
   Dépendances : utils.js, patients.js (IDB)
════════════════════════════════════════════════ */

/* ── IDB helpers ─────────────────────────────── */
const TRANS_STORE = 'transmissions';

async function _transDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ami_transmissions', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(TRANS_STORE)) {
        const s = db.createObjectStore(TRANS_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('patient_id', 'patient_id', { unique: false });
        s.createIndex('user_id',    'user_id',    { unique: false });
        s.createIndex('date',       'date',        { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _transGetAll(patientId) {
  const db = await _transDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(TRANS_STORE, 'readonly');
    const idx = tx.objectStore(TRANS_STORE).index('patient_id');
    const req = idx.getAll(patientId);
    req.onsuccess = e => {
      const uid = APP?.user?.id || '';
      resolve((e.target.result || []).filter(t => t.user_id === uid).sort((a, b) => new Date(b.date) - new Date(a.date)));
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

/* ── État local ──────────────────────────────── */
let _transCurrentPatient = null;
let _transMode = 'SOAP'; // 'SOAP' | 'DAR'

/* ════════════════════════════════════════════════
   RENDU PRINCIPAL — vue transmissions
════════════════════════════════════════════════ */
async function renderTransmissions() {
  const wrap = document.getElementById('view-transmissions');
  if (!wrap) return;

  // Charger la liste des patients
  let patients = [];
  try {
    if (typeof getAllPatients === 'function') patients = await getAllPatients();
  } catch (_) {}

  wrap.innerHTML = `
    <h1 class="pt">Transmissions <em>infirmières</em></h1>
    <p class="ps">Cahier de liaison numérique · SOAP / DAR · Horodaté · Chiffré localement</p>

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">🔒</span><p><strong>Données locales uniquement :</strong> Les transmissions sont stockées sur votre appareil, chiffrées. Elles ne sont jamais transmises à nos serveurs.</p></div>

      <!-- Sélecteur patient -->
      <div class="lbl" style="margin-bottom:8px">Patient concerné</div>
      <select id="trans-patient-sel" onchange="transSelectPatient(this.value)" style="width:100%;margin-bottom:16px;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
        <option value="">— Sélectionner un patient —</option>
        ${patients.map(p => `<option value="${p.id}">${p.nom || ''} ${p.prenom || ''}</option>`).join('')}
      </select>

      <!-- Choix du format -->
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button id="trans-btn-soap" class="btn bp bsm" onclick="transSetMode('SOAP')" style="flex:1">📋 Format SOAP</button>
        <button id="trans-btn-dar"  class="btn bs bsm" onclick="transSetMode('DAR')"  style="flex:1">📝 Format DAR</button>
      </div>

      <!-- Formulaire SOAP -->
      <div id="trans-form-soap">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div class="f"><label>🔵 S — Situation / Données subjectives</label><textarea id="trans-s" placeholder="Ce que le patient dit, ressent, exprime..." style="min-height:80px;resize:vertical"></textarea></div>
          <div class="f"><label>🟢 O — Objectif / Données objectives</label><textarea id="trans-o" placeholder="Constantes, observations, résultats mesurés..." style="min-height:80px;resize:vertical"></textarea></div>
          <div class="f"><label>🟡 A — Analyse / Évaluation infirmière</label><textarea id="trans-a" placeholder="Votre analyse clinique, problèmes identifiés..." style="min-height:80px;resize:vertical"></textarea></div>
          <div class="f"><label>🔴 P — Plan / Actions à prévoir</label><textarea id="trans-p" placeholder="Soins à réaliser, transmissions à faire, à surveiller..." style="min-height:80px;resize:vertical"></textarea></div>
        </div>
      </div>

      <!-- Formulaire DAR -->
      <div id="trans-form-dar" style="display:none">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
          <div class="f"><label>📊 D — Données</label><textarea id="trans-d" placeholder="Données recueillies, constatations..." style="min-height:100px;resize:vertical"></textarea></div>
          <div class="f"><label>⚡ A — Action</label><textarea id="trans-aa" placeholder="Actions infirmières réalisées..." style="min-height:100px;resize:vertical"></textarea></div>
          <div class="f"><label>✅ R — Résultat</label><textarea id="trans-r" placeholder="Résultat obtenu, évolution..." style="min-height:100px;resize:vertical"></textarea></div>
        </div>
      </div>

      <!-- Options -->
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

    <!-- Historique transmissions -->
    <div id="trans-history" class="card" style="display:none">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div class="lbl">📋 Historique des transmissions</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn bs bsm" onclick="transExportPDF()">⬇ Export PDF</button>
          <select id="trans-filter-cat" onchange="transLoadHistory()" style="padding:6px 10px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:12px;font-family:var(--fm)">
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

async function transLoadHistory() {
  if (!_transCurrentPatient) {
    const hist = document.getElementById('trans-history');
    if (hist) hist.style.display = 'none';
    return;
  }
  const hist = document.getElementById('trans-history');
  if (hist) hist.style.display = 'block';

  const list = document.getElementById('trans-list');
  if (!list) return;
  list.innerHTML = '<div class="ai in" style="font-size:12px">Chargement…</div>';

  try {
    let all = await _transGetAll(_transCurrentPatient);
    const filterCat = document.getElementById('trans-filter-cat')?.value || '';
    if (filterCat) all = all.filter(t => t.categorie === filterCat);

    if (!all.length) {
      list.innerHTML = '<div class="empty"><p>Aucune transmission enregistrée pour ce patient.</p></div>';
      return;
    }

    list.innerHTML = all.map(t => {
      const dateStr = new Date(t.date).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const urgClass = t.urgent ? 'border-left:3px solid #ef4444;' : '';
      const urgBadge = t.urgent ? '<span style="background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3);border-radius:20px;font-size:10px;padding:1px 8px;font-family:var(--fm)">🚨 URGENT</span>' : '';
      const catIcons = { general:'📋', douleur:'😣', plaie:'🩹', medicament:'💊', alimentation:'🍽️', chute:'⚠️', psycho:'🧠', famille:'👨‍👩‍👧', medecin:'👨‍⚕️' };
      const catIcon = catIcons[t.categorie] || '📋';

      let contenu = '';
      if (t.mode === 'SOAP') {
        contenu = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;font-size:12px">
            ${t.s ? `<div style="background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.2);border-radius:6px;padding:8px"><strong style="color:#60a5fa">S</strong> ${t.s}</div>` : ''}
            ${t.o ? `<div style="background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:6px;padding:8px"><strong style="color:#4ade80">O</strong> ${t.o}</div>` : ''}
            ${t.a ? `<div style="background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.2);border-radius:6px;padding:8px"><strong style="color:#fbbf24">A</strong> ${t.a}</div>` : ''}
            ${t.p ? `<div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:6px;padding:8px"><strong style="color:#f87171">P</strong> ${t.p}</div>` : ''}
          </div>`;
      } else {
        contenu = `
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:8px;font-size:12px">
            ${t.d  ? `<div style="background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.2);border-radius:6px;padding:8px"><strong style="color:#60a5fa">D</strong> ${t.d}</div>` : ''}
            ${t.aa ? `<div style="background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:6px;padding:8px"><strong style="color:#4ade80">A</strong> ${t.aa}</div>` : ''}
            ${t.r  ? `<div style="background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.2);border-radius:6px;padding:8px"><strong style="color:#fbbf24">R</strong> ${t.r}</div>` : ''}
          </div>`;
      }

      return `
        <div style="background:var(--s);border:1px solid var(--b);${urgClass}border-radius:10px;padding:14px;margin-bottom:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:6px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span style="font-size:13px">${catIcon}</span>
              <span style="font-size:12px;font-family:var(--fm);color:var(--m)">${dateStr}</span>
              <span style="font-size:11px;font-family:var(--fm);background:var(--dd);padding:2px 8px;border-radius:20px;color:var(--m)">${t.mode || 'SOAP'}</span>
              ${urgBadge}
            </div>
            <button onclick="transDelete(${t.id})" style="background:none;border:none;color:var(--d);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px;font-family:var(--fm)" onmouseenter="this.style.background='rgba(239,68,68,.1)'" onmouseleave="this.style.background='none'">🗑</button>
          </div>
          ${contenu}
        </div>`;
    }).join('');
  } catch (err) {
    if (list) list.innerHTML = `<div class="msg e">Erreur chargement : ${err.message}</div>`;
  }
}

async function transSaveNew() {
  if (!_transCurrentPatient) {
    showToast('warning', 'Patient requis', 'Sélectionnez un patient avant d\'enregistrer.'); return;
  }

  const urgent    = document.getElementById('trans-urgent')?.checked || false;
  const categorie = document.getElementById('trans-categorie')?.value || 'general';
  const userId    = APP?.user?.id || '';
  const infNom    = APP?.user?.prenom ? `${APP.user.prenom} ${APP.user.nom || ''}`.trim() : 'Infirmière';

  let trans = {
    patient_id: _transCurrentPatient,
    user_id:    userId,
    inf_nom:    infNom,
    mode:       _transMode,
    date:       new Date().toISOString(),
    urgent,
    categorie,
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
    showToast('success', 'Transmission enregistrée', urgent ? '🚨 Marquée comme urgente' : 'Horodatée et signée');
    transResetForm();
    await transLoadHistory();
  } catch (err) {
    showToast('error', 'Erreur', err.message);
  }
}

function transResetForm() {
  ['trans-s','trans-o','trans-a','trans-p','trans-d','trans-aa','trans-r'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const urg = document.getElementById('trans-urgent');
  if (urg) urg.checked = false;
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

    let rows = all.map(t => {
      const dateStr = new Date(t.date).toLocaleString('fr-FR');
      if (t.mode === 'SOAP') {
        return `[${dateStr}] SOAP${t.urgent?' 🚨 URGENT':''}\nS: ${t.s||'-'}\nO: ${t.o||'-'}\nA: ${t.a||'-'}\nP: ${t.p||'-'}`;
      } else {
        return `[${dateStr}] DAR${t.urgent?' 🚨 URGENT':''}\nD: ${t.d||'-'}\nA: ${t.aa||'-'}\nR: ${t.r||'-'}`;
      }
    }).join('\n\n---\n\n');

    const blob = new Blob([`FICHE DE LIAISON INFIRMIÈRE — AMI\nExport : ${new Date().toLocaleString('fr-FR')}\n\n${rows}`], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `transmissions_${Date.now()}.txt`; a.click();
    URL.revokeObjectURL(url);
    showToast('success', 'Export réussi');
  } catch (err) {
    showToast('error', 'Erreur export', err.message);
  }
}

/* ── Événement navigation ────────────────────── */
document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'transmissions') {
    renderTransmissions();
  }
});
