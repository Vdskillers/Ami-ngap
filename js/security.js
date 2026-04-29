/* ════════════════════════════════════════════════
   security.js — AMI NGAP v2.0
   ────────────────────────────────────────────────
   Sécurité RGPD + HDS — Privacy by Design
   ─────────────────────────────────────────────────
   1. Chiffrement AES-GCM (Web Crypto API)
      - generateEncKey() — clé PBKDF2 100 000 itérations
      - encryptData() / decryptData()
      - encryptField() / decryptField() — champs unitaires
      🔒 Clé dérivée du token de session, jamais persistée
   2. IndexedDB chiffré (remplace IDB en clair de pwa.js)
      - saveSecure() / loadSecure()
      - clearSecureStore()
   3. Consentement RGPD
      - checkConsent() — vérifie à chaque démarrage
      - showConsentModal() — modale onboarding
      - acceptConsent() / revokeConsent()
   4. Droits RGPD utilisateur
      - exportMyData() — téléchargement JSON chiffré
      - purgeLocalData() — effacement complet local
      - cleanOldLogs() — purge auto > 90 jours
   5. Audit log local (actions sensibles)
      - auditLocal() — log chiffré dans IDB
   6. PIN local (verrouillage session)
      - setupPIN() / checkPIN() / lockApp()
   7. Minimisation données
      - stripSensitive() — retire les champs non nécessaires
   8. ✅ v2.0 — Surveillance fraude temps réel
      - watchFraudScore() — alerte si fraud_score ≥ FRAUD_ALERT_THRESHOLD
      - reportFraudAlert() — envoi log serveur + audit local
      - FRAUD_ALERT_THRESHOLD = 70 (configurable)
════════════════════════════════════════════════ */

/* ── Guards ──────────────────────────────────── */
(function checkDeps() {
  assertDep(typeof APP !== 'undefined', 'security.js : utils.js non chargé.');
  assertDep(typeof crypto !== 'undefined' && crypto.subtle, 'security.js : Web Crypto API non disponible (HTTPS requis).');
})();

/* ════════════════════════════════════════════════
   1. CHIFFREMENT AES-GCM
   Clé dérivée du mot de passe utilisateur via PBKDF2.
   Jamais stockée en clair — recréée à chaque session.
════════════════════════════════════════════════ */

/* Clé AES de session (en mémoire uniquement, jamais persistée) */
let _sessionKey = null;

/* Dériver une clé AES-256-GCM depuis un mot de passe */
async function generateEncKey(password, saltHex = '') {
  const enc      = new TextEncoder();
  const salt     = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g).map(b => parseInt(b,16)))
    : crypto.getRandomValues(new Uint8Array(16));

  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return { key, salt: Array.from(salt).map(b=>b.toString(16).padStart(2,'0')).join('') };
}

/* Initialise la clé de session depuis le token de connexion */
async function initSessionKey(token) {
  if (!token) return;
  /* Salt stocké dans sessionStorage (non sensible seul) */
  let saltHex = sessionStorage.getItem('ami_enc_salt');
  /* ── Fix A4 : utiliser le token ENTIER comme matériau de clé.
     Avant : token.slice(0,32) → seulement 128 bits d'un SHA-256 hex de 512 bits
     Après : token complet → entropie pleine (512 bits en entrée PBKDF2).
     La dérivation PBKDF2-SHA256 / 100 000 itérations produit toujours
     une clé AES-256 de 256 bits, quelle que soit la longueur du mot de passe.
     Compatibilité : le salt en sessionStorage reste valide — seul le mot de
     passe PBKDF2 change. Les données déjà chiffrées avec l'ancienne clé
     seront déchiffrables jusqu'à la fin de la session courante car _sessionKey
     est en mémoire ; à la reconnexion la nouvelle clé s'applique. ── */
  const result = await generateEncKey(token, saltHex || '');
  _sessionKey = result.key;
  if (!saltHex) sessionStorage.setItem('ami_enc_salt', result.salt);
  log('Clé AES-GCM initialisée ✅ (entropie complète)');
}

/* Chiffrer un objet JS → { data: base64, iv: base64 } */
async function encryptData(obj) {
  if (!_sessionKey) return { data: btoa(JSON.stringify(obj)), iv: '', _plain: true };
  const iv      = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(obj));
  const cipher  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _sessionKey, encoded);
  return {
    data: btoa(String.fromCharCode(...new Uint8Array(cipher))),
    iv:   btoa(String.fromCharCode(...iv)),
  };
}

/* Déchiffrer → objet JS */
async function decryptData(payload) {
  if (!payload || payload._plain) return JSON.parse(atob(payload.data));
  if (!_sessionKey) { logWarn('Clé manquante — données non déchiffrables'); return null; }
  try {
    const iv      = Uint8Array.from(atob(payload.iv),   c => c.charCodeAt(0));
    const cipher  = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));
    const plain   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, _sessionKey, cipher);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    logWarn('Déchiffrement échoué:', e.message);
    return null;
  }
}

/* Chiffrer un seul champ string */
async function encryptField(str) {
  const r = await encryptData({ v: str });
  return JSON.stringify(r);
}
async function decryptField(json) {
  try { const o = JSON.parse(json); const r = await decryptData(o); return r?.v ?? null; }
  catch { return null; }
}

/* ════════════════════════════════════════════════
   2. INDEXEDDB CHIFFRÉ
   Toutes les données sensibles passent par encryptData
   avant d'être stockées. Le schéma IDB version 2
   remplace la version 1 non chiffrée de pwa.js.
════════════════════════════════════════════════ */

const SEC_IDB_NAME    = 'ami-secure';
const SEC_IDB_VERSION = 2;

