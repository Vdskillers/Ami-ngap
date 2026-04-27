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
const CONSENT_TOMBSTONE_STORE = 'consentements_tombstones';
const CONSENT_DB_VERSION = 4; // bump : ajout store tombstones

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

      // Store des tombstones : un consentement supprimé = un payload_hash mémorisé
      // → permet à consentSyncPull de filtrer les remontées d'un autre appareil
      if (!db.objectStoreNames.contains(CONSENT_TOMBSTONE_STORE)) {
        const t = db.createObjectStore(CONSENT_TOMBSTONE_STORE, { keyPath: 'payload_hash' });
        t.createIndex('deleted_at',  'deleted_at',  { unique: false });
        t.createIndex('synced',      'synced',      { unique: false });
        t.createIndex('patient_id',  'patient_id',  { unique: false });
      }
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

async function _consentDelete(id) {
  const db = await _consentDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(CONSENT_STORE, 'readwrite');
    const req = tx.objectStore(CONSENT_STORE).delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _consentGetById(id) {
  const db = await _consentDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(CONSENT_STORE, 'readonly');
    const req = tx.objectStore(CONSENT_STORE).get(id);
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = e => reject(e.target.error);
  });
}

/* ════════════════════════════════════════════════
   TOMBSTONES — Suppression cross-device fiable
   ────────────────────────────────────────────────
   Un tombstone est l'empreinte (payload_hash) d'un consentement supprimé.
   Stockés localement, synchronisés via le worker, ils empêchent les autres
   appareils de réinjecter le consentement supprimé via consentSyncPull.
═══════════════════════════════════════════════ */

/** Ajoute un tombstone local (idempotent — UNIQUE sur payload_hash). */
async function _consentTombstoneAdd({ payload_hash, patient_id, consent_type, consent_version }) {
  if (!payload_hash) return false;
  const db = await _consentDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONSENT_TOMBSTONE_STORE, 'readwrite');
    const obj = {
      payload_hash,
      patient_id:      patient_id || null,
      consent_type:    consent_type || null,
      consent_version: consent_version || null,
      deleted_at:      new Date().toISOString(),
      synced:          0, // 0 = pas encore poussé au serveur, 1 = poussé
    };
    const req = tx.objectStore(CONSENT_TOMBSTONE_STORE).put(obj);
    req.onsuccess = () => resolve(true);
    req.onerror   = e => reject(e.target.error);
  });
}

/** Récupère tous les tombstones locaux (Set des payload_hash pour lookup O(1)). */
async function _consentTombstoneGetSet() {
  const db = await _consentDb();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(CONSENT_TOMBSTONE_STORE)) return resolve(new Set());
    const tx  = db.transaction(CONSENT_TOMBSTONE_STORE, 'readonly');
    const req = tx.objectStore(CONSENT_TOMBSTONE_STORE).getAll();
    req.onsuccess = e => {
      const all = e.target.result || [];
      resolve(new Set(all.map(t => t.payload_hash).filter(Boolean)));
    };
    req.onerror = e => reject(e.target.error);
  });
}

/** Récupère les tombstones non encore synchronisés vers le worker. */
async function _consentTombstoneGetUnsynced() {
  const db = await _consentDb();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(CONSENT_TOMBSTONE_STORE)) return resolve([]);
    const tx  = db.transaction(CONSENT_TOMBSTONE_STORE, 'readonly');
    const req = tx.objectStore(CONSENT_TOMBSTONE_STORE).getAll();
    req.onsuccess = e => resolve((e.target.result || []).filter(t => !t.synced));
    req.onerror   = e => reject(e.target.error);
  });
}

/** Marque un lot de tombstones comme synchronisés vers le worker. */
async function _consentTombstoneMarkSynced(payloadHashes) {
  if (!payloadHashes?.length) return;
  const db = await _consentDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONSENT_TOMBSTONE_STORE, 'readwrite');
    const st = tx.objectStore(CONSENT_TOMBSTONE_STORE);
    let remaining = payloadHashes.length;
    for (const h of payloadHashes) {
      const r = st.get(h);
      r.onsuccess = e => {
        const rec = e.target.result;
        if (rec) {
          rec.synced = 1;
          rec.synced_at = new Date().toISOString();
          st.put(rec);
        }
        if (--remaining === 0) resolve(true);
      };
      r.onerror = () => { if (--remaining === 0) resolve(false); };
    }
    tx.onerror = e => reject(e.target.error);
  });
}

/**
 * Pousse les tombstones non synchronisés vers le worker.
 * Pattern fire-and-forget : non bloquant, retry au prochain appel si échec.
 */
async function _consentTombstonePush() {
  try {
    const unsynced = await _consentTombstoneGetUnsynced();
    if (!unsynced.length) return { pushed: 0 };

    const payload = {
      tombstones: unsynced.map(t => ({
        payload_hash:    t.payload_hash,
        patient_id:      t.patient_id,
        consent_type:    t.consent_type,
        consent_version: t.consent_version,
        deleted_at:      t.deleted_at,
      })),
    };

    const resp = await _consentWpost('/webhook/consentements-tombstone', payload);
    if (resp?.ok && (resp.recorded ?? 0) >= 0) {
      // Marque comme synchronisés même si recorded=0 (cas merge-duplicates)
      await _consentTombstoneMarkSynced(unsynced.map(t => t.payload_hash));
      return { pushed: unsynced.length };
    }
    return { pushed: 0, error: 'unexpected_response' };
  } catch (e) {
    console.warn('[consentTombstonePush]', e.message);
    return { pushed: 0, error: e.message };
  }
}

/**
 * Récupère les tombstones du serveur (de tous les appareils du user) et les
 * applique localement : suppression effective des consentements correspondants
 * dans l'IDB locale + insertion des tombstones manquants.
 */
