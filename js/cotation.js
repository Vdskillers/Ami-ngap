/* ════════════════════════════════════════════════
   cotation.js — AMI NGAP v7
   ────────────────────────────────────────────────
   Cotation NGAP + Vérification IA
   - cotation() — appel API calcul NGAP (N8N v7)
     → preuve_soin (auto_declaration / signature_patient)
     → upsert IDB : cotationIdx > invoice_number > invoice_number original
     → mode édition (_editRef) : jamais de doublon
   - renderCot() — affiche résultat N8N v7
     → fraud (score, level, flags)
     → preuve_soin (force_probante)
     → cpam_simulation (anomalies, décision)
     → suggestions_optimisation
     → infirmiere_scoring
   - printInv() — vérifie infos pro → modale si manquantes → PDF
   - closeProInfoModal() — ferme la modale infos pro
   - clrCot() — réinitialise le formulaire
   - coterDepuisRoute() — cotation depuis tournée
   - openVerify() / closeVM() / applyVerify()
   - verifyStandalone() — vérification indépendante
   ── CABINET MULTI-IDE (v8) ──
   - cotationToggleCabinetMode() — active/désactive le mode cabinet
   - cotationRenderCabinetActes() — rendu des sélecteurs "Qui fait quoi ?"
   - cotationOptimizeDistribution() — suggestion IA de répartition optimale
   - cotationCabinet() — pipeline cotation multi-IDE

   Tarifs NGAP 2026 (référence — calcul officiel côté N8N) :
   AMI=3,15€ · AIS=2,65€ · BSA=13€ · BSB=18,20€ · BSC=28,70€
   IFD=2,75€ · MCI=5€ · MIE=3,15€ · NUIT=9,15€ · NUIT_PROF=18,30€
   DIM=8,50€ · IK=km×2×0,35€
   Règles : acte principal×1, secondaires×0,5, majorations×1
   AIS+BSx : INTERDIT — BSA/BSB/BSC : mutuellement exclusifs
════════════════════════════════════════════════ */

let VM_DATA = null;
let _pendingPrintData = null; // données facture en attente d'impression

/* ════════════════════════════════════════════════
   MODE CABINET — UX Cotation multi-IDE
════════════════════════════════════════════════ */

// Tarifs locaux pour estimation cabinet côté client
const _COT_TARIFS = {
  AMI1:3.15, AMI2:6.30, AMI3:9.45, AMI4:12.60, AMI5:15.75, AMI6:18.90,
  AIS1:2.65, AIS3:7.95, BSA:13.00, BSB:18.20, BSC:28.70, IFD:2.75,
};

// Actes NGAP détectés depuis le texte libre (pour le sélecteur multi-IDE)
const _COT_NLP_PATTERNS = [
  { rx: /injection|insuline|anticoagulant|héparine|piqûre/i,     code:'AMI1', label:'Injection SC/IM' },
  { rx: /intraveineuse|ivd|iv directe/i,                          code:'AMI2', label:'Injection IV directe' },
  { rx: /prélèvement|prise de sang|pds|bilan sanguin/i,           code:'AMI1', label:'Prélèvement veineux' },
  { rx: /pansement complexe|escarre|plaie chronique|nécrose/i,    code:'AMI4', label:'Pansement complexe' },
  { rx: /pansement/i,                                             code:'AMI1', label:'Pansement simple' },
  { rx: /perfusion.*>.*1h|perfusion.*longue/i,                    code:'AMI6', label:'Perfusion longue (>1h)' },
  { rx: /perfusion|perf\b/i,                                      code:'AMI5', label:'Perfusion' },
  { rx: /toilette.*totale|grabataire|nursing.*lourd/i,            code:'BSC', label:'Bilan soins C (dép. lourde)' },
  { rx: /toilette.*modér|dépendance modér/i,                      code:'BSB', label:'Bilan soins B (dép. modérée)' },
  { rx: /toilette|nursing|bilan soins|bsi/i,                      code:'BSA', label:'Bilan soins A (dép. légère)' },
  { rx: /ecg|électrocardiogramme/i,                               code:'AMI3', label:'ECG' },
];

/**
 * Détecte les actes depuis le texte libre (NLP léger côté client)
 * Retourne [ { code, label }, … ] sans doublons
 */
function _cotDetectActes(texte) {
  const found = [], seenCodes = new Set();
  for (const pat of _COT_NLP_PATTERNS) {
    if (pat.rx.test(texte) && !seenCodes.has(pat.code)) {
      found.push({ code: pat.code, label: pat.label });
      seenCodes.add(pat.code);
    }
  }
  if (!found.length) found.push({ code: 'AMI1', label: 'Acte infirmier (à préciser)' });
  return found;
}

/**
 * cotationToggleCabinetMode — active/désactive le panneau multi-IDE
 */
function cotationToggleCabinetMode(active) {
  const panel = $('cot-cabinet-panel');
  if (!panel) return;
  panel.style.display = active ? 'block' : 'none';
  if (active) cotationRenderCabinetActes();
}

/**
 * cotationRenderCabinetActes — affiche un sélecteur IDE par acte détecté
 */
function cotationRenderCabinetActes() {
  const list = $('cot-cabinet-actes-list');
  if (!list) return;

  const cab = APP.get('cabinet');
  const members = cab?.members || [];
  const texte = gv('f-txt');

  if (!members.length) {
    list.innerHTML = `<div class="ai wa" style="font-size:12px">⚠️ Vous n'êtes pas dans un cabinet. <a href="#" onclick="if(typeof navTo==='function')navTo('cabinet',null);return false;" style="color:var(--a)">Rejoindre un cabinet →</a></div>`;
    return;
  }

  const actes = _cotDetectActes(texte);
  const meId  = APP.user?.id || 'moi';
  const meLabel = ((APP.user?.prenom||'') + ' ' + (APP.user?.nom||'')).trim() || 'Moi';

  const memberOptions = [
    `<option value="${meId}">${meLabel} (moi)</option>`,
    ...members.filter(m => m.id !== meId).map(m =>
      `<option value="${m.id}">${m.prenom} ${m.nom}</option>`
    )
  ].join('');

  list.innerHTML = actes.map((acte, i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--b);border-radius:8px;background:var(--s);flex-wrap:wrap">
      <div style="flex:1;min-width:120px">
        <div style="font-weight:600;font-size:13px">${acte.label}</div>
        <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${acte.code} · ${(_COT_TARIFS[acte.code]||3.15).toFixed(2)} €</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span style="font-size:11px;color:var(--m)">→ Réalisé par :</span>
        <select id="cot-cab-ide-${i}" data-acte="${acte.code}" data-idx="${i}"
          onchange="cotationUpdateCabinetTotal()"
          style="padding:6px 10px;background:var(--s);border:1px solid var(--b);border-radius:6px;color:var(--t);font-size:12px">
          ${memberOptions}
        </select>
      </div>
    </div>`).join('');

  cotationUpdateCabinetTotal();
}

/**
 * cotationUpdateCabinetTotal — recalcule et affiche les totaux par IDE
 */
function cotationUpdateCabinetTotal() {
  const list = $('cot-cabinet-actes-list');
  if (!list) return;

  const selectors = list.querySelectorAll('select[id^="cot-cab-ide-"]');
  if (!selectors.length) return;

  const totals = {};
  selectors.forEach(sel => {
    const code  = sel.dataset.acte;
    const ideId = sel.value;
    const tarif = _COT_TARIFS[code] || 3.15;
    totals[ideId] = (totals[ideId] || 0) + tarif;
  });

  const cab     = APP.get('cabinet');
  const members = cab?.members || [];
  const meId    = APP.user?.id || 'moi';
  const meLabel = ((APP.user?.prenom||'') + ' ' + (APP.user?.nom||'')).trim() || 'Moi';

  // Afficher les totaux estimés
  const existing = $('cot-cabinet-totals');
  const wrap = existing || document.createElement('div');
  wrap.id = 'cot-cabinet-totals';
  wrap.style.cssText = 'margin-top:10px;padding:10px;background:rgba(0,212,170,.06);border-radius:8px;font-size:13px';

  const lines = Object.entries(totals).map(([id, total]) => {
    const m  = members.find(x => x.id === id);
    const nm = id === meId ? meLabel : (m ? `${m.prenom} ${m.nom}` : id.slice(0,8)+'…');
    return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <span>${nm}</span>
      <strong style="color:var(--a)">${total.toFixed(2)} €</strong>
    </div>`;
  }).join('');

  const grand = Object.values(totals).reduce((s, v) => s + v, 0);
  wrap.innerHTML = lines + `<div style="border-top:1px solid var(--b);margin-top:6px;padding-top:6px;display:flex;justify-content:space-between"><strong>TOTAL CABINET</strong><strong style="color:var(--a);font-size:15px">${grand.toFixed(2)} €</strong></div>`;

  if (!existing) {
    const panel = $('cot-cabinet-panel');
    if (panel) {
      const actesWrap = $('cot-cabinet-actes-list');
      if (actesWrap && actesWrap.nextSibling) panel.insertBefore(wrap, actesWrap.nextSibling);
      else if (panel) panel.appendChild(wrap);
    }
  }
}

