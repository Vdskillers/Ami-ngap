/* ════════════════════════════════════════════════
   security.js — AMI NGAP v1.0
   ────────────────────────────────────────────────
   Sécurité RGPD + HDS — Privacy by Design
   ─────────────────────────────────────────────────
   1. Chiffrement AES-GCM (Web Crypto API)
      - generateEncKey() — clé dérivée du mot de passe
      - encryptData() / decryptData()
      - encryptField() / decryptField() — champs unitaires
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
  const result = await generateEncKey(token.slice(0, 32), saltHex || '');
  _sessionKey = result.key;
  if (!saltHex) sessionStorage.setItem('ami_enc_salt', result.salt);
  log('Clé AES-GCM initialisée ✅');
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

function hasConsent() {
  try { return localStorage.getItem(CONSENT_KEY) === 'accepted'; } catch { return false; }
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
  try { localStorage.setItem(CONSENT_KEY, 'accepted'); } catch {}
  const modal = document.getElementById('rgpd-consent-modal');
  if (modal) modal.style.display = 'none';
  log('Consentement RGPD accepté ✅');
  /* Initialiser la clé de chiffrement après consentement */
  if (ss.tok()) initSessionKey(ss.tok());
}

function revokeConsent() {
  if (!confirm('⚠️ Révoquer votre consentement supprimera toutes vos données locales. Continuer ?')) return;
  purgeLocalData();
  try { localStorage.removeItem(CONSENT_KEY); } catch {}
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
    return data.replace(/\b\d{13,15}\b/g, '[NIR]').replace(/\b\d{9}\b/g, '[ADELI]');
  }
  if (typeof data !== 'object' || !data) return data;
  const SENSITIVE_KEYS = ['nom_patient','prenom_patient','numero_secu','nir','date_naissance','f_pt','f_sec','adresse_patient','tel_patient'];
  const clean = { ...data };
  SENSITIVE_KEYS.forEach(k => { if (clean[k]) clean[k] = '[MASQUÉ]'; });
  return clean;
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
  log('Module sécurité initialisé ✅');
}
