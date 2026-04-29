/* ════════════════════════════════════════════════
   auth.js — AMI NGAP v4.0
   ────────────────────────────────────────────────
   Authentification & gestion de session
   - login() / register() / logout()
   - checkAuth() — vérifie la session au chargement
   - showApp() / showAuthOv() / showAdm()
   - switchTab() — bascule connexion ↔ inscription
   - goToApp() — retour app depuis panel admin
   ────────────────────────────────────────────────
   v4.0 — Ajouts :
   - RBAC client (miroir du worker)
   - Prescripteurs : loadPrescripteurs() / addPrescripteur()
   - Numéro de facture : displayInvoiceNumber()
   - Admin : masquage prescripteur + invoice number (RGPD)
   - Map : refreshMapSize() + invalidateSize() auto
════════════════════════════════════════════════ */

/* ── RBAC côté client ────────────────────────────
   Miroir des permissions worker.js.
   Sert UNIQUEMENT à adapter l'UI (afficher/masquer).
   Toute action sensible est re-validée par le backend.
─────────────────────────────────────────────── */
const CLIENT_PERMISSIONS = {
  nurse: ['create_invoice','view_own_data','import_calendar','manage_tournee','change_password','delete_account','manage_prescripteurs','export_data'],
  admin: ['block_user','unblock_user','delete_user','view_stats','view_logs','view_users_list','export_data']
  // ⚠️ 'view_patient_data' intentionnellement absent du rôle admin
};
function clientHasPermission(permission){
  const role = S?.role || 'nurse';
  return (CLIENT_PERMISSIONS[role] || []).includes(permission);
}

/* ── IDLE TIMEOUT v2 — déconnexion auto contextuelle ───────────
   RGPD/HDS : sessions de données de santé non persistantes au-delà
   d'une période d'inactivité raisonnable.

   ⚡ Design context-aware (validé avec retour terrain) :
   ──────────────────────────────────────────────────────────────
   1. Tournée ACTIVE (APP.uberPatients contient des patients non visités)
        → idle DÉSACTIVÉ. L'infirmière conduit, le téléphone est en poche,
          le risque de vol est faible et l'interruption serait critique.
   2. Mode VOCAL actif (voicebtn.listening)
        → idle DÉSACTIVÉ. Pas de DOM events pendant les commandes vocales,
          le timer expirerait à tort.
   3. PIN OFFLINE configuré (offlineAuth.hasPIN)
        → après 30 min d'inactivité, ÉCRAN PIN (pas de logout). La session
          est préservée, l'utilisateur saisit son PIN 4 chiffres et reprend
          en 2 secondes.
   4. Aucun PIN, aucune tournée, aucune voix
        → logout complet après 30 min (force l'utilisateur à reconfigurer
          son PIN pour la prochaine fois).

   ⚡ Heartbeat manuel : d'autres modules (sync, vocal navigation, GPS)
      peuvent appeler `window._amiIdleTouch()` pour reset le timer
      sans simuler un événement DOM.

   Désactivation totale (debug uniquement) : window.AMI_DISABLE_IDLE = true
   Forcer le timeout pour test : window.AMI_FORCE_IDLE = true (déclenche
      l'expiration immédiatement sans reset).
   Override du délai (ms) : window.AMI_IDLE_TIMEOUT_MS = 60_000 (ex: 1 min)

   Ajustement du délai par défaut : modifier IDLE_TIMEOUT_MS_DEFAULT.
─────────────────────────────────────────────────────────────── */
const IDLE_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000; // 30 minutes (recommandation santé)
const IDLE_WARNING_MS         = 60 * 1000;       // 60 sec avant expiration → toast d'avertissement
let _amiIdleTimer    = null;
let _amiIdleWarnTimer = null;
let _amiIdleAttached = false;
let _amiIdleHandling = false; // évite le re-entrée pendant le PIN unlock

function _amiIdleTimeoutMs() {
  const override = Number(window.AMI_IDLE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : IDLE_TIMEOUT_MS_DEFAULT;
}

function _amiIsActiveTournee() {
  try {
    const list = (window.APP?.get ? APP.get('uberPatients') : null) || (window.APP?.uberPatients);
    if (!Array.isArray(list) || list.length === 0) return false;
    // Tournée considérée active s'il reste au moins un patient non visité
    return list.some(p => !p?.done);
  } catch { return false; }
}

function _amiIsVoiceActive() {
  try {
    const btn = document.getElementById('voicebtn');
    return !!(btn && btn.classList && btn.classList.contains('listening'));
  } catch { return false; }
}

function _amiHasPIN() {
  try {
    return !!(window.offlineAuth && typeof window.offlineAuth.hasPIN === 'function'
              && S?.user?.id && window.offlineAuth.hasPIN(S.user.id));
  } catch { return false; }
}

/* ── Toast warning ────────────────────────────────────────────
   Affiche une notification non-bloquante 60 sec avant le logout.
   - Position : bas-centré, au-dessus du bottom nav (z-index 600)
   - Theme : sombre AMI (#0b0f14 bg, #00d4aa accent)
   - Auto-dismiss : sur click n'importe où dans la page (le click reset
     déjà le timer via les listeners DOM standard) OU à l'expiration
     (l'écran PIN/logout prend le relais).
   - Skip : si tournée/voice active (cohérent avec la logique principale)
─────────────────────────────────────────────────────────────── */
const _AMI_IDLE_TOAST_ID = 'ami-idle-warning-toast';

function _amiHideIdleWarning() {
  const el = document.getElementById(_AMI_IDLE_TOAST_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function _amiShowIdleWarning() {
  // Skip défensif : si l'utilisateur a entre-temps lancé une tournée
  //   ou activé la voix, on ne montre pas le warning.
  if (_amiIsActiveTournee() || _amiIsVoiceActive()) return;
  if (document.getElementById(_AMI_IDLE_TOAST_ID)) return; // déjà affiché

  const wrap = document.createElement('div');
  wrap.id = _AMI_IDLE_TOAST_ID;
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  wrap.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:88px',
    'transform:translateX(-50%)',
    'z-index:600',
    'max-width:min(420px, calc(100vw - 32px))',
    'padding:14px 18px',
    'background:linear-gradient(135deg, #0b0f14 0%, #131a23 100%)',
    'border:1px solid rgba(0,212,170,.45)',
    'border-radius:14px',
    'color:#e6edf3',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'font-size:13px',
    'line-height:1.4',
    'box-shadow:0 12px 40px rgba(0,0,0,.55), 0 0 24px rgba(0,212,170,.18)',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'animation:amiIdleSlideIn .25s ease-out',
    'cursor:pointer',
  ].join(';');
  wrap.innerHTML =
    '<span style="font-size:20px;flex-shrink:0">⏰</span>' +
    '<div style="flex:1;min-width:0">' +
      '<div style="font-weight:600;color:#00d4aa;margin-bottom:2px">Session bientôt expirée</div>' +
      '<div style="font-size:12px;color:#94a3b8">Touchez l\'écran pour rester connecté.</div>' +
    '</div>' +
    '<button type="button" style="flex-shrink:0;background:rgba(0,212,170,.15);border:1px solid rgba(0,212,170,.4);color:#00d4aa;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Je suis là</button>';

  // Inject keyframe (idempotent)
  if (!document.getElementById('ami-idle-toast-anim')) {
    const style = document.createElement('style');
    style.id = 'ami-idle-toast-anim';
    style.textContent = '@keyframes amiIdleSlideIn{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}';
    document.head.appendChild(style);
  }

  // Click n'importe où sur le toast → reset (le bouton hérite du bubbling)
  wrap.addEventListener('click', () => {
    _amiHideIdleWarning();
    _amiIdleReset();
  });

  document.body.appendChild(wrap);
}

function _amiIdleReset() {
  if (window.AMI_DISABLE_IDLE === true) return;
  if (_amiIdleTimer)     { clearTimeout(_amiIdleTimer);     _amiIdleTimer     = null; }
  if (_amiIdleWarnTimer) { clearTimeout(_amiIdleWarnTimer); _amiIdleWarnTimer = null; }
  // Si un toast warning était affiché, le retirer (l'utilisateur a fait
  //   un mouvement → la session est ranimée).
  _amiHideIdleWarning();

  if (window.AMI_FORCE_IDLE === true) {
    queueMicrotask(_amiIdleExpire);
    return;
  }

  const total   = _amiIdleTimeoutMs();
  const warnAt  = Math.max(0, total - IDLE_WARNING_MS);
  // Timer 1 : warning toast (ne s'affiche pas si tournée/voice actif au moment du tick)
  if (warnAt > 0) {
    _amiIdleWarnTimer = setTimeout(_amiShowIdleWarning, warnAt);
  }
  // Timer 2 : expiration effective
  _amiIdleTimer = setTimeout(_amiIdleExpire, total);
}

// Hook public : permet aux modules sans interaction DOM (sync, vocal, GPS)
// de signaler une activité utilisateur et reset le timer.
window._amiIdleTouch = _amiIdleReset;

async function _amiIdleExpire() {
  if (_amiIdleHandling) return;
  if (!S?.token) return;

  // Le toast warning est remplacé par le flow d'expiration (PIN ou logout)
  _amiHideIdleWarning();

  // 1. Tournée active ou voice active → on diffère, on ne déconnecte pas
  if (_amiIsActiveTournee() || _amiIsVoiceActive()) {
    console.info('[AMI] Idle reporté — tournée/voice actif.');
    _amiIdleReset(); // ré-arme pour le prochain cycle
    return;
  }

  _amiIdleHandling = true;

  // 2. PIN configuré → unlock screen plutôt que logout (fast resume offline-first)
  if (_amiHasPIN() && typeof window.offlineAuth?.showUnlockScreen === 'function') {
    console.info('[AMI] Idle — PIN unlock requis.');
    try {
      const sess = await window.offlineAuth.showUnlockScreen();
      if (sess) {
        // PIN OK → on reprend la session (potentiellement rafraîchie offline)
        ss.save(sess.token, sess.role, sess.user, sess.dataKey || null);
        if (typeof initSecurity === 'function') initSecurity(sess.token);
        _amiIdleHandling = false;
        _amiIdleReset();
        return;
      }
      // sess === null → l'utilisateur a cliqué "Utiliser un autre compte"
      // → on bascule sur le logout standard ci-dessous
    } catch (e) { console.warn('[AMI] PIN unlock KO:', e); }
  }

  // 3. Pas de PIN (ou refus du PIN) → logout complet
  console.info('[AMI] Idle timeout — logout auto.');
  try {
    if (typeof showM === 'function') {
      try { showM('msg-pilot', 'Session expirée après inactivité prolongée. Reconnexion requise.', 'i'); } catch {}
    }
    if (typeof logout === 'function') logout();
  } catch (e) { console.warn('[AMI] Idle logout KO:', e); }
  _amiIdleHandling = false;
}

function _amiIdleAttach() {
  if (_amiIdleAttached) return;
  _amiIdleAttached = true;
  const events = ['mousedown','keydown','touchstart','scroll','click','wheel'];
  events.forEach(ev => {
    document.addEventListener(ev, _amiIdleReset, { passive: true, capture: true });
  });
  // Visibility change : reset le timer quand l'onglet redevient visible
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) _amiIdleReset();
  });
  _amiIdleReset();
}

