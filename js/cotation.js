/* ════════════════════════════════════════════════
   cotation.js — AMI NGAP
   ────────────────────────────────────────────────
   Cotation NGAP + Vérification IA
   - cotation() — appel API calcul NGAP
   - renderCot() — affiche la feuille de soins
   - printInv() — vérifie infos pro → modale si manquantes → PDF
   - closeProInfoModal() — ferme la modale infos pro
   - clrCot() — réinitialise le formulaire
   - coterDepuisRoute() — cotation depuis tournée
   - openVerify() / closeVM() / applyVerify()
   - verifyStandalone() — vérification indépendante
════════════════════════════════════════════════ */

let VM_DATA = null;
let _pendingPrintData = null; // données facture en attente d'impression

/* ════════════════════════════════════════════════
   COTATION
════════════════════════════════════════════════ */
async function cotation() {
  const txt = gv('f-txt');
  if (!txt) { alert('Veuillez saisir une description.'); return; }
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
    // Si mode édition, passer l'invoice_number original pour upsert Supabase
    const _editRef = window._editingCotation || null;
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
      // invoice_number existant → le worker fera un PATCH au lieu d'un POST
      ...(_editRef?.invoice_number ? { invoice_number: _editRef.invoice_number } : {}),
    });
    if (d.error) throw new Error(d.error);
    // Afficher le numéro de facture retourné par le worker (séquentiel CPAM)
    if (d.invoice_number && typeof displayInvoiceNumber === 'function') {
      displayInvoiceNumber(d.invoice_number);
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

    // ── Sauvegarder la cotation dans le carnet patient (IDB) ────────────────
    // Synchronise IDB ↔ Supabase pour que Dashboard et Carnet patient affichent
    // le même nombre de cotations.
    try {
      const _patNom = (gv('f-pt') || '').trim();
      if (_patNom && typeof _idbGetAll === 'function' && typeof PATIENTS_STORE !== 'undefined') {
        const _patRows = await _idbGetAll(PATIENTS_STORE);
        // Chercher le patient par nom (correspondance partielle insensible à la casse)
        const _patNomLower = _patNom.toLowerCase();
        const _patRow = _patRows.find(r =>
          ((r.nom||'') + ' ' + (r.prenom||'')).toLowerCase().includes(_patNomLower) ||
          ((r.prenom||'') + ' ' + (r.nom||'')).toLowerCase().includes(_patNomLower)
        );
        if (_patRow) {
          const _pat = { id: _patRow.id, nom: _patRow.nom, prenom: _patRow.prenom, ...(_dec(_patRow._data)||{}) };
          if (!Array.isArray(_pat.cotations)) _pat.cotations = [];

          const _newCot = {
            date:           gv('f-ds') || new Date().toISOString().slice(0,10),
            heure:          gv('f-hs') || '',
            actes:          d.actes || [],
            total:          parseFloat(d.total || 0),
            part_amo:       parseFloat(d.part_amo || 0),
            part_amc:       parseFloat(d.part_amc || 0),
            part_patient:   parseFloat(d.part_patient || 0),
            soin:           txt.slice(0, 120),
            invoice_number: d.invoice_number || (_editRef?.invoice_number) || null,
            source:         _editRef ? 'cotation_edit' : 'cotation_form',
            _synced:        true,
          };

          // Mode édition : remplacer la cotation existante par index
          if (_editRef && typeof _editRef.cotationIdx === 'number' && _pat.cotations[_editRef.cotationIdx]) {
            _pat.cotations[_editRef.cotationIdx] = {
              ..._pat.cotations[_editRef.cotationIdx],
              ..._newCot,
              date_edit: new Date().toISOString(),
            };
          } else {
            // Nouvelle cotation : vérifier l'absence de doublon par invoice_number
            const _alreadySaved = _newCot.invoice_number &&
              _pat.cotations.some(c => c.invoice_number === _newCot.invoice_number);
            if (!_alreadySaved) _pat.cotations.push(_newCot);
          }

          _pat.updated_at = new Date().toISOString();
          await _idbPut(PATIENTS_STORE, {
            id: _pat.id, nom: _pat.nom, prenom: _pat.prenom,
            _data: _enc(_pat), updated_at: _pat.updated_at,
          });
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
  } catch (e) {
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
  const a = d.actes || [], al = d.alerts || [], op = d.optimisations || [];
  const aiQualBadge = d.ai_quality
    ? `<div style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:${d.ai_quality==='high'?'rgba(0,212,170,.15)':d.ai_quality==='medium'?'rgba(251,191,36,.15)':'rgba(239,68,68,.15)'};color:${d.ai_quality==='high'?'#00d4aa':d.ai_quality==='medium'?'#f59e0b':'#ef4444'}">
        ${d.ai_quality==='high'?'🟢 IA haute qualité':d.ai_quality==='medium'?'🟡 IA qualité moyenne':'🔴 IA incertaine'}
        ${d.ai_score!=null?` — ${d.ai_score}/100`:''}
      </div>` : '';
  const gainBadge = d.gain_potentiel > 0
    ? `<div class="ai in" style="margin-top:8px">💰 Gain potentiel non coté : <strong>+${d.gain_potentiel.toFixed(2)} €</strong></div>`
    : '';
  const rentBadge = d.rentabilite_minute > 0
    ? `<div style="font-size:11px;color:var(--m);margin-top:4px">⏱️ Rentabilité estimée : ${d.rentabilite_minute.toFixed(2)} €/min · Temps ~${d.temps_estime||'?'}min</div>`
    : '';
  return `<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
    <div><div class="lbl">Total cotation</div>
    <div style="display:flex;align-items:baseline;gap:6px"><div class="ta">${(d.total || 0).toFixed(2)}</div><div class="tu">€</div></div>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">${d.dre_requise ? '<div class="dreb">📋 DRE requise</div>' : ''}</div>
    ${aiQualBadge}
    ${rentBadge}
    </div>
    <button class="btn bs bsm" onclick='printInv(${JSON.stringify(d).replace(/'/g, "&#39;")})'>📥 Télécharger facture</button>
  ${window._editingCotation ? `<button class="btn bp bsm" onclick='_saveEditedCotation(${JSON.stringify(d).replace(/'/g, "&#39;")})' style="background:var(--a);color:#fff;border-color:var(--a)">💾 Mettre à jour la cotation patient</button>` : ''}
  </div>
  <div class="rg">
    <div class="rc am"><div class="rl">Part AMO (SS)</div><div class="ra">${fmt(d.part_amo)}</div><div class="rp">${d.taux_amo ? Math.round(d.taux_amo * 100) + '%' : '60%'}</div></div>
    <div class="rc mc"><div class="rl">Part AMC</div><div class="ra">${fmt(d.part_amc)}</div><div class="rp">Complémentaire</div></div>
    <div class="rc pa"><div class="rl">Part Patient</div><div class="ra">${fmt(d.part_patient)}</div><div class="rp">Ticket modérateur</div></div>
  </div>
  <div class="lbl" style="margin-bottom:10px">Détail des actes</div>
  <div class="al">${a.length ? a.map(x => `<div class="ar"><div class="ac ${cc(x.code)}">${x.code || '?'}</div><div class="an">${x.nom || ''}</div><div class="ao">×${(x.coefficient || 1).toFixed(1)}</div><div class="at">${fmt(x.total)}</div></div>`).join('') : '<div class="ai wa">⚠️ Aucun acte retourné</div>'}</div>
  ${al.length ? `<div class="aic" style="margin-top:12px">${al.map(x => `<div class="ai ${x.startsWith('⚠️')?'wa':'er'}">⚠️ ${x.replace(/^⚠️\s*/,'')}</div>`).join('')}</div>` : '<div class="ai su" style="margin-top:12px">✅ Aucune alerte NGAP</div>'}
  ${gainBadge}
  ${op.length ? (() => {
    // Séparer upgrades (valorisation), pertes de revenus, incompatibilités, optimisations générales
    const upgrades      = op.filter(o => (typeof o === 'object' ? o.type : '') === 'upgrade');
    const lostRevenue   = op.filter(o => (typeof o === 'object' ? o.type : '') === 'lost_revenue');
    const incompats     = op.filter(o => (typeof o === 'object' ? o.type : '') === 'incompatibilite');
    const others        = op.filter(o => !['upgrade','lost_revenue','incompatibilite'].includes(typeof o === 'object' ? o.type : 'optimization'));
    const getMsg  = o => typeof o === 'string' ? o : (o.msg || '');
    const getGain = o => typeof o === 'object' && o.gain > 0 ? ` <strong style="color:var(--a)">+${o.gain.toFixed(2)} €</strong>` : '';
    const getCode = o => typeof o === 'object' && o.code_suggere ? ` <span style="font-family:var(--fm);font-size:10px;background:var(--ad);color:var(--a);padding:1px 7px;border-radius:20px;margin-left:6px">${o.code_suggere}</span>` : '';
    let html = '<div style="margin-top:14px">';
    if (upgrades.length) html += `<div class="lbl" style="font-size:10px;margin-bottom:6px;color:#22c55e">⬆️ Valorisations légales possibles</div>`
      + `<div class="aic">${upgrades.map(o => `<div class="ai su" style="border-left:3px solid #22c55e">`
        + `⬆️ ${getMsg(o)}${getGain(o)}${getCode(o)}</div>`).join('')}</div>`;
    if (lostRevenue.length) html += `<div class="lbl" style="font-size:10px;margin-bottom:6px;margin-top:10px;color:var(--w)">💰 Revenus non cotés détectés</div>`
      + `<div class="aic">${lostRevenue.map(o => `<div class="ai wa">`
        + `💰 ${getMsg(o)}${getGain(o)}${getCode(o)}</div>`).join('')}</div>`;
    if (incompats.length) html += `<div class="aic" style="margin-top:8px">${incompats.map(o =>`<div class="ai er">${getMsg(o)}</div>`).join('')}</div>`;
    if (others.length) html += `<div class="lbl" style="font-size:10px;margin-bottom:6px;margin-top:${upgrades.length||lostRevenue.length?10:0}px">💡 Optimisations</div>`
      + `<div class="aic">${others.map(o => `<div class="ai in">💡 ${getMsg(o)}${getGain(o)}</div>`).join('')}</div>`;
    html += '</div>';
    return html;
  })() : ''}
  ${d.ai_issues && d.ai_issues.length ? `<div class="aic" style="margin-top:8px">${d.ai_issues.map(x=>`<div class="ai wa">🔍 ${x}</div>`).join('')}</div>` : ''}
  </div>`;
}

/* Sauvegarde le résultat re-coté dans la cotation existante du carnet patient */
async function _saveEditedCotation(d) {
  const ref = window._editingCotation;
  if (!ref) return;
  const { patientId, cotationIdx } = ref;

  try {
    const rows = await _idbGetAll(PATIENTS_STORE);
    const row  = rows.find(r => r.id === patientId);
    if (!row) throw new Error('Patient non trouvé');

    const p = { ...(_dec(row._data)||{}), id: row.id, nom: row.nom, prenom: row.prenom };
    if (!p.cotations?.[cotationIdx]) throw new Error('Cotation introuvable');

    // Mettre à jour avec les nouvelles données IA
    p.cotations[cotationIdx] = {
      ...p.cotations[cotationIdx],
      actes:     d.actes || [],
      total:     d.total || 0,
      part_amo:  d.part_amo,
      part_amc:  d.part_amc,
      part_patient: d.part_patient,
      dre_requise:  d.dre_requise || false,
      date_edit: new Date().toISOString(),
      source:    'edit',
    };

    const toStore = {
      id:         row.id,
      nom:        row.nom,
      prenom:     row.prenom,
      _data:      _enc(p),
      updated_at: new Date().toISOString(),
    };
    await _idbPut(PATIENTS_STORE, toStore);

    // Synchroniser vers Supabase (PATCH si invoice_number connu)
    try {
      const invNum = p.cotations[cotationIdx].invoice_number || null;
      if (invNum && typeof apiCall === 'function') {
        // Utiliser ami-save-cotation avec invoice_number → le worker fait un PATCH
        apiCall('/webhook/ami-save-cotation', {
          cotations: [{
            actes:          d.actes || [],
            total:          d.total || 0,
            part_amo:       d.part_amo || 0,
            part_amc:       d.part_amc || 0,
            part_patient:   d.part_patient || 0,
            dre_requise:    d.dre_requise || false,
            source:         'cotation_edit',
            invoice_number: invNum, // déclenche PATCH côté worker
          }]
        }).catch(() => {}); // silencieux — IDB fait foi
      }
    } catch (_syncErr) {}

    // Invalider le cache dashboard
    try {
      const _key = (typeof _dashCacheKey === 'function') ? _dashCacheKey()
        : ('ami_dash_cache_' + (typeof S !== 'undefined' ? (S?.user?.id || '') : ''));
      localStorage.removeItem(_key);
    } catch {}

    // Réinitialiser le mode édition
    window._editingCotation = null;

    if (typeof showToastSafe === 'function')
      showToastSafe(`✅ Cotation mise à jour — ${(d.total||0).toFixed(2)} €`);

    // Retourner sur la fiche patient
    setTimeout(() => {
      if (typeof navTo === 'function') navTo('patients', null);
      setTimeout(() => {
        if (typeof openPatientDetail === 'function') openPatientDetail(patientId);
      }, 200);
    }, 800);

  } catch(e) {
    if (typeof showToastSafe === 'function') showToastSafe('❌ ' + e.message);
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
  AMI NGAP · N° facture : ${num} · Cotation NGAP métropole en vigueur · Généré le ${new Date().toLocaleDateString('fr-FR')}
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
        alerts = d.alertes_urssaf || d.alertes || [], sugg = d.optimisations || d.suggestions || [];
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
    const corrige = d.texte_corrige || '', fixes = d.corrections || [], alerts = d.alertes_urssaf || d.alertes || [], sugg = d.optimisations || d.suggestions || [];
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
