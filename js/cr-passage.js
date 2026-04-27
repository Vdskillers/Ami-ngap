/* ════════════════════════════════════════════════
   cr-passage.js — AMI v1.0
   ────────────────────────────────────────────────
   Module Compte-rendu de Passage
   ────────────────────────────────────────────────
   Génère un CR structuré : actes réalisés,
   observations, constantes, transmissions
   Exportable PDF pour médecin ou entourage
   ────────────────────────────────────────────────
   ⚡ Extrait de audit-cpam.js (refactor)
   ════════════════════════════════════════════════ */

/* ──────────────────────────────────────────────
   COMPTE-RENDU DE PASSAGE
   ────────────────────────────────────────────── */

const CR_STORE = 'comptes_rendus';

async function _crDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ami_cr', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CR_STORE)) {
        const s = db.createObjectStore(CR_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('patient_id', 'patient_id', { unique: false });
        s.createIndex('user_id',    'user_id',    { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _crSave(obj) {
  const db = await _crDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CR_STORE, 'readwrite');
    const req = tx.objectStore(CR_STORE).put(obj);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

/* ════════════════════════════════════════════════════════════════
   🆕 SYNC INTER-APPAREILS CR-PASSAGE — v8.9 / Livraison 3
   ────────────────────────────────────────────────────────────────
   Synchronise tous les comptes-rendus de passage de l'utilisateur
   entre ses appareils via la table Supabase cr_passage_sync.
   Pattern identique à BSI : 1 blob chiffré par user, clé dérivée userId.

   Endpoints worker :
     POST /webhook/cr-passage-push   { encrypted_data, updated_at }
     POST /webhook/cr-passage-pull   → { ok, data: { encrypted_data, updated_at } }

   Intégration boot-sync :
     Le module 'cr_passage' est inclus dans /webhook/boot-sync.
     crSyncPull() tente d'abord boot-sync, fallback cr-passage-pull.
═══════════════════════════════════════════════════════════════ */

function _crSyncKey() {
  const uid = APP?.user?.id || APP?.user?.email || S?.user?.id || S?.user?.email || 'local';
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (Math.imul(31, h) + uid.charCodeAt(i)) | 0;
  return 'sk_cr_' + String(Math.abs(h));
}
function _crEnc(obj) {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(obj) + '|' + _crSyncKey()))); } catch { return null; }
}
function _crDec(str) {
  try {
    const raw = decodeURIComponent(escape(atob(str)));
    const sep = raw.lastIndexOf('|');
    return JSON.parse(raw.slice(0, sep));
  } catch { return null; }
}

/** Récupère TOUS les CR de l'IDB (tous patients confondus) pour le push */
async function _crGetAllForSync() {
  const db = await _crDb();
  const uid = APP?.user?.id || S?.user?.id || '';
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(CR_STORE, 'readonly');
    const req = tx.objectStore(CR_STORE).getAll();
    req.onsuccess = e => resolve(
      (e.target.result || []).filter(cr => cr.user_id === uid)
    );
    req.onerror = e => reject(e.target.error);
  });
}

/** Push : chiffre tous les CR locaux et les envoie au serveur */
async function crSyncPush() {
  if (typeof S === 'undefined' || !S?.token) return;
  if (typeof wpost !== 'function') return;
  try {
    const all = await _crGetAllForSync();
    if (!all.length) return;
    const encrypted_data = _crEnc(all);
    if (!encrypted_data) return;
    await wpost('/webhook/cr-passage-push', {
      encrypted_data,
      updated_at: new Date().toISOString(),
    });
    if (typeof window.bootSyncInvalidate === 'function') window.bootSyncInvalidate();
  } catch (e) {
    console.warn('[crSyncPush]', e.message);
  }
}

/** Pull : récupère le blob serveur, fusionne avec l'IDB local */
async function crSyncPull() {
  if (typeof S === 'undefined' || !S?.token) return;
  if (typeof wpost !== 'function') return;
  try {
    // ✅ v8.9 — Tente boot-sync d'abord (1 fetch pour tous les modules)
    let resp = null;
    if (typeof window.bootSyncGet === 'function') {
      try { resp = await window.bootSyncGet('cr_passage'); } catch {}
    }
    if (!resp) {
      resp = await wpost('/webhook/cr-passage-pull', {});
    }
    if (!resp?.ok || !resp.data?.encrypted_data) return;

    const remote = _crDec(resp.data.encrypted_data);
    if (!Array.isArray(remote) || !remote.length) return;

    // Merge : on insère uniquement les CR absents localement (par id ou signature)
    const db = await _crDb();
    const existing = await new Promise((res2, rej) => {
      const tx  = db.transaction(CR_STORE, 'readonly');
      const req = tx.objectStore(CR_STORE).getAll();
      req.onsuccess = e => res2(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    });
    const existingIds  = new Set(existing.map(cr => cr.id).filter(Boolean));
    const existingKeys = new Set(existing.map(cr => `${cr.patient_id}|${cr.date}|${cr.heure || ''}`));

    let merged = 0;
    for (const remoteCr of remote) {
      if (remoteCr.id && existingIds.has(remoteCr.id)) continue;
      const sig = `${remoteCr.patient_id}|${remoteCr.date}|${remoteCr.heure || ''}`;
      if (existingKeys.has(sig)) continue;
      const { id, ...rest } = remoteCr;
      try {
        await new Promise((res2, rej) => {
          const tx = db.transaction(CR_STORE, 'readwrite');
          const req = tx.objectStore(CR_STORE).add(rest);
          req.onsuccess = () => res2();
          req.onerror   = e => rej(e.target.error);
        });
        merged++;
      } catch {}
    }
    if (merged > 0) {
      console.info(`[crSyncPull] ${merged} CR-Passage fusionné(s) depuis le serveur`);
    }
  } catch (e) {
    console.warn('[crSyncPull]', e.message);
  }
}

if (typeof window !== 'undefined') {
  window.crSyncPush = crSyncPush;
  window.crSyncPull = crSyncPull;
}

async function _crGetAll(patientId) {
  // ⚠️ v2 — inclut les CR du user courant ET les CR reçus du cabinet
  // (marqués par _from_cabinet). Les CR d'autres IDE sans lien cabinet
  // restent invisibles (isolation RGPD).
  const db  = await _crDb();
  const uid = APP?.user?.id || '';
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(CR_STORE, 'readonly');
    const idx = tx.objectStore(CR_STORE).index('patient_id');
    const req = idx.getAll(patientId);
    req.onsuccess = e => {
      const all = e.target.result || [];
      const visible = all.filter(c =>
        c.user_id === uid ||                    // mes CR
        (c.type === 'shared' && c._from_cabinet) // CR partagés reçus du cabinet
      );
      visible.sort((a, b) => new Date(b.date) - new Date(a.date));
      resolve(visible);
    };
    req.onerror = e => reject(e.target.error);
  });
}

/* ── Récupère uniquement les CR partageables (type=shared ou alert=true) ── */
async function _crGetAllShared() {
  const db  = await _crDb();
  const uid = APP?.user?.id || '';
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(CR_STORE, 'readonly');
    const req = tx.objectStore(CR_STORE).getAll();
    req.onsuccess = e => {
      const all = (e.target.result || []).filter(c =>
        c.user_id === uid &&                                    // uniquement les miens
        !c._from_cabinet &&                                      // jamais re-router un CR reçu
        (c.type === 'shared' || c.alert === true)                // partageables
      );
      resolve(all);
    };
    req.onerror = e => reject(e.target.error);
  });
}

let _crCurrentPatient = null;
// ⚡ v4.1 — Mode édition d'un CR existant. Si non-null, crSave() upserte
//          (put avec le même id) au lieu d'ajouter un nouveau (add).
//          Doctrine : Patient existe + CR chargé → MAJ, jamais de doublon.
let _crEditingId = null;

/* ══════════════════════════════════════════════════════════════════
   🧠 MOTEURS IA CLINIQUES — Résumé, aggravation, timeline, score
   ──────────────────────────────────────────────────────────────────
   Fonctionnement 100 % local (aucune donnée transmise).
   Règle : outil d'aide à la surveillance — ne remplace PAS un avis
   médical. Affiché systématiquement sur chaque widget.
   ══════════════════════════════════════════════════════════════════ */

