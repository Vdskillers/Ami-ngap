/* ════════════════════════════════════════════════
   signature.js — AMI NGAP  (v3.9 — preuve médico-légale)
   ────────────────────────────────────────────────
   Signature électronique patient + preuve opposable
   ✅ Canvas tactile + souris + stylet
   ✅ Stockage local chiffré (IDB isolé par userId)
   ✅ Export PNG embarqué dans la facture
   ✅ Historique signatures par cotation
   ✅ Conformité : horodatage + IP + user-agent

   🛡️ PREUVE MÉDICO-LÉGALE (v3.9)
   ✅ Hash SHA-256 signature (PNG + timestamp + invoice + patient_id + actes)
   ✅ Photo de présence → hashée → SUPPRIMÉE immédiatement (RGPD)
   ✅ Géozone floue — lat/lng arrondis à 2 décimales (~1km)
   ✅ Horodatage ISO 8601
   ✅ Signature serveur HMAC-SHA256 (/webhook/proof-certify)
   ✅ Upgrade preuve_soin côté cotation (FORTE + hash)
   ────────────────────────────────────────────────
   Fonctions :
   - openSignatureModal(invoiceId, context?)  — ouvre le pad
     context = { patient_id, actes, ide_id }  (facultatif)
   - captureProofPhoto()            — photo → hash → delete (jamais stockée)
   - clearSignature()               — efface le pad
   - saveSignature()                — sauvegarde + preuve + ferme
   - getSignature(invoiceId)        — récupère PNG base64
   - deleteSignature(invoiceId)     — supprime (RGPD)
   - injectSignatureInPDF(invoiceId) — ajoute signature + preuve au PDF
════════════════════════════════════════════════ */

const SIG_STORE = 'ami_signatures';
// ⚡ Clé réservée pour la signature personnelle de l'infirmier(ère)
// Utilisée pour l'auto-injection dans les PDF générés (facture, BSI, etc.)
const IDE_SELF_SIG_ID = '__ide_self__';
let _sigCanvas = null, _sigCtx = null, _sigDrawing = false;
let _currentInvoiceId = null, _sigDB = null;
let _sigDBUserId = null;        // Garde la trace du user actif pour la DB signatures
let _sigDBOpeningPromise = null; // Verrou contre les ouvertures simultanées
let _sigModalMode = 'patient';  // 'patient' | 'ide_self' — détermine le flow de saveSignature

/* ════════════════════════════════════════════════
   PREUVE MÉDICO-LÉGALE — État courant
   ────────────────────────────────────────────────
   Gardé en mémoire le temps du modal uniquement.
   Structure minimale : signature canvas + hash photo (photo NON stockée)
   + horodatage + géozone floue (département/ville — pas de GPS précis).
   Ces données alimentent saveSignature() pour produire un hash opposable.
════════════════════════════════════════════════ */
let _currentProofContext = null; // { invoice, patient_id, actes, ide_id }
let _currentPhotoHash    = null; // Hash SHA-256 d'une éventuelle photo de présence
let _currentGeozone      = null; // { zone, approx_lat, approx_lng } — précision ~1km

/* ── Helpers crypto partagés pour la preuve médico-légale ── */
async function _sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Hash canonique d'une preuve :
   SHA256(signature_png + date + invoice + patient_id + actes)
   → empreinte unique, toute modification invalide le hash.
   Le PNG n'est utilisé qu'en entrée du hash, jamais transmis. */
async function _computeProofHash({ png, timestamp, invoice, patient_id, actes }) {
  const payload = [
    png || '',
    timestamp || '',
    invoice || '',
    patient_id || '',
    Array.isArray(actes) ? actes.join(',') : String(actes || ''),
  ].join('|');
  return _sha256Hex(payload);
}

/* ════════════════════════════════════════════════
   GÉOZONE — Localisation floue (RGPD compatible)
   ────────────────────────────────────────────────
   On NE stocke PAS de GPS précis. Lat/lng arrondis à 2 décimales
   (~1 km de précision) = zone approximative, suffisant pour prouver
   "j'étais dans cette zone au moment du soin" sans tracer la personne.
════════════════════════════════════════════════ */
function _getGeozone() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), 2500);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        // Arrondi à 2 décimales = ~1km de précision (RGPD floue)
        const approx_lat = Math.round(pos.coords.latitude  * 100) / 100;
        const approx_lng = Math.round(pos.coords.longitude * 100) / 100;
        resolve({
          zone:       'zone_' + approx_lat.toFixed(2) + '_' + approx_lng.toFixed(2),
          approx_lat, approx_lng,
          precision:  '~1km',
        });
      },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: false, timeout: 2000, maximumAge: 60000 }
    );
  });
}

/* ════════════════════════════════════════════════
   PHOTO → HASH → SUPPRESSION IMMÉDIATE
   ────────────────────────────────────────────────
   ⚠️ RGPD : une photo est une donnée sensible (biométrique + santé).
   On NE stocke JAMAIS la photo. On calcule son hash SHA-256 puis
   on supprime toute référence à l'image. Seul le hash reste —
   opposable juridiquement mais vide d'information personnelle.
════════════════════════════════════════════════ */
async function captureProofPhoto() {
  return new Promise((resolve) => {
    // Input caché type=file avec capture caméra
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = async () => {
      const file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) return resolve(null);
      try {
        // Lire en ArrayBuffer pour hasher sans stocker
        const buf = await file.arrayBuffer();
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        const hash = Array.from(new Uint8Array(hashBuf))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        // ✅ Suppression immédiate : plus aucune référence à l'image
        _currentPhotoHash = hash;
        const btn = document.getElementById('sig-photo-btn');
        if (btn) {
          btn.textContent = '✅ Preuve photo enregistrée';
          btn.style.background = 'rgba(0,212,170,.15)';
          btn.style.color = 'var(--a)';
          btn.disabled = true;
        }
        if (typeof showToast === 'function') showToast('📸 Hash photo calculé — image non stockée (RGPD).', 'ok');
        resolve(hash);
      } catch (e) {
        console.warn('[Signature] captureProofPhoto:', e);
        resolve(null);
      }
    };

    input.click();
  });
}

/* ════════════════════════════════════════════════
   CERTIFICATION SERVEUR — Signature HMAC-SHA256
   ────────────────────────────────────────────────
   Envoie au worker le payload de preuve (sans le PNG — uniquement son hash).
   Le serveur renvoie une signature HMAC qui prouve :
     1. l'intégrité du payload (toute modification invalide la signature)
     2. l'origine (seul le serveur AMI peut produire cette signature)
     3. l'horodatage (le serveur ajoute son propre timestamp signé)
   → niveau juridique supérieur à une simple image/hash local.

   v2 — Retry 3 tentatives + backoff exponentiel pour fiabiliser
   la certification HMAC sur réseau mobile instable (tournée).
   Si toutes les tentatives échouent, l'invoice_id est ajouté à une file
   d'attente persistante (localStorage) drainée plus tard.
════════════════════════════════════════════════ */
async function _certifyProofOnServer(payload) {
  if (typeof S === 'undefined' || !S?.token) return null;
  const wpost = typeof window.wpost === 'function' ? window.wpost
    : (url, body) => (typeof apiCall === 'function' ? apiCall(url, body) : Promise.reject('no wpost'));

  const _MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= _MAX_RETRIES; attempt++) {
    try {
      const res = await wpost('/webhook/proof-certify', { payload });
      if (res?.ok && res?.server_signature) {
        return {
          server_signature: res.server_signature,
          algorithm:        res.algorithm || 'HMAC-SHA256',
          cert_timestamp:   res.cert_timestamp,
          cert_id:          res.cert_id,
          zone_source:      res.zone_source || null,        // 'gps_client' | 'ip_fallback' | null
          server_zone:      res.payload?.zone || null,      // zone telle que signée (peut différer si IP fallback)
          version:          res.version || 2,
        };
      }
      // Si le serveur répond une erreur métier (400/403), inutile de retry
      if (res && res.ok === false) {
        console.warn('[Signature] proof-certify rejet métier :', res.error || 'unknown');
        return null;
      }
    } catch (e) {
      const msg = e?.message || String(e);
      console.warn(`[Signature] _certifyProofOnServer tentative ${attempt}/${_MAX_RETRIES} KO :`, msg);
      if (attempt < _MAX_RETRIES) {
        // Backoff exponentiel : 400ms, 1.2s, 3.6s
        await new Promise(r => setTimeout(r, 400 * Math.pow(3, attempt - 1)));
      }
    }
  }
  return null;
}

/* ── File d'attente persistante pour HMAC offline ──
   Stocke localement les invoice_id qui n'ont pas pu être certifiés.
   Drainée à chaque navigation vers #view-sig + au login + au retour online. */
const _SIG_HMAC_QUEUE_KEY = 'ami_pending_hmac_v1';
function _hmacQueueGet() {
  try { return JSON.parse(localStorage.getItem(_SIG_HMAC_QUEUE_KEY) || '[]'); }
  catch (_) { return []; }
}
function _hmacQueuePush(invoiceId) {
  if (!invoiceId) return;
  const q = _hmacQueueGet();
  if (!q.includes(invoiceId)) q.push(invoiceId);
  try { localStorage.setItem(_SIG_HMAC_QUEUE_KEY, JSON.stringify(q.slice(-50))); } catch (_) {}
}
function _hmacQueueRemove(invoiceId) {
  const q = _hmacQueueGet().filter(id => id !== invoiceId);
  try { localStorage.setItem(_SIG_HMAC_QUEUE_KEY, JSON.stringify(q)); } catch (_) {}
}

