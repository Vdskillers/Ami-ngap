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

  /* Dashboard & Stats → charger données */
  if (v === 'dash') {
    if (typeof loadDash === 'function') loadDash();
    if (typeof loadStatsAvancees === 'function') setTimeout(loadStatsAvancees, 300);
  }

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

      /* Restaurer le marker du point de départ si déjà défini — sans appeler
         renderPatientsOnMap qui peut écraser APP.map et casser le handler de clic */
      if (typeof _restoreStartPointMarker === 'function') {
        setTimeout(() => _restoreStartPointMarker(), 350);
      }

    }, 150);
  }

  /* Uber → charger patients si pas déjà fait */
  if (v === 'uber' && typeof loadUberPatients === 'function') {
    if (!APP.get('uberPatients')?.length) loadUberPatients();
  }

  /* Planning → restaurer depuis localStorage et re-rendre */
  if (v === 'pla') {
    setTimeout(() => {
      if (typeof _restorePlanningIfNeeded === 'function') _restorePlanningIfNeeded();
      const hasPts = APP.importedData?.patients?.length || APP.importedData?.entries?.length;
      if (hasPts && typeof renderPlanning === 'function') {
        renderPlanning({}).catch(() => {});
      }
    }, 120);
  }

  /* Historique → charger les cotations */
  if (v === 'his') {
    setTimeout(() => {
      if (typeof hist === 'function') hist();
    }, 100);
  }

  /* Documentation & FAQ → charger le guide infirmières */
  if (v === 'aide') {
    setTimeout(() => {
      if (typeof loadFaqGuide === 'function') loadFaqGuide();
    }, 80);
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
/* ════════════════════════════════════════════════
   FAQ GUIDE — chargement dynamique GUIDE_INFIRMIERES.md
   + recherche en temps réel
════════════════════════════════════════════════ */

/** Convertit le Markdown simplifié du guide en HTML accordéon */
function _mdToFaqHtml(md) {
  const lines   = md.split('\n');
  let html      = '';
  let inSection = false;
  let inAnswer  = false;
  let answerBuf = '';

  const _flushAnswer = () => {
    if (!inAnswer) return;
    // Convertir le contenu de la réponse en HTML basique
    let body = answerBuf.trim()
      // Tableaux Markdown simples
      .replace(/\|(.+)\|/g, (m) => {
        const cells = m.split('|').filter(c => c.trim() && !/^[-\s|]+$/.test(c));
        return cells.length ? '<tr>' + cells.map(c => `<td style="padding:6px 10px;border-bottom:1px solid var(--b)">${c.trim()}</td>`).join('') + '</tr>' : '';
      })
      // Lignes de séparation tableau → wrapper
      .replace(/((<tr>.*<\/tr>\n?)+)/g, (m) => `<table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:13px">${m}</table>`)
      // Gras
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italique
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Code inline
      .replace(/`([^`]+)`/g, '<code style="background:var(--s);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>')
      // Listes à tirets
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul style="padding-left:1.2rem;margin:6px 0">${m}</ul>`)
      // Sauts de ligne
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
    html += `<div class="accord-body"><p>${body}</p></div></div>`;
    answerBuf = '';
    inAnswer  = false;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Titre de section (##)
    if (/^## /.test(line)) {
      _flushAnswer();
      if (inSection) html += '</div>';
      const title = line.replace(/^## /, '');
      html += `<div class="faq-section" data-faq-section style="margin-top:20px">
        <div class="lbl" style="margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid var(--a)">${title}</div>`;
      inSection = true;
      continue;
    }

    // Question (###)
    if (/^### /.test(line)) {
      _flushAnswer();
      const q = line.replace(/^### /, '');
      html += `<div class="accord faq-item">
        <div class="accord-hdr" onclick="this.closest('.accord').classList.toggle('open')">
          <div class="accord-hdr-txt">${q}</div>
          <div class="accord-arrow">▼</div>
        </div>`;
      inAnswer = true;
      continue;
    }

    // Ligne de séparation ---
    if (/^---+$/.test(line)) { _flushAnswer(); continue; }

    // Lignes de contenu de la réponse
    if (inAnswer) {
      answerBuf += line + '\n';
    }
  }

  _flushAnswer();
  if (inSection) html += '</div>';
  return html;
}

/** Charge GUIDE_INFIRMIERES.md et l'injecte dans #faq-content */
async function loadFaqGuide() {
  const container = document.getElementById('faq-content');
  if (!container) return;

  // Éviter le rechargement si déjà chargé
  if (container.dataset.loaded === '1') return;

  try {
    const res = await fetch('GUIDE_INFIRMIERES.md?v=' + (window._AMI_VERSION || '1'));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const md = await res.text();
    container.innerHTML = _mdToFaqHtml(md);
    container.dataset.loaded = '1';
  } catch (e) {
    container.innerHTML = `<div style="text-align:center;padding:32px;color:var(--m)">
      <div style="font-size:32px;margin-bottom:10px">📄</div>
      <p style="font-size:13px">Impossible de charger le guide.<br>
      <a href="GUIDE_INFIRMIERES.md" target="_blank" style="color:var(--a)">Ouvrir directement →</a></p>
    </div>`;
    console.warn('[AMI] loadFaqGuide KO:', e.message);
  }
}

function filterFaq() {
  const q = ($('faq-search')?.value || '').toLowerCase().trim();
  let anyVisible = false;

  document.querySelectorAll('#view-aide .accord').forEach(item => {
    const match = !q || item.textContent.toLowerCase().includes(q);
    item.style.display = match ? '' : 'none';
    if (match) {
      anyVisible = true;
      if (q) item.classList.add('open');
      else item.classList.remove('open');
    }
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
['f-ds', 'f-pr-dt'].forEach(id => { const e = $(id); if (e) e.value = today; });
updateNavMode();
checkAuth();