function _amiIdleDetach() {
  if (_amiIdleTimer)     { clearTimeout(_amiIdleTimer);     _amiIdleTimer     = null; }
  if (_amiIdleWarnTimer) { clearTimeout(_amiIdleWarnTimer); _amiIdleWarnTimer = null; }
  _amiHideIdleWarning();
  _amiIdleHandling = false;
  // On laisse les listeners attachés (rallumage automatique au prochain login)
}


/* ── AUTH ─────────────────────────────────────── */
async function checkAuth(){
  /* Vérifier consentement RGPD avant tout */ 
  if(typeof checkConsent==='function' && !checkConsent()) return;
  const session = ss.load();
  if(session && session.token){
    S = session; // hydratation obligatoire avant showApp()
    if(typeof initSecurity==='function') initSecurity(S.token);
    showApp();
    return;
  }

  /* ── Boot hors-ligne : session absente mais creds offline valides ?
     On propose direct l'écran PIN sans passer par login classique. ──── */
  if (!navigator.onLine && window.offlineAuth) {
    const info = window.offlineAuth.getLastUserInfo();
    if (info && info.session_valid) {
      const sess = await window.offlineAuth.showUnlockScreen();
      if (sess) {
        ss.save(sess.token, sess.role, sess.user, sess.dataKey||null);
        if (typeof initSecurity === 'function') initSecurity(sess.token);
        window.APP = window.APP || {};
        window.APP._offlineRestored = true;
        if (typeof wpost === 'function') window.offlineAuth.installOnlineRefresh(wpost);
        window.offlineAuth.showOfflineBadge();
        showApp();
        if (typeof initCabinet === 'function') setTimeout(() => initCabinet(), 300);
        return;
      }
    }
  }

  ss.clear();
  showAuthOv();
}
function showAuthOv(){$('auth-ov').classList.remove('hide');$('adm').classList.remove('show');$('app').style.display='none';}
function showAdm(){$('auth-ov').classList.add('hide');$('adm').classList.add('show');$('app').style.display='none';loadAdm();if(typeof loadSystemHealth==='function')loadSystemHealth();}
function goToApp(){$('adm').classList.remove('show');$('app').style.display='grid';updateNavMode();}
function showApp(){
  if(!S?.token){ const session = ss.load(); if(session) S = session; }
  $('auth-ov').classList.add('hide');$('adm').classList.remove('show');$('app').style.display='grid';
  const u=S?.user||{};
  $('uname').textContent=((u.prenom||'')+' '+(u.nom||'')).trim()||u.email||'—';
  if($('sess-inf'))$('sess-inf').textContent=(u.email||'')+' · session active';
  $('voicebtn').classList.add('show');
  updateNavMode();

  // ⚡ RGPD/HDS — Démarrage de l'idle timeout (15 min d'inactivité → logout auto).
  //   _amiIdleAttach() est idempotent : appelé plusieurs fois (login, retour
  //   admin → app, etc.), il n'attache les listeners qu'une seule fois.
  try { _amiIdleAttach(); } catch (e) { console.warn('[AMI] Idle attach KO:', e); }

  const isAdmin = S?.role==='admin';

  if(isAdmin){
    /* ── MODE ADMIN : données patients masquées (RGPD/HDS) ────────── */
    // Afficher bloc badge+déco admin, masquer les contrôles normaux
    const admCtrl = $('admin-header-controls');
    if(admCtrl) admCtrl.style.display='flex';
    const btnLogoutNormal = $('btn-logout-normal');
    if(btnLogoutNormal) btnLogoutNormal.style.display='none';
    // Classe admin-active sur le header pour le layout mobile
    const topBar = document.querySelector('.top');
    if(topBar) topBar.classList.add('admin-active');

    // ── Mobile : afficher nom admin dans header, masquer btn-profil normal ──
    if(window.innerWidth <= 768) {
      // Masquer le btn-profil normal (remplacé par pill admin)
      const btnProfilNormal = $('btn-profil');
      if(btnProfilNormal) btnProfilNormal.style.display='none';
      // Injecter pill nom admin dans admin-header-controls (une seule fois)
      if(!document.getElementById('mobile-admin-name')) {
        const u2 = S?.user || {};
        const nomAdmin = ((u2.prenom||'')+' '+(u2.nom||'')).trim() || 'Admin';
        const namePill = document.createElement('button');
        namePill.id = 'mobile-admin-name';
        namePill.onclick = () => { if(typeof openPM==='function') openPM(); };
        namePill.style.cssText = 'background:rgba(255,95,109,.1);border:1px solid rgba(255,95,109,.25);color:#FF7A85;font-family:var(--fm);font-size:11px;font-weight:700;padding:4px 11px;border-radius:20px;cursor:pointer;white-space:nowrap;flex-shrink:0';
        namePill.textContent = nomAdmin;
        const admCtrl2 = $('admin-header-controls');
        const boutBtn = admCtrl2?.querySelector('.bout');
        if(boutBtn) admCtrl2.insertBefore(namePill, boutBtn);
        else if(admCtrl2) admCtrl2.appendChild(namePill);
      }
    }

    $('admin-cot-notice').style.display='none';
    $('priv-cot').style.display='';
    // ⚠️ Ne forcer display:flex que sur les éléments de navigation/UI,
    // JAMAIS sur les sections .view (elles ont leur propre display géré par navTo)
    document.querySelectorAll('.nurse-only').forEach(el => {
      if (!el.classList.contains('view')) {
        el.style.display = 'flex';
      }
    });
    /* ── MODE ADMIN : accès fonctionnel complet pour tester l'application ──
       L'admin ne voit QUE ses propres données (base IndexedDB isolée par userId).
       Les données des infirmières sont physiquement inaccessibles (bases séparées).
       L'admin peut saisir ses propres patients de test, utiliser toutes les fonctions
       exactement comme une infirmière, pour valider et démontrer l'application.
       Isolation garantie par _getDBName() → ami_patients_db_<userId>.
    ────────────────────────────────────────────────────────────────────────── */
    // Pré-remplir date pour test fonctionnel
    const fds=$('f-ds'); if(fds)fds.value=new Date().toISOString().split('T')[0];
    // Pré-remplir f-hs avec l'heure actuelle SAUF si une cotation est en cours d'édition
    const fhs=$('f-hs');
    const _hsEditMode = !!(window._editingCotation &&
      (window._editingCotation.invoice_number || window._editingCotation.cotationIdx != null));
    if(fhs && !fhs.value && !_hsEditMode) {
      const now=new Date();
      fhs.value=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
    }
    // Charger les prescripteurs (fonctionnel en mode admin)
    loadPrescripteurs();

    // ── Notices admin pour toutes les sections accessibles ──
    ['dash-admin-notice','copilote-admin-notice','sig-admin-notice','his-admin-notice'].forEach(id => {
      const el = $(id); if(el) el.style.display = 'flex';
    });

    // ── Rebrancher onclick pour copilote et stats (nurse-only mais accessibles admin) ──
    ['dash','copilote','ngap-ref','rapport','sig','tur','live','imp','pla','his','patients','tresor','outils-ordos','outils-km','cabinet',
     'transmissions','constantes','compte-rendu','pilulier','bsi','consentements','alertes-med','audit-cpam'].forEach(v => {
      const ni = document.querySelector(`.ni[data-v="${v}"]`);
      if (ni) {
        ni.classList.remove('nurse-only');
        ni.style.display = 'flex'; // forcer visible (était nurse-only donc potentiellement masqué)
        ni.onclick = () => navTo(v, null);
      }
    });

    // ── Initialiser le Copilote immédiatement (HTML déjà dans le DOM) ──
    setTimeout(() => {
      if (typeof initCopiloteSection === 'function') initCopiloteSection();
    }, 200);
    // Boutons "Mon compte" + "Panneau admin" dans la sidebar (créés une seule fois)
    if(!$('btn-goto-admin')){
      const slLast = document.querySelector('.side .sl:last-child');

      // Bouton "Panneau admin"
      const liAdmin=document.createElement('div');
      liAdmin.className='ni';liAdmin.id='btn-goto-admin';
      liAdmin.innerHTML='<span class="nic">⚙️</span> Panneau admin';
      liAdmin.style.cssText='color:var(--d);background:rgba(255,95,109,.08);border:1px solid rgba(255,95,109,.2);margin:4px 14px 8px;border-radius:var(--r);';
      liAdmin.onclick=()=>{$('app').style.display='none';$('adm').classList.add('show');loadAdm();if(typeof loadSystemHealth==='function')loadSystemHealth();};

      // Bouton "Mon compte" (au-dessus du panneau admin)
      const liCompte=document.createElement('div');
      liCompte.className='ni';liCompte.id='btn-goto-compte';
      const u=S?.user||{};
      const nom=((u.prenom||'')+' '+(u.nom||'')).trim()||'Mon compte';
      liCompte.innerHTML=`<span class="nic">👤</span> ${nom}`;
      liCompte.style.cssText='color:var(--a);background:rgba(0,212,170,.06);border:1px solid rgba(0,212,170,.15);margin:8px 14px 4px;border-radius:var(--r);';
      liCompte.onclick=()=>{ if(typeof openPM==='function') openPM(); };

      // Insérer : Mon compte en premier, Panneau admin en second
      slLast?.prepend(liAdmin);   // admin en bas
      slLast?.prepend(liCompte);  // compte au-dessus

      // nav-cabinet-item est déjà dans le HTML statique (section Système)
      // On s'assure juste qu'il est visible pour l'admin
      const _cabNavStatic = $('nav-cabinet-item');
      if (_cabNavStatic) {
        _cabNavStatic.classList.remove('nurse-only');
        _cabNavStatic.onclick = () => { if (typeof navTo === 'function') navTo('cabinet', _cabNavStatic); };
      }

      // ── Mobile : injecter bouton Panneau admin dans le menu Plus ──
      const _injectAdminMobile = () => {
        if(document.getElementById('btn-goto-admin-mobile')) return;
        const mobileGrid = document.querySelector('#mobile-menu > div');
        if(!mobileGrid){ setTimeout(_injectAdminMobile, 100); return; }

        // Bouton "Profil" — juste avant Admin
        if (!document.getElementById('btn-profil-mobile')) {
          const btnProfilM = document.createElement('button');
          btnProfilM.id = 'btn-profil-mobile';
          btnProfilM.className = 'bn-item';
          btnProfilM.style.cssText = 'background:var(--s);border:1px solid var(--b);border-radius:12px;padding:12px 4px;height:auto;flex:none';
          btnProfilM.innerHTML = '<span class="bn-ic">👤</span>Profil';
          btnProfilM.onclick = () => { if(typeof openPM==='function') openPM(); if(typeof toggleMobileMenu==='function') toggleMobileMenu(); };
          const btnQuitter0 = mobileGrid.querySelector('[onclick*="logout"]');
          if(btnQuitter0) mobileGrid.insertBefore(btnProfilM, btnQuitter0);
          else mobileGrid.appendChild(btnProfilM);
        }

        // Bouton "Panneau admin" — juste après Profil, avant Quitter
        const btnAdminM = document.createElement('button');
        btnAdminM.id = 'btn-goto-admin-mobile';
        btnAdminM.className = 'bn-item';
        btnAdminM.style.cssText = 'background:rgba(255,95,109,.08);border:1px solid rgba(255,95,109,.2);border-radius:12px;padding:12px 4px;height:auto;flex:none;color:var(--d)';
        btnAdminM.innerHTML = '<span class="bn-ic">⚙️</span>Admin';
        btnAdminM.onclick = () => {
          document.getElementById('app').style.display='none';
          document.getElementById('adm').classList.add('show');
          if(typeof loadAdm==='function') loadAdm();
          if(typeof loadSystemHealth==='function') loadSystemHealth();
          if(typeof toggleMobileMenu==='function') toggleMobileMenu();
        };
        const btnQuitter = mobileGrid.querySelector('[onclick*="logout"]');
        if(btnQuitter) mobileGrid.insertBefore(btnAdminM, btnQuitter);
        else mobileGrid.appendChild(btnAdminM);

        // Rendre nurse-only visibles pour l'admin (copilote, rapport, contact, sig, tournée…)
        // 'cabinet' inclus pour permettre aux admins de tester le mode cabinet
        ['copilote','rapport','contact','sec','tur','live','imp','pla','his','patients','tresor','outils-ordos','outils-km','dash','cabinet',
         'transmissions','constantes','compte-rendu','pilulier','bsi','consentements','alertes-med','audit-cpam'].forEach(v => {
          const btn = mobileGrid.querySelector(`.bn-item[data-v="${v}"]`);
          if(btn) btn.classList.remove('nurse-only');
        });
      };
      setTimeout(_injectAdminMobile, 200);
    }
  } else {
    /* ── MODE INFIRMIÈRE ─────────────────────────────────────────── */
    const admCtrl = $('admin-header-controls');
    if(admCtrl) admCtrl.style.display='none';
    const btnLogoutNormal = $('btn-logout-normal');
    if(btnLogoutNormal) btnLogoutNormal.style.display='';
    // Retirer la classe admin-active du header
    const topBar = document.querySelector('.top');
    if(topBar) topBar.classList.remove('admin-active');
    $('admin-cot-notice').style.display='none';
    $('priv-cot').style.display='';
    $('btn-profil').style.display='';
    const prescSec=$('prescripteur-section');
    if(prescSec) prescSec.style.display='';
    const invSec=$('invoice-number-section');
    if(invSec) invSec.style.display='';
    // Charger la liste des prescripteurs
    loadPrescripteurs();

    // ── Le lien cabinet est dans le HTML statique (section Système)
    // Il est nurse-only donc visible automatiquement côté infirmière ──
    // ── Le bouton Cabinet du menu mobile est aussi dans le HTML statique
    // (data-v="cabinet" nurse-only) — plus besoin d'injection dynamique ──
  }

  // Correction Leaflet après changement de layout
  setTimeout(()=>{ if(typeof depMap!=='undefined'&&depMap) depMap.invalidateSize(); },250);

  // ✅ v8.7+ — Pré-charger boot-sync AVANT que les modules individuels lancent
  //   leurs propres pulls. Ça déclenche 1 SEUL fetch /webhook/boot-sync qui
  //   pré-remplit le cache, puis quand patients.js / pilulier.js / etc. font
  //   bootSyncGet('xxx'), ils trouvent le cache déjà rempli (déduplication).
  //   Si /boot-sync n'existe pas (ancien worker), fallback silencieux.
  if (typeof window.bootSyncStart === 'function') {
    window.bootSyncStart().catch(() => {});
  }

  // Dispatcher l'event de login pour les modules qui en dépendent (copilote, etc.)
  setTimeout(()=>{ document.dispatchEvent(new CustomEvent('ami:login', { detail: { role: S?.role } })); }, 150);
}
function switchTab(t){['l','r'].forEach(x=>{$('tab-'+x).classList.toggle('on',x===t);$('pan-'+x).style.display=x===t?'block':'none';});hideM('le','re','ro');}
async function login(){
  hideM('le');const em=sanitize(gv('l-em')),pw=gv('l-pw');
  if(!em||!pw){showM('le','Email et mot de passe requis.');return;}
  ld('btn-l',true);
  try{
    /* ⚡ MFA TOTP DÉSACTIVÉ — login direct email + mot de passe (pas de device_token,
       pas de challenge, pas d'enrôlement). */
    const d = await wpost('/webhook/auth-login', { email: em, password: pw });
    if(!d.ok)throw new Error(d.error||'Identifiants incorrects');

    /* ⚡ MFA TOTP DÉSACTIVÉ (sur demande utilisateur)
       Le worker ne renvoie plus jamais mfa_setup_required ni mfa_required.
       Les modales _showMfaSetupModal / _showMfaChallengeModal restent en place
       (pas appelées) pour réactivation future éventuelle. */
    // if (d.mfa_setup_required) { ... await _showMfaSetupModal(d); ... return; }
    // if (d.mfa_required)       { ... await _showMfaChallengeModal(d); ... return; }

    /* ── Isolation RGPD : fermer la session précédente en mémoire ──
       APP.importedData et uberPatients sont des données de session (tournée du jour),
       pas des données persistantes — elles sont remises à zéro à chaque login.
       Les données patients IndexedDB (carnet, signatures) restent intactes sur l'appareil.
       On ferme juste la connexion à la DB de l'utilisateur précédent pour
       forcer l'ouverture de la bonne base (ami_patients_db_<userId>) au prochain accès.
    ───────────────────────────────────────────────────────────────────────────────────── */
    APP.importedData = null;
    APP.uberPatients = [];
    APP.startPoint   = null;
    APP.nextPatient  = null;
    /* Fermer (sans supprimer) la connexion IDB de l'utilisateur précédent */
    if (typeof _patientsDB !== 'undefined' && _patientsDB) {
      try { _patientsDB.close(); } catch(_) {}
      _patientsDB = null;
      if (typeof _patientsDBUserId !== 'undefined') _patientsDBUserId = null;
    }
    if (typeof _sigDB !== 'undefined' && _sigDB) {
      try { _sigDB.close(); } catch(_) {}
      _sigDB = null;
      if (typeof _sigDBUserId !== 'undefined') _sigDBUserId = null;
    }
    if (typeof _pilulierDB !== 'undefined' && _pilulierDB) {
      try { _pilulierDB.close(); } catch(_) {}
      _pilulierDB = null;
      if (typeof _pilulierDBUserId !== 'undefined') _pilulierDBUserId = null;
    }
    if (typeof _constDB !== 'undefined' && _constDB) {
      try { _constDB.close(); } catch(_) {}
      _constDB = null;
      if (typeof _constDBUserId !== 'undefined') _constDBUserId = null;
    }

    ss.save(d.token,d.role,d.user,d.data_key||null);
    /* ── Sécurité RGPD : chiffrement + audit ── */
    if(typeof initSecurity==='function') initSecurity(d.token);
    /* ⚡ RGPD/HDS — flusher tout consentement accepté hors-ligne (avant login)
       vers la table rgpd_consents pour traçabilité audit-ready. Best-effort. */
    if (typeof flushPendingConsent === 'function') flushPendingConsent().catch(() => {});

    /* ── Mode hors-ligne : création PIN au 1er login, ou refresh des creds ── */
    if (window.offlineAuth) {
      ld('btn-l', false);
      try {
        const alreadyHasPin = window.offlineAuth.hasPIN(d.user.id);
        if (!alreadyHasPin) {
          // 1er login sur cet appareil → PIN obligatoire pour activer le mode offline
          const pin = await window.offlineAuth.showPinCreationModal();
          if (pin) {
            await window.offlineAuth.saveCredentials(d.user, d.token, d.role, pin, d.data_key||null);
          }
        } else {
          // PIN déjà configuré → on ne peut pas rechiffrer sans connaître le PIN,
          // mais on peut rafraîchir last_online_check (expire_at repoussé de 7j)
          window.offlineAuth.touchLastOnlineCheck(d.user.id);
        }
      } catch (offErr) {
        console.warn('[auth] PIN setup skipped:', offErr?.message);
      }
      ld('btn-l', true);
    }

    showApp();
    /* ── Initialiser le cabinet (mode multi-IDE) ── */
    if (typeof initCabinet === 'function') setTimeout(() => initCabinet(), 300);
    /* ⚡ RGPD/HDS — Migration legacy → AES en arrière-plan (idempotente).
       Au 1er login post-déploiement de #7, toutes les fiches IDB encore en
       format base64 obfusqué seront re-chiffrées en AES-256-GCM. Aux logins
       suivants, le marqueur localStorage skip immédiatement. */
    if (typeof window !== 'undefined' && typeof window._migrateLegacyToAES === 'function') {
      setTimeout(() => { window._migrateLegacyToAES().catch(() => {}); }, 3000);
    }
  }catch(e){
    /* ── Fallback offline : si pas de réseau ET session offline existante pour ce user ── */
    if (!navigator.onLine && window.offlineAuth) {
      const lastInfo = window.offlineAuth.getLastUserInfo();
      if (lastInfo && lastInfo.email && lastInfo.email.toLowerCase() === em.toLowerCase() && lastInfo.session_valid) {
        ld('btn-l', false);
        const sess = await window.offlineAuth.showUnlockScreen();
        if (sess) {
          ss.save(sess.token, sess.role, sess.user, sess.dataKey||null);
          if (typeof initSecurity === 'function') initSecurity(sess.token);
          window.APP = window.APP || {};
          window.APP._offlineRestored = true;
          if (typeof wpost === 'function') window.offlineAuth.installOnlineRefresh(wpost);
          window.offlineAuth.showOfflineBadge();
          showApp();
          if (typeof initCabinet === 'function') setTimeout(() => initCabinet(), 300);
          return;
        }
      }
      showM('le','📡 Pas de réseau — impossible de se connecter pour la première fois sans internet.');
    } else {
      showM('le', e.message);
    }
  }finally{ld('btn-l',false);}
}
async function register(){
  hideM('re','ro');
  const fn=sanitize(gv('r-fn')),ln=sanitize(gv('r-ln')),em=sanitize(gv('r-em')),pw=gv('r-pw'),pw2=gv('r-pw2');
  if(!fn||!ln){showM('re','Prénom et Nom obligatoires.');return;}
  if(!em){showM('re','Email obligatoire.');return;}
  if(!pw||pw.length<8){showM('re','Mot de passe minimum 8 caractères.');return;}
  if(pw!==pw2){showM('re','Les mots de passe ne correspondent pas.');return;}
  ld('btn-r',true);
  try{
    const d=await wpost('/webhook/infirmiere-register',{prenom:fn,nom:ln,email:em,password:pw,adeli:sanitize(gv('r-ad')),rpps:sanitize(gv('r-rp')),structure:sanitize(gv('r-st'))});
    if(!d.ok)throw new Error(d.error||'Erreur');
    showM('ro','✅ Compte créé ! Vous pouvez vous connecter.','o');
    setTimeout(()=>switchTab('l'),2000);
  }catch(e){showM('re',e.message);}finally{ld('btn-r',false);}
}
function logout(){
  // ⚡ RGPD/HDS — Stop le timer idle pour éviter un logout récursif si le timeout
  //   se déclenche pendant qu'on est déjà en train de logout (ex: confirm offline).
  try { _amiIdleDetach(); } catch {}
  /* ── Option offline : proposer de conserver l'accès PIN ou tout effacer ── */
  if (window.offlineAuth && S?.user?.id && window.offlineAuth.hasPIN(S.user.id)) {
    const keepPin = confirm(
      '🔐 Déconnexion\n\n' +
      'Souhaitez-vous CONSERVER votre PIN sur cet appareil\n' +
      'pour pouvoir vous reconnecter rapidement en mode hors-ligne ?\n\n' +
      '  • OK  = conserver le PIN (reconnexion PIN possible)\n' +
      '  • Annuler = effacer le PIN et la session offline'
    );
    if (!keepPin) {
      window.offlineAuth.clearForUser(S.user.id);
    }
  }
  ss.clear();
  APP.startPoint=null;
  APP.userPos=null;
  APP.importedData=null;
  APP.uberPatients=[];
  // ⚡ Reset complet du cache cabinet au logout. Sans ça, quand un user
  // se déconnecte (ex: Manon) et qu'un autre se connecte (ex: Bastien),
  // les anciens membres restent affichés dans la Tournée IA jusqu'à ce
  // que initCabinet() ait fini son fetch — obligeant l'utilisateur à
  // faire "Clear site data" + Ctrl+Shift+R pour voir les bons membres.
  if (typeof APP.set === 'function') APP.set('cabinet', null);
  APP.cabinet = null;
  // Reset aussi l'état nextPatient (sinon ancien prochain patient visible
  // dans le header pilotage au prochain login avant qu'une nouvelle
  // tournée soit construite).
  if (typeof APP.set === 'function') APP.set('nextPatient', null);
  APP._ideAssignments = {};
  APP._constraintFirst = null;
  APP._constraintSecond = null;
  try { localStorage.removeItem('ami_tournee_km'); } catch {}
  if(typeof stopVoice==='function') stopVoice();
  /* ── Fermer les connexions IndexedDB ouvertes (sans supprimer les données) ──
     Les données patients/signatures restent intactes sur l'appareil.
     La prochaine connexion ouvrira la base correspondant au nouveau user.
  ─────────────────────────────────────────────────────────────────────────── */
  if (typeof _patientsDB !== 'undefined' && _patientsDB) {
    try { _patientsDB.close(); } catch(_) {}
    _patientsDB = null;
    if (typeof _patientsDBUserId !== 'undefined') _patientsDBUserId = null;
  }
  if (typeof _sigDB !== 'undefined' && _sigDB) {
    try { _sigDB.close(); } catch(_) {}
    _sigDB = null;
    if (typeof _sigDBUserId !== 'undefined') _sigDBUserId = null;
  }
  // Fermer les bases pilulier et constantes isolées par userId
  if (typeof _pilulierDB !== 'undefined' && _pilulierDB) {
    try { _pilulierDB.close(); } catch(_) {}
    _pilulierDB = null;
    if (typeof _pilulierDBUserId !== 'undefined') _pilulierDBUserId = null;
  }
  if (typeof _constDB !== 'undefined' && _constDB) {
    try { _constDB.close(); } catch(_) {}
    _constDB = null;
    if (typeof _constDBUserId !== 'undefined') _constDBUserId = null;
  }
  // Dispatcher ami:logout pour les modules qui en ont besoin
  document.dispatchEvent(new CustomEvent('ami:logout'));
  showAuthOv();
  switchTab('l');
  const pw=$('l-pw');if(pw)pw.value='';
  $('voicebtn').classList.remove('show');
}