async function _consentTombstonePull() {
  try {
    const resp = await _consentWpost('/webhook/consentements-tombstones-pull', {});
    if (!resp?.ok || !Array.isArray(resp.tombstones)) return { applied: 0 };

    const remoteTombs = resp.tombstones;
    if (!remoteTombs.length) return { applied: 0 };

    // 1. Insérer les tombstones manquants en local (déjà marqués synced=1)
    const localSet = await _consentTombstoneGetSet();
    const db = await _consentDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CONSENT_TOMBSTONE_STORE, 'readwrite');
      const st = tx.objectStore(CONSENT_TOMBSTONE_STORE);
      for (const t of remoteTombs) {
        if (!t.payload_hash) continue;
        if (localSet.has(t.payload_hash)) continue;
        st.put({
          payload_hash:    t.payload_hash,
          patient_id:      t.patient_id,
          consent_type:    t.consent_type,
          consent_version: t.consent_version,
          deleted_at:      t.deleted_at,
          synced:          1,
          synced_at:       new Date().toISOString(),
          _from_remote:    true,
        });
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror    = e  => reject(e.target.error);
    });

    // 2. Construire un Set complet des hash supprimés (local + serveur)
    const allTombs = new Set([...localSet, ...remoteTombs.map(t => t.payload_hash).filter(Boolean)]);

    // 3. Supprimer de l'IDB locale les consentements dont le hash est dans le set
    const allLocal = await _consentGetAllRaw();
    let applied = 0;
    for (const c of allLocal) {
      if (c.payload_hash && allTombs.has(c.payload_hash)) {
        await _consentDelete(c.id);
        applied++;
      }
    }

    if (applied > 0) {
      console.info(`[consentTombstonePull] ${applied} consentement(s) supprimé(s) suite à tombstones distants.`);
    }
    return { applied };
  } catch (e) {
    console.warn('[consentTombstonePull]', e.message);
    return { applied: 0, error: e.message };
  }
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
 *
 * Stockage de la signature brute :
 *   - Le PNG (signatureDataUrl) est conservé EN LOCAL uniquement, pour permettre
 *     l'affichage visuel sur le PDF du consentement et dans l'historique.
 *   - Il est PURGÉ au sync push (cf. consentSyncPush) — seul le hash part vers
 *     le backend, ce qui reste RGPD/HDS-compatible.
 *   - Le invoice_id permet, en fallback, de récupérer la signature canonique
 *     depuis ami_signatures (source de vérité médico-légale via signature.js).
 */
async function _consentCreateOrUpdate({ patient_id, type, signatureDataUrl, patient_nom, qualite, date, invoice_id }) {
  const tpl = CONSENT_TEMPLATES[type];
  if (!tpl) throw new Error('Type de consentement inconnu : ' + type);

  // Archiver la version active précédente (garder trace)
  const prev = await _consentGetActive(patient_id, type);
  if (prev) {
    prev.status = 'archived';
    prev.archived_at = new Date().toISOString();
    await _consentPut(prev);
  }

  // Hash de la signature (intégrité — toujours envoyé au backend)
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
    // ⚡ Signature brute — stockée en local uniquement, purgée au sync push (RGPD/HDS)
    // Permet l'affichage visuel dans l'historique et le PDF de consentement.
    signatureDataUrl: signatureDataUrl || null,
    // ⚡ Lien vers la signature canonique dans ami_signatures (source de vérité
    // médico-légale via signature.js). Sert de fallback si signatureDataUrl absente.
    invoice_id:       invoice_id || null,
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

  // Audit local + sync cabinet + sync user (best-effort, non bloquant)
  try { if (typeof auditLog === 'function') auditLog('CONSENT_SIGNED', { patient_id, type, version: obj.version }); } catch(_){}
  _consentSyncToCabinet(obj).catch(() => {}); // async fire-and-forget
  consentSyncPush().catch(() => {});          // sync user-level (tous appareils)

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

/**
 * Résout la signature visuelle d'un consentement avec une chaîne de fallback :
 *   1. c.signatureDataUrl     → signature stockée localement dans le consentement
 *   2. getSignature(invoice_id) → signature canonique de l'acte (ami_signatures)
 *   3. null                   → aucune signature disponible (afficher hash uniquement)
 *
 * Cette fonction permet d'afficher la même signature que celle de la cotation
 * dans le PDF/historique du consentement éclairé associé au même acte.
 */
async function _consentResolveSignature(c) {
  if (!c) return null;
  // 1. Stockée directement dans le consentement (créé après le patch sig→consent)
  if (c.signatureDataUrl) return c.signatureDataUrl;
  // 2. Fallback : récupérer depuis ami_signatures via invoice_id (source canonique)
  if (c.invoice_id) {
    try {
      const fn = (typeof getSignature === 'function')
        ? getSignature
        : (typeof window.getSignature === 'function' ? window.getSignature : null);
      if (fn) {
        const png = await fn(c.invoice_id);
        if (png) return png;
      }
    } catch (_) { /* fallback silencieux — on retombe sur null */ }
  }
  return null;
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
   SYNCHRONISATION USER-LEVEL (tous appareils du même compte)
   ────────────────────────────────────────────────
   Permet à une infirmière de retrouver ses consentements signés
   sur tous ses appareils (téléphone ↔ tablette ↔ desktop).
   Fonctionne SANS cabinet — c'est le cas d'usage solo.

   • Obfuscation btoa + clé dérivée userId (stable tous appareils)
   • Endpoints : /webhook/consentements-push · /webhook/consentements-pull
   • Table Supabase : consentements_sync (RLS par infirmiere_id)
   • Modèle copié à l'identique de constantes.js / piluliers.js

   ⚠️ RGPD/HDS : les signatures brutes ne sont JAMAIS envoyées.
      Seuls les hashes + métadonnées partent vers le backend.
════════════════════════════════════════════════ */

function _consentSyncKey() {
  const uid = APP?.user?.id || APP?.user?.email || 'local';
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (Math.imul(31, h) + uid.charCodeAt(i)) | 0;
  return 'sk_cons_' + String(Math.abs(h));
}
function _consentEnc(obj) {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(obj) + '|' + _consentSyncKey()))); }
  catch { return null; }
}
function _consentDec(str) {
  try {
    const raw = decodeURIComponent(escape(atob(str)));
    const sep = raw.lastIndexOf('|');
    return JSON.parse(raw.slice(0, sep));
  } catch { return null; }
}

