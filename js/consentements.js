/* ════════════════════════════════════════════════
   consentements.js — AMI v2.0 (cabinet sync + workflow médico-légal)
   ────────────────────────────────────────────────
   Modèle : UN consentement = UN patient × UN type × UNE version
           → partagé entre toutes les IDE du cabinet
           → versionné (trace médico-légale)
           → horodaté + hash (intégrité)
   ────────────────────────────────────────────────
   Fonctionnalités :
   1. Consentements pré-remplis (Pose sonde, Perfusion, Soins palliatifs, Photo, …)
   2. Signature patient sur canvas → hash SHA-256 stocké (RGPD-safe)
   3. Versionning automatique (chaque modif = nouvelle version, ancienne archivée)
   4. Synchronisation cabinet (patient-lié, toutes IDE voient le même statut)
   5. Détection « consentement manquant » avant acte (hook beforeCareCheck)
   6. Relance automatique intelligente (priorisation HIGH/MED/LOW)
   7. Dashboard conformité cabinet (compute via compliance-engine.js)
   8. Export PDF signé — audit-ready
   ────────────────────────────────────────────────
   Stockage IDB (local) :
     consentements: { id, patient_id, type, version, status,
                      signed_at, signature_hash, created_by, updated_by,
                      payload_hash, horodatage }
   ────────────────────────────────────────────────
   Sync cabinet :
     POST /webhook/cabinet-consent-push  — envoi vers les IDE du cabinet
     POST /webhook/cabinet-consent-pull  — récupération des MAJ
   ════════════════════════════════════════════════ */

const CONSENT_STORE = 'consentements';
const CONSENT_DB_VERSION = 3; // bump : ajout index type + status + version

/* ── Hash SHA-256 (intégrité) ─────────────────── */
async function _consentHash(s) {
  const data = new TextEncoder().encode(String(s || ''));
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/* ── IDB ──────────────────────────────────────── */
async function _consentDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ami_consentements', CONSENT_DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      let s;
      if (!db.objectStoreNames.contains(CONSENT_STORE)) {
        s = db.createObjectStore(CONSENT_STORE, { keyPath: 'id', autoIncrement: true });
      } else {
        s = e.target.transaction.objectStore(CONSENT_STORE);
      }
      if (!s.indexNames.contains('patient_id')) s.createIndex('patient_id', 'patient_id', { unique: false });
      if (!s.indexNames.contains('user_id'))    s.createIndex('user_id',    'user_id',    { unique: false });
      if (!s.indexNames.contains('type'))       s.createIndex('type',       'type',       { unique: false });
      if (!s.indexNames.contains('status'))     s.createIndex('status',     'status',     { unique: false });
      if (!s.indexNames.contains('pat_type'))   s.createIndex('pat_type',   ['patient_id','type'], { unique: false });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _consentPut(obj) {
  const db = await _consentDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONSENT_STORE, 'readwrite');
    const req = tx.objectStore(CONSENT_STORE).put(obj);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _consentGetAllRaw() {
  const db = await _consentDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(CONSENT_STORE, 'readonly');
    const req = tx.objectStore(CONSENT_STORE).getAll();
    req.onsuccess = e => resolve(e.target.result || []);
    req.onerror   = e => reject(e.target.error);
  });
}

/**
 * Récupère les consentements d'un patient (tous types + toutes versions)
 * Partagé cabinet : pas de filtrage par user_id — tous les membres du cabinet
 * voient les consentements du patient.
 */
async function _consentGetAll(patientId) {
  const all = await _consentGetAllRaw();
  return all
    .filter(c => c.patient_id === patientId)
    .sort((a, b) => new Date(b.horodatage || b.date || 0) - new Date(a.horodatage || a.date || 0));
}

/**
 * Récupère le consentement ACTIF (dernière version non archivée) pour un patient + type
 * → seul consentement valide, celui utilisé pour le check avant acte.
 */
async function _consentGetActive(patientId, type) {
  const list = await _consentGetAll(patientId);
  return list.find(c => c.type === type && c.status !== 'archived') || null;
}