/* ── PRESCRIPTEURS ──────────────────────────────
   Accessible uniquement au rôle nurse (RBAC).
   Chargement de la liste + ajout d'un médecin.
─────────────────────────────────────────────── */
async function loadPrescripteurs(){
  if(!clientHasPermission('manage_prescripteurs')) return;
  const sel=$('f-prescripteur-select');
  if(!sel) return;
  try{
    const d=await wpost('/webhook/prescripteur-liste',{});
    if(!d.ok||!Array.isArray(d.prescripteurs)) return;
    sel.innerHTML='<option value="">— Médecin prescripteur (sélectionner) —</option>';
    d.prescripteurs.forEach(p=>{
      const opt=document.createElement('option');
      opt.value=p.id;
      opt.textContent=`${p.nom}${p.rpps?' · RPPS '+p.rpps:''}${p.specialite?' · '+p.specialite:''}`;
      sel.appendChild(opt);
    });
    // Synchroniser le champ texte libre si nécessaire
    sel.onchange=()=>{
      const selected=d.prescripteurs.find(p=>p.id===sel.value);
      const fPr=$('f-pr');
      const fPrRp=$('f-pr-rp');
      if(selected){
        if(fPr)  fPr.value=selected.nom||'';
        if(fPrRp)fPrRp.value=selected.rpps||'';
      }
    };
  }catch(e){ console.warn('loadPrescripteurs:',e.message); }
}

