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
  const u = S?.user || {};
  try {
    const d = await apiCall('/webhook/ami-calcul', {
      mode: 'ngap', texte: txt,
      infirmiere: ((u.prenom || '') + ' ' + (u.nom || '')).trim(),
      adeli: u.adeli || '', rpps: u.rpps || '', structure: u.structure || '',
      ddn: gv('f-ddn'), amo: gv('f-amo'), amc: gv('f-amc'),
      exo: gv('f-exo'), regl: gv('f-regl'),
      date_soin: gv('f-ds'), heure_soin: gv('f-hs')
    });
    if (d.error) throw new Error(d.error);
    $('cbody').innerHTML = renderCot(d);
    $('res-cot').classList.add('show');
  } catch (e) {
    $('cerr').style.display = 'flex';
    $('cerr-m').textContent = e.message;
    $('res-cot').classList.add('show');
  }
  ld('btn-cot', false);
}

function renderCot(d) {
  const a = d.actes || [], al = d.alerts || [], op = d.optimisations || [];
  return `<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
    <div><div class="lbl">Total cotation</div>
    <div style="display:flex;align-items:baseline;gap:6px"><div class="ta">${(d.total || 0).toFixed(2)}</div><div class="tu">€</div></div>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">${d.dre_requise ? '<div class="dreb">📋 DRE requise</div>' : ''}</div></div>
    <button class="btn bs bsm" onclick='printInv(${JSON.stringify(d).replace(/'/g, "&#39;")})'>🖨️ Imprimer</button>
  </div>
  <div class="rg">
    <div class="rc am"><div class="rl">Part AMO (SS)</div><div class="ra">${fmt(d.part_amo)}</div><div class="rp">${d.taux_amo ? Math.round(d.taux_amo * 100) + '%' : '60%'}</div></div>
    <div class="rc mc"><div class="rl">Part AMC</div><div class="ra">${fmt(d.part_amc)}</div><div class="rp">Complémentaire</div></div>
    <div class="rc pa"><div class="rl">Part Patient</div><div class="ra">${fmt(d.part_patient)}</div><div class="rp">Ticket modérateur</div></div>
  </div>
  <div class="lbl" style="margin-bottom:10px">Détail des actes</div>
  <div class="al">${a.length ? a.map(x => `<div class="ar"><div class="ac ${cc(x.code)}">${x.code || '?'}</div><div class="an">${x.nom || ''}</div><div class="ao">×${(x.coefficient || 1).toFixed(1)}</div><div class="at">${fmt(x.total)}</div></div>`).join('') : '<div class="ai wa">⚠️ Aucun acte retourné</div>'}</div>
  ${al.length ? `<div class="aic">${al.map(x => `<div class="ai er">❌ ${x}</div>`).join('')}</div>` : '<div class="ai su">✅ Aucune alerte NGAP</div>'}
  ${op.length ? `<div style="margin-top:16px"><div class="aic">${op.map(x => `<div class="ai in">💡 ${x}</div>`).join('')}</div></div>` : ''}
  </div>`;
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
  const num = 'F' + new Date().getFullYear() + '-' + String(Date.now()).slice(-6);
  const inf = ((u.prenom || '') + ' ' + (u.nom || '')).trim() || 'Infirmier(ère) libéral(e)';

  /* Bloc infos professionnelles — affiche seulement les champs renseignés */
  const infoPro = [
    u.structure ? `<div style="font-weight:600;margin-bottom:2px">${u.structure}</div>` : '',
    `<div>${inf}</div>`,
    u.adeli  ? `<div style="color:#6b7a99;font-size:12px">N° ADELI : <strong style="color:#1a1a2e">${u.adeli}</strong></div>`  : '',
    u.rpps   ? `<div style="color:#6b7a99;font-size:12px">N° RPPS : <strong style="color:#1a1a2e">${u.rpps}</strong></div>`    : '',
    u.adresse? `<div style="color:#6b7a99;font-size:12px">${u.adresse}</div>` : '',
    u.tel    ? `<div style="color:#6b7a99;font-size:12px">Tél : ${u.tel}</div>` : '',
  ].filter(Boolean).join('\n');

  /* Avertissement si infos manquantes (apparaît sur le PDF) */
  const missingWarning = (!u.adeli || !u.rpps || !u.structure)
    ? `<div style="background:#fff8e1;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#92400e">
        ⚠️ Facture générée sans : ${[!u.adeli?'N° ADELI':'',!u.rpps?'N° RPPS':'',!u.structure?'Cabinet/Structure':''].filter(Boolean).join(', ')}
       </div>`
    : '';

  const w = window.open('', '_blank');
  if (!w) { alert("Le navigateur a bloqué la fenêtre d'impression. Autorisez les popups pour ce site."); return; }

  w.document.write(`<!DOCTYPE html>
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
  @media print { button { display: none !important; } body { padding: 20px; } }
</style>
</head>
<body>
${missingWarning}
<div class="hdr">
  <div class="hdr-left">
    <h1>Feuille de soins</h1>
    <div class="meta">N° ${num} · ${new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })}</div>
    ${d.date_soin ? `<div class="meta">Date du soin : ${d.date_soin}</div>` : ''}
  </div>
  <div class="hdr-right">
    ${infoPro}
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
  AMI NGAP · Cotation NGAP métropole en vigueur · Généré le ${new Date().toLocaleDateString('fr-FR')}
</div>

<script>window.onload = () => window.print();<\/script>
</body>
</html>`);
  w.document.close();
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
  $('res-cot').classList.remove('show');
}

function coterDepuisRoute(desc) {
  navTo('cot', null);
  setTimeout(() => { const el = $('f-txt'); if (el) { el.value = desc; el.focus(); } }, 150);
}