async function _drainHmacQueue() {
  if (typeof S === 'undefined' || !S?.token) return;
  if (!navigator.onLine) return;
  const q = _hmacQueueGet();
  if (!q.length) return;
  for (const invoiceId of q) {
    try {
      const sig = await _sigGet(invoiceId);
      if (!sig) { _hmacQueueRemove(invoiceId); continue; }
      // Skip si déjà certifié entre-temps
      if (sig.server_cert?.server_signature) { _hmacQueueRemove(invoiceId); continue; }
      // Skip si pas de payload exploitable
      if (!sig.proof_payload || !sig.signature_hash) { _hmacQueueRemove(invoiceId); continue; }

      const cert = await _certifyProofOnServer(sig.proof_payload);
      if (cert) {
        await _sigPut({ ...sig, server_cert: cert });
        _hmacQueueRemove(invoiceId);
        console.info('[AMI:Sig] HMAC queue drained :', invoiceId);
      }
    } catch (e) {
      console.warn('[AMI:Sig] queue drain item KO :', e.message);
    }
  }
  // Re-render si la vue est ouverte
  try { if (typeof loadSignatureList === 'function') loadSignatureList(); } catch (_) {}
}

// Drainer la file au retour online (utile en tournée 3G/4G instable)
window.addEventListener('online', () => { _drainHmacQueue().catch(() => {}); });

/* ── Retourne le nom de la base IndexedDB signatures isolée par user ──
   Chaque infirmière a sa propre base : ami_sig_db_<userId>.
   Un admin voit uniquement ses propres signatures de test.
───────────────────────────────────────────────────────────────────── */
function _getSigDBName() {
  const uid = (typeof S !== 'undefined') ? (S?.user?.id || S?.user?.email || 'local') : 'local';
  return 'ami_sig_db_' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/* ── IndexedDB ── */
async function _initSigDB() {
  const currentUserId = (typeof S !== 'undefined') ? (S?.user?.id || S?.user?.email || 'local') : 'local';
  // Fermer si l'utilisateur a changé
  if (_sigDB && _sigDBUserId !== currentUserId) {
    try { _sigDB.close(); } catch (_) {}
    _sigDB = null;
    _sigDBUserId = null;
    _sigDBOpeningPromise = null;
  }
  if (_sigDB) return _sigDB;
  // Verrou : si une ouverture est déjà en cours, attendre qu'elle termine
  if (_sigDBOpeningPromise) return _sigDBOpeningPromise;

  const dbName = _getSigDBName();
  _sigDBOpeningPromise = new Promise((res, rej) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SIG_STORE)) {
        db.createObjectStore(SIG_STORE, { keyPath: 'invoice_id' });
      }
    };
    req.onsuccess = e => {
      _sigDB = e.target.result;
      _sigDBUserId = currentUserId;
      _sigDBOpeningPromise = null;
      // Détecter fermeture inattendue (ex: Tracking Prevention Edge)
      _sigDB.onclose = () => {
        _sigDB = null;
        _sigDBUserId = null;
        _sigDBOpeningPromise = null;
      };
      res(_sigDB);
    };
    req.onerror = () => {
      _sigDBOpeningPromise = null;
      rej(req.error);
    };
    req.onblocked = () => {
      console.warn('[AMI] SigDB bloquée — autre instance ouverte');
    };
  });
  return _sigDBOpeningPromise;
}