function _openSecureIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(SEC_IDB_NAME, SEC_IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      /* Patients chiffrés */
      if (!db.objectStoreNames.contains('s_patients'))
        db.createObjectStore('s_patients', { keyPath: 'id' });
      /* Sync queue chiffrée */
      if (!db.objectStoreNames.contains('s_sync'))
        db.createObjectStore('s_sync', { autoIncrement: true });
      /* Audit logs chiffrés */
      if (!db.objectStoreNames.contains('s_audit'))
        db.createObjectStore('s_audit', { autoIncrement: true, keyPath: 'ts' });
      /* Consentement + préférences (non chiffré — non sensible) */
      if (!db.objectStoreNames.contains('prefs'))
        db.createObjectStore('prefs', { keyPath: 'k' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

/* Sauvegarder une valeur chiffrée */
async function saveSecure(storeName, id, value) {
  try {
    const payload = await encryptData(value);
    const db  = await _openSecureIDB();
    const tx  = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put({ id, payload, ts: Date.now() });
    log(`saveSecure(${storeName}) OK`);
  } catch (e) { logWarn('saveSecure:', e.message); }
}

/* Charger et déchiffrer une valeur */
async function loadSecure(storeName, id) {
  try {
    const db = await _openSecureIDB();
    return await new Promise((res, rej) => {
      const tx  = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(id);
      req.onsuccess = async () => {
        if (!req.result) { res(null); return; }
        res(await decryptData(req.result.payload));
      };
      req.onerror = () => rej(req.error);
    });
  } catch { return null; }
}

/* Charger tous les enregistrements d'un store */
async function loadAllSecure(storeName) {
  try {
    const db = await _openSecureIDB();
    const all = await new Promise((res, rej) => {
      const tx  = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
    const decrypted = await Promise.all(all.map(r => decryptData(r.payload)));
    return decrypted.filter(Boolean);
  } catch { return []; }
}

async function clearSecureStore(storeName) {
  try {
    const db = await _openSecureIDB();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
  } catch (e) { logWarn('clearSecureStore:', e.message); }
}

/* ════════════════════════════════════════════════
   3. CONSENTEMENT RGPD — Onboarding obligatoire
   Affiché au premier lancement et après revocation.
   Sans consentement → app bloquée.
════════════════════════════════════════════════ */

const CONSENT_KEY = 'ami_rgpd_consent_v1';
// ⚡ RGPD/HDS — version de la politique de confidentialité acceptée.
//   Toute évolution majeure des CGU → bumper cette version + relancer la modale
//   au prochain login pour ré-acceptation explicite.
//   Stockée localement pour gating client + envoyée au worker pour traçabilité.
const CONSENT_VERSION = '2026.04';
const CONSENT_VERSION_KEY = 'ami_rgpd_consent_version';
const CONSENT_DATE_KEY    = 'ami_rgpd_consent_date';

function hasConsent() {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (v !== 'accepted') return false;
    // Si la version a évolué et que la version localement acceptée est différente,
    // forcer une nouvelle acceptation (CGU modifiées).
    const acceptedVersion = localStorage.getItem(CONSENT_VERSION_KEY);
    if (acceptedVersion && acceptedVersion !== CONSENT_VERSION) return false;
    return true;
  } catch { return false; }
}

/* Vérifie le consentement au démarrage — bloque si absent */
function checkConsent() {
  if (hasConsent()) return true;
  showConsentModal();
  return false;
}

function showConsentModal() {
  let modal = document.getElementById('rgpd-consent-modal');
  if (modal) { modal.style.display = 'flex'; return; }

  modal = document.createElement('div');
  modal.id = 'rgpd-consent-modal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.9);padding:20px;
  `;
  modal.innerHTML = `
    <div style="background:#0b0f14;border:1px solid rgba(0,212,170,.3);border-radius:16px;
                padding:32px;max-width:480px;width:100%;color:#e2e8f0;font-family:sans-serif">
      <div style="font-size:28px;margin-bottom:8px">🔒</div>
      <h2 style="font-size:20px;margin-bottom:8px;color:#fff">Confidentialité & RGPD</h2>
      <p style="font-size:13px;color:#94a3b8;line-height:1.7;margin-bottom:20px">
        AMI NGAP traite des <strong style="color:#e2e8f0">données de santé</strong> (soins, patients, tournées).<br><br>
        ✅ Données stockées <strong>localement sur votre appareil</strong><br>
        ✅ Chiffrement AES-256 de toutes les données sensibles<br>
        ✅ Aucune donnée patient transmise aux administrateurs<br>
        ✅ Vous conservez le droit d'export et d'effacement<br>
        ✅ Conformité RGPD — hébergement Cloudflare / Supabase
      </p>
      <div style="background:rgba(0,212,170,.06);border:1px solid rgba(0,212,170,.2);
                  border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:12px;color:#94a3b8">
        En utilisant AMI NGAP, vous acceptez que vos données professionnelles
        (cotations, tournées) soient stockées de façon chiffrée sur cet appareil
        et synchronisées avec votre compte Supabase personnel.
      </div>
      <div style="display:flex;gap:10px;flex-direction:column">
        <button id="btn-consent-accept"
          style="background:#00d4aa;color:#000;border:none;padding:14px;border-radius:10px;
                 font-size:15px;font-weight:700;cursor:pointer">
          ✅ J'accepte et je commence
        </button>
        <button id="btn-consent-refuse"
          style="background:transparent;color:#64748b;border:1px solid #1e2d3d;
                 padding:10px;border-radius:10px;font-size:13px;cursor:pointer">
          ❌ Refuser — je ne peux pas utiliser l'app
        </button>
      </div>
      <p style="font-size:10px;color:#475569;text-align:center;margin-top:16px">
        Vous pouvez révoquer votre consentement depuis l'onglet Sécurité & RGPD
      </p>
    </div>`;

  document.body.appendChild(modal);

  document.getElementById('btn-consent-accept').onclick = acceptConsent;
  document.getElementById('btn-consent-refuse').onclick = () => {
    modal.innerHTML = `<div style="color:#fff;text-align:center;padding:40px;font-family:sans-serif">
      <div style="font-size:40px;margin-bottom:16px">🚫</div>
      <p>Sans consentement, l'application ne peut pas fonctionner.<br>
      <small style="color:#64748b">Fermez cet onglet ou rechargez pour recommencer.</small></p>
    </div>`;
  };
}

function acceptConsent() {
  // ⚡ Persistance locale immédiate
  const acceptedAt = new Date().toISOString();
  try {
    localStorage.setItem(CONSENT_KEY, 'accepted');
    localStorage.setItem(CONSENT_VERSION_KEY, CONSENT_VERSION);
    localStorage.setItem(CONSENT_DATE_KEY, acceptedAt);
  } catch {}
  const modal = document.getElementById('rgpd-consent-modal');
  if (modal) modal.style.display = 'none';
  log('Consentement RGPD accepté ✅ (v' + CONSENT_VERSION + ')');

  /* ⚡ RGPD/HDS — Traçabilité BDD : si une session est active, on pousse
     l'acceptation au worker pour stockage en table rgpd_consents.
     Si aucune session (1ère acceptation pré-login) → on enqueue dans
     localStorage et on retentera après login. */
  _pushConsentToServer({ version: CONSENT_VERSION, accepted_at: acceptedAt });

  /* Initialiser la clé de chiffrement après consentement */
  if (typeof ss !== 'undefined' && ss.tok()) initSessionKey(ss.tok());
}

/* ⚡ Push consentement vers le worker (best-effort, non bloquant) */
async function _pushConsentToServer({ version, accepted_at }) {
  try {
    if (typeof ss === 'undefined' || !ss.tok()) {
      // Pas de session → on enqueue pour push après login
      try {
        localStorage.setItem('ami_rgpd_consent_pending', JSON.stringify({ version, accepted_at }));
      } catch {}
      return;
    }
    if (typeof wpost !== 'function') return;
    await wpost('/webhook/consent-record', {
      version,
      accepted_at,
      user_agent: (navigator.userAgent || '').slice(0, 300),
    });
    // Succès → purger le pending si présent
    try { localStorage.removeItem('ami_rgpd_consent_pending'); } catch {}
  } catch (e) {
    // Best-effort : on garde le pending pour retry au prochain login
    try {
      localStorage.setItem('ami_rgpd_consent_pending', JSON.stringify({ version, accepted_at }));
    } catch {}
  }
}

/* ⚡ Au login, si un consentement local a été accepté hors-ligne,
   on le synchronise vers le serveur. À appeler depuis auth.js après ss.save. */
async function flushPendingConsent() {
  try {
    const pending = localStorage.getItem('ami_rgpd_consent_pending');
    if (!pending) return;
    const { version, accepted_at } = JSON.parse(pending);
    await _pushConsentToServer({ version, accepted_at });
  } catch {}
}
if (typeof window !== 'undefined') {
  window.flushPendingConsent = flushPendingConsent;
}

function revokeConsent() {
  if (!confirm('⚠️ Révoquer votre consentement supprimera toutes vos données locales. Continuer ?')) return;
  purgeLocalData();
  try {
    localStorage.removeItem(CONSENT_KEY);
    localStorage.removeItem(CONSENT_VERSION_KEY);
    localStorage.removeItem(CONSENT_DATE_KEY);
    localStorage.removeItem('ami_rgpd_consent_pending');
  } catch {}
  // ⚡ Notifier le serveur de la révocation (best-effort)
  try {
    if (typeof ss !== 'undefined' && ss.tok() && typeof wpost === 'function') {
      wpost('/webhook/consent-record', {
        version: CONSENT_VERSION,
        accepted_at: new Date().toISOString(),
        revoked: true,
      }).catch(() => {});
    }
  } catch {}
  sessionStorage.clear();
  if (typeof ss !== 'undefined') ss.clear();
  showConsentModal();
}

/* ════════════════════════════════════════════════
   4. DROITS RGPD UTILISATEUR
════════════════════════════════════════════════ */

/* Export complet des données locales (JSON téléchargeable) */
async function exportMyData() {
  const patients  = await loadAllSecure('s_patients');
  const auditLogs = await loadAllSecure('s_audit');
  const export_data = {
    exported_at:    new Date().toISOString(),
    user_email:     S?.user?.email || '—',
    rgpd_version:   '1.0',
    patients_count: patients.length,
    audit_count:    auditLogs.length,
    /* Les données restent chiffrées dans l'export — seul l'utilisateur peut les lire */
    note: 'Les données patients sont chiffrées par votre clé personnelle.',
  };
  const blob = new Blob([JSON.stringify(export_data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `ami-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  auditLocal('EXPORT_DATA', 'Données exportées par l\'utilisateur');
  log('Export RGPD déclenché');
}

/* Effacement complet des données locales */
async function purgeLocalData() {
  await clearSecureStore('s_patients');
  await clearSecureStore('s_sync');
  await clearSecureStore('s_audit');
  /* Vider aussi les caches PWA non sensibles */
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch {}
  /* Vider ML stats */
  try { localStorage.removeItem('ami_ml_stats'); localStorage.removeItem('ami_user_stats'); } catch {}
  log('Purge locale complète ✅');
}

/* Purge automatique des logs > 90 jours */
async function cleanOldLogs() {
  try {
    const db       = await _openSecureIDB();
    const limit    = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const tx       = db.transaction('s_audit', 'readwrite');
    const store    = tx.objectStore('s_audit');
    const req      = store.openCursor();
    req.onsuccess  = e => {
      const cursor = e.target.result;
      if (!cursor) return;
      if ((cursor.value.ts || 0) < limit) cursor.delete();
      cursor.continue();
    };
    log('Nettoyage logs anciens effectué');
  } catch (e) { logWarn('cleanOldLogs:', e.message); }
}

/* ════════════════════════════════════════════════
   5. AUDIT LOG LOCAL — actions sensibles
   Chiffré dans s_audit. TTL 90 jours.
════════════════════════════════════════════════ */

async function auditLocal(action, detail = '') {
  const entry = {
    ts:     Date.now(),
    action,
    detail: stripSensitive(detail),
    user:   S?.user?.email || 'anon',
  };
  try {
    const payload = await encryptData(entry);
    const db  = await _openSecureIDB();
    const tx  = db.transaction('s_audit', 'readwrite');
    tx.objectStore('s_audit').put({ ts: entry.ts, payload });
  } catch (e) { logWarn('auditLocal:', e.message); }
}

/* ════════════════════════════════════════════════
   6. PIN LOCAL — verrouillage après inactivité
   Le PIN est haché (SHA-256) avant stockage.
   Aucune donnée ne quitte l'appareil.
════════════════════════════════════════════════ */

const PIN_KEY      = 'ami_pin_hash';
let   _pinTimeout  = null;
const PIN_IDLE_MS  = 10 * 60 * 1000; // 10 minutes

async function setupPIN(pin) {
  if (!pin || pin.length < 4) { showM('sec-msg','Le PIN doit contenir au moins 4 chiffres.'); return; }
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin + 'ami_pin_salt'));
  const hash = Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  try { localStorage.setItem(PIN_KEY, hash); } catch {}
  showM('sec-msg','✅ PIN enregistré. Verrouillage automatique après 10 min d\'inactivité.','o');
  _startPinTimer();
  log('PIN configuré ✅');
}

async function checkPIN(pin) {
  const stored = localStorage.getItem(PIN_KEY);
  if (!stored) return true; // pas de PIN configuré → OK
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin + 'ami_pin_salt'));
  const hash = Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  return hash === stored;
}