/**
 * cotationOptimizeDistribution — suggestion IA de répartition optimale
 * Trie par tarif décroissant et répartit en alternant les IDEs
 */
function cotationOptimizeDistribution() {
  const list = $('cot-cabinet-actes-list');
  if (!list) return;

  const selectors = Array.from(list.querySelectorAll('select[id^="cot-cab-ide-"]'));
  if (!selectors.length) { if (typeof showToast==='function') showToast('Aucun acte détecté.', 'wa'); return; }

  const cab = APP.get('cabinet');
  if (!cab?.members?.length) return;

  const meId = APP.user?.id || 'moi';
  // IDEs disponibles : moi + membres
  const ideIds = [meId, ...cab.members.filter(m => m.id !== meId).map(m => m.id)];

  // Trier les actes par tarif décroissant (acte le plus valorisé en premier)
  const sorted = [...selectors].sort((a, b) =>
    (_COT_TARIFS[b.dataset.acte] || 0) - (_COT_TARIFS[a.dataset.acte] || 0)
  );

  // Répartir : IDE 0 prend le plus cher, IDE 1 le suivant, etc.
  sorted.forEach((sel, i) => {
    sel.value = ideIds[i % ideIds.length];
  });

  cotationUpdateCabinetTotal();

  const sugg = $('cot-cabinet-suggestion');
  if (sugg) {
    sugg.textContent = '✅ Répartition optimisée — chaque IDE a son acte principal à tarif plein';
    sugg.style.display = 'block';
    setTimeout(() => { sugg.style.display = 'none'; }, 4000);
  }
}

/**
 * Construit le payload multi-IDE depuis les sélecteurs cabinet
 */
function _cotBuildCabinetPayload() {
  const list = $('cot-cabinet-actes-list');
  if (!list) return null;

  const selectors = list.querySelectorAll('select[id^="cot-cab-ide-"]');
  if (!selectors.length) return null;

  const actes = [];
  selectors.forEach(sel => {
    actes.push({
      code:         sel.dataset.acte,
      performed_by: sel.value,
    });
  });
  return actes;
}

/**
 * renderCotCabinet — affiche le résultat multi-IDE
 */
function renderCotCabinet(d) {
  const cotations = d.cotations || [];
  const cab = APP.get('cabinet');
  const members = cab?.members || [];
  const meId = APP.user?.id || 'moi';
  const meLabel = ((APP.user?.prenom||'') + ' ' + (APP.user?.nom||'')).trim() || 'Moi';

  const cotHTML = cotations.map(cot => {
    const m  = members.find(x => x.id === cot.ide_id);
    const nm = cot.ide_id === meId ? meLabel : (m ? `${m.prenom} ${m.nom}` : cot.ide_id?.slice(0,8)+'…');
    const actesList = (cot.actes || []).map(a =>
      `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--b)">
        <span>${a.nom||a.code}</span>
        <span style="font-family:var(--fm)">${(a.total||0).toFixed(2)} €</span>
      </div>`
    ).join('');

    return `<div class="cab-cot-result">
      <div class="cab-cot-header">
        <span>👤 ${nm}</span>
        <span class="cab-cot-total">${(cot.total||0).toFixed(2)} €</span>
      </div>
      <div class="cab-cot-body">${actesList || '<span style="color:var(--m)">—</span>'}</div>
    </div>`;
  }).join('');

  return `<div class="card">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
      <div style="font-size:22px;font-family:var(--fs);font-weight:700">🏥 Cotation cabinet</div>
      <div style="background:rgba(0,212,170,.12);color:var(--a);border-radius:20px;font-size:11px;padding:2px 10px;font-family:var(--fm)">${cotations.length} IDE(s)</div>
    </div>
    ${cotHTML}
    <div style="margin-top:14px;padding:12px;background:rgba(0,212,170,.08);border-radius:8px;display:flex;justify-content:space-between;align-items:center">
      <strong>TOTAL CABINET</strong>
      <strong style="font-size:20px;color:var(--a);font-family:var(--fs)">${(d.total_global||0).toFixed(2)} €</strong>
    </div>
    ${d.cabinet_mode ? `<div class="ai in" style="margin-top:10px;font-size:11px">🏥 Mode cabinet — chaque IDE bénéficie de son acte principal au tarif plein</div>` : ''}
  </div>`;
}

