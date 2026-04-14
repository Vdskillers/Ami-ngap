/* ════════════════════════════════════════════════
   ui.js — AMI NGAP v5.0
   ────────────────────────────────────────────────
   Interface & Navigation — orchestrateur UI
   v5.0 — Améliorations architecture :
   ✅ Découpage logique interne : nav / mobile / faq / bindings / init
   ✅ navTo() émet 'ui:navigate' (CustomEvent) → modules réactifs
   ✅ invalidateSize() Leaflet via APP.map.instance
   ✅ Tous les effets de bord navTo sont dans des blocs distincts
   ⚠️  Chargé EN DERNIER (après tous les modules)
════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════
   NAVIGATION
════════════════════════════════════════════════ */
function navTo(v, triggerEl) {
  /* Vues */
  document.querySelectorAll('.view').forEach(x => x.classList.remove('on'));
  const target = $('view-' + v);
  if (target) target.classList.add('on');

  /* Sidebar desktop */
  document.querySelectorAll('.ni[data-v]').forEach(n => n.classList.remove('on'));
  const sideItem = document.querySelector(`.ni[data-v="${v}"]`);
  if (sideItem) sideItem.classList.add('on');

  /* Bottom nav mobile */
  document.querySelectorAll('#bottom-nav .bn-item').forEach(n => n.classList.remove('on'));
  if (triggerEl) triggerEl.classList.add('on');
  else {
    const bn = document.querySelector(`#bottom-nav .bn-item[data-v="${v}"]`);
    if (bn) bn.classList.add('on');
  }

  /* Émet un event pour que les modules réagissent */
  document.dispatchEvent(new CustomEvent('ui:navigate', { detail: { view: v } }));

  /* Scroll to top */
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
}

/* Effets de bord navigation — centralisés ici */
document.addEventListener('ui:navigate', e => {
  const v = e.detail.view;

  /* Dashboard → charger données */
  if (v === 'dash' && typeof loadDash === 'function') loadDash();

  /* Copilote IA → monter l'interface */
  if (v === 'copilote' && typeof initCopiloteSection === 'function') {
    setTimeout(initCopiloteSection, 80);
  }

  /* Tournée → init carte + invalider taille — identique admin et infirmière */
  if (v === 'tur') {
    setTimeout(() => {
      /* Init carte */
      if (typeof initTurMap === 'function') initTurMap();
      else if (typeof initDepMap === 'function') initDepMap();

      if (typeof showCaFromImport === 'function') showCaFromImport();
      if (typeof updateCAEstimate === 'function') updateCAEstimate();

      /* Invalider la taille APRÈS que la vue est visible (évite la carte grise) */
      setTimeout(() => {
        const mapInst = (APP.map && typeof APP.map.invalidateSize === 'function')
          ? APP.map
          : APP.map?.instance;
        if (mapInst) { try { mapInst.invalidateSize(); } catch(_){} }
      }, 300);

      /* Si des données importées existent, afficher les marqueurs sur la carte
         Fonctionne pour admin ET infirmière — chacun avec ses propres données */
      if (APP.importedData?.patients?.length && typeof renderPatientsOnMap === 'function') {
        const startPt = (typeof APP.get === 'function' ? APP.get('startPoint') : APP.startPoint) || null;
        const _retryMap = (n) => {
          const mapInst = (APP.map && typeof APP.map.invalidateSize === 'function')
            ? APP.map
            : APP.map?.instance;
          if (mapInst) {
            renderPatientsOnMap(APP.importedData.patients, startPt).catch(() => {});
            setTimeout(() => { try { mapInst.invalidateSize(); } catch(_){} }, 250);
          } else if (n < 10) {
            setTimeout(() => _retryMap(n + 1), 300);
          }
        };
        _retryMap(0);
      }
    }, 150);
  }

  /* Uber → charger patients si pas déjà fait */
  if (v === 'uber' && typeof loadUberPatients === 'function') {
    if (!APP.get('uberPatients')?.length) loadUberPatients();
  }

  log('navTo →', v);
});

/* ════════════════════════════════════════════════
   MOBILE — Bottom nav + responsive
════════════════════════════════════════════════ */
function isMobile() { return window.innerWidth <= 768; }

function updateNavMode() {
  const bn = $('bottom-nav');
  if (!bn) return;
  bn.style.display = isMobile() ? 'flex' : 'none';
}
window.addEventListener('resize', debounce(updateNavMode, 150));

/* Menu "Plus" mobile */
let mobileMenuOpen = false;
function toggleMobileMenu() {
  mobileMenuOpen = !mobileMenuOpen;
  const m = $('mobile-menu');
  if (!m) return;
  m.style.display = mobileMenuOpen ? 'block' : 'none';
  const moreBtn = document.querySelector('#bottom-nav .bn-item[data-v="more"]');
  if (moreBtn) moreBtn.classList.toggle('on', mobileMenuOpen);
}
document.addEventListener('click', e => {
  if (mobileMenuOpen && !e.target.closest('#mobile-menu') && !e.target.closest('[onclick*="toggleMobileMenu"]')) {
    mobileMenuOpen = false;
    const m = $('mobile-menu'); if (m) m.style.display = 'none';
    const btn = document.querySelector('#bottom-nav .bn-item[data-v="more"]'); if (btn) btn.classList.remove('on');
  }
});

/* Patch sidebar .ni → navTo */
document.querySelectorAll('.ni[data-v]').forEach(item => {
  item.addEventListener('click', () => navTo(item.dataset.v, null));
});

/* ════════════════════════════════════════════════
   FAQ SEARCH
════════════════════════════════════════════════ */
function filterFaq() {
  const q = ($('faq-search')?.value || '').toLowerCase().trim();
  let anyVisible = false;
  document.querySelectorAll('#view-aide .accord').forEach(item => {
    const match = !q || item.textContent.toLowerCase().includes(q);
    item.style.display = match ? '' : 'none';
    if (match) { anyVisible = true; if (q) item.classList.add('open'); else item.classList.remove('open'); }
  });
  document.querySelectorAll('#view-aide .faq-section').forEach(section => {
    section.style.display = [...section.querySelectorAll('.accord')].some(a => a.style.display !== 'none') ? '' : 'none';
  });
  const noRes = $('faq-no-result');
  if (noRes) noRes.style.display = anyVisible ? 'none' : 'block';
}

/* ════════════════════════════════════════════════
   BINDINGS addEventListener
   (exécutés ici car script APRÈS le DOM)
════════════════════════════════════════════════ */
const btnL = $('btn-l');          if (btnL)         btnL.addEventListener('click', login);
const btnR = $('btn-r');          if (btnR)         btnR.addEventListener('click', register);
const tabL = $('tab-l');          if (tabL)         tabL.addEventListener('click', () => switchTab('l'));
const tabR = $('tab-r');          if (tabR)         tabR.addEventListener('click', () => switchTab('r'));
const btnSavePm   = $('btn-save-pm');     if (btnSavePm)    btnSavePm.addEventListener('click', savePM);
const btnChangePwd= $('btn-change-pwd');  if (btnChangePwd) btnChangePwd.addEventListener('click', changePwd);
const btnDelAcc   = $('btn-del-account'); if (btnDelAcc)    btnDelAcc.addEventListener('click', delAccount);
const admQ        = $('adm-q');           if (admQ)         admQ.addEventListener('input', debounce(filterAccs, 300));

/* ════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════ */
const today = new Date().toISOString().split('T')[0];
['f-ds', 'f-pr-dt', 'v-ds'].forEach(id => { const e = $(id); if (e) e.value = today; });
updateNavMode();
checkAuth();