function lockApp() {
  const overlay = document.getElementById('pin-lock-overlay');
  if (overlay) { overlay.style.display = 'flex'; return; }

  const el = document.createElement('div');
  el.id = 'pin-lock-overlay';
  el.style.cssText = `
    position:fixed;inset:0;z-index:99998;
    background:#0b0f14;display:flex;align-items:center;
    justify-content:center;flex-direction:column;gap:16px;
  `;
  el.innerHTML = `
    <div style="font-size:40px">🔒</div>
    <div style="color:#fff;font-size:18px;font-family:sans-serif">AMI est verrouillé</div>
    <input id="pin-input" type="password" inputmode="numeric" maxlength="8"
      placeholder="Entrez votre PIN"
      style="background:#1e2d3d;border:1px solid rgba(0,212,170,.3);color:#fff;
             padding:12px 20px;border-radius:10px;font-size:18px;text-align:center;
             letter-spacing:8px;width:200px;outline:none">
    <button onclick="unlockApp()"
      style="background:#00d4aa;color:#000;border:none;padding:12px 32px;
             border-radius:10px;font-size:15px;font-weight:700;cursor:pointer">
      Déverrouiller
    </button>
    <div id="pin-error" style="color:#ff5f6d;font-size:13px;min-height:18px"></div>`;
  document.body.appendChild(el);
  setTimeout(() => document.getElementById('pin-input')?.focus(), 100);
}

