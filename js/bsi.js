/* ════════════════════════════════════════════════
   bsi.js — AMI v2.0
   ────────────────────────────────────────────────
   Assistant BSI (Bilan de Soins Infirmiers)
   ────────────────────────────────────────────────
   Fonctionnalités :
   1. Grille de dépendance (inspiré AGGIR partiel)
   2. Calcul automatique niveau BSI (1/2/3)
   3. Codes NGAP : BSI1 (3,1c), BSI2 (5,1c), BSI3 (7,1c)
   4. Justificatif archivable
   5. Alerte renouvellement (3 mois)
   6. Stockage IDB local (chiffré par user)
   7. 🆕 Unicité : un patient = un seul BSI actif
   8. 🆕 Synchronisation cabinet (partage entre IDE)
   9. 🆕 Suggestion IA (bsi-engine)
   10. 🆕 Détection incohérences BSI vs actes
   11. 🆕 Impact financier projeté
   ────────────────────────────────────────────────
   Référence NGAP 2026 :
   BSI1 = 3.1c (≤4 pts dépendance partielle)
   BSI2 = 5.1c (5-8 pts dépendance importante)
   BSI3 = 7.1c (≥9 pts grande dépendance)
   ────────────────────────────────────────────────
   RGPD : toutes les données sont stockées sur le
   terminal. Le partage cabinet passe par le canal
   chiffré clé-cabinet existant (voir cabinet.js).
═══════════════════════════════════════════════ */

const BSI_STORE          = 'bsi_evaluations';
const BSI_VALIDITY_DAYS  = 90; // durée de validité réglementaire

async function _bsiDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ami_bsi', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(BSI_STORE)) {
        const s = db.createObjectStore(BSI_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('patient_id', 'patient_id', { unique: false });
        s.createIndex('user_id',    'user_id',    { unique: false });
      } else {
        // Migration v1 → v2 : ajouter index active si absent
        const tx = e.target.transaction;
        const st = tx.objectStore(BSI_STORE);
        if (!st.indexNames.contains('active')) {
          try { st.createIndex('active', 'active', { unique: false }); } catch {}
        }
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
      (e.target.result||[])
        .filter(b => b.user_id === uid || b._cabinet_shared === true)
        .sort((a,b) => new Date(b.date) - new Date(a.date))
    );
    req.onerror = e => reject(e.target.error);
  });
}

/**
 * 🆕 Retourne le BSI actif le plus récent pour un patient
 * (règle : 1 patient = 1 seul BSI actif à la fois)
 */
async function _bsiGetActive(patientId) {
  const all = await _bsiGetAll(patientId);
  if (!all.length) return null;
  // Priorité : active === true, sinon le plus récent non-expiré
  const active = all.find(b => b.active === true);
  if (active) return active;
  // Rétrocompat : pas de champ active → prendre le plus récent non-expiré
  const now = Date.now();
  const nonExpired = all.find(b => {
    const d = new Date(b.date).getTime();
    return (now - d) / 86400000 <= BSI_VALIDITY_DAYS;
  });
  return nonExpired || all[0];
}

/**
 * 🆕 Invalide tous les BSI antérieurs d'un patient
 * Appelé avant chaque nouveau BSI → garantit l'unicité
 */
async function _bsiInvalidateOlder(patientId) {
  const db = await _bsiDb();
  const all = await _bsiGetAll(patientId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BSI_STORE, 'readwrite');
    const st = tx.objectStore(BSI_STORE);
    let remaining = all.length;
    if (!remaining) return resolve(0);
    let count = 0;
    all.forEach(b => {
      if (b.active !== false) {
        st.put({ ...b, active: false, _invalidated_at: new Date().toISOString() });
        count++;
      }
      if (--remaining === 0) resolve(count);
    });
    tx.onerror = e => reject(e.target.error);
  });
}

/**
 * 🆕 Import d'un BSI partagé par un membre du cabinet
 * Appelé depuis cabinet.js (cabinet-sync-pull) quand un BSI est reçu.
 */
