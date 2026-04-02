/* ════════════════════════════════════════════════
   profil.js — AMI NGAP
   ────────────────────────────────────────────────
   Modale profil utilisateur
   - openPM() / closePM()
   - savePM() — sauvegarde les infos professionnelles
   - changePwd() — changement mot de passe
   - delAccount() — suppression compte RGPD
════════════════════════════════════════════════ */
/* PROFIL */
async function openPM(){
  $('pm').classList.add('open');hideM('pe','po','ppe','ppo');
  const u=S?.user||{};
  $('p-fn').value=u.prenom||'';$('p-ln').value=u.nom||'';$('p-ad').value=u.adeli||'';$('p-rp').value=u.rpps||'';$('p-st').value=u.structure||'';$('p-adr').value=u.adresse||'';$('p-tel').value=u.tel||'';
  try{const d=await wpost('/webhook/profil-get',{});if(d.ok&&d.profil){const p=d.profil;$('p-fn').value=p.prenom||'';$('p-ln').value=p.nom||'';$('p-ad').value=p.adeli||'';$('p-rp').value=p.rpps||'';$('p-st').value=p.structure||'';$('p-adr').value=p.adresse||'';$('p-tel').value=p.tel||'';}}catch{}
}
function closePM(){$('pm').classList.remove('open');}
async function savePM(){
  hideM('pe','po');
  try{const d=await wpost('/webhook/profil-save',{nom:gv('p-ln'),prenom:gv('p-fn'),adeli:gv('p-ad'),rpps:gv('p-rp'),structure:gv('p-st'),adresse:gv('p-adr'),tel:gv('p-tel')});if(!d.ok)throw new Error(d.error||'Erreur');S.user={...S.user,...d.profil};ss.save(S.token,S.role,S.user);$('uname').textContent=((S.user.prenom||'')+' '+(S.user.nom||'')).trim();showM('po','✅ Profil enregistré.','o');}
  catch(e){showM('pe',e.message);}
}
async function changePwd(){
  hideM('ppe','ppo');const old=gv('p-old'),nw=gv('p-new');
  if(!old||!nw){showM('ppe','Remplissez les deux champs.');return;}
  if(nw.length<8){showM('ppe','Minimum 8 caractères.');return;}
  try{const d=await wpost('/webhook/change-password',{ancien:old,nouveau:nw});if(!d.ok)throw new Error(d.error);$('p-old').value='';$('p-new').value='';showM('ppo','✅ Mot de passe changé.','o');}catch(e){showM('ppe',e.message);}
}
async function delAccount(){
  if(!confirm('⚠️ Supprimer votre compte définitivement ?'))return;
  try{const d=await wpost('/webhook/delete-account',{});if(!d.ok)throw new Error(d.error);ss.clear();closePM();showAuthOv();switchTab('l');}catch(e){showM('pe',e.message);}
}