/* ════════════════════════════════════════════════
   COTATION
════════════════════════════════════════════════ */
async function cotation() {
  const txt = gv('f-txt');
  if (!txt) { alert('Veuillez saisir une description.'); return; }

  // ── Mode cabinet : pipeline multi-IDE ─────────────────────────────────────
  const cabinetCheckbox = $('cot-cabinet-mode');
  if (cabinetCheckbox?.checked && APP.get('cabinet')?.id) {
    await cotationCabinet(txt);
    return;
  }
  ld('btn-cot', true);
  $('res-cot').classList.remove('show');
  $('cerr').style.display = 'none';

  // ── Feedback progressif si l'IA est lente (Grok cold start) ──
  const _btnEl = $('btn-cot');
  const _origBtnHTML = _btnEl ? _btnEl.innerHTML : null;
  const _slowTimers = [];
  const _showSlowMsg = (msg) => { if (_btnEl) _btnEl.innerHTML = `<span style="font-size:12px;font-weight:400">${msg}</span>`; };
  _slowTimers.push(setTimeout(() => _showSlowMsg('🤖 Analyse NGAP en cours…'),           5000));
  _slowTimers.push(setTimeout(() => _showSlowMsg('🤖 Calcul en cours — merci de patienter…'), 15000));
  _slowTimers.push(setTimeout(() => _showSlowMsg('🤖 Encore quelques secondes…'),        30000));
  _slowTimers.push(setTimeout(() => _showSlowMsg('🤖 Dernière tentative…'),               44000));
  const _clearSlowTimers = () => {
    _slowTimers.forEach(t => clearTimeout(t));
    if (_btnEl && _origBtnHTML) _btnEl.innerHTML = _origBtnHTML;
  };

  const u = S?.user || {};
  try {
    // Récupérer le prescripteur sélectionné (select ou champ texte libre)
    const prescSel = $('f-prescripteur-select');
    const prescripteur_id = prescSel?.value || null;

    // ── Correction heure soin ───────────────────────────────────────────────
    // Si f-hs n'a pas été édité manuellement par l'utilisateur (_userEdited),
    // utiliser l'heure locale courante (évite le bug "02:00" sur re-cotation).
    const _fHsEl = document.getElementById('f-hs');
    if (_fHsEl && !_fHsEl._userEdited) {
      const _now = new Date();
      _fHsEl.value = String(_now.getHours()).padStart(2,'0') + ':' + String(_now.getMinutes()).padStart(2,'0');
    }

    // ── Auto-détection mode édition ─────────────────────────────────────────
    // Si _editingCotation n'est pas encore positionné, vérifier dans l'IDB
    // si une cotation existe déjà pour ce patient à cette date.
    // Si oui → forcer le mode édition pour éviter tout doublon.
    if (!window._editingCotation) {
      try {
        const _patNomCheck = (gv('f-pt') || '').trim();
        const _dateCheck   = gv('f-ds') || new Date().toISOString().slice(0, 10);
        if (_patNomCheck && typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
          const _allRows = await _idbGetAll(PATIENTS_STORE);
          const _nomLow  = _patNomCheck.toLowerCase();
          const _foundRow = _allRows.find(r =>
            ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomLow) ||
            ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomLow)
          );
          if (_foundRow && typeof _dec === 'function') {
            const _foundPat = { ...(_dec(_foundRow._data) || {}), id: _foundRow.id };
            if (Array.isArray(_foundPat.cotations)) {
              // Chercher une cotation existante à la même date
              const _existIdx = _foundPat.cotations.findIndex(c => c.date === _dateCheck);
              if (_existIdx >= 0) {
                const _existCot = _foundPat.cotations[_existIdx];
                // Renseigner automatiquement _editingCotation
                window._editingCotation = {
                  patientId:    _foundRow.id,
                  cotationIdx:  _existIdx,
                  invoice_number: _existCot.invoice_number || null,
                  _autoDetected: true, // flag : positionné automatiquement (pas par l'utilisateur)
                };
              }
            }
          }
        }
      } catch (_autoDetectErr) {
        // Non bloquant — si la détection échoue, comportement normal
        console.warn('[cotation] auto-détection doublon:', _autoDetectErr.message);
      }
    }

    // Si mode édition, passer l'invoice_number original pour upsert Supabase
    const _editRef = window._editingCotation || null;

    // ── Pré-résolution patient IDB ─────────────────────────────────────────
    // Nécessaire pour envoyer patient_id à planning_patients AVANT le résultat IA
    let _prePatientId = _editRef?.patientId || null;
    if (!_prePatientId) {
      try {
        const _patNomPre = (gv('f-pt') || '').trim();
        if (_patNomPre && typeof _idbGetAll === 'function') {
          const _preRows = await _idbGetAll(PATIENTS_STORE);
          const _nomPre  = _patNomPre.toLowerCase();
          const _preRow  = _preRows.find(r =>
            ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomPre) ||
            ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomPre)
          );
          if (_preRow) _prePatientId = _preRow.id;
        }
      } catch (_) {}
    }
    // ── Preuve soin (N8N v7) — bouclier anti-redressement CPAM ──
    // La photo / signature ne sont JAMAIS transmises — uniquement leur hash
    // La géolocalisation est floue (département uniquement — RGPD compatible)
    const _sigEl = document.querySelector('[data-last-sig-hash]');
    const _sigHash = _sigEl?.dataset?.lastSigHash || '';
    const _preuveType = _sigHash ? 'signature_patient' : 'auto_declaration';
    const _preuveForce = _sigHash ? 'FORTE' : 'STANDARD';

    const d = await apiCall('/webhook/ami-calcul', {
      mode: 'ngap', texte: txt,
      infirmiere: ((u.prenom || '') + ' ' + (u.nom || '')).trim(),
      adeli: u.adeli || '', rpps: u.rpps || '', structure: u.structure || '',
      ddn: gv('f-ddn'), amo: gv('f-amo'), amc: gv('f-amc'),
      exo: gv('f-exo'), regl: gv('f-regl'),
      date_soin: gv('f-ds'), heure_soin: gv('f-hs'),
      prescripteur_nom: gv('f-pr') || '',
      prescripteur_rpps: gv('f-pr-rp') || '',
      date_prescription: gv('f-pr-dt') || '',
      ...(prescripteur_id ? { prescripteur_id } : {}),
      // patient_id IDB → rattachement cotation ↔ fiche dans planning_patients
      // Note : _prePatientId est résolu juste avant cet appel
      ...(_prePatientId ? { patient_id: _prePatientId } : {}),
      // invoice_number existant → le worker fera un PATCH au lieu d'un POST
      ...(_editRef?.invoice_number ? { invoice_number: _editRef.invoice_number } : {}),
      // Preuve soin — N8N v7 : hash uniquement, jamais les données brutes
      preuve_soin: {
        type:         _preuveType,
        timestamp:    new Date().toISOString(),
        hash_preuve:  _sigHash,
        certifie_ide: true,
        force_probante: _preuveForce,
      },
    });
    if (d.error) throw new Error(d.error);
    // Afficher le numéro de facture retourné par le worker (séquentiel CPAM)
    if (d.invoice_number && typeof displayInvoiceNumber === 'function') {
      displayInvoiceNumber(d.invoice_number);
    }
    // ── Mettre à jour _editingCotation avec l'invoice_number final ───────────
    // Garantit que toute re-cotation (ex : Vérifier→Corriger→Coter) fait un
    // PATCH Supabase et non un INSERT, évitant les doublons dans l'historique.
    if (d.invoice_number) {
      const _existRef = window._editingCotation;
      window._editingCotation = {
        patientId:      _existRef?.patientId      || null,
        cotationIdx:    _existRef?.cotationIdx     ?? -1,
        invoice_number: d.invoice_number,
        _autoDetected:  _existRef?._autoDetected   || false,
      };
    }
    // ── Mémoriser l'heure de soin dans le cache persistant (analyse horaire Dashboard) ──
    // Permet à l'analyse horaire de fonctionner même sans recharger l'historique API.
    try {
      if (typeof _updateHeureCache === 'function') {
        const heure = gv('f-hs');
        const date  = gv('f-ds') || new Date().toISOString().slice(0,10);
        if (heure) {
          _updateHeureCache([{
            id:         d.invoice_number || ('local_' + Date.now()),
            date_soin:  date,
            heure_soin: heure,
          }]);
        }
      }
    } catch {}
    _clearSlowTimers();
    $('cbody').innerHTML = renderCot(d);
    $('res-cot').classList.add('show');

    // ── Upsert cotation dans le carnet patient (IDB) ───────────────────────
    // RÈGLE STRICTE :
    //   • Patient existant → toujours upsert (mise à jour), jamais de doublon
    //   • Patient absent du carnet → créer la fiche + la cotation (1 seule fois)
    try {
      const _patNom = (gv('f-pt') || '').trim();
      if (_patNom && typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
        const _patRows = await _idbGetAll(PATIENTS_STORE);

        // Recherche par ID (mode édition) puis par nom exact/partiel
        let _patRow = _editRef?.patientId
          ? _patRows.find(r => r.id === _editRef.patientId)
          : null;
        if (!_patRow) {
          const _nomLow = _patNom.toLowerCase();
          _patRow = _patRows.find(r =>
            ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_nomLow) ||
            ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_nomLow)
          );
        }

        const _invNum = d.invoice_number || _editRef?.invoice_number || null;
        const _cotDate = gv('f-ds') || new Date().toISOString().slice(0,10);
        const _newCot = {
          date:           _cotDate,
          heure:          gv('f-hs') || '',
          actes:          d.actes || [],
          total:          parseFloat(d.total || 0),
          part_amo:       parseFloat(d.part_amo || 0),
          part_amc:       parseFloat(d.part_amc || 0),
          part_patient:   parseFloat(d.part_patient || 0),
          soin:           txt.slice(0, 120),
          invoice_number: _invNum,
          source:         _editRef ? 'cotation_edit' : 'cotation_form',
          _synced:        true,
        };

        if (_patRow) {
          // ── Patient existant → upsert strict ──────────────────────────
          const _pat = { id: _patRow.id, nom: _patRow.nom, prenom: _patRow.prenom, ...(_dec(_patRow._data)||{}) };
          if (!Array.isArray(_pat.cotations)) _pat.cotations = [];

          // Résoudre l'index à mettre à jour (ordre de priorité)
          let _idx = -1;
          // 1. cotationIdx direct (depuis fiche patient)
          if (typeof _editRef?.cotationIdx === 'number' && _editRef.cotationIdx >= 0)
            _idx = _editRef.cotationIdx;
          // 2. Par invoice_number (tournée ou re-cotation)
          if (_idx < 0 && _invNum)
            _idx = _pat.cotations.findIndex(c => c.invoice_number === _invNum);
          // 3. Par invoice_number original du ref (cas correction post-tournée)
          if (_idx < 0 && _editRef?.invoice_number)
            _idx = _pat.cotations.findIndex(c => c.invoice_number === _editRef.invoice_number);

          if (_idx >= 0) {
            // Cotation existante trouvée → mettre à jour
            _pat.cotations[_idx] = { ..._pat.cotations[_idx], ..._newCot, date_edit: new Date().toISOString() };
          } else if (!_editRef) {
            // Aucun index ET pas en mode édition → première cotation pour ce patient (OK d'ajouter)
            _pat.cotations.push(_newCot);
          }
          // Si _editRef mais pas d'index → ne rien faire (eviter les doublons)

          _pat.updated_at = new Date().toISOString();
          const _toStore1 = { id: _pat.id, nom: _pat.nom, prenom: _pat.prenom, _data: _enc(_pat), updated_at: _pat.updated_at };
          await _idbPut(PATIENTS_STORE, _toStore1);
          // Sync immédiate vers carnet_patients — propagation inter-appareils
          if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStore1).catch(() => {});

        } else if (!_editRef) {
          // ── Patient absent du carnet → créer la fiche + la cotation ──
          // Uniquement si ce n'est pas une correction (mode édition)
          const _parts = _patNom.trim().split(/\s+/);
          const _prenom = _parts.slice(0, -1).join(' ') || _patNom;
          const _nom    = _parts.length > 1 ? _parts[_parts.length - 1] : '';
          const _newPat = {
            id:         'pat_' + Date.now(),
            nom:        _nom,
            prenom:     _prenom,
            ddn:        gv('f-ddn') || '',
            amo:        gv('f-amo') || '',
            amc:        gv('f-amc') || '',
            exo:        gv('f-exo') || '',
            medecin:    gv('f-pr')  || '',
            cotations:  [_newCot],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            source:     'cotation_auto',
          };
          const _toStore2 = {
            id:         _newPat.id,
            nom:        _nom,
            prenom:     _prenom,
            _data:      _enc(_newPat),
            updated_at: _newPat.updated_at,
          };
          await _idbPut(PATIENTS_STORE, _toStore2);
          // Sync immédiate vers carnet_patients — propagation inter-appareils
          if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStore2).catch(() => {});
          if (typeof showToast === 'function')
            showToast('👤 Fiche patient créée automatiquement pour ' + _patNom);
        }
      }
    } catch(_idbErr) { console.warn('[cotation] IDB save KO:', _idbErr.message); }

    // ── Déclencher la signature après cotation ──────────────────────────────
    // Dispatch ami:cotation_done pour signature.js + injection directe du bouton
    const _invoiceId = d.invoice_number || null;
    if (_invoiceId) {  // admin inclus — peut tester et démontrer la signature
      // Injection directe du bouton de signature dans la card résultat
      const _cbody = $('cbody');
      if (_cbody && !_cbody.querySelector('.sig-btn-wrap')) {
        const _wrap = document.createElement('div');
        _wrap.className = 'sig-btn-wrap';
        _wrap.style.cssText = 'margin-top:14px;padding-top:14px;border-top:1px solid var(--b);display:flex;align-items:center;gap:12px;flex-wrap:wrap';
        _wrap.innerHTML = `
          <button class="btn bv bsm" id="sig-btn-${_invoiceId}" data-sig="${_invoiceId}"
            onclick="openSignatureModal('${_invoiceId}')">
            ✍️ Faire signer le patient
          </button>
          <span style="font-size:11px;color:var(--m)">Signature stockée localement · non transmise</span>`;
        _cbody.querySelector('.card')?.appendChild(_wrap);
      }
      // Dispatch pour tout listener externe
      document.dispatchEvent(new CustomEvent('ami:cotation_done', { detail: { invoice_number: _invoiceId } }));
    }
    // ── Nettoyer _editingCotation auto-détecté (ne doit pas persister entre cotations) ──
    // UNIQUEMENT si c'était une détection automatique — ne pas toucher aux refs manuelles
    // posées explicitement depuis la fiche patient (sans _autoDetected)
    if (window._editingCotation?._autoDetected) {
      window._editingCotation = null;
    }

  } catch (e) {
    // Nettoyer aussi en cas d'erreur (auto-détecté seulement)
    if (window._editingCotation?._autoDetected) {
      window._editingCotation = null;
    }
    _clearSlowTimers();
    $('cerr').style.display = 'flex';
    // Message plus clair pour timeout IA
    const isSlowTimeout = e.message && e.message.includes("prend plus de temps");
    $('cerr-m').textContent = isSlowTimeout
      ? "⏱️ L'IA a mis trop de temps à répondre. La cotation a été estimée automatiquement ci-dessous."
      : e.message;
    $('res-cot').classList.add('show');
  }
  ld('btn-cot', false);
}

