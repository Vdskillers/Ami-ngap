/* ════════════════════════════════════════════════
   profil.js — AMI NGAP (v3.10 — signature IDE + 2FA)
   ────────────────────────────────────────────────
   Modale profil utilisateur
   - openPM() / closePM()
   - savePM() — sauvegarde les infos professionnelles
   - changePwd() — changement mot de passe
   - delAccount() — suppression compte RGPD
   - ✍️ Onglet signature électronique IDE (via signature.js)
   - 🔐 Section 2FA (via security.js → renderMfaSection)
════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════
   🔐 Injection de la section MFA dans la modale profil.
   Stratégie défensive : crée le container #p-mfa-section au 1er appel
   et le réutilise (renderMfaSection écrase son innerHTML proprement).

   Placement (ordre de priorité) :
     1. Avant le bouton delAccount (pour cohérence : sécurité avant zone danger)
     2. Avant la zone de changement de mot de passe
     3. À la fin de la modale #pm (fallback)
════════════════════════════════════════════════════════════════════════ */
function _ensureMfaSectionInPM() {
  // ⚡ MFA TOTP DÉSACTIVÉ (sur demande utilisateur) — no-op
  //
  // La section "Sécurité du compte" avec accès aux paramètres 2FA n'est plus
  // injectée dans la modale profil. Le code original est conservé en commentaire
  // pour réactivation future éventuelle.
  return null;

  /* ── Code original conservé pour réactivation future ──
  if (typeof renderMfaSection !== 'function') return null;
  let container = document.getElementById('p-mfa-section');
  if (container) return container;
  const pm = document.getElementById('pm');
  if (!pm) return null;
  container = document.createElement('div');
  container.id = 'p-mfa-section';
  container.style.cssText = 'margin:14px 0;padding:0';
  const heading = document.createElement('h3');
  heading.textContent = 'Sécurité du compte';
  heading.style.cssText = 'font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin:18px 0 8px;font-weight:600';
  let inserted = false;
  const delBtn = pm.querySelector('button[onclick*="delAccount"]');
  if (delBtn && delBtn.parentElement) {
    delBtn.parentElement.insertBefore(heading, delBtn);
    delBtn.parentElement.insertBefore(container, delBtn);
    inserted = true;
  }
  if (!inserted) {
    const pOld = document.getElementById('p-old');
    if (pOld) {
      let target = pOld.closest('.section, .pwd-section, fieldset, [data-section="password"]') || pOld.parentElement;
      if (target && target.parentElement) {
        target.parentElement.insertBefore(heading, target);
        target.parentElement.insertBefore(container, target);
        inserted = true;
      }
    }
  }
  if (!inserted) { pm.appendChild(heading); pm.appendChild(container); }
  return container;
  ──────────────────────────────────────────────────── */
}

/* PROFIL */
async function openPM(){
  $('pm').classList.add('open');hideM('pe','po','ppe','ppo');
  const u=S?.user||{};
  $('p-fn').value=u.prenom||'';$('p-ln').value=u.nom||'';$('p-ad').value=u.adeli||'';$('p-rp').value=u.rpps||'';$('p-st').value=u.structure||'';$('p-adr').value=u.adresse||'';$('p-tel').value=u.tel||'';
  try{const d=await wpost('/webhook/profil-get',{});if(d.ok&&d.profil){const p=d.profil;$('p-fn').value=p.prenom||'';$('p-ln').value=p.nom||'';$('p-ad').value=p.adeli||'';$('p-rp').value=p.rpps||'';$('p-st').value=p.structure||'';$('p-adr').value=p.adresse||'';$('p-tel').value=p.tel||'';}}catch{}
  // ✍️ Signature électronique IDE — rafraîchir l'UI (preview + état boutons)
  try{if(typeof refreshIDESignatureUI==='function')refreshIDESignatureUI();}catch{}
  // 🔐 Section 2FA — injection automatique (défensive, no-op si security.js absent)
  try{
    const c = _ensureMfaSectionInPM();
    if (c) renderMfaSection('p-mfa-section');
  }catch(e){console.warn('[AMI] MFA section injection KO:', e.message);}
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
