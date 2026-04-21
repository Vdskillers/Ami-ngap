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
      if (typeof _planningInitCabinetUI === 'function') _planningInitCabinetUI();
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

  /* Cabinet multi-IDE → rendre la section cabinet */
  if (v === 'cabinet') {
    setTimeout(() => {
      if (typeof renderCabinetSection === 'function') renderCabinetSection();
    }, 80);
  }

  /* Note : les modules cliniques v2 (transmissions, constantes, pilulier,
     bsi, consentements, alertes-med, audit-cpam, compte-rendu) gèrent
     leur propre listener ui:navigate dans leurs fichiers JS respectifs. */

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

/**
 * Convertit le Markdown simplifié du guide en HTML accordéon.
 * Version line-based (v2) — corrige le rendu des tableaux :
 *  - plus de wrap <p> autour du body (HTML invalide avec <table>)
 *  - tableaux parsés en un seul <table> (thead + tbody)
 *  - plus de doublons de <br> qui créaient d'énormes espaces vides
 */
function _mdToFaqHtml(md) {
  const lines     = md.split('\n');
  let html        = '';
  let inSection   = false;
  let inAnswer    = false;
  let answerLines = [];

  /* ── Inline : gras, italique, code ── */
  const _inline = (s) => (s || '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code style="background:var(--s);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>');

  /* ── Parser cellules d'une ligne Markdown | a | b | c | ── */
  const _parseRow = (row) => {
    // Retire les | de début/fin puis split sur |
    const trimmed = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
    return trimmed.split('|').map(c => c.trim());
  };

  /* ── Rendu d'un bloc de lignes markdown formant un tableau ── */
  const _renderTable = (rows) => {
    if (rows.length < 2) return '';
    const header   = _parseRow(rows[0]);
    // Ligne 1 = séparateur |---|---|  → on saute
    // Lignes 2+ = données, en filtrant toute ligne de dashes résiduelle
    const bodyRows = rows.slice(2).filter(r => !/^\s*\|[\s\-:|]+\|\s*$/.test(r));

    let t = `<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px;table-layout:auto">`;
    t += `<thead><tr>` + header.map(h =>
      `<th style="text-align:left;padding:8px 10px;border-bottom:2px solid var(--a);color:var(--a);font-family:var(--fm);font-size:10px;letter-spacing:.8px;text-transform:uppercase;font-weight:600">${_inline(h)}</th>`
    ).join('') + `</tr></thead>`;
    t += `<tbody>` + bodyRows.map(r => {
      const cells = _parseRow(r);
      return `<tr>` + cells.map(c =>
        `<td style="padding:8px 10px;border-bottom:1px solid var(--b);vertical-align:top;line-height:1.5">${_inline(c)}</td>`
      ).join('') + `</tr>`;
    }).join('') + `</tbody></table>`;
    return t;
  };

  /* ── Convertit l'ensemble des lignes d'une réponse en HTML ── */
  const _processAnswer = (arr) => {
    let out = '';
    let i   = 0;
    const isTable  = (l) => /^\s*\|.+\|\s*$/.test(l);
    const isList   = (l) => /^\s*- /.test(l);
    const isQuote  = (l) => /^\s*> /.test(l);
    const isEmpty  = (l) => l.trim() === '';

    while (i < arr.length) {
      const line = arr[i];

      if (isEmpty(line))       { i++; continue; }

      if (isTable(line)) {
        const block = [];
        while (i < arr.length && isTable(arr[i])) { block.push(arr[i]); i++; }
        out += _renderTable(block);
        continue;
      }

      if (isList(line)) {
        const items = [];
        while (i < arr.length && isList(arr[i])) {
          items.push(arr[i].trim().replace(/^-\s+/, ''));
          i++;
        }
        out += `<ul style="padding-left:1.2rem;margin:8px 0;line-height:1.7">` +
          items.map(x => `<li>${_inline(x)}</li>`).join('') + `</ul>`;
        continue;
      }

      if (isQuote(line)) {
        // Regrouper les lignes de blockquote contiguës
        const ql = [];
        while (i < arr.length && isQuote(arr[i])) {
          ql.push(arr[i].trim().replace(/^>\s+/, ''));
          i++;
        }
        out += `<div style="border-left:3px solid var(--a);padding:10px 14px;margin:10px 0;background:var(--s);border-radius:0 8px 8px 0;font-size:13px;line-height:1.6">${_inline(ql.join(' '))}</div>`;
        continue;
      }

      // Paragraphe : lignes contiguës non-vides, non-spéciales
      const para = [];
      while (i < arr.length && !isEmpty(arr[i]) && !isTable(arr[i]) && !isList(arr[i]) && !isQuote(arr[i])) {
        para.push(arr[i].trim());
        i++;
      }
      if (para.length) {
        out += `<p style="margin:8px 0;line-height:1.6">${_inline(para.join(' '))}</p>`;
      }
    }

    return out;
  };

  const _flushAnswer = () => {
    if (!inAnswer) return;
    html += `<div class="accord-body">${_processAnswer(answerLines)}</div></div>`;
    answerLines = [];
    inAnswer    = false;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');   // trim trailing whitespace seulement

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

    // Lignes de contenu de la réponse (on garde les lignes vides pour détecter les blocs)
    if (inAnswer) answerLines.push(line);
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
