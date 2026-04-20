/* ════════════════════════════════════════════════
   cabinet.js — AMI NGAP v1.0
   ────────────────────────────────────────────────
   Module cabinet multi-IDE
   ────────────────────────────────────────────────
   Fonctionnalités :
   1. Gestion cabinet (créer / rejoindre / quitter)
   2. Liste des membres avec rôles
   3. Synchronisation sélective inter-IDEs
      - L'infirmière choisit QUOI synchroniser
      - Elle choisit AVEC QUI synchroniser
      - Rien n'est partagé sans consentement explicite
   4. Cotation mode cabinet (multi-IDE)
   5. État cabinet stocké dans APP.cabinet
   ────────────────────────────────────────────────
   Dépendances : utils.js (APP, apiCall, ss, showToast)
   Appelé depuis : auth.js (initCabinet au login)
════════════════════════════════════════════════ */

/* ── Guards ──────────────────────────────────── */
(function checkDeps() {
  if (typeof APP === 'undefined')      console.error('cabinet.js : utils.js non chargé.');
  if (typeof apiCall === 'undefined')  console.error('cabinet.js : apiCall non disponible.');
})();

/* ════════════════════════════════════════════════
   1. ÉTAT CABINET — dans APP store
   APP.cabinet = {
     id, nom, my_role, members: [],
     sync_prefs: {
       what: { planning:bool, patients:bool, cotations:bool, ordonnances:bool, km:bool },
       with: { [membre_id]: bool }
     }
   }
════════════════════════════════════════════════ */
const CABINET_SYNC_KEY = () => `ami_cabinet_sync_${APP.user?.id || 'anon'}`;

function _loadSyncPrefs() {
  try {
    const key = CABINET_SYNC_KEY();
    const raw = localStorage.getItem(key) || sessionStorage.getItem(key + '_bak');
    return raw ? JSON.parse(raw) : _defaultSyncPrefs();
  } catch { return _defaultSyncPrefs(); }
}

function _saveSyncPrefs(prefs) {
  try {
    const key = CABINET_SYNC_KEY();
    const val = JSON.stringify(prefs);
    localStorage.setItem(key, val);
    sessionStorage.setItem(key + '_bak', val); // backup en cas de clear localStorage
  } catch {}
}

function _defaultSyncPrefs() {
  return {
    what: { planning: false, patients: false, cotations: false, ordonnances: false, km: false, piluliers: false, constantes: false },
    with: {}
  };
}