/* ── Templates de consentement ──────────────── */
const CONSENT_TEMPLATES = {
  sonde_urinaire: {
    label: 'Sondage urinaire',
    icon: '🩺',
    validity_days: 180,
    risques: [
      'Inconfort ou douleur lors de la pose',
      'Infection urinaire (risque estimé 3–7% par jour de sonde)',
      'Traumatisme urétral (rare)',
      'Hémorragie légère',
    ],
    alternatives: 'Recueil d\'urines par étui pénien (homme), protection absorbante, rééducation sphinctérienne.',
    texte: `Je soussigné(e) consens à la pose et au maintien d'une sonde urinaire à demeure réalisée par l'infirmier(ère) soussigné(e). J'ai été informé(e) des indications, des risques et des alternatives à ce geste.`,
    actes_lies: ['sonde', 'sondage'],
  },
  perfusion: {
    label: 'Perfusion / Voie veineuse',
    icon: '💉',
    validity_days: 90,
    risques: [
      'Hématome ou douleur au point de ponction',
      'Phlébite ou inflammation veineuse',
      'Infection locale (risque faible)',
      'Réaction au traitement perfusé',
    ],
    alternatives: 'Traitement par voie orale si le médecin prescripteur le juge possible.',
    texte: `Je soussigné(e) consens à la pose d'une voie veineuse périphérique et à la réalisation de la perfusion prescrite. J'ai été informé(e) des risques inhérents à ce geste.`,
    actes_lies: ['perfusion', 'voie veineuse', 'iv', 'intraveineuse'],
  },
  soins_palliatifs: {
    label: 'Soins palliatifs / Soins de confort',
    icon: '🤝',
    validity_days: 365,
    risques: [
      'Adaptation possible du traitement antalgique selon évolution',
      'Risques liés aux médicaments prescrits (somnolence, etc.)',
    ],
    alternatives: 'Hospitalisation en unité de soins palliatifs si besoin d\'une prise en charge plus intensive.',
    texte: `Je soussigné(e) (ou représentant légal) consens aux soins palliatifs et de confort à domicile. J'ai été informé(e) que l'objectif est le maintien du confort et de la qualité de vie, et non la guérison.`,
    actes_lies: ['palliatif', 'confort'],
  },
  photo_soin: {
    label: 'Photographie de soin (plaie)',
    icon: '📸',
    validity_days: 180,
    risques: [
      'Photographie stockée sur l\'appareil de l\'infirmier(ère)',
      'Usage limité au suivi médical',
    ],
    alternatives: 'Suivi par description textuelle sans photographie.',
    texte: `Je soussigné(e) autorise l'infirmier(ère) soussigné(e) à photographier ma plaie/lésion dans le cadre unique du suivi infirmier. Ces photos sont stockées localement sur l'appareil de l'infirmier(ère), ne sont pas transmises à des tiers, et seront supprimées à la cicatrisation.`,
    actes_lies: ['photo', 'photographie'],
  },
  pansement_complexe: {
    label: 'Pansement complexe / Chirurgical',
    icon: '🩹',
    validity_days: 180,
    risques: [
      'Douleur lors du retrait du pansement',
      'Retard de cicatrisation en cas d\'infection',
      'Allergie au matériel utilisé (rare)',
    ],
    alternatives: 'Prise en charge en cabinet infirmier ou hospitalisation courte si douleurs importantes.',
    texte: `Je soussigné(e) consens à la réalisation de pansements complexes par l'infirmier(ère) soussigné(e), conformément à la prescription médicale.`,
    actes_lies: ['pansement complexe', 'escarre', 'plaie chronique'],
  },
  injection_sc_im: {
    label: 'Injection sous-cutanée / IM',
    icon: '💊',
    validity_days: 365,
    risques: [
      'Douleur et ecchymose au site d\'injection',
      'Réaction locale (rougeur, induration)',
      'Réaction allergique (rare)',
    ],
    alternatives: 'Traitement par voie orale si disponible et prescrit.',
    texte: `Je soussigné(e) consens aux injections sous-cutanées ou intramusculaires prescrites par mon médecin et réalisées par l'infirmier(ère) soussigné(e).`,
    actes_lies: ['injection', 'piqûre', 'insuline'],
  },
  telemedecine: {
    label: 'Télémédecine / Télésurveillance',
    icon: '📡',
    validity_days: 365,
    risques: [
      'Transmission de données via réseau sécurisé',
      'Interruption possible en cas de panne réseau',
    ],
    alternatives: 'Suivi 100% présentiel sans télésurveillance.',
    texte: `Je soussigné(e) consens à la télésurveillance et à la télétransmission de mes données de santé via le dispositif sécurisé proposé par mon infirmier(ère).`,
    actes_lies: ['télésurveillance', 'télémédecine'],
  },
};