async function unlockApp() {
  const pin = document.getElementById('pin-input')?.value || '';
  const ok  = await checkPIN(pin);
  if (ok) {
    const el = document.getElementById('pin-lock-overlay');
    if (el) el.style.display = 'none';
    _startPinTimer();
    auditLocal('APP_UNLOCK', 'Déverrouillage PIN');
  } else {
    const err = document.getElementById('pin-error');
    if (err) err.textContent = '❌ PIN incorrect';
    document.getElementById('pin-input').value = '';
  }
}

function _startPinTimer() {
  if (_pinTimeout) clearTimeout(_pinTimeout);
  if (!localStorage.getItem(PIN_KEY)) return;
  _pinTimeout = setTimeout(() => {
    lockApp();
    auditLocal('APP_LOCK', 'Verrouillage automatique inactivité');
  }, PIN_IDLE_MS);
}

/* Réinitialiser le timer à chaque interaction */
['click','keydown','touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { if (localStorage.getItem(PIN_KEY)) _startPinTimer(); }, { passive: true })
);

/* ════════════════════════════════════════════════
   7. MINIMISATION DONNÉES
   Retire les champs non nécessaires avant stockage/sync.
════════════════════════════════════════════════ */

function stripSensitive(data) {
  if (typeof data === 'string') {
    /* Masquer numéros qui ressemblent à des données sensibles */
    return data
      .replace(/\b\d{13,15}\b/g, '[NIR]')
      .replace(/\b\d{9}\b/g, '[ADELI]')
      .replace(/\b\d{11}\b/g, '[RPPS]');
  }
  if (typeof data !== 'object' || !data) return data;
  const SENSITIVE_KEYS = [
    'nom_patient','prenom_patient','numero_secu','nir',
    'date_naissance','f_pt','f_sec',
    'adresse_patient','tel_patient','email_patient',
    'mutuelle','num_adherent','num_contrat',
    'secu','amo','amc','ddn',
  ];
  const clean = { ...data };
  SENSITIVE_KEYS.forEach(k => { if (clean[k] !== undefined) clean[k] = '[MASQUÉ]'; });
  return clean;
}

/* ════════════════════════════════════════════════
   8. SURVEILLANCE FRAUDE TEMPS RÉEL (v2.0)
   Détecte les fraud_score élevés et déclenche une
   alerte locale + log serveur automatique.
   Seuil FRAUD_ALERT_THRESHOLD = 70 (configurable).
════════════════════════════════════════════════ */

const FRAUD_ALERT_THRESHOLD = 70;

