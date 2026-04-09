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
function showAdm(){$('auth-ov').classList.add('hide');$('adm').classList.add('show');$('app').style.display='none';loadAdm();loadAdmStats();}
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
    $('admin-mode-badge').style.display='flex';
    $('admin-cot-notice').style.display='flex';
    $('priv-cot').style.display='none';
    $('btn-profil').style.display='none';
    document.querySelectorAll('.nurse-only').forEach(el=>el.style.display='flex');
    // Masquage strict des champs patient (RGPD)
    ['f-pt','f-ddn','f-sec','f-amo','f-amc'].forEach(id=>{
      const el=$(id); if(el){ el.value=''; el.placeholder='— masqué (admin) —'; el.readOnly=true; }
    });
    // Masquer section prescripteur en mode admin
    const prescSec=$('prescripteur-section');
    if(prescSec) prescSec.style.display='none';
    // Masquer numéro de facture en mode admin
    const invSec=$('invoice-number-section');
    if(invSec) invSec.style.display='none';
    // Pré-remplir date pour test fonctionnel
    const fds=$('f-ds'); if(fds)fds.value=new Date().toISOString().split('T')[0];

    // ── Notices admin pour toutes les sections accessibles ──
    ['dash-admin-notice','copilote-admin-notice','ver-admin-notice','stats-admin-notice'].forEach(id => {
      const el = $(id); if(el) el.style.display = 'flex';
    });

    // ── Rebrancher onclick pour copilote et stats (nurse-only mais accessibles admin) ──
    ['dash','copilote','stats','ngap-ref'].forEach(v => {
      const ni = document.querySelector(`.ni[data-v="${v}"]`);
      if (ni) {
        ni.classList.remove('nurse-only');
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
      liAdmin.onclick=()=>{$('app').style.display='none';$('adm').classList.add('show');loadAdm();loadAdmStats();};

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
    }
  } else {
    /* ── MODE INFIRMIÈRE ─────────────────────────────────────────── */
    $('admin-mode-badge').style.display='none';
    $('admin-cot-notice').style.display='none';
    $('priv-cot').style.display='';
    $('btn-profil').style.display='';
    const prescSec=$('prescripteur-section');
    if(prescSec) prescSec.style.display='';
    const invSec=$('invoice-number-section');
    if(invSec) invSec.style.display='';
    // Charger la liste des prescripteurs
    loadPrescripteurs();
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
    ss.save(d.token,d.role,d.user);
    /* ── Sécurité RGPD : chiffrement + audit ── */
    if(typeof initSecurity==='function') initSecurity(d.token);
    showApp();
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
