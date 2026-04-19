/* ════════════════════════════════════════════════
   alertes-medicaments.js — AMI v1.0
   ────────────────────────────────────────────────
   Détection des interactions médicamenteuses
   et alertes pharmacologiques pour IDEL
   ────────────────────────────────────────────────
   Fonctionnalités :
   1. Base locale des interactions dangereuses ANSM
   2. Détection en saisie libre (NLP léger)
   3. Widget alertes dans fiche patient
   4. Intégration cotation (détection dans f-txt)
   5. Base de données médicaments fréquents IDEL
   ────────────────────────────────────────────────
   Source : Thériaque / ANSM / Vidal références 2026
════════════════════════════════════════════════ */

/* ── Base interactions contre-indiquées / à surveiller ── */
const INTERACTIONS_DB = [
  // [méd A, méd B, gravité, message]
  { a: ['avk','warfarine','sintrom','coumadine','previscan'], b: ['ains','ibuprofène','kétoprofène','naproxène','diclofénac','aspirine','aas'], gravite: 'CI', msg: 'Contre-indication absolue AVK + AINS : risque hémorragique majeur. Contacter le médecin prescripteur immédiatement.' },
  { a: ['insuline'], b: ['sulfamide','glibenclamide','glimépiride','glipizide','glicalazide'], gravite: 'DANGER', msg: 'Association insuline + sulfamide hypoglycémiant : risque hypoglycémie sévère. Surveillance glycémique rapprochée obligatoire.' },
  { a: ['metformine'], b: ['iode','produit de contraste'], gravite: 'DANGER', msg: 'Metformine + iode : risque d\'acidose lactique. Stopper metformine 48h avant et après injection de produit de contraste iodé.' },
  { a: ['lithium'], b: ['ains','ibuprofène','kétoprofène','naproxène','diclofénac'], gravite: 'CI', msg: 'Lithium + AINS : toxicité lithium augmentée. Contrôle lithiémie et avis médical urgent.' },
  { a: ['ieca','enalapril','ramipril','périndopril','lisinopril','captopril'], b: ['ains','ibuprofène','kétoprofène'], gravite: 'DANGER', msg: 'IEC + AINS : risque insuffisance rénale aiguë et réduction effet antihypertenseur. Surveiller créatinine et pression artérielle.' },
  { a: ['digoxine','lanitop'], b: ['amiodarone','cordarone'], gravite: 'DANGER', msg: 'Digoxine + amiodarone : toxicité digitalique augmentée. Surveillance ECG et digoxinémie recommandée.' },
  { a: ['hbpm','lovenox','fragmine','innohep','clexane'], b: ['ains','ibuprofène','kétoprofène','naproxène','aspirine'], gravite: 'DANGER', msg: 'HBPM + AINS : risque hémorragique augmenté. Signaler au médecin et surveiller les signes de saignement.' },
  { a: ['ipp','oméprazole','pantoprazole','lansoprazole'], b: ['clopidogrel','plavix'], gravite: 'ATTENTION', msg: 'IPP + clopidogrel : réduction de l\'effet antiaggrégant. Discuter substitution IPP avec le médecin.' },
  { a: ['potassium','chlorure de potassium'], b: ['ieca','enalapril','ramipril','périndopril','spironolactone','aldactone'], gravite: 'DANGER', msg: 'Potassium + IEC/anti-aldostérone : risque hyperkaliémie grave. Contrôle kaliémie obligatoire.' },
  { a: ['tramadol','tramal'], b: ['ims','escitalopram','sertraline','fluoxétine','paroxétine','venlafaxine'], gravite: 'DANGER', msg: 'Tramadol + IRS/IRSNA : risque syndrome sérotoninergique (agitation, tremblements, fièvre). Surveillance et avis médical.' },
  { a: ['morphine','oxycodone','fentanyl'], b: ['benzodiazépine','diazépam','lorazépam','alprazolam','xanax','temesta'], gravite: 'DANGER', msg: 'Opioïde + benzodiazépine : dépression respiratoire potentiellement fatale. Surveillance respiratoire renforcée.' },
  { a: ['methotrexate'], b: ['ains','ibuprofène','kétoprofène','naproxène','aspirine'], gravite: 'CI', msg: 'Méthotrexate + AINS : toxicité méthotrexate majorée (pancytopénie, toxicité rénale). Contacter le médecin.' },
  { a: ['ciclosporine','néoral'], b: ['ains','ibuprofène','kétoprofène'], gravite: 'DANGER', msg: 'Ciclosporine + AINS : risque néphrotoxicité. Surveillance de la fonction rénale.' },
  { a: ['tamsulosine','alfuzosine'], b: ['sildénafil','tadalafil','vardénafil','cialis','viagra'], gravite: 'DANGER', msg: 'Alpha-bloquant + IPDE5 : risque hypotension sévère. Avertir le patient et surveiller la pression artérielle.' },
  { a: ['fluconazole','kétoconazole'], b: ['avk','warfarine','coumadine','sintrom'], gravite: 'DANGER', msg: 'Azolé + AVK : augmentation importante de l\'anticoagulation. Contrôle INR rapproché.' },
];