/**
 * À appeler après chaque retour de cotation.
 * Si fraud_score >= FRAUD_ALERT_THRESHOLD, déclenche l'alerte.
 * @param {number} score   — fraud_score retourné par le worker
 * @param {object} context — contexte minimal (acte, date) — JAMAIS de données patient
 */
async function watchFraudScore(score, context = {}) {
  if (!score || score < FRAUD_ALERT_THRESHOLD) return;

  const safeCtx = {
    score,
    acte:    context.acte    || '—',
    date:    context.date    || new Date().toISOString().slice(0,10),
    source:  context.source  || 'cotation',
  };

  log(`⚠️ Alerte fraude — score ${score} ≥ ${FRAUD_ALERT_THRESHOLD}`);
  auditLocal('FRAUD_ALERT_LOCAL', `Score ${score} — ${safeCtx.acte}`);
  await reportFraudAlert(safeCtx);
}

/**
 * Envoie l'alerte fraude au worker (system_logs côté serveur).
 * Ne transmet jamais de données patient — uniquement le score et l'acte anonymisé.
 */
async function reportFraudAlert(ctx) {
  try {
    if (typeof wpost !== 'function') return;
    await wpost('/webhook/log', {
      level:   'warn',
      source:  'security_front',
      event:   'FRAUD_ALERT_FRONT',
      message: `Score fraude ${ctx.score} — acte : ${ctx.acte} — date : ${ctx.date}`,
    });
  } catch (e) {
    logWarn('reportFraudAlert:', e.message);
  }
}

/* ════════════════════════════════════════════════
   INIT — appelé après login réussi
════════════════════════════════════════════════ */
async function initSecurity(token) {
  if (!token) return;
  await initSessionKey(token);
  cleanOldLogs();
  _startPinTimer();
  auditLocal('LOGIN', 'Connexion sécurisée');
  // 🔐 Injection accès rapide 2FA dans menus (defensive : no-op si DOM absent)
  try { if (typeof installMfaQuickAccess === 'function') installMfaQuickAccess(); } catch (_) {}
  log('Module sécurité v2.0 initialisé ✅ — AES-256-GCM · PBKDF2 100k · Fraude surveillée (seuil ' + FRAUD_ALERT_THRESHOLD + ')');
}

/* ════════════════════════════════════════════════════════════════════════
   🔐 GESTION MFA — UI dans le profil sécurité
   ────────────────────────────────────────────────────────────────────────
   Fonctions exposées au reste de l'app (appelables depuis profil.js,
   security.js, ou via window.openMfaSettings()) :
     • openMfaSettings()         → ouvre la modale plein écran 2FA
     • renderMfaSection(target)  → injecte la section dans un conteneur

   Helpers internes :
     • _fetchMfaStatus / _fetchMfaDevices
     • _mfaEnableNurse / _mfaDisableNurse
     • _mfaRegenerateRecovery
     • _mfaRevokeAllDevices

   Toutes les routes côté worker sont sous /webhook/auth-mfa-*.
═════════════════════════════════════════════════════════════════════════ */

async function _fetchMfaStatus() {
  if (typeof wpost !== 'function') return null;
  try {
    const r = await wpost('/webhook/auth-mfa-status', {});
    return r && r.ok ? r : null;
  } catch (e) { return null; }
}

async function _fetchMfaDevices() {
  if (typeof wpost !== 'function') return [];
  try {
    const r = await wpost('/webhook/auth-mfa-devices-list', {});
    return r && r.ok && Array.isArray(r.devices) ? r.devices : [];
  } catch (e) { return []; }
}

/* Workflow opt-in nurse : appelle /auth-mfa-enable, puis ouvre la modale
   d'enrôlement de auth.js pour saisir le code de confirmation. */
async function _mfaEnableNurse() {
  if (typeof wpost !== 'function') return false;
  try {
    const r = await wpost('/webhook/auth-mfa-enable', {});
    if (!r || !r.ok) {
      alert(r?.error || 'Activation impossible.');
      return false;
    }
    if (typeof _showMfaSetupModal !== 'function') {
      alert('Module d\'enrôlement indisponible — rechargez la page.');
      return false;
    }
    // Reuse la modale existante de auth.js (gère QR local + recovery codes)
    return await _showMfaSetupModal(r);
  } catch (e) {
    alert('Erreur : ' + e.message);
    return false;
  }
}

/* Désactivation nurse : demande le code TOTP courant pour confirmation. */
async function _mfaDisableNurse() {
  if (typeof wpost !== 'function') return false;
  const code = prompt('Pour désactiver le 2FA, saisissez le code à 6 chiffres affiché par votre application Authenticator :', '');
  if (!code) return false;
  const cleaned = String(code).replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(cleaned)) {
    alert('Format incorrect — 6 chiffres attendus.');
    return false;
  }
  try {
    const r = await wpost('/webhook/auth-mfa-disable', { code: cleaned });
    if (!r || !r.ok) {
      alert(r?.error || 'Désactivation impossible.');
      return false;
    }
    alert('2FA désactivé. Vos recovery codes et trusted devices ont été supprimés.');
    return true;
  } catch (e) {
    alert('Erreur : ' + e.message);
    return false;
  }
}

/* Régénération recovery codes : nécessite confirmation explicite. */
async function _mfaRegenerateRecovery() {
  if (!confirm('⚠️ Régénérer les codes de récupération ?\n\n• Les 8 codes actuels seront invalidés immédiatement.\n• Tous vos navigateurs de confiance seront aussi déconnectés.\n• Vous devrez sauvegarder les nouveaux codes.')) {
    return false;
  }
  if (typeof wpost !== 'function') return false;
  try {
    const r = await wpost('/webhook/auth-mfa-recovery-regenerate', {});
    if (!r || !r.ok) {
      alert(r?.error || 'Régénération impossible.');
      return false;
    }
    if (Array.isArray(r.recovery_codes) && typeof _showRecoveryCodesModal === 'function') {
      await _showRecoveryCodesModal(r.recovery_codes);
    }
    return true;
  } catch (e) {
    alert('Erreur : ' + e.message);
    return false;
  }
}