function renderCot(d) {
  const a   = d.actes  || [];
  const al  = d.alerts || [];
  const op  = d.optimisations || [];
  const sugg = d.suggestions_optimisation || [];

  // ── Badge NGAP version ──────────────────────────────────────────────────────
  const ngapBadge = d.ngap_version
    ? `<span style="font-size:10px;color:var(--m);background:var(--s);border:1px solid var(--b);padding:2px 8px;border-radius:20px">NGAP v${d.ngap_version}</span>`
    : '';

  // ── Badge fraud N8N v7 ──────────────────────────────────────────────────────
  const fraud = d.fraud || {};
  const fraudBadge = fraud.level ? (() => {
    const cfg = {
      LOW:    { bg: 'rgba(0,212,170,.12)',  col: '#00b894', icon: '🟢', label: 'Faible risque CPAM' },
      MEDIUM: { bg: 'rgba(251,191,36,.15)', col: '#f59e0b', icon: '🟡', label: 'Risque CPAM modéré' },
      HIGH:   { bg: 'rgba(239,68,68,.15)',  col: '#ef4444', icon: '🔴', label: 'RISQUE CPAM ÉLEVÉ' },
    }[fraud.level] || { bg: '', col: 'var(--m)', icon: 'ℹ️', label: fraud.level };
    return `<div style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:${cfg.bg};color:${cfg.col}">
      ${cfg.icon} ${cfg.label}${fraud.score != null ? ` (${fraud.score} pts)` : ''}
    </div>`;
  })() : '';

  // ── Badge preuve soin N8N v7 ────────────────────────────────────────────────
  const preuve = d.preuve_soin || {};
  const preuveBadge = preuve.force_probante ? (() => {
    const cfg = {
      FORTE:    { bg: 'rgba(0,212,170,.12)',  col: '#00b894', icon: '🛡️', label: preuve.type === 'signature_patient' ? 'Preuve forte — Signature' : 'Preuve forte — Photo' },
      STANDARD: { bg: 'rgba(99,102,241,.1)',  col: '#6366f1', icon: '📋', label: 'Auto-déclaration IDE' },
      ABSENTE:  { bg: 'rgba(239,68,68,.1)',   col: '#ef4444', icon: '⚠️', label: 'Aucune preuve terrain' },
    }[preuve.force_probante] || null;
    if (!cfg) return '';
    return `<div style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:20px;font-size:11px;background:${cfg.bg};color:${cfg.col}">
      ${cfg.icon} ${cfg.label}
    </div>`;
  })() : '';

  // ── Badge horaire ───────────────────────────────────────────────────────────
  const horaireBadge = d.horaire_type && d.horaire_type !== 'jour'
    ? `<div style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:20px;font-size:11px;background:rgba(99,102,241,.1);color:#6366f1">
        ${d.horaire_type === 'nuit' ? '🌙 Nuit' : d.horaire_type === 'nuit_profonde' ? '🌑 Nuit profonde' : d.horaire_type === 'dimanche' ? '☀️ Dimanche/Férié' : ''}
      </div>`
    : '';

  // ── Bloc simulation CPAM N8N v7 ─────────────────────────────────────────────
  const cpam = d.cpam_simulation || {};
  const cpamBloc = (cpam.niveau && cpam.niveau !== 'OK') ? (() => {
    const isKO = cpam.niveau === 'CRITIQUE';
    return `<div style="margin-top:12px;padding:12px 14px;border-radius:8px;background:${isKO ? 'rgba(239,68,68,.08)' : 'rgba(251,191,36,.08)'};border:1px solid ${isKO ? '#ef4444' : '#f59e0b'}">
      <div style="font-size:11px;font-weight:700;color:${isKO ? '#ef4444' : '#f59e0b'};margin-bottom:6px">
        ${isKO ? '🚨' : '⚠️'} Simulation CPAM — ${cpam.decision || cpam.niveau}
      </div>
      ${(cpam.anomalies||[]).map(a => `<div style="font-size:11px;color:var(--fg);margin-bottom:2px">• ${a}</div>`).join('')}
    </div>`;
  })() : '';

  // ── Suggestions alternatives N8N v7 ─────────────────────────────────────────
  const suggBloc = sugg.length ? `<div style="margin-top:12px">
    <div class="lbl" style="font-size:10px;margin-bottom:6px;color:#22c55e">💰 Suggestions de valorisation</div>
    <div class="aic">${sugg.map(s =>
      `<div class="ai su" style="border-left:3px solid #22c55e">
        ${s.gain ? `<strong style="color:var(--a)">${s.gain}</strong> — ` : ''}${s.reason || ''}
        ${s.action ? `<span style="font-size:10px;opacity:.7"> → ${s.action}</span>` : ''}
      </div>`
    ).join('')}</div>
  </div>` : '';

  // ── Scoring infirmière N8N v7 ────────────────────────────────────────────────
  const scoring = d.infirmiere_scoring || {};
  const scoringBloc = (scoring.level && scoring.level !== 'SAFE') ? (() => {
    const col = scoring.level === 'DANGER' ? '#ef4444' : '#f59e0b';
    return `<div style="margin-top:10px;padding:8px 12px;border-radius:6px;background:rgba(239,68,68,.06);border:1px solid ${col};font-size:11px">
      <span style="color:${col};font-weight:700">${scoring.level === 'DANGER' ? '🚨' : '⚠️'} Scoring IDE : ${scoring.level}</span>
      ${scoring.score != null ? ` (${scoring.score} pts)` : ''}
    </div>`;
  })() : '';

  // ── Alertes NGAP ────────────────────────────────────────────────────────────
  const alertsBloc = al.length
    ? `<div class="aic" style="margin-top:12px">${al.map(x => {
        const isErr = x.startsWith('🚨') || x.startsWith('❌');
        const isOk  = x.startsWith('✅');
        return `<div class="ai ${isErr ? 'er' : isOk ? 'su' : 'wa'}">${x}</div>`;
      }).join('')}</div>`
    : `<div class="ai su" style="margin-top:12px">✅ Aucune alerte NGAP</div>`;

  // ── Optimisations ajoutées par N8N ──────────────────────────────────────────
  const opBloc = op.length ? `<div style="margin-top:12px">
    <div class="lbl" style="font-size:10px;margin-bottom:6px">⬆️ Optimisations appliquées</div>
    <div class="aic">${op.map(o => {
      const msg = typeof o === 'string' ? o : (o.msg || JSON.stringify(o));
      return `<div class="ai su">💰 ${msg}</div>`;
    }).join('')}</div>
  </div>` : '';

  return `<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
    <div>
      <div class="lbl">Total cotation</div>
      <div style="display:flex;align-items:baseline;gap:6px">
        <div class="ta">${(d.total || 0).toFixed(2)}</div><div class="tu">€</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center">
        ${d.dre_requise ? '<div class="dreb">📋 DRE requise</div>' : ''}
        ${ngapBadge}
        ${horaireBadge}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
        ${fraudBadge}
        ${preuveBadge}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
      <button class="btn bs bsm" onclick='printInv(${JSON.stringify(d).replace(/'/g, "&#39;")})'>📥 Télécharger facture</button>
      ${window._editingCotation ? `<button class="btn bp bsm" onclick='_saveEditedCotation(${JSON.stringify(d).replace(/'/g, "&#39;")})' style="background:var(--a);color:#fff;border-color:var(--a)">💾 Mettre à jour la cotation patient</button>` : ''}
    </div>
  </div>
  <div class="rg">
    <div class="rc am"><div class="rl">Part AMO (SS)</div><div class="ra">${fmt(d.part_amo)}</div><div class="rp">${d.taux_amo ? Math.round(d.taux_amo * 100) + '%' : '60%'}</div></div>
    <div class="rc mc"><div class="rl">Part AMC</div><div class="ra">${fmt(d.part_amc)}</div><div class="rp">Complémentaire</div></div>
    <div class="rc pa"><div class="rl">Part Patient</div><div class="ra">${fmt(d.part_patient)}</div><div class="rp">Ticket modérateur</div></div>
  </div>
  <div class="lbl" style="margin-bottom:10px;margin-top:16px">Détail des actes</div>
  <div class="al">${a.length
    ? a.map(x => `<div class="ar">
        <div class="ac ${cc(x.code)}">${x.code || '?'}</div>
        <div class="an">${x.nom || ''}</div>
        <div class="ao">×${(x.coefficient || 1).toFixed(1)}</div>
        <div class="at">${fmt(x.total)}</div>
      </div>`).join('')
    : '<div class="ai wa">⚠️ Aucun acte retourné</div>'}
  </div>
  ${alertsBloc}
  ${opBloc}
  ${suggBloc}
  ${cpamBloc}
  ${scoringBloc}
  </div>`;
}

/* Sauvegarde le résultat re-coté dans la cotation existante du carnet patient */
async function _saveEditedCotation(d) {
  const ref = window._editingCotation;
  if (!ref) return;

  const { patientId, cotationIdx, invoice_number: refInvoice, _fromTournee } = ref;
  // invoice_number final : préférer celui retourné par l'IA (PATCH Supabase),
  // sinon celui stocké dans ref (tournée sans re-cotation)
  const invNum = d.invoice_number || refInvoice || null;

  try {
    // ── 1. Mise à jour IDB carnet patient ───────────────────────────────────
    if (typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
      // Chercher la fiche patient : par ID direct si dispo, sinon par nom dans f-pt
      let row = null;
      const allRows = await _idbGetAll(PATIENTS_STORE);

      if (patientId) {
        row = allRows.find(r => r.id === patientId);
      }
      if (!row) {
        // Fallback : recherche par nom dans le champ f-pt
        const nomField = (typeof gv === 'function' ? gv('f-pt') : '') || '';
        const nomLow   = nomField.toLowerCase().trim();
        if (nomLow) {
          row = allRows.find(r =>
            ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(nomLow) ||
            ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(nomLow)
          );
        }
      }

      // Si aucune fiche trouvée et qu'on vient de la tournée (pas depuis fiche patient)
      // → créer la fiche patient automatiquement avec cette cotation
      if (!row && _fromTournee && typeof _enc === 'function') {
        const nomField = (typeof gv === 'function' ? gv('f-pt') : '') || '';
        if (nomField.trim()) {
          const parts  = nomField.trim().split(/\s+/);
          const prenom = parts.slice(0, -1).join(' ') || nomField.trim();
          const nom    = parts.length > 1 ? parts[parts.length - 1] : '';
          const newPat = {
            id: 'pat_' + Date.now(), nom, prenom,
            ddn:        (typeof gv === 'function' ? gv('f-ddn') : '') || '',
            amo:        (typeof gv === 'function' ? gv('f-amo') : '') || '',
            cotations: [{
              date:           new Date().toISOString(),
              actes:          d.actes || [],
              total:          parseFloat(d.total || 0),
              invoice_number: invNum,
              source:         'cotation_edit',
              _synced:        false,
            }],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            source:     'tournee_auto',
          };
          if (typeof _idbPut === 'function') {
            const _toStoreTN = { id: newPat.id, nom, prenom, _data: _enc(newPat), updated_at: newPat.updated_at };
            await _idbPut(PATIENTS_STORE, _toStoreTN);
            // Sync immédiate vers carnet_patients — propagation inter-appareils
            if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStoreTN).catch(() => {});
          }
          const toast = typeof showToast === 'function' ? showToast : (typeof showToastSafe === 'function' ? showToastSafe : null);
          if (toast) toast('👤 Fiche patient créée : ' + nomField.trim());
        }
      }

      if (row) {
        const p = { ...(_dec(row._data)||{}), id: row.id, nom: row.nom, prenom: row.prenom };
        if (!Array.isArray(p.cotations)) p.cotations = [];

        // Résoudre l'index de la cotation à mettre à jour :
        // 1. cotationIdx direct (fiche patient)
        // 2. Recherche par invoice_number (tournée)
        // 3. Recherche par source tournee + date du jour (dernier fallback)
        let idx = (typeof cotationIdx === 'number' && cotationIdx >= 0) ? cotationIdx : -1;
        if (idx < 0 && invNum) {
          idx = p.cotations.findIndex(c => c.invoice_number === invNum);
        }
        if (idx < 0 && invNum && refInvoice) {
          idx = p.cotations.findIndex(c => c.invoice_number === refInvoice);
        }
        if (idx < 0 && _fromTournee) {
          const today = new Date().toISOString().slice(0, 10);
          idx = p.cotations.findIndex(c =>
            (c.source === 'tournee' || c.source === 'tournee_auto' ||
             c.source === 'tournee_live' || c.source === 'cotation_edit') &&
            (c.date || '').slice(0, 10) === today
          );
        }

        const updatedCot = {
          ...(idx >= 0 ? p.cotations[idx] : {}),
          actes:        d.actes || [],
          total:        parseFloat(d.total || 0),
          part_amo:     parseFloat(d.part_amo || 0),
          part_amc:     parseFloat(d.part_amc || 0),
          part_patient: parseFloat(d.part_patient || 0),
          dre_requise:  !!d.dre_requise,
          invoice_number: invNum || (idx >= 0 ? p.cotations[idx]?.invoice_number : null),
          source:       'cotation_edit',
          date_edit:    new Date().toISOString(),
          // Conserver la date originale du soin
          date: (idx >= 0 && p.cotations[idx]?.date)
            ? p.cotations[idx].date
            : (typeof gv === 'function' ? gv('f-ds') : '') || new Date().toISOString().slice(0, 10),
          heure: (idx >= 0 && p.cotations[idx]?.heure)
            ? p.cotations[idx].heure
            : (typeof gv === 'function' ? gv('f-hs') : '') || '',
          soin: (idx >= 0 && p.cotations[idx]?.soin)
            ? p.cotations[idx].soin
            : (typeof gv === 'function' ? (gv('f-txt') || '').slice(0, 120) : ''),
        };

        if (idx >= 0) {
          // Cotation existante → mise à jour stricte
          p.cotations[idx] = updatedCot;
        }
        // Si idx < 0 : cotation introuvable mais patient existe
        // → NE PAS créer de doublon. L'upsert Supabase (bloc 2) gérera la synchro.

        p.updated_at = new Date().toISOString();
        const _toStoreTE = { id: row.id, nom: row.nom, prenom: row.prenom, _data: _enc(p), updated_at: p.updated_at };
        await _idbPut(PATIENTS_STORE, _toStoreTE);
        // Sync immédiate vers carnet_patients — propagation inter-appareils
        if (typeof _syncPatientNow === 'function') _syncPatientNow(_toStoreTE).catch(() => {});
      }
    }

    // ── 2. Sync Supabase (PATCH si invoice_number connu) ────────────────────
    if (invNum && typeof apiCall === 'function') {
      apiCall('/webhook/ami-save-cotation', {
        cotations: [{
          actes:          d.actes || [],
          total:          d.total || 0,
          part_amo:       d.part_amo || 0,
          part_amc:       d.part_amc || 0,
          part_patient:   d.part_patient || 0,
          dre_requise:    !!d.dre_requise,
          source:         'cotation_edit',
          invoice_number: invNum,
        }]
      }).catch(() => {});
    }

    // ── 3. Invalider le cache dashboard ─────────────────────────────────────
    try {
      const _key = (typeof _dashCacheKey === 'function') ? _dashCacheKey()
        : 'ami_dash_cache_' + ((typeof S !== 'undefined' ? S?.user?.id : '') || '');
      localStorage.removeItem(_key);
    } catch {}

    // ── 4. Réinitialiser + feedback ─────────────────────────────────────────
    window._editingCotation = null;

    const toast = typeof showToast === 'function' ? showToast
      : (typeof showToastSafe === 'function' ? showToastSafe : null);
    if (toast) toast('✅ Cotation mise à jour — ' + (d.total||0).toFixed(2) + ' €');

    // Retourner sur la fiche patient si on vient de la fiche (pas de la tournée)
    if (!_fromTournee && patientId) {
      setTimeout(() => {
        if (typeof navTo === 'function') navTo('patients', null);
        setTimeout(() => {
          if (typeof openPatientDetail === 'function') openPatientDetail(patientId);
        }, 200);
      }, 800);
    }

  } catch(e) {
    const toast = typeof showToast === 'function' ? showToast
      : (typeof showToastSafe === 'function' ? showToastSafe : null);
    if (toast) toast('❌ ' + e.message);
    console.warn('[AMI] _saveEditedCotation KO:', e.message);
  }
}

/* ════════════════════════════════════════════════
   IMPRESSION / PDF
   ────────────────────────────────────────────────
   1. Vérifie si ADELI, RPPS, Structure sont renseignés
   2. Si manquants → modale de complétion avec 2 choix :
        a) Enregistrer + Imprimer
        b) Imprimer sans ces infos
   3. Si complets → impression directe
════════════════════════════════════════════════ */
function printInv(d) {
  const u = S?.user || {};
  const missing = [];
  if (!u.adeli)     missing.push('N° ADELI');
  if (!u.rpps)      missing.push('N° RPPS');
  if (!u.structure) missing.push('Cabinet / Structure');

  if (missing.length > 0) {
    /* Infos manquantes → afficher la modale de complétion */
    _pendingPrintData = d;
    _showProInfoModal(u, missing);
  } else {
    /* Tout est renseigné → imprimer directement */
    _doPrint(d, u);
  }
}

/* Affiche la modale avec les champs manquants pré-remplis */
function _showProInfoModal(u, missing) {
  const modal = $('pro-info-modal');
  if (!modal) { /* fallback si la modale n'existe pas dans le HTML */ _doPrint(_pendingPrintData, u); return; }

  /* Liste des champs manquants */
  const listEl = $('pro-info-missing-list');
  if (listEl) listEl.innerHTML = `⚠️ Ces informations sont absentes de votre profil :<br><strong>${missing.join(' · ')}</strong><br><span style="font-size:11px;opacity:.8">Elles sont recommandées sur une facture de soins réglementaire.</span>`;

  /* Pré-remplir avec les valeurs existantes si partielles */
  const piAdeli = $('pi-adeli'), piRpps = $('pi-rpps'), piStruct = $('pi-structure');
  if (piAdeli)  { piAdeli.value  = u.adeli     || ''; piAdeli.required  = !u.adeli; }
  if (piRpps)   { piRpps.value   = u.rpps      || ''; piRpps.required   = !u.rpps; }
  if (piStruct) { piStruct.value = u.structure || ''; piStruct.required = !u.structure; }

  /* Masquer uniquement les champs déjà renseignés */
  if ($('pi-adeli')?.closest('.af'))  $('pi-adeli').closest('.af').style.display  = u.adeli     ? 'none' : '';
  if ($('pi-rpps')?.closest('.af'))   $('pi-rpps').closest('.af').style.display   = u.rpps      ? 'none' : '';
  if ($('pi-structure')?.closest('.af')) $('pi-structure').closest('.af').style.display = u.structure ? 'none' : '';

  /* Reset message */
  const msg = $('pro-info-msg');
  if (msg) msg.style.display = 'none';

  /* Bouton "Enregistrer et imprimer" */
  const btnSave = $('btn-pi-save-print');
  if (btnSave) {
    btnSave.onclick = async () => {
      const adeli     = sanitize(gv('pi-adeli')  || u.adeli     || '');
      const rpps      = sanitize(gv('pi-rpps')   || u.rpps      || '');
      const structure = sanitize(gv('pi-structure') || u.structure || '');

      btnSave.disabled = true;
      btnSave.innerHTML = '<span class="spin"></span> Enregistrement…';

      try {
        const res = await wpost('/webhook/profil-save', {
          nom: u.nom || '', prenom: u.prenom || '',
          adeli, rpps, structure,
          adresse: u.adresse || '', tel: u.tel || ''
        });
        if (!res.ok) throw new Error(res.error || 'Erreur sauvegarde');

        /* Mettre à jour la session locale */
        S.user = { ...S.user, adeli, rpps, structure };
        ss.save(S.token, S.role, S.user);

        closeProInfoModal();
        _doPrint(_pendingPrintData, S.user);
      } catch (e) {
        const msg = $('pro-info-msg');
        if (msg) { msg.textContent = '❌ ' + e.message; msg.style.display = 'block'; }
      } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = '<span>💾</span> Enregistrer et imprimer';
      }
    };
  }

  /* Bouton "Imprimer sans ces informations" */
  const btnAnyway = $('btn-pi-print-anyway');
  if (btnAnyway) {
    btnAnyway.onclick = () => {
      closeProInfoModal();
      _doPrint(_pendingPrintData, u);
    };
  }

  modal.style.display = 'flex';
}

function closeProInfoModal() {
  const modal = $('pro-info-modal');
  if (modal) modal.style.display = 'none';
  _pendingPrintData = null;
}

/* ════════════════════════════════════════════════
   GÉNÉRATION PDF / IMPRESSION
   ────────────────────────────────────────────────
   Affiche toutes les infos pro disponibles :
   - Nom complet
   - N° ADELI (si présent)
   - N° RPPS (si présent)
   - Cabinet / Structure (si présent)
   - Date + N° facture
════════════════════════════════════════════════ */
function _doPrint(d, u) {
  if (!d) return;
  const ac  = d.actes || [];
  // Priorité au numéro généré par le serveur (séquentiel CPAM)
  // Fallback local uniquement si le worker n'a pas encore renvoyé le numéro
  const num = d.invoice_number || ('F' + new Date().getFullYear() + '-' + String(Date.now()).slice(-6));
  const inf = ((u.prenom || '') + ' ' + (u.nom || '')).trim() || 'Infirmier(ère) libéral(e)';

  /* Bloc infos prescripteur (si disponible) */
  const prescBloc = d.prescripteur
    ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid #e0e7ef">
        <div style="font-size:11px;text-transform:uppercase;color:#6b7a99;letter-spacing:.5px;margin-bottom:6px">Prescripteur</div>
        <div style="font-weight:600">${d.prescripteur.nom || ''}</div>
        ${d.prescripteur.rpps ? `<div style="font-size:12px;color:#6b7a99">RPPS : <strong style="color:#1a1a2e">${d.prescripteur.rpps}</strong></div>` : ''}
        ${d.prescripteur.specialite ? `<div style="font-size:12px;color:#6b7a99">${d.prescripteur.specialite}</div>` : ''}
        ${gv('f-pr-dt') ? `<div style="font-size:12px;color:#6b7a99">Prescription du : ${gv('f-pr-dt')}</div>` : ''}
       </div>`
    : (gv('f-pr') ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid #e0e7ef">
        <div style="font-size:11px;text-transform:uppercase;color:#6b7a99;letter-spacing:.5px;margin-bottom:6px">Prescripteur</div>
        <div style="font-weight:600">${gv('f-pr')}</div>
        ${gv('f-pr-rp') ? `<div style="font-size:12px;color:#6b7a99">RPPS : ${gv('f-pr-rp')}</div>` : ''}
        ${gv('f-pr-dt') ? `<div style="font-size:12px;color:#6b7a99">Prescription du : ${gv('f-pr-dt')}</div>` : ''}
       </div>` : '');

  /* Bloc infos professionnelles — affiche seulement les champs renseignés */
  const infoPro = [
    u.structure ? `<div style="font-weight:600;margin-bottom:2px">${u.structure}</div>` : '',
    `<div>${inf}</div>`,
    u.adeli  ? `<div style="color:#6b7a99;font-size:12px">N° ADELI : <strong style="color:#1a1a2e">${u.adeli}</strong></div>`  : '',
    u.rpps   ? `<div style="color:#6b7a99;font-size:12px">N° RPPS : <strong style="color:#1a1a2e">${u.rpps}</strong></div>`    : '',
    u.adresse? `<div style="color:#6b7a99;font-size:12px">${u.adresse}</div>` : '',
    u.tel    ? `<div style="color:#6b7a99;font-size:12px">Tél : ${u.tel}</div>` : '',
  ].filter(Boolean).join('\n');

  /* Avertissement si infos manquantes */
  const missingWarning = (!u.adeli || !u.rpps || !u.structure)
    ? `<div style="background:#fff8e1;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#92400e">
        ⚠️ Facture générée sans : ${[!u.adeli?'N° ADELI':'',!u.rpps?'N° RPPS':'',!u.structure?'Cabinet/Structure':''].filter(Boolean).join(', ')}
       </div>`
    : '';

  /* ── Construction du HTML de facture ── */
  const htmlContent = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Facture ${num}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; padding: 40px; font-size: 14px; color: #1a1a2e; }
  h1 { font-size: 26px; color: #0b3954; margin-bottom: 4px; }
  .meta { font-size: 12px; color: #6b7a99; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; padding-bottom: 18px; border-bottom: 2px solid #e0e7ef; gap: 20px; }
  .hdr-left h1 { margin-bottom: 4px; }
  .hdr-right { text-align: right; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th { background: #f0f4fa; padding: 9px 12px; text-align: left; font-size: 11px; text-transform: uppercase; color: #6b7a99; letter-spacing: .5px; }
  td { padding: 10px 12px; border-bottom: 1px solid #e8edf5; }
  tfoot td { font-weight: 700; border-top: 2px solid #ccd5e0; background: #f7f9fc; }
  .rep { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 20px; }
  .rc { background: #f7f9fc; padding: 14px; border-radius: 8px; text-align: center; }
  .rl { font-size: 11px; text-transform: uppercase; color: #6b7a99; margin-bottom: 4px; }
  .rv { font-size: 22px; font-weight: 700; color: #0b3954; }
  .dre { margin-top: 16px; padding: 10px 14px; background: #e8f4ff; border-radius: 6px; font-size: 13px; color: #2563eb; }
  .footer { margin-top: 30px; padding-top: 16px; border-top: 1px solid #e0e7ef; font-size: 11px; color: #9ca3af; text-align: center; }
  .print-btn { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 20px; padding: 10px 20px; background: #0b3954; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
  @media print { .print-btn, .no-print { display: none !important; } body { padding: 20px; } }
</style>
</head>
<body>
<button class="print-btn no-print" onclick="window.print()">🖨️ Imprimer / Enregistrer en PDF</button>
${missingWarning}
<div class="hdr">
  <div class="hdr-left">
    <h1>Feuille de soins</h1>
    <div class="meta">N° ${num} · ${new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })}</div>
    ${d.date_soin ? `<div class="meta">Date du soin : ${d.date_soin}</div>` : ''}
    ${d.ngap_version ? `<div class="meta" style="color:#9ca3af">NGAP v${d.ngap_version}</div>` : ''}
  </div>
  <div class="hdr-right">
    ${infoPro}
    ${prescBloc}
  </div>
</div>

<table>
  <thead><tr><th>Code</th><th>Acte médical</th><th style="text-align:right">Coef.</th><th style="text-align:right">Montant</th></tr></thead>
  <tbody>
    ${ac.map(x => `<tr>
      <td style="font-weight:600;font-size:13px;color:#0b3954">${x.code || ''}</td>
      <td>${x.nom || ''}</td>
      <td style="text-align:right;color:#6b7a99">×${(x.coefficient || 1).toFixed(1)}</td>
      <td style="text-align:right;font-weight:600">${fmt(x.total)}</td>
    </tr>`).join('')}
  </tbody>
  <tfoot>
    <tr>
      <td colspan="3" style="text-align:right">TOTAL</td>
      <td style="text-align:right;font-size:16px">${fmt(d.total)}</td>
    </tr>
  </tfoot>
</table>

<div class="rep">
  <div class="rc"><div class="rl">Part AMO (SS)</div><div class="rv">${fmt(d.part_amo)}</div></div>
  <div class="rc"><div class="rl">Part AMC</div><div class="rv">${fmt(d.part_amc)}</div></div>
  <div class="rc"><div class="rl">Part Patient</div><div class="rv">${fmt(d.part_patient)}</div></div>
</div>

${d.dre_requise ? '<div class="dre">📋 <strong>DRE requise</strong> — Demande de Remboursement Exceptionnel</div>' : ''}

<div class="footer">
  AMI NGAP · N° facture : ${num} · Tarifs NGAP 2026 — AMI 3,15 € · BSA 13,00 € · BSB 18,20 € · BSC 28,70 € · IFD 2,75 € · MCI 5,00 € · MIE 3,15 € · Nuit 9,15 € · Nuit prof. 18,30 € · Dim./Fér. 8,50 € · Généré le ${new Date().toLocaleDateString('fr-FR')}
</div>
</body>
</html>`;

  /* ── Téléchargement via Blob (contourne le blocage popup navigateur) ── */
  try {
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `facture-${num}.html`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    /* Nettoyer après 3s */
    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (a.parentNode) document.body.removeChild(a);
    }, 3000);
    /* Feedback visuel */
    const btn = document.querySelector('[onclick*="printInv"]') || document.querySelector('.btn.bs');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '✅ Téléchargé !';
      setTimeout(() => { btn.innerHTML = orig; }, 2500);
    }
  } catch (e) {
    /* Fallback : essayer window.open si Blob échoue (très rare) */
    const w = window.open('', '_blank');
    if (!w) { alert('Impossible d\'ouvrir la facture. Vérifiez que les popups sont autorisés.'); return; }
    w.document.write(htmlContent);
    w.document.close();
  }
}