/* ── Base médicaments fréquents IDEL (NLP) ─── */
const MEDS_PATTERNS = {
  'avk': /\b(avk|warfar|sintrom|coumad|prévisan|previscan)\b/i,
  'aspirine': /\b(aspirin|aas|kardégic|aspégic)\b/i,
  'ains': /\b(ains|ibuprofène?|ibuprofene|kétoprofène?|naproxène?|diclofénac|voltarène|profénid|advil|nurofen)\b/i,
  'insuline': /\b(insul|actrapid|humalog|novorapid|lantus|levemir|toujeo|tresiba)\b/i,
  'sulfamide': /\b(sulfamide|glibenclamide|glimépiride|glipizide|glicalazide|daonil|amarel|diamicron)\b/i,
  'metformine': /\b(metformine?|glucophage|stagid|glucinan)\b/i,
  'iode': /\b(produit de contraste|iode|iodé|iodure)\b/i,
  'lithium': /\b(lithium|téralithe|li-liquid)\b/i,
  'ieca': /\b(iec|enalapril|ramipril|périndopril|lisinopril|captopril|renitec|triatec|coversyl|zestril|lopril)\b/i,
  'digoxine': /\b(digoxine|lanitop)\b/i,
  'amiodarone': /\b(amiodarone|cordarone)\b/i,
  'hbpm': /\b(hbpm|lovenox|fragmine|innohep|clexane|enoxaparine|daltéparine|tinzaparine)\b/i,
  'ipp': /\b(ipp|oméprazole|pantoprazole|lansoprazole|mopral|inipomp|ogast)\b/i,
  'clopidogrel': /\b(clopidogrel|plavix)\b/i,
  'potassium': /\b(potassium|diffu-k|kaleorid|gluconate de potassium)\b/i,
  'spironolactone': /\b(spironolactone|aldactone|eplerenone|inspra)\b/i,
  'tramadol': /\b(tramadol|tramal|contramal|zamudol)\b/i,
  'ims': /\b(escitalopram|sertraline|fluoxétine|paroxétine|venlafaxine|lexapro|prozac|zoloft|deroxat|effexor)\b/i,
  'morphine': /\b(morphine|oxycodone|fentanyl|skenan|oramorph|oxynorm|durogesic)\b/i,
  'benzodiazépine': /\b(benzo|diazépam|lorazépam|alprazolam|xanax|temesta|valium|lexomil|lysanxia)\b/i,
  'methotrexate': /\b(méthotrexate|metoject|novatrex)\b/i,
  'ciclosporine': /\b(ciclosporine|néoral|sandimmun)\b/i,
  'tamsulosine': /\b(tamsulosine|alfuzosine|omix|josir|urion|xatral)\b/i,
  'sildénafil': /\b(sildénafil|tadalafil|vardénafil|cialis|viagra|levitra)\b/i,
  'fluconazole': /\b(fluconazole|kétoconazole|triflucan|nizoral|itraconazole)\b/i,
};

