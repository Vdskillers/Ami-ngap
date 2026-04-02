/* ════════════════════════════════════════════════
   ui.js — AMI NGAP
   ────────────────────────────────────────────────
   Interface & Navigation
   - navTo() — navigation entre vues
   - updateNavMode() — responsive sidebar/bottom nav
   - toggleMobileMenu() — menu "Plus" mobile
   - filterFaq() — recherche dans l'aide
   - Bindings addEventListener (auth, profil, admin)
   - INIT — checkAuth(), dates par défaut
   ⚠️  Doit être chargé EN DERNIER (après tous les
       autres modules qui définissent les fonctions)
════════════════════════════════════════════════ */
/* FAQ SEARCH */
function filterFaq() {
  const q = ($('faq-search')?.value||'').toLowerCase().trim();
  let anyVisible = false;
  document.querySelectorAll('#view-aide .accord').forEach(item => {
    const text = item.textContent.toLowerCase();
    const match = !q || text.includes(q);
    item.style.display = match ? '' : 'none';
    if (match) { anyVisible = true; if (q) item.classList.add('open'); else item.classList.remove('open'); }
  });
  document.querySelectorAll('#view-aide .faq-section').forEach(section => {
    const visible = [...section.querySelectorAll('.accord')].some(a => a.style.display !== 'none');
    section.style.display = visible ? '' : 'none';
  });
  const noRes = $('faq-no-result');
  if (noRes) noRes.style.display = anyVisible ? 'none' : 'block';
}

/* ============================================================
   MOBILE — Bottom nav + responsive logic
   ============================================================ */
function isMobile(){ return window.innerWidth<=768; }

/* Affiche/masque la bottom nav selon la taille d'écran */
function updateNavMode(){
  const bn=$('bottom-nav');
  if(!bn) return;
  if(isMobile()) bn.style.display='flex';
  else bn.style.display='none';
}
window.addEventListener('resize', updateNavMode);

/* Navigation unifiée sidebar + bottom nav */
function navTo(v, triggerEl){
  // Vues
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('on'));
  const target=$('view-'+v);
  if(target) target.classList.add('on');

  // Sidebar desktop
  document.querySelectorAll('.ni[data-v]').forEach(n=>n.classList.remove('on'));
  const sideItem=document.querySelector(`.ni[data-v="${v}"]`);
  if(sideItem) sideItem.classList.add('on');

  // Bottom nav mobile
  document.querySelectorAll('#bottom-nav .bn-item').forEach(n=>n.classList.remove('on'));
  if(triggerEl) triggerEl.classList.add('on');
  else {
    const bn=document.querySelector(`#bottom-nav .bn-item[data-v="${v}"]`);
    if(bn) bn.classList.add('on');
  }

  // Actions spéciales
  if(v==='dash') loadDash();
  if(v==='tur') setTimeout(()=>{initDepMap();showCaFromImport();},100);

  // Scroll to top
  const main=document.querySelector('.main');
  if(main) main.scrollTop=0;
}

/* Menu "Plus" mobile */
let mobileMenuOpen=false;
function toggleMobileMenu(){
  mobileMenuOpen=!mobileMenuOpen;
  const m=$('mobile-menu');
  if(!m) return;
  m.style.display=mobileMenuOpen?'block':'none';
  // Toggle icône
  const moreBtn=document.querySelector('#bottom-nav .bn-item[data-v="more"]');
  if(moreBtn) moreBtn.classList.toggle('on', mobileMenuOpen);
}
// Ferme le menu si clic ailleurs
document.addEventListener('click', e=>{
  if(mobileMenuOpen && !e.target.closest('#mobile-menu') && !e.target.closest('[onclick*="toggleMobileMenu"]')){
    mobileMenuOpen=false;
    const m=$('mobile-menu');if(m)m.style.display='none';
    const btn=document.querySelector('#bottom-nav .bn-item[data-v="more"]');if(btn)btn.classList.remove('on');
  }
});

/* Patch sidebar .ni clicks pour aussi mettre à jour bottom nav */
document.querySelectorAll('.ni[data-v]').forEach(item=>{
  item.addEventListener('click',()=>navTo(item.dataset.v, null));
});

/* ══════════════════════════════════════════════
   BINDINGS — exécutés ici car le script est APRÈS le DOM
   (pas besoin de DOMContentLoaded quand le script est en fin de body)
   ══════════════════════════════════════════════ */
/* Auth */
const btnL=$('btn-l');if(btnL)btnL.addEventListener('click',login);
const btnR=$('btn-r');if(btnR)btnR.addEventListener('click',register);
const tabL=$('tab-l');if(tabL)tabL.addEventListener('click',()=>switchTab('l'));
const tabR=$('tab-r');if(tabR)tabR.addEventListener('click',()=>switchTab('r'));
/* Profil modal */
const btnSavePm=$('btn-save-pm');if(btnSavePm)btnSavePm.addEventListener('click',savePM);
const btnChangePwd=$('btn-change-pwd');if(btnChangePwd)btnChangePwd.addEventListener('click',changePwd);
const btnDelAccount=$('btn-del-account');if(btnDelAccount)btnDelAccount.addEventListener('click',delAccount);
/* Admin search avec debounce 300ms */
const admQ=$('adm-q');if(admQ)admQ.addEventListener('input',debounce(filterAccs,300));

/* INIT */
const today=new Date().toISOString().split('T')[0];
['f-ds','f-pr-dt','v-ds'].forEach(id=>{const e=$(id);if(e)e.value=today;});
checkAuth();