/* ── Normalisation texte ────────────────────────────────────────── */
function _crNormalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/é|è|ê|ë/g, 'e')
    .replace(/à|â|ä/g, 'a')
    .replace(/î|ï/g, 'i')
    .replace(/ô|ö/g, 'o')
    .replace(/û|ü|ù/g, 'u')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9\s\/\.]/g, ' ');
}

/* ── Dictionnaire NLP pragmatique (FR) ──────────────────────────── */
const CR_NLP_DICT = {
  douleur:      ['douleur','algie','douloureux','souffrance','mal','eva'],
  rougeur:      ['rougeur','erytheme','rouge','inflammation'],
  oedeme:       ['oedeme','gonflement','gonfle','tumefaction'],
  infection:    ['infection','pus','purulent','fievre','febrile','sepsis','suintement','suintant'],
  amelioration: ['amelioration','mieux','meilleur','stable','evolution favorable','cicatrise','diminution'],
  aggravation: ['aggravation','pire','augmente','empire','evolution defavorable','extension','detresse'],
  chute:        ['chute','tombe','trauma'],
  hypotension:  ['hypotension','malaise','vertige'],
  hypertension: ['hta','tension haute'],
  confusion:    ['confusion','desorient','desoriente','delire','delirium'],
};

function _crExtractEntities(text) {
  const t = _crNormalize(text);
  const out = {};
  for (const [k, words] of Object.entries(CR_NLP_DICT)) {
    out[k] = words.some(w => t.includes(w)) ? 1 : 0;
  }
  // Score douleur EVA (détection "eva 7/10" ou "douleur 8")
  const m = t.match(/(?:eva|douleur)\s*:?\s*(\d{1,2})(?:\s*\/\s*10)?/);
  out.douleur_score = m ? Math.min(10, parseInt(m[1], 10)) : (out.douleur ? 5 : 0);
  return out;
}

/* ── Résumé automatique : statut + alertes + tendance ───────────── */
function generateCRSummary(reports) {
  if (!Array.isArray(reports) || !reports.length) {
    return { status: 'AUCUN_DONNEE', alerts: 0, trend: 'aucune', lastEvent: null, alertDates: [] };
  }
  const alertDates = [];
  const trendVotes = { amelioration: 0, aggravation: 0 };
  let stable = true;
  let lastEvent = null;

  // Parcours chronologique inverse (plus récent d'abord)
  const chrono = [...reports].sort((a, b) => new Date(b.date) - new Date(a.date));
  for (const r of chrono) {
    const txt = `${r.actes || ''} ${r.observations || ''} ${r.transmissions || ''}`;
    const e = _crExtractEntities(txt);
    if (e.rougeur || e.douleur >= 1 || e.infection || e.oedeme || e.chute || e.confusion) {
      stable = false;
      if (r.date) alertDates.push(r.date);
    }
    if (e.amelioration) trendVotes.amelioration++;
    if (e.aggravation) trendVotes.aggravation++;
    if (!lastEvent && (e.rougeur || e.infection || e.aggravation || e.douleur_score >= 6)) {
      lastEvent = { date: r.date, label: _crSummarizeLine(txt) };
    }
    if (r.urgence === 'urgent' || r.urgence === 'attention') stable = false;
  }

  let trend = 'stable';
  if (trendVotes.aggravation > trendVotes.amelioration) trend = 'aggravation';
  else if (trendVotes.amelioration > trendVotes.aggravation) trend = 'amelioration';

  return {
    status: stable ? 'STABLE' : 'A_SURVEILLER',
    alerts: alertDates.length,
    trend,
    lastEvent,
    alertDates: alertDates.slice(0, 5),
  };
}

function _crSummarizeLine(txt) {
  const clean = String(txt || '').replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? clean.slice(0, 77) + '…' : clean;
}

/* ── Détection d'aggravation (score pondéré) ────────────────────── */
function detectAggravation(reports) {
  if (!Array.isArray(reports) || !reports.length) {
    return { level: 'LOW', score: 0, probability: 0, reasons: [] };
  }
  const last3 = [...reports]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 3);

  let score = 0;
  const reasons = new Set();

  for (const r of last3) {
    const txt = `${r.actes || ''} ${r.observations || ''} ${r.transmissions || ''}`;
    const e = _crExtractEntities(txt);
    if (e.douleur)      { score += 2; reasons.add('douleur'); }
    if (e.douleur_score >= 7) { score += 1; reasons.add('douleur intense'); }
    if (e.rougeur)      { score += 2; reasons.add('rougeur'); }
    if (e.infection)    { score += 3; reasons.add('signes infectieux'); }
    if (e.oedeme)       { score += 2; reasons.add('oedème'); }
    if (e.aggravation)  { score += 3; reasons.add('évolution défavorable'); }
    if (e.chute)        { score += 2; reasons.add('chute récente'); }
    if (e.confusion)    { score += 2; reasons.add('confusion / désorientation'); }
    if (r.urgence === 'urgent')    { score += 3; reasons.add('niveau urgence déclaré'); }
    if (r.urgence === 'attention') { score += 1; reasons.add('surveillance signalée'); }
  }

  // Normaliser en probabilité 0-1 (plafond à 15 pts = 100%)
  const probability = Math.min(1, score / 15);
  const level = probability > 0.65 ? 'HIGH' : probability > 0.35 ? 'MEDIUM' : 'LOW';

  return {
    level,
    score,
    probability: Math.round(probability * 100) / 100,
    reasons: Array.from(reasons),
  };
}

/* ── Score clinique IDE (0-10) ──────────────────────────────────── */
function computeIDEClinicalScore(reports) {
  if (!Array.isArray(reports) || !reports.length) {
    return { score: 0, level: 'STABLE', factors: [] };
  }
  const last = reports.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  const txt = `${last.actes || ''} ${last.observations || ''} ${last.transmissions || ''}`;
  const e = _crExtractEntities(txt);

  let score = 0;
  const factors = [];

  // Douleur
  if (e.douleur_score >= 7)       { score += 2; factors.push('douleur élevée'); }
  else if (e.douleur_score >= 4)  { score += 1; factors.push('douleur modérée'); }

  // Inflammation
  if (e.rougeur)  { score += 2; factors.push('rougeur'); }
  if (e.oedeme)   { score += 1; factors.push('œdème'); }

  // Infection
  if (e.infection) { score += 3; factors.push('signes infectieux'); }

  // Tendance (calculée sur les 3 derniers)
  const agg = detectAggravation(reports);
  if (agg.level === 'HIGH')   { score += 2; factors.push('aggravation détectée'); }
  if (agg.level === 'MEDIUM') { score += 1; factors.push('surveillance recommandée'); }

  // Urgence déclarée
  if (last.urgence === 'urgent')    { score += 2; factors.push('niveau urgent déclaré'); }
  if (last.urgence === 'attention') { score += 1; factors.push('niveau attention déclaré'); }

  score = Math.max(0, Math.min(10, score));
  const level = score >= 7 ? 'CRITICAL' : score >= 4 ? 'WARNING' : 'STABLE';

  return { score, level, factors };
}