/* Helper wpost — tolérant à l'absence (retombe sur apiCall s'il existe) */
async function _consentWpost(path, body) {
  if (typeof wpost === 'function') return wpost(path, body);
  if (typeof apiCall === 'function') return apiCall(path, body);
  return null;
}

/**
 * Pousse TOUS les consentements locaux (actifs ET archivés) vers Supabase.
 * Signatures brutes retirées — seuls hashes + métadonnées partent.
 * Fire-and-forget : erreurs loggées mais non bloquantes.
 */
async function consentSyncPush() {
  const uid = APP?.user?.id;
  if (!uid) return;

  try {
    const all = await _consentGetAllRaw();
    if (!Array.isArray(all) || !all.length) return;

    // Purge des champs sensibles (signature brute) avant envoi
    const sanitized = all.map(c => {
      const { signatureDataUrl, signature_raw, _raw_signature, ...clean } = c;
      return clean;
    });

    const encrypted_data = _consentEnc(sanitized);
    if (!encrypted_data) return;

    await _consentWpost('/webhook/consentements-push', {
      encrypted_data,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[consentSyncPush]', e.message);
  }
}

/**
 * Récupère les consentements des autres appareils et merge dans l'IDB locale.
 * Dédup par (patient_id, type, version) — la version la plus haute gagne.
 *
 * ⚡ FIX résurrection : avant de réimporter, on récupère ET applique les tombstones
 *    (locaux + serveur). Tout consentement remote dont le payload_hash est marqué
 *    comme supprimé est IGNORÉ (et même supprimé localement s'il a survécu).
 *
 * Retourne { pulled: N, applied_tombstones: M }.
 */
async function consentSyncPull() {
  const uid = APP?.user?.id;
  if (!uid) return { pulled: 0 };

  // ── ÉTAPE 1 : Tombstones — pull serveur + apply local ──────────
  // Doit s'exécuter AVANT le pull des consentements pour que les hash
  // supprimés soient bien dans le set de filtrage.
  let appliedTombstones = 0;
  try {
    const r = await _consentTombstonePull();
    appliedTombstones = r?.applied || 0;
  } catch (e) { console.warn('[consentSyncPull] tombstone pull KO:', e.message); }

  // Set des hash supprimés (local IDB + serveur fraîchement pull)
  const tombSet = await _consentTombstoneGetSet();

  try {
    // ✅ v8.7 — Tente boot-sync d'abord
    let resp = null;
    if (typeof window.bootSyncGet === 'function') {
      try { resp = await window.bootSyncGet('consentements'); } catch {}
    }
    if (!resp) {
      resp = await _consentWpost('/webhook/consentements-pull', {});
    }
    if (!resp?.data?.encrypted_data) return { pulled: 0, applied_tombstones: appliedTombstones };

    // Format AES-GCM de l'ancien code (incompatible) → forcer un push d'écrasement
    try {
      const parsed = JSON.parse(resp.data.encrypted_data);
      if (parsed?.iv !== undefined) {
        console.warn('[consentSyncPull] Format AES-GCM obsolète — push forcé pour corriger.');
        consentSyncPush().catch(() => {});
        return { pulled: 0, applied_tombstones: appliedTombstones };
      }
    } catch (_) { /* format btoa correct, continuer */ }

    const remote = _consentDec(resp.data.encrypted_data);
    if (!Array.isArray(remote) || !remote.length) {
      // Payload illisible avec la clé actuelle → probablement corruption ou user différent
      console.warn('[consentSyncPull] Déchiffrement échoué — push forcé pour réécrire.');
      consentSyncPush().catch(() => {});
      return { pulled: 0, applied_tombstones: appliedTombstones };
    }

    // Index des consentements locaux par clé (patient_id, type, version)
    const existing = await _consentGetAllRaw();
    const byKey = new Map();
    for (const c of existing) {
      const k = `${c.patient_id}|${c.type}|${c.version || 1}`;
      byKey.set(k, c);
    }

    let pulled = 0;
    let blocked = 0;
    for (const r of remote) {
      if (!r?.patient_id || !r?.type) continue;

      // ⚡ FIX résurrection : si ce consentement a été supprimé sur un autre appareil,
      // on l'ignore. Sans ce filtre, il serait réinjecté ad vitam aeternam.
      if (r.payload_hash && tombSet.has(r.payload_hash)) {
        blocked++;
        continue;
      }

      const k = `${r.patient_id}|${r.type}|${r.version || 1}`;
      const local = byKey.get(k);

      // Existe déjà avec le même (id, version) → skip
      if (local) continue;

      // Import — on ne récupère PAS l'id IDB pour laisser autoIncrement en local
      const { id: _drop, ...clean } = r;
      await _consentPut({
        ...clean,
        _synced_from_user: true,
        _synced_at: new Date().toISOString(),
      });
      byKey.set(k, clean);
      pulled++;
    }

    if (pulled > 0)  console.info(`[consentSyncPull] ${pulled} consentement(s) importé(s) d'un autre appareil.`);
    if (blocked > 0) console.info(`[consentSyncPull] ${blocked} consentement(s) bloqué(s) par tombstone.`);
    if (appliedTombstones > 0) console.info(`[consentSyncPull] ${appliedTombstones} suppression(s) appliquée(s) depuis tombstones distants.`);
    return { pulled, blocked, applied_tombstones: appliedTombstones };
  } catch (e) {
    console.warn('[consentSyncPull]', e.message);
    return { pulled: 0, error: e.message };
  }
}

/* Au login : push (écrase les lignes corrompues), puis pull immédiat */
document.addEventListener('ami:login', () => {
  consentSyncPush().catch(() => {}).finally(() => {
    consentSyncPull().catch(() => {});
  });
});

/* Expose pour debug / usages externes */
window.consentSyncPush = consentSyncPush;
window.consentSyncPull = consentSyncPull;

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
  // Pull user-level : récupère les consentements signés sur les autres appareils
  // du même utilisateur (téléphone ↔ tablette ↔ desktop). Silencieux, non bloquant.
  consentSyncPull().then(r => {
    if (r?.pulled > 0 && typeof showToast === 'function') {
      // Re-render au prochain tick pour afficher les consentements pullés
      setTimeout(() => { try { renderConsentements(); } catch(_){} }, 150);
    }
  }).catch(() => {});

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
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <h3 style="font-size:14px;margin:0">Historique consentements <em>(toutes IDE cabinet)</em></h3>
        <button id="consent-delete-all-btn" class="btn bs bsm" onclick="consentDeleteAllForPatient()" title="Suppression définitive de TOUS les consentements de ce patient (toutes versions)" style="color:#ef4444;display:none">🗑️ Tout supprimer</button>
      </div>
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

/* ════════════════════════════════════════════════
   EXPORT PNG — Conversion noir-sur-blanc pour PDF
   ────────────────────────────────────────────────
   Le canvas du formulaire de consentement dessine en vert AMI
   (#00d4aa) sur fond transparent. Ce trait clair est presque
   invisible une fois incrusté dans un PDF blanc (consentement
   imprimé, archive papier, dossier patient).

   Cette fonction redessine le canvas dans un buffer temporaire :
     - fond BLANC opaque (apparaîtra dans le PNG)
     - pixels du tracé → NOIR foncé (#1a1a20, légère teinte bleu nuit)
   Le PNG résultant reste lisible une fois imprimé ou affiché sur
   n'importe quel fond clair.

   Le hash SHA-256 (calculé après cette transformation) reste
   cohérent — toute modification ultérieure invalide le hash, donc
   la valeur de preuve médico-légale est conservée.
════════════════════════════════════════════════ */
function _exportConsentSignaturePNG(canvas) {
  if (!canvas) return '';
  try {
    const w = canvas.width, h = canvas.height;
    const srcCtx = canvas.getContext('2d');
    const src    = srcCtx.getImageData(0, 0, w, h);
    const sd     = src.data;
    // ⚡ SEUILLAGE alpha (≥ 16) → noir OPAQUE (alpha 255).
    //    Avant : on conservait l'alpha source ⇒ pixels de bord d'antialias
    //    avaient alpha 8/16 ⇒ noir presque transparent ⇒ trait délavé sur
    //    fond blanc dans le PDF.
    //    Maintenant : tout pixel ayant ne serait-ce qu'un peu de couleur
    //    devient noir plein ⇒ trait dense et lisible.
    const ALPHA_THRESHOLD = 16;
    const out = new ImageData(w, h);
    const od  = out.data;
    for (let i = 0; i < sd.length; i += 4) {
      const a = sd[i + 3];
      if (a >= ALPHA_THRESHOLD) {
        // Pixel dessiné → noir bleu nuit OPAQUE
        od[i]     = 26;   // #1a — R
        od[i + 1] = 26;   // #1a — G
        od[i + 2] = 32;   // #20 — B (légère teinte bleu nuit, plus élégant que pur noir)
        od[i + 3] = 255;  // ⚡ alpha PLEIN — clé pour visibilité PDF
      } else {
        // Pixel vide → blanc opaque (fond papier)
        od[i]     = 255;
        od[i + 1] = 255;
        od[i + 2] = 255;
        od[i + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width  = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(0, 0, w, h);
    tctx.putImageData(out, 0, 0);
    return tmp.toDataURL('image/png');
  } catch (e) {
    // Fallback : si la transformation échoue (ex: tainted canvas), on retombe
    // sur l'export brut — la signature sera pâle sur PDF mais au moins enregistrée.
    console.warn('[Consent] _exportConsentSignaturePNG fallback :', e.message);
    return canvas.toDataURL();
  }
}

function _initConsentCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#00d4aa';
  ctx.lineWidth = 3.2;          // ⚡ 2 → 3.2 : trait plus épais ⇒ meilleure densité PDF
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';       // ⚡ ajout : évite les angles cassants entre segments

  const getPos = e => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - rect.left) * scaleX, y: (src.clientY - rect.top) * scaleY };
  };

  canvas.addEventListener('mousedown',  e => { _consentDrawing = true; _consentLastPos = getPos(e); });
  canvas.addEventListener('mousemove',  e => { if (!_consentDrawing) return; const p=getPos(e); ctx.beginPath(); ctx.moveTo(_consentLastPos.x, _consentLastPos.y); ctx.lineTo(p.x,p.y); ctx.stroke(); _consentLastPos=p; });
  canvas.addEventListener('mouseup',    () => { _consentDrawing = false; _consentSignature = _exportConsentSignaturePNG(canvas); });
  canvas.addEventListener('touchstart', e => { e.preventDefault(); _consentDrawing=true; _consentLastPos=getPos(e); }, { passive:false });
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if(!_consentDrawing)return; const p=getPos(e); ctx.beginPath(); ctx.moveTo(_consentLastPos.x,_consentLastPos.y); ctx.lineTo(p.x,p.y); ctx.stroke(); _consentLastPos=p; }, { passive:false });
  canvas.addEventListener('touchend',   () => { _consentDrawing=false; _consentSignature=_exportConsentSignaturePNG(canvas); });
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