async function addPrescripteur(){
  if(!clientHasPermission('manage_prescripteurs')){showM('prescr-msg','Accès non autorisé.');return;}
  const nom       =sanitize(gv('prescr-nom')||'');
  const rpps      =sanitize(gv('prescr-rpps')||'');
  const specialite=sanitize(gv('prescr-spe')||'');
  if(!nom){showM('prescr-msg','Le nom du médecin est obligatoire.');return;}
  ld('btn-add-prescr',true);
  try{
    const d=await wpost('/webhook/prescripteur-add',{nom,rpps,specialite});
    if(!d.ok)throw new Error(d.error||'Erreur');
    showM('prescr-msg',`✅ Dr ${nom} ajouté.`,'o');
    ['prescr-nom','prescr-rpps','prescr-spe'].forEach(id=>{const el=$(id);if(el)el.value='';});
    await loadPrescripteurs();
    const sel=$('f-prescripteur-select');
    if(sel&&d.prescripteur?.id) sel.value=d.prescripteur.id;
  }catch(e){showM('prescr-msg',e.message);}
  finally{ld('btn-add-prescr',false);}
}

/* ── NUMÉRO DE FACTURE ──────────────────────────
   Affiche le numéro retourné par le worker après cotation.
   Ce numéro est généré côté serveur (séquentiel + unique).
   Il est utilisé tel quel par la CPAM — ne jamais le modifier.
─────────────────────────────────────────────── */
function displayInvoiceNumber(invoiceNumber){
  if(!invoiceNumber) return;
  const el=$('invoice-number-display');
  if(el){
    el.textContent=invoiceNumber;
    const section=$('invoice-number-section');
    if(section) section.style.removeProperty('display');
  }
  if(typeof updatePDFInvoiceNumber==='function') updatePDFInvoiceNumber(invoiceNumber);
}