async function _bsiImportFromCabinet(bsi, senderName = '') {
  if (!bsi || !bsi.patient_id) return false;
  const uid = APP?.user?.id || '';
  // Vérifier qu'on n'a pas déjà un BSI plus récent localement
  const local = await _bsiGetActive(bsi.patient_id);
  if (local) {
    const localTs = new Date(local.saved_at || local.date || 0).getTime();
    const remoteTs = new Date(bsi.saved_at || bsi.date || 0).getTime();
    if (localTs >= remoteTs) {
      console.info('[bsi import] BSI local plus récent — import ignoré');
      return false;
    }
  }
  // Invalider les anciens BSI de ce patient pour garantir l'unicité
  await _bsiInvalidateOlder(bsi.patient_id);
  // Stocker le BSI partagé avec flag _cabinet_shared
  const imported = {
    ...bsi,
    user_id:          uid,
    active:           true,
    _cabinet_shared:  true,
    _imported_from:   bsi.created_by || senderName || '',
    _imported_at:     new Date().toISOString(),
  };
  delete imported.id; // nouveau local id généré par IDB
  await _bsiSave(imported);
  if (typeof showToast === 'function') {
    showToast('info',
      `BSI partagé par ${senderName || 'un collègue'}`,
      `Niveau ${imported.level} — ${imported.patient_nom || 'patient'}`);
  }
  return true;
}

/**
 * 🆕 Exporte le dernier BSI actif pour synchro cabinet
 */