/* ════════════════════════════════════════════════
   COTATION CABINET — pipeline multi-IDE
════════════════════════════════════════════════ */

/**
 * cotationCabinet — appelle /webhook/cabinet-calcul avec les actes répartis par IDE
 */
async function cotationCabinet(txt) {
  ld('btn-cot', true);
  $('res-cot').classList.remove('show');
  $('cerr').style.display = 'none';

  const _btnEl = $('btn-cot');
  const _origHTML = _btnEl?.innerHTML;
  const _slow = [];
  const _showSlow = m => { if (_btnEl) _btnEl.innerHTML = `<span style="font-size:12px;font-weight:400">${m}</span>`; };
  _slow.push(setTimeout(() => _showSlow('🏥 Cotation cabinet en cours…'), 5000));
  _slow.push(setTimeout(() => _showSlow('🤖 Calcul multi-IDE…'), 15000));
  const _clear = () => { _slow.forEach(t => clearTimeout(t)); if (_btnEl && _origHTML) _btnEl.innerHTML = _origHTML; };

  try {
    const cab    = APP.get('cabinet');
    const u      = S?.user || {};
    const actes  = _cotBuildCabinetPayload();

    if (!actes?.length) {
      // Fallback : cotation solo si pas d'actes distribués
      _clear();
      ld('btn-cot', false);
      return cotation(); // re-appel sans mode cabinet
    }

    const payload = {
      cabinet_mode:  true,
      cabinet_id:    cab.id,
      actes,
      texte:         txt,
      mode:          'ngap',
      date_soin:     gv('f-ds') || new Date().toISOString().slice(0,10),
      heure_soin:    gv('f-hs') || '',
      exo:           gv('f-exo') || '',
      regl:          gv('f-regl') || 'patient',
      infirmiere:    ((u.prenom||'') + ' ' + (u.nom||'')).trim(),
      adeli:         u.adeli || '',
      rpps:          u.rpps  || '',
      structure:     u.structure || '',
    };

    const d = await apiCall('/webhook/cabinet-calcul', payload);
    _clear();

    if (!d.ok) throw new Error(d.error || 'Erreur cotation cabinet');

    // Afficher résultat multi-IDE
    $('cbody').innerHTML = renderCotCabinet(d);
    $('res-cot').classList.add('show');

    if (typeof showToast === 'function') showToast(`✅ Cabinet — Total : ${(d.total_global||0).toFixed(2)} €`, 'ok');

  } catch(e) {
    _clear();
    $('cerr').style.display = 'flex';
    $('cerr-m').textContent = e.message;
    $('res-cot').classList.add('show');
  }
  ld('btn-cot', false);
}