/* ── MAP RESPONSIVE ─────────────────────────────
   Hauteur adaptée via CSS : clamp(220px, 50vh, 520px)
   refreshMapSize() à appeler après tout changement de layout.
─────────────────────────────────────────────── */
function refreshMapSize(){
  setTimeout(()=>{ if(typeof depMap!=='undefined'&&depMap) depMap.invalidateSize(); },200);
}
if(typeof window!=='undefined'){
  window.addEventListener('resize',()=>refreshMapSize());
}

/* ════════════════════════════════════════════════════════════════════════
   🔐 MFA TOTP — Modales d'enrôlement et de challenge
   ────────────────────────────────────────────────────────────────────────
   Ces modales sont déclenchées par login() lorsque le worker renvoie
   mfa_setup_required ou mfa_required. Compatibles smartphone (mobile-first).

   - _showMfaSetupModal : 1ère fois — affiche QR code (via api.qrserver.com),
     secret base32 pour saisie manuelle, deeplink otpauth, input 6 chiffres
     pour confirmer.
   - _showMfaChallengeModal : logins suivants — input 6 chiffres seulement.

   Les deux modales appellent /webhook/auth-mfa-verify avec mfa_temp_token + code.
   En cas de succès : ss.save + showApp + flush consent + migration AES.
   En cas d'échec : message d'erreur + permission de réessayer (compteur côté worker).
═════════════════════════════════════════════════════════════════════════ */

/* Helper : finaliser la session après MFA OK (mêmes étapes que login normal) */
async function _afterMfaSuccess(d) {
  // Reset session précédente IDB
  if (typeof APP !== 'undefined') {
    APP.importedData = null;
    APP.uberPatients = [];
    APP.startPoint   = null;
    APP.nextPatient  = null;
  }
  if (typeof _patientsDB !== 'undefined' && _patientsDB) {
    try { _patientsDB.close(); } catch(_) {}
    _patientsDB = null;
    if (typeof _patientsDBUserId !== 'undefined') _patientsDBUserId = null;
  }
  if (typeof _sigDB !== 'undefined' && _sigDB) {
    try { _sigDB.close(); } catch(_) {}
    _sigDB = null;
    if (typeof _sigDBUserId !== 'undefined') _sigDBUserId = null;
  }
  // Sauvegarde session
  ss.save(d.token, d.role, d.user, d.data_key || null);
  if (typeof initSecurity === 'function') initSecurity(d.token);
  if (typeof flushPendingConsent === 'function') flushPendingConsent().catch(() => {});
  showApp();
  if (typeof initCabinet === 'function') setTimeout(() => initCabinet(), 300);
  if (typeof window !== 'undefined' && typeof window._migrateLegacyToAES === 'function') {
    setTimeout(() => { window._migrateLegacyToAES().catch(() => {}); }, 3000);
  }
}

/* Modale d'ENRÔLEMENT TOTP — 1ère configuration admin OU opt-in nurse.
   Affiche : QR code généré LOCALEMENT (privacy : aucun service externe),
   secret base32, lien otpauth, input de confirmation. À la confirmation,
   affiche les 8 recovery codes (admin uniquement) avant de finaliser le login. */