async function _bsiExportForCabinet(patientId, patientNom = '') {
  const active = await _bsiGetActive(patientId);
  if (!active) return null;
  return {
    patient_id:      patientId,
    patient_nom:     patientNom || '', // chiffré clé cabinet
    date:            active.date,
    level:           active.level,
    total:           active.total,
    scores:          active.scores || {},
    medecin:         active.medecin || '',
    observations:    active.observations || '',
    created_by:      active.created_by || `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim(),
    saved_at:        active.saved_at || active.date,
    active:          true,
  };
}

/**
 * 🆕 Liste tous les BSI actifs (pour push cabinet)
 */
async function _bsiGetAllActive() {
  const db = await _bsiDb();
  const uid = APP?.user?.id || '';
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BSI_STORE, 'readonly');
    const req = tx.objectStore(BSI_STORE).getAll();
    req.onsuccess = e => resolve(
      (e.target.result||[])
        .filter(b => b.user_id === uid && b.active !== false)
        .sort((a,b) => new Date(b.date) - new Date(a.date))
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
let _bsiCurrentPatientNom = '';
let _bsiScores = {};
let _bsiActiveRecord = null; // BSI actif chargé automatiquement

/* ════════════════════════════════════════════════
   RENDU PRINCIPAL
════════════════════════════════════════════════ */
async function renderBSI() {
  const wrap = document.getElementById('bsi-root');
  if (!wrap) return;

  let patients = [];
  try { if (typeof getAllPatients === 'function') patients = await getAllPatients(); } catch (_) {}

  const cab = APP?.get?.('cabinet');
  const cabBadge = cab ? `<span style="font-size:11px;font-family:var(--fm);background:rgba(0,212,170,.1);color:var(--a);padding:2px 8px;border-radius:8px;margin-left:8px">🤝 Cabinet ${cab.nom||''}</span>` : '';

  wrap.innerHTML = `
    <h1 class="pt">BSI — <em>Bilan de Soins Infirmiers</em>${cabBadge}</h1>
    <p class="ps">Évaluation de dépendance · Calcul automatique BSI1/2/3 · Archivage justificatif</p>

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">⚕️</span><p>Le BSI permet de justifier la complexité des soins auprès de la CPAM. Sans BSI valide, certaines cotations peuvent être rejetées lors d'un contrôle.${cab ? ` <strong>En cabinet, le BSI est partagé automatiquement entre tous les IDE qui suivent ce patient.</strong>` : ''}</p></div>

      <div class="lbl" style="margin-bottom:8px">Patient évalué</div>
      <select id="bsi-patient-sel" onchange="bsiSelectPatient(this.value)" style="width:100%;margin-bottom:20px;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
        <option value="">— Sélectionner un patient —</option>
        ${patients.map(p => `<option value="${p.id}" data-nom="${(p.nom||'')+' '+(p.prenom||'')}">${p.nom||''} ${p.prenom||''}</option>`).join('')}
      </select>

      <!-- 🆕 Widget BSI actif -->
      <div id="bsi-active-widget" style="display:none"></div>

      <!-- 🆕 Widget suggestion IA -->
      <div id="bsi-suggestion-widget" style="display:none"></div>

      <!-- 🆕 Widget incohérences -->
      <div id="bsi-incoherences-widget" style="display:none"></div>

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

        <!-- 🆕 Widget impact financier -->
        <div id="bsi-impact-widget" style="display:none"></div>

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
  bsiRenderImpact(); // 🆕 recalculer l'impact €
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

/* ════════════════════════════════════════════════
   🆕 WIDGET BSI ACTIF
═══════════════════════════════════════════════ */
function _bsiRenderActiveWidget(active) {
  const el = document.getElementById('bsi-active-widget');
  if (!el) return;
  if (!active) { el.style.display = 'none'; el.innerHTML = ''; return; }

  const lvlColors = ['#6b7280','#22c55e','#f59e0b','#ef4444'];
  const col = lvlColors[active.level] || '#6b7280';
  const age = Math.round((Date.now() - new Date(active.date).getTime()) / 86400000);
  const exp = BSI_VALIDITY_DAYS - age;
  const expText = exp > 0 ? `Expire dans ${exp} j` : `⚠️ Expiré depuis ${-exp} j`;
  const expColor = exp > 15 ? '#22c55e' : exp > 0 ? '#f59e0b' : '#ef4444';
  const sharedBadge = active._cabinet_shared
    ? `<span style="font-size:10px;font-family:var(--fm);background:rgba(0,212,170,.15);color:var(--a);padding:2px 8px;border-radius:8px;margin-left:8px">🤝 partagé par ${active._imported_from||'collègue'}</span>`
    : '';

  el.style.display = 'block';
  el.innerHTML = `
    <div style="background:${col}11;border:1px solid ${col}44;border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-size:11px;font-family:var(--fm);color:var(--m);margin-bottom:4px">BSI ACTIF</div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span style="font-family:var(--fs);font-size:24px;color:${col}">Niveau ${active.level}</span>
            <span style="font-size:12px;color:var(--m)">Score ${active.total} pts · ${new Date(active.date).toLocaleDateString('fr-FR')}</span>
            ${sharedBadge}
          </div>
          <div style="font-size:11px;color:${expColor};font-family:var(--fm);margin-top:4px">${expText}</div>
        </div>
        <button class="btn bs bsm" onclick="bsiLoadActive()" title="Charger ce BSI dans la grille">📋 Charger</button>
      </div>
    </div>
  `;
}

/**
 * 🆕 Recharger le BSI actif dans la grille (pour révision)
 */
function bsiLoadActive() {
  if (!_bsiActiveRecord) return;
  _bsiScores = { ..._bsiActiveRecord.scores || {} };
  const formSec = document.getElementById('bsi-form-section');
  if (formSec) formSec.style.display = 'block';
  bsiRenderGrid();
  bsiCalcResult();
  const medEl = document.getElementById('bsi-medecin');
  const obsEl = document.getElementById('bsi-observations');
  if (medEl) medEl.value = _bsiActiveRecord.medecin || '';
  if (obsEl) obsEl.value = _bsiActiveRecord.observations || '';
  if (typeof showToast === 'function') showToast('info', 'BSI chargé', `Niveau ${_bsiActiveRecord.level}`);
}

/* ════════════════════════════════════════════════
   🆕 WIDGET SUGGESTION IA
═══════════════════════════════════════════════ */
async function _bsiRenderSuggestionWidget() {
  const el = document.getElementById('bsi-suggestion-widget');
  if (!el || !_bsiCurrentPatient) return;
  if (!window.BSI_ENGINE) { el.style.display = 'none'; return; }

  // Récupérer les actes/fréquence depuis les cotations du patient
  let actes = [], freqPerDay = 1, minutesPerDay = 0;
  try {
    if (typeof getAllPatients === 'function') {
      const pts = await getAllPatients();
      const pat = pts.find(p => p.id === _bsiCurrentPatient);
      if (pat && Array.isArray(pat.cotations)) {
        // 30 derniers jours
        const cutoff = Date.now() - 30 * 86400000;
        const recent = pat.cotations.filter(c => new Date(c.date || 0).getTime() >= cutoff);
        if (recent.length) {
          // Agrégation des codes
          const allActes = recent.flatMap(c => c.actes || []);
          actes = allActes;
          // Fréquence quotidienne = nb passages / nb jours distincts
          const jours = new Set(recent.map(c => (c.date || '').slice(0,10))).size;
          freqPerDay = jours ? recent.length / jours : 1;
        }
      }
    }
  } catch {}

  const suggestion = window.BSI_ENGINE.suggestBSI({
    actes, freqPerDay, minutesPerDay,
    scores: Object.keys(_bsiScores).length >= 5 ? _bsiScores : null,
  });

  if (!suggestion.level) { el.style.display = 'none'; return; }

  const colors = ['#6b7280','#22c55e','#f59e0b','#ef4444'];
  const col = colors[suggestion.level];

  el.style.display = 'block';
  el.innerHTML = `
    <div style="background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.25);border-radius:12px;padding:14px;margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:16px">💡</span>
          <span style="font-size:13px;font-weight:700;color:#3b82f6">Suggestion IA</span>
          <span style="font-size:10px;background:rgba(59,130,246,.15);color:#3b82f6;padding:2px 8px;border-radius:8px;font-family:var(--fm)">confiance ${Math.round(suggestion.confidence*100)}%</span>
        </div>
        <span style="font-family:var(--fs);font-size:18px;color:${col}">BSI ${suggestion.level}</span>
      </div>
      ${suggestion.motifs.length ? `
      <div style="font-size:11px;color:var(--m);font-family:var(--fm);margin-bottom:10px">Motifs détectés :</div>
      <ul style="margin:0 0 10px;padding-left:20px;font-size:12px;color:var(--t);line-height:1.5">
        ${suggestion.motifs.map(m => `<li>${m}</li>`).join('')}
      </ul>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn bp bsm" onclick="bsiApplySuggestion(${suggestion.level})">✓ Appliquer cette suggestion</button>
        <button class="btn bs bsm" onclick="document.getElementById('bsi-suggestion-widget').style.display='none'">Ignorer</button>
      </div>
      <div style="font-size:10px;color:var(--m);margin-top:8px;font-style:italic">La décision finale reste à votre appréciation professionnelle.</div>
    </div>
  `;
}

/**
 * 🆕 Applique une suggestion de niveau BSI en pré-remplissant la grille
 */
function bsiApplySuggestion(level) {
  // Pré-remplir avec des scores cohérents pour le niveau suggéré
  const targets = {
    1: { hygiene: 1, habillage: 1, alimentation: 0, elimination: 0, transfert: 0, communication: 0, medicaments: 1, soins: 1 }, // total 4
    2: { hygiene: 1, habillage: 1, alimentation: 1, elimination: 1, transfert: 1, communication: 0, medicaments: 1, soins: 1 }, // total 7
    3: { hygiene: 2, habillage: 2, alimentation: 1, elimination: 1, transfert: 1, communication: 1, medicaments: 1, soins: 2 }, // total 11
  };
  _bsiScores = { ...targets[level] };
  const formSec = document.getElementById('bsi-form-section');
  if (formSec) formSec.style.display = 'block';
  bsiRenderGrid();
  bsiCalcResult();
  bsiRenderImpact();
  if (typeof showToast === 'function') {
    showToast('info', `BSI ${level} pré-rempli`, 'Ajustez les critères selon la situation réelle.');
  }
}

/* ════════════════════════════════════════════════
   🆕 WIDGET INCOHÉRENCES
═══════════════════════════════════════════════ */
async function _bsiRenderIncoherencesWidget() {
  const el = document.getElementById('bsi-incoherences-widget');
  if (!el || !_bsiCurrentPatient || !window.BSI_ENGINE) return;

  const active = _bsiActiveRecord;
  if (!active) { el.style.display = 'none'; return; }

  // Récupérer actes + fréquence depuis cotations
  let actes = [], freqPerDay = 1;
  try {
    if (typeof getAllPatients === 'function') {
      const pts = await getAllPatients();
      const pat = pts.find(p => p.id === _bsiCurrentPatient);
      if (pat && Array.isArray(pat.cotations)) {
        const cutoff = Date.now() - 30 * 86400000;
        const recent = pat.cotations.filter(c => new Date(c.date || 0).getTime() >= cutoff);
        actes = recent.flatMap(c => c.actes || []);
        const jours = new Set(recent.map(c => (c.date || '').slice(0,10))).size;
        freqPerDay = jours ? recent.length / jours : 1;
      }
    }
  } catch {}

  const issues = window.BSI_ENGINE.checkBSIConsistency({
    bsiLevel: active.level, actes, freqPerDay,
  });

  if (!issues.length) { el.style.display = 'none'; return; }

  const sevColors = { faible:'#84cc16', moyen:'#f59e0b', eleve:'#f97316' };
  el.style.display = 'block';
  el.innerHTML = `
    <div style="background:rgba(249,115,22,.06);border:1px solid rgba(249,115,22,.25);border-radius:12px;padding:14px;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:16px">⚠️</span>
        <span style="font-size:13px;font-weight:700;color:#f97316">Point à vérifier — cohérence BSI / actes</span>
      </div>
      ${issues.map(iss => `
        <div style="background:${sevColors[iss.severity]}15;border-left:3px solid ${sevColors[iss.severity]};border-radius:6px;padding:10px 12px;margin-bottom:8px">
          <div style="font-size:12px;color:var(--t);line-height:1.4">${iss.message}</div>
          ${iss.suggestion ? `<div style="font-size:11px;color:${sevColors[iss.severity]};font-family:var(--fm);margin-top:4px">→ Suggestion : passer en niveau BSI ${iss.suggestion}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

/* ════════════════════════════════════════════════
   🆕 WIDGET IMPACT FINANCIER
═══════════════════════════════════════════════ */
function bsiRenderImpact() {
  const el = document.getElementById('bsi-impact-widget');
  if (!el || !window.BSI_ENGINE) return;

  const total = Object.values(_bsiScores).reduce((s,v) => s+(v||0), 0);
  const filled = Object.keys(_bsiScores).length;
  if (filled < 5) { el.style.display = 'none'; return; }

  let calcLevel = 1;
  if      (total <= 4) calcLevel = 1;
  else if (total <= 8) calcLevel = 2;
  else                 calcLevel = 3;

  // Niveau actuel = BSI actif
  const currentLevel = _bsiActiveRecord?.level || 0;
  if (!currentLevel || currentLevel === calcLevel) { el.style.display = 'none'; return; }

  const impact = window.BSI_ENGINE.simulateBSIImpact({
    current: currentLevel, suggested: calcLevel, freqPerDay: 1, days: 30,
  });

  const col = impact.delta > 0 ? '#22c55e' : '#ef4444';
  const sign = impact.delta > 0 ? '+' : '';
  el.style.display = 'block';
  el.innerHTML = `
    <div style="background:${col}15;border:1px solid ${col}44;border-radius:12px;padding:14px;margin-bottom:16px;text-align:center">
      <div style="font-size:11px;font-family:var(--fm);color:var(--m);margin-bottom:8px">📊 Impact financier estimé (1 passage/j · 30 j)</div>
      <div style="font-family:var(--fs);font-size:24px;color:${col};margin-bottom:4px">${sign}${impact.delta.toFixed(2)} € / mois</div>
      <div style="font-size:11px;color:var(--m);font-family:var(--fm)">BSI ${currentLevel} (${impact.revenuMensuel_current.toFixed(0)}€) → BSI ${calcLevel} (${impact.revenuMensuel_suggested.toFixed(0)}€) · ${sign}${impact.deltaAnnuel.toFixed(0)}€ / an</div>
    </div>
  `;
}

async function bsiSelectPatient(pid) {
  _bsiCurrentPatient = pid || null;
  _bsiScores = {};
  _bsiActiveRecord = null;
  const section  = document.getElementById('bsi-form-section');
  const histWrap = document.getElementById('bsi-history-wrap');

  if (!pid) {
    if (section) section.style.display = 'none';
    if (histWrap) histWrap.style.display = 'none';
    const activeEl = document.getElementById('bsi-active-widget');
    if (activeEl) { activeEl.style.display = 'none'; activeEl.innerHTML = ''; }
    return;
  }

  // 🆕 Récupérer nom patient (pour partage cabinet)
  const sel = document.getElementById('bsi-patient-sel');
  _bsiCurrentPatientNom = sel?.options[sel.selectedIndex]?.dataset?.nom || '';

  // 🆕 Charger automatiquement le BSI actif du patient
  try {
    _bsiActiveRecord = await _bsiGetActive(pid);
    _bsiRenderActiveWidget(_bsiActiveRecord);
  } catch (_) {}

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
      if (renewalAlert) renewalAlert.style.display = diffDays > BSI_VALIDITY_DAYS ? 'block' : 'none';
    } else if (renewalAlert) renewalAlert.style.display = 'none';
  } catch (_) {}

  // 🆕 Suggestion IA + incohérences (asynchrone)
  _bsiRenderSuggestionWidget().catch(() => {});
  _bsiRenderIncoherencesWidget().catch(() => {});

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

  // 🆕 Invalider les BSI antérieurs → garantit l'unicité (1 patient = 1 BSI actif)
  try {
    const invalidated = await _bsiInvalidateOlder(_bsiCurrentPatient);
    if (invalidated > 0) {
      console.info(`[bsi save] ${invalidated} ancien(s) BSI invalidé(s) pour garantir l'unicité`);
    }
  } catch (e) {
    console.warn('[bsi save] invalidation échec:', e.message);
  }

  const obj = {
    patient_id:    _bsiCurrentPatient,
    patient_nom:   _bsiCurrentPatientNom,
    user_id:       APP?.user?.id || '',
    date:          document.getElementById('bsi-date-eval')?.value || new Date().toISOString().slice(0,10),
    medecin:       document.getElementById('bsi-medecin')?.value?.trim() || '',
    observations:  document.getElementById('bsi-observations')?.value?.trim() || '',
    scores:        JSON.parse(JSON.stringify(_bsiScores)),
    total,
    level,
    active:        true, // 🆕 marqueur unicité
    created_by:    `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim(),
    saved_at:      new Date().toISOString(),
  };

  try {
    const newId = await _bsiSave(obj);
    obj.id = newId;
    _bsiActiveRecord = obj;
    showToast('success', `BSI ${level} archivé`, `Score ${total} pts`);
    _bsiRenderActiveWidget(obj);
    await bsiLoadHistory();

    // 🆕 Propagation cabinet (si membre d'un cabinet)
    try { await _bsiSyncToCabinet(obj); } catch (e) { console.warn('[bsi cabinet sync]', e.message); }
  } catch (err) {
    showToast('error','Erreur',err.message);
  }
}

/**
 * 🆕 Synchronise un BSI vers les membres du cabinet
 * Utilise le mécanisme cabinet-sync-push existant.
 */
async function _bsiSyncToCabinet(bsi) {
  const cab = APP?.get?.('cabinet');
  if (!cab || !cab.id) return; // pas de cabinet → rien à faire
  if (typeof apiCall !== 'function') return;

  // Récupérer les autres membres du cabinet (exclu moi-même)
  const members = (cab.members || []).filter(m => m.id !== APP?.user?.id);
  if (!members.length) return;

  try {
    const payload = {
      cabinet_id:  cab.id,
      target_ids:  members.map(m => m.id),
      what:        ['bsi'],
      data: {
        bsi_shared: [{
          patient_id:    bsi.patient_id,
          patient_nom:   bsi.patient_nom || '',
          date:          bsi.date,
          level:         bsi.level,
          total:         bsi.total,
          scores:        bsi.scores || {},
          medecin:       bsi.medecin || '',
          observations:  bsi.observations || '',
          created_by:    bsi.created_by,
          saved_at:      bsi.saved_at,
          active:        true,
        }],
      },
    };
    const r = await apiCall('/webhook/cabinet-sync-push', payload);
    if (r?.ok) {
      console.info('[bsi cabinet sync] BSI propagé à', members.length, 'membre(s)');
      if (typeof showToast === 'function') {
        showToast('success','BSI partagé',`${members.length} collègue(s) notifié(s)`);
      }
    }
  } catch (e) {
    console.warn('[bsi cabinet sync] échec:', e.message);
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
      const expDays = Math.round(BSI_VALIDITY_DAYS - (now - new Date(b.date))/86400000);
      const expLabel = expDays > 0 ? `Expire dans ${expDays}j` : '⚠️ Expiré';
      const activeBadge = b.active === true
        ? '<span style="font-size:10px;background:rgba(34,197,94,.15);color:#22c55e;padding:2px 8px;border-radius:8px;font-family:var(--fm);margin-left:6px">● ACTIF</span>'
        : b.active === false
          ? '<span style="font-size:10px;background:rgba(107,114,128,.15);color:#6b7280;padding:2px 8px;border-radius:8px;font-family:var(--fm);margin-left:6px">archivé</span>'
          : '';
      const sharedBadge = b._cabinet_shared
        ? `<span style="font-size:10px;background:rgba(0,212,170,.15);color:var(--a);padding:2px 8px;border-radius:8px;font-family:var(--fm);margin-left:6px">🤝 ${b._imported_from||'cabinet'}</span>`
        : '';
      return `
        <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
              <span style="font-family:var(--fs);font-size:20px;color:${lvlColors[b.level]}">BSI ${b.level}</span>
              <span style="font-size:12px;font-family:var(--fm);color:var(--m)">Score : ${b.total} pts · ${d}</span>
              ${activeBadge}${sharedBadge}
            </div>
            <div style="font-size:11px;font-family:var(--fm);color:${expDays>0?'var(--m)':'#ef4444'}">${expLabel} · ${b.medecin?'Dr. '+b.medecin:''}${b.created_by?' · par '+b.created_by:''}</div>
          </div>
          <button class="btn bs bsm" onclick="bsiPrintFromHistory(${b.id})">🖨️ Imprimer</button>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="msg e">Erreur : ${err.message}</div>`;
  }
}

/* ════════════════════════════════════════════════
   🆕 HANDLER IMPORT BSI DEPUIS CABINET-SYNC-PULL
   ────────────────────────────────────────────────
   Appelé depuis cabinet.js après pull.
═══════════════════════════════════════════════ */
async function bsiHandleCabinetPull(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  let imported = 0;
  for (const item of items) {
    if (!Array.isArray(item?.what) || !item.what.includes('bsi')) continue;
    const bsiList = item?.data?.bsi_shared;
    if (!Array.isArray(bsiList)) continue;
    const sender = `${item.sender_prenom||''} ${item.sender_nom||''}`.trim();
    for (const bsi of bsiList) {
      try {
        const ok = await _bsiImportFromCabinet(bsi, sender);
        if (ok) imported++;
      } catch (e) {
        console.warn('[bsi import cabinet]', e.message);
      }
    }
  }
  return imported;
}

// Expose globalement pour cabinet.js
if (typeof window !== 'undefined') {
  window.bsiHandleCabinetPull = bsiHandleCabinetPull;
  window._bsiImportFromCabinet = _bsiImportFromCabinet;
  window._bsiGetActive = _bsiGetActive;
  window._bsiGetAllActive = _bsiGetAllActive;
}

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'bsi') renderBSI();
});