/**
 * initCotationCabinetToggle — affiche/masque le toggle cabinet selon APP.cabinet
 * Appelé par cabinet.js après initCabinet()
 */
function initCotationCabinetToggle() {
  const wrap = $('cot-cabinet-toggle-wrap');
  if (!wrap) return;
  const cab = APP.get('cabinet');
  wrap.style.display = (cab?.id && APP.role !== 'admin') ? 'block' : 'none';
}

// Réagir aux changements d'état cabinet
APP.on('cabinet', () => {
  initCotationCabinetToggle();
});

// Réagir aux modifications du texte pour rafraîchir les actes cabinet
document.addEventListener('input', e => {
  if (e.target?.id === 'f-txt' && $('cot-cabinet-mode')?.checked) {
    cotationRenderCabinetActes();
  }
});

/* ════════════════════════════════════════════════
   VÉRIFICATION IA (modale)
════════════════════════════════════════════════ */
async function openVerify() {
  const txt = gv('f-txt');
  if (!txt) { alert("Saisissez d'abord une description du soin."); return; }
  $('vm').classList.add('open');
  $('vm-loading').style.display = 'block';
  $('vm-result').style.display = 'none';
  $('vm-apply').style.display = 'none';
  $('vm-cotate').style.display = 'none';
  VM_DATA = null;
  try {
    const d = await apiCall('/webhook/ami-calcul', {
      mode: 'verify', texte: txt, ddn: gv('f-ddn'),
      date_soin: gv('f-ds'), heure_soin: gv('f-hs'),
      exo: gv('f-exo'), regl: gv('f-regl')
    });
    VM_DATA = d;
    renderVM(d);
  } catch (e) {
    $('vm-loading').style.display = 'none';
    $('vm-result').innerHTML = `<div class="vm-item warn">⚠️ Erreur : ${e.message}</div>`;
    $('vm-result').style.display = 'block';
  }
}