function _showMfaSetupModal(d) {
  return new Promise((resolve) => {
    const old = document.getElementById('mfa-setup-modal');
    if (old) old.remove();

    // ⚡ Génération QR locale (privacy : le secret ne quitte pas le navigateur)
    let qrSvg = '';
    try {
      if (window._qrCode && d.mfa_otpauth_url) {
        const matrix = window._qrCode.generate(d.mfa_otpauth_url);
        if (matrix) qrSvg = window._qrCode.toSvg(matrix, { scale: 6, margin: 2 });
      }
    } catch (e) { console.warn('[AMI] QR local KO:', e.message); }

    const modal = document.createElement('div');
    modal.id = 'mfa-setup-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:99998;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.92);padding:20px;overflow-y:auto;
    `;
    modal.innerHTML = `
      <div style="background:#0b0f14;border:1px solid rgba(0,212,170,.3);border-radius:16px;
                  padding:24px;max-width:480px;width:100%;color:#e2e8f0;font-family:sans-serif;
                  max-height:90vh;overflow-y:auto">
        <div style="font-size:32px;margin-bottom:8px;text-align:center">🔐</div>
        <h2 style="font-size:20px;margin:0 0 8px;color:#fff;text-align:center">Activation du 2FA</h2>
        <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0 0 16px;text-align:center">
          Scannez ce QR code avec <strong style="color:#e2e8f0">Google Authenticator</strong>,
          <strong style="color:#e2e8f0">Authy</strong> ou <strong style="color:#e2e8f0">1Password</strong>.
        </p>

        <div style="background:#fff;padding:12px;border-radius:12px;margin:0 auto 16px;
                    width:fit-content;display:flex;align-items:center;justify-content:center;
                    min-width:240px;min-height:240px">
          ${qrSvg || '<div style="color:#000;padding:20px;text-align:center;font-size:13px">QR indisponible<br>Utilisez le secret manuel ci-dessous.</div>'}
        </div>

        <details style="margin:0 0 16px;background:rgba(0,212,170,.05);border-radius:8px;padding:10px 14px">
          <summary style="cursor:pointer;font-size:13px;color:#00d4aa">Saisie manuelle / lien direct</summary>
          <div style="margin-top:10px;font-size:12px">
            <div style="color:#94a3b8;margin-bottom:4px">Secret base32 :</div>
            <code style="display:block;background:#000;padding:8px;border-radius:6px;
                         font-family:monospace;font-size:14px;color:#00d4aa;word-break:break-all;
                         user-select:all;cursor:text">${(d.mfa_secret_base32 || '').match(/.{1,4}/g)?.join(' ') || ''}</code>
            <div style="color:#94a3b8;margin:10px 0 4px">Lien otpauth (cliquable sur mobile) :</div>
            <a href="${d.mfa_otpauth_url || '#'}" style="color:#00d4aa;font-size:11px;word-break:break-all">${d.mfa_otpauth_url || ''}</a>
          </div>
        </details>

        <div style="margin:0 0 16px">
          <label style="display:block;font-size:13px;color:#94a3b8;margin-bottom:6px">
            Code à 6 chiffres généré par votre app :
          </label>
          <input id="mfa-setup-code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6"
                 autocomplete="one-time-code" placeholder="000000"
                 style="width:100%;padding:14px;font-size:24px;text-align:center;letter-spacing:8px;
                        background:#000;border:1px solid #1e2d3d;border-radius:10px;color:#fff;
                        box-sizing:border-box;font-family:monospace" />
          <div id="mfa-setup-err" style="display:none;color:#ef4444;font-size:12px;margin-top:8px"></div>
        </div>

        <button id="mfa-setup-confirm"
          style="width:100%;background:#00d4aa;color:#000;border:none;padding:14px;border-radius:10px;
                 font-size:15px;font-weight:700;cursor:pointer;margin-bottom:8px">
          ✅ Activer le 2FA et se connecter
        </button>
        <button id="mfa-setup-cancel"
          style="width:100%;background:transparent;color:#64748b;border:1px solid #1e2d3d;
                 padding:10px;border-radius:10px;font-size:13px;cursor:pointer">
          Annuler
        </button>
      </div>`;
    document.body.appendChild(modal);

    const codeInput = document.getElementById('mfa-setup-code');
    const errEl     = document.getElementById('mfa-setup-err');
    const btnOk     = document.getElementById('mfa-setup-confirm');
    const btnNo     = document.getElementById('mfa-setup-cancel');

    if (codeInput) {
      setTimeout(() => codeInput.focus(), 100);
      codeInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
        if (errEl) errEl.style.display = 'none';
      });
      codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnOk.click();
      });
    }

    btnOk.onclick = async () => {
      const code = (codeInput?.value || '').trim();
      if (!/^\d{6}$/.test(code)) {
        errEl.textContent = 'Saisissez les 6 chiffres affichés par votre application.';
        errEl.style.display = 'block';
        return;
      }
      btnOk.disabled = true;
      btnOk.innerHTML = '<span class="spin"></span> Vérification…';
      try {
        const r = await wpost('/webhook/auth-mfa-verify', {
          temp_token: d.mfa_temp_token,
          code,
        });
        if (!r.ok) throw new Error(r.error || 'Code incorrect');

        // ⚡ Si recovery codes générés (admin), les afficher AVANT de finaliser
        if (Array.isArray(r.recovery_codes) && r.recovery_codes.length > 0) {
          modal.remove();
          const acked = await _showRecoveryCodesModal(r.recovery_codes);
          if (!acked) { resolve(false); return; }
        } else {
          modal.remove();
        }
        await _afterMfaSuccess(r);
        resolve(true);
      } catch (e) {
        errEl.textContent = e.message || 'Erreur — réessayez.';
        errEl.style.display = 'block';
        btnOk.disabled = false;
        btnOk.innerHTML = '✅ Activer le 2FA et se connecter';
        if (codeInput) { codeInput.value = ''; codeInput.focus(); }
      }
    };
    btnNo.onclick = () => { modal.remove(); resolve(false); };
  });
}

/* Modale d'AFFICHAGE des recovery codes — 1 SEULE FOIS après enrôlement.
   L'utilisateur DOIT cocher "j'ai sauvegardé ces codes" pour continuer. */
function _showRecoveryCodesModal(codes) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.id = 'mfa-recovery-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:99998;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.95);padding:20px;overflow-y:auto;
    `;
    const codesHtml = codes.map(c => `<code style="display:block;padding:8px 12px;background:#000;border:1px solid #1e2d3d;border-radius:6px;font-family:monospace;font-size:16px;color:#00d4aa;letter-spacing:2px;text-align:center;margin:4px 0">${c}</code>`).join('');
    modal.innerHTML = `
      <div style="background:#0b0f14;border:2px solid #f59e0b;border-radius:16px;
                  padding:24px;max-width:480px;width:100%;color:#e2e8f0;font-family:sans-serif;
                  max-height:90vh;overflow-y:auto">
        <div style="font-size:32px;margin-bottom:8px;text-align:center">⚠️ 🆘</div>
        <h2 style="font-size:20px;margin:0 0 8px;color:#f59e0b;text-align:center">Codes de récupération</h2>
        <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0 0 16px">
          Ces <strong style="color:#fbbf24">8 codes à usage unique</strong> sont votre seul moyen
          d'accéder à votre compte si vous perdez votre téléphone. <strong style="color:#fbbf24">Sauvegardez-les MAINTENANT</strong>
          (gestionnaire de mots de passe, papier dans un coffre, etc.).
        </p>
        <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);
                    border-radius:8px;padding:12px;margin-bottom:16px;font-size:12px;color:#fbbf24">
          🔒 Ces codes ne seront <strong>plus jamais affichés</strong>. Chacun ne fonctionne qu'une seule fois.
        </div>
        <div style="margin-bottom:16px">${codesHtml}</div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button id="rc-copy" style="flex:1;background:#1e2d3d;color:#e2e8f0;border:none;padding:10px;
                                       border-radius:8px;font-size:13px;cursor:pointer">📋 Copier tous</button>
          <button id="rc-print" style="flex:1;background:#1e2d3d;color:#e2e8f0;border:none;padding:10px;
                                        border-radius:8px;font-size:13px;cursor:pointer">🖨️ Imprimer</button>
        </div>
        <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:#cbd5e1;
                      padding:10px;background:rgba(0,212,170,.05);border-radius:8px;
                      cursor:pointer;margin-bottom:12px">
          <input type="checkbox" id="rc-ack" style="width:18px;height:18px;cursor:pointer" />
          <span>J'ai sauvegardé mes codes en lieu sûr.</span>
        </label>
        <button id="rc-confirm" disabled
          style="width:100%;background:#00d4aa;color:#000;border:none;padding:14px;border-radius:10px;
                 font-size:15px;font-weight:700;cursor:pointer;opacity:.4">
          Continuer
        </button>
      </div>`;
    document.body.appendChild(modal);

    const ackEl  = document.getElementById('rc-ack');
    const okBtn  = document.getElementById('rc-confirm');
    const copyBtn = document.getElementById('rc-copy');
    const printBtn = document.getElementById('rc-print');

    ackEl.addEventListener('change', () => {
      okBtn.disabled = !ackEl.checked;
      okBtn.style.opacity = ackEl.checked ? '1' : '.4';
    });

    copyBtn.onclick = () => {
      const txt = '🔐 AMI NGAP — Recovery Codes (' + new Date().toISOString().slice(0,10) + ')\n\n' + codes.join('\n');
      navigator.clipboard?.writeText(txt).then(() => {
        copyBtn.textContent = '✅ Copié !';
        setTimeout(() => { copyBtn.textContent = '📋 Copier tous'; }, 2000);
      }).catch(() => alert('Copie KO — sélectionnez et copiez manuellement.'));
    };
    printBtn.onclick = () => {
      const w = window.open('', '_blank');
      if (!w) { alert('Pop-up bloquée — autorisez les pop-ups pour imprimer.'); return; }
      w.document.write(`<html><head><title>AMI Recovery Codes</title></head><body style="font-family:monospace;padding:30px">
        <h1>🔐 AMI NGAP — Recovery Codes</h1>
        <p>Date : ${new Date().toLocaleString('fr-FR')}</p>
        <p><strong>Conservez ces codes en lieu sûr — ils ne seront plus affichés.</strong></p>
        <ol style="font-size:18px;letter-spacing:2px">${codes.map(c => `<li>${c}</li>`).join('')}</ol>
      </body></html>`);
      w.document.close(); w.print();
    };

    okBtn.onclick = () => {
      if (!ackEl.checked) return;
      modal.remove();
      resolve(true);
    };
  });
}

/* Modale de CHALLENGE TOTP — logins suivants (admin OU nurse opt-in).
   Inclut : input 6 chiffres, checkbox "trust device 30j", lien "code de récupération".
   Le device_token reçu en cas de succès est stocké en localStorage pour skip MFA futur. */