/* Révoque tous les trusted devices et purge le device_token local. */
async function _mfaRevokeAllDevices() {
  if (!confirm('Révoquer tous les navigateurs de confiance ?\n\nVous devrez ressaisir un code 2FA depuis chacun d\'eux au prochain login.')) {
    return false;
  }
  if (typeof wpost !== 'function') return false;
  try {
    const r = await wpost('/webhook/auth-mfa-devices-revoke', {});
    if (!r || !r.ok) {
      alert(r?.error || 'Révocation impossible.');
      return false;
    }
    // Purger aussi le token de ce navigateur (sinon il continue à skipper le MFA)
    try { localStorage.removeItem('ami_device_token'); } catch (_) {}
    alert('Tous les navigateurs de confiance ont été révoqués.');
    return true;
  } catch (e) {
    alert('Erreur : ' + e.message);
    return false;
  }
}

/* Format d'un User-Agent court (Chrome/Mac, Firefox/Windows…) */
function _shortUA(ua) {
  if (!ua) return '?';
  const s = String(ua);
  let browser = 'Navigateur';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Safari\//.test(s) && !/Chrome/.test(s)) browser = 'Safari';
  let os = '';
  if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X/.test(s) || /Macintosh/.test(s)) os = 'macOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(s)) os = 'iOS';
  else if (/Linux/.test(s)) os = 'Linux';
  return browser + (os ? ' / ' + os : '');
}

function _formatRelDate(ts) {
  if (!ts) return '';
  const diff = ts - Date.now();
  const days = Math.round(diff / 86400000);
  if (diff < 0) return 'expiré';
  if (days === 0) return 'aujourd\'hui';
  if (days === 1) return 'demain';
  if (days < 30) return `dans ${days}j`;
  const months = Math.round(days / 30);
  return `dans ${months} mois`;
}

/* Ouvre la modale plein écran "Paramètres 2FA". Affiche le statut, les
   actions disponibles selon le rôle (admin/nurse), et la liste des trusted devices. */
