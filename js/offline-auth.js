/* ════════════════════════════════════════════════
   offline-auth.js — AMI NGAP v1.0
   ────────────────────────────────────────────────
   Connexion hors-ligne sécurisée par PIN.
   
   Architecture cryptographique :
   - Le token de session est CHIFFRÉ (AES-GCM 256) par une clé
     dérivée du PIN via PBKDF2 (100 000 itérations + sel 16 octets).
   - Sans le PIN, le localStorage ne contient RIEN d'exploitable.
   - PIN bloqué 5 min après 5 essais ratés.
   - Expiration absolue : 7 jours sans validation serveur → re-login obligatoire.
   
   Workflow :
   1. 1er login en ligne → modale création PIN obligatoire
   2. Login en ligne avec PIN existant → refresh transparent du token chiffré
   3. Boot hors-ligne + session expirée → écran déverrouillage PIN
   4. Retour en ligne → /webhook/session-refresh pour valider le token
   
   Exposé sur window.offlineAuth (voir bas du fichier).
════════════════════════════════════════════════ */

(function() {
  'use strict';

  const LS_PREFIX_AUTH    = 'ami_off_auth_';    // + userId
  const LS_PREFIX_PIN     = 'ami_off_pin_';     // + userId (méta : compteur, lock)
  const LS_LAST_USER      = 'ami_off_last_user';
  const OFFLINE_MAX_MS    = 7 * 24 * 60 * 60 * 1000;  // 7 jours
  const PIN_MAX_ATTEMPTS  = 5;
  const PIN_LOCK_MS       = 5 * 60 * 1000;            // 5 min
  const PBKDF2_ITERATIONS = 100000;

  // ══ UTILITAIRES BINAIRES ══
  const _b64 = {
    encode(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); },
    decode(str) {
      const bin = atob(str);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr.buffer;
    },
  };
  const _randBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

  // ══ CRYPTO PRIMITIVES ══
  async function deriveKeyFromPIN(pin, salt) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptWithPIN(plaintext, pin) {
    const salt = _randBytes(16);
    const iv   = _randBytes(12);
    const key  = await deriveKeyFromPIN(pin, salt);
    const enc  = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, enc.encode(plaintext)
    );
    return {
      ct:   _b64.encode(ciphertext),
      iv:   _b64.encode(iv),
      salt: _b64.encode(salt),
    };
  }

  async function decryptWithPIN(payload, pin) {
    const salt = new Uint8Array(_b64.decode(payload.salt));
    const iv   = new Uint8Array(_b64.decode(payload.iv));
    const ct   = _b64.decode(payload.ct);
    const key  = await deriveKeyFromPIN(pin, salt);
    const dec  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(dec);
  }

  // ══ STOCKAGE LOCALSTORAGE ══
  function _getAuthRecord(userId) {
    try {
      const raw = localStorage.getItem(LS_PREFIX_AUTH + userId);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function _setAuthRecord(userId, record) {
    try { localStorage.setItem(LS_PREFIX_AUTH + userId, JSON.stringify(record)); } catch {}
  }
  function _clearAuthRecord(userId) {
    try { localStorage.removeItem(LS_PREFIX_AUTH + userId); } catch {}
  }

  function _getPinMeta(userId) {
    try {
      const raw = localStorage.getItem(LS_PREFIX_PIN + userId);
      return raw ? JSON.parse(raw) : { attempts: 0, locked_until: 0 };
    } catch { return { attempts: 0, locked_until: 0 }; }
  }
  function _setPinMeta(userId, meta) {
    try { localStorage.setItem(LS_PREFIX_PIN + userId, JSON.stringify(meta)); } catch {}
  }

  // ══ API PUBLIQUE ══

  /**
   * Enregistre les credentials pour un login offline futur.
   * Appelé après un login en ligne réussi et après création du PIN.
   *
   * @param {Object} user   — { id, email, nom, prenom }
   * @param {string} token  — token session renvoyé par /webhook/auth-login
   * @param {string} role   — 'nurse' | 'admin'
   * @param {string} pin    — PIN en clair (utilisé pour chiffrer le token, non stocké)
   */
  async function saveCredentials(user, token, role, pin) {
    if (!user?.id || !token || !pin) throw new Error('Paramètres invalides');
    const encrypted = await encryptWithPIN(token, pin);
    const record = {
      user_id:           String(user.id),
      email:             String(user.email || ''),
      nom:               String(user.nom || ''),
      prenom:            String(user.prenom || ''),
      role:              String(role || 'nurse'),
      token_enc:         encrypted,
      last_online_check: Date.now(),
      expires_at:        Date.now() + OFFLINE_MAX_MS,
      created_at:        Date.now(),
    };
    _setAuthRecord(user.id, record);
    try { localStorage.setItem(LS_LAST_USER, String(user.id)); } catch {}
  }

  /**
   * Rafraîchit last_online_check (appelé après validation serveur online).
   * Le token lui-même ne change pas, on pousse juste l'expiration.
   */
  function touchLastOnlineCheck(userId) {
    const rec = _getAuthRecord(userId);
    if (!rec) return;
    rec.last_online_check = Date.now();
    rec.expires_at        = Date.now() + OFFLINE_MAX_MS;
    _setAuthRecord(userId, rec);
  }

  /** Retourne true si un PIN a été configuré pour ce user (détecté via présence d'un record auth chiffré) */
  function hasPIN(userId) {
    const rec = _getAuthRecord(userId);
    return !!(rec && rec.token_enc);
  }

  /**
   * Tente de restaurer la session offline pour un user donné avec son PIN.
   * @returns {Object|null} — { token, role, user } si OK, null sinon
   * @throws Error avec message utilisateur si PIN faux / bloqué / expiré
   */
  async function unlockWithPIN(userId, pin) {
    const rec = _getAuthRecord(userId);
    if (!rec) throw new Error('Aucune session offline enregistrée.');
    if (Date.now() > rec.expires_at) {
      throw new Error('Session offline expirée — reconnectez-vous en ligne.');
    }
    const meta = _getPinMeta(userId);
    if (meta.locked_until && Date.now() < meta.locked_until) {
      const mins = Math.ceil((meta.locked_until - Date.now()) / 60000);
      throw new Error(`Trop de tentatives — réessayez dans ${mins} min.`);
    }
    let token;
    try {
      token = await decryptWithPIN(rec.token_enc, pin);
    } catch (e) {
      // Mauvais PIN : incrémenter compteur
      meta.attempts = (meta.attempts || 0) + 1;
      if (meta.attempts >= PIN_MAX_ATTEMPTS) {
        meta.locked_until = Date.now() + PIN_LOCK_MS;
        meta.attempts = 0;
        _setPinMeta(userId, meta);
        throw new Error(`PIN incorrect — compte bloqué ${Math.ceil(PIN_LOCK_MS/60000)} min.`);
      }
      _setPinMeta(userId, meta);
      const remaining = PIN_MAX_ATTEMPTS - meta.attempts;
      throw new Error(`PIN incorrect — ${remaining} essai${remaining > 1 ? 's' : ''} restant${remaining > 1 ? 's' : ''}.`);
    }
    // Succès : reset compteur
    _setPinMeta(userId, { attempts: 0, locked_until: 0 });
    return {
      token,
      role: rec.role,
      user: {
        id:     rec.user_id,
        email:  rec.email,
        nom:    rec.nom,
        prenom: rec.prenom,
      },
    };
  }

  /** Efface complètement les credentials offline (déclenché par logout volontaire) */
  function clearForUser(userId) {
    _clearAuthRecord(userId);
    try { localStorage.removeItem(LS_PREFIX_PIN + userId); } catch {}
    try {
      if (localStorage.getItem(LS_LAST_USER) === String(userId)) {
        localStorage.removeItem(LS_LAST_USER);
      }
    } catch {}
  }

  /** Renvoie l'ID du dernier user qui s'est connecté (offline restore) */
  function getLastUserId() {
    try { return localStorage.getItem(LS_LAST_USER) || null; }
    catch { return null; }
  }

  /** Infos publiques du dernier user (pour afficher son nom sur l'écran PIN) */
  function getLastUserInfo() {
    const id = getLastUserId();
    if (!id) return null;
    const rec = _getAuthRecord(id);
    if (!rec) return null;
    return {
      id:                rec.user_id,
      email:             rec.email,
      nom:               rec.nom,
      prenom:            rec.prenom,
      role:              rec.role,
      expires_at:        rec.expires_at,
      last_online_check: rec.last_online_check,
      session_valid:     Date.now() <= rec.expires_at,
    };
  }

  // ══ MODALES UI ══

  function _injectStyles() {
    if (document.getElementById('offline-auth-styles')) return;
    const st = document.createElement('style');
    st.id = 'offline-auth-styles';
    st.textContent = `
      .oa-overlay{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.88);
        display:flex;align-items:center;justify-content:center;padding:20px;
        backdrop-filter:blur(12px);animation:oaFade .25s ease-out}
      @keyframes oaFade{from{opacity:0}to{opacity:1}}
      .oa-box{background:#161b22;border:1px solid #30363d;border-radius:14px;
        padding:28px 24px;max-width:380px;width:100%;color:#e6edf3;
        box-shadow:0 20px 60px rgba(0,0,0,.5);font-family:system-ui,-apple-system,sans-serif}
      .oa-icon{font-size:42px;text-align:center;margin-bottom:10px}
      .oa-title{font-size:18px;font-weight:700;text-align:center;margin-bottom:6px}
      .oa-sub{font-size:13px;text-align:center;color:#8b949e;margin-bottom:18px;line-height:1.5}
      .oa-user{background:rgba(0,212,170,.08);border:1px solid rgba(0,212,170,.2);
        border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:13px;text-align:center}
      .oa-user b{color:#00d4aa}
      .oa-input{width:100%;padding:14px;font-size:20px;text-align:center;
        background:#0d1117;border:2px solid #30363d;border-radius:10px;color:#e6edf3;
        letter-spacing:8px;font-family:monospace;outline:none;transition:border .2s;
        box-sizing:border-box}
      .oa-input:focus{border-color:#00d4aa}
      .oa-input.err{border-color:#ff5f6d;animation:oaShake .3s}
      @keyframes oaShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}
      .oa-err{color:#ff5f6d;font-size:12px;text-align:center;margin-top:8px;min-height:16px}
      .oa-btn{width:100%;padding:13px;font-size:14px;font-weight:600;
        background:linear-gradient(135deg,#00d4aa,#00b891);color:#000;border:none;
        border-radius:10px;cursor:pointer;margin-top:14px;transition:transform .1s}
      .oa-btn:hover{transform:translateY(-1px)}
      .oa-btn:disabled{opacity:.5;cursor:not-allowed}
      .oa-btn.sec{background:transparent;color:#8b949e;border:1px solid #30363d;margin-top:8px}
      .oa-badge{position:fixed;top:0;left:0;right:0;z-index:9998;
        background:linear-gradient(90deg,#f59e0b,#d97706);color:#000;
        text-align:center;padding:6px 14px;font-size:12px;font-weight:600;
        font-family:system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)}
    `;
    document.head.appendChild(st);
  }

  /**
   * Modale "Créer votre PIN" — affichée au 1er login en ligne.
   * @param {string} pin — callback appelé avec le PIN saisi (après confirmation)
   */
  function showPinCreationModal() {
    return new Promise((resolve) => {
      _injectStyles();
      const ov = document.createElement('div');
      ov.className = 'oa-overlay';
      ov.innerHTML = `
        <div class="oa-box" role="dialog" aria-labelledby="oa-pin-title">
          <div class="oa-icon">🔐</div>
          <div class="oa-title" id="oa-pin-title">Créer votre code PIN</div>
          <div class="oa-sub">
            Ce code vous permettra d'accéder à l'application <strong>hors-ligne</strong>
            et de la déverrouiller après 10 min d'inactivité.<br><br>
            Minimum 4 chiffres. À garder confidentiel.
          </div>
          <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8"
                 class="oa-input" id="oa-pin-new" placeholder="••••" autocomplete="new-password">
          <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8"
                 class="oa-input" id="oa-pin-confirm" placeholder="Confirmer"
                 autocomplete="new-password" style="margin-top:10px">
          <div class="oa-err" id="oa-pin-err"></div>
          <button class="oa-btn" id="oa-pin-ok">✅ Activer le PIN</button>
        </div>
      `;
      document.body.appendChild(ov);

      const inp1 = ov.querySelector('#oa-pin-new');
      const inp2 = ov.querySelector('#oa-pin-confirm');
      const err  = ov.querySelector('#oa-pin-err');
      const btn  = ov.querySelector('#oa-pin-ok');

      setTimeout(() => inp1.focus(), 100);
      inp1.addEventListener('keypress', e => { if (e.key === 'Enter') inp2.focus(); });
      inp2.addEventListener('keypress', e => { if (e.key === 'Enter') btn.click(); });

      btn.addEventListener('click', () => {
        const p1 = inp1.value.trim();
        const p2 = inp2.value.trim();
        err.textContent = '';
        if (p1.length < 4)        { err.textContent = 'Minimum 4 chiffres.'; inp1.classList.add('err'); return; }
        if (!/^\d+$/.test(p1))    { err.textContent = 'Chiffres uniquement.'; inp1.classList.add('err'); return; }
        if (p1 !== p2)            { err.textContent = 'Les deux PIN ne correspondent pas.'; inp2.classList.add('err'); return; }
        // PIN trop simple
        if (/^(\d)\1+$/.test(p1)) { err.textContent = 'PIN trop simple (chiffres identiques).'; inp1.classList.add('err'); return; }
        if (p1 === '1234' || p1 === '0000' || p1 === '1111') {
          err.textContent = 'PIN trop courant — choisissez autre chose.'; inp1.classList.add('err'); return;
        }
        ov.remove();
        resolve(p1);
      });
    });
  }

  /**
   * Écran plein écran de déverrouillage PIN — affiché au boot offline.
   * @returns {Promise<Object|null>} résolu avec {token, role, user} ou null si cancel
   */
  function showUnlockScreen() {
    return new Promise((resolve) => {
      _injectStyles();
      const info = getLastUserInfo();
      if (!info || !info.session_valid) { resolve(null); return; }

      const ov = document.createElement('div');
      ov.className = 'oa-overlay';
      const daysLeft = Math.max(0, Math.floor((info.expires_at - Date.now()) / 86400000));
      const displayName = (info.prenom + ' ' + info.nom).trim() || info.email;
      ov.innerHTML = `
        <div class="oa-box" role="dialog" aria-labelledby="oa-unlock-title">
          <div class="oa-icon">📡</div>
          <div class="oa-title" id="oa-unlock-title">Mode hors-ligne</div>
          <div class="oa-sub">
            Vous n'êtes pas connecté à internet.<br>
            Saisissez votre PIN pour accéder à l'application en mode local.
          </div>
          <div class="oa-user">
            Connecté en tant que <b>${_esc(displayName)}</b><br>
            <span style="font-size:11px;color:#8b949e">Session valide ${daysLeft} jour${daysLeft>1?'s':''} offline</span>
          </div>
          <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8"
                 class="oa-input" id="oa-unlock-pin" placeholder="••••" autocomplete="current-password">
          <div class="oa-err" id="oa-unlock-err"></div>
          <button class="oa-btn" id="oa-unlock-ok">🔓 Déverrouiller</button>
          <button class="oa-btn sec" id="oa-unlock-switch">Utiliser un autre compte</button>
        </div>
      `;
      document.body.appendChild(ov);

      const inp    = ov.querySelector('#oa-unlock-pin');
      const err    = ov.querySelector('#oa-unlock-err');
      const btn    = ov.querySelector('#oa-unlock-ok');
      const btnAlt = ov.querySelector('#oa-unlock-switch');

      setTimeout(() => inp.focus(), 100);
      inp.addEventListener('keypress', e => { if (e.key === 'Enter') btn.click(); });

      btn.addEventListener('click', async () => {
        const pin = inp.value.trim();
        err.textContent = '';
        inp.classList.remove('err');
        if (!pin) { err.textContent = 'Saisissez votre PIN.'; inp.classList.add('err'); return; }
        btn.disabled = true;
        try {
          const sess = await unlockWithPIN(info.id, pin);
          ov.remove();
          resolve(sess);
        } catch (e) {
          err.textContent = '⚠️ ' + e.message;
          inp.classList.add('err');
          inp.value = '';
          btn.disabled = false;
          setTimeout(() => inp.focus(), 300);
        }
      });

      btnAlt.addEventListener('click', () => {
        ov.remove();
        resolve(null); // fallback login classique
      });
    });
  }

  function _esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ══ BANNIÈRE OFFLINE ══

  function showOfflineBadge() {
    _injectStyles();
    let el = document.getElementById('oa-offline-badge');
    if (el) return;
    el = document.createElement('div');
    el.id = 'oa-offline-badge';
    el.className = 'oa-badge';
    el.textContent = '📡 MODE HORS-LIGNE — Synchronisation différée à la reconnexion';
    document.body.appendChild(el);
    // Décale le contenu de 26px pour ne pas chevaucher le header
    document.body.style.paddingTop = (parseInt(document.body.style.paddingTop) || 0) + 26 + 'px';
  }

  function hideOfflineBadge() {
    const el = document.getElementById('oa-offline-badge');
    if (el) {
      el.remove();
      const pt = parseInt(document.body.style.paddingTop) || 0;
      document.body.style.paddingTop = Math.max(0, pt - 26) + 'px';
    }
  }

  // ══ HANDLER RETOUR EN LIGNE ══

  let _onlineHandlerInstalled = false;

  /**
   * Installe un listener 'online' qui tente un refresh silencieux du token.
   * Si le token n'est plus valide → alerte + logout.
   */
  function installOnlineRefresh(wpostFn) {
    if (_onlineHandlerInstalled) return;
    _onlineHandlerInstalled = true;

    const refresh = async () => {
      // Ne rien faire si session n'est pas en mode offline-restored
      if (!window.APP || !window.APP._offlineRestored) return;
      if (!window.APP.user?.id) return;
      try {
        const d = await wpostFn('/webhook/session-refresh', {});
        if (!d?.ok) throw new Error(d?.error || 'Session invalide');
        // Token toujours OK → rafraîchir last_online_check
        touchLastOnlineCheck(window.APP.user.id);
        window.APP._offlineRestored = false;
        hideOfflineBadge();
        if (typeof showToast === 'function') showToast('✅ Reconnexion — session validée.', 'ok');
      } catch (e) {
        // Token expiré côté serveur → logout propre
        console.warn('[offline-auth] session-refresh KO:', e.message);
        if (typeof showToast === 'function') {
          showToast('⚠️ Session expirée — veuillez vous reconnecter.', 'err');
        }
        setTimeout(() => {
          if (typeof logout === 'function') logout();
          else window.location.reload();
        }, 1500);
      }
    };

    window.addEventListener('online', refresh);
    // Check initial au cas où on boot déjà online après un restore offline
    setTimeout(() => { if (navigator.onLine) refresh(); }, 2000);
  }

  // ══ EXPORT ══
  window.offlineAuth = {
    saveCredentials,
    touchLastOnlineCheck,
    hasPIN,
    unlockWithPIN,
    clearForUser,
    getLastUserId,
    getLastUserInfo,
    showPinCreationModal,
    showUnlockScreen,
    showOfflineBadge,
    hideOfflineBadge,
    installOnlineRefresh,
    // Diagnostic
    _debug: {
      getAuthRecord: _getAuthRecord,
      getPinMeta:    _getPinMeta,
      OFFLINE_MAX_MS,
      PIN_MAX_ATTEMPTS,
    },
  };
})();