async function consentLoadHistory() {
  if (!_consentCurrentPatient) return;
  const list = document.getElementById('consent-history-list');
  if (!list) return;
  const delAllBtn = document.getElementById('consent-delete-all-btn');
  try {
    const all = await _consentGetAll(_consentCurrentPatient);
    if (!all.length) {
      list.innerHTML = '<div class="empty"><p>Aucun consentement archivé.</p></div>';
      if (delAllBtn) delAllBtn.style.display = 'none';
      return;
    }
    if (delAllBtn) delAllBtn.style.display = '';

    // Résolution parallèle des signatures (consent local → ami_signatures via invoice_id)
    // ⚡ Puis normalisation parallèle pour gérer les anciens PNG legacy (clair-sur-transparent)
    //    qui sinon apparaissent presque invisibles sur la vignette à fond blanc.
    const sigsRaw = await Promise.all(all.map(c => _consentResolveSignature(c).catch(() => null)));
    const _normFn = (typeof window.normalizeSignaturePNGCached === 'function')
      ? window.normalizeSignaturePNGCached
      : null;
    const sigs = _normFn
      ? await Promise.all(sigsRaw.map(p => p ? _normFn(p).catch(() => p) : Promise.resolve(null)))
      : sigsRaw;
    const sigById = new Map();
    all.forEach((c, i) => sigById.set(c.id, sigs[i]));

    // Grouper par type — l'ordre intra-groupe (date desc) est déjà garanti par _consentGetAll
    const byType = new Map();
    for (const c of all) {
      if (!byType.has(c.type)) byType.set(c.type, []);
      byType.get(c.type).push(c);
    }

    // Rendu d'une entrée individuelle
    const renderEntry = (c) => {
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
      const sigPng = sigById.get(c.id);
      const sigThumb = sigPng ? `
              <div style="margin-top:8px;display:flex;align-items:center;gap:8px">
                <img src="${sigPng}" alt="Signature patient" style="height:60px;max-width:200px;border:1px solid var(--b);border-radius:4px;background:#fff;object-fit:contain;image-rendering:crisp-edges" title="Signature manuscrite du patient">
                <span style="font-size:10px;color:var(--m)">${c.invoice_id ? '🔗 Liée à la facture ' + c.invoice_id : 'Signature locale'}</span>
              </div>` : '';
      return `
        <div style="background:var(--dd);border:1px solid var(--b);border-radius:10px;padding:12px;margin-bottom:8px;border-left:4px solid ${statusColor}">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
            <div>
              <div style="font-size:13px;font-weight:600">${tpl.icon||'📋'} ${c.type_label} <span style="font-size:11px;color:var(--m)">v${c.version||1}</span></div>
              <div style="font-size:11px;color:var(--m);margin-top:2px">${d} · ${c.patient_nom||'—'}${byWho}</div>
              ${c.signature_hash ? `<div style="font-size:10px;color:var(--m);margin-top:3px;font-family:monospace" title="Hash d'intégrité">🔒 ${c.signature_hash.slice(0,16)}…</div>` : ''}
            </div>
            <div style="font-size:11px;color:${statusColor};font-weight:600">${statusIcon} ${c.status}${expired && c.status==='signed'?' (expiré)':''}</div>
          </div>
          ${sigThumb}
          <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
            <button class="btn bs bsm" onclick="consentEditEntry(${c.id})" title="Re-signer une nouvelle version (l'actuelle sera archivée automatiquement)">✏️ Modifier</button>
            <button class="btn bs bsm" onclick="consentPrintEntry(${c.id})" title="Imprimer ou exporter en PDF">🖨️ PDF</button>
            <button class="btn bs bsm" onclick="consentDeleteEntry(${c.id})" title="Suppression définitive (avec confirmation et trace audit)" style="color:#ef4444">🧹 Effacer</button>
          </div>
        </div>`;
    };

    // Ordre canonique des types selon CONSENT_TEMPLATES, on ne montre que ceux ayant des entrées
    const typeOrder = Object.keys(CONSENT_TEMPLATES).filter(t => byType.has(t));
    // Types legacy/inconnus (pas dans CONSENT_TEMPLATES) → ajoutés en fin de liste
    for (const t of byType.keys()) {
      if (!typeOrder.includes(t)) typeOrder.push(t);
    }

    // Une <details> par type, repliée par défaut (pas d'attribut "open")
    list.innerHTML = typeOrder.map(type => {
      const group = byType.get(type);
      const tpl = CONSENT_TEMPLATES[type] || {};
      const label = tpl.label || group[0]?.type_label || type;
      const icon  = tpl.icon || '📋';

      // Synthèse pour le summary : version active + nb archivés
      const active = group.find(c => c.status !== 'archived');
      const expired = active ? _consentIsExpired(active) : false;
      const archivedCount = group.filter(c => c.status === 'archived').length;
      const statusIcon = !active ? '📜'
                       : active.status === 'pending' ? '⏳'
                       : expired ? '❌'
                       : '✅';
      const statusColor = !active ? 'var(--m)'
                        : active.status === 'pending' ? '#f59e0b'
                        : expired ? '#ef4444'
                        : '#00d4aa';
      const summaryRight = active
        ? `${statusIcon} v${active.version||1}${expired && active.status==='signed' ? ' (expiré)' : ''}${archivedCount ? ` · +${archivedCount} archive${archivedCount>1?'s':''}` : ''}`
        : `${statusIcon} ${archivedCount} archive${archivedCount>1?'s':''}`;

      return `
        <details style="background:var(--s);border:1px solid var(--b);border-left:4px solid ${statusColor};border-radius:10px;margin-bottom:8px;overflow:hidden">
          <summary style="cursor:pointer;padding:12px;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;user-select:none">
            <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:160px">
              <span class="cdetails-arrow" style="font-size:10px;color:var(--m);transition:transform .15s;display:inline-block">▶</span>
              <span style="font-size:18px">${icon}</span>
              <div>
                <div style="font-size:13px;font-weight:600">${label}</div>
                <div style="font-size:11px;color:var(--m);margin-top:2px">${group.length} entrée${group.length>1?'s':''}</div>
              </div>
            </div>
            <div style="font-size:11px;color:${statusColor};font-weight:600">${summaryRight}</div>
          </summary>
          <div style="padding:0 12px 12px 12px">
            ${group.map(renderEntry).join('')}
          </div>
        </details>`;
    }).join('');

    // CSS pour la flèche pivotante + masquer le marqueur natif (injecté une seule fois)
    if (!document.getElementById('cdetails-style')) {
      const style = document.createElement('style');
      style.id = 'cdetails-style';
      style.textContent = `
        details[open] > summary .cdetails-arrow { transform: rotate(90deg); }
        details > summary::-webkit-details-marker { display: none; }
        details > summary::marker { content: ''; }
      `;
      document.head.appendChild(style);
    }
  } catch (err) {
    list.innerHTML = `<div class="msg e">Erreur : ${err.message}</div>`;
  }
}