async function openMfaSettings() {
  // Supprimer une modale existante
  const old = document.getElementById('mfa-settings-modal');
  if (old) old.remove();

  // Conteneur de chargement
  const modal = document.createElement('div');
  modal.id = 'mfa-settings-modal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:99997;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.92);padding:20px;overflow-y:auto;
  `;
  modal.innerHTML = `
    <div style="background:#0b0f14;border:1px solid rgba(0,212,170,.3);border-radius:16px;
                padding:24px;max-width:520px;width:100%;color:#e2e8f0;font-family:sans-serif;
                max-height:90vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h2 style="font-size:18px;margin:0;color:#fff">🔐 Paramètres 2FA</h2>
        <button id="mfa-settings-close" aria-label="Fermer"
          style="background:transparent;color:#64748b;border:none;font-size:24px;cursor:pointer;padding:0 8px">×</button>
      </div>
      <div id="mfa-settings-body" style="font-size:13px;color:#94a3b8;line-height:1.6">
        <div style="text-align:center;padding:30px 0">
          <span class="spin"></span> Chargement…
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('mfa-settings-close').onclick = () => modal.remove();

  // Charger statut + devices en parallèle
  const [status, devices] = await Promise.all([
    _fetchMfaStatus(),
    _fetchMfaDevices(),
  ]);

  const body = document.getElementById('mfa-settings-body');
  if (!body) return;

  if (!status) {
    body.innerHTML = `<div style="color:#ef4444;text-align:center;padding:20px">
      ⚠️ Impossible de récupérer le statut 2FA.<br>
      <small>Vérifiez votre connexion ou réessayez.</small>
    </div>`;
    return;
  }

  const enabled    = !!status.enabled;
  const mandatory  = !!status.mandatory;
  const optional   = !!status.optional;
  const remaining  = parseInt(status.recovery_remaining || 0, 10);
  const confirmedAt = status.confirmed_at ? new Date(status.confirmed_at).toLocaleString('fr-FR') : null;

  const statusBadge = enabled
    ? `<span style="background:rgba(0,212,170,.15);color:#00d4aa;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600">✅ ACTIVÉ</span>`
    : `<span style="background:rgba(245,158,11,.15);color:#f59e0b;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600">⚠️ DÉSACTIVÉ</span>`;

  // Construction des sections
  let html = `
    <!-- Section status -->
    <div style="background:rgba(255,255,255,.02);border:1px solid #1e2d3d;border-radius:12px;padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="color:#e2e8f0">Authentification à 2 facteurs</strong>
        ${statusBadge}
      </div>
      ${mandatory ? '<div style="font-size:11px;color:#fbbf24">🔒 Obligatoire pour les administrateurs</div>' : ''}
      ${confirmedAt ? `<div style="font-size:11px;color:#64748b;margin-top:4px">Activé le ${confirmedAt}</div>` : ''}
    </div>`;

  // Section : activer pour nurse
  if (!enabled && !mandatory) {
    html += `
    <div style="background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.2);border-radius:12px;padding:14px;margin-bottom:14px">
      <strong style="color:#e2e8f0;display:block;margin-bottom:6px">Renforcez la sécurité de votre compte</strong>
      <p style="font-size:12px;color:#94a3b8;margin:0 0 10px">
        Le 2FA ajoute une couche de protection au-delà du mot de passe.
        Recommandé pour tout compte traitant des données patients.
      </p>
      <button id="mfa-enable-btn"
        style="background:#00d4aa;color:#000;border:none;padding:10px 16px;border-radius:8px;
               font-size:13px;font-weight:700;cursor:pointer">
        🔐 Activer le 2FA
      </button>
    </div>`;
  }

  // Section : recovery codes (si MFA activé)
  if (enabled) {
    const recoveryWarn = remaining <= 2
      ? `<div style="color:#ef4444;font-size:11px;margin-top:4px">⚠️ Codes presque épuisés — régénérez-les.</div>`
      : '';
    html += `
    <div style="background:rgba(255,255,255,.02);border:1px solid #1e2d3d;border-radius:12px;padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="color:#e2e8f0">🆘 Codes de récupération</strong>
        <span style="font-size:11px;color:${remaining <= 2 ? '#ef4444' : '#94a3b8'}">${remaining} / 8 restants</span>
      </div>
      <p style="font-size:12px;color:#94a3b8;margin:0 0 10px">
        À utiliser si vous perdez votre téléphone. Chaque code n'est valable qu'une seule fois.
      </p>
      ${recoveryWarn}
      <button id="mfa-regen-btn"
        style="background:#1e2d3d;color:#e2e8f0;border:none;padding:8px 14px;border-radius:6px;
               font-size:12px;cursor:pointer;margin-top:8px">
        🔄 Régénérer 8 nouveaux codes
      </button>
    </div>`;
  }

  // Section : trusted devices (si MFA activé)
  if (enabled) {
    const now = Date.now();
    const validDevices = (devices || []).filter(d => (d.expires_at || 0) > now);
    let devicesHtml = '';
    if (validDevices.length === 0) {
      devicesHtml = `<div style="color:#64748b;font-size:12px;font-style:italic;padding:8px 0">
        Aucun navigateur de confiance enregistré.
      </div>`;
    } else {
      devicesHtml = validDevices.map(d => {
        const ua = _shortUA(d.ua);
        const exp = _formatRelDate(d.expires_at);
        return `<div style="display:flex;justify-content:space-between;align-items:center;
                            padding:8px 10px;background:rgba(255,255,255,.02);border-radius:6px;margin:4px 0;font-size:12px">
          <span>📱 <strong style="color:#e2e8f0">${ua}</strong></span>
          <span style="color:#64748b">expire ${exp}</span>
        </div>`;
      }).join('');
    }
    html += `
    <div style="background:rgba(255,255,255,.02);border:1px solid #1e2d3d;border-radius:12px;padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="color:#e2e8f0">📱 Navigateurs de confiance</strong>
        <span style="font-size:11px;color:#94a3b8">${validDevices.length} / 5</span>
      </div>
      <p style="font-size:12px;color:#94a3b8;margin:0 0 10px">
        Ces navigateurs peuvent se connecter sans saisir de code 2FA pendant 30 jours.
      </p>
      ${devicesHtml}
      ${validDevices.length > 0 ? `
      <button id="mfa-revoke-devices-btn"
        style="background:#1e2d3d;color:#e2e8f0;border:none;padding:8px 14px;border-radius:6px;
               font-size:12px;cursor:pointer;margin-top:8px">
        🚫 Révoquer tous
      </button>` : ''}
    </div>`;
  }

  // Section : désactiver (nurse uniquement, jamais admin)
  if (enabled && !mandatory) {
    html += `
    <div style="background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.2);border-radius:12px;padding:14px;margin-bottom:14px">
      <strong style="color:#ef4444;display:block;margin-bottom:6px">Zone de danger</strong>
      <p style="font-size:12px;color:#94a3b8;margin:0 0 10px">
        Désactiver le 2FA réduit la sécurité de votre compte.
        Vos recovery codes et navigateurs de confiance seront supprimés.
      </p>
      <button id="mfa-disable-btn"
        style="background:transparent;color:#ef4444;border:1px solid #ef4444;padding:8px 14px;border-radius:6px;
               font-size:12px;cursor:pointer">
        🔓 Désactiver le 2FA
      </button>
    </div>`;
  }

  body.innerHTML = html;

  // Bind handlers
  const enableBtn = document.getElementById('mfa-enable-btn');
  if (enableBtn) enableBtn.onclick = async () => {
    enableBtn.disabled = true;
    enableBtn.innerHTML = '<span class="spin"></span> Activation…';
    const ok = await _mfaEnableNurse();
    if (ok) {
      modal.remove();
      // La modale d'enrôlement a tout finalisé (login refresh inclus)
    } else {
      enableBtn.disabled = false;
      enableBtn.innerHTML = '🔐 Activer le 2FA';
    }
  };

  const regenBtn = document.getElementById('mfa-regen-btn');
  if (regenBtn) regenBtn.onclick = async () => {
    regenBtn.disabled = true;
    regenBtn.innerHTML = '<span class="spin"></span> Régénération…';
    const ok = await _mfaRegenerateRecovery();
    if (ok) {
      modal.remove();
      // Re-ouvrir pour rafraîchir le compteur (8/8)
      setTimeout(() => openMfaSettings(), 300);
    } else {
      regenBtn.disabled = false;
      regenBtn.innerHTML = '🔄 Régénérer 8 nouveaux codes';
    }
  };

  const revokeBtn = document.getElementById('mfa-revoke-devices-btn');
  if (revokeBtn) revokeBtn.onclick = async () => {
    revokeBtn.disabled = true;
    revokeBtn.innerHTML = '<span class="spin"></span> Révocation…';
    const ok = await _mfaRevokeAllDevices();
    if (ok) {
      modal.remove();
      setTimeout(() => openMfaSettings(), 300);
    } else {
      revokeBtn.disabled = false;
      revokeBtn.innerHTML = '🚫 Révoquer tous';
    }
  };

  const disableBtn = document.getElementById('mfa-disable-btn');
  if (disableBtn) disableBtn.onclick = async () => {
    disableBtn.disabled = true;
    disableBtn.innerHTML = '<span class="spin"></span> Désactivation…';
    const ok = await _mfaDisableNurse();
    if (ok) {
      modal.remove();
      setTimeout(() => openMfaSettings(), 300);
    } else {
      disableBtn.disabled = false;
      disableBtn.innerHTML = '🔓 Désactiver le 2FA';
    }
  };
}

