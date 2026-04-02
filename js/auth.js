/* ════════════════════════════════════════════════
   auth.js — AMI NGAP
   ────────────────────────────────────────────────
   Authentification & gestion de session
   - login() / register() / logout()
   - checkAuth() — vérifie la session au chargement
   - showApp() / showAuthOv() / showAdm()
   - switchTab() — bascule connexion ↔ inscription
   - goToApp() — retour app depuis panel admin
════════════════════════════════════════════════ */
/* AUTH */
function checkAuth(){
  if(ss.load()&&S?.token){
    showApp();
  }else{
    ss.clear(); // nettoie toute session corrompue
    showAuthOv();
  }
}
function showAuthOv(){$('auth-ov').classList.remove('hide');$('adm').classList.remove('show');$('app').style.display='none';}
function showAdm(){$('auth-ov').classList.add('hide');$('adm').classList.add('show');$('app').style.display='none';loadAdm();loadAdmStats();}
function goToApp(){$('adm').classList.remove('show');$('app').style.display='grid';updateNavMode();}
function showApp(){
  $('auth-ov').classList.add('hide');$('adm').classList.remove('show');$('app').style.display='grid';
  const u=S?.user||{};
  $('uname').textContent=((u.prenom||'')+' '+(u.nom||'')).trim()||u.email||'—';
  if($('sess-inf'))$('sess-inf').textContent=(u.email||'')+' · session active';
  $('voicebtn').classList.add('show');
  updateNavMode();
  // Mode admin : toutes les pages visibles, données patients masquées
  if(S?.role==='admin'){
    $('admin-mode-badge').style.display='flex';
    $('admin-cot-notice').style.display='flex';
    $('priv-cot').style.display='none';
    $('btn-profil').style.display='none';
    // Afficher toutes les pages (nurse-only visible pour vérification fonctionnelle)
    document.querySelectorAll('.nurse-only').forEach(el=>el.style.display='flex');
    // Masquer les champs patient individuels (RGPD)
    ['f-pt','f-ddn','f-sec','f-amo','f-amc'].forEach(id=>{
      const el=$(id); if(el){ el.value=''; el.placeholder='— masqué (admin) —'; el.readOnly=true; }
    });
    // Pré-remplir champs neutres pour test
    const fds=$(  'f-ds'); if(fds)fds.value=new Date().toISOString().split('T')[0];
    // Ajouter bouton "Panneau admin" dans la sidebar
    if(!$('btn-goto-admin')){
      const li=document.createElement('div');
      li.className='ni';li.id='btn-goto-admin';
      li.innerHTML='<span class="nic">⚙️</span> Panneau admin';
      li.style.cssText='color:var(--d);background:rgba(255,95,109,.08);border:1px solid rgba(255,95,109,.2);margin:8px 14px;border-radius:var(--r);';
      li.onclick=()=>{$('app').style.display='none';$('adm').classList.add('show');loadAdm();loadAdmStats();};
      document.querySelector('.side .sl:last-child')?.prepend(li);
    }
  }
}
function switchTab(t){['l','r'].forEach(x=>{$('tab-'+x).classList.toggle('on',x===t);$('pan-'+x).style.display=x===t?'block':'none';});hideM('le','re','ro');}
async function login(){
  hideM('le');const em=sanitize(gv('l-em')),pw=gv('l-pw');
  if(!em||!pw){showM('le','Email et mot de passe requis.');return;}
  ld('btn-l',true);
  try{
    const d=await wpost('/webhook/auth-login',{email:em,password:pw});
    if(!d.ok)throw new Error(d.error||'Identifiants incorrects');
    ss.save(d.token,d.role,d.user); // met aussi à jour APP.token/role/user
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
  ss.clear();                        // vide sessionStorage + APP.token/role/user
  APP.startPoint=null;               // réinitialise la position GPS
  APP.userPos=null;
  APP.importedData=null;
  APP.uberPatients=[];
  if(typeof stopVoice==='function') stopVoice();
  showAuthOv();
  switchTab('l');
  const pw=$('l-pw');if(pw)pw.value='';
  $('voicebtn').classList.remove('show');
}