function renderVM(d) {
  $('vm-loading').style.display = 'none';
  $('vm-result').style.display = 'block';
  const corrige = d.texte_corrige || '', fixes = d.corrections || [],
        alerts = d.alerts || [], sugg = d.optimisations || [];
  const hasChanges = corrige || fixes.length || alerts.length || sugg.length;
  if (corrige && corrige !== gv('f-txt')) {
    $('vm-corr-wrap').style.display = 'block';
    $('vm-corrected-text').textContent = corrige;
    $('vm-apply').style.display = 'flex';
  } else { $('vm-corr-wrap').style.display = 'none'; }
  if (fixes.length)  { $('vm-fixes-wrap').style.display = 'block';  $('vm-fixes').innerHTML  = fixes.map(f  => `<div class="vm-item fix">✏️ ${f}</div>`).join(''); } else { $('vm-fixes-wrap').style.display  = 'none'; }
  if (alerts.length) { $('vm-alerts-wrap').style.display = 'block'; $('vm-alerts').innerHTML = alerts.map(a => `<div class="vm-item warn">⚠️ ${a}</div>`).join(''); } else { $('vm-alerts-wrap').style.display = 'none'; }
  if (sugg.length)   { $('vm-sugg-wrap').style.display   = 'block'; $('vm-sugg').innerHTML   = sugg.map(s   => `<div class="vm-item sugg">💡 ${s}</div>`).join(''); } else { $('vm-sugg-wrap').style.display   = 'none'; }
  $('vm-ok-wrap').style.display = hasChanges ? 'none' : 'block';
  $('vm-cotate').style.display = 'flex';
}