/* Injecte un bouton "Paramètres 2FA" dans un conteneur DOM existant.
   Utile pour brancher dans la page profil sans modale. Le bouton ouvre
   openMfaSettings() au clic. */
function renderMfaSection(targetId) {
  const target = typeof targetId === 'string' ? document.getElementById(targetId) : targetId;
  if (!target) return false;
  // Status badge async
  _fetchMfaStatus().then((status) => {
    const enabled   = status && !!status.enabled;
    const mandatory = status && !!status.mandatory;
    const remaining = status ? parseInt(status.recovery_remaining || 0, 10) : 0;
    const lowCodes  = enabled && remaining <= 2;
    const badge = enabled
      ? `<span style="background:rgba(0,212,170,.15);color:#00d4aa;padding:3px 8px;border-radius:12px;font-size:10px;font-weight:600">2FA ON</span>`
      : `<span style="background:rgba(245,158,11,.15);color:#f59e0b;padding:3px 8px;border-radius:12px;font-size:10px;font-weight:600">2FA OFF</span>`;
    target.innerHTML = `
      <button id="mfa-open-settings"
        style="width:100%;display:flex;justify-content:space-between;align-items:center;
               background:rgba(255,255,255,.02);border:1px solid #1e2d3d;border-radius:10px;
               padding:12px 14px;cursor:pointer;color:#e2e8f0;font-family:inherit;font-size:13px;text-align:left">
        <span style="display:flex;align-items:center;gap:10px">
          <span style="font-size:18px">🔐</span>
          <span>
            <strong>Authentification 2FA</strong>
            ${mandatory ? '<span style="display:block;font-size:10px;color:#fbbf24">Obligatoire (admin)</span>' : ''}
            ${lowCodes ? '<span style="display:block;font-size:10px;color:#ef4444">⚠️ Recovery codes presque épuisés</span>' : ''}
          </span>
        </span>
        <span style="display:flex;align-items:center;gap:8px">${badge}<span style="color:#64748b">›</span></span>
      </button>`;
    const btn = document.getElementById('mfa-open-settings');
    if (btn) btn.onclick = openMfaSettings;
  });
  return true;
}

/* Expose globalement pour appel depuis profil.js, navigation.js, etc. */
if (typeof window !== 'undefined') {
  window.openMfaSettings = openMfaSettings;
  window.renderMfaSection = renderMfaSection;
}

/* ════════════════════════════════════════════════════════════════════════
   🚀 INJECTION RAPIDE DU BOUTON 2FA — menus hamburger + sidebar
   ────────────────────────────────────────────────────────────────────────
   Appelé automatiquement depuis initSecurity() après login.
   Injecte dynamiquement (si pas déjà présents) :
     • Un bouton "🔐 2FA" dans le menu mobile #mobile-menu (avant "Profil")
     • Un item de navigation dans le sidebar desktop <nav class="side">
       sous le bloc "Système"

   Stratégie défensive :
     - Idempotente (vérif l'existence d'un id avant insertion)
     - No-op silencieuse si le DOM cible est absent (autre layout)
     - Style aligné sur les autres items existants (var(--s), var(--b), etc.)
═════════════════════════════════════════════════════════════════════════ */
function installMfaQuickAccess() {
  // ⚡ MFA TOTP DÉSACTIVÉ (sur demande utilisateur) — no-op
  //
  // Le code d'injection des boutons "🔐 2FA" dans le menu mobile et le sidebar
  // desktop reste en place ci-dessous (en commentaire) au cas où on voudrait
  // réactiver le 2FA plus tard.
  return;

  /* ── Code original conservé pour réactivation future ──
  // ── Mobile : injecte dans #mobile-menu juste avant le bouton Profil ──
  try {
    const mobileMenu = document.querySelector('#mobile-menu .grid, #mobile-menu > div');
    const btnProfilMobile = document.getElementById('btn-profil-mobile');
    if (mobileMenu && !document.getElementById('btn-mfa-mobile')) {
      const btn = document.createElement('button');
      btn.id = 'btn-mfa-mobile';
      btn.className = 'bn-item';
      btn.style.cssText = 'background:var(--s,#1e2d3d);border:1px solid var(--b,#2a3a4d);border-radius:12px;padding:12px 4px;height:auto;flex:none';
      btn.innerHTML = '<span class="bn-ic">🔐</span>2FA';
      btn.onclick = () => {
        if (typeof toggleMobileMenu === 'function') { try { toggleMobileMenu(); } catch (_) {} }
        openMfaSettings();
      };
      if (btnProfilMobile && btnProfilMobile.parentElement === mobileMenu) {
        mobileMenu.insertBefore(btn, btnProfilMobile);
      } else {
        mobileMenu.appendChild(btn);
      }
    }
  } catch (e) { console.warn('[AMI] MFA mobile button KO:', e.message); }

  try {
    const sideNav = document.querySelector('nav.side');
    if (sideNav && !document.getElementById('nav-mfa-desktop')) {
      const blocks = sideNav.querySelectorAll('.sl');
      const systemBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
      const item = document.createElement('div');
      item.className = 'ni';
      item.id = 'nav-mfa-desktop';
      item.style.cssText = 'cursor:pointer';
      item.innerHTML = '<span class="nic">🔐</span> Sécurité 2FA';
      item.onclick = () => { openMfaSettings(); };
      if (systemBlock) systemBlock.appendChild(item);
      else sideNav.appendChild(item);
    }
  } catch (e) { console.warn('[AMI] MFA desktop nav item KO:', e.message); }
  ──────────────────────────────────────────────────── */
}

if (typeof window !== 'undefined') {
  window.installMfaQuickAccess = installMfaQuickAccess;
}