/* ── Timeline (événements horodatés avec sévérité) ──────────────── */
function buildTimeline(reports) {
  if (!Array.isArray(reports)) return [];
  return reports.map(r => {
    const txt = `${r.actes || ''} ${r.observations || ''} ${r.transmissions || ''}`;
    const e = _crExtractEntities(txt);
    // Sévérité : 0 = vert, 1 = jaune, 2 = orange, 3 = rouge
    let severity = 0;
    if (e.douleur || e.rougeur || e.oedeme) severity = 1;
    if (e.douleur_score >= 6 || (e.rougeur && e.oedeme)) severity = 2;
    if (e.infection || e.aggravation || r.urgence === 'urgent') severity = 3;
    if (r.urgence === 'attention' && severity < 2) severity = 2;

    return {
      date: r.date,
      severity,
      type: e.infection ? 'infection' : e.aggravation ? 'aggravation' : e.amelioration ? 'amelioration' : 'passage',
      label: _crSummarizeLine(txt) || 'Passage',
      inf_nom: r.inf_nom || '',
      urgence: r.urgence || 'normal',
    };
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
}

/* ── Palette sévérité (UI) ──────────────────────────────────────── */
function _crSeverityColor(s) {
  return s === 3 ? '#ef4444' : s === 2 ? '#f97316' : s === 1 ? '#f59e0b' : '#22c55e';
}
function _crSeverityIcon(s) {
  return s === 3 ? '🔴' : s === 2 ? '🟠' : s === 1 ? '🟡' : '🟢';
}

/* ── Export global pour usage cross-module ──────────────────────── */
window.CR_ENGINE = {
  generateCRSummary,
  detectAggravation,
  computeIDEClinicalScore,
  buildTimeline,
  extractEntities: _crExtractEntities,
};

async function renderCompteRendu() {
  const wrap = document.getElementById('compte-rendu-root');
  if (!wrap) return;

  let patients = [];
  try { if (typeof getAllPatients === 'function') patients = await getAllPatients(); } catch (_) {}

  // Détection cabinet : si l'IDE est dans un cabinet, on expose le partage
  const cab = (typeof APP !== 'undefined' && APP.get) ? APP.get('cabinet') : null;
  const inCabinet = !!(cab && cab.id);

  wrap.innerHTML = `
    <h1 class="pt">Compte-rendu <em>de passage</em></h1>
    <p class="ps">CR structuré pour médecin traitant · Synthèse IA · Export PDF · Archivage local</p>

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">📋</span><p>Générez un compte-rendu structuré de chaque passage, exportable pour le médecin traitant ou l'entourage. ${inCabinet ? 'En cabinet, vous pouvez partager les CR importants avec vos collègues.' : ''}</p></div>

      <div class="lbl" style="margin-bottom:8px">Patient</div>
      <select id="cr-patient-sel" onchange="crSelectPatient(this.value)" style="width:100%;margin-bottom:16px;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
        <option value="">— Sélectionner un patient —</option>
        ${patients.map(p => `<option value="${p.id}">${p.nom||''} ${p.prenom||''}</option>`).join('')}
      </select>

      <div id="cr-form-section" style="display:none">
        <!-- ⚡ Bandeau "Mode édition" — visible uniquement quand un CR est chargé pour modification -->
        <div id="cr-edit-banner" style="display:none;background:rgba(0,212,170,0.08);border:1px solid #00d4aa;border-radius:10px;padding:10px 14px;margin-bottom:14px;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div style="font-size:12px;color:var(--t)">
            <span style="font-size:14px">✏️</span> <strong>Mode édition</strong> — vous modifiez un compte-rendu existant. La sauvegarde mettra à jour cette entrée.
          </div>
          <button class="btn bs bsm" onclick="crNewFromEdit()" title="Repartir d'un CR vierge pour ce patient">🆕 Nouveau CR</button>
        </div>

        <div class="fg" style="margin-bottom:16px">
          <div class="f"><label>Date / Heure de passage</label><input type="datetime-local" id="cr-date" value="${new Date().toISOString().slice(0,16)}"></div>
          <div class="f"><label>Médecin traitant (destinataire)</label><input type="text" id="cr-medecin" placeholder="Dr. ..."></div>
        </div>

        <div class="lbl" style="margin-bottom:8px">Actes réalisés</div>
        <div class="f" style="margin-bottom:14px">
          <textarea id="cr-actes" placeholder="Ex : Injection insuline SC 20UI, Surveillance glycémie (1.3 g/L), Pansement plaie jambe gauche..." style="min-height:90px;resize:vertical"></textarea>
        </div>

        <div class="lbl" style="margin-bottom:8px">Constantes relevées</div>
        <div class="fg" style="margin-bottom:14px">
          <div class="f"><label>TA (mmHg)</label><input type="text" id="cr-ta" placeholder="130/80"></div>
          <div class="f"><label>Glycémie (g/L)</label><input type="text" id="cr-gly" placeholder="1.10"></div>
          <div class="f"><label>SpO2 (%)</label><input type="text" id="cr-spo2" placeholder="97%"></div>
          <div class="f"><label>T° (°C)</label><input type="text" id="cr-temp" placeholder="36.8"></div>
          <div class="f"><label>FC (bpm)</label><input type="text" id="cr-fc" placeholder="72"></div>
          <div class="f"><label>Douleur EVA</label><input type="text" id="cr-eva" placeholder="2/10"></div>
        </div>

        <div class="lbl" style="margin-bottom:8px">Observations cliniques</div>
        <div class="f" style="margin-bottom:14px">
          <textarea id="cr-observations" placeholder="État général, comportement, changements observés..." style="min-height:80px;resize:vertical"></textarea>
        </div>

        <div class="lbl" style="margin-bottom:8px">Transmissions / À signaler</div>
        <div class="f" style="margin-bottom:16px">
          <textarea id="cr-transmissions" placeholder="Points à signaler au médecin, soins à prévoir, alertes..." style="min-height:80px;resize:vertical"></textarea>
        </div>

        <!-- Niveau urgence -->
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
          <label style="font-size:13px;color:var(--m)">Niveau :</label>
          <select id="cr-urgence" style="padding:8px 12px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:13px;font-family:var(--fm)">
            <option value="normal">✅ RAS — Situation stable</option>
            <option value="attention">⚡ Attention — Surveiller</option>
            <option value="urgent">🚨 Urgent — Contacter médecin</option>
          </select>
        </div>

        <!-- 🆕 Partage cabinet (uniquement si cabinet actif) -->
        ${inCabinet ? `
        <div style="background:rgba(0,212,170,.04);border:1px solid rgba(0,212,170,.2);border-radius:10px;padding:12px;margin-bottom:16px">
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
            <input type="checkbox" id="cr-shared" style="width:18px;height:18px;accent-color:var(--a);flex-shrink:0;margin-top:2px">
            <div>
              <div style="font-size:13px;font-weight:600;color:var(--t)">📡 Partager avec mon cabinet (${cab.nom || 'cabinet'})</div>
              <div style="font-size:11px;color:var(--m);margin-top:3px;line-height:1.5">
                Ce CR sera visible par vos collègues du cabinet qui suivent ce patient. Recommandé si alerte ou évolution importante. <strong>Les CR non partagés restent strictement privés.</strong>
              </div>
            </div>
          </label>
        </div>` : ''}

        <div class="ar-row">
          <button class="btn bp" onclick="crSave()"><span>💾</span> Sauvegarder</button>
          <button class="btn bv" onclick="crGeneratePDF()"><span>🖨️</span> PDF complet</button>
          <button class="btn bv" onclick="crGenerateDoctorPDF()"><span>👨‍⚕️</span> PDF synthèse médecin</button>
          <button class="btn bs" onclick="crGenerateDoctorMessage()"><span>✉️</span> Message médecin</button>
          <button class="btn bs" onclick="crReset()">↺ Effacer</button>
        </div>

        <!-- Disclaimer médico-légal -->
        <div style="margin-top:14px;padding:10px 12px;background:rgba(59,130,246,.06);border-left:3px solid #3b82f6;border-radius:6px;font-size:11px;color:var(--m);line-height:1.5">
          ⚖️ <strong>Outil d'aide à la surveillance infirmière.</strong> Les analyses IA (synthèse, score, aggravation) ne remplacent pas un avis médical et ne constituent pas un diagnostic.
        </div>
      </div>
    </div>

    <!-- 🆕 Widgets IA cliniques (visibles si patient sélectionné) -->
    <div id="cr-ia-wrap" style="display:none">
      <div id="cr-ia-synthesis" class="card" style="margin-bottom:12px"></div>
      <div id="cr-ia-risk"      class="card" style="margin-bottom:12px"></div>
      <div id="cr-ia-timeline"  class="card" style="margin-bottom:12px"></div>
    </div>

    <!-- Historique -->
    <div id="cr-history-wrap" class="card" style="display:none">
      <div class="lbl" style="margin-bottom:14px">📋 Comptes-rendus précédents</div>
      <div id="cr-history-list"></div>
    </div>
  `;
}

async function crSelectPatient(pid) {
  _crCurrentPatient = pid || null;
  // ⚡ v4.1 — changement de patient → on quitte tout mode édition
  _crEditingId = null;
  const section  = document.getElementById('cr-form-section');
  const histWrap = document.getElementById('cr-history-wrap');
  const iaWrap   = document.getElementById('cr-ia-wrap');
  if (!pid) {
    if (section) section.style.display = 'none';
    if (histWrap) histWrap.style.display = 'none';
    if (iaWrap)   iaWrap.style.display = 'none';
    return;
  }
  if (section) section.style.display = 'block';
  if (histWrap) histWrap.style.display = 'block';
  if (iaWrap)   iaWrap.style.display = 'block';
  _crUpdateEditBanner();
  await crLoadHistory();
  await crRenderIntelligence();
}

/* ═════════════════════════════════════════════════════════════
   🆕 crRenderIntelligence — widgets IA cliniques du patient
   ─────────────────────────────────────────────────────────────
   3 panneaux : Synthèse · Risque · Timeline
   Charge depuis l'historique des CR (privés + partagés cabinet)
   ═════════════════════════════════════════════════════════════ */
async function crRenderIntelligence() {
  if (!_crCurrentPatient) return;
  const synthEl = document.getElementById('cr-ia-synthesis');
  const riskEl  = document.getElementById('cr-ia-risk');
  const tlEl    = document.getElementById('cr-ia-timeline');
  if (!synthEl && !riskEl && !tlEl) return;

  let reports = [];
  try { reports = await _crGetAll(_crCurrentPatient); } catch (_) {}

  // ── PANNEAU 1 — Synthèse ────────────────────────────────────
  if (synthEl) {
    if (!reports.length) {
      synthEl.innerHTML = `
        <div class="lbl" style="margin-bottom:10px">🧠 Synthèse IA</div>
        <div class="empty" style="padding:18px"><p>Aucun CR pour ce patient. La synthèse s'affichera après la 1re sauvegarde.</p></div>`;
    } else {
      const s = generateCRSummary(reports);
      const stColor = s.status === 'STABLE' ? '#22c55e' : '#f97316';
      const trendIcon = s.trend === 'aggravation' ? '📉' : s.trend === 'amelioration' ? '📈' : '➖';
      const trendColor = s.trend === 'aggravation' ? '#ef4444' : s.trend === 'amelioration' ? '#22c55e' : '#94a3b8';
      synthEl.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          <div class="lbl" style="margin:0">🧠 Synthèse IA</div>
          <span style="font-size:10px;color:var(--m);font-family:var(--fm)">Analyse locale · ${reports.length} CR</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
          <div style="background:var(--s);border-radius:10px;padding:12px;text-align:center;border:1px solid ${stColor}33">
            <div style="font-size:10px;color:var(--m);font-family:var(--fm);text-transform:uppercase;letter-spacing:1px">Statut</div>
            <div style="font-family:var(--fs);font-size:20px;color:${stColor};margin-top:4px">${s.status === 'STABLE' ? '🟢 Stable' : '🟠 À surveiller'}</div>
          </div>
          <div style="background:var(--s);border-radius:10px;padding:12px;text-align:center">
            <div style="font-size:10px;color:var(--m);font-family:var(--fm);text-transform:uppercase;letter-spacing:1px">Alertes</div>
            <div style="font-family:var(--fs);font-size:20px;color:${s.alerts ? '#f59e0b' : '#22c55e'};margin-top:4px">${s.alerts}</div>
          </div>
          <div style="background:var(--s);border-radius:10px;padding:12px;text-align:center">
            <div style="font-size:10px;color:var(--m);font-family:var(--fm);text-transform:uppercase;letter-spacing:1px">Tendance</div>
            <div style="font-family:var(--fs);font-size:20px;color:${trendColor};margin-top:4px">${trendIcon} ${s.trend}</div>
          </div>
        </div>
        ${s.lastEvent ? `
          <div style="margin-top:12px;padding:10px 12px;background:rgba(245,158,11,.06);border-left:3px solid #f59e0b;border-radius:6px;font-size:12px;color:var(--t)">
            <strong>Dernier événement marquant</strong> · ${new Date(s.lastEvent.date).toLocaleDateString('fr-FR')}<br>
            <span style="color:var(--m);font-size:11px">${s.lastEvent.label}</span>
          </div>` : ''}`;
    }
  }

  // ── PANNEAU 2 — Risque d'aggravation + score IDE ────────────
  if (riskEl) {
    if (!reports.length) {
      riskEl.innerHTML = `
        <div class="lbl" style="margin-bottom:10px">⚠️ Risque & score clinique</div>
        <div class="empty" style="padding:18px"><p>Données insuffisantes.</p></div>`;
    } else {
      const agg = detectAggravation(reports);
      const sc  = computeIDEClinicalScore(reports);
      const aggColor = agg.level === 'HIGH' ? '#ef4444' : agg.level === 'MEDIUM' ? '#f97316' : '#22c55e';
      const scColor  = sc.level  === 'CRITICAL' ? '#ef4444' : sc.level === 'WARNING' ? '#f97316' : '#22c55e';
      riskEl.innerHTML = `
        <div class="lbl" style="margin-bottom:12px">⚠️ Risque & score clinique IDE</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:14px">
          <div style="background:${aggColor}11;border:1px solid ${aggColor}40;border-radius:10px;padding:14px">
            <div style="font-size:10px;color:${aggColor};font-family:var(--fm);text-transform:uppercase;letter-spacing:1px">Risque d'aggravation</div>
            <div style="font-family:var(--fs);font-size:24px;color:${aggColor};margin-top:6px">${Math.round(agg.probability * 100)}%</div>
            <div style="font-size:11px;color:var(--m);margin-top:2px">Niveau : <strong style="color:${aggColor}">${agg.level}</strong></div>
            <div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px;margin-top:8px;overflow:hidden">
              <div style="height:100%;width:${Math.round(agg.probability * 100)}%;background:${aggColor};transition:width .6s"></div>
            </div>
          </div>
          <div style="background:${scColor}11;border:1px solid ${scColor}40;border-radius:10px;padding:14px">
            <div style="font-size:10px;color:${scColor};font-family:var(--fm);text-transform:uppercase;letter-spacing:1px">Score clinique IDE</div>
            <div style="font-family:var(--fs);font-size:24px;color:${scColor};margin-top:6px">${sc.score}<span style="font-size:14px;color:var(--m)">/10</span></div>
            <div style="font-size:11px;color:var(--m);margin-top:2px">Niveau : <strong style="color:${scColor}">${sc.level}</strong></div>
            <div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px;margin-top:8px;overflow:hidden">
              <div style="height:100%;width:${sc.score * 10}%;background:${scColor};transition:width .6s"></div>
            </div>
          </div>
        </div>
        ${(agg.reasons.length || sc.factors.length) ? `
          <div style="font-size:12px;color:var(--m);line-height:1.6">
            <strong style="color:var(--t)">Motifs identifiés :</strong> ${Array.from(new Set([...agg.reasons, ...sc.factors])).join(' · ') || '—'}
          </div>` : ''}
        ${agg.level !== 'LOW' || sc.level !== 'STABLE' ? `
          <div style="margin-top:12px;padding:10px 12px;background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.2);border-radius:8px;font-size:12px;color:var(--t);line-height:1.5">
            💡 <strong>Recommandation :</strong> ${agg.level === 'HIGH' || sc.level === 'CRITICAL' ? 'Avis médical recommandé rapidement.' : 'Surveillance rapprochée conseillée.'}
          </div>` : ''}`;
    }
  }

  // ── PANNEAU 3 — Timeline ────────────────────────────────────
  if (tlEl) {
    if (!reports.length) {
      tlEl.innerHTML = `
        <div class="lbl" style="margin-bottom:10px">📊 Timeline patient</div>
        <div class="empty" style="padding:18px"><p>Aucun événement enregistré.</p></div>`;
    } else {
      const timeline = buildTimeline(reports).slice(0, 10);
      tlEl.innerHTML = `
        <div class="lbl" style="margin-bottom:12px">📊 Timeline patient <span style="font-size:10px;color:var(--m);font-family:var(--fm);font-weight:400">· ${timeline.length} dernier(s) événement(s)</span></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${timeline.map(t => {
            const col = _crSeverityColor(t.severity);
            const icon = _crSeverityIcon(t.severity);
            const d = new Date(t.date);
            const dateFmt = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
            const heureFmt = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            return `
              <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--s);border-radius:8px;border-left:3px solid ${col}">
                <div style="font-size:14px;flex-shrink:0">${icon}</div>
                <div style="flex:1;min-width:0">
                  <div style="font-size:12px;color:var(--t);font-weight:600">${dateFmt} · ${heureFmt}${t.inf_nom ? ` <span style="font-weight:400;color:var(--m)">· ${t.inf_nom}</span>` : ''}</div>
                  <div style="font-size:11px;color:var(--m);margin-top:2px;line-height:1.5">${t.label}</div>
                </div>
              </div>`;
          }).join('')}
        </div>`;
    }
  }
}

async function crSave() {
  if (!_crCurrentPatient) { showToast('warning','Patient requis'); return; }
  const get = id => document.getElementById(id)?.value?.trim() || '';

  // 🆕 Lire le flag partage cabinet (checkbox présente uniquement si cabinet actif)
  const sharedChk = document.getElementById('cr-shared');
  const isShared  = !!(sharedChk && sharedChk.checked);
  const urgence   = get('cr-urgence') || 'normal';

  // Récupérer nom patient pour affichage dans CR reçus côté collègue
  let patientNom = '';
  try {
    if (typeof getAllPatients === 'function') {
      const pts = await getAllPatients();
      const p = pts.find(x => String(x.id) === String(_crCurrentPatient));
      if (p) patientNom = `${p.nom||''} ${p.prenom||''}`.trim();
    }
  } catch (_) {}

  // ── UPSERT v4.1 : si on édite un CR existant, conserver son id et sa date_creation
  //                 d'origine. Sinon, c'est un nouveau CR (autoIncrement attribuera un id).
  //                 Doctrine : Patient existe + _crEditingId trouvé → MAJ, jamais de doublon.
  let originalSavedAt = null;
  if (_crEditingId) {
    try {
      const db = await _crDb();
      const existing = await new Promise((res, rej) => {
        const tx  = db.transaction(CR_STORE, 'readonly');
        const req = tx.objectStore(CR_STORE).get(_crEditingId);
        req.onsuccess = e => res(e.target.result);
        req.onerror   = e => rej(e.target.error);
      });
      if (existing?.saved_at) originalSavedAt = existing.saved_at;
    } catch (_) { /* si lecture KO on garde la nouvelle date */ }
  }

  const obj = {
    // Inclure l'id uniquement en mode édition (sinon autoIncrement attribue un nouvel id)
    ...(_crEditingId ? { id: _crEditingId } : {}),
    patient_id:    _crCurrentPatient,
    patient_nom:   patientNom,
    user_id:       APP?.user?.id || '',
    date:          get('cr-date') || new Date().toISOString(),
    medecin:       get('cr-medecin'),
    actes:         get('cr-actes'),
    ta:            get('cr-ta'),
    glycemie:      get('cr-gly'),
    spo2:          get('cr-spo2'),
    temperature:   get('cr-temp'),
    fc:            get('cr-fc'),
    eva:           get('cr-eva'),
    observations:  get('cr-observations'),
    transmissions: get('cr-transmissions'),
    urgence,
    inf_nom:       `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim(),
    // 🆕 Métadonnées CR en 2 niveaux (règle partagée/privé)
    type:          isShared ? 'shared' : 'private',
    alert:         urgence === 'urgent' || urgence === 'attention',
    saved_at:      originalSavedAt || new Date().toISOString(),
    updated_at:    new Date().toISOString(),
    _cr_version:   2,
  };
  try {
    const wasEdit = !!_crEditingId; // true si on était en mode édition avant le save
    const newId = await _crSave(obj);
    // ⚡ Mémoriser l'id pour les saves suivants — qu'on vienne de créer ou modifier,
    //    les saves suivants doivent continuer à modifier ce même CR jusqu'à reset/nouveau.
    _crEditingId = newId;
    _crUpdateEditBanner();
    showToast('success', wasEdit ? 'Compte-rendu mis à jour' : (isShared ? 'CR sauvegardé et partagé' : 'Compte-rendu sauvegardé'));
    await crLoadHistory();
    await crRenderIntelligence();

    // 🆕 v8.9 — Sync inter-appareils via Supabase (silencieux, non bloquant)
    try { await crSyncPush(); } catch (e) { console.warn('[cr sync push]', e.message); }

    // 🆕 Push cabinet immédiat si CR partagé ET cabinet actif
    // Non bloquant : l'IDE n'attend pas le push pour continuer
    if (isShared && typeof APP !== 'undefined' && APP.get) {
      const cab = APP.get('cabinet');
      if (cab && cab.id) {
        // Push silencieux si la fonction cabinet existe et que le toggle "compte_rendu" est actif
        setTimeout(() => {
          try {
            const prefsRaw = localStorage.getItem(`ami_cabinet_sync_prefs_${APP.user?.id}`);
            const prefs = prefsRaw ? JSON.parse(prefsRaw) : null;
            const crSyncOn = !prefs || prefs.what?.compte_rendu !== false;
            if (crSyncOn && typeof cabinetPushSync === 'function') {
              // On ne déclenche pas automatiquement pour ne pas surprendre l'IDE
              // mais on informe qu'un push est possible
              if (typeof showToast === 'function') {
                showToast('info', 'CR prêt à partager', 'Depuis Cabinet → Envoyer pour diffuser à vos collègues');
              }
            }
          } catch {}
        }, 600);
      }
    }
  } catch (err) { showToast('error','Erreur',err.message); }
}

function crReset() {
  ['cr-actes','cr-observations','cr-transmissions','cr-medecin','cr-ta','cr-gly','cr-spo2','cr-temp','cr-fc','cr-eva'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  const dt = document.getElementById('cr-date');
  if (dt) dt.value = new Date().toISOString().slice(0,16);
  // ⚡ v4.1 — Reset = on quitte le mode édition (futur save = nouveau CR)
  _crEditingId = null;
  _crUpdateEditBanner();
  const urg = document.getElementById('cr-urgence'); if (urg) urg.value = 'normal';
  const shr = document.getElementById('cr-shared');  if (shr) shr.checked = false;
}

/* ⚡ v4.1 — Affiche/masque le bandeau "Mode édition" en fonction de _crEditingId */
function _crUpdateEditBanner() {
  const banner = document.getElementById('cr-edit-banner');
  if (!banner) return;
  banner.style.display = _crEditingId ? 'flex' : 'none';
}

/* ⚡ v4.1 — Quitte le mode édition pour repartir d'un CR vierge (sans changer de patient) */
function crNewFromEdit() {
  _crEditingId = null;
  crReset();
  if (typeof showToast === 'function') showToast('info', 'Nouveau compte-rendu', 'La prochaine sauvegarde créera une nouvelle entrée.');
}

/* ⚡ v4.1 — Charge un CR existant dans le formulaire pour modification.
            Doctrine : Patient existe + index trouvé → MAJ, jamais de doublon. */
async function crEdit(id) {
  if (!_crCurrentPatient) { if (typeof showToast === 'function') showToast('warning','Sélectionnez d\'abord un patient'); return; }
  try {
    const db = await _crDb();
    const obj = await new Promise((res, rej) => {
      const tx  = db.transaction(CR_STORE, 'readonly');
      const req = tx.objectStore(CR_STORE).get(id);
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
    if (!obj) { if (typeof showToast === 'function') showToast('warning','Compte-rendu introuvable'); return; }

    // Pré-remplir tous les champs
    const setVal = (eid, val) => { const el = document.getElementById(eid); if (el && val != null) el.value = val; };
    let dateLocal = '';
    if (obj.date) {
      try {
        const d = new Date(obj.date);
        if (!isNaN(d)) {
          const pad = n => String(n).padStart(2, '0');
          dateLocal = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
      } catch (_) {}
    }
    setVal('cr-date',          dateLocal);
    setVal('cr-medecin',       obj.medecin);
    setVal('cr-actes',         obj.actes);
    setVal('cr-ta',            obj.ta);
    setVal('cr-gly',           obj.glycemie);
    setVal('cr-spo2',          obj.spo2);
    setVal('cr-temp',          obj.temperature);
    setVal('cr-fc',            obj.fc);
    setVal('cr-eva',           obj.eva);
    setVal('cr-observations',  obj.observations);
    setVal('cr-transmissions', obj.transmissions);
    setVal('cr-urgence',       obj.urgence || 'normal');
    const shr = document.getElementById('cr-shared');
    if (shr) shr.checked = (obj.type === 'shared');

    // ⚡ Activer le mode édition — la prochaine sauvegarde mettra à jour ce CR
    _crEditingId = id;
    _crUpdateEditBanner();

    // Scroll vers le formulaire pour visibilité
    const formSec = document.getElementById('cr-form-section');
    if (formSec) formSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (typeof showToast === 'function') showToast('info', 'Mode édition activé', 'Modifiez puis cliquez sur Sauvegarder pour mettre à jour.');
  } catch (err) {
    if (typeof showToast === 'function') showToast('error', 'Erreur', err.message);
  }
}

/* ⚡ v4.1 — Supprime un CR (avec confirmation), rafraîchit historique + IA */
async function crDelete(id) {
  if (!confirm('Supprimer définitivement ce compte-rendu ?\n\nCette action est irréversible.')) return;
  try {
    const db = await _crDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(CR_STORE, 'readwrite');
      const req = tx.objectStore(CR_STORE).delete(id);
      req.onsuccess = () => res();
      req.onerror   = e => rej(e.target.error);
    });
    // Si on supprime le CR en cours d'édition → repartir d'une feuille blanche
    if (_crEditingId === id) {
      _crEditingId = null;
      crReset();
    }
    if (typeof showToast === 'function') showToast('success', 'Compte-rendu supprimé');
    try { if (typeof auditLog === 'function') auditLog('CR_DELETED', { id, patient_id: _crCurrentPatient }); } catch (_) {}
    await crLoadHistory();
    await crRenderIntelligence();
    // Sync silencieuse pour propager la suppression
    try { await crSyncPush(); } catch (_) {}
  } catch (err) {
    if (typeof showToast === 'function') showToast('error', 'Erreur', err.message);
  }
}

function crGeneratePDF() {
  const get = id => document.getElementById(id)?.value?.trim() || '—';
  const patSel = document.getElementById('cr-patient-sel');
  const patNom = patSel?.options[patSel.selectedIndex]?.text || 'Patient';
  const urgLabels = { normal:'✅ RAS — Situation stable', attention:'⚡ À surveiller', urgent:'🚨 URGENT — Contacter médecin' };

  const w = window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>CR Infirmier AMI</title>
    <style>body{font-family:Arial,sans-serif;padding:30px;color:#000;max-width:680px;margin:0 auto}h1{font-size:16px;color:#007a6a}h2{font-size:13px;color:#555;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:18px}p,li{font-size:12px;line-height:1.7}.urgence{padding:8px 12px;border-radius:6px;font-weight:bold;font-size:13px;margin:12px 0}.ras{background:#e6f9f4;color:#007a6a}.attention{background:#fff8e6;color:#b45309}.urgent{background:#fee;color:#c00}@media print{@page{margin:15mm}}</style>
    </head><body>
    <h1>🩺 Compte-rendu de Passage Infirmier</h1>
    <p><strong>Patient :</strong> ${patNom} · <strong>Date :</strong> ${get('cr-date')} · <strong>Infirmier(ère) :</strong> ${`${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim()||'—'}</p>
    ${get('cr-medecin')!=='—'?`<p><strong>Destinataire :</strong> Dr. ${get('cr-medecin')}</p>`:''}
    <div class="urgence ${get('cr-urgence')||'normal'}">${urgLabels[get('cr-urgence')]||urgLabels.normal}</div>
    <h2>Actes réalisés</h2><p>${get('cr-actes')}</p>
    <h2>Constantes</h2>
    <table style="border-collapse:collapse;font-size:12px;margin-bottom:8px"><tr>
      ${[['TA',get('cr-ta')],['Glycémie',get('cr-gly')],['SpO2',get('cr-spo2')],['T°',get('cr-temp')],['FC',get('cr-fc')],['EVA',get('cr-eva')]].map(([l,v])=>`<td style="border:1px solid #ddd;padding:6px 10px"><strong>${l}</strong><br>${v}</td>`).join('')}
    </tr></table>
    <h2>Observations</h2><p>${get('cr-observations')}</p>
    <h2>Transmissions</h2><p>${get('cr-transmissions')}</p>
    <p style="font-size:10px;color:#888;margin-top:24px;border-top:1px solid #ddd;padding-top:8px">Généré par AMI · ${new Date().toLocaleString('fr-FR')}</p>
    <script>
      // ⚡ Auto-print dans la fenêtre fille — pas de blocage du main thread parent
      window.addEventListener('load', () => setTimeout(() => window.print(), 400));
      // ⚡ Restaurer le focus au parent AVANT de fermer la fenêtre fille
      //    sinon le focus système peut rester sur la fille en cours de fermeture
      //    → l'app principale ne reçoit plus les clics (sélection patient gelée).
      window.addEventListener('afterprint', () => {
        try { if (window.opener && !window.opener.closed) window.opener.focus(); } catch(_) {}
        setTimeout(() => window.close(), 300);
      });
    </script>
    </body></html>`);
  w.document.close();
  // ⚡ PAS de setTimeout(() => w.print(), 400) — laisse l'app principale réactive
  // ⚡ Forcer le retour du focus au parent en plus du opener.focus() côté fille
  setTimeout(() => { try { window.focus(); } catch (_) {} }, 1500);
}

async function crLoadHistory() {
  if (!_crCurrentPatient) return;
  const list = document.getElementById('cr-history-list');
  if (!list) return;
  try {
    const all = await _crGetAll(_crCurrentPatient);
    if (!all.length) { list.innerHTML = '<div class="empty"><p>Aucun compte-rendu.</p></div>'; return; }
    const myUid = APP?.user?.id || '';
    const urgColors = { normal:'var(--ok)', attention:'var(--w)', urgent:'var(--d)' };
    list.innerHTML = all.slice(0,20).map(c => {
      const d = new Date(c.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
      // 🆕 Badge partage / origine
      let originBadge = '';
      if (c._from_cabinet) {
        // CR reçu d'un collègue du cabinet
        originBadge = `<span style="display:inline-block;background:rgba(59,130,246,.15);color:#3b82f6;font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;font-family:var(--fm);margin-left:6px">🤝 ${c.inf_nom || 'Collègue'}</span>`;
      } else if (c.type === 'shared') {
        originBadge = `<span style="display:inline-block;background:rgba(0,212,170,.15);color:var(--a);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;font-family:var(--fm);margin-left:6px">📡 Partagé</span>`;
      } else {
        originBadge = `<span style="display:inline-block;background:rgba(148,163,184,.15);color:#94a3b8;font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;font-family:var(--fm);margin-left:6px">🔒 Privé</span>`;
      }
      const alertBadge = c.alert
        ? `<span style="display:inline-block;background:rgba(239,68,68,.15);color:#ef4444;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;font-family:var(--fm);margin-left:4px">⚠️ ALERTE</span>`
        : '';
      // ⚡ v4.1 — Boutons Modifier/Supprimer désactivés sur les CR reçus du cabinet
      //          (médico-légal : on ne touche pas à un CR rédigé par un collègue)
      const isMine = !c._from_cabinet;
      const editingNow = _crEditingId === c.id;
      const actionsHTML = isMine ? `
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          <button class="btn bs bsm" onclick="crEdit(${c.id})" title="Modifier ce compte-rendu" ${editingNow ? 'style="background:rgba(0,212,170,.15);border-color:var(--a);color:var(--a)"' : ''}>${editingNow ? '✏️ En cours…' : '✏️ Modifier'}</button>
          <button class="btn bs bsm" onclick="crDelete(${c.id})" title="Supprimer ce compte-rendu" style="color:#ef4444">🗑️ Supprimer</button>
        </div>` : '';
      return `
        <div style="background:var(--s);border:1px solid var(--b);border-left:3px solid ${urgColors[c.urgence]||'var(--b)'};border-radius:10px;padding:12px;margin-bottom:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:6px">
            <div style="font-size:13px;font-weight:600">${d}${originBadge}${alertBadge}</div>
          </div>
          <div style="font-size:12px;color:var(--m);line-height:1.5">${(c.actes||'').slice(0,120)}${(c.actes||'').length>120?'…':''}</div>
          ${actionsHTML}
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="msg e">Erreur : ${err.message}</div>`;
  }
}

/* ═════════════════════════════════════════════════════════════
   🆕 crGenerateDoctorPDF — PDF synthèse médecin (intelligent)
   ─────────────────────────────────────────────────────────────
   Contrairement au PDF "complet" qui reproduit le CR brut,
   ce PDF utilise les moteurs IA pour produire une synthèse
   lisible et utile au médecin : résumé + score + timeline.
   ═════════════════════════════════════════════════════════════ */
async function crGenerateDoctorPDF() {
  if (!_crCurrentPatient) { showToast?.('warning','Patient requis'); return; }

  let reports = [];
  try { reports = await _crGetAll(_crCurrentPatient); } catch (_) {}

  if (!reports.length) {
    showToast?.('warning', 'Aucun CR pour ce patient — sauvegardez au moins un passage avant de générer la synthèse.');
    return;
  }

  const patSel = document.getElementById('cr-patient-sel');
  const patNom = patSel?.options[patSel.selectedIndex]?.text || 'Patient';
  const summary = generateCRSummary(reports);
  const risk    = detectAggravation(reports);
  const score   = computeIDEClinicalScore(reports);
  const timeline = buildTimeline(reports).slice(0, 5);
  const infNom = `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim() || '—';
  const medecin = document.getElementById('cr-medecin')?.value?.trim() || '—';

  const statusLabel = summary.status === 'STABLE' ? 'État stable' : 'À surveiller';
  const trendLabel  = summary.trend === 'aggravation' ? 'Évolution défavorable'
                   : summary.trend === 'amelioration' ? 'Évolution favorable' : 'Évolution stable';

  const tlRows = timeline.map(t => {
    const d = new Date(t.date).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
    return `<tr>
      <td style="border:1px solid #ddd;padding:6px 10px;white-space:nowrap">${d}</td>
      <td style="border:1px solid #ddd;padding:6px 10px">${_crSeverityIcon(t.severity)} ${t.type}</td>
      <td style="border:1px solid #ddd;padding:6px 10px">${t.label}</td>
    </tr>`;
  }).join('');

  const reasonsHTML = Array.from(new Set([...risk.reasons, ...score.factors]))
    .map(r => `<li>${r}</li>`).join('') || '<li>Aucun point de vigilance majeur</li>';

  const w = window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Synthèse médecin AMI</title>
    <style>
      body{font-family:Arial,sans-serif;padding:30px;color:#000;max-width:720px;margin:0 auto}
      h1{font-size:17px;color:#007a6a;margin-bottom:6px}
      h2{font-size:13px;color:#555;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:20px}
      p,li{font-size:12px;line-height:1.6}
      table{border-collapse:collapse;width:100%;margin:10px 0;font-size:11px}
      th{background:#f3f4f6;padding:6px 10px;border:1px solid #ddd;text-align:left;font-size:11px}
      .kpi{display:inline-block;padding:6px 12px;border-radius:6px;font-weight:bold;font-size:12px;margin-right:6px;margin-bottom:6px}
      .stable{background:#dcfce7;color:#166534}
      .warn{background:#fef3c7;color:#92400e}
      .alert{background:#fee2e2;color:#991b1b}
      .disc{font-size:10px;color:#666;margin-top:20px;padding:10px 12px;background:#f9fafb;border-left:3px solid #3b82f6;line-height:1.6}
      @media print{@page{margin:15mm}}
    </style>
    </head><body>
    <h1>📋 Synthèse clinique infirmière — Compte-rendu médecin</h1>
    <p><strong>Patient :</strong> ${patNom}</p>
    <p><strong>Destinataire :</strong> Dr. ${medecin}</p>
    <p><strong>IDE rédactrice :</strong> ${infNom} · <strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
    <p><strong>Période couverte :</strong> ${reports.length} passage(s) analysés</p>

    <h2>État clinique de synthèse</h2>
    <div>
      <span class="kpi ${summary.status === 'STABLE' ? 'stable' : 'warn'}">Statut : ${statusLabel}</span>
      <span class="kpi ${risk.level === 'HIGH' ? 'alert' : risk.level === 'MEDIUM' ? 'warn' : 'stable'}">Risque d'aggravation : ${risk.level} (${Math.round(risk.probability * 100)}%)</span>
      <span class="kpi ${score.level === 'CRITICAL' ? 'alert' : score.level === 'WARNING' ? 'warn' : 'stable'}">Score clinique IDE : ${score.score}/10</span>
    </div>

    <h2>Évolution observée</h2>
    <p>${trendLabel}. ${summary.alerts > 0 ? `<strong>${summary.alerts}</strong> passage(s) avec signaux cliniques sur la période.` : 'Aucune alerte majeure relevée.'}</p>

    <h2>Points de vigilance</h2>
    <ul>${reasonsHTML}</ul>

    <h2>Derniers événements horodatés</h2>
    ${timeline.length ? `<table>
      <thead><tr><th>Date</th><th>Type</th><th>Observation</th></tr></thead>
      <tbody>${tlRows}</tbody>
    </table>` : '<p>—</p>'}

    <h2>Conclusion</h2>
    <p>${risk.level === 'HIGH' || score.level === 'CRITICAL'
        ? '<strong>Avis médical recommandé rapidement</strong> au regard des signaux cliniques observés.'
        : risk.level === 'MEDIUM' || score.level === 'WARNING'
          ? 'Surveillance rapprochée en cours. Avis médical à envisager si évolution défavorable.'
          : 'Situation stable. Poursuite des soins selon prescription.'}</p>

    <p style="margin-top:30px">Cordialement,<br><br>${infNom}<br><em>Infirmier(e) libéral(e)</em></p>

    <div class="disc">
      ⚖️ <strong>Outil d'aide à la surveillance infirmière.</strong>
      Les indicateurs présentés (statut, risque, score, tendance) résultent d'une analyse textuelle locale des comptes-rendus de passage. Ils ne constituent ni un diagnostic, ni une évaluation médicale, et ne remplacent pas l'examen clinique du médecin traitant. Synthèse générée par AMI.
    </div>
    <script>
      // ⚡ Auto-print dans la fenêtre fille — pas de blocage du main thread parent
      window.addEventListener('load', () => setTimeout(() => window.print(), 400));
      // ⚡ Restaurer le focus au parent AVANT de fermer la fenêtre fille
      //    sinon le focus système peut rester sur la fille en cours de fermeture
      //    → l'app principale ne reçoit plus les clics (sélection patient gelée).
      window.addEventListener('afterprint', () => {
        try { if (window.opener && !window.opener.closed) window.opener.focus(); } catch(_) {}
        setTimeout(() => window.close(), 300);
      });
    </script>
    </body></html>`);
  w.document.close();
  // ⚡ PAS de setTimeout(() => w.print(), 400) — laisse l'app principale réactive
  // ⚡ Forcer le retour du focus au parent en plus du opener.focus() côté fille
  setTimeout(() => { try { window.focus(); } catch (_) {} }, 1500);
}

/* ═════════════════════════════════════════════════════════════
   🆕 crGenerateDoctorMessage — Génère un message médecin prêt
   à copier (fenêtre modale avec bouton "Copier")
   ═════════════════════════════════════════════════════════════ */
async function crGenerateDoctorMessage() {
  if (!_crCurrentPatient) { showToast?.('warning','Patient requis'); return; }

  let reports = [];
  try { reports = await _crGetAll(_crCurrentPatient); } catch (_) {}

  if (!reports.length) {
    showToast?.('warning', 'Aucun CR pour ce patient — enregistrez au moins un passage.');
    return;
  }

  const patSel = document.getElementById('cr-patient-sel');
  const patNom = patSel?.options[patSel.selectedIndex]?.text || 'Patient';
  const summary = generateCRSummary(reports);
  const risk    = detectAggravation(reports);
  const score   = computeIDEClinicalScore(reports);
  const infNom = `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim() || 'Infirmier(e)';
  const medecinSaisi = document.getElementById('cr-medecin')?.value?.trim() || 'Docteur';

  const reasons = Array.from(new Set([...risk.reasons, ...score.factors]));
  const statusTxt = summary.status === 'STABLE' ? 'État globalement stable' : 'État à surveiller';
  const trendTxt  = summary.trend === 'aggravation' ? 'évolution défavorable'
                 : summary.trend === 'amelioration' ? 'évolution favorable' : 'situation stable';

  const msg = `Bonjour ${medecinSaisi},

Je vous contacte concernant votre patient ${patNom}.

État actuel :
- ${statusTxt}, ${trendTxt}

Points de vigilance :
${reasons.length ? reasons.map(r => `- ${r}`).join('\n') : '- Aucun point majeur'}

Indicateurs de surveillance :
- Score clinique IDE : ${score.score}/10 (${score.level})
- Risque d'aggravation : ${Math.round(risk.probability * 100)}% (${risk.level})
- ${summary.alerts} passage(s) avec alertes sur la période

Demande :
- ${risk.level === 'HIGH' || score.level === 'CRITICAL'
      ? 'Avis médical recommandé rapidement'
      : risk.level === 'MEDIUM' || score.level === 'WARNING'
        ? 'Avis médical à envisager si évolution défavorable'
        : "Information pour suivi — pas d'action urgente"}

Cordialement,
${infNom}

— Message généré par AMI (aide à la surveillance infirmière · ne remplace pas un avis médical).`;

  // Modale simple avec bouton copier
  const old = document.getElementById('cr-doctor-msg-modal');
  if (old) old.remove();
  const modal = document.createElement('div');
  modal.id = 'cr-doctor-msg-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--b);border-radius:14px;padding:20px;max-width:560px;width:100%;max-height:85vh;overflow:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div class="ct" style="margin:0">✉️ Message médecin généré</div>
        <button onclick="document.getElementById('cr-doctor-msg-modal').remove()" style="background:none;border:none;color:var(--m);font-size:20px;cursor:pointer">×</button>
      </div>
      <textarea id="cr-doctor-msg-txt" style="width:100%;min-height:320px;padding:12px;background:var(--s);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:12px;font-family:var(--fm);line-height:1.6;resize:vertical">${msg}</textarea>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn bp" onclick="(()=>{const t=document.getElementById('cr-doctor-msg-txt');t.select();navigator.clipboard.writeText(t.value).then(()=>showToast('success','Message copié')).catch(()=>showToast('error','Copie impossible'));})()"><span>📋</span> Copier</button>
        <button class="btn bs" onclick="document.getElementById('cr-doctor-msg-modal').remove()">Fermer</button>
      </div>
      <div style="margin-top:10px;font-size:10px;color:var(--m);line-height:1.5">
        ⚖️ Aide à la surveillance infirmière — ne remplace pas un avis médical.
      </div>
    </div>`;
  document.body.appendChild(modal);
}

/* ═════════════════════════════════════════════════════════════
   🆕 crHandleCabinetPull — Réception CR partagés du cabinet
   ─────────────────────────────────────────────────────────────
   Appelé par cabinet.js lors d'un pull sync.
   Règles :
   • Last-write-wins basé sur saved_at (pas d'écrasement d'un CR
     plus récent localement)
   • Marqueur _from_cabinet pour isolation visuelle
   • Déduplication par (patient_id + date + user_id_émetteur)
   • Les CR privés reçus par erreur sont IGNORÉS (double garde)
   ═════════════════════════════════════════════════════════════ */
async function crHandleCabinetPull(item) {
  if (!item || !Array.isArray(item.data?.compte_rendu_shared)) return 0;
  const incoming = item.data.compte_rendu_shared
    .filter(c => c && c.patient_id && (c.type === 'shared' || c.alert === true));

  if (!incoming.length) return 0;

  try {
    const db = await _crDb();
    // Lire tous les CR existants pour dédup
    const allExisting = await new Promise((res, rej) => {
      const tx = db.transaction(CR_STORE, 'readonly');
      const req = tx.objectStore(CR_STORE).getAll();
      req.onsuccess = e => res(e.target.result || []);
      req.onerror = e => rej(e.target.error);
    });

    // Signature de dédup : patient + date + émetteur
    const sigOf = c => `${c.patient_id}|${c.date}|${c.user_id || c._from_cabinet_user || ''}`;
    const existingMap = new Map();
    allExisting.forEach(c => {
      const s = sigOf(c);
      if (!existingMap.has(s) ||
          new Date(c.saved_at || c.date) > new Date(existingMap.get(s).saved_at || existingMap.get(s).date)) {
        existingMap.set(s, c);
      }
    });

    let inserted = 0;
    let updated  = 0;
    const tx = db.transaction(CR_STORE, 'readwrite');
    const store = tx.objectStore(CR_STORE);

    for (const remote of incoming) {
      const enriched = {
        ...remote,
        _from_cabinet:      item.sender_id || 'unknown',
        _from_cabinet_user: remote.user_id || '',
        _received_at:       new Date().toISOString(),
        type:               'shared', // force — seuls les CR partagés sont propagés
      };
      const sig = sigOf(enriched);
      const existing = existingMap.get(sig);
      if (!existing) {
        // Nouveau : insertion (sans id pour autoIncrement)
        const { id: _drop, ...noId } = enriched;
        store.add(noId);
        inserted++;
      } else {
        // Last-write-wins : n'écraser que si plus récent
        const remoteSaved = new Date(enriched.saved_at || enriched.date).getTime();
        const localSaved  = new Date(existing.saved_at || existing.date).getTime();
        if (remoteSaved > localSaved) {
          store.put({ ...enriched, id: existing.id });
          updated++;
        }
      }
    }

    await new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = e => rej(e.target.error); });

    // Notifier l'IDE si reçus
    const nb = inserted + updated;
    if (nb > 0 && typeof showToast === 'function') {
      const sender = item.sender_nom ? `${item.sender_prenom||''} ${item.sender_nom}`.trim() : 'votre collègue';
      showToast('info', `${nb} CR reçu(s)`, `Partagés par ${sender}${inserted && updated ? ` (${inserted} nouveau(x), ${updated} mis à jour)` : ''}`);
    }

    // Rafraîchir la vue CR si elle est ouverte sur le bon patient
    if (_crCurrentPatient && incoming.some(c => String(c.patient_id) === String(_crCurrentPatient))) {
      try { await crLoadHistory(); } catch {}
      try { await crRenderIntelligence(); } catch {}
    }

    return nb;
  } catch (e) {
    console.warn('[crHandleCabinetPull]', e.message);
    return 0;
  }
}

/* ═════════════════════════════════════════════════════════════
   🆕 Exports globaux — exposés pour cabinet.js
   ═════════════════════════════════════════════════════════════ */
window.crSelectPatient        = crSelectPatient;
window.crSave                 = crSave;
window.crReset                = crReset;
window.crEdit                 = crEdit;          // ⚡ v4.1
window.crDelete               = crDelete;        // ⚡ v4.1
window.crNewFromEdit          = crNewFromEdit;   // ⚡ v4.1
window.crGeneratePDF          = crGeneratePDF;
window.crGenerateDoctorPDF    = crGenerateDoctorPDF;
window.crGenerateDoctorMessage = crGenerateDoctorMessage;
window.crHandleCabinetPull    = crHandleCabinetPull;
window._crGetAllShared        = _crGetAllShared;
window.renderCompteRendu      = renderCompteRendu;

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'compte-rendu') renderCompteRendu();
});

// ✅ v8.9 — Sync inter-appareils au login : tire les CR du serveur
document.addEventListener('ami:login', () => {
  try { crSyncPull().catch(() => {}); } catch {}
});
