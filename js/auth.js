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
  nurse: ['create_invoice','view_own_data','import_calendar','manage_tournee','change_password','delete_account','manage_prescripteurs'],
  admin: ['block_user','unblock_user','delete_user','view_stats','view_logs','view_users_list']
  // ⚠️ 'view_patient_data' intentionnellement absent du rôle admin
};
function clientHasPermission(permission){
  const role = S?.role || 'nurse';
  return (CLIENT_PERMISSIONS[role] || []).includes(permission);
}

/* ── AUTH ─────────────────────────────────────── */
function checkAuth(){
  /* Vérifier consentement RGPD avant tout */ 
  if(typeof checkConsent==='function' && !checkConsent()) return;
  const session = ss.load();
  if(session && session.token){
    S = session; // hydratation obligatoire avant showApp()
    if(typeof initSecurity==='function') initSecurity(S.token);
    showApp();
  }else{
    ss.clear();
    showAuthOv();
  }
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

        // Injecter bouton Cabinet mobile si absent (admin se connecte en premier)
        if (!document.getElementById('btn-cabinet-mobile')) {
          const btnCabM = document.createElement('button');
          btnCabM.id = 'btn-cabinet-mobile';
          btnCabM.className = 'bn-item';
          btnCabM.style.cssText = 'background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.2);border-radius:12px;padding:12px 4px;height:auto;flex:none';
          btnCabM.innerHTML = '<span class="bn-ic">🏥</span>Cabinet';
          btnCabM.setAttribute('data-v', 'cabinet');
          btnCabM.onclick = () => { if (typeof navTo === 'function') navTo('cabinet', null); if (typeof toggleMobileMenu === 'function') toggleMobileMenu(); };
          const btnQuitter2 = mobileGrid.querySelector('[onclick*="logout"]');
          if (btnQuitter2) mobileGrid.insertBefore(btnCabM, btnQuitter2);
          else mobileGrid.appendChild(btnCabM);
        }
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

    // ── Injecter "Cabinet" dans le menu mobile Plus (une seule fois) ──
    const _injectCabinetMobile = () => {
      if (document.getElementById('btn-cabinet-mobile')) return;
      const mobileGrid = document.querySelector('#mobile-menu > div');
      if (!mobileGrid) { setTimeout(_injectCabinetMobile, 200); return; }
      const btnCab = document.createElement('button');
      btnCab.id = 'btn-cabinet-mobile';
      btnCab.className = 'bn-item nurse-only';
      btnCab.style.cssText = 'background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.2);border-radius:12px;padding:12px 4px;height:auto;flex:none';
      btnCab.innerHTML = '<span class="bn-ic">🏥</span>Cabinet';
      btnCab.setAttribute('data-v', 'cabinet');
      btnCab.onclick = () => { if (typeof navTo === 'function') navTo('cabinet', null); if (typeof toggleMobileMenu === 'function') toggleMobileMenu(); };
      // Insérer avant le bouton "Quitter"
      const btnQuitter = mobileGrid.querySelector('[onclick*="logout"]');
      if (btnQuitter) mobileGrid.insertBefore(btnCab, btnQuitter);
      else mobileGrid.appendChild(btnCab);
    };
    setTimeout(_injectCabinetMobile, 250);
  }

  // Correction Leaflet après changement de layout
  setTimeout(()=>{ if(typeof depMap!=='undefined'&&depMap) depMap.invalidateSize(); },250);

  // Dispatcher l'event de login pour les modules qui en dépendent (copilote, etc.)
  setTimeout(()=>{ document.dispatchEvent(new CustomEvent('ami:login', { detail: { role: S?.role } })); }, 150);
}
function switchTab(t){['l','r'].forEach(x=>{$('tab-'+x).classList.toggle('on',x===t);$('pan-'+x).style.display=x===t?'block':'none';});hideM('le','re','ro');}
async function login(){
  hideM('le');const em=sanitize(gv('l-em')),pw=gv('l-pw');
  if(!em||!pw){showM('le','Email et mot de passe requis.');return;}
  ld('btn-l',true);
  try{
    const d=await wpost('/webhook/auth-login',{email:em,password:pw});
    if(!d.ok)throw new Error(d.error||'Identifiants incorrects');

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

    ss.save(d.token,d.role,d.user);
    /* ── Sécurité RGPD : chiffrement + audit ── */
    if(typeof initSecurity==='function') initSecurity(d.token);
    showApp();
    /* ── Initialiser le cabinet (mode multi-IDE) ── */
    if (typeof initCabinet === 'function') setTimeout(() => initCabinet(), 300);
  }catch(e){showM('le',e.message);}finally{ld('btn-l',false);}
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
  ss.clear();
  APP.startPoint=null;
  APP.userPos=null;
  APP.importedData=null;
  APP.uberPatients=[];
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