/* ── Détection des médicaments dans un texte ── */
function detectMeds(text) {
  const found = [];
  const lower = (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [key, pattern] of Object.entries(MEDS_PATTERNS)) {
    if (pattern.test(lower)) found.push(key);
  }
  return found;
}

/* ── Vérification des interactions ──────────── */
function checkInteractions(meds) {
  const alerts = [];
  for (const inter of INTERACTIONS_DB) {
    const hasA = inter.a.some(m => meds.includes(m));
    const hasB = inter.b.some(m => meds.includes(m));
    if (hasA && hasB) {
      alerts.push({ gravite: inter.gravite, msg: inter.msg });
    }
  }
  return alerts;
}

/* ── Couleurs par gravité ────────────────────── */
function _interGravColor(g) {
  return g === 'CI' ? '#ef4444' : g === 'DANGER' ? '#f97316' : '#f59e0b';
}
function _interGravBg(g) {
  return g === 'CI' ? 'rgba(239,68,68,.1)' : g === 'DANGER' ? 'rgba(249,115,22,.1)' : 'rgba(245,158,11,.1)';
}
function _interGravBorder(g) {
  return g === 'CI' ? 'rgba(239,68,68,.3)' : g === 'DANGER' ? 'rgba(249,115,22,.3)' : 'rgba(245,158,11,.3)';
}
function _interGravLabel(g) {
  return g === 'CI' ? '🚫 CONTRE-INDICATION' : g === 'DANGER' ? '⚠️ INTERACTION DANGEREUSE' : '⚡ ATTENTION';
}

/* ── Rendu du widget alertes ─────────────────── */
function renderInteractionAlerts(targetId, text) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const meds = detectMeds(text);
  if (!meds.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const alerts = checkInteractions(meds);
  if (!alerts.length) { el.style.display = 'none'; el.innerHTML = ''; return; }

  el.style.display = 'block';
  el.innerHTML = `
    <div style="background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:14px;margin-bottom:8px">
      <div style="font-family:var(--fm);font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#ef4444;margin-bottom:10px">💊 Alertes Interactions Médicamenteuses</div>
      ${alerts.map(a => `
        <div style="background:${_interGravBg(a.gravite)};border:1px solid ${_interGravBorder(a.gravite)};border-radius:8px;padding:10px 12px;margin-bottom:8px">
          <div style="font-size:11px;font-weight:800;color:${_interGravColor(a.gravite)};margin-bottom:4px;font-family:var(--fm)">${_interGravLabel(a.gravite)}</div>
          <div style="font-size:12px;color:var(--t);line-height:1.5">${a.msg}</div>
        </div>`).join('')}
      <div style="font-size:10px;color:var(--m);font-family:var(--fm);margin-top:6px">Source : ANSM / Thériaque 2026 · Ces alertes ne remplacent pas l'avis médical</div>
    </div>`;
}

/* ── Intégration dans la fiche patient ──────── */
function renderPatientMedAlerts(patientId, medications, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const meds = detectMeds(medications);
  const alerts = checkInteractions(meds);
  if (!alerts.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--m)">✅ Aucune interaction détectée dans les médicaments renseignés.</div>';
    return;
  }
  el.innerHTML = alerts.map(a => `
    <div style="background:${_interGravBg(a.gravite)};border:1px solid ${_interGravBorder(a.gravite)};border-radius:8px;padding:10px 12px;margin-bottom:8px">
      <div style="font-size:11px;font-weight:800;color:${_interGravColor(a.gravite)};margin-bottom:4px;font-family:var(--fm)">${_interGravLabel(a.gravite)}</div>
      <div style="font-size:12px;color:var(--t);line-height:1.5">${a.msg}</div>
    </div>`).join('');
}