/* ════════════════════════════════════════════════
   ÉTAT GLOBAL
════════════════════════════════════════════════ */
let _consentCurrentPatient = null;
let _consentType = null;
let _consentSignature = null; // data URL — transitoire, jamais persisté
let _consentCanvas = null;
let _consentDrawing = false;
let _consentLastPos = null;

/* ════════════════════════════════════════════════
   WORKFLOW — Création / Signature / Versionning
════════════════════════════════════════════════ */

/**
 * Crée ou met à jour un consentement (versionné).
 * Règle : un consentement signé avec succès devient la version active.
 *         Les anciennes versions sont archivées (status='archived').
 */
async function _consentCreateOrUpdate({ patient_id, type, signatureDataUrl, patient_nom, qualite, date }) {
  const tpl = CONSENT_TEMPLATES[type];
  if (!tpl) throw new Error('Type de consentement inconnu : ' + type);

  // Archiver la version active précédente (garder trace)
  const prev = await _consentGetActive(patient_id, type);
  if (prev) {
    prev.status = 'archived';
    prev.archived_at = new Date().toISOString();
    await _consentPut(prev);
  }

  // Hash de la signature (jamais stocker l'image brute — RGPD)
  const signature_hash = signatureDataUrl ? await _consentHash(signatureDataUrl) : '';

  // Hash du payload (intégrité médico-légale)
  const payloadForHash = {
    patient_id, type, version: (prev?.version || 0) + 1,
    signed_at: new Date().toISOString(),
    signature_hash,
    texte_version: tpl.texte,
  };
  const payload_hash = await _consentHash(JSON.stringify(payloadForHash));

  const obj = {
    patient_id,
    type,
    type_label:       tpl.label,
    version:          (prev?.version || 0) + 1,
    previous_version: prev?.version || null,
    status:           signature_hash ? 'signed' : 'pending',
    patient_nom:      patient_nom || '',
    qualite:          qualite || '',
    date:             date || new Date().toISOString().slice(0,10),
    signed_at:        signature_hash ? new Date().toISOString() : null,
    signature_hash,
    payload_hash,
    texte:            tpl.texte,
    validity_days:    tpl.validity_days || 365,
    expires_at:       new Date(Date.now() + (tpl.validity_days || 365)*86400000).toISOString(),
    created_by:       APP?.user?.id || '',
    created_by_nom:   `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim(),
    updated_by:       APP?.user?.id || '',
    cabinet_id:       APP?.get?.('cabinet')?.id || null,
    horodatage:       new Date().toISOString(),
  };
  const id = await _consentPut(obj);
  obj.id = id;

  // Audit local + sync cabinet (best-effort, non bloquant)
  try { if (typeof auditLog === 'function') auditLog('CONSENT_SIGNED', { patient_id, type, version: obj.version }); } catch(_){}
  _consentSyncToCabinet(obj).catch(() => {}); // async fire-and-forget

  return obj;
}

/** Vérifie l'expiration d'un consentement. */
function _consentIsExpired(c) {
  if (!c?.expires_at) return false;
  return new Date(c.expires_at) < new Date();
}

function _consentIsExpiringSoon(c, daysAhead = 14) {
  if (!c?.expires_at) return false;
  const now = new Date();
  const limit = new Date(now.getTime() + daysAhead*86400000);
  const exp = new Date(c.expires_at);
  return exp > now && exp < limit;
}

/* ════════════════════════════════════════════════
   SYNCHRONISATION CABINET (patient-lié, partagé)
════════════════════════════════════════════════ */
async function _consentSyncToCabinet(consent) {
  const cabinetId = APP?.get?.('cabinet')?.id;
  if (!cabinetId) return; // pas de cabinet → stockage local uniquement

  // Payload léger — jamais la signature brute
  const payload = {
    cabinet_id:     cabinetId,
    patient_id:     consent.patient_id,
    type:           consent.type,
    type_label:     consent.type_label,
    version:        consent.version,
    status:         consent.status,
    signed_at:      consent.signed_at,
    signature_hash: consent.signature_hash,
    payload_hash:   consent.payload_hash,
    validity_days:  consent.validity_days,
    expires_at:     consent.expires_at,
    created_by:     consent.created_by,
    created_by_nom: consent.created_by_nom,
    horodatage:     consent.horodatage,
  };
  try {
    if (typeof apiCall === 'function') {
      await apiCall('/webhook/cabinet-consent-push', { consents: [payload] });
    }
  } catch (e) {
    console.warn('[consent] sync cabinet KO (retry plus tard):', e.message);
  }
}

/** Récupère les consentements partagés du cabinet (pull).
 *  Merge intelligent : la version la plus récente écrase la locale. */
async function consentPullFromCabinet() {
  const cabinetId = APP?.get?.('cabinet')?.id;
  if (!cabinetId || typeof apiCall !== 'function') return { pulled: 0 };

  try {
    const d = await apiCall('/webhook/cabinet-consent-pull', { cabinet_id: cabinetId });
    if (!d?.ok || !Array.isArray(d.consents)) return { pulled: 0 };

    let pulled = 0;
    for (const remote of d.consents) {
      const local = await _consentGetActive(remote.patient_id, remote.type);
      // La version remote est plus récente OU absente en local → appliquer
      if (!local || (remote.version > (local.version || 0))) {
        if (local) {
          local.status = 'archived';
          local.archived_at = new Date().toISOString();
          await _consentPut(local);
        }
        await _consentPut({
          ...remote,
          _synced_from_cabinet: true,
          _synced_at: new Date().toISOString(),
        });
        pulled++;
      }
    }
    return { pulled };
  } catch (e) {
    console.warn('[consent] pull cabinet KO:', e.message);
    return { pulled: 0, error: e.message };
  }
}

/* ════════════════════════════════════════════════
   CHECK AVANT ACTE (beforeCareCheck)
   ────────────────────────────────────────────────
   Retourne { allowed, reason, consent, level }
   level : 'BLOCK' (strict) | 'WARN' (soft) | 'OK'
════════════════════════════════════════════════ */
async function consentCheckBeforeAct(patient_id, actTextOrType) {
  if (!patient_id) return { allowed: true, reason: 'NO_PATIENT_ID', level: 'OK' };

  const text = String(actTextOrType || '').toLowerCase();
  let requiredTypes = [];

  // Match direct si actTextOrType = clé de template
  if (CONSENT_TEMPLATES[actTextOrType]) {
    requiredTypes = [actTextOrType];
  } else {
    for (const [k, tpl] of Object.entries(CONSENT_TEMPLATES)) {
      if (tpl.actes_lies?.some(mot => text.includes(mot))) {
        requiredTypes.push(k);
      }
    }
  }

  if (!requiredTypes.length) return { allowed: true, reason: 'NO_CONSENT_REQUIRED', level: 'OK' };

  const missing = [];
  const expired = [];
  for (const t of requiredTypes) {
    const c = await _consentGetActive(patient_id, t);
    if (!c || c.status !== 'signed') missing.push(t);
    else if (_consentIsExpired(c))   expired.push(t);
  }

  if (missing.length || expired.length) {
    const strictMode = APP?.get?.('consent_mode') === 'STRICT';
    return {
      allowed:     !strictMode,
      level:       strictMode ? 'BLOCK' : 'WARN',
      reason:      missing.length ? 'CONSENT_MISSING' : 'CONSENT_EXPIRED',
      missing,
      expired,
      types:       [...missing, ...expired],
      types_label: [...missing, ...expired].map(t => CONSENT_TEMPLATES[t]?.label || t),
    };
  }

  return { allowed: true, reason: 'CONSENT_OK', level: 'OK' };
}

/* ════════════════════════════════════════════════
   RELANCES INTELLIGENTES
════════════════════════════════════════════════ */
async function consentBuildReminders() {
  const all = await _consentGetAllRaw();
  const byPatTypeActive = {};
  for (const c of all) {
    if (c.status === 'archived') continue;
    const k = c.patient_id + '|' + c.type;
    if (!byPatTypeActive[k] || c.version > byPatTypeActive[k].version) {
      byPatTypeActive[k] = c;
    }
  }

  const reminders = [];
  for (const c of Object.values(byPatTypeActive)) {
    if (_consentIsExpired(c)) {
      reminders.push({
        id:         'CONSENT_EXP_' + c.id,
        patient_id: c.patient_id,
        type:       c.type,
        type_label: c.type_label || CONSENT_TEMPLATES[c.type]?.label,
        status:     'expired',
        priority:   'HIGH',
        label:      `Renouveler consentement : ${c.type_label || c.type}`,
      });
    } else if (_consentIsExpiringSoon(c, 14)) {
      reminders.push({
        id:         'CONSENT_SOON_' + c.id,
        patient_id: c.patient_id,
        type:       c.type,
        type_label: c.type_label || CONSENT_TEMPLATES[c.type]?.label,
        status:     'expiring',
        priority:   'MEDIUM',
        label:      `Consentement à renouveler bientôt : ${c.type_label || c.type}`,
      });
    } else if (c.status === 'pending') {
      reminders.push({
        id:         'CONSENT_PEND_' + c.id,
        patient_id: c.patient_id,
        type:       c.type,
        type_label: c.type_label || CONSENT_TEMPLATES[c.type]?.label,
        status:     'pending',
        priority:   'HIGH',
        label:      `Signature manquante : ${c.type_label || c.type}`,
      });
    }
  }

  const order = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  reminders.sort((a, b) => order[b.priority] - order[a.priority]);
  return reminders;
}

/* ════════════════════════════════════════════════
   SCORING CONFORMITÉ (pilier consentements)
════════════════════════════════════════════════ */
async function consentComputeScore() {
  const all = await _consentGetAllRaw();
  const active = all.filter(c => c.status !== 'archived');
  if (!active.length) return { score: 100, total: 0, valid: 0, missing: 0, expired: 0 };

  const signed  = active.filter(c => c.status === 'signed' && !_consentIsExpired(c)).length;
  const pending = active.filter(c => c.status === 'pending').length;
  const expired = active.filter(c => _consentIsExpired(c)).length;
  const total   = active.length;

  return {
    score:   Math.round((signed / total) * 100),
    total,
    valid:   signed,
    missing: pending,
    expired,
  };
}

/* ════════════════════════════════════════════════
   RENDU PRINCIPAL
════════════════════════════════════════════════ */
async function renderConsentements() {
  const wrap = document.getElementById('consentements-root');
  if (!wrap) return;

  // Pull cabinet en fond avant render (silencieux)
  consentPullFromCabinet().catch(() => {});

  let patients = [];
  try { if (typeof getAllPatients === 'function') patients = await getAllPatients(); } catch (_) {}

  const score     = await consentComputeScore();
  const reminders = await consentBuildReminders();

  wrap.innerHTML = `
    <h1 class="pt">Consentements <em>éclairés</em></h1>
    <p class="ps">Protection médico-légale · Signature patient · Archivage horodaté · Partagé cabinet</p>

    <!-- Dashboard mini-compliance -->
    <div class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:16px">
      <div><div style="font-size:11px;color:var(--m)">Conformité</div>
        <div style="font-size:24px;font-weight:700;color:${score.score>=90?'#00d4aa':score.score>=70?'#f59e0b':'#ef4444'}">${score.score}%</div></div>
      <div><div style="font-size:11px;color:var(--m)">Signés valides</div>
        <div style="font-size:24px;font-weight:700;color:var(--t)">${score.valid}</div></div>
      <div><div style="font-size:11px;color:var(--m)">En attente</div>
        <div style="font-size:24px;font-weight:700;color:${score.missing?'#f59e0b':'var(--m)'}">${score.missing}</div></div>
      <div><div style="font-size:11px;color:var(--m)">Expirés</div>
        <div style="font-size:24px;font-weight:700;color:${score.expired?'#ef4444':'var(--m)'}">${score.expired}</div></div>
    </div>

    ${reminders.length ? `
    <div class="card" style="margin-bottom:16px;border-left:4px solid #f59e0b">
      <div style="font-weight:600;margin-bottom:10px;font-size:13px">⚠️ ${reminders.length} action${reminders.length>1?'s':''} requise${reminders.length>1?'s':''}</div>
      ${reminders.slice(0, 5).map(r => `
        <div style="font-size:12px;padding:6px 0;border-bottom:1px solid var(--b)">
          <span style="color:${r.priority==='HIGH'?'#ef4444':'#f59e0b'};margin-right:6px">
            ${r.priority==='HIGH'?'🔴':'🟠'}
          </span>${r.label}
        </div>
      `).join('')}
      ${reminders.length > 5 ? `<div style="font-size:11px;color:var(--m);margin-top:6px">+${reminders.length-5} autres…</div>` : ''}
    </div>` : ''}

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">🛡️</span><p>Le consentement éclairé est une obligation légale (Art. L1111-4 CSP). Ces formulaires vous protègent en cas de litige ou de contrôle. Les consentements sont <strong>partagés avec les IDE de votre cabinet</strong> — ils restent rattachés au patient, pas à vous.</p></div>

      <div class="lbl" style="margin-bottom:8px">Patient</div>
      <select id="consent-patient-sel" onchange="consentSelectPatient(this.value)" style="width:100%;margin-bottom:16px;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
        <option value="">— Sélectionner un patient —</option>
        ${patients.map(p => `<option value="${p.id}">${p.nom||''} ${p.prenom||''}</option>`).join('')}
      </select>

      <div id="consent-type-section" style="display:none">
        <div class="lbl" style="margin-bottom:12px">Type de consentement</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:20px">
          ${Object.entries(CONSENT_TEMPLATES).map(([key, tpl]) => `
            <button onclick="consentSelectType('${key}')" id="consent-type-btn-${key}" class="btn bs" style="display:flex;align-items:center;gap:8px;padding:12px 14px;text-align:left;height:auto">
              <span style="font-size:20px;flex-shrink:0">${tpl.icon}</span>
              <span style="font-size:12px;line-height:1.3">${tpl.label}</span>
            </button>`).join('')}
        </div>

        <div id="consent-form-section" style="display:none">
          <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:16px;margin-bottom:16px">
            <div id="consent-form-title" style="font-weight:700;font-size:15px;margin-bottom:10px"></div>
            <div id="consent-risques-list" style="margin-bottom:12px"></div>
            <div id="consent-alternatives" style="margin-bottom:12px"></div>
            <div id="consent-text-box" style="font-size:12px;color:var(--t);line-height:1.6;padding:10px;background:var(--dd);border-radius:8px"></div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
            <div><div class="lbl">Patient (nom)</div><input id="consent-patient-nom" type="text" class="inp" style="width:100%"></div>
            <div><div class="lbl">Qualité</div><input id="consent-qualite" type="text" class="inp" placeholder="Patient / Tuteur / Parent" style="width:100%"></div>
          </div>
          <div style="margin-bottom:12px"><div class="lbl">Date</div><input id="consent-date" type="date" class="inp" style="width:100%"></div>

          <div class="lbl">Signature patient</div>
          <canvas id="consent-sig-canvas" width="600" height="180" style="width:100%;max-width:100%;height:180px;border:2px dashed var(--b);border-radius:10px;background:#fff;touch-action:none;cursor:crosshair"></canvas>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
            <button class="btn bs bsm" onclick="consentClearSig()">🧹 Effacer</button>
            <button class="btn bp bsm" onclick="consentSave()">💾 Archiver</button>
            <button class="btn bs bsm" onclick="consentPrint()">🖨️ PDF</button>
          </div>
        </div>
      </div>
    </div>

    <div id="consent-history-wrap" class="card" style="margin-top:16px;display:none">
      <h3 style="font-size:14px;margin-bottom:10px">Historique consentements <em>(toutes IDE cabinet)</em></h3>
      <div id="consent-history-list"></div>
    </div>
  `;
}

function consentSelectPatient(pid) {
  _consentCurrentPatient = pid || null;
  const section  = document.getElementById('consent-type-section');
  const histWrap = document.getElementById('consent-history-wrap');
  if (!pid) {
    if (section)  section.style.display  = 'none';
    if (histWrap) histWrap.style.display = 'none';
    return;
  }
  if (section)  section.style.display  = 'block';
  if (histWrap) histWrap.style.display = 'block';
  consentLoadHistory();

  const sel   = document.getElementById('consent-patient-sel');
  const nomEl = document.getElementById('consent-patient-nom');
  if (sel && nomEl) {
    nomEl.value = sel.options[sel.selectedIndex]?.text || '';
  }
}

function consentSelectType(type) {
  _consentType = type;
  const tpl = CONSENT_TEMPLATES[type];
  if (!tpl) return;

  Object.keys(CONSENT_TEMPLATES).forEach(k => {
    const btn = document.getElementById(`consent-type-btn-${k}`);
    if (btn) {
      btn.className = k === type ? 'btn bp' : 'btn bs';
      btn.style.cssText = 'display:flex;align-items:center;gap:8px;padding:12px 14px;text-align:left;height:auto';
    }
  });

  const section = document.getElementById('consent-form-section');
  if (section) section.style.display = 'block';

  const titleEl = document.getElementById('consent-form-title');
  if (titleEl) titleEl.textContent = `${tpl.icon} ${tpl.label} · validité ${tpl.validity_days||365} j`;

  const risquesEl = document.getElementById('consent-risques-list');
  if (risquesEl) risquesEl.innerHTML = `
    <div style="font-size:12px;font-family:var(--fm);color:var(--m);margin-bottom:6px">⚠️ Risques expliqués au patient :</div>
    <ul style="margin:0;padding-left:20px">${tpl.risques.map(r => `<li style="font-size:12px;color:var(--t);margin-bottom:3px">${r}</li>`).join('')}</ul>`;

  const altEl = document.getElementById('consent-alternatives');
  if (altEl) altEl.innerHTML = `<div style="font-size:12px;color:var(--m);font-family:var(--fm)">🔄 <strong>Alternatives proposées :</strong> ${tpl.alternatives}</div>`;

  const textEl = document.getElementById('consent-text-box');
  if (textEl) textEl.textContent = tpl.texte;

  setTimeout(() => {
    const canvas = document.getElementById('consent-sig-canvas');
    if (canvas) {
      _consentCanvas = canvas;
      _consentSignature = null;
      _initConsentCanvas(canvas);
    }
  }, 100);
}

function _initConsentCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#00d4aa';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  const getPos = e => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - rect.left) * scaleX, y: (src.clientY - rect.top) * scaleY };
  };

  canvas.addEventListener('mousedown',  e => { _consentDrawing = true; _consentLastPos = getPos(e); });
  canvas.addEventListener('mousemove',  e => { if (!_consentDrawing) return; const p=getPos(e); ctx.beginPath(); ctx.moveTo(_consentLastPos.x, _consentLastPos.y); ctx.lineTo(p.x,p.y); ctx.stroke(); _consentLastPos=p; });
  canvas.addEventListener('mouseup',    () => { _consentDrawing = false; _consentSignature = canvas.toDataURL(); });
  canvas.addEventListener('touchstart', e => { e.preventDefault(); _consentDrawing=true; _consentLastPos=getPos(e); }, { passive:false });
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if(!_consentDrawing)return; const p=getPos(e); ctx.beginPath(); ctx.moveTo(_consentLastPos.x,_consentLastPos.y); ctx.lineTo(p.x,p.y); ctx.stroke(); _consentLastPos=p; }, { passive:false });
  canvas.addEventListener('touchend',   () => { _consentDrawing=false; _consentSignature=canvas.toDataURL(); });
}

function consentClearSig() {
  const canvas = document.getElementById('consent-sig-canvas');
  if (canvas) {
    canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
    _consentSignature = null;
  }
}

async function consentSave() {
  if (!_consentCurrentPatient || !_consentType) {
    if (typeof showToast === 'function') showToast('warning','Sélectionnez un patient et un type');
    return;
  }
  if (!_consentSignature) {
    if (typeof showToast === 'function') showToast('warning','Signature requise','Le patient doit signer dans le cadre.');
    return;
  }
  try {
    const obj = await _consentCreateOrUpdate({
      patient_id:       _consentCurrentPatient,
      type:             _consentType,
      signatureDataUrl: _consentSignature,
      patient_nom:      document.getElementById('consent-patient-nom')?.value?.trim() || '',
      qualite:          document.getElementById('consent-qualite')?.value?.trim() || '',
      date:             document.getElementById('consent-date')?.value || new Date().toISOString().slice(0,10),
    });
    // Signature transitoire effacée — seul le hash est persisté
    _consentSignature = null;
    if (typeof showToast === 'function')
      showToast('success', `Consentement v${obj.version} archivé`, `${obj.type_label} · Signé · Partagé cabinet`);
    await consentLoadHistory();
    await renderConsentements(); // Rafraîchir score + reminders
  } catch (err) {
    if (typeof showToast === 'function') showToast('error','Erreur', err.message);
  }
}

function consentPrint() {
  const tpl = CONSENT_TEMPLATES[_consentType];
  if (!tpl) return;
  const sig = _consentSignature || '';
  const patNom = document.getElementById('consent-patient-nom')?.value || '—';
  const d = document.getElementById('consent-date')?.value || new Date().toISOString().slice(0,10);
  const infNom = `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim() || '—';

  const w = window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Consentement AMI</title>
    <style>body{font-family:Arial,sans-serif;padding:30px;color:#000;max-width:680px;margin:0 auto}h1{font-size:16px}p{font-size:13px;line-height:1.7}ul{font-size:12px}.hash{font-family:monospace;font-size:10px;word-break:break-all;color:#666}@media print{@page{margin:15mm}}</style>
    </head><body>
    <h1>${tpl.icon} Formulaire de consentement éclairé — ${tpl.label}</h1>
    <p><strong>Patient :</strong> ${patNom} · <strong>Date :</strong> ${d}</p>
    <p><strong>Infirmier(ère) :</strong> ${infNom}</p>
    <h2>Risques expliqués</h2><ul>${tpl.risques.map(r=>`<li>${r}</li>`).join('')}</ul>
    <h2>Alternatives</h2><p>${tpl.alternatives}</p>
    <h2>Consentement</h2><p>${tpl.texte}</p>
    ${sig ? `<h2>Signature du patient</h2><img src="${sig}" style="border:1px solid #ccc;border-radius:4px;max-width:300px;height:auto">` : ''}
    <p style="font-size:10px;color:#888;margin-top:20px">Généré par AMI · ${new Date().toLocaleString('fr-FR')}</p>
    </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

async function consentLoadHistory() {
  if (!_consentCurrentPatient) return;
  const list = document.getElementById('consent-history-list');
  if (!list) return;
  try {
    const all = await _consentGetAll(_consentCurrentPatient);
    if (!all.length) { list.innerHTML = '<div class="empty"><p>Aucun consentement archivé.</p></div>'; return; }
    list.innerHTML = all.slice(0,20).map(c => {
      const d = new Date(c.horodatage || c.date).toLocaleString('fr-FR');
      const tpl = CONSENT_TEMPLATES[c.type] || {};
      const expired = _consentIsExpired(c);
      const statusIcon = c.status === 'archived' ? '📜'
                       : c.status === 'pending'  ? '⏳'
                       : expired                 ? '❌'
                       : '✅';
      const statusColor = c.status === 'archived' ? 'var(--m)'
                        : c.status === 'pending'  ? '#f59e0b'
                        : expired                 ? '#ef4444'
                        : '#00d4aa';
      const byWho = c.created_by_nom ? ` · par ${c.created_by_nom}` : '';
      return `
        <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px;margin-bottom:8px;border-left:4px solid ${statusColor}">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
            <div>
              <div style="font-size:13px;font-weight:600">${tpl.icon||'📋'} ${c.type_label} <span style="font-size:11px;color:var(--m)">v${c.version||1}</span></div>
              <div style="font-size:11px;color:var(--m);margin-top:2px">${d} · ${c.patient_nom||'—'}${byWho}</div>
              ${c.signature_hash ? `<div style="font-size:10px;color:var(--m);margin-top:3px;font-family:monospace" title="Hash d'intégrité">🔒 ${c.signature_hash.slice(0,16)}…</div>` : ''}
            </div>
            <div style="font-size:11px;color:${statusColor};font-weight:600">${statusIcon} ${c.status}${expired && c.status==='signed'?' (expiré)':''}</div>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="msg e">Erreur : ${err.message}</div>`;
  }
}

/* ════════════════════════════════════════════════
   EXPOSITION GLOBALE — API publique
════════════════════════════════════════════════ */
window.consentCheckBeforeAct  = consentCheckBeforeAct;
window.consentBuildReminders  = consentBuildReminders;
window.consentComputeScore    = consentComputeScore;
window.consentPullFromCabinet = consentPullFromCabinet;
window._consentGetActive      = _consentGetActive;
window._consentGetAllRaw      = _consentGetAllRaw;
window.CONSENT_TEMPLATES      = CONSENT_TEMPLATES;

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'consentements') renderConsentements();
});
