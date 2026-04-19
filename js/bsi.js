/* ════════════════════════════════════════════════
   bsi.js — AMI v1.0
   ────────────────────────────────────────────────
   Assistant BSI (Bilan de Soins Infirmiers)
   ────────────────────────────────────────────────
   Fonctionnalités :
   1. Grille de dépendance (inspiré AGGIR partiel)
   2. Calcul automatique niveau BSI (1/2/3)
   3. Codes NGAP générés : BSI1 (3,1c), BSI2 (5,1c), BSI3 (7,1c)
   4. Justificatif archivable avec signature
   5. Alerte renouvellement (tous les 3 mois)
   6. Stockage IDB local
   ────────────────────────────────────────────────
   Référence NGAP 2026 :
   BSI1 = 3.1c (≤4 pts dépendance partielle)
   BSI2 = 5.1c (5-8 pts dépendance importante)
   BSI3 = 7.1c (≥9 pts grande dépendance)
════════════════════════════════════════════════ */

const BSI_STORE = 'bsi_evaluations';

async function _bsiDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ami_bsi', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(BSI_STORE)) {
        const s = db.createObjectStore(BSI_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('patient_id', 'patient_id', { unique: false });
        s.createIndex('user_id',    'user_id',    { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _bsiSave(obj) {
  const db = await _bsiDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BSI_STORE, 'readwrite');
    const req = tx.objectStore(BSI_STORE).put(obj);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _bsiGetAll(patientId) {
  const db  = await _bsiDb();
  const uid = APP?.user?.id || '';
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(BSI_STORE, 'readonly');
    const idx = tx.objectStore(BSI_STORE).index('patient_id');
    const req = idx.getAll(patientId);
    req.onsuccess = e => resolve(
      (e.target.result||[]).filter(b => b.user_id === uid).sort((a,b) => new Date(b.date) - new Date(a.date))
    );
    req.onerror = e => reject(e.target.error);
  });
}

/* ── Grille de dépendance (simplifié AGGIR) ── */
const BSI_ITEMS = [
  { id: 'hygiene',     label: 'Hygiène corporelle',       desc: 'Toilette, soins d\'hygiène' },
  { id: 'habillage',   label: 'Habillage / déshabillage',  desc: 'Haut et bas du corps' },
  { id: 'alimentation',label: 'Alimentation / hydratation',desc: 'Préparation et prise des repas' },
  { id: 'elimination', label: 'Élimination urinaire/fécale',desc: 'Continence, changes, stomie' },
  { id: 'transfert',   label: 'Transfert / déplacement',  desc: 'Lever, coucher, déplacements' },
  { id: 'communication',label:'Communication / comportement',desc: 'Orienté, troubles cognitifs' },
  { id: 'medicaments', label: 'Prise médicaments',         desc: 'Autonomie pour les traitements' },
  { id: 'soins',       label: 'Soins techniques infirmiers',desc: 'Pansements, injections, perfusions' },
  { id: 'surveillance',label: 'Surveillance état clinique', desc: 'Monitoring, constantes, signaux' },
  { id: 'prevention',  label: 'Prévention complications',  desc: 'Escarres, chutes, dénutrition' },
];

const BSI_LEVELS = [
  { val: 0, label: 'Autonome', color: '#22c55e', pts: 0 },
  { val: 1, label: 'Partiellement dépendant', color: '#f59e0b', pts: 1 },
  { val: 2, label: 'Totalement dépendant', color: '#ef4444', pts: 2 },
];

let _bsiCurrentPatient = null;
let _bsiScores = {};

/* ════════════════════════════════════════════════
   RENDU PRINCIPAL
════════════════════════════════════════════════ */
async function renderBSI() {
  const wrap = document.getElementById('view-bsi');
  if (!wrap) return;

  let patients = [];
  try { if (typeof getAllPatients === 'function') patients = await getAllPatients(); } catch (_) {}

  wrap.innerHTML = `
    <h1 class="pt">BSI — <em>Bilan de Soins Infirmiers</em></h1>
    <p class="ps">Évaluation de dépendance · Calcul automatique BSI1/2/3 · Archivage justificatif</p>

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">⚕️</span><p>Le BSI permet de justifier la complexité des soins auprès de la CPAM. Sans BSI valide, certaines cotations peuvent être rejetées lors d'un contrôle.</p></div>

      <div class="lbl" style="margin-bottom:8px">Patient évalué</div>
      <select id="bsi-patient-sel" onchange="bsiSelectPatient(this.value)" style="width:100%;margin-bottom:20px;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
        <option value="">— Sélectionner un patient —</option>
        ${patients.map(p => `<option value="${p.id}">${p.nom||''} ${p.prenom||''}</option>`).join('')}
      </select>

      <div id="bsi-form-section" style="display:none">
        <!-- Rappel renouvellement -->
        <div id="bsi-renewal-alert" style="display:none;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px;color:var(--w)">
          ⏰ <strong>Renouvellement requis :</strong> Le dernier BSI date de plus de 3 mois — une nouvelle évaluation est nécessaire.
        </div>

        <!-- Grille dépendance -->
        <div class="lbl" style="margin-bottom:12px">📋 Grille d'évaluation de dépendance</div>
        <div style="font-size:12px;color:var(--m);margin-bottom:14px;font-family:var(--fm)">Pour chaque item, évaluez le niveau d'autonomie du patient.</div>

        <div id="bsi-grid" style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px"></div>

        <!-- Résultat BSI en temps réel -->
        <div id="bsi-result-box" style="background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.2);border-radius:12px;padding:20px;margin-bottom:16px;text-align:center">
          <div style="font-size:12px;font-family:var(--fm);color:var(--m);margin-bottom:8px">Niveau calculé</div>
          <div id="bsi-level-display" style="font-family:var(--fs);font-size:36px;color:var(--a)">—</div>
          <div id="bsi-code-display" style="font-size:13px;color:var(--m);margin-top:6px">Saisissez la grille ci-dessus</div>
          <div id="bsi-score-display" style="font-size:11px;color:var(--m);font-family:var(--fm);margin-top:4px"></div>
        </div>

        <!-- Informations complémentaires -->
        <div class="fg" style="margin-bottom:16px">
          <div class="f"><label>Médecin prescripteur</label><input type="text" id="bsi-medecin" placeholder="Dr. ..."></div>
          <div class="f"><label>Date d'évaluation</label><input type="date" id="bsi-date-eval" value="${new Date().toISOString().slice(0,10)}"></div>
          <div class="f" style="grid-column:1/-1"><label>Observations cliniques</label><textarea id="bsi-observations" placeholder="Contexte clinique, pathologies justifiant la dépendance..." style="min-height:80px;resize:vertical"></textarea></div>
        </div>

        <div class="ar-row">
          <button class="btn bp" onclick="bsiSave()"><span>💾</span> Archiver l'évaluation</button>
          <button class="btn bv" onclick="bsiGenerateCotation()"><span>⚡</span> Générer la cotation</button>
          <button class="btn bs" onclick="bsiPrint()"><span>🖨️</span> Imprimer</button>
        </div>
      </div>
    </div>

    <!-- Historique BSI -->
    <div id="bsi-history-wrap" class="card" style="display:none">
      <div class="lbl" style="margin-bottom:14px">📋 Historique des BSI</div>
      <div id="bsi-history-list"></div>
    </div>
  `;
}

function bsiRenderGrid() {
  const el = document.getElementById('bsi-grid');
  if (!el) return;
  el.innerHTML = BSI_ITEMS.map(item => `
    <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px">
      <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div style="font-size:13px;font-weight:600;color:var(--t);margin-bottom:2px">${item.label}</div>
          <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${item.desc}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          ${BSI_LEVELS.map(lv => `
            <label style="display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;padding:6px 10px;border-radius:8px;border:1px solid ${(_bsiScores[item.id]===lv.val)?lv.color:'var(--b)'};background:${(_bsiScores[item.id]===lv.val)?`${lv.color}22`:'transparent'};transition:all .15s" onclick="_bsiSetScore('${item.id}',${lv.val})">
              <input type="radio" name="bsi-${item.id}" value="${lv.val}" ${_bsiScores[item.id]===lv.val?'checked':''} style="accent-color:${lv.color};width:16px;height:16px">
              <span style="font-size:10px;font-family:var(--fm);color:${(_bsiScores[item.id]===lv.val)?lv.color:'var(--m)'};text-align:center;max-width:70px;line-height:1.2">${lv.label}</span>
            </label>`).join('')}
        </div>
      </div>
    </div>`).join('');
}

function _bsiSetScore(itemId, val) {
  _bsiScores[itemId] = val;
  bsiRenderGrid();
  bsiCalcResult();
}

function bsiCalcResult() {
  const total = Object.values(_bsiScores).reduce((s, v) => s + (v||0), 0);
  const filled = Object.keys(_bsiScores).length;

  let level = null, code = '', coeff = 0, color = '#a0bbd0';
  if (filled >= 5) {
    if (total <= 4)  { level = 'BSI 1'; code = 'BSI 1 — 3,1c'; coeff = 3.1; color = '#22c55e'; }
    else if (total <= 8) { level = 'BSI 2'; code = 'BSI 2 — 5,1c'; coeff = 5.1; color = '#f59e0b'; }
    else              { level = 'BSI 3'; code = 'BSI 3 — 7,1c'; coeff = 7.1; color = '#ef4444'; }
  }

  const lvlEl  = document.getElementById('bsi-level-display');
  const codeEl = document.getElementById('bsi-code-display');
  const scoreEl= document.getElementById('bsi-score-display');
  if (lvlEl)  { lvlEl.textContent = level || '—'; lvlEl.style.color = color; }
  if (codeEl) { codeEl.textContent = level ? `${code} · ≈ ${(coeff * 3.15).toFixed(2)} €` : 'Évaluez au moins 5 critères'; }
  if (scoreEl){ scoreEl.textContent = filled ? `Score total : ${total} pts sur ${filled} critères évalués` : ''; }
}

async function bsiSelectPatient(pid) {
  _bsiCurrentPatient = pid || null;
  _bsiScores = {};
  const section  = document.getElementById('bsi-form-section');
  const histWrap = document.getElementById('bsi-history-wrap');

  if (!pid) {
    if (section) section.style.display = 'none';
    if (histWrap) histWrap.style.display = 'none';
    return;
  }

  if (section) section.style.display = 'block';
  bsiRenderGrid();
  bsiCalcResult();

  // Vérifier renouvellement
  try {
    const hist = await _bsiGetAll(pid);
    const renewalAlert = document.getElementById('bsi-renewal-alert');
    if (hist.length) {
      const lastDate = new Date(hist[0].date);
      const now = new Date();
      const diffDays = (now - lastDate) / 86400000;
      if (renewalAlert) renewalAlert.style.display = diffDays > 90 ? 'block' : 'none';
    } else if (renewalAlert) renewalAlert.style.display = 'none';
  } catch (_) {}

  if (histWrap) histWrap.style.display = 'block';
  await bsiLoadHistory();
}

async function bsiSave() {
  if (!_bsiCurrentPatient) { showToast('warning','Patient requis'); return; }
  const total = Object.values(_bsiScores).reduce((s,v) => s+(v||0), 0);
  if (Object.keys(_bsiScores).length < 5) { showToast('warning','Évaluation incomplète','Évaluez au moins 5 critères.'); return; }

  let level = 1;
  if (total <= 4) level = 1;
  else if (total <= 8) level = 2;
  else level = 3;

  const obj = {
    patient_id:    _bsiCurrentPatient,
    user_id:       APP?.user?.id || '',
    date:          document.getElementById('bsi-date-eval')?.value || new Date().toISOString().slice(0,10),
    medecin:       document.getElementById('bsi-medecin')?.value?.trim() || '',
    observations:  document.getElementById('bsi-observations')?.value?.trim() || '',
    scores:        JSON.parse(JSON.stringify(_bsiScores)),
    total,
    level,
  };

  try {
    await _bsiSave(obj);
    showToast('success', `BSI ${level} archivé`, `Score ${total} pts`);
    await bsiLoadHistory();
  } catch (err) {
    showToast('error','Erreur',err.message);
  }
}

function bsiGenerateCotation() {
  const total = Object.values(_bsiScores).reduce((s,v)=>s+(v||0),0);
  if (Object.keys(_bsiScores).length < 5) { showToast('warning','Grille incomplète'); return; }
  let bsiN = 1;
  if (total <= 4) bsiN=1; else if (total<=8) bsiN=2; else bsiN=3;
  const codes = ['','BSI 1 - Bilan de soins infirmiers niveau 1','BSI 2 - Bilan de soins infirmiers niveau 2','BSI 3 - Bilan de soins infirmiers niveau 3'];
  // Injecter dans le formulaire de cotation
  if (typeof navTo === 'function') navTo('cot', null);
  setTimeout(() => {
    const fTxt = document.getElementById('f-txt');
    if (fTxt) {
      fTxt.value = codes[bsiN];
      if (typeof renderLiveReco === 'function') renderLiveReco(fTxt.value);
    }
    showToast('info','Cotation BSI pré-remplie', `BSI niveau ${bsiN}`);
  }, 300);
}

function bsiPrint() {
  const total = Object.values(_bsiScores).reduce((s,v)=>s+(v||0),0);
  let level = total<=4?1:total<=8?2:3;
  const patSel = document.getElementById('bsi-patient-sel');
  const patNom = patSel?.options[patSel.selectedIndex]?.text || 'Patient';

  const w = window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>BSI AMI</title>
    <style>body{font-family:Arial,sans-serif;padding:20px;color:#000;max-width:700px;margin:0 auto}h1{font-size:18px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ccc;padding:8px;font-size:12px}th{background:#f0f0f0}@media print{@page{margin:15mm}}</style>
    </head><body>
    <h1>🩺 Bilan de Soins Infirmiers — AMI</h1>
    <p><strong>Patient :</strong> ${patNom} · <strong>Date :</strong> ${document.getElementById('bsi-date-eval')?.value||'—'} · <strong>Médecin :</strong> ${document.getElementById('bsi-medecin')?.value||'—'}</p>
    <h2>Résultat : BSI Niveau ${level} (score ${total}/20)</h2>
    <table><thead><tr><th>Critère</th><th>Niveau</th><th>Score</th></tr></thead><tbody>
    ${BSI_ITEMS.map(i => { const v=_bsiScores[i.id]||0; return `<tr><td>${i.label}</td><td>${BSI_LEVELS[v].label}</td><td>${v}</td></tr>`; }).join('')}
    <tr style="font-weight:bold"><td colspan="2">TOTAL</td><td>${total}</td></tr>
    </tbody></table>
    <p><strong>Observations :</strong> ${document.getElementById('bsi-observations')?.value||'—'}</p>
    <p style="font-size:10px;color:#888">Généré par AMI · BSI NGAP 2026</p>
    </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

async function bsiLoadHistory() {
  if (!_bsiCurrentPatient) return;
  const list = document.getElementById('bsi-history-list');
  if (!list) return;
  try {
    const all = await _bsiGetAll(_bsiCurrentPatient);
    if (!all.length) { list.innerHTML = '<div class="empty"><p>Aucun BSI enregistré.</p></div>'; return; }
    const lvlColors = ['','#22c55e','#f59e0b','#ef4444'];
    list.innerHTML = all.slice(0,10).map(b => {
      const d = new Date(b.date).toLocaleDateString('fr-FR');
      const now = new Date();
      const expDays = Math.round(90 - (now - new Date(b.date))/86400000);
      const expLabel = expDays > 0 ? `Expire dans ${expDays}j` : '⚠️ Expiré';
      return `
        <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-family:var(--fs);font-size:20px;color:${lvlColors[b.level]}">BSI ${b.level}</span>
              <span style="font-size:12px;font-family:var(--fm);color:var(--m)">Score : ${b.total} pts · ${d}</span>
            </div>
            <div style="font-size:11px;font-family:var(--fm);color:${expDays>0?'var(--m)':'#ef4444'}">${expLabel} · ${b.medecin?'Dr. '+b.medecin:''}</div>
          </div>
          <button class="btn bs bsm" onclick="bsiPrintFromHistory(${b.id})">🖨️ Imprimer</button>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="msg e">Erreur : ${err.message}</div>`;
  }
}

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'bsi') renderBSI();
});