function applyVerify() { if (VM_DATA?.texte_corrige) $('f-txt').value = VM_DATA.texte_corrige; closeVM(); }
function closeVM() { $('vm').classList.remove('open'); }

async function verifyStandalone() {
  const txt = gv('v-txt');
  if (!txt) { alert('Saisissez une description.'); return; }
  ld('btn-ver', true);
  $('res-ver').classList.remove('show');
  try {
    const d = await apiCall('/webhook/ami-calcul', { mode: 'verify', texte: txt, date_soin: gv('v-ds'), heure_soin: gv('v-hs'), exo: gv('v-exo') });
    const corrige = d.texte_corrige || '', fixes = d.corrections || [], alerts = d.alerts || [], sugg = d.optimisations || [];
    $('vbody').innerHTML = `<div class="card"><div class="ct">🔍 Résultat</div>
    ${corrige ? `<div style="margin-bottom:16px"><div class="lbl" style="color:var(--ok)">Texte normalisé</div><div style="background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:14px;font-style:italic;font-size:14px;line-height:1.7">${corrige}</div></div>` : ''}
    ${fixes.length  ? `<div class="aic" style="margin-bottom:14px">${fixes.map(f  => `<div class="ai su">✏️ ${f}</div>`).join('')}</div>` : ''}
    ${alerts.length ? `<div class="aic" style="margin-bottom:14px">${alerts.map(a => `<div class="ai wa">⚠️ ${a}</div>`).join('')}</div>` : ''}
    ${sugg.length   ? `<div class="aic">${sugg.map(s => `<div class="ai in">💡 ${s}</div>`).join('')}</div>` : ''}
    ${!corrige && !fixes.length && !alerts.length && !sugg.length ? '<div class="ai su">✅ Description correcte</div>' : ''}
    </div>`;
    $('verr').style.display = 'none';
  } catch (e) {
    $('verr').style.display = 'flex';
    $('verr-m').textContent = e.message;
  }
  $('res-ver').classList.add('show');
  ld('btn-ver', false);
}

/* ════════════════════════════════════════════════
   UTILITAIRES
════════════════════════════════════════════════ */
function clrCot() {
  ['f-pr','f-pr-rp','f-pr-dt','f-pt','f-ddn','f-sec','f-amo','f-amc','f-txt','f-ds','f-hs']
    .forEach(id => { const e = $(id); if (e) e.value = ''; });
  ['f-exo','f-regl'].forEach(id => { const e = $(id); if (e) e.selectedIndex = 0; });
  // Réinitialiser le select prescripteur
  const prescSel = $('f-prescripteur-select');
  if (prescSel) prescSel.value = '';
  // Masquer le numéro de facture
  const invSec = $('invoice-number-section');
  if (invSec) invSec.style.display = 'none';
  const invDisplay = $('invoice-number-display');
  if (invDisplay) invDisplay.textContent = '';
  $('res-cot').classList.remove('show');
  // Réinitialiser le sélecteur patient
  if (typeof cotClearPatient === 'function') cotClearPatient();
  // Masquer les reco live
  const liveReco = $('live-reco');
  if (liveReco) liveReco.style.display = 'none';
  // Réinitialiser l'édition de cotation en cours
  window._editingCotation = null;
}

function coterDepuisRoute(desc, nomPatient) {
  navTo('cot', null);
  setTimeout(() => {
    const elTxt = $('f-txt'); if (elTxt) { elTxt.value = desc; elTxt.focus(); }
    const elPt  = $('f-pt');  if (elPt && nomPatient) elPt.value = nomPatient;
  }, 150);
}