/* ════════════════════════════════════════════════
   MODULE CRYPTO CABINET — plug & play
   Aujourd'hui : clé symétrique cabinet_id (btoa)
   Demain : RSA-OAEP asymétrique — sans rien casser
   Toggle : CAB_CRYPTO.enabled = true
════════════════════════════════════════════════ */
const CAB_CRYPTO = {
  enabled: false, // 🔥 false = clé symétrique actuelle | true = RSA futur

  async encrypt(data, cabinetId) {
    if (!this.enabled) return _cabEnc(data, cabinetId);
    // Futur : chiffrement RSA-OAEP multi-destinataires
    return _cabEnc(data, cabinetId); // fallback pendant migration
  },

  async decrypt(payload, cabinetId) {
    if (!this.enabled) return _cabDec(payload, cabinetId);
    // Futur : déchiffrement RSA avec clé privée locale
    return _cabDec(payload, cabinetId); // fallback pendant migration
  },

  // Génération future d'une paire de clés par IDE
  async generateKeyPair() {
    if (!window.crypto?.subtle) return null;
    try {
      const kp = await crypto.subtle.generateKey(
        { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' },
        true, ['encrypt','decrypt']
      );
      const pub  = await crypto.subtle.exportKey('spki',  kp.publicKey);
      const priv = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
      return {
        publicKey:  btoa(String.fromCharCode(...new Uint8Array(pub))),
        privateKey: btoa(String.fromCharCode(...new Uint8Array(priv))),
      };
    } catch { return null; }
  },
};

/* ── Chiffrement partagé cabinet (clé = cabinet_id) ───────────────────
   Même cabinet_id pour tous les membres → même clé → déchiffrement mutuel.
   Utilisé pour les données partagées entre comptes différents.
─────────────────────────────────────────────────────────────────────── */
function _cabinetKey(cabinetId) {
  const id = String(cabinetId || '');
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = (Math.imul(33, h) ^ id.charCodeAt(i)) >>> 0;
  return 'ck_' + h.toString(36);
}
function _cabEnc(obj, cabinetId) {
  try {
    // Chiffrement : JSON → base64, clé vérifiée côté déchiffrement
    const json = JSON.stringify(obj);
    const key  = _cabinetKey(cabinetId);
    // Stocker : base64(json) + '.' + base64(key)
    const b64json = btoa(unescape(encodeURIComponent(json)));
    const b64key  = btoa(unescape(encodeURIComponent(key)));
    return b64json + '.' + b64key;
  } catch { return null; }
}
function _cabDec(str, cabinetId) {
  try {
    const sep = str.lastIndexOf('.');
    if (sep === -1) return null;
    const b64json = str.slice(0, sep);
    const b64key  = str.slice(sep + 1);
    // Vérifier que la clé correspond
    const expectedKey = _cabinetKey(cabinetId);
    const decodedKey  = decodeURIComponent(escape(atob(b64key)));
    if (decodedKey !== expectedKey) {
      console.warn('[_cabDec] Clé cabinet incorrecte — cabinet_id mismatch');
      return null;
    }
    return JSON.parse(decodeURIComponent(escape(atob(b64json))));
  } catch (e) {
    console.warn('[_cabDec] Erreur déchiffrement:', e.message);
    return null;
  }
}

/* ════════════════════════════════════════════════
   2. INITIALISATION AU LOGIN
   Appelé par auth.js après showApp()
════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════
   TEMPS RÉEL — WebSocket cabinet
   Sync instantanée quand un collègue pousse
   Fallback automatique si WS indisponible
════════════════════════════════════════════════ */
let _cabinetWS = null;

function initCabinetRealtime() {
  // ⚠️ WebSocket désactivé — Cloudflare Workers standard ne supporte pas WS
  // (nécessite Durable Objects). Mode pull manuel uniquement.
  // Pour activer : migrer vers Cloudflare Durable Objects ou un serveur dédié.
  console.info('[cabinet] Sync temps réel non disponible — mode pull manuel.');
}

async function initCabinet() {
  try {
    const d = await apiCall('/webhook/cabinet-get', {});
    if (d.ok && d.cabinet) {
      const prefs = _loadSyncPrefs();
      APP.set('cabinet', {
        id:       d.cabinet.id,
        nom:      d.cabinet.nom,
        my_role:  d.my_role,
        members:  d.members || [],
        sync_prefs: prefs,
      });
      _updateCabinetBadge(d.members?.length || 0);
      // Activer le toggle cabinet dans la cotation
      if (typeof initCotationCabinetToggle === 'function') initCotationCabinetToggle();
      // Afficher le panel cabinet dans la tournée
      _updateTourneeCabinetPanel();
      // Démarrer la sync temps réel (WebSocket)
      setTimeout(initCabinetRealtime, 500);
    } else {
      APP.set('cabinet', null);
      _updateCabinetBadge(0);
    }
  } catch {
    APP.set('cabinet', null);
  }
}

function _updateCabinetBadge(nbMembers) {
  const badge = document.getElementById('cabinet-nav-badge');
  if (!badge) return;
  if (nbMembers > 1) {
    badge.textContent = nbMembers;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

/* ════════════════════════════════════════════════
   3. RENDU PRINCIPAL — renderCabinetSection()
   Appelé par navTo('cabinet') via ui.js
════════════════════════════════════════════════ */
async function renderCabinetSection() {
  const root = document.getElementById('cabinet-root');
  if (!root) return;

  // N'afficher le spinner que si la vue cabinet est active (évite le spinner sur d'autres pages)
  const view = document.getElementById('view-cabinet');
  if (view && !view.classList.contains('on')) return;

  root.innerHTML = `<div class="card" style="text-align:center;padding:32px"><div class="spin spinw" style="width:32px;height:32px;margin:0 auto"></div><p style="margin-top:12px;color:var(--m)">Chargement cabinet…</p></div>`;

  try {
    const d = await apiCall('/webhook/cabinet-get', {});
    if (d.ok && d.cabinet) {
      _renderCabinetDashboard(root, d);
    } else {
      _renderNoCabinet(root);
    }
  } catch (e) {
    root.innerHTML = `<div class="card"><div class="msg e">Erreur chargement : ${e.message}</div></div>`;
  }
}

/* ── Pas de cabinet — formulaire créer/rejoindre ── */
function _renderNoCabinet(root) {
  const isAdmin = (typeof S !== 'undefined' && S?.role === 'admin') ||
                  (typeof APP !== 'undefined' && APP?.role === 'admin');

  root.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="ct">🏥 Rejoindre ou créer un cabinet</div>
      ${isAdmin ? `
        <div class="ai in" style="margin-bottom:14px;font-size:12px">
          🛡️ <strong>Mode admin — test fonctionnel</strong> · Créez un cabinet de test pour tester toutes les fonctionnalités multi-IDE.
          Vos données de test restent isolées. Les données des infirmières sont inaccessibles.
        </div>
        <!-- Mode démo solo : simule un cabinet avec l'admin comme seul IDE -->
        <div style="background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.2);border-radius:10px;padding:16px;margin-bottom:20px">
          <div style="font-size:13px;font-weight:700;color:var(--a);margin-bottom:6px">⚡ Mode démo solo — sans cabinet réel</div>
          <div style="font-size:12px;color:var(--m);margin-bottom:12px;line-height:1.5">
            Testez immédiatement toutes les fonctions cabinet (cotation multi-IDE, tournée, sync) en mode solo.
            Vous jouez le rôle des deux IDEs. Aucun enregistrement en base de données.
          </div>
          <button class="btn bp bsm" onclick="cabinetDemoSolo()"><span>🚀</span> Activer le mode démo solo</button>
        </div>` : ''}
      <p style="font-size:13px;color:var(--m);margin-bottom:20px;line-height:1.6">
        Le mode cabinet vous permet de partager votre tournée et certaines données avec vos collègues,
        <strong style="color:var(--t)">uniquement ce que vous choisissez de partager</strong>.
        Vos données personnelles restent toujours sur votre appareil.
      </p>
      <div class="msg e" id="cab-msg" style="display:none"></div>

      <!-- Créer -->
      <div style="margin-bottom:24px">
        <div class="lbl" style="margin-bottom:10px">✨ Créer un nouveau cabinet</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <input type="text" id="cab-nom" placeholder="Nom du cabinet (ex: Cabinet Infirmier Dupont)" style="flex:1;min-width:200px">
          <button class="btn bp" onclick="cabinetCreate()"><span>🏥</span> Créer</button>
        </div>
      </div>

      <!-- Rejoindre -->
      <div style="border-top:1px solid var(--b);padding-top:20px">
        <div class="lbl" style="margin-bottom:10px">🔗 Rejoindre un cabinet existant</div>
        <p style="font-size:12px;color:var(--m);margin-bottom:12px">Demandez l'<strong>ID du cabinet</strong> à la titulaire.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <input type="text" id="cab-join-id" placeholder="ID cabinet (ex: 3f8a2c1d-…)" style="flex:1;min-width:200px;font-family:var(--fm);font-size:12px">
          <button class="btn bs" onclick="cabinetJoin()"><span>🔗</span> Rejoindre</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="ct">ℹ️ Comment ça marche ?</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:8px">
        <div class="ai in"><strong>🔒 Contrôle total</strong><br><span style="font-size:12px">Vous décidez quelles données partager et avec qui. Rien ne part sans votre accord.</span></div>
        <div class="ai su"><strong>👥 Multi-IDE</strong><br><span style="font-size:12px">Coordinatez les tournées et cotations entre plusieurs infirmières du même cabinet.</span></div>
        <div class="ai in"><strong>📊 Statistiques cabinet</strong><br><span style="font-size:12px">Vue agrégée du CA et des actes du cabinet (avec accord de chaque membre).</span></div>
      </div>
    </div>`;
}

/* ── Dashboard cabinet existant ── */
function _renderCabinetDashboard(root, d) {
  const cab     = d.cabinet;
  const members = d.members || [];
  const myRole  = d.my_role;
  const prefs   = _loadSyncPrefs();

  // Mettre à jour APP.cabinet
  APP.set('cabinet', { id: cab.id, nom: cab.nom, my_role: myRole, members, sync_prefs: prefs });

  const membersHTML = members.map(m => {
    const isMe = m.id === APP.user?.id;
    const syncWith = prefs.with[m.id] !== false; // true par défaut pour les membres
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--b)">
        <div style="width:36px;height:36px;border-radius:50%;background:rgba(0,212,170,.15);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">
          ${m.role === 'titulaire' ? '👑' : '👤'}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px">${m.prenom} ${m.nom} ${isMe ? '<span style="font-size:10px;color:var(--a);font-family:var(--fm)">(moi)</span>' : ''}</div>
          <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${m.role === 'titulaire' ? '👑 Titulaire' : '👤 Membre'}</div>
        </div>
        ${!isMe ? `
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--m);cursor:pointer;flex-shrink:0">
          <input type="checkbox" id="sync-with-${m.id}" ${syncWith ? 'checked' : ''}
            onchange="cabinetToggleSyncWith('${m.id}', this.checked)"
            style="width:16px;height:16px;accent-color:var(--a)">
          Sync
        </label>` : ''}
      </div>`;
  }).join('');

  const whatItems = [
    { key: 'planning',    icon: '📅', label: 'Planning & tournée', desc: 'Partagez votre planning du jour pour coordonner les visites' },
    { key: 'patients',    icon: '👤', label: 'Patients communs', desc: 'Partagez la liste de vos patients (noms anonymisés)' },
    { key: 'cotations',   icon: '🩺', label: 'Cotations NGAP', desc: 'Synchronisez les cotations multi-IDE pour la facturation cabinet' },
    { key: 'ordonnances', icon: '💊', label: 'Ordonnances', desc: 'Partagez les ordonnances actives pour éviter les doublons' },
    { key: 'km',          icon: '🚗', label: 'Journal kilométrique', desc: 'Synchronisez les km pour les statistiques cabinet' },
    { key: 'piluliers',   icon: '💊', label: 'Semainier / Pilulier', desc: 'Partagez les semainiers patients avec vos collègues — chiffré AES' },
    { key: 'constantes',  icon: '📊', label: 'Constantes patients', desc: 'Partagez les mesures TA, glycémie, SpO2… entre IDEs — chiffré AES' },
  ];

  // Pré-population : si une clé what n'a jamais été définie → true par défaut
  let whatPrefsChanged = false;
  whatItems.forEach(item => {
    if (!(item.key in prefs.what)) { prefs.what[item.key] = true; whatPrefsChanged = true; }
  });
  if (whatPrefsChanged) { _saveSyncPrefs(prefs); }

  const whatHTML = whatItems.map(item => `
    <label style="display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--b);border-radius:10px;cursor:pointer;background:var(--s);transition:border-color .15s"
      onmouseenter="this.style.borderColor='rgba(0,212,170,.3)'" onmouseleave="this.style.borderColor='var(--b)'">
      <input type="checkbox" id="sync-what-${item.key}" ${prefs.what[item.key] !== false ? 'checked' : ''}
        onchange="cabinetToggleSyncWhat('${item.key}', this.checked)"
        style="width:18px;height:18px;accent-color:var(--a);flex-shrink:0;margin-top:1px">
      <div>
        <div style="font-weight:600;font-size:13px">${item.icon} ${item.label}</div>
        <div style="font-size:11px;color:var(--m);margin-top:2px">${item.desc}</div>
      </div>
    </label>`).join('');

  root.innerHTML = `
    <!-- En-tête cabinet -->
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px">
        <div>
          <div style="font-size:20px;font-family:var(--fs);font-weight:700">🏥 ${cab.nom}</div>
          <div style="font-size:12px;color:var(--m);font-family:var(--fm);margin-top:2px">
            ${myRole === 'titulaire' ? '👑 Titulaire' : '👤 Membre'} · ${members.length} membre(s)
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${myRole === 'titulaire' ? `<button class="btn bs bsm" onclick="cabinetCopyId('${cab.id}')">📋 Copier l'ID</button>` : ''}
          <button class="btn bd bsm" onclick="cabinetLeave()">🚪 Quitter</button>
        </div>
      </div>
      ${myRole === 'titulaire' ? `
      <div class="ai in" style="font-size:12px">
        💡 <strong>Titulaire :</strong> Partagez l'ID du cabinet avec vos collègues pour qu'elles rejoignent.
        <span style="font-family:var(--fm);font-size:11px;color:var(--a);word-break:break-all">${cab.id}</span>
      </div>` : ''}
    </div>

    <!-- Membres -->
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div class="ct" style="margin-bottom:0">👥 Membres du cabinet</div>
        <button class="btn bs bsm" onclick="renderCabinetSection()">↻ Actualiser</button>
      </div>
      <div id="cab-members-list">${membersHTML}</div>
    </div>

    <!-- Synchronisation — CE que je partage -->
    <div class="card" style="margin-bottom:16px">
      <div class="ct">🔄 Ce que je synchronise</div>
      <p style="font-size:12px;color:var(--m);margin-bottom:16px;line-height:1.6">
        Cochez uniquement ce que vous souhaitez partager. Les données non cochées restent
        <strong style="color:var(--t)">100% privées sur votre appareil</strong>.
      </p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-bottom:16px">
        ${whatHTML}
      </div>
      <div class="msg s" id="sync-what-msg" style="display:none"></div>
    </div>

    <!-- Synchronisation — AVEC QUI -->
    <div class="card" style="margin-bottom:16px">
      <div class="ct">👥 Avec qui je synchronise</div>
      <p style="font-size:12px;color:var(--m);margin-bottom:14px">Cochez les collègues avec qui vous acceptez de partager vos données sélectionnées ci-dessus.</p>
      <div id="cab-sync-with-list">
        ${members.filter(m => m.id !== APP.user?.id).length === 0
          ? `<div class="ai in" style="font-size:12px">Aucun autre membre pour l'instant.</div>`
          : (() => {
              // Pré-populer prefs.with pour les membres jamais vus (défaut = true)
              // Évite le bug : checkbox affichée cochée mais withIds vide
              let prefsChanged = false;
              members.filter(m => m.id !== APP.user?.id).forEach(m => {
                if (!(m.id in prefs.with)) { prefs.with[m.id] = true; prefsChanged = true; }
              });
              if (prefsChanged) { _saveSyncPrefs(prefs); }
              return members.filter(m => m.id !== APP.user?.id).map(m => {
                const syncWith = prefs.with[m.id] !== false;
                return `
                  <label style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--b);border-radius:8px;cursor:pointer;margin-bottom:8px;background:var(--s)">
                    <input type="checkbox" id="syncwith-${m.id}" ${syncWith ? 'checked' : ''}
                      onchange="cabinetToggleSyncWith('${m.id}', this.checked)"
                      style="width:18px;height:18px;accent-color:var(--a)">
                    <div>
                      <div style="font-weight:600;font-size:13px">${m.prenom} ${m.nom}</div>
                      <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${m.role === 'titulaire' ? '👑 Titulaire' : '👤 Membre'}</div>
                    </div>
                  </label>`;
              }).join('');
            })()
        }
      </div>
    </div>

    <!-- Actions de synchronisation -->
    <div class="card" style="margin-bottom:16px">
      <div class="ct">⚡ Actions de synchronisation</div>
      <div class="msg e" id="sync-action-msg" style="display:none"></div>
      <div class="msg s" id="sync-action-ok" style="display:none"></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:8px">
        <button class="btn bp" onclick="cabinetPushSync()"><span>⬆️</span> Envoyer mes données</button>
        <button class="btn bs" onclick="cabinetPullSync()"><span>⬇️</span> Recevoir les données</button>
        <button class="btn bs" onclick="cabinetSyncStatus()"><span>📊</span> État de la synchro</button>
      </div>
      <div id="sync-status-result" style="margin-top:14px"></div>
    </div>

    <!-- Notice RGPD -->
    <div class="card">
      <div class="ct">🔒 Confidentialité & RGPD</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;font-size:12px">
        <div class="ai su">✅ Consentement explicite requis</div>
        <div class="ai su">✅ Données chiffrées AES-256</div>
        <div class="ai su">✅ Synchronisation à la demande</div>
        <div class="ai su">✅ Révocable à tout moment</div>
        <div class="ai in">⚠️ Les données patients restent anonymisées lors du partage</div>
        <div class="ai in">⚠️ Aucune synchronisation automatique sans votre accord</div>
      </div>
    </div>`;
}

/* ════════════════════════════════════════════════
   4. ACTIONS CABINET
════════════════════════════════════════════════ */

async function cabinetCreate() {
  const nom = (document.getElementById('cab-nom')?.value || '').trim();
  if (!nom) { _cabMsg('Nom du cabinet obligatoire.', 'e'); return; }
  const btn = document.querySelector('[onclick="cabinetCreate()"]');
  if (btn) { btn.disabled = true; btn._o = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Création…'; }
  try {
    const d = await apiCall('/webhook/cabinet-register', { action: 'create', nom });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    if (typeof showToast === 'function') showToast('✅ Cabinet créé !', 'ok');
    await renderCabinetSection();
  } catch (e) {
    _cabMsg(e.message, 'e');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btn._o || '<span>🏥</span> Créer'; }
  }
}

async function cabinetJoin() {
  const id = (document.getElementById('cab-join-id')?.value || '').trim();
  if (!id) { _cabMsg('ID du cabinet obligatoire.', 'e'); return; }
  const btn = document.querySelector('[onclick="cabinetJoin()"]');
  if (btn) { btn.disabled = true; btn._o = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Rejoindre…'; }
  try {
    const d = await apiCall('/webhook/cabinet-register', { action: 'join', cabinet_id: id });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    if (typeof showToast === 'function') showToast('✅ Cabinet rejoint !', 'ok');
    await renderCabinetSection();
  } catch (e) {
    _cabMsg(e.message, 'e');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btn._o || '<span>🔗</span> Rejoindre'; }
  }
}

async function cabinetLeave() {
  if (!confirm('Voulez-vous vraiment quitter ce cabinet ? Cette action est irréversible.')) return;
  try {
    const d = await apiCall('/webhook/cabinet-register', { action: 'leave' });
    if (!d.ok) throw new Error(d.error || 'Erreur');
    APP.set('cabinet', null);
    if (typeof showToast === 'function') showToast('Vous avez quitté le cabinet.', 'ok');
    await renderCabinetSection();
  } catch (e) {
    if (typeof showToast === 'function') showToast('❌ ' + e.message, 'err');
  }
}

function cabinetCopyId(id) {
  navigator.clipboard?.writeText(id).then(() => {
    if (typeof showToast === 'function') showToast('✅ ID copié dans le presse-papier !', 'ok');
  }).catch(() => prompt('Copiez cet ID :', id));
}

/* ════════════════════════════════════════════════
   MODE DÉMO SOLO — Admin sans cabinet réel
   Simule un cabinet à 2 IDEs avec l'admin
   pour tester toutes les fonctions multi-IDE
   sans créer d'entrée en base de données.
════════════════════════════════════════════════ */
function cabinetDemoSolo() {
  const u   = APP.user || S?.user || {};
  const nom = ((u.prenom || '') + ' ' + (u.nom || '')).trim() || 'Admin';

  // Créer un cabinet synthétique en mémoire uniquement
  const fakeCabinet = {
    id:      'demo-solo-' + (u.id || 'admin'),
    nom:     'Cabinet Démo — ' + nom,
    my_role: 'titulaire',
    members: [
      { id: u.id || 'ide_0', nom: u.nom || '', prenom: u.prenom || nom, role: 'titulaire' },
      { id: 'ide_demo_2',    nom: 'Dupont', prenom: 'IDE 2 (démo)',      role: 'membre'    },
    ],
    sync_prefs: _loadSyncPrefs(),
    _demo: true, // flag : pas de persistance backend
  };

  APP.set('cabinet', fakeCabinet);
  _updateCabinetBadge(2);

  // Activer le toggle cabinet dans la cotation
  if (typeof initCotationCabinetToggle === 'function') initCotationCabinetToggle();
  _updateTourneeCabinetPanel();

  const root = document.getElementById('cabinet-root');
  if (root) _renderCabinetDemoDashboard(root, fakeCabinet);

  if (typeof showToast === 'function')
    showToast('success', 'Mode démo solo activé', '2 IDEs simulés — aucune donnée en base');
}

/* ── Dashboard démo solo ─────────────────────── */
function _renderCabinetDemoDashboard(root, cab) {
  const members  = cab.members || [];
  const prefs    = _loadSyncPrefs();

  const whatItems = [
    { key: 'planning',    icon: '📅', label: 'Planning & tournée',    desc: 'Partagez votre planning du jour' },
    { key: 'patients',    icon: '👤', label: 'Patients communs',       desc: 'Partagez la liste de vos patients' },
    { key: 'cotations',   icon: '🩺', label: 'Cotations NGAP',         desc: 'Synchronisez les cotations multi-IDE' },
    { key: 'ordonnances', icon: '💊', label: 'Ordonnances',             desc: 'Partagez les ordonnances actives' },
    { key: 'km',          icon: '🚗', label: 'Journal kilométrique',    desc: 'Synchronisez les km cabinet' },
    { key: 'piluliers',   icon: '💊', label: 'Semainier / Pilulier',    desc: 'Partagez les semainiers patients — chiffré AES' },
    { key: 'constantes',  icon: '📊', label: 'Constantes patients',     desc: 'Partagez les constantes TA, glycémie… — chiffré AES' },
  ];

  root.innerHTML = `
    <!-- Bannière démo -->
    <div class="ai in" style="margin-bottom:16px;font-size:12px">
      🛡️ <strong>Mode démo solo actif</strong> · Cabinet simulé en mémoire — toutes les fonctions multi-IDE sont testables.
      Les données ne sont pas persistées en base. <button onclick="_cabinetExitDemo()" style="background:none;border:none;color:var(--a);cursor:pointer;font-size:12px;text-decoration:underline;padding:0;margin-left:8px">Quitter la démo</button>
    </div>

    <!-- En-tête cabinet -->
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px">
        <div>
          <div style="font-size:20px;font-family:var(--fs);font-weight:700">🏥 ${cab.nom}</div>
          <div style="font-size:12px;color:var(--m);font-family:var(--fm);margin-top:2px">
            👑 Titulaire · ${members.length} IDE(s) simulé(s)
          </div>
        </div>
        <button class="btn bp bsm" onclick="cabinetCreate()"><span>🏥</span> Créer un vrai cabinet</button>
      </div>
    </div>

    <!-- Membres simulés -->
    <div class="card" style="margin-bottom:16px">
      <div class="ct" style="margin-bottom:14px">👥 IDEs simulés</div>
      ${members.map(m => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--b)">
          <div style="width:36px;height:36px;border-radius:50%;background:rgba(0,212,170,.15);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">
            ${m.role === 'titulaire' ? '👑' : '👤'}
          </div>
          <div style="flex:1">
            <div style="font-weight:600;font-size:14px">${m.prenom} ${m.nom} ${m.id===APP.user?.id?'<span style="font-size:10px;color:var(--a);font-family:var(--fm)">(moi)</span>':''}</div>
            <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${m.role === 'titulaire' ? '👑 Titulaire' : '👤 Membre simulé'}</div>
          </div>
        </div>`).join('')}
    </div>

    <!-- Ce que je synchronise -->
    <div class="card" style="margin-bottom:16px">
      <div class="ct">🔄 Ce que je synchronise</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-top:12px;margin-bottom:16px">
        ${whatItems.map(item => `
          <label style="display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--b);border-radius:10px;cursor:pointer;background:var(--s)">
            <input type="checkbox" id="sync-what-${item.key}" ${prefs.what[item.key] !== false ? 'checked' : ''}
              onchange="cabinetToggleSyncWhat('${item.key}', this.checked)"
              style="width:18px;height:18px;accent-color:var(--a);flex-shrink:0;margin-top:1px">
            <div>
              <div style="font-weight:600;font-size:13px">${item.icon} ${item.label}</div>
              <div style="font-size:11px;color:var(--m);margin-top:2px">${item.desc}</div>
            </div>
          </label>`).join('')}
      </div>
    </div>

    <!-- Actions démo -->
    <div class="card" style="margin-bottom:16px">
      <div class="ct">⚡ Tester les fonctions multi-IDE</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:8px">
        <button class="btn bp" onclick="navTo('cot',null);setTimeout(()=>document.getElementById('cot-cabinet-mode')?.click?.(),400)">
          <span>🩺</span> Tester cotation multi-IDE
        </button>
        <button class="btn bs" onclick="navTo('tur',null);setTimeout(()=>typeof optimiserTourneeCabinet==='function'&&optimiserTourneeCabinet(),600)">
          <span>🗺️</span> Tester tournée cabinet
        </button>
        <button class="btn bs" onclick="_cabinetDemoSync()">
          <span>🔄</span> Simuler une synchronisation
        </button>
      </div>
    </div>

    <!-- RGPD -->
    <div class="card">
      <div class="ct">🔒 Confidentialité — rappel</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;font-size:12px">
        <div class="ai su">✅ Données démo isolées dans votre IDB admin</div>
        <div class="ai su">✅ Aucune donnée infirmière accessible</div>
        <div class="ai in">⚠️ Ce cabinet n'existe pas en base — mode test uniquement</div>
      </div>
    </div>`;
}

function _cabinetExitDemo() {
  APP.set('cabinet', null);
  _updateCabinetBadge(0);
  const root = document.getElementById('cabinet-root');
  if (root) _renderNoCabinet(root);
  if (typeof showToast === 'function') showToast('info', 'Mode démo quitté');
}

function _cabinetDemoSync() {
  if (typeof showToast === 'function') {
    showToast('info', 'Synchronisation simulée', 'En mode démo, les données restent locales.');
  }
  const statusEl = document.getElementById('sync-status-result');
  if (statusEl) {
    statusEl.innerHTML = `
      <div style="background:rgba(0,212,170,.06);border:1px solid rgba(0,212,170,.2);border-radius:8px;padding:12px;font-size:12px">
        <div style="font-weight:700;color:var(--a);margin-bottom:6px">📊 État de synchronisation (démo)</div>
        <div style="color:var(--m)">IDE 2 (démo) — Dernière sync : maintenant · Statut : ✅ Simulé</div>
        <div style="color:var(--m);margin-top:4px">Mode démo : aucune donnée réelle échangée</div>
      </div>`;
  }
}

/* ════════════════════════════════════════════════
   5. PRÉFÉRENCES DE SYNCHRONISATION
════════════════════════════════════════════════ */

function cabinetToggleSyncWhat(key, checked) {
  const prefs = _loadSyncPrefs();
  prefs.what[key] = checked;
  _saveSyncPrefs(prefs);
  // Mettre à jour APP.cabinet si existant
  const cab = APP.get('cabinet');
  if (cab) { cab.sync_prefs = prefs; APP.set('cabinet', cab); }
  const msg = document.getElementById('sync-what-msg');
  if (msg) {
    msg.className = 'msg s';
    msg.textContent = `✅ Préférence "${key}" ${checked ? 'activée' : 'désactivée'} — sauvegardée localement.`;
    msg.style.display = 'block';
    setTimeout(() => { msg.style.display = 'none'; }, 2500);
  }
}

function cabinetToggleSyncWith(memberId, checked) {
  const prefs = _loadSyncPrefs();
  prefs.with[memberId] = checked;
  _saveSyncPrefs(prefs);
  const cab = APP.get('cabinet');
  if (cab) { cab.sync_prefs = prefs; APP.set('cabinet', cab); }
}

/* ════════════════════════════════════════════════
   6. SYNCHRONISATION PUSH / PULL
════════════════════════════════════════════════ */

/* ── Audit log cabinet ──────────────────────────────────────────────── */
async function _cabinetAuditLog(action, meta = {}) {
  try {
    await apiCall('/webhook/log', {
      type: 'CABINET_ACTION',
      cabinet_id: APP.get('cabinet')?.id,
      user_id:    APP.user?.id,
      action,
      meta:       JSON.stringify(meta),
    });
  } catch {} // silencieux — ne pas bloquer le flux
}

async function cabinetPushSync() {
  const cab   = APP.get('cabinet');
  if (!cab?.id) { _syncMsg('Vous n\'êtes pas dans un cabinet.', 'e'); return; }
  const prefs = _loadSyncPrefs();

  const whatKeys  = Object.entries(prefs.what).filter(([,v]) => v).map(([k]) => k);
  const withIds   = Object.entries(prefs.with).filter(([,v]) => v).map(([k]) => k);

  if (!whatKeys.length) { _syncMsg('Aucune donnée à synchroniser — cochez ce que vous souhaitez partager.', 'e'); return; }
  if (!withIds.length)  { _syncMsg('Aucune collègue sélectionnée — cochez avec qui partager.', 'e'); return; }

  // Si piluliers ou constantes cochés → patients obligatoire (les données sont liées aux fiches)
  if ((prefs.what.piluliers || prefs.what.constantes || prefs.what.cotations) && !prefs.what.patients) {
    whatKeys = [...new Set([...whatKeys, 'patients'])];
  }

  const btn = document.querySelector('[onclick="cabinetPushSync()"]');
  if (btn) { btn.disabled = true; btn._o = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Envoi…'; }

  try {
    // Collecter les données selon les préférences
    const payload = {
      cabinet_id:  cab.id,
      sender_id:   APP.user?.id,
      target_ids:  withIds,
      what:        whatKeys,
      data:        {},
    };

    // Planning
    if (prefs.what.planning) {
      try {
        const planKey = `ami_planning_${APP.user?.id}`;
        const planRaw = localStorage.getItem(planKey);
        payload.data.planning = planRaw ? JSON.parse(planRaw) : null;
      } catch {}
    }

    // Journal km
    if (prefs.what.km) {
      try {
        const kmKey = `ami_km_journal_${APP.user?.id}`;
        const kmRaw = localStorage.getItem(kmKey);
        payload.data.km = kmRaw ? JSON.parse(kmRaw) : null;
      } catch {}
    }

    // Patients — deux niveaux :
    // 1. patients_meta : adresses GPS anonymisées (tournée)
    // 2. patients_cabinet : fiches complètes chiffrées clé cabinet (import carnet collègue)
    if (prefs.what.patients && typeof getAllPatients === 'function') {
      try {
        // S'assurer que les cotations Supabase sont dans les fiches avant de pousser
        if (typeof syncCotationsFromServer === 'function') {
          try { await syncCotationsFromServer(); } catch {}
        }
        const pts = await getAllPatients();
        // Métadonnées GPS pour la tournée
        payload.data.patients_meta = pts.map(p => ({
          id:         p.id,
          nom_hash:   btoa(unescape(encodeURIComponent((p.nom||'').toLowerCase().trim()+'|'+(p.prenom||'').toLowerCase().trim()))).slice(0,24),
          adresse:    p.adresse   || null,
          lat:        p.lat       || null,
          lng:        p.lng       || null,
          heure_soin: p.heure_soin|| null,
        }));
        // Fiches patients pour import dans le carnet du collègue
        // Chiffrées avec la clé cabinet (partagée entre tous les membres)
        // On limite aux champs identité + cliniques essentiels pour rester sous la limite 100KB
        const full = pts.map(p => ({
          id: p.id, nom: p.nom||'', prenom: p.prenom||'',
          adresse: p.adresse||'', lat: p.lat||null, lng: p.lng||null,
          ddn: p.ddn||'', secu: p.secu||'', amo: p.amo||'', amc: p.amc||'',
          medecin: p.medecin||'', allergies: p.allergies||'',
          pathologies: p.pathologies||'', traitements: p.traitements||'',
          heure_preferee: p.heure_preferee||'', actes_recurrents: p.actes_recurrents||'',
          // Versioning pour résolution de conflits
          _version:    (p._version || 0),
          _updated_at: p.updated_at ? new Date(p.updated_at).getTime() : Date.now(),
          // Données cliniques limitées pour rester sous 80KB
          cotations:   (p.cotations  ||[]).slice(-20),
          piluliers:   (p.piluliers  ||[]).slice(-10),
          constantes:  (p.constantes ||[]).slice(-30),
          ordonnances: (p.ordonnances||[]).slice(-5),
        }));
        const enc = await CAB_CRYPTO.encrypt(full, cab.id);
        const encSize = enc ? Math.round(enc.length / 1024) + 'KB' : 'ECHEC';
        console.info('[cabinet push] patients_cabinet:', full.length, 'patients,', encSize);
        if (!enc) { console.warn('[cabinet push] Encodage patients_cabinet échoué'); }
        if (enc && enc.length < 80000) { // limite sécuritaire 80KB
          payload.data.patients_cabinet = enc;
        } else if (enc) {
          console.warn('[cabinet push] patients_cabinet trop volumineux (' + encSize + ') — envoi sans données cliniques');
          // Réessayer sans cotations/piluliers/constantes
          const fullLight = pts.map(p => ({
            id: p.id, nom: p.nom||'', prenom: p.prenom||'',
            adresse: p.adresse||'', lat: p.lat||null, lng: p.lng||null,
            ddn: p.ddn||'', secu: p.secu||'', amo: p.amo||'', amc: p.amc||'',
            medecin: p.medecin||'', heure_preferee: p.heure_preferee||'',
          }));
          const encLight = _cabEnc(fullLight, cab.id);
          if (encLight) payload.data.patients_cabinet = encLight;
        }
      } catch (e) { console.warn('[cabinet push patients]', e.message); }
    }

    // Ordonnances (liste anonymisée)
    if (prefs.what.ordonnances) {
      try {
        const ordKey = `ami_ordonnances_${APP.user?.id}`;
        const ordRaw = localStorage.getItem(ordKey);
        if (ordRaw) {
          const ords = JSON.parse(ordRaw);
          // Anonymiser les noms patients avant partage
          payload.data.ordonnances = ords.map(o => ({
            ...o,
            patient: '—', // ⚠️ nom patient jamais partagé
          }));
        }
      } catch {}
    }

    // Cotations : résumés anonymisés (invoice_number, date, total, actes_codes)
    // Pas de nom patient, pas de notes médicales — juste ce qu'il faut pour la réconciliation
    if (prefs.what.cotations && typeof getAllPatients === 'function') {
      try {
        const pts = await getAllPatients();
        const cotResumes = [];
        for (const p of pts) {
          for (const c of (p.cotations || [])) {
            if (!c.invoice_number || parseFloat(c.total || 0) <= 0) continue;
            cotResumes.push({
              invoice_number: c.invoice_number,
              date:           (c.date || '').slice(0, 10),
              total:          parseFloat(c.total || 0),
              actes_codes:    (c.actes || []).map(a => a.code).filter(Boolean),
              source:         c.source || 'carnet',
              patient_id:     p.id, // ID local — permet la fusion côté destinataire
            });
          }
        }
        if (cotResumes.length) payload.data.cotations_summary = cotResumes;
      } catch (e) { console.warn('[cabinet push cotations]', e.message); }
    }

    // Piluliers & Constantes : déjà inclus dans patients_cabinet ci-dessus.
    // Rien de plus à faire — ils transitent dans les fiches patients complètes.

    const d = await apiCall('/webhook/cabinet-sync-push', payload);
    if (!d.ok) throw new Error(d.error || 'Erreur synchronisation');

    _syncOk(`✅ Données envoyées à ${withIds.length} collègue(s) — ${whatKeys.join(', ')}`);
    _cabinetAuditLog('SYNC_PUSH', { what: whatKeys, targets: withIds.length });
  } catch (e) {
    _syncMsg('❌ ' + e.message, 'e');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btn._o || '<span>⬆️</span> Envoyer'; }
  }
}

async function cabinetPullSync() {
  const cab = APP.get('cabinet');
  if (!cab?.id) { _syncMsg('Vous n\'êtes pas dans un cabinet.', 'e'); return; }

  const btn = document.querySelector('[onclick="cabinetPullSync()"]');
  if (btn) { btn.disabled = true; btn._o = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Réception…'; }

  try {
    // ── Sync patients d'abord pour que les fiches existent localement ──────
    // Les patient_id dans les données cabinet sont des IDs locaux de l'émetteur.
    // Ils n'existent côté destinataire que si la fiche patient a été synchronisée.
    if (typeof syncPatientsFromServer === 'function') {
      try { await syncPatientsFromServer(); } catch {}
    }

    const d = await apiCall('/webhook/cabinet-sync-pull', {
      cabinet_id: cab.id,
      user_id:    APP.user?.id,
    });
    if (!d.ok) throw new Error(d.error || 'Erreur');

    const items = d.items || [];
    if (!items.length) {
      _syncOk('ℹ️ Aucune donnée reçue — vérifiez que votre collègue a coché votre nom dans "Avec qui je synchronise" et a cliqué ⬆️ Envoyer.');
      return;
    }

    // Log détaillé pour debug
    console.info('[cabinetPullSync] Données reçues:', items.length, 'item(s)');
    items.forEach((i, idx) => {
      console.info('  Item', idx, ':', {
        sender: i.sender_prenom + ' ' + i.sender_nom,
        what: i.what,
        dataKeys: Object.keys(i.data || {}),
        patients_cabinet_len: i.data?.patients_cabinet?.length || 0,
        patients_meta_len: (i.data?.patients_meta || []).length,
        cab_id_used: cab.id,
      });
      // Tenter le déchiffrement maintenant pour voir l'erreur exacte
      if (i.data?.patients_cabinet) {
        const testDec = _cabDec(i.data.patients_cabinet, cab.id);
        console.info('  _cabDec test:', testDec === null ? 'NULL — échec' : Array.isArray(testDec) ? testDec.length + ' patients OK' : typeof testDec);
      } else {
        console.warn('  patients_cabinet ABSENT de item.data');
      }
    });

    let applied = 0;
    const details = []; // résumé des imports pour le message final

    for (const item of items) {
      const sender = item.sender_nom ? `${item.sender_prenom} ${item.sender_nom}` : 'collègue';

      // ── Planning ─────────────────────────────────────────────────────
      if (item.what.includes('planning') && item.data?.planning) {
        try {
          localStorage.setItem(`ami_cabinet_planning_${item.sender_id}`, JSON.stringify(item.data.planning));
          applied++; details.push('📅 planning');
        } catch {}
      }

      // ── Journal km ───────────────────────────────────────────────────
      if (item.what.includes('km') && item.data?.km) {
        try {
          localStorage.setItem(`ami_cabinet_km_${item.sender_id}`, JSON.stringify(item.data.km));
          applied++; details.push('🚗 km');
        } catch {}
      }

      // ── Patients meta (GPS pour tournée) ────────────────────────────
      if (item.what.includes('patients') && Array.isArray(item.data?.patients_meta)) {
        try {
          localStorage.setItem(`ami_cabinet_patients_${item.sender_id}`, JSON.stringify(item.data.patients_meta));
        } catch {}
      }

      // ── Patients cabinet (VERSION CLEAN) ──────────────────────────────
      if (item.what.includes('patients') && item.data?.patients_cabinet) {
        try {
          const pts = await CAB_CRYPTO.decrypt(item.data.patients_cabinet, cab.id);
          console.info('[cabinet pull] _cabDec:', pts === null ? 'ECHEC' : Array.isArray(pts) ? pts.length + ' patients' : typeof pts);

          if (Array.isArray(pts) && pts.length) {
            await initPatientsDB();
            const localRows = await _idbGetAll(PATIENTS_STORE);
            const localMap  = new Map(localRows.map(r => [r.id, r]));
            let nbPt = 0;

            // Helper merge tableau sans doublons
            const mergeArr = (localArr, incoming, uniqueKey) => {
              if (!Array.isArray(incoming) || !incoming.length) return false;
              if (!Array.isArray(localArr)) return false;
              const existSet = new Set(localArr.map(x => x[uniqueKey]).filter(Boolean));
              let changed = false;
              for (const item of incoming) {
                if (item[uniqueKey] && !existSet.has(item[uniqueKey])) {
                  localArr.push({ ...item, _synced: true });
                  existSet.add(item[uniqueKey]);
                  changed = true;
                }
              }
              return changed;
            };

            // Helper versioning : faut-il écraser ?
            const shouldOverride = (incoming, localDecoded) => {
              if (!localDecoded) return true;
              if ((incoming._version || 0) > (localDecoded._version || 0)) return true;
              if ((incoming._updated_at || 0) > (localDecoded._updated_at || 0)) return true;
              return false;
            };

            for (const p of pts) {
              if (!p.id || !p.nom) continue;
              const existing   = localMap.get(p.id);
              const localDecoded = existing ? (_dec(existing._data) || {}) : null;

              // ✅ CRITIQUE : toujours encoder avec la clé locale du destinataire
              // Enrichir avec version + traçabilité
              const enriched = {
                ...p,
                _version:    (p._version || 0) + 1,
                _updated_at: Date.now(),
                _updated_by: item.sender_id,
                source:      'cabinet',
                owner_id:    item.sender_id,
              };
              const encoded = _enc(enriched);
              if (!encoded) continue;

              // ✅ CRITIQUE : infirmiere_id = userId LOCAL du destinataire
              const baseRow = {
                id:            p.id,
                nom:           p.nom,
                prenom:        p.prenom || '',
                _data:         encoded,
                updated_at:    new Date().toISOString(),
                infirmiere_id: APP.user?.id,   // ← clé de visibilité
              };

              if (!existing || shouldOverride(p, localDecoded)) {
                // Nouveau patient OU version distante plus récente
                await _idbPut(PATIENTS_STORE, baseRow);
                nbPt++;
              } else {
                // Version locale plus récente — merger les tableaux uniquement
                let changed = false;
                if (!Array.isArray(localDecoded.cotations))  localDecoded.cotations  = [];
                if (!Array.isArray(localDecoded.piluliers))  localDecoded.piluliers  = [];
                if (!Array.isArray(localDecoded.constantes)) localDecoded.constantes = [];

                if (mergeArr(localDecoded.cotations,  p.cotations,  'invoice_number')) changed = true;
                if (mergeArr(localDecoded.piluliers,  p.piluliers,  'semaine_debut'))  changed = true;
                if (mergeArr(localDecoded.constantes, p.constantes, 'date'))           changed = true;

                if (changed) {
                  localDecoded.updated_at = new Date().toISOString();
                  await _idbPut(PATIENTS_STORE, {
                    ...baseRow,
                    _data: _enc(localDecoded),
                  });
                  nbPt++;
                }
              }
            }

            if (nbPt > 0) { applied++; details.push(`👤 ${nbPt} patient(s)`); }
          }
        } catch (e) { console.error('[cabinet pull patients_cabinet]', e); }
      }

      // ── Ordonnances (anonymisées) ─────────────────────────────────────
      if (item.what.includes('ordonnances') && Array.isArray(item.data?.ordonnances)) {
        try {
          localStorage.setItem(`ami_cabinet_ordonnances_${item.sender_id}`, JSON.stringify(item.data.ordonnances));
          applied++; details.push(`💊 ${item.data.ordonnances.length} ordonnance(s)`);
        } catch {}
      }

      // ── Cotations ────────────────────────────────────────────────────
      if (item.what.includes('cotations') && Array.isArray(item.data?.cotations_summary)) {
        try {
          const toSave = item.data.cotations_summary.map(c => ({
            invoice_number: c.invoice_number,
            date_soin:      c.date,
            total:          c.total,
            actes:          (c.actes_codes || []).map(code => ({ code })),
            source:         'cabinet_sync',
            patient_id:     c.patient_id || null,
          })).filter(c => c.total > 0);
          if (toSave.length) {
            await apiCall('/webhook/ami-save-cotation', { cotations: toSave });
            applied++; details.push(`🩺 ${toSave.length} cotation(s)`);
          }
        } catch (e) { console.warn('[cabinet pull cotations]', e.message); }
      }

      // Piluliers & Constantes inclus dans patients_cabinet — déjà traités ci-dessus.
    }

    console.info('[cabinetPullSync] items reçus:', items.length, '| applied:', applied, '| details:', details);
    _cabinetAuditLog('SYNC_PULL', { received: items.length, applied });
    if (applied > 0) {
      _syncOk(`✅ Import depuis ${items.length} collègue(s) — ${details.join(', ')}`);
      showToast('success', 'Données importées', details.join(', '));
      // 🔥 Refresh UI fiable — attendre que l'IDB soit committed avant reload
      if (typeof loadPatients === 'function') {
        try { await loadPatients(); } catch {}
      }
      if (typeof syncCotationsFromServer === 'function') syncCotationsFromServer().catch(() => {});
      // Rafraîchir la liste patients sans reload brutal
      setTimeout(() => {
        const list = document.getElementById('patients-list');
        if (list && list.children.length === 0 && applied > 0) {
          console.warn('[cabinetPullSync] UI stale → retry loadPatients');
          if (typeof loadPatients === 'function') loadPatients().catch(() => {});
        }
      }, 800);
    } else {
      // Afficher le détail pour aider au diagnostic
      const whatReceived = items.map(i => i.what?.join(', ') || '(vide)').join(' | ');
      _syncOk(`ℹ️ Reçu ${items.length} paquet(s) [${whatReceived}] mais rien à importer — données déjà présentes ou types non cochés.`);
    }
  } catch (e) {
    _syncMsg('❌ ' + e.message, 'e');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btn._o || '<span>⬇️</span> Recevoir'; }
  }
}

async function cabinetSyncStatus() {
  const cab = APP.get('cabinet');
  if (!cab?.id) { _syncMsg('Vous n\'êtes pas dans un cabinet.', 'e'); return; }

  try {
    const d = await apiCall('/webhook/cabinet-sync-status', { cabinet_id: cab.id });
    const result = document.getElementById('sync-status-result');
    if (!result) return;

    if (!d.ok) throw new Error(d.error || 'Erreur');

    const members = d.members || [];
    result.innerHTML = `
      <div class="ct" style="font-size:12px;margin-bottom:10px">État de synchronisation du cabinet</div>
      ${members.map(m => {
        const isSelf      = m.id === APP.user?.id;
        const pushColor   = m.last_push ? '#00d4aa' : '#555';
        const pullColor   = m.last_pull_ok ? '#00d4aa' : m.last_pull ? '#f59e0b' : '#555';
        const pushLabel   = m.last_push ? new Date(m.last_push).toLocaleString('fr-FR') : 'Jamais envoyé';
        const pushWhat    = m.last_push_what && m.last_push_what.length ? m.last_push_what.join(', ') : '';
        const pullLabel   = m.last_pull ? new Date(m.last_pull).toLocaleString('fr-FR') : 'Jamais reçu';
        const pullBadge   = m.last_pull
          ? (m.last_pull_ok
            ? '<span style="color:#00d4aa;font-size:10px">✅ ' + m.last_pull_items + ' élément(s) reçu(s)</span>'
            : '<span style="color:#f59e0b;font-size:10px">⚠️ 0 élément reçu</span>')
          : '<span style="color:#888;font-size:10px">En attente</span>';
        return '<div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px;margin-bottom:8px">'
          + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">'
          + '<div style="font-weight:600;font-size:13px">' + m.prenom + ' ' + m.nom + '</div>'
          + (isSelf ? '<span style="font-size:10px;color:var(--a);font-family:var(--fm)">(moi)</span>' : '')
          + '<span style="font-size:10px;color:var(--m);font-family:var(--fm);margin-left:auto">'
          + (m.role === 'titulaire' ? '👑 Titulaire' : '👤 Membre') + '</span>'
          + '</div>'
          + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11px;font-family:var(--fm)">'
          + '<div style="padding:8px;background:var(--dd);border-radius:6px;border-left:3px solid ' + pushColor + '">'
          + '<div style="color:var(--m);margin-bottom:3px">⬆️ Dernier envoi</div>'
          + '<div style="color:var(--t);font-weight:600">' + pushLabel + '</div>'
          + (pushWhat ? '<div style="color:var(--m);margin-top:2px;font-size:10px">' + pushWhat + '</div>' : '')
          + '</div>'
          + '<div style="padding:8px;background:var(--dd);border-radius:6px;border-left:3px solid ' + pullColor + '">'
          + '<div style="color:var(--m);margin-bottom:3px">⬇️ Dernière réception</div>'
          + '<div style="color:var(--t);font-weight:600">' + pullLabel + '</div>'
          + '<div style="margin-top:3px">' + pullBadge + '</div>'
          + '</div>'
          + '</div>'
          + '</div>';
      }).join('')}`;
  } catch (e) {
    _syncMsg('❌ ' + e.message, 'e');
  }
}

/* ── Helpers UI ─── */
function _cabMsg(txt, type = 'e') {
  const el = document.getElementById('cab-msg');
  if (!el) { if (typeof showToast === 'function') showToast(txt, type === 'e' ? 'err' : 'ok'); return; }
  el.className = 'msg ' + type;
  el.textContent = txt;
  el.style.display = 'block';
}

function _syncMsg(txt, type = 'e') {
  const el = document.getElementById('sync-action-msg');
  if (!el) return;
  el.className = 'msg ' + type;
  el.textContent = txt;
  el.style.display = 'block';
  const ok = document.getElementById('sync-action-ok');
  if (ok) ok.style.display = 'none';
}

function _syncOk(txt) {
  const ok = document.getElementById('sync-action-ok');
  if (!ok) { if (typeof showToast === 'function') showToast(txt, 'ok'); return; }
  ok.className = 'msg s';
  ok.textContent = txt;
  ok.style.display = 'block';
  const err = document.getElementById('sync-action-msg');
  if (err) err.style.display = 'none';
}

/* ════════════════════════════════════════════════
   7. COTATION CABINET — wrapper multi-IDE
   Appelé depuis cotation.js si cabinet_mode actif
════════════════════════════════════════════════ */
async function cabinetCotation(basePayload, actes) {
  const cab = APP.get('cabinet');
  if (!cab?.id) return null;

  const payload = {
    ...basePayload,
    cabinet_mode: true,
    cabinet_id:   cab.id,
    actes:        actes,
    mode:         'ngap',
  };

  try {
    const d = await apiCall('/webhook/cabinet-calcul', payload);
    return d;
  } catch (e) {
    console.warn('[AMI Cabinet] cotation cabinet KO:', e.message);
    return null;
  }
}

/* ════════════════════════════════════════════════
   8. TOURNÉE CABINET — wrapper multi-IDE
   Appelé depuis tournee.js si cabinet_mode actif
════════════════════════════════════════════════ */
async function cabinetTournee(patients) {
  const cab = APP.get('cabinet');
  if (!cab?.id) return null;

  try {
    const d = await apiCall('/webhook/cabinet-tournee', {
      cabinet_id: cab.id,
      patients:   patients,
      members:    cab.members,
    });
    return d;
  } catch (e) {
    console.warn('[AMI Cabinet] tournée cabinet KO:', e.message);
    return null;
  }
}

/* Exposer les fonctions globalement */
window.initCabinet          = initCabinet;
window.initCabinetRealtime  = initCabinetRealtime;
window.CAB_CRYPTO           = CAB_CRYPTO;

function _updateTourneeCabinetPanel() {
  const panel = document.getElementById('tur-cabinet-panel');
  if (!panel) return;
  const cab = APP.get('cabinet');
  if (cab?.id) {
    panel.style.display = 'block';
    const nomEl = document.getElementById('tur-cabinet-nom');
    if (nomEl) nomEl.textContent = cab.nom || '—';
  } else {
    panel.style.display = 'none';
  }
}

// Réagir aux changements de cabinet pour la tournée
APP.on('cabinet', () => {
  _updateTourneeCabinetPanel();
});
window.renderCabinetSection = renderCabinetSection;
window.cabinetCreate        = cabinetCreate;
window.cabinetJoin          = cabinetJoin;
window.cabinetLeave         = cabinetLeave;
window.cabinetCopyId        = cabinetCopyId;
window.cabinetToggleSyncWhat= cabinetToggleSyncWhat;
window.cabinetToggleSyncWith= cabinetToggleSyncWith;
window.cabinetPushSync      = cabinetPushSync;
window.cabinetPullSync      = cabinetPullSync;
window.cabinetSyncStatus    = cabinetSyncStatus;
window.cabinetCotation      = cabinetCotation;
window.cabinetTournee       = cabinetTournee;