/* ── Hook sur le champ description cotation ─── */
(function _hookCotationField() {
  document.addEventListener('DOMContentLoaded', () => {
    // Injecter le widget d'alertes sous le textarea de cotation
    const fTxt = document.getElementById('f-txt');
    if (!fTxt) return;

    // Créer le conteneur d'alertes
    let alertBox = document.getElementById('cot-med-alerts');
    if (!alertBox) {
      alertBox = document.createElement('div');
      alertBox.id = 'cot-med-alerts';
      alertBox.style.display = 'none';
      fTxt.parentNode.insertAdjacentElement('afterend', alertBox);
    }

    fTxt.addEventListener('input', () => {
      renderInteractionAlerts('cot-med-alerts', fTxt.value);
    });
  });
})();

/* ── Rendu vue dédiée ────────────────────────── */
async function renderAlertesView() {
  const wrap = document.getElementById('view-alertes-med');
  if (!wrap) return;

  let patients = [];
  try {
    if (typeof getAllPatients === 'function') patients = await getAllPatients();
  } catch (_) {}

  wrap.innerHTML = `
    <h1 class="pt">Alertes <em>médicamenteuses</em></h1>
    <p class="ps">Détection des interactions dangereuses · Base ANSM/Thériaque 2026</p>

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">⚕️</span><p>Vérification d'interactions en saisie libre. Ces alertes complètent — mais ne remplacent pas — l'avis du médecin ou du pharmacien.</p></div>

      <div class="lbl" style="margin-bottom:8px">Saisir les médicaments ou le soin</div>
      <div class="f" style="margin-bottom:8px">
        <textarea id="alert-med-input" placeholder="Ex : injection insuline + ibuprofène + tramadol..." style="min-height:90px;resize:vertical"
          oninput="renderInteractionAlerts('alert-med-result', this.value)"></textarea>
      </div>
      <div id="alert-med-result" style="display:none"></div>

      <div style="margin-top:24px">
        <div class="lbl" style="margin-bottom:10px">📋 Vérifier un patient du carnet</div>
        <select onchange="checkPatientInteractions(this.value)" style="width:100%;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
          <option value="">— Sélectionner un patient —</option>
          ${patients.map(p => `<option value="${p.id}">${p.nom || ''} ${p.prenom || ''}</option>`).join('')}
        </select>
        <div id="alert-patient-result" style="margin-top:12px"></div>
      </div>

      <!-- Référence interactions connues -->
      <div style="margin-top:24px">
        <div class="lbl" style="margin-bottom:10px">📚 Interactions surveillées (${INTERACTIONS_DB.length} références)</div>
        <div style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
          ${INTERACTIONS_DB.map(i => `
            <div style="background:var(--s);border:1px solid ${_interGravBorder(i.gravite)};border-radius:8px;padding:10px 12px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                <span style="font-size:10px;font-weight:800;color:${_interGravColor(i.gravite)};font-family:var(--fm)">${_interGravLabel(i.gravite)}</span>
              </div>
              <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${i.a.slice(0,3).join(', ')} + ${i.b.slice(0,3).join(', ')}</div>
              <div style="font-size:12px;color:var(--t);margin-top:4px;line-height:1.4">${i.msg}</div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

async function checkPatientInteractions(patientId) {
  const el = document.getElementById('alert-patient-result');
  if (!el || !patientId) return;
  el.innerHTML = '<div class="ai in" style="font-size:12px">Chargement…</div>';
  try {
    let patient = null;
    if (typeof getPatientById === 'function') patient = await getPatientById(patientId);
    if (!patient) { el.innerHTML = ''; return; }
    const medText = [patient.medicaments || '', patient.pathologies || '', patient.actes_recurrents || ''].join(' ');
    el.innerHTML = `<div class="lbl" style="margin-bottom:8px">Analyse pour ${patient.prenom || ''} ${patient.nom || ''}</div>`;
    renderPatientMedAlerts(patientId, medText, 'alert-patient-result');
  } catch (err) {
    el.innerHTML = `<div class="msg e">Erreur : ${err.message}</div>`;
  }
}

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'alertes-med') renderAlertesView();
});