/* ════════════════════════════════════════════════
   ACTIONS SUR ENTRÉE D'HISTORIQUE — Modifier / PDF / Effacer
════════════════════════════════════════════════ */

/**
 * Recharge un consentement existant dans le formulaire pour une nouvelle signature.
 *
 * Médico-légal : à l'archivage suivant, une NOUVELLE version sera créée et
 * la version actuelle sera marquée 'archived' (versionning automatique).
 * On ne mute jamais une signature existante — on en crée une nouvelle.
 */
async function consentEditEntry(id) {
  try {
    const c = await _consentGetById(Number(id));
    if (!c) {
      if (typeof showToast === 'function') showToast('warning', 'Consentement introuvable');
      return;
    }

    // 1) Sélectionner le patient (ouvre la section type + historique)
    const sel = document.getElementById('consent-patient-sel');
    if (sel && c.patient_id) {
      sel.value = c.patient_id;
      consentSelectPatient(c.patient_id);
    }

    // 2) Sélectionner le type (affiche le formulaire)
    consentSelectType(c.type);

    // 3) Pré-remplir les champs après que la section soit visible
    setTimeout(() => {
      const nomEl  = document.getElementById('consent-patient-nom');
      const qualEl = document.getElementById('consent-qualite');
      const dateEl = document.getElementById('consent-date');
      if (nomEl)  nomEl.value  = c.patient_nom || nomEl.value || '';
      if (qualEl) qualEl.value = c.qualite     || '';
      if (dateEl) dateEl.value = c.date        || new Date().toISOString().slice(0, 10);

      // Scroll doux vers le formulaire
      const formSec = document.getElementById('consent-form-section');
      if (formSec) formSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 200);

    if (typeof showToast === 'function')
      showToast('info', `Modification v${c.version || 1}`,
                'Re-signez pour archiver une nouvelle version. L\'actuelle sera conservée comme archive.');
  } catch (err) {
    if (typeof showToast === 'function') showToast('error', 'Erreur', err.message);
  }
}

/**
 * Génère un PDF d'un consentement déjà archivé (depuis ses données IDB).
 *
 * Affiche la signature manuscrite si disponible :
 *   1. en priorité depuis le consentement (signatureDataUrl, en local seulement)
 *   2. en fallback depuis ami_signatures via invoice_id (signature canonique de l'acte)
 *
 * Le hash SHA-256 reste imprimé comme preuve d'intégrité médico-légale,
 * que la signature visuelle soit présente ou non.
 */
async function consentPrintEntry(id) {
  try {
    const c = await _consentGetById(Number(id));
    if (!c) {
      if (typeof showToast === 'function') showToast('warning', 'Consentement introuvable');
      return;
    }
    const tpl = CONSENT_TEMPLATES[c.type] || {};
    const dSign = c.signed_at  ? new Date(c.signed_at).toLocaleString('fr-FR')   : '—';
    const dExp  = c.expires_at ? new Date(c.expires_at).toLocaleDateString('fr-FR') : '—';
    const expired = _consentIsExpired(c);
    const statusLbl = c.status === 'archived' ? '📜 Archivé'
                    : c.status === 'pending'  ? '⏳ En attente de signature'
                    : expired                 ? '❌ Signé mais expiré'
                    : '✅ Signé et valide';

    // ⚡ Récupération de la signature visuelle (PNG)
    //    Chaîne de fallback : consentement local → ami_signatures via invoice_id
    let signaturePng = await _consentResolveSignature(c);
    // ⚡ Normalisation des PNG legacy (clair-sur-transparent) → noir-sur-blanc
    //    Indispensable pour les anciens consentements signés AVANT le seuillage
    //    alpha. Sans ce traitement, la signature est presque invisible dans le PDF.
    if (signaturePng) {
      try {
        const norm = (typeof window.normalizeSignaturePNGCached === 'function')
          ? await window.normalizeSignaturePNGCached(signaturePng)
          : signaturePng;
        if (norm) signaturePng = norm;
      } catch (_) { /* on garde le PNG original si la normalisation échoue */ }
    }

    const w = window.open('', '_blank');
    if (!w) {
      if (typeof showToast === 'function') showToast('warning', 'Pop-up bloqué', 'Autorisez les fenêtres pop-up pour imprimer.');
      return;
    }
    w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Consentement AMI v${c.version||1}</title>
      <style>
        body{font-family:Arial,sans-serif;padding:30px;color:#000;max-width:680px;margin:0 auto}
        h1{font-size:16px;margin-bottom:10px}
        h2{font-size:13px;margin-top:18px;margin-bottom:6px;border-bottom:1px solid #ccc;padding-bottom:3px}
        p{font-size:13px;line-height:1.7;margin:6px 0}
        ul{font-size:12px;margin:6px 0;padding-left:22px}
        .meta{background:#f6f8fa;border:1px solid #e5e7eb;border-radius:6px;padding:10px;font-size:11px;margin-bottom:12px}
        .meta div{margin:3px 0}
        .hash{font-family:monospace;font-size:10px;word-break:break-all;color:#444;background:#f0f0f0;padding:6px;border-radius:4px;margin-top:4px}
        .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#e6f7f1;color:#00644a}
        .sigbox{border:1px solid #ccd5e0;border-radius:6px;padding:10px;background:#fff;text-align:center;margin-top:6px}
        .sigbox img{max-width:340px;max-height:150px;display:block;margin:0 auto;background:#fff;image-rendering:crisp-edges}
        .sigbox .cap{font-size:10px;color:#777;margin-top:6px;text-align:center}
        @media print{@page{margin:15mm}}
      </style>
      </head><body>
      <h1>${tpl.icon||'📋'} Consentement éclairé — ${c.type_label || tpl.label || c.type}</h1>
      <div class="meta">
        <div><strong>Patient :</strong> ${c.patient_nom || '—'} · <strong>Qualité :</strong> ${c.qualite || '—'}</div>
        <div><strong>Version :</strong> v${c.version || 1} · <strong>Statut :</strong> <span class="badge">${statusLbl}</span></div>
        <div><strong>Date acte :</strong> ${c.date || '—'} · <strong>Signé le :</strong> ${dSign}</div>
        <div><strong>Expire le :</strong> ${dExp} · <strong>Validité :</strong> ${c.validity_days || 365} j</div>
        <div><strong>Infirmier(ère) créateur :</strong> ${c.created_by_nom || '—'}</div>
        ${c.invoice_id ? `<div><strong>N° de facture liée :</strong> ${c.invoice_id}</div>` : ''}
      </div>
      ${tpl.risques ? `<h2>Risques expliqués au patient</h2><ul>${tpl.risques.map(r => `<li>${r}</li>`).join('')}</ul>` : ''}
      ${tpl.alternatives ? `<h2>Alternatives proposées</h2><p>${tpl.alternatives}</p>` : ''}
      <h2>Texte du consentement</h2>
      <p>${c.texte || tpl.texte || '—'}</p>

      ${signaturePng ? `
      <h2>Signature manuscrite du patient</h2>
      <div class="sigbox">
        <img src="${signaturePng}" alt="Signature du patient">
        <div class="cap">Signée le ${dSign}${c.invoice_id ? ' · Facture ' + c.invoice_id : ''}</div>
      </div>` : ''}

      <h2>Preuve d'intégrité — Hash de signature</h2>
      <p style="font-size:11px;color:#555">${signaturePng
        ? `La signature manuscrite ci-dessus est conservée chiffrée sur l'appareil de l'infirmier(ère). Le hash SHA-256 ci-dessous garantit son intégrité et sa non-modification :`
        : `La signature manuscrite n'est pas disponible visuellement sur cet appareil. Le hash SHA-256 ci-dessous reste la preuve d'intégrité opposable :`}</p>
      <div class="hash">🔒 ${c.signature_hash || '—'}</div>
      ${c.payload_hash ? `<h2>Hash global du payload</h2><div class="hash">🔐 ${c.payload_hash}</div>` : ''}
      <p style="font-size:10px;color:#888;margin-top:24px">Document généré par AMI · ${new Date().toLocaleString('fr-FR')} · À conserver dans le dossier patient.</p>
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
  } catch (err) {
    if (typeof showToast === 'function') showToast('error', 'Erreur', err.message);
  }
}

/**
 * Suppression DÉFINITIVE d'une entrée de l'IDB locale.
 *
 * ⚠️ Acte médico-légal sensible :
 *   • Double confirmation utilisateur (window.confirm)
 *   • Audit log obligatoire (CONSENT_DELETED) — la trace reste même après suppression
 *   • Push de l'état local (snapshot) vers le backend pour propagation
 *
 * Note : la suppression locale n'écrase pas les autres appareils via pull
 * (consentSyncPull n'effectue que des inserts). Cela protège les sauvegardes
 * cabinet/multi-device — la suppression doit être faite explicitement
 * sur chaque appareil si souhaité.
 */
async function consentDeleteEntry(id) {
  try {
    const c = await _consentGetById(Number(id));
    if (!c) {
      if (typeof showToast === 'function') showToast('warning', 'Consentement introuvable');
      return;
    }
    const lbl = `${c.type_label || c.type} v${c.version || 1} · ${c.patient_nom || ''}`.trim();
    const ok = window.confirm(
      `⚠️ Suppression DÉFINITIVE du consentement\n\n` +
      `${lbl}\n\n` +
      `Cette action est irréversible.\n` +
      `Elle sera tracée dans le journal d'audit (CONSENT_DELETED).\n\n` +
      `Confirmer la suppression ?`
    );
    if (!ok) return;

    await _consentDelete(c.id);

    // Tombstone : empêche la résurrection via consentSyncPull d'un autre appareil
    if (c.payload_hash) {
      try {
        await _consentTombstoneAdd({
          payload_hash:    c.payload_hash,
          patient_id:      c.patient_id,
          consent_type:    c.type,
          consent_version: c.version || 1,
        });
      } catch (e) { console.warn('[consentDeleteEntry] tombstone add KO:', e.message); }
    }

    // Audit log — best-effort, non bloquant
    try {
      if (typeof auditLog === 'function') {
        auditLog('CONSENT_DELETED', {
          consent_id:   c.id,
          patient_id:   c.patient_id,
          type:         c.type,
          version:      c.version || 1,
          status:       c.status,
          payload_hash: c.payload_hash || null,
        });
      }
    } catch (_) {}

    // Synchronisation cross-device :
    //   1. push tombstone (informe le serveur des hash supprimés)
    //   2. push état local actualisé (blob sans le consentement)
    _consentTombstonePush().catch(() => {});
    consentSyncPush().catch(() => {});

    if (typeof showToast === 'function')
      showToast('success', 'Consentement supprimé', lbl);

    await consentLoadHistory();
    await renderConsentements();
  } catch (err) {
    if (typeof showToast === 'function') showToast('error', 'Erreur', err.message);
  }
}

/**
 * Suppression DÉFINITIVE de TOUS les consentements d'un patient.
 *
 * ⚠️ Acte médico-légal extrêmement sensible :
 *   • Double confirmation utilisateur (window.confirm + saisie texte)
 *   • Audit log obligatoire avec liste des id supprimés
 *   • Sync push après suppression pour propager l'état local
 *
 * @param {string} [patientId] - id du patient (optionnel : utilise _consentCurrentPatient si absent)
 */
async function consentDeleteAllForPatient(patientId) {
  try {
    const pid = patientId || _consentCurrentPatient;
    if (!pid) {
      if (typeof showToast === 'function') showToast('warning', 'Aucun patient sélectionné');
      return;
    }
    const all = await _consentGetAll(pid);
    if (!all.length) {
      if (typeof showToast === 'function') showToast('info', 'Aucun consentement à supprimer');
      return;
    }

    // Résumé des entrées à supprimer (groupées par type)
    const byType = new Map();
    for (const c of all) {
      const tplLbl = (CONSENT_TEMPLATES[c.type]?.label) || c.type_label || c.type;
      byType.set(tplLbl, (byType.get(tplLbl) || 0) + 1);
    }
    const summary = Array.from(byType.entries())
      .map(([k, v]) => `  • ${k} (${v})`)
      .join('\n');

    const patientNom = all[0]?.patient_nom || 'ce patient';

    // ── 1ère confirmation ─────────────────────────────────────────
    const ok1 = window.confirm(
      `⚠️ SUPPRESSION DE TOUS LES CONSENTEMENTS\n\n` +
      `Patient : ${patientNom}\n` +
      `Total : ${all.length} consentement${all.length>1?'s':''} (toutes versions, actives + archivées)\n\n` +
      `Détail :\n${summary}\n\n` +
      `Cette action est IRRÉVERSIBLE.\n` +
      `Elle sera tracée dans le journal d'audit (CONSENT_DELETED_ALL).\n\n` +
      `Continuer ?`
    );
    if (!ok1) return;

    // ── 2ème confirmation : saisie texte (anti-clic accidentel) ────
    const confirmText = window.prompt(
      `⚠️ DERNIÈRE CONFIRMATION\n\n` +
      `Pour valider la suppression définitive de ${all.length} consentement${all.length>1?'s':''}, ` +
      `tapez exactement :\n\nSUPPRIMER\n\n(en majuscules, sans espace)`
    );
    if (confirmText !== 'SUPPRIMER') {
      if (typeof showToast === 'function') showToast('info', 'Suppression annulée');
      return;
    }

    // ── Suppression effective ─────────────────────────────────────
    const deletedIds = [];
    const deletedDetails = [];
    const tombstonesToAdd = [];
    for (const c of all) {
      try {
        await _consentDelete(c.id);
        deletedIds.push(c.id);
        deletedDetails.push({ id: c.id, type: c.type, version: c.version || 1, status: c.status });
        // Préparer le tombstone (on le persiste après la boucle pour limiter les transactions)
        if (c.payload_hash) {
          tombstonesToAdd.push({
            payload_hash:    c.payload_hash,
            patient_id:      c.patient_id,
            consent_type:    c.type,
            consent_version: c.version || 1,
          });
        }
      } catch (e) {
        console.warn('[consent delete all]', c.id, e.message);
      }
    }

    // ── Tombstones : empêche la résurrection cross-device ─────────
    for (const t of tombstonesToAdd) {
      try { await _consentTombstoneAdd(t); }
      catch (e) { console.warn('[consent delete all] tombstone KO:', e.message); }
    }

    // ── Audit log : trace exhaustive (best-effort, non bloquant) ──
    try {
      if (typeof auditLog === 'function') {
        auditLog('CONSENT_DELETED_ALL', {
          patient_id:     pid,
          patient_nom:    patientNom,
          deleted_count:  deletedIds.length,
          deleted_ids:    deletedIds,
          deleted_detail: deletedDetails,
        });
      }
    } catch (_) {}

    // ── Synchronisation cross-device ──────────────────────────────
    //   1. push tombstones (informe le serveur des hash supprimés)
    //   2. push état local actualisé (blob sans les consentements)
    _consentTombstonePush().catch(() => {});
    consentSyncPush().catch(() => {});

    if (typeof showToast === 'function')
      showToast('success', 'Consentements supprimés', `${deletedIds.length} entrée${deletedIds.length>1?'s':''} effacée${deletedIds.length>1?'s':''}`);

    await consentLoadHistory();
    await renderConsentements();
  } catch (err) {
    if (typeof showToast === 'function') showToast('error', 'Erreur', err.message);
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
// ⚡ Exposés pour le chaînage depuis signature.js (création auto de
// consentement à la signature patient d'une cotation + refresh UI après).
window._consentCreateOrUpdate = _consentCreateOrUpdate;
window.renderConsentements    = renderConsentements;
window.consentSelectPatient   = consentSelectPatient;
// Actions par entrée d'historique
window.consentEditEntry       = consentEditEntry;
window.consentPrintEntry      = consentPrintEntry;
window.consentDeleteEntry     = consentDeleteEntry;
window.consentDeleteAllForPatient = consentDeleteAllForPatient;

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'consentements') renderConsentements();
});