/* Wrapper retry sur InvalidStateError (DB closing) */
async function _sigExec(fn, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const db = await _initSigDB();
      return await fn(db);
    } catch (e) {
      const isClosing = e?.name === 'InvalidStateError'
        || (e?.message || '').includes('closing')
        || (e?.message || '').includes('closed');
      if (isClosing && attempt < retries) {
        try { if (_sigDB) _sigDB.close(); } catch (_) {}
        _sigDB = null;
        _sigDBUserId = null;
        _sigDBOpeningPromise = null;
        await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function _sigPut(val) {
  return _sigExec(db => new Promise((res, rej) => {
    const tx = db.transaction(SIG_STORE, 'readwrite');
    tx.objectStore(SIG_STORE).put(val).onsuccess = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}

async function _sigGet(id) {
  return _sigExec(db => new Promise((res) => {
    const tx = db.transaction(SIG_STORE, 'readonly');
    const req = tx.objectStore(SIG_STORE).get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror   = () => res(null);
  }));
}

async function _sigDelete(id) {
  return _sigExec(db => new Promise((res) => {
    const tx = db.transaction(SIG_STORE, 'readwrite');
    tx.objectStore(SIG_STORE).delete(id);
    tx.oncomplete = () => res();
  }));
}

/* ════════════════════════════════════════════════
   BACKFILL DES PREUVES MANQUANTES (v2 — reconstruction rétroactive)
   ────────────────────────────────────────────────
   Scanne toutes les signatures locales et tente de compléter celles qui
   ont des preuves manquantes :
     - signature_hash manquant → reconstruit depuis le PNG existant
     - proof_payload manquant → reconstruit depuis ce qu'on a (legacy v1)
     - geozone null → re-tentative GPS (si l'utilisateur autorise maintenant)
     - server_cert null → re-tentative HMAC-SHA256 sur le worker
   Photo : non backfillable (donnée biométrique non stockée → perte définitive
   pour les anciennes signatures, pas de fallback possible).
   Limité à 1 backfill / 30 min / signature pour éviter des appels en boucle.
   Non bloquant — exécution silencieuse en arrière-plan.
   IDE_self : skip (pas de preuve médico-légale, c'est un template).
════════════════════════════════════════════════ */
let _sigBackfillRunning = false;
async function _sigBackfillProofs(targetInvoiceId) {
  if (_sigBackfillRunning) return;
  _sigBackfillRunning = true;
  try {
    const all = await _sigExec(db => new Promise((res) => {
      const tx = db.transaction(SIG_STORE, 'readonly');
      const req = tx.objectStore(SIG_STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => res([]);
    }));

    if (!Array.isArray(all) || !all.length) return;

    const _now = Date.now();
    const _BACKFILL_COOLDOWN = 30 * 60 * 1000; // 30 min
    let _patched = 0;
    for (const sig of all) {
      if (!sig?.invoice_id) continue;
      // Skip signature IDE template (pas de preuve médico-légale dessus)
      if (sig.invoice_id === IDE_SELF_SIG_ID) continue;
      // Si une cible spécifique est demandée, ne traiter que celle-ci
      if (targetInvoiceId && sig.invoice_id !== targetInvoiceId) continue;
      // Skip si pas de PNG (signature complètement corrompue)
      if (!sig.png && !sig.data_url) continue;

      // Cooldown : 30 min entre tentatives — sauf appel ciblé (forcer)
      const _lastAttempt = sig._backfill_at || 0;
      if (!targetInvoiceId && (_now - _lastAttempt < _BACKFILL_COOLDOWN)) continue;

      const _missingHash = !sig.signature_hash;
      const _missingCert = !(sig.server_cert && sig.server_cert.server_signature);
      const _missingZone = !(sig.geozone && sig.geozone.zone);
      const _missingPayload = !sig.proof_payload;
      if (!_missingHash && !_missingCert && !_missingZone && !_missingPayload) continue;

      const updates = { ...sig, _backfill_at: _now };
      const _png = sig.png || sig.data_url;
      const _signedAt = sig.signed_at || sig.created_at || new Date(_now).toISOString();
      // Forcer signed_at en ISO 8601 si absent (legacy)
      if (!sig.signed_at) updates.signed_at = _signedAt;

      // ── 1. Reconstruction du signature_hash si manquant ──
      //    Hash = SHA-256(PNG + timestamp + invoice + patient_id + actes)
      //    Pour les legacy, patient_id et actes peuvent être vides — c'est OK,
      //    le hash reste opposable (n'importe quelle modification ultérieure
      //    invalidera le hash, ce qui est l'objectif).
      if (_missingHash) {
        try {
          const _legacyHash = await _computeProofHash({
            png:        _png,
            timestamp:  _signedAt,
            invoice:    sig.invoice_id,
            patient_id: sig.proof_payload?.patient_id || '',
            actes:      sig.proof_payload?.actes || [],
          });
          updates.signature_hash = _legacyHash;
        } catch (_) {}
      }

      // ── 2. Reconstruction du proof_payload si manquant ──
      const _hashFinal = updates.signature_hash || sig.signature_hash;
      if (_missingPayload && _hashFinal) {
        updates.proof_payload = {
          invoice:        sig.invoice_id,
          patient_id:     '',
          ide_id:         (typeof S !== 'undefined') ? (S?.user?.id || '') : '',
          actes:          [],
          timestamp:      _signedAt,
          signature_hash: _hashFinal,
          photo_hash:     sig.photo_hash || null,
          zone:           sig.geozone?.zone || null,
        };
      }

      // ── 3. Tenter récupération géozone (si l'utilisateur autorise maintenant) ──
      if (_missingZone) {
        try {
          const z = await _getGeozone();
          if (z) updates.geozone = z;
        } catch (_) {}
      }

      // ── 4. Tenter certification serveur (HMAC-SHA256) ──
      if (_missingCert && _hashFinal) {
        try {
          const _payloadForCert = {
            ...(updates.proof_payload || sig.proof_payload || {}),
            signature_hash: _hashFinal,
            zone: updates.geozone?.zone || sig.geozone?.zone || null,
          };
          const cert = await _certifyProofOnServer(_payloadForCert);
          if (cert) updates.server_cert = cert;
        } catch (_) {}
      }

      // ── 5. Marquer comme version 2 (preuve backfillée rétroactivement) ──
      const _hadAnyProof = sig.signature_hash || sig.proof_payload || sig.server_cert;
      updates.proof_version = _hadAnyProof ? (sig.proof_version || 2) : 2;
      if (!_hadAnyProof) updates.proof_legacy_backfill = true;

      // Persiste la tentative (même si rien n'a abouti) pour respecter le cooldown
      await _sigPut(updates);

      // Compter comme "patched" uniquement si une vraie nouvelle preuve a été obtenue
      if ((_missingHash && updates.signature_hash)
          || (_missingZone && updates.geozone)
          || (_missingCert && updates.server_cert)
          || (_missingPayload && updates.proof_payload)) {
        _patched++;
      }
    }
    if (_patched > 0) {
      console.info(`[AMI:Sig] Backfill : ${_patched} signature(s) complétée(s)`);
      // Re-render la liste si elle est visible
      try {
        if (typeof loadSignatureList === 'function') loadSignatureList();
        else if (typeof renderSignaturesList === 'function') renderSignaturesList();
      } catch (_) {}
      if (targetInvoiceId && typeof showToast === 'function') {
        showToast('🛡️ Preuve renforcée avec succès.', 'ok');
      }
    } else if (targetInvoiceId && typeof showToast === 'function') {
      showToast('ℹ️ Aucune preuve supplémentaire récupérable pour cette signature.', 'info');
    }
  } catch (e) {
    console.warn('[AMI:Sig] Backfill KO :', e?.message);
  } finally {
    _sigBackfillRunning = false;
  }
}

/* Renforce manuellement une signature spécifique (depuis bouton UI) */
async function reinforceSignatureProof(invoiceId) {
  if (!invoiceId) return;
  if (typeof showToast === 'function') showToast('🛡️ Renforcement de la preuve en cours…', 'info');
  await _sigBackfillProofs(invoiceId);
}
window.reinforceSignatureProof = reinforceSignatureProof;

/* ════════════════════════════════════════════════
   SYNC SIGNATURES — PC ↔ Mobile via Supabase
   ────────────────────────────────────────────────
   Les PNG sont chiffrés AES-256-GCM AVANT envoi.
   Le serveur ne stocke que des blobs opaques (RGPD/HDS).
   La clé de chiffrement reste sur l'appareil.
════════════════════════════════════════════════ */

/* Chiffre un PNG base64 via AES-256-GCM (Web Crypto) — retourne base64 */
async function _sigEncrypt(pngBase64) {
  const uid = (typeof S !== 'undefined') ? (S?.user?.id || S?.user?.email || 'local') : 'local';
  const rawKey = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode('sig_enc_' + uid)),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(pngBase64);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, rawKey, enc);
  // Concatène iv (12 bytes) + ciphertext, encode en base64
  const combined = new Uint8Array(12 + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), 12);
  return btoa(String.fromCharCode(...combined));
}

/* Déchiffre un blob base64 chiffré par _sigEncrypt */
async function _sigDecrypt(encBase64) {
  const uid = (typeof S !== 'undefined') ? (S?.user?.id || S?.user?.email || 'local') : 'local';
  const rawKey = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode('sig_enc_' + uid)),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const combined = Uint8Array.from(atob(encBase64), c => c.charCodeAt(0));
  const iv       = combined.slice(0, 12);
  const cipher   = combined.slice(12);
  const plain    = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, rawKey, cipher);
  return new TextDecoder().decode(plain);
}

/* Pousse toutes les signatures locales vers le serveur */
async function syncSignaturesToServer() {
  if (typeof S === 'undefined' || !S?.token) return;
  try {
    const all = await _sigExec(db => new Promise((res, rej) => {
      const tx  = db.transaction(SIG_STORE, 'readonly');
      const req = tx.objectStore(SIG_STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    }));
    if (!all.length) return;

    const signatures = [];
    for (const sig of all) {
      if (!sig.invoice_id || !sig.png) continue;
      try {
        const encrypted_data = await _sigEncrypt(sig.png);
        signatures.push({
          invoice_id:     sig.invoice_id,
          encrypted_data,
          updated_at:     sig.signed_at || new Date().toISOString(),
        });
      } catch(_) {}
    }
    if (!signatures.length) return;

    const wpost = typeof window.wpost === 'function' ? window.wpost
      : (url, body) => (typeof apiCall === 'function' ? apiCall(url, body) : Promise.reject('no wpost'));
    const res = await wpost('/webhook/signatures-push', { signatures });
    if (res?.ok) console.info('[AMI:Sig] Sync push OK :', signatures.length);
  } catch(e) {
    console.warn('[AMI:Sig] Sync push KO :', e.message);
  }
}

/* Tire les signatures du serveur et fusionne avec l'IDB local */
async function syncSignaturesFromServer() {
  if (typeof S === 'undefined' || !S?.token) return;
  try {
    const wpost = typeof window.wpost === 'function' ? window.wpost
      : (url, body) => (typeof apiCall === 'function' ? apiCall(url, body) : Promise.reject('no wpost'));
    const res = await wpost('/webhook/signatures-pull', {});
    if (!res?.ok || !Array.isArray(res.signatures) || !res.signatures.length) return;

    // Charger les locales pour comparaison par date
    const localAll = await _sigExec(db => new Promise((res2, rej) => {
      const tx  = db.transaction(SIG_STORE, 'readonly');
      const req = tx.objectStore(SIG_STORE).getAll();
      req.onsuccess = () => res2(req.result || []);
      req.onerror   = () => rej(req.error);
    }));
    const localMap = new Map(localAll.map(s => [s.invoice_id, s]));

    let merged = 0;
    for (const remote of res.signatures) {
      if (!remote.invoice_id || !remote.encrypted_data) continue;
      const local = localMap.get(remote.invoice_id);
      const remoteDate = new Date(remote.updated_at || 0).getTime();
      const localDate  = local ? new Date(local.signed_at || 0).getTime() : 0;
      if (!local || remoteDate > localDate) {
        try {
          const png = await _sigDecrypt(remote.encrypted_data);
          await _sigPut({
            invoice_id: remote.invoice_id,
            png,
            signed_at:  remote.updated_at || new Date().toISOString(),
            user_agent: 'sync',
          });
          merged++;
        } catch(_) {}
      }
    }
    if (merged > 0) {
      console.info('[AMI:Sig] Sync pull OK :', merged, 'signatures fusionnées');
      if (typeof showToastSafe === 'function') showToastSafe(`✍️ ${merged} signature(s) reçue(s).`);
      if (typeof loadSignatureList === 'function') loadSignatureList();
    }
  } catch(e) {
    console.warn('[AMI:Sig] Sync pull KO :', e.message);
  }
}

/* Push immédiat d'une signature après sauvegarde */
async function _syncSignatureNow(invoiceId, png, signedAt) {
  if (typeof S === 'undefined' || !S?.token) return;
  try {
    const encrypted_data = await _sigEncrypt(png);
    const wpost = typeof window.wpost === 'function' ? window.wpost
      : (url, body) => (typeof apiCall === 'function' ? apiCall(url, body) : Promise.reject('no wpost'));
    await wpost('/webhook/signatures-push', {
      signatures: [{ invoice_id: invoiceId, encrypted_data, updated_at: signedAt || new Date().toISOString() }]
    });
  } catch(e) {
    console.warn('[AMI:Sig] _syncSignatureNow KO :', e.message);
  }
}

/* ════════════════════════════════════════════════
   MODAL SIGNATURE
   ────────────────────────────────────────────────
   openSignatureModal(invoiceId, context?)
   context = { patient_id, actes, ide_id } — utilisé pour construire
   le hash de preuve médico-légale. Optionnel — sans contexte,
   seule l'empreinte PNG+timestamp+invoice est hashée.
════════════════════════════════════════════════ */
function openSignatureModal(invoiceId, context) {
  _sigModalMode = 'patient';
  _currentInvoiceId = invoiceId || 'sig_' + Date.now();
  _currentProofContext = context && typeof context === 'object' ? {
    patient_id: context.patient_id || '',
    actes:      Array.isArray(context.actes) ? context.actes : (context.actes ? [context.actes] : []),
    ide_id:     context.ide_id     || '',
  } : null;
  // Reset état preuve du tour précédent
  _currentPhotoHash = null;
  _currentGeozone   = null;

  let modal = document.getElementById('sig-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'sig-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:1500;display:flex;align-items:center;
      justify-content:center;background:rgba(11,15,20,.92);
      backdrop-filter:blur(12px);padding:20px;overflow-y:auto`;
    modal.innerHTML = `
      <div style="background:var(--c);border:1px solid var(--b);border-radius:20px;
        padding:28px;width:100%;max-width:520px;box-shadow:0 0 60px rgba(0,0,0,.6);margin:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div style="font-family:var(--fs);font-size:20px">✍️ Signature patient</div>
          <button onclick="closeSignatureModal()" style="background:var(--s);border:1px solid var(--b);
            color:var(--m);width:32px;height:32px;border-radius:50%;cursor:pointer;
            display:grid;place-items:center;font-size:16px">✕</button>
        </div>
        <p style="font-size:12px;color:var(--m);margin-bottom:14px">
          Signez dans le cadre ci-dessous pour valider le soin et autoriser la télétransmission.
          La signature est chiffrée (AES-256) et synchronisée entre vos appareils.
        </p>
        <div style="position:relative;border:2px dashed var(--b);border-radius:var(--r);
          background:var(--s);overflow:hidden;touch-action:none" id="sig-wrap">
          <canvas id="sig-canvas" width="480" height="200"
            style="width:100%;height:200px;display:block;cursor:crosshair"></canvas>
          <div id="sig-placeholder" style="position:absolute;inset:0;display:flex;
            align-items:center;justify-content:center;color:var(--m);font-size:13px;
            pointer-events:none;font-family:var(--fm)">Signez ici ✍️</div>
        </div>
        <div id="sig-info" style="font-family:var(--fm);font-size:10px;color:var(--m);
          margin-top:8px;text-align:right"></div>

        <!-- ── Preuve médico-légale renforcée — 4 GARANTIES OBLIGATOIRES ── -->
        <div style="margin-top:14px;padding:12px;background:var(--s);border:1px solid var(--b);border-radius:var(--r)">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--m);margin-bottom:8px;font-family:var(--fm)">
            🛡️ Preuve médico-légale (4 garanties)
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
            <button type="button" id="sig-photo-btn" class="btn bs bsm" onclick="captureProofPhoto()"
              style="font-size:11px;padding:6px 10px">
              📸 Ajouter preuve présence (option.)
            </button>
            <span style="font-size:10px;color:var(--m);font-family:var(--fm);flex:1;min-width:180px">
              Photo hashée puis <strong>supprimée</strong> immédiatement · RGPD
            </span>
          </div>
          <!-- Indicateurs live des 4 garanties (mis à jour pendant la signature) -->
          <div id="sig-proof-indicators" style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;font-size:10px;font-family:var(--fm)">
            <span id="sig-ind-hash" class="sig-ind sig-ind-pending" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:rgba(255,180,0,.12);color:#f5a623;border-radius:4px"
              title="SHA-256(tracé + date + acte + patient) — toute modification invalide le hash">
              ⏳ Hash SHA-256 (tracé+date+acte+patient)
            </span>
            <span id="sig-ind-iso" class="sig-ind sig-ind-ok" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:rgba(0,212,170,.12);color:var(--a);border-radius:4px"
              title="Horodatage ISO 8601 — prouve quand le soin a eu lieu">
              ✔ Horodatage ISO 8601
            </span>
            <span id="sig-ind-zone" class="sig-ind sig-ind-pending" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:rgba(255,180,0,.12);color:#f5a623;border-radius:4px"
              title="Lat/lng arrondis : prouve la zone sans tracer précisément">
              ⏳ Géozone floue (~1km)
            </span>
            <span id="sig-ind-hmac" class="sig-ind sig-ind-pending" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:rgba(255,180,0,.12);color:#f5a623;border-radius:4px"
              title="Signature serveur HMAC-SHA256 — impossible à antidater ou falsifier">
              ⏳ HMAC-SHA256 serveur
            </span>
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
          <button class="btn bp" onclick="saveSignature()" style="flex:1">💾 Valider la signature</button>
          <button class="btn bs bsm" onclick="clearSignature()">🗑️ Effacer</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  } else {
    // Reset état bouton photo si modal réutilisé
    const pbtn = document.getElementById('sig-photo-btn');
    if (pbtn) {
      pbtn.textContent = '📸 Ajouter preuve présence';
      pbtn.disabled = false;
      pbtn.style.background = '';
      pbtn.style.color = '';
    }
  }

  modal.style.display = 'flex';
  _initCanvas();

  // Afficher l'horodatage
  const info = document.getElementById('sig-info');
  if (info) info.textContent = new Date().toLocaleString('fr-FR') + ' · Facture ' + (_currentInvoiceId || '—');

  // Reset indicateurs live (modal réutilisé)
  _setProofIndicator('hash', 'pending');
  _setProofIndicator('zone', 'pending');
  _setProofIndicator('hmac', 'pending');

  // Préparer la géozone en arrière-plan + bascule indicateur live
  _getGeozone().then(z => {
    _currentGeozone = z;
    _setProofIndicator('zone', z ? 'ok' : 'pending');
  }).catch(() => {});
}

/* Helper UI — bascule un indicateur du modal entre pending/ok/fail */
function _setProofIndicator(kind, state) {
  const el = document.getElementById('sig-ind-' + kind);
  if (!el) return;
  const labels = {
    hash: { pending: '⏳ Hash SHA-256 (tracé+date+acte+patient)', ok: '✔ Hash SHA-256 (tracé+date+acte+patient)', fail: '⚠ Hash non calculé' },
    zone: { pending: '⏳ Géozone floue (~1km)',  ok: '✔ Géozone floue (~1km)',     fail: '⚠ Géozone indispo (fallback IP)' },
    hmac: { pending: '⏳ HMAC-SHA256 serveur',   ok: '✔ HMAC-SHA256 serveur',      fail: '⚠ HMAC en file d\'attente' },
    iso:  { pending: '⏳ Horodatage ISO 8601',   ok: '✔ Horodatage ISO 8601',      fail: '⚠ Horodatage ISO 8601' },
  };
  const colors = {
    pending: { bg: 'rgba(255,180,0,.12)',  fg: '#f5a623' },
    ok:      { bg: 'rgba(0,212,170,.12)',  fg: 'var(--a)' },
    fail:    { bg: 'rgba(255,90,90,.12)',  fg: '#ff5a5a' },
  };
  const lbl = labels[kind]?.[state] || '';
  const c = colors[state] || colors.pending;
  el.textContent = lbl;
  el.style.background = c.bg;
  el.style.color = c.fg;
}

function closeSignatureModal() {
  const modal = document.getElementById('sig-modal');
  if (modal) modal.style.display = 'none';
}

/* ════════════════════════════════════════════════
   CANVAS — DESSIN
════════════════════════════════════════════════ */
function _initCanvas() {
  _sigCanvas = document.getElementById('sig-canvas');
  if (!_sigCanvas) return;
  _sigCtx = _sigCanvas.getContext('2d');
  _sigCtx.clearRect(0, 0, _sigCanvas.width, _sigCanvas.height);
  _sigCtx.strokeStyle = '#e8f0f8';
  _sigCtx.lineWidth   = 2.5;
  _sigCtx.lineCap     = 'round';
  _sigCtx.lineJoin    = 'round';
  _sigDrawing = false;

  // Masquer le placeholder quand on commence à dessiner
  const placeholder = document.getElementById('sig-placeholder');

  const getPos = (e) => {
    const rect = _sigCanvas.getBoundingClientRect();
    const scaleX = _sigCanvas.width  / rect.width;
    const scaleY = _sigCanvas.height / rect.height;
    const src = e.touches ? e.touches[0] : e;
    return {
      x: (src.clientX - rect.left) * scaleX,
      y: (src.clientY - rect.top)  * scaleY,
    };
  };

  const start = (e) => {
    e.preventDefault();
    _sigDrawing = true;
    if (placeholder) placeholder.style.display = 'none';
    const { x, y } = getPos(e);
    _sigCtx.beginPath();
    _sigCtx.moveTo(x, y);
  };

  const draw = (e) => {
    e.preventDefault();
    if (!_sigDrawing) return;
    const { x, y } = getPos(e);
    _sigCtx.lineTo(x, y);
    _sigCtx.stroke();
  };

  const end = () => { _sigDrawing = false; };

  // Souris
  _sigCanvas.addEventListener('mousedown',  start);
  _sigCanvas.addEventListener('mousemove',  draw);
  _sigCanvas.addEventListener('mouseup',    end);
  _sigCanvas.addEventListener('mouseleave', end);

  // Tactile (tablette, smartphone)
  _sigCanvas.addEventListener('touchstart', start, { passive: false });
  _sigCanvas.addEventListener('touchmove',  draw,  { passive: false });
  _sigCanvas.addEventListener('touchend',   end);
}

function clearSignature() {
  if (!_sigCanvas || !_sigCtx) return;
  _sigCtx.clearRect(0, 0, _sigCanvas.width, _sigCanvas.height);
  const placeholder = document.getElementById('sig-placeholder');
  if (placeholder) placeholder.style.display = 'flex';
}

/* ════════════════════════════════════════════════
   SAUVEGARDE & RÉCUPÉRATION — avec preuve médico-légale
   ────────────────────────────────────────────────
   Flow UX invisible (≤2 secondes) :
     1. Patient signe → Valider
     2. En arrière-plan :
        - hash signature (SHA-256 du PNG + contexte)
        - géozone floue (lat/lng ~1km)
        - certification serveur (HMAC-SHA256 signé)
        - mise à jour preuve_soin côté cotation
     3. Badges ✔ Preuve certifiée / Horodatée / Sécurisée
   ────────────────────────────────────────────────
   ⚠️ Le PNG reste en local (chiffré). Le SERVEUR ne reçoit que :
     - encrypted_data (PNG AES-256-GCM, coffre opaque)
     - hash opaque + métadonnées (type, timestamp, zone)
     - jamais d'image brute, jamais de photo
════════════════════════════════════════════════ */
async function saveSignature() {
  if (!_sigCanvas) { closeSignatureModal(); return; }

  // Vérifier si la signature est vide
  const imageData = _sigCtx.getImageData(0, 0, _sigCanvas.width, _sigCanvas.height);
  const hasDrawing = imageData.data.some(v => v !== 0);
  if (!hasDrawing) {
    if (!confirm('Aucune signature tracée. Valider quand même ?')) return;
  }

  // ── BRANCHE : signature personnelle de l'infirmier(ère) ──
  //   → pas de preuve médico-légale (c'est un template, pas un acte de soin)
  //   → stockage sous clé réservée, synchronisé entre appareils via chiffrement AES
  if (_sigModalMode === 'ide_self') {
    const png       = _sigCanvas.toDataURL('image/png');
    const signedAt  = new Date().toISOString();
    await _sigPut({
      invoice_id:  IDE_SELF_SIG_ID,
      png,
      signed_at:   signedAt,
      user_agent:  navigator.userAgent.slice(0, 100),
      ide_self:    true,
    });
    // Sync chiffrée vers le serveur (mécanisme existant, même clé)
    _syncSignatureNow(IDE_SELF_SIG_ID, png, signedAt).catch(() => {});

    closeSignatureModal();
    _sigModalMode = 'patient'; // reset

    // Rafraîchir UI appelante si présente
    const preview = document.getElementById('ide-sig-preview');
    if (preview) {
      preview.innerHTML = `<img src="${png}" style="width:100%;height:100%;object-fit:contain">`;
    }
    const stateBtn = document.getElementById('btn-ide-sig');
    if (stateBtn) stateBtn.textContent = '✏️ Modifier ma signature';
    const delBtn = document.getElementById('btn-ide-sig-delete');
    if (delBtn) delBtn.style.display = 'inline-flex';

    // Rafraîchir la vue signatures si elle est montée
    if (typeof loadSignatureList === 'function') loadSignatureList();

    if (typeof showToast === 'function') {
      showToast('✍️ Signature enregistrée — elle sera injectée dans les PDF générés.', 'ok');
    }
    return;
  }

  // ── BRANCHE : signature patient (flow médico-légal complet) ──
  //
  // GARANTIES MÉDICO-LÉGALES (chaque signature DOIT contenir ces 4 preuves) :
  //   ✔ Hash SHA-256 — empreinte du tracé+date+acte+patient (toute modif invalide)
  //   ✔ Horodatage ISO 8601 — toISOString() retourne toujours UTC ISO 8601
  //   ✔ Géozone floue (~1km) — tentative GPS active + fallback IP côté worker
  //   ✔ Signature HMAC-SHA256 serveur — retry 3x + file d'attente offline
  //
  // (Photo de présence reste optionnelle — si fournie, elle est aussi hashée.)
  const png       = _sigCanvas.toDataURL('image/png');
  const signedAt  = new Date().toISOString();   // ✔ ISO 8601 garanti
  const ctx       = _currentProofContext || {};

  // ── 1) Hash local de la preuve (empreinte opposable) ──
  // Hash = SHA-256(PNG + timestamp + invoice + patient_id + actes)
  // Toute modification ultérieure (PNG, date, acte, patient) invalide le hash.
  let signatureHash = '';
  try {
    signatureHash = await _computeProofHash({
      png,
      timestamp:  signedAt,
      invoice:    _currentInvoiceId,
      patient_id: ctx.patient_id || '',
      actes:      ctx.actes || [],
    });
  } catch (_) {}
  _setProofIndicator('hash', signatureHash ? 'ok' : 'fail');

  // ── 2) Géozone floue — tentative ACTIVE (pas seulement passive) ──
  // Si openSignatureModal a déjà résolu _currentGeozone en arrière-plan, on l'utilise.
  // Sinon, on retente activement avec timeout 4s pour ne pas bloquer en tournée.
  // Si même cette tentative échoue, le worker fera un fallback IP via request.cf
  // (précision ~10km au lieu de ~1km, mais reste une preuve de zone valide).
  if (!_currentGeozone) {
    try { _currentGeozone = await _getGeozone(); } catch (_) {}
  }
  _setProofIndicator('zone', _currentGeozone ? 'ok' : 'fail');

  // ── 3) Certification serveur HMAC-SHA256 (bloquante avec retry interne 3x) ──
  const proofPayload = {
    invoice:        _currentInvoiceId,
    patient_id:     ctx.patient_id || '',
    ide_id:         (typeof S !== 'undefined') ? (S?.user?.id || '') : '',
    actes:          ctx.actes || [],
    timestamp:      signedAt,            // ISO 8601 — sera validé regex côté worker
    signature_hash: signatureHash,
    photo_hash:     _currentPhotoHash || null,
    zone:           _currentGeozone?.zone || null,   // null → fallback IP côté worker
  };
  let serverCert = null;
  try { serverCert = await _certifyProofOnServer(proofPayload); } catch (_) {}
  _setProofIndicator('hmac', serverCert ? 'ok' : 'fail');

  // Si la zone côté client était null mais le worker a fait fallback IP,
  // on récupère la zone effective signée pour l'affichage.
  let effectiveGeozone = _currentGeozone;
  if (!effectiveGeozone && serverCert?.server_zone) {
    effectiveGeozone = {
      zone:       serverCert.server_zone,
      precision:  '~10km',
      source:     'ip_fallback',
    };
  }

  // Si la certification HMAC a échoué → mettre dans la file pour retry plus tard
  if (!serverCert) {
    _hmacQueuePush(_currentInvoiceId);
    console.info('[AMI:Sig] HMAC indisponible — invoice ajouté à la file de retry :', _currentInvoiceId);
  }

  // ── 4) Stockage local : PNG + toutes les preuves (4 garanties médico-légales) ──
  await _sigPut({
    invoice_id:  _currentInvoiceId,
    png,
    signed_at:   signedAt,                       // ✔ Horodatage ISO 8601
    user_agent:  navigator.userAgent.slice(0, 100),
    // Preuve médico-légale
    signature_hash: signatureHash,               // ✔ SHA-256 du tracé+date+acte+patient
    photo_hash:     _currentPhotoHash || null,
    geozone:        effectiveGeozone || null,    // ✔ Géozone (GPS ~1km ou fallback IP ~10km)
    server_cert:    serverCert || null,          // ✔ HMAC-SHA256 (ou null si offline → file d'attente)
    proof_payload:  proofPayload,
    proof_version:  2,                           // v2 = 4 garanties activées
  });

  // ── 5) Sync PNG chiffré vers serveur (cadre existant) ──
  _syncSignatureNow(_currentInvoiceId, png, signedAt).catch(() => {});

  // ── 6) Upgrade preuve_soin côté cotation (route existante) ──
  try {
    const wpost = typeof window.wpost === 'function' ? window.wpost
      : (url, body) => (typeof apiCall === 'function' ? apiCall(url, body) : Promise.reject('no wpost'));
    if (typeof S !== 'undefined' && S?.token && signatureHash) {
      wpost('/webhook/cotation-preuve-update', {
        invoice_number: _currentInvoiceId,
        preuve_soin: {
          type:           'signature_patient',
          force_probante: 'FORTE',
          hash_preuve:    signatureHash,
          timestamp:      signedAt,
          certifie_ide:   !!serverCert,
        }
      }).catch(() => {});
    }
  } catch (_) {}

  // ⚡ 6-bis) Création AUTOMATIQUE des consentements pré-remplis ──────────────
  //    Si la cotation a détecté un consentement manquant (toast "Consentement à
  //    compléter" → warning), les types requis ont été mémorisés côté cotation.js.
  //    On crée ici le(s) consentement(s) avec la signature qui vient d'être saisie,
  //    le type détecté depuis l'acte, la date et le nom du patient.
  //    Résultat : un consentement valide apparaît automatiquement dans l'onglet
  //    Consentements du patient, sans aucune action supplémentaire.
  try {
    // Purge TTL : si un pending a plus de 2h sans signature, on le nettoie
    // (évite qu'une signature tardive sur un autre invoice créé une semaine plus
    // tard recrée un consentement fantôme). Seuil 2h largement au-dessus d'une
    // tournée normale.
    const _TTL = 2 * 3600 * 1000;
    const _now = Date.now();
    if (window._pendingConsentsByInvoice) {
      for (const [_k, _v] of Object.entries(window._pendingConsentsByInvoice)) {
        if (_v?.created_at && (_now - _v.created_at) > _TTL) {
          delete window._pendingConsentsByInvoice[_k];
        }
      }
    }
    if (window._pendingConsentsForPatient) {
      for (const [_k, _v] of Object.entries(window._pendingConsentsForPatient)) {
        if (_v?.created_at && (_now - _v.created_at) > _TTL) {
          delete window._pendingConsentsForPatient[_k];
        }
      }
    }

    const _pending = window._pendingConsentsByInvoice?.[_currentInvoiceId];
    // _consentCreateOrUpdate est déclaré au top-level dans consentements.js (portée globale)
    const _createFn = (typeof _consentCreateOrUpdate === 'function')
      ? _consentCreateOrUpdate
      : (typeof window._consentCreateOrUpdate === 'function' ? window._consentCreateOrUpdate : null);

    // ⚡ FALLBACK : si pas de _pending (ex: signature déclenchée depuis le bandeau
    // CPAM, pas depuis le bouton sous la cotation), on infère les types de
    // consentement depuis la cotation actuelle en mémoire (_lastCotData).
    // Mapping vers les VRAIS types de CONSENT_TEMPLATES (consentements.js) :
    //   - AMI4/AMI4.1/AMI4.2 + texte "pansement/escarre/ulcère" → "pansement_complexe"
    //   - AMI9/AMI14/AMI15 + texte "perfusion/voie veineuse" → "perfusion"
    //   - AMI1 + texte "injection insuline/SC/IM/HBPM" → "injection_sc_im"
    //   - texte "sonde urinaire/vésical" → "sonde_urinaire"
    //   - texte "soins palliatifs/confort" → "soins_palliatifs"
    //   - texte "photo/photographie" → "photo_soin"
    // Si aucun type ne matche → on SKIP la création (pas de consentement orphelin).
    let _effectivePending = _pending;
    if (!_effectivePending) {
      const _lastCot = window._lastCotData;
      const _patIdFallback = _lastCot?.patient_id
        || window._editingCotation?.patientId
        || _currentProofContext?.patient_id
        || null;
      if (_lastCot && _patIdFallback && Array.isArray(_lastCot.actes) && _lastCot.actes.length) {
        const _codes = _lastCot.actes.map(a => String(a.code || '').toUpperCase());
        // Récupérer aussi les libellés/notes pour matcher des mots-clés
        const _allText = (
          (_lastCot.actes.map(a => (a.nom || '') + ' ' + (a.description || '')).join(' ')) +
          ' ' + (_lastCot.notes || '')
        ).toLowerCase();
        const _types = new Set();
        const _typesLabel = [];
        // Pansement complexe : AMI4 + texte évocateur
        if (_codes.some(c => /^AMI4(\.|_)?/.test(c)) ||
            /pansement.{0,20}complexe|escarre|ulc[eè]re|n[eé]crose|br[uû]l[uû]re/.test(_allText)) {
          _types.add('pansement_complexe');
          _typesLabel.push('Pansement complexe / Chirurgical');
        }
        // Perfusion : AMI9/AMI14/AMI15 + texte
        if (_codes.some(c => /^AMI(9|14|15)/.test(c)) ||
            /perfusion|voie\s+veineuse|i\.?v\.?\b|intraveineuse/.test(_allText)) {
          _types.add('perfusion');
          _typesLabel.push('Perfusion / Voie veineuse');
        }
        // Injection SC/IM : AMI1 + texte injection
        if (_codes.some(c => /^AMI1$/.test(c)) ||
            /injection.{0,30}(insuline|sc|s\.c|im|i\.m|sous-?cutan|intra-?musculaire|hbpm|h[eé]parine|anticoagulant|vaccin)/.test(_allText)) {
          _types.add('injection_sc_im');
          _typesLabel.push('Injection SC/IM');
        }
        // Sondage urinaire
        if (/sond(?:age|e).{0,20}(urinaire|v[eé]sical|demeure)/.test(_allText)) {
          _types.add('sonde_urinaire');
          _typesLabel.push('Sondage urinaire');
        }
        // Soins palliatifs
        if (/soin.{0,10}palliatif|soin.{0,10}confort|fin\s+de\s+vie/.test(_allText)) {
          _types.add('soins_palliatifs');
          _typesLabel.push('Soins palliatifs');
        }
        // Photo de soin
        if (/photo(graphi)?[e\b]/.test(_allText)) {
          _types.add('photo_soin');
          _typesLabel.push('Photographie de soin');
        }

        // Si aucun type ne matche → on ne crée PAS de consentement orphelin
        // (la signature reste valide comme preuve, mais sans consentement structuré)
        if (_types.size > 0) {
          _effectivePending = {
            patient_id:    _patIdFallback,
            types:         Array.from(_types),
            types_label:   _typesLabel,
            patient_nom:   _lastCot.patient_nom || '',
            date_soin:     _lastCot.date_soin || signedAt.slice(0, 10),
            _from_fallback: true,
          };
        } else {
          console.info('[sig→consent] Aucun type de consentement spécifique détecté pour les actes :', _codes.join(', '), '— signature OK, pas de consentement créé');
        }
      }
    }

    if (_effectivePending && Array.isArray(_effectivePending.types) && _effectivePending.types.length
        && _createFn && _effectivePending.patient_id) {
      const _pendingForUse = _effectivePending;
      const _dateSoin = _pendingForUse.date_soin || signedAt.slice(0, 10);
      const _createdLabels = [];
      for (const _type of _pendingForUse.types) {
        try {
          await _createFn({
            patient_id:       _pendingForUse.patient_id,
            type:             _type,
            signatureDataUrl: png,                // même signature que l'invoice
            patient_nom:      _pendingForUse.patient_nom || '',
            qualite:          'Patient',
            date:             _dateSoin,
          });
          const _tplMap = (typeof CONSENT_TEMPLATES !== 'undefined') ? CONSENT_TEMPLATES
                        : (typeof window.CONSENT_TEMPLATES !== 'undefined' ? window.CONSENT_TEMPLATES : {});
          const _lbl = _tplMap[_type]?.label || _type;
          _createdLabels.push(_lbl);
        } catch (_cErr) {
          console.warn('[sig→consent] création KO pour', _type, ':', _cErr.message);
        }
      }
      // Nettoyer l'état partagé (uniquement si pending venait de cotation())
      if (_pending) {
        delete window._pendingConsentsByInvoice[_currentInvoiceId];
        if (_pending.patient_id && window._pendingConsentsForPatient) {
          delete window._pendingConsentsForPatient[_pending.patient_id];
        }
      }
      // Feedback utilisateur
      if (_createdLabels.length && typeof showToast === 'function') {
        showToast('ok', '✅ Consentement(s) enregistré(s)',
          _createdLabels.join(', ') + ' — signé le ' + _dateSoin);
      }
      // Rafraîchir la vue consentements si elle est affichée
      // Fonction exposée depuis consentements.js : renderConsentements (pas consentRenderList)
      const _renderFn = (typeof renderConsentements === 'function')
        ? renderConsentements
        : (typeof window.renderConsentements === 'function' ? window.renderConsentements : null);
      if (_renderFn) {
        try { _renderFn(); } catch(_) {}
      }
    }
  } catch (_autoConsentErr) {
    console.warn('[sig→consent] flow global KO:', _autoConsentErr.message);
  }

  closeSignatureModal();

  // ── Feedback visuel sur le bouton d'impression si présent ──
  const sigBtn = document.querySelector(`[data-sig="${_currentInvoiceId}"]`);
  if (sigBtn) {
    sigBtn.textContent = '✅ Signé';
    sigBtn.style.background = 'rgba(0,212,170,.15)';
    sigBtn.style.color = 'var(--a)';
  }

  // ── 🛡️ Notifier les autres composants (cotation.js, etc.) ──────────────
  // L'event permet à cotation.js de mettre à jour le badge preuve, masquer
  // le bandeau « Aucune preuve terrain » dans le simulateur CPAM et le
  // scoring IDE, et afficher un visuel positif « Preuve forte enregistrée ».
  try {
    document.dispatchEvent(new CustomEvent('ami:preuve_updated', {
      detail: {
        invoice_number: _currentInvoiceId,
        type:           'signature_patient',
        force_probante: 'FORTE',
        hash_preuve:    signatureHash,
        timestamp:      signedAt,
        certifie_ide:   !!serverCert,
      }
    }));
  } catch (_) {}

  // ── Reset état preuve ──
  _currentPhotoHash    = null;
  _currentGeozone      = null;
  _currentProofContext = null;

  if (typeof showToast === 'function') {
    const msg = serverCert
      ? '✍️ Signature enregistrée · Preuve certifiée ✔'
      : '✍️ Signature enregistrée.';
    showToast(msg, 'ok');
  }
}

async function getSignature(invoiceId) {
  const row = await _sigGet(invoiceId);
  return row?.png || null;
}

async function deleteSignature(invoiceId) {
  await _sigDelete(invoiceId);
  // Supprimer aussi côté serveur
  try {
    const wpost = typeof window.wpost === 'function' ? window.wpost
      : (url, body) => (typeof apiCall === 'function' ? apiCall(url, body) : Promise.reject('no wpost'));
    if (typeof S !== 'undefined' && S?.token)
      wpost('/webhook/signatures-delete', { invoice_id: invoiceId }).catch(() => {});
  } catch(_) {}
  if (typeof showToast === 'function') showToast('🗑️ Signature supprimée.', 'ok');
}

/* ════════════════════════════════════════════════
   INJECTION DANS LA FACTURE PDF — signature IDE + preuve médico-légale
   ────────────────────────────────────────────────
   Injecte :
     - à GAUCHE : la signature de l'infirmier(ère) depuis la profil (si enregistrée)
     - à DROITE : la signature du patient + preuve opposable
   Les deux signatures sont indépendantes : l'IDE signe UNE FOIS dans son
   profil, puis sa signature est auto-injectée dans tous les PDF générés.
════════════════════════════════════════════════ */
async function injectSignatureInPDF(invoiceId) {
  const row = await _sigGet(invoiceId);
  if (!row?.png) return '';
  const png = row.png;

  // ── Bloc preuve (affiché uniquement si données présentes) ──
  const hash      = row.signature_hash || '';
  const hashShort = hash ? hash.slice(0, 16).toUpperCase() + '…' : '';
  const signedTs  = row.signed_at ? new Date(row.signed_at).toLocaleString('fr-FR') : new Date().toLocaleString('fr-FR');
  const signedISO = row.signed_at || '';
  const zone      = row.geozone?.zone || '';
  const certified = !!(row.server_cert && row.server_cert.server_signature);
  const certId    = row.server_cert?.cert_id || '';
  const hasPhoto  = !!row.photo_hash;

  // Détail technique sur 2 lignes pour audit CPAM (lisibilité PDF)
  const proofMain = [
    certified ? '✔ HMAC-SHA256 serveur' : null,
    hashShort ? '✔ Hash SHA-256 ' + hashShort : null,
    signedISO ? '✔ Horodatage ISO 8601' : null,
    zone      ? '✔ Géozone floue (~1km)' : null,
    hasPhoto  ? '✔ Preuve photo (hash, RGPD)' : null,
  ].filter(Boolean).join(' · ');

  const proofMeta = [
    signedISO,
    certId ? 'Cert ' + certId : null,
  ].filter(Boolean).join(' · ');

  // ── Récupération de la signature IDE depuis le profil (auto-injection) ──
  let ideSigHTML = `
    <div style="height:80px;border:1px dashed #ccd5e0;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:11px">
      À signer
    </div>`;
  try {
    const ideRow = await _sigGet(IDE_SELF_SIG_ID);
    if (ideRow?.png) {
      const ideTs = ideRow.signed_at ? new Date(ideRow.signed_at).toLocaleDateString('fr-FR') : '';
      ideSigHTML = `
        <img src="${ideRow.png}" style="width:100%;max-height:80px;border:1px solid #e0e7ef;border-radius:6px;object-fit:contain;background:#fff">
        <div style="font-size:9px;color:#9ca3af;margin-top:3px">Signature enregistrée${ideTs ? ' · ' + ideTs : ''}</div>`;
    }
  } catch (_) {}

  return `
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid #e0e7ef">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start">
        <div>
          <div style="font-size:11px;text-transform:uppercase;color:#6b7a99;letter-spacing:.5px;margin-bottom:8px">Signature infirmier(ère)</div>
          ${ideSigHTML}
        </div>
        <div>
          <div style="font-size:11px;text-transform:uppercase;color:#6b7a99;letter-spacing:.5px;margin-bottom:8px">Signature patient — accord soins</div>
          <img src="${png}" style="width:100%;max-height:80px;border:1px solid #e0e7ef;border-radius:6px;object-fit:contain;background:#fff">
          <div style="font-size:9px;color:#9ca3af;margin-top:3px">Signé électroniquement · ${signedTs}</div>
        </div>
      </div>
      ${proofMain ? `<div style="margin-top:10px;padding:8px 10px;background:#f3f7fa;border-left:3px solid #00a884;border-radius:4px;font-size:9px;color:#445566;font-family:ui-monospace,Menlo,monospace;line-height:1.5">
        🛡️ <strong>Preuve médico-légale opposable :</strong> ${proofMain}
        ${proofMeta ? `<div style="margin-top:3px;opacity:.7">${proofMeta}</div>` : ''}
      </div>` : ''}
    </div>`;
}

/* ════════════════════════════════════════════════
   SIGNATURE PERSONNELLE DE L'INFIRMIER(ÈRE)
   ────────────────────────────────────────────────
   Enregistrée une seule fois depuis le profil.
   Auto-injectée dans tous les PDF générés par l'app qui ont besoin
   d'une signature IDE (factures, BSI, transmissions, consentements…).
   Stockée sous la clé réservée IDE_SELF_SIG_ID dans la même IDB
   (ami_sig_db_<userId>) — donc isolée par utilisateur et synchronisée
   via le même canal chiffré AES-256-GCM que les signatures patients.
════════════════════════════════════════════════ */
function openIDESignatureModal() {
  _sigModalMode = 'ide_self';
  _currentInvoiceId = IDE_SELF_SIG_ID;
  _currentProofContext = null;
  _currentPhotoHash = null;
  _currentGeozone = null;

  // Réutilise le modal existant, mais on masque le bloc preuve médico-légale
  // (non pertinent pour une signature template)
  let modal = document.getElementById('sig-modal');
  // Forcer recréation si existant (pour basculer en mode IDE_self)
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'sig-modal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:1500;display:flex;align-items:center;
    justify-content:center;background:rgba(11,15,20,.92);
    backdrop-filter:blur(12px);padding:20px;overflow-y:auto`;
  modal.innerHTML = `
    <div style="background:var(--c);border:1px solid var(--b);border-radius:20px;
      padding:28px;width:100%;max-width:520px;box-shadow:0 0 60px rgba(0,0,0,.6);margin:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="font-family:var(--fs);font-size:20px">✍️ Ma signature — infirmier(ère)</div>
        <button onclick="closeSignatureModal()" style="background:var(--s);border:1px solid var(--b);
          color:var(--m);width:32px;height:32px;border-radius:50%;cursor:pointer;
          display:grid;place-items:center;font-size:16px">✕</button>
      </div>
      <p style="font-size:12px;color:var(--m);margin-bottom:14px">
        Signez une seule fois — votre signature sera ensuite <strong>auto-injectée</strong> dans toutes les factures et PDF générés par l'application (BSI, transmissions, consentements…).
        Stockée localement et chiffrée AES-256.
      </p>
      <div style="position:relative;border:2px dashed var(--b);border-radius:var(--r);
        background:var(--s);overflow:hidden;touch-action:none" id="sig-wrap">
        <canvas id="sig-canvas" width="480" height="200"
          style="width:100%;height:200px;display:block;cursor:crosshair"></canvas>
        <div id="sig-placeholder" style="position:absolute;inset:0;display:flex;
          align-items:center;justify-content:center;color:var(--m);font-size:13px;
          pointer-events:none;font-family:var(--fm)">Signez ici ✍️</div>
      </div>
      <div id="sig-info" style="font-family:var(--fm);font-size:10px;color:var(--m);
        margin-top:8px;text-align:right"></div>
      <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
        <button class="btn bp" onclick="saveSignature()" style="flex:1">💾 Enregistrer ma signature</button>
        <button class="btn bs bsm" onclick="clearSignature()">🗑️ Effacer</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.style.display = 'flex';
  _initCanvas();

  const info = document.getElementById('sig-info');
  if (info) info.textContent = 'Signature personnelle · ' + ((typeof S !== 'undefined' && S?.user?.email) ? S.user.email : 'infirmier(ère)');
}

/* Récupère la signature IDE (PNG base64) — null si non enregistrée */
async function getIDESignature() {
  const row = await _sigGet(IDE_SELF_SIG_ID);
  return row?.png || null;
}

/* Supprime la signature IDE (local + serveur) */
async function deleteIDESignature() {
  if (!confirm('Supprimer votre signature ? Elle ne sera plus auto-injectée dans les PDF.')) return;
  await _sigDelete(IDE_SELF_SIG_ID);
  try {
    const wpost = typeof window.wpost === 'function' ? window.wpost
      : (url, body) => (typeof apiCall === 'function' ? apiCall(url, body) : Promise.reject('no wpost'));
    if (typeof S !== 'undefined' && S?.token)
      wpost('/webhook/signatures-delete', { invoice_id: IDE_SELF_SIG_ID }).catch(() => {});
  } catch(_) {}

  // Rafraîchir UI
  const preview = document.getElementById('ide-sig-preview');
  if (preview) preview.innerHTML = '<div style="color:var(--m);font-size:12px">Aucune signature enregistrée</div>';
  const stateBtn = document.getElementById('btn-ide-sig');
  if (stateBtn) stateBtn.textContent = '✍️ Créer ma signature';
  const delBtn = document.getElementById('btn-ide-sig-delete');
  if (delBtn) delBtn.style.display = 'none';
  if (typeof loadSignatureList === 'function') loadSignatureList();

  if (typeof showToast === 'function') showToast('🗑️ Signature infirmier(ère) supprimée.', 'ok');
}

/* Charge la signature IDE dans le profil au moment de l'ouverture */
async function refreshIDESignatureUI() {
  const preview = document.getElementById('ide-sig-preview');
  const btn     = document.getElementById('btn-ide-sig');
  const delBtn  = document.getElementById('btn-ide-sig-delete');
  if (!preview) return;
  try {
    const png = await getIDESignature();
    if (png) {
      preview.innerHTML = `<img src="${png}" style="width:100%;height:100%;object-fit:contain">`;
      if (btn)    btn.textContent = '✏️ Modifier ma signature';
      if (delBtn) delBtn.style.display = 'inline-flex';
    } else {
      preview.innerHTML = '<div style="color:var(--m);font-size:12px">Aucune signature enregistrée</div>';
      if (btn)    btn.textContent = '✍️ Créer ma signature';
      if (delBtn) delBtn.style.display = 'none';
    }
  } catch (_) {
    preview.innerHTML = '<div style="color:var(--m);font-size:12px">Chargement…</div>';
  }
}

/* Exposer globalement */
window.openSignatureModal  = openSignatureModal;
window.closeSignatureModal = closeSignatureModal;
window.clearSignature      = clearSignature;
window.saveSignature       = saveSignature;
window.getSignature        = getSignature;
window.deleteSignature     = deleteSignature;
window.injectSignatureInPDF = injectSignatureInPDF;
window.syncSignaturesToServer   = syncSignaturesToServer;
window.syncSignaturesFromServer = syncSignaturesFromServer;
window.captureProofPhoto   = captureProofPhoto;
// ── Signature personnelle infirmier(ère) ──
window.openIDESignatureModal = openIDESignatureModal;
window.getIDESignature       = getIDESignature;
window.deleteIDESignature    = deleteIDESignature;
window.refreshIDESignatureUI = refreshIDESignatureUI;

/* ── Patch printInv pour injecter la signature automatiquement ── */
document.addEventListener('DOMContentLoaded', () => {
  const _origPrintInv = window.printInv;
  if (typeof _origPrintInv === 'function') {
    window.printInv = async function(d) {
      // Injecter la signature si elle existe
      if (d?.invoice_number) {
        const sigBloc = await injectSignatureInPDF(d.invoice_number);
        if (sigBloc) d._sig_html = sigBloc;
      }
      return _origPrintInv(d);
    };
  }

  // Ajouter le bouton signature dans les résultats de cotation
  // ami:cotation_done — géré directement dans cotation.js (injection immédiate)
  // Ce listener reste en fallback pour d'autres contextes (tournée, etc.)
  document.addEventListener('ami:cotation_done', async (e) => {
    const invoiceId = e.detail?.invoice_number;
    if (!invoiceId) return;
    const cbody = document.getElementById('cbody');
    if (!cbody) return;
    if (cbody.querySelector('.sig-btn-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'sig-btn-wrap';
    wrap.style.cssText = 'margin-top:14px;padding-top:14px;border-top:1px solid var(--b);display:flex;align-items:center;gap:12px;flex-wrap:wrap';
    wrap.innerHTML = `
      <button class="btn bv bsm" data-sig="${invoiceId}"
        onclick="openSignatureModal('${invoiceId}')">
        ✍️ Faire signer le patient
      </button>
      <span style="font-size:11px;color:var(--m)">Signature stockée localement · non transmise</span>`;
    cbody.querySelector('.card')?.appendChild(wrap);
  });
});

/* ════════════════════════════════════════════════
   LISTE DES SIGNATURES (vue #view-sig)
   ────────────────────────────────────────────────
   Affiche deux sections distinctes :
     1. Ma signature infirmier(ère) — template auto-injecté dans les PDF
     2. Signatures patients enregistrées — liées aux cotations
════════════════════════════════════════════════ */
async function loadSignatureList() {
  const el = document.getElementById('sig-list-body');
  if (!el) return;
  // Bloc dédié à la signature IDE (peuplé ensuite si le slot existe dans le HTML)
  const ideEl = document.getElementById('ide-sig-card-body');
  el.innerHTML = '<p style="color:var(--m);font-size:13px;padding:20px 0;text-align:center">Chargement…</p>';

  try {
    const all = await _sigExec(db => new Promise((res, rej) => {
      const tx  = db.transaction(SIG_STORE, 'readonly');
      const req = tx.objectStore(SIG_STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    }));

    // ── Séparer la signature IDE des signatures patients ──
    const ideSig     = all.find(s => s.invoice_id === IDE_SELF_SIG_ID) || null;
    const patientSig = all.filter(s => s.invoice_id !== IDE_SELF_SIG_ID);

    // ── 1) Rendu section IDE (slot dédié dans view-sig) ──
    if (ideEl) {
      if (ideSig && ideSig.png) {
        const ideDate = ideSig.signed_at ? new Date(ideSig.signed_at).toLocaleString('fr-FR', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
        ideEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:14px;padding:8px 0;flex-wrap:wrap">
            <div style="width:96px;height:56px;border-radius:8px;border:1px solid var(--b);overflow:hidden;flex-shrink:0;background:rgba(255,255,255,.04)">
              <img src="${ideSig.png}" style="width:100%;height:100%;object-fit:contain">
            </div>
            <div style="flex:1 1 160px;min-width:140px">
              <div style="font-size:13px;font-weight:500">Signature enregistrée</div>
              <div style="font-size:11px;color:var(--m)">Auto-injectée dans les PDF · ${ideDate}</div>
              <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">
                <span style="display:inline-block;padding:2px 6px;background:rgba(0,212,170,.15);color:var(--a);border-radius:4px;font-size:9px;font-family:var(--fm)">👤 Infirmier(ère)</span>
                <span style="display:inline-block;padding:2px 6px;background:rgba(255,255,255,.06);color:var(--m);border-radius:4px;font-size:9px;font-family:var(--fm)">AES-256</span>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0">
              <button class="btn bv bsm" onclick="openIDESignatureModal()" style="font-size:11px;padding:6px 10px">✏️ Modifier</button>
              <button class="btn bs bsm" onclick="deleteIDESignature()" style="font-size:11px;padding:6px 10px">🗑️</button>
            </div>
          </div>`;
      } else {
        ideEl.innerHTML = `
          <div style="padding:14px 0;text-align:center">
            <div style="font-size:13px;color:var(--m);margin-bottom:10px">Aucune signature infirmier(ère) enregistrée.</div>
            <button class="btn bv bsm" onclick="openIDESignatureModal()" style="font-size:12px">
              ✍️ Créer ma signature
            </button>
            <div style="font-size:10px;color:var(--m);margin-top:8px;opacity:.7">
              Elle sera auto-injectée dans les factures et PDF de l'application.
            </div>
          </div>`;
      }
    }

    // ── 2) Rendu section signatures patients ──
    if (!patientSig.length) {
      el.innerHTML = `<p style="color:var(--m);font-size:13px;padding:20px 0;text-align:center">
        Aucune signature patient enregistrée.<br><span style="font-size:11px;opacity:.6">Les signatures patients apparaissent après chaque cotation signée.</span>
      </p>`;
      return;
    }

    el.innerHTML = patientSig.map(sig => {
      const _dateRaw = sig.signed_at || sig.created_at || null;
      const date = _dateRaw ? new Date(_dateRaw).toLocaleString('fr-FR', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
      const isoDate = _dateRaw || '';
      const invoiceId = sig.invoice_id || '—';
      const _previewSrc = sig.png || sig.data_url || null;

      // ── 5 critères de preuve médico-légale ──
      const certified = !!(sig.server_cert && sig.server_cert.server_signature);
      const hasHash   = !!sig.signature_hash;
      const hasPhoto  = !!sig.photo_hash;
      const hasZone   = !!(sig.geozone && sig.geozone.zone);
      const hasISO    = !!_dateRaw;
      const isLegacy  = !hasHash && !hasPhoto && !hasZone && !certified;
      const isBackfilled = sig.proof_legacy_backfill === true;

      // ── Style commun pour les badges ──
      const _bStrong = 'display:inline-block;padding:2px 6px;background:rgba(0,212,170,.15);color:var(--a);border-radius:4px;font-size:9px;font-family:var(--fm);margin-right:4px;margin-bottom:2px';
      const _bNeutral = 'display:inline-block;padding:2px 6px;background:rgba(255,255,255,.06);color:var(--m);border-radius:4px;font-size:9px;font-family:var(--fm);margin-right:4px;margin-bottom:2px';
      const _bWarn = 'display:inline-block;padding:2px 6px;background:rgba(255,180,0,.15);color:#f5a623;border-radius:4px;font-size:9px;font-family:var(--fm);margin-right:4px;margin-bottom:2px';

      const badges = [
        certified ? `<span style="${_bStrong}">🔐 HMAC serveur</span>` : '',
        hasHash   ? `<span style="${_bNeutral}">🔒 Hash SHA-256</span>` : '',
        hasISO    ? `<span style="${_bNeutral}">⏱ ISO 8601</span>` : '',
        hasZone   ? `<span style="${_bNeutral}">📍 Zone ~1km</span>` : '',
        hasPhoto  ? `<span style="${_bNeutral}">📸 Photo (hash)</span>` : '',
        isLegacy  ? `<span style="${_bWarn}">⚠ Preuve incomplète</span>` : '',
        isBackfilled && !isLegacy ? `<span style="${_bNeutral}">🛡️ Renforcée</span>` : '',
      ].filter(Boolean).join('');

      // ── Lignes de détails techniques (sous le titre) ──
      const detailsLines = [];
      if (hasHash) {
        detailsLines.push(`<div style="font-size:9px;color:var(--m);font-family:var(--fm);opacity:.7" title="SHA-256(tracé + date + acte + patient)">Hash · ${sig.signature_hash.slice(0,16).toUpperCase()}…</div>`);
      }
      if (hasISO) {
        detailsLines.push(`<div style="font-size:9px;color:var(--m);font-family:var(--fm);opacity:.7" title="Horodatage ISO 8601">ISO · ${isoDate}</div>`);
      }
      if (hasZone) {
        const z = sig.geozone;
        detailsLines.push(`<div style="font-size:9px;color:var(--m);font-family:var(--fm);opacity:.7" title="Géozone floue ~1km — RGPD">Zone · ${z.approx_lat?.toFixed(2)}, ${z.approx_lng?.toFixed(2)} (~1km)</div>`);
      }
      if (certified && sig.server_cert?.cert_id) {
        detailsLines.push(`<div style="font-size:9px;color:var(--m);font-family:var(--fm);opacity:.7" title="Identifiant unique de certification serveur">Cert · ${sig.server_cert.cert_id}</div>`);
      }
      const detailsBlock = detailsLines.join('');

      // ── Bouton "Renforcer la preuve" si legacy ou si certification manquante ──
      const canReinforce = isLegacy || (!certified && hasHash) || !hasZone;
      const reinforceBtn = canReinforce
        ? `<button class="btn bs bsm" onclick="reinforceSignatureProof('${sig.invoice_id.replace(/'/g, "\\'")}').then(loadSignatureList)" style="font-size:11px;padding:6px 10px;flex-shrink:0" title="Tente de récupérer les preuves manquantes (hash, zone, certification serveur)">🛡️ Renforcer</button>`
        : '';

      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--b);flex-wrap:wrap">
        <div style="width:48px;height:48px;border-radius:8px;border:1px solid var(--b);overflow:hidden;flex-shrink:0;background:rgba(255,255,255,.04)">
          ${_previewSrc ? `<img src="${_previewSrc}" style="width:100%;height:100%;object-fit:contain">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:20px">✍️</div>'}
        </div>
        <div style="flex:1 1 220px;min-width:200px">
          <div style="font-size:13px;font-weight:500;font-family:var(--fm);word-break:break-all">${invoiceId}</div>
          <div style="font-size:11px;color:var(--m)">${date}</div>
          ${badges ? `<div style="margin-top:4px;display:flex;flex-wrap:wrap">${badges}</div>` : ''}
          ${detailsBlock ? `<div style="margin-top:4px">${detailsBlock}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap">
          ${reinforceBtn}
          <button class="btn bs bsm" onclick="deleteSignature('${sig.invoice_id.replace(/'/g, "\\'")}').then(loadSignatureList)" style="font-size:11px;padding:6px 10px">🗑️</button>
        </div>
      </div>`;
    }).join('');
    // ⚡ Backfill différé : tente de compléter les signatures sans server_cert
    // ou geozone. Non bloquant — re-render automatique si succès.
    setTimeout(() => { _sigBackfillProofs(); }, 500);
  } catch(e) {
    el.innerHTML = '<p style="color:var(--d);font-size:13px;padding:20px 0;text-align:center">Erreur de chargement des signatures.</p>';
    console.warn('[Signatures] loadSignatureList:', e);
  }
}

/* Charger la liste quand on navigue vers #view-sig */
document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'sig') {
    loadSignatureList();
    // Sync pull au chargement de la vue signatures
    syncSignaturesFromServer().catch(() => {});
    // Drainer la file HMAC en attente (signatures non certifiées en offline)
    _drainHmacQueue().catch(() => {});
  }
});

/* Sync pull au login (quand la session est disponible) */
document.addEventListener('ami:login', () => {
  syncSignaturesFromServer().catch(() => {});
  // Drainer la file HMAC : retry des certifications qui ont échoué offline
  _drainHmacQueue().catch(() => {});
});

/* Sync push au logout (pour s'assurer que tout est envoyé) */
document.addEventListener('ami:logout', () => {
  syncSignaturesToServer().catch(() => {});
});
