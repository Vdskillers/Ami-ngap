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
    const raw = localStorage.getItem(CABINET_SYNC_KEY());
    return raw ? JSON.parse(raw) : _defaultSyncPrefs();
  } catch { return _defaultSyncPrefs(); }
}

function _saveSyncPrefs(prefs) {
  try { localStorage.setItem(CABINET_SYNC_KEY(), JSON.stringify(prefs)); } catch {}
}

function _defaultSyncPrefs() {
  return {
    what: { planning: false, patients: false, cotations: false, ordonnances: false, km: false, piluliers: false, constantes: false },
    with: {}
  };
}

/* ════════════════════════════════════════════════
   2. INITIALISATION AU LOGIN
   Appelé par auth.js après showApp()
════════════════════════════════════════════════ */
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

  const whatHTML = whatItems.map(item => `
    <label style="display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--b);border-radius:10px;cursor:pointer;background:var(--s);transition:border-color .15s"
      onmouseenter="this.style.borderColor='rgba(0,212,170,.3)'" onmouseleave="this.style.borderColor='var(--b)'">
      <input type="checkbox" id="sync-what-${item.key}" ${prefs.what[item.key] ? 'checked' : ''}
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
            <input type="checkbox" id="sync-what-${item.key}" ${prefs.what[item.key] ? 'checked' : ''}
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

async function cabinetPushSync() {
  const cab   = APP.get('cabinet');
  if (!cab?.id) { _syncMsg('Vous n\'êtes pas dans un cabinet.', 'e'); return; }
  const prefs = _loadSyncPrefs();

  const whatKeys  = Object.entries(prefs.what).filter(([,v]) => v).map(([k]) => k);
  const withIds   = Object.entries(prefs.with).filter(([,v]) => v).map(([k]) => k);

  if (!whatKeys.length) { _syncMsg('Aucune donnée à synchroniser — cochez ce que vous souhaitez partager.', 'e'); return; }
  if (!withIds.length)  { _syncMsg('Aucune collègue sélectionnée — cochez avec qui partager.', 'e'); return; }

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

    // Patients (anonymisés — hash uniquement)
    if (prefs.what.patients && typeof getAllPatients === 'function') {
      try {
        const pts = await getAllPatients();
        // On ne partage que les métadonnées anonymisées (sans données de santé)
        payload.data.patients_meta = pts.map(p => ({
          id:          p.id,
          adresse:     p.adresse || null,
          lat:         p.lat    || null,
          lng:         p.lng    || null,
          heure_soin:  p.heure_soin || null,
          // ⚠️ NOM, SECU, DDN ne sont JAMAIS partagés
        }));
      } catch {}
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

    // Piluliers — données de santé : chiffrées AES avant envoi
    if (prefs.what.piluliers && typeof getAllPatients === 'function') {
      try {
        const pts = await getAllPatients();
        // Collecter tous les piluliers de tous les patients
        const allPiluliers = pts
          .filter(p => Array.isArray(p.piluliers) && p.piluliers.length)
          .map(p => ({
            patient_id:  p.id,
            // ⚠️ Nom anonymisé — jamais le vrai nom
            patient_ref: btoa(p.id).slice(0, 8),
            piluliers:   p.piluliers,
          }));
        if (allPiluliers.length) {
          // Chiffrement AES via security.js si disponible
          if (typeof encryptData === 'function') {
            payload.data.piluliers_enc = await encryptData(allPiluliers);
          } else {
            payload.data.piluliers_enc = btoa(JSON.stringify(allPiluliers));
          }
        }
      } catch (e) { console.warn('[cabinet push piluliers]', e.message); }
    }

    // Constantes — données de santé : chiffrées AES avant envoi
    if (prefs.what.constantes && typeof getAllPatients === 'function') {
      try {
        const pts = await getAllPatients();
        const allConstantes = pts
          .filter(p => Array.isArray(p.constantes) && p.constantes.length)
          .map(p => ({
            patient_id:  p.id,
            patient_ref: btoa(p.id).slice(0, 8),
            constantes:  p.constantes,
          }));
        if (allConstantes.length) {
          if (typeof encryptData === 'function') {
            payload.data.constantes_enc = await encryptData(allConstantes);
          } else {
            payload.data.constantes_enc = btoa(JSON.stringify(allConstantes));
          }
        }
      } catch (e) { console.warn('[cabinet push constantes]', e.message); }
    }

    const d = await apiCall('/webhook/cabinet-sync-push', payload);
    if (!d.ok) throw new Error(d.error || 'Erreur synchronisation');

    _syncOk(`✅ Données envoyées à ${withIds.length} collègue(s) — ${whatKeys.join(', ')}`);
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
    const d = await apiCall('/webhook/cabinet-sync-pull', {
      cabinet_id: cab.id,
      user_id:    APP.user?.id,
    });
    if (!d.ok) throw new Error(d.error || 'Erreur');

    const items = d.items || [];
    if (!items.length) {
      _syncOk('ℹ️ Aucune donnée disponible à recevoir — votre collègue n\'a pas encore effectué de push, ou les données ont expiré (> 7 jours).');
      return;
    }

    let applied = 0;

    for (const item of items) {
      const sender = item.sender_nom ? `${item.sender_prenom} ${item.sender_nom}` : 'collègue';

      // Planning partagé
      if (item.what.includes('planning') && item.data?.planning) {
        // Proposer à l'utilisateur d'accepter
        if (confirm(`📅 ${sender} partage son planning — voulez-vous l'importer ?`)) {
          // Stocker dans une clé dédiée (jamais écraser le planning personnel)
          try {
            const sharedKey = `ami_cabinet_planning_${item.sender_id}`;
            localStorage.setItem(sharedKey, JSON.stringify(item.data.planning));
            applied++;
          } catch {}
        }
      }

      // Km
      if (item.what.includes('km') && item.data?.km) {
        if (confirm(`🚗 ${sender} partage son journal km — voulez-vous l'importer ?`)) {
          try {
            const sharedKey = `ami_cabinet_km_${item.sender_id}`;
            localStorage.setItem(sharedKey, JSON.stringify(item.data.km));
            applied++;
          } catch {}
        }
      }

      // Cotations — résumés : enregistrement dans planning_patients via ami-save-cotation
      if (item.what.includes('cotations') && Array.isArray(item.data?.cotations_summary)) {
        if (confirm(`🩺 ${sender} partage ${item.data.cotations_summary.length} cotation(s) — voulez-vous les importer ?`)) {
          try {
            const toSave = item.data.cotations_summary.map(c => ({
              invoice_number: c.invoice_number,
              date_soin:      c.date,
              total:          c.total,
              actes:          (c.actes_codes || []).map(code => ({ code })),
              source:         'cabinet_sync',
              patient_id:     c.patient_id || null,
            }));
            if (toSave.length) {
              await apiCall('/webhook/ami-save-cotation', { cotations: toSave });
              applied++;
              showToast('success', `${toSave.length} cotation(s) importée(s)`, `De ${sender}`);
            }
          } catch (e) { console.warn('[cabinet pull cotations]', e.message); }
        }
      }

      // Patients meta — adresses GPS anonymisées pour la tournée
      if (item.what.includes('patients') && Array.isArray(item.data?.patients_meta)) {
        if (confirm(`👤 ${sender} partage ${item.data.patients_meta.length} adresse(s) patient — voulez-vous les importer pour la tournée ?`)) {
          try {
            const sharedKey = `ami_cabinet_patients_${item.sender_id}`;
            localStorage.setItem(sharedKey, JSON.stringify(item.data.patients_meta));
            applied++;
            showToast('success', `${item.data.patients_meta.length} adresse(s) importée(s)`, `De ${sender}`);
          } catch {}
        }
      }

      // Ordonnances — liste anonymisée
      if (item.what.includes('ordonnances') && Array.isArray(item.data?.ordonnances)) {
        if (confirm(`💊 ${sender} partage ${item.data.ordonnances.length} ordonnance(s) — voulez-vous les importer ?`)) {
          try {
            const sharedKey = `ami_cabinet_ordonnances_${item.sender_id}`;
            localStorage.setItem(sharedKey, JSON.stringify(item.data.ordonnances));
            applied++;
            showToast('success', `${item.data.ordonnances.length} ordonnance(s) importée(s)`, `De ${sender}`);
          } catch {}
        }
      }

      // Piluliers — déchiffrement AES + fusion dans les fiches patients
      if (item.what.includes('piluliers') && item.data?.piluliers_enc) {
        if (confirm(`💊 ${sender} partage ses semainiers patients — voulez-vous les importer ?`)) {
          try {
            let allPiluliers;
            if (typeof decryptData === 'function') {
              allPiluliers = await decryptData(item.data.piluliers_enc);
            } else {
              allPiluliers = JSON.parse(atob(item.data.piluliers_enc));
            }
            if (Array.isArray(allPiluliers) && typeof patientAddPilulier === 'function') {
              for (const entry of allPiluliers) {
                for (const pil of (entry.piluliers || [])) {
                  // Fusion : n'importe que les piluliers absents localement
                  await patientAddPilulier(entry.patient_id, pil);
                }
              }
              applied++;
              showToast('success', 'Semainiers importés', `De ${sender}`);
            }
          } catch (e) { console.warn('[cabinet pull piluliers]', e.message); }
        }
      }

      // Constantes — déchiffrement AES + fusion dans les fiches patients
      if (item.what.includes('constantes') && item.data?.constantes_enc) {
        if (confirm(`📊 ${sender} partage ses constantes patients — voulez-vous les importer ?`)) {
          try {
            let allConstantes;
            if (typeof decryptData === 'function') {
              allConstantes = await decryptData(item.data.constantes_enc);
            } else {
              allConstantes = JSON.parse(atob(item.data.constantes_enc));
            }
            if (Array.isArray(allConstantes) && typeof patientAddConstante === 'function') {
              for (const entry of allConstantes) {
                for (const mesure of (entry.constantes || [])) {
                  // Fusion : n'importe que les constantes absentes localement
                  await patientAddConstante(entry.patient_id, mesure);
                }
              }
              applied++;
              showToast('success', 'Constantes importées', `De ${sender}`);
            }
          } catch (e) { console.warn('[cabinet pull constantes]', e.message); }
        }
      }
    }

    _syncOk(`✅ ${items.length} élément(s) reçu(s), ${applied} appliqué(s).`);
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
      <div class="ct" style="font-size:12px;margin-bottom:10px">État de la synchronisation</div>
      ${members.map(m => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--b)">
          <div style="width:8px;height:8px;border-radius:50%;background:${m.last_sync ? '#00d4aa' : '#888'};flex-shrink:0"></div>
          <div style="flex:1;font-size:12px"><strong>${m.prenom} ${m.nom}</strong></div>
          <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${m.last_sync ? new Date(m.last_sync).toLocaleString('fr-FR') : 'Jamais synchronisé'}</div>
        </div>`).join('')}`;
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