function _showMfaChallengeModal(d) {
  return new Promise((resolve) => {
    const old = document.getElementById('mfa-challenge-modal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.id = 'mfa-challenge-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:99998;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.92);padding:20px;
    `;
    modal.innerHTML = `
      <div style="background:#0b0f14;border:1px solid rgba(0,212,170,.3);border-radius:16px;
                  padding:32px;max-width:380px;width:100%;color:#e2e8f0;font-family:sans-serif">
        <div style="font-size:32px;margin-bottom:8px;text-align:center">🔐</div>
        <h2 style="font-size:18px;margin:0 0 8px;color:#fff;text-align:center">Code 2FA</h2>
        <p style="font-size:13px;color:#94a3b8;margin:0 0 20px;text-align:center;line-height:1.5">
          Saisissez le code à 6 chiffres affiché par votre application
          <strong style="color:#e2e8f0">Authenticator</strong>.
        </p>

        <div id="mfa-challenge-mode" style="display:flex;gap:6px;margin-bottom:14px;font-size:11px">
          <button id="mfa-mode-totp" type="button"
            style="flex:1;padding:8px;background:rgba(0,212,170,.15);color:#00d4aa;border:1px solid #00d4aa;border-radius:6px;cursor:pointer">
            Code app
          </button>
          <button id="mfa-mode-recovery" type="button"
            style="flex:1;padding:8px;background:transparent;color:#64748b;border:1px solid #1e2d3d;border-radius:6px;cursor:pointer">
            Code de récupération
          </button>
        </div>

        <div id="mfa-totp-block">
          <input id="mfa-challenge-code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6"
                 autocomplete="one-time-code" placeholder="000000"
                 style="width:100%;padding:16px;font-size:28px;text-align:center;letter-spacing:10px;
                        background:#000;border:1px solid #1e2d3d;border-radius:10px;color:#fff;
                        box-sizing:border-box;font-family:monospace;margin-bottom:8px" />
        </div>
        <div id="mfa-recovery-block" style="display:none">
          <input id="mfa-recovery-input" type="text" placeholder="XXXX-XXXX-XX" maxlength="12"
                 style="width:100%;padding:14px;font-size:18px;text-align:center;letter-spacing:2px;
                        background:#000;border:1px solid #1e2d3d;border-radius:10px;color:#fff;
                        box-sizing:border-box;font-family:monospace;margin-bottom:8px;text-transform:uppercase" />
        </div>

        <div id="mfa-challenge-err" style="display:none;color:#ef4444;font-size:12px;margin-bottom:12px;text-align:center"></div>

        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#94a3b8;
                      padding:8px;background:rgba(255,255,255,.02);border-radius:6px;cursor:pointer;margin-bottom:12px">
          <input type="checkbox" id="mfa-trust-device" style="width:16px;height:16px;cursor:pointer" />
          <span>Faire confiance à ce navigateur 30 jours</span>
        </label>

        <button id="mfa-challenge-confirm"
          style="width:100%;background:#00d4aa;color:#000;border:none;padding:14px;border-radius:10px;
                 font-size:15px;font-weight:700;cursor:pointer;margin-bottom:8px">
          Valider
        </button>
        <button id="mfa-challenge-cancel"
          style="width:100%;background:transparent;color:#64748b;border:1px solid #1e2d3d;
                 padding:10px;border-radius:10px;font-size:13px;cursor:pointer">
          Annuler
        </button>
        <p id="mfa-challenge-hint" style="font-size:11px;color:#475569;text-align:center;margin:14px 0 0">
          Le code change toutes les 30 secondes.
        </p>
      </div>`;
    document.body.appendChild(modal);

    const codeInput = document.getElementById('mfa-challenge-code');
    const recInput  = document.getElementById('mfa-recovery-input');
    const errEl     = document.getElementById('mfa-challenge-err');
    const btnOk     = document.getElementById('mfa-challenge-confirm');
    const btnNo     = document.getElementById('mfa-challenge-cancel');
    const trustEl   = document.getElementById('mfa-trust-device');
    const totpBlock = document.getElementById('mfa-totp-block');
    const recBlock  = document.getElementById('mfa-recovery-block');
    const modeTotp  = document.getElementById('mfa-mode-totp');
    const modeRec   = document.getElementById('mfa-mode-recovery');
    const hintEl    = document.getElementById('mfa-challenge-hint');

    let mode = 'totp'; // ou 'recovery'

    function setMode(m) {
      mode = m;
      const isTotp = m === 'totp';
      totpBlock.style.display = isTotp ? '' : 'none';
      recBlock.style.display  = isTotp ? 'none' : '';
      modeTotp.style.cssText = isTotp
        ? 'flex:1;padding:8px;background:rgba(0,212,170,.15);color:#00d4aa;border:1px solid #00d4aa;border-radius:6px;cursor:pointer'
        : 'flex:1;padding:8px;background:transparent;color:#64748b;border:1px solid #1e2d3d;border-radius:6px;cursor:pointer';
      modeRec.style.cssText = !isTotp
        ? 'flex:1;padding:8px;background:rgba(0,212,170,.15);color:#00d4aa;border:1px solid #00d4aa;border-radius:6px;cursor:pointer'
        : 'flex:1;padding:8px;background:transparent;color:#64748b;border:1px solid #1e2d3d;border-radius:6px;cursor:pointer';
      hintEl.textContent = isTotp ? 'Le code change toutes les 30 secondes.' : 'Code à usage unique au format XXXX-XXXX-XX.';
      setTimeout(() => (isTotp ? codeInput : recInput)?.focus(), 50);
    }
    modeTotp.onclick = () => setMode('totp');
    modeRec.onclick  = () => setMode('recovery');

    setTimeout(() => codeInput?.focus(), 100);
    if (codeInput) {
      codeInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
        if (errEl) errEl.style.display = 'none';
        if (e.target.value.length === 6) btnOk.click();
      });
      codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnOk.click(); });
    }
    if (recInput) {
      recInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-F0-9-]/g, '').slice(0, 12);
        if (errEl) errEl.style.display = 'none';
      });
      recInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnOk.click(); });
    }

    btnOk.onclick = async () => {
      const payload = { temp_token: d.mfa_temp_token, trust_device: !!trustEl?.checked };
      if (mode === 'totp') {
        const code = (codeInput?.value || '').trim();
        if (!/^\d{6}$/.test(code)) {
          errEl.textContent = 'Saisissez les 6 chiffres affichés.';
          errEl.style.display = 'block'; return;
        }
        payload.code = code;
      } else {
        const rc = (recInput?.value || '').trim();
        if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{2}$/.test(rc)) {
          errEl.textContent = 'Format attendu : XXXX-XXXX-XX';
          errEl.style.display = 'block'; return;
        }
        payload.recovery_code = rc;
      }
      btnOk.disabled = true;
      btnOk.innerHTML = '<span class="spin"></span> Vérification…';
      try {
        const r = await wpost('/webhook/auth-mfa-verify', payload);
        if (!r.ok) throw new Error(r.error || 'Code incorrect');
        // ⚡ Si trusted device confirmé → stocker token + email en localStorage.
        //    L'email permet à login() de ne renvoyer le token que pour le bon user
        //    (évite qu'un changement d'utilisateur hérite du trust de l'ancien).
        if (r.device_token) {
          try {
            localStorage.setItem('ami_device_token', r.device_token);
            if (r.user && r.user.email) {
              localStorage.setItem('ami_device_token_email', String(r.user.email).toLowerCase().trim());
            }
          } catch {}
        }
        modal.remove();
        await _afterMfaSuccess(r);
        resolve(true);
      } catch (e) {
        errEl.textContent = e.message || 'Erreur — réessayez.';
        errEl.style.display = 'block';
        btnOk.disabled = false;
        btnOk.innerHTML = 'Valider';
        const target = mode === 'totp' ? codeInput : recInput;
        if (target) { target.value = ''; target.focus(); }
      }
    };
    btnNo.onclick = () => { modal.remove(); resolve(false); };
  });
}

/* ════════════════════════════════════════════════════════════════════════
   📱 MINI QR CODE GENERATOR — Pure JS, SVG output
   ────────────────────────────────────────────────────────────────────────
   Encode du texte en QR Code Model 2, niveau d'erreur L (Low ~7%),
   mode Binary 8-bit, Versions 1-10 (jusqu'à 174 chars en mode binaire).
   Suffisant pour les URLs otpauth:// (~80-100 chars typiques).

   Implémentation autonome (pas de dépendance externe), basée sur les specs
   ISO/IEC 18004 et inspirée de l'algorithme de Kazuhiko Arase (MIT).
   Privacy : le secret TOTP ne quitte JAMAIS le navigateur.
═════════════════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  // ── Reed-Solomon GF(256) avec primitive 0x11d ────────────────────────
  const _GF_LOG = new Uint8Array(256);
  const _GF_EXP = new Uint8Array(256);
  (function _gfInit() {
    let x = 1;
    for (let i = 0; i < 255; i++) { _GF_EXP[i] = x; _GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    _GF_EXP[255] = _GF_EXP[0];
  })();
  function _gfMul(a, b) { return a && b ? _GF_EXP[(_GF_LOG[a] + _GF_LOG[b]) % 255] : 0; }

  function _rsGenPoly(degree) {
    let p = [1];
    for (let i = 0; i < degree; i++) {
      const np = new Array(p.length + 1).fill(0);
      for (let j = 0; j < p.length; j++) {
        np[j]     ^= p[j];
        np[j + 1] ^= _gfMul(p[j], _GF_EXP[i]);
      }
      p = np;
    }
    return p;
  }
  function _rsCompute(data, ecLen) {
    const gen = _rsGenPoly(ecLen);
    const ec  = new Array(ecLen).fill(0);
    for (let i = 0; i < data.length; i++) {
      const f = data[i] ^ ec[0];
      ec.shift(); ec.push(0);
      if (f) for (let j = 0; j < ecLen; j++) ec[j] ^= _gfMul(gen[j + 1], f);
    }
    return ec;
  }

  // ── Capacity table : ECC L, mode Binary, versions 1-7 ───────────────
  // Format : { size, blocks: [{ count, data, ec }] }
  // Multi-block : V6+ = 2 blocks identiques (interleaving requis ISO 18004)
  const _QR_CAP_L = [
    null, // index 0 unused
    { size: 21, blocks: [{ count: 1, data: 19,  ec: 7  }] }, // V1 : 1×19+7
    { size: 25, blocks: [{ count: 1, data: 34,  ec: 10 }] }, // V2 : 1×34+10
    { size: 29, blocks: [{ count: 1, data: 55,  ec: 15 }] }, // V3 : 1×55+15
    { size: 33, blocks: [{ count: 1, data: 80,  ec: 20 }] }, // V4 : 1×80+20
    { size: 37, blocks: [{ count: 1, data: 108, ec: 26 }] }, // V5 : 1×108+26
    { size: 41, blocks: [{ count: 2, data: 68,  ec: 18 }] }, // V6 : 2×68+18 = 136 data total
    { size: 45, blocks: [{ count: 2, data: 78,  ec: 20 }] }, // V7 : 2×78+20 = 156 data total (+ version info)
  ];
  // Helpers : taille data totale et nombre total de codewords
  function _capDataBytes(cap) { return cap.blocks.reduce((s, b) => s + b.count * b.data, 0); }
  function _capTotalCodewords(cap) { return cap.blocks.reduce((s, b) => s + b.count * (b.data + b.ec), 0); }
  // Version info BCH pour V7+ (RFC ISO 18004 Annexe D, table D.1)
  const _QR_VERSION_INFO = { 7: 0x07C94 }; // 18 bits

  function _pickVersion(byteLen) {
    // Mode Binary : 4 bits indicator + 8 bits length (V1-V9) + 8*byteLen bits
    for (let v = 1; v <= 7; v++) {
      const cap = _QR_CAP_L[v];
      const dataBits = _capDataBytes(cap) * 8;
      const headerBits = 4 + 8; // mode (4) + length (8)
      const payloadBits = byteLen * 8;
      if (headerBits + payloadBits <= dataBits) return v;
    }
    return -1; // trop long
  }

  // ── Encodage des données + ECC (avec interleaving multi-block V6+) ──
  function _encodeData(text, version) {
    const cap = _QR_CAP_L[version];
    const totalData = _capDataBytes(cap);
    const bytes = new TextEncoder().encode(text);
    const bits = [];
    bits.push(0, 1, 0, 0); // mode binaire 0100
    const len = bytes.length;
    for (let i = 7; i >= 0; i--) bits.push((len >> i) & 1);
    for (const b of bytes) {
      for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    }
    const remaining = totalData * 8 - bits.length;
    for (let i = 0; i < Math.min(4, remaining); i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const pads = [0xEC, 0x11];
    let pi = 0;
    while (bits.length < totalData * 8) {
      const b = pads[pi++ % 2];
      for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    }
    // Convert to data bytes
    const data = new Uint8Array(totalData);
    for (let i = 0; i < totalData; i++) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
      data[i] = v;
    }

    // Single-block path (V1-V5) : pas d'interleaving
    if (cap.blocks.length === 1 && cap.blocks[0].count === 1) {
      const ec = _rsCompute(Array.from(data), cap.blocks[0].ec);
      const total = _capTotalCodewords(cap);
      const final = new Uint8Array(total);
      final.set(data, 0);
      for (let i = 0; i < ec.length; i++) final[totalData + i] = ec[i];
      return final;
    }

    // Multi-block path (V6+) : interleaving ISO 18004 §8.6
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (const spec of cap.blocks) {
      for (let bi = 0; bi < spec.count; bi++) {
        const dataBlock = Array.from(data.slice(offset, offset + spec.data));
        const ecBlock   = _rsCompute(dataBlock, spec.ec);
        dataBlocks.push(dataBlock);
        ecBlocks.push(ecBlock);
        offset += spec.data;
      }
    }
    // Interleave data column-major
    const maxData = Math.max(...dataBlocks.map(b => b.length));
    const interleaved = [];
    for (let i = 0; i < maxData; i++) {
      for (const block of dataBlocks) {
        if (i < block.length) interleaved.push(block[i]);
      }
    }
    // Interleave EC column-major
    const maxEc = Math.max(...ecBlocks.map(b => b.length));
    for (let i = 0; i < maxEc; i++) {
      for (const block of ecBlocks) {
        if (i < block.length) interleaved.push(block[i]);
      }
    }
    return new Uint8Array(interleaved);
  }

  // ── Placement des modules sur la matrice ─────────────────────────────
  function _newMatrix(size) {
    const m = new Array(size);
    for (let i = 0; i < size; i++) m[i] = new Int8Array(size).fill(-1); // -1 = vide
    return m;
  }
  function _placeFinder(m, x, y) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= m.length || yy >= m.length) continue;
        const inOuter = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
                        (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6));
        const inInner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        m[yy][xx] = (inOuter || inInner) ? 1 : 0;
      }
    }
  }
  function _placeTiming(m) {
    const sz = m.length;
    for (let i = 8; i < sz - 8; i++) {
      m[6][i] = i % 2 === 0 ? 1 : 0;
      m[i][6] = i % 2 === 0 ? 1 : 0;
    }
  }
  function _placeAlignment(m, version) {
    if (version < 2) return;
    // Tableau des centres pour V2-V7 (RFC ISO 18004 Annexe E.1)
    const positions = {
      2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
      6: [6, 34],
      7: [6, 22, 38],
    }[version];
    if (!positions) return;
    const last = positions[positions.length - 1];
    for (const px of positions) {
      for (const py of positions) {
        // Skip si chevauchement avec finders top-left/top-right/bottom-left
        if ((px === 6 && py === 6) || (px === 6 && py === last) || (py === 6 && px === last)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = px + dx, yy = py + dy;
            if (xx < 0 || yy < 0 || xx >= m.length || yy >= m.length) continue;
            const onOuter = Math.abs(dx) === 2 || Math.abs(dy) === 2;
            const center = dx === 0 && dy === 0;
            m[yy][xx] = (onOuter || center) ? 1 : 0;
          }
        }
      }
    }
  }

  // ── Version info pour V7+ (18 bits placés en 6×3 et 3×6) ─────────────
  // RFC ISO 18004 §8.10. Code BCH(18,6) hardcodé pour les versions supportées.
  function _placeVersionInfo(m, version) {
    if (version < 7) return;
    const code = _QR_VERSION_INFO[version];
    if (code === undefined) return;
    const sz = m.length;
    // Placer en 6×3 zone (au-dessus du finder bottom-left)
    // et en 3×6 zone (à gauche du finder top-right)
    for (let i = 0; i < 18; i++) {
      const bit = (code >> i) & 1;
      const x = Math.floor(i / 3);
      const y = (i % 3) + sz - 11;
      // Zone 1 : 6×3 en bas-gauche
      m[y][x] = bit;
      // Zone 2 : 3×6 symétrique en haut-droite
      m[x][y] = bit;
    }
  }
  function _placeFormat(m, ecLevel /* 0=L */, mask) {
    // Bits format pour ECC L = 01, mask = 3 bits
    // Lookup table BCH(15,5) avec masking 0x5412
    const FORMAT_BITS = {
      0: [0,1, 0,0,0, 0x77c4], 1: [0,1, 0,0,1, 0x72f3],
      2: [0,1, 0,1,0, 0x7daa], 3: [0,1, 0,1,1, 0x789d],
      4: [0,1, 1,0,0, 0x662f], 5: [0,1, 1,0,1, 0x6318],
      6: [0,1, 1,1,0, 0x6c41], 7: [0,1, 1,1,1, 0x6976],
    };
    const fmt = FORMAT_BITS[mask][5]; // 15-bit
    const sz = m.length;
    const bits = [];
    for (let i = 14; i >= 0; i--) bits.push((fmt >> i) & 1);

    // Position 1 : autour du finder top-left
    for (let i = 0; i <= 5; i++)  m[8][i]      = bits[14 - i];
    m[8][7] = bits[14 - 6]; m[8][8] = bits[14 - 7]; m[7][8] = bits[14 - 8];
    for (let i = 9; i <= 14; i++) m[14 - i][8] = bits[14 - i];

    // Position 2 : bottom-left + top-right
    for (let i = 0; i <= 7; i++) m[sz - 1 - i][8] = bits[i];
    for (let i = 8; i <= 14; i++) m[8][sz - 15 + i] = bits[i];
    m[sz - 8][8] = 1; // dark module
  }
  function _placeData(m, codewords, version) {
    const sz = m.length;
    let bitIdx = 0;
    let upward = true;
    for (let col = sz - 1; col > 0; col -= 2) {
      if (col === 6) col--; // skip timing column
      for (let row = 0; row < sz; row++) {
        const y = upward ? sz - 1 - row : row;
        for (let dx = 0; dx < 2; dx++) {
          const x = col - dx;
          if (m[y][x] === -1) {
            const byteIdx = Math.floor(bitIdx / 8);
            const bitInByte = 7 - (bitIdx % 8);
            const bit = byteIdx < codewords.length ? ((codewords[byteIdx] >> bitInByte) & 1) : 0;
            m[y][x] = bit;
            bitIdx++;
          }
        }
      }
      upward = !upward;
    }
  }
  function _applyMask(m, reservedMask, mask) {
    const sz = m.length;
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        if (reservedMask[y][x]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) m[y][x] ^= 1;
      }
    }
  }
  function _scoreMask(m) {
    // Penalty rules ISO 18004 — version simplifiée pour rapidité
    const sz = m.length;
    let p = 0;
    // Rule 1 : runs of same color
    for (let y = 0; y < sz; y++) {
      let run = 1;
      for (let x = 1; x < sz; x++) {
        if (m[y][x] === m[y][x - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else run = 1;
      }
    }
    for (let x = 0; x < sz; x++) {
      let run = 1;
      for (let y = 1; y < sz; y++) {
        if (m[y][x] === m[y - 1][x]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else run = 1;
      }
    }
    // Rule 2 : 2x2 blocks
    for (let y = 0; y < sz - 1; y++) {
      for (let x = 0; x < sz - 1; x++) {
        if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
      }
    }
    return p;
  }

  // ── API publique ──────────────────────────────────────────────────────
  // Retourne une matrice 0/1 [size][size] ou null si trop long
  function generate(text) {
    const bytes = new TextEncoder().encode(text);
    const version = _pickVersion(bytes.length);
    if (version < 0) return null;
    const cap = _QR_CAP_L[version];
    const codewords = _encodeData(text, version);
    const sz = cap.size;

    // Try all 8 masks, pick the best (lowest penalty)
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = _newMatrix(sz);
      _placeFinder(m, 0, 0);
      _placeFinder(m, sz - 7, 0);
      _placeFinder(m, 0, sz - 7);
      _placeAlignment(m, version);
      _placeTiming(m);
      _placeFormat(m, 0, mask);
      _placeVersionInfo(m, version);  // ⚡ V7+ requis par ISO 18004
      // reservedMask = positions où modules ne sont PAS data
      const reserved = _newMatrix(sz);
      for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++) reserved[y][x] = (m[y][x] === -1) ? 0 : 1;
      _placeData(m, codewords, version);
      _applyMask(m, reserved, mask);
      const score = _scoreMask(m);
      if (score < bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  // Retourne du SVG avec les modules sombres groupés
  function toSvg(matrix, options) {
    options = options || {};
    const scale  = options.scale  || 8;
    const margin = options.margin || 4;
    const dark   = options.dark   || '#000';
    const light  = options.light  || '#fff';
    const sz = matrix.length;
    const total = (sz + margin * 2) * scale;
    let path = '';
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        if (matrix[y][x] === 1) {
          path += `M${(x + margin) * scale},${(y + margin) * scale}h${scale}v${scale}h-${scale}z`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}">` +
           `<rect width="100%" height="100%" fill="${light}"/>` +
           `<path d="${path}" fill="${dark}"/></svg>`;
  }

  // Expose
  if (typeof window !== 'undefined') {
    window._qrCode = { generate, toSvg };
  }
})();
