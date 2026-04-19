/* ════════════════════════════════════════════════
   consentements.js — AMI v1.0
   ────────────────────────────────────────────────
   Module Consentements Éclairés
   ────────────────────────────────────────────────
   Fonctionnalités :
   1. Formulaires de consentement pré-remplis
      (Pose sonde, Perfusion, Soins palliatifs, Photo)
   2. Signature patient sur canvas
   3. Archivage avec horodatage + nom infirmière
   4. Export PDF signé
   5. Protection médico-légale (local IDB)
   ────────────────────────────────────────────────
════════════════════════════════════════════════ */

const CONSENT_STORE = 'consentements';

async function _consentDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ami_consentements', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CONSENT_STORE)) {
        const s = db.createObjectStore(CONSENT_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('patient_id', 'patient_id', { unique: false });
        s.createIndex('user_id',    'user_id',    { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _consentSave(obj) {
  const db = await _consentDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONSENT_STORE, 'readwrite');
    const req = tx.objectStore(CONSENT_STORE).put(obj);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _consentGetAll(patientId) {
  const db  = await _consentDb();
  const uid = APP?.user?.id || '';
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(CONSENT_STORE, 'readonly');
    const idx = tx.objectStore(CONSENT_STORE).index('patient_id');
    const req = idx.getAll(patientId);
    req.onsuccess = e => resolve(
      (e.target.result||[]).filter(c => c.user_id === uid).sort((a,b) => new Date(b.date) - new Date(a.date))
    );
    req.onerror = e => reject(e.target.error);
  });
}

/* ── Templates de consentement ───────────────── */
const CONSENT_TEMPLATES = {
  sonde_urinaire: {
    label: 'Sondage urinaire',
    icon: '🩺',
    risques: [
      'Inconfort ou douleur lors de la pose',
      'Infection urinaire (risque estimé 3–7% par jour de sonde)',
      'Traumatisme urétral (rare)',
      'Hémorragie légère',
    ],
    alternatives: 'Recueil d\'urines par étui pénien (homme), protection absorbante, rééducation sphinctérienne.',
    texte: `Je soussigné(e) consens à la pose et au maintien d'une sonde urinaire à demeure réalisée par l'infirmier(ère) soussigné(e). J'ai été informé(e) des indications, des risques et des alternatives à ce geste.`,
  },
  perfusion: {
    label: 'Perfusion / Voie veineuse',
    icon: '💉',
    risques: [
      'Hématome ou douleur au point de ponction',
      'Phlébite ou inflammation veineuse',
      'Infection locale (risque faible)',
      'Réaction au traitement perfusé',
    ],
    alternatives: 'Traitement par voie orale si le médecin prescripteur le juge possible.',
    texte: `Je soussigné(e) consens à la pose d'une voie veineuse périphérique et à la réalisation de la perfusion prescrite. J'ai été informé(e) des risques inhérents à ce geste.`,
  },
  soins_palliatifs: {
    label: 'Soins palliatifs / Soins de confort',
    icon: '🤝',
    risques: [
      'Adaptation possible du traitement antalgique selon évolution',
      'Risques liés aux médicaments prescrits (somnolence, etc.)',
    ],
    alternatives: 'Hospitalisation en unité de soins palliatifs si besoin d\'une prise en charge plus intensive.',
    texte: `Je soussigné(e) (ou représentant légal) consens aux soins palliatifs et de confort à domicile. J'ai été informé(e) que l'objectif est le maintien du confort et de la qualité de vie, et non la guérison.`,
  },
  photo_soin: {
    label: 'Photographie de soin (plaie)',
    icon: '📸',
    risques: [
      'Photographie stockée sur l\'appareil de l\'infirmier(ère)',
      'Usage limité au suivi médical',
    ],
    alternatives: 'Suivi par description textuelle sans photographie.',
    texte: `Je soussigné(e) autorise l'infirmier(ère) soussigné(e) à photographier ma plaie/lésion dans le cadre unique du suivi infirmier. Ces photos sont stockées localement sur l'appareil de l'infirmier(ère), ne sont pas transmises à des tiers, et seront supprimées à la cicatrisation.`,
  },
  pansement_complexe: {
    label: 'Pansement complexe / Chirurgical',
    icon: '🩹',
    risques: [
      'Douleur lors du retrait du pansement',
      'Retard de cicatrisation en cas d\'infection',
      'Allergie au matériel utilisé (rare)',
    ],
    alternatives: 'Prise en charge en cabinet infirmier ou hospitalisation courte si douleurs importantes.',
    texte: `Je soussigné(e) consens à la réalisation de pansements complexes par l'infirmier(ère) soussigné(e), conformément à la prescription médicale.`,
  },
  injection_sc_im: {
    label: 'Injection sous-cutanée / IM',
    icon: '💊',
    risques: [
      'Douleur et ecchymose au site d\'injection',
      'Réaction locale (rougeur, induration)',
      'Réaction allergique (rare)',
    ],
    alternatives: 'Traitement par voie orale si disponible et prescrit.',
    texte: `Je soussigné(e) consens aux injections sous-cutanées ou intramusculaires prescrites par mon médecin et réalisées par l'infirmier(ère) soussigné(e).`,
  },
};

let _consentCurrentPatient = null;
let _consentType = null;
let _consentSignature = null;
let _consentCanvas = null;
let _consentDrawing = false;
let _consentLastPos = null;

/* ════════════════════════════════════════════════
   RENDU PRINCIPAL
════════════════════════════════════════════════ */
async function renderConsentements() {
  const wrap = document.getElementById('view-consentements');
  if (!wrap) return;

  let patients = [];
  try { if (typeof getAllPatients === 'function') patients = await getAllPatients(); } catch (_) {}

  wrap.innerHTML = `
    <h1 class="pt">Consentements <em>éclairés</em></h1>
    <p class="ps">Protection médico-légale · Signature patient · Archivage horodaté</p>

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">🛡️</span><p>Le consentement éclairé est une obligation légale (Art. L1111-4 CSP). Ces formulaires vous protègent en cas de litige ou de contrôle.</p></div>

      <div class="lbl" style="margin-bottom:8px">Patient</div>
      <select id="consent-patient-sel" onchange="consentSelectPatient(this.value)" style="width:100%;margin-bottom:16px;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
        <option value="">— Sélectionner un patient —</option>
        ${patients.map(p => `<option value="${p.id}">${p.nom||''} ${p.prenom||''}</option>`).join('')}
      </select>

      <div id="consent-type-section" style="display:none">
        <div class="lbl" style="margin-bottom:12px">Type de consentement</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:20px">
          ${Object.entries(CONSENT_TEMPLATES).map(([key, tpl]) => `
            <button onclick="consentSelectType('${key}')" id="consent-type-btn-${key}" class="btn bs" style="display:flex;align-items:center;gap:8px;padding:12px 14px;text-align:left;height:auto">
              <span style="font-size:20px;flex-shrink:0">${tpl.icon}</span>
              <span style="font-size:12px;line-height:1.3">${tpl.label}</span>
            </button>`).join('')}
        </div>

        <div id="consent-form-section" style="display:none">
          <!-- Texte du consentement -->
          <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:16px;margin-bottom:16px">
            <div class="lbl" style="margin-bottom:10px" id="consent-form-title">Formulaire de consentement</div>
            <div id="consent-risques-list" style="margin-bottom:12px"></div>
            <div id="consent-alternatives" style="margin-bottom:12px"></div>
            <div id="consent-text-box" style="background:rgba(0,212,170,.03);border:1px solid rgba(0,212,170,.15);border-radius:8px;padding:14px;font-size:13px;line-height:1.7;color:var(--t)"></div>
          </div>

          <!-- Infos patient -->
          <div class="fg" style="margin-bottom:16px">
            <div class="f"><label>Nom du patient / représentant légal</label><input type="text" id="consent-patient-nom" placeholder="NOM Prénom"></div>
            <div class="f"><label>Qualité (si représentant)</label><input type="text" id="consent-qualite" placeholder="Lui-même / Tuteur / ..."></div>
            <div class="f"><label>Date</label><input type="date" id="consent-date" value="${new Date().toISOString().slice(0,10)}"></div>
          </div>

          <!-- Canvas signature -->
          <div class="lbl" style="margin-bottom:8px">✍️ Signature du patient</div>
          <div style="background:var(--s);border:2px solid var(--b);border-radius:10px;overflow:hidden;margin-bottom:8px">
            <canvas id="consent-sig-canvas" width="600" height="180" style="width:100%;height:180px;display:block;touch-action:none;cursor:crosshair;background:rgba(255,255,255,0.03)"></canvas>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:16px">
            <button class="btn bs bsm" onclick="consentClearSig()">↺ Effacer la signature</button>
            <span style="font-size:12px;color:var(--m);font-family:var(--fm);align-self:center">Signez dans le cadre ci-dessus</span>
          </div>

          <div class="ar-row">
            <button class="btn bp" onclick="consentSave()"><span>💾</span> Archiver le consentement</button>
            <button class="btn bv" onclick="consentPrint()"><span>🖨️</span> Imprimer</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Historique -->
    <div id="consent-history-wrap" class="card" style="display:none">
      <div class="lbl" style="margin-bottom:14px">📋 Consentements archivés</div>
      <div id="consent-history-list"></div>
    </div>
  `;
}

function consentSelectPatient(pid) {
  _consentCurrentPatient = pid || null;
  const section = document.getElementById('consent-type-section');
  const histWrap = document.getElementById('consent-history-wrap');
  if (!pid) {
    if (section) section.style.display = 'none';
    if (histWrap) histWrap.style.display = 'none';
    return;
  }
  if (section) section.style.display = 'block';
  if (histWrap) histWrap.style.display = 'block';
  consentLoadHistory();

  // Pré-remplir nom patient
  const sel = document.getElementById('consent-patient-sel');
  const nomEl = document.getElementById('consent-patient-nom');
  if (sel && nomEl) {
    nomEl.value = sel.options[sel.selectedIndex]?.text || '';
  }
}

function consentSelectType(type) {
  _consentType = type;
  const tpl = CONSENT_TEMPLATES[type];
  if (!tpl) return;

  // Highlight bouton actif
  Object.keys(CONSENT_TEMPLATES).forEach(k => {
    const btn = document.getElementById(`consent-type-btn-${k}`);
    if (btn) btn.className = k === type ? 'btn bp' : 'btn bs';
    if (btn) { btn.style.display = 'flex'; btn.style.alignItems = 'center'; btn.style.gap = '8px'; btn.style.padding = '12px 14px'; btn.style.textAlign = 'left'; btn.style.height = 'auto'; }
  });

  const section = document.getElementById('consent-form-section');
  if (section) section.style.display = 'block';

  const titleEl = document.getElementById('consent-form-title');
  if (titleEl) titleEl.textContent = `${tpl.icon} ${tpl.label}`;

  const risquesEl = document.getElementById('consent-risques-list');
  if (risquesEl) risquesEl.innerHTML = `
    <div style="font-size:12px;font-family:var(--fm);color:var(--m);margin-bottom:6px">⚠️ Risques expliqués au patient :</div>
    <ul style="margin:0;padding-left:20px">${tpl.risques.map(r => `<li style="font-size:12px;color:var(--t);margin-bottom:3px">${r}</li>`).join('')}</ul>`;

  const altEl = document.getElementById('consent-alternatives');
  if (altEl) altEl.innerHTML = `<div style="font-size:12px;color:var(--m);font-family:var(--fm)">🔄 <strong>Alternatives proposées :</strong> ${tpl.alternatives}</div>`;

  const textEl = document.getElementById('consent-text-box');
  if (textEl) textEl.textContent = tpl.texte;

  // Init canvas signature
  setTimeout(() => {
    const canvas = document.getElementById('consent-sig-canvas');
    if (canvas) {
      _consentCanvas = canvas;
      _consentSignature = null;
      _initConsentCanvas(canvas);
    }
  }, 100);
}

function _initConsentCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#00d4aa';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  const getPos = e => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - rect.left) * scaleX, y: (src.clientY - rect.top) * scaleY };
  };

  canvas.addEventListener('mousedown',  e => { _consentDrawing = true; _consentLastPos = getPos(e); });
  canvas.addEventListener('mousemove',  e => { if (!_consentDrawing) return; const p=getPos(e); ctx.beginPath(); ctx.moveTo(_consentLastPos.x, _consentLastPos.y); ctx.lineTo(p.x,p.y); ctx.stroke(); _consentLastPos=p; });
  canvas.addEventListener('mouseup',    () => { _consentDrawing = false; _consentSignature = canvas.toDataURL(); });
  canvas.addEventListener('touchstart', e => { e.preventDefault(); _consentDrawing=true; _consentLastPos=getPos(e); }, { passive:false });
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if(!_consentDrawing)return; const p=getPos(e); ctx.beginPath(); ctx.moveTo(_consentLastPos.x,_consentLastPos.y); ctx.lineTo(p.x,p.y); ctx.stroke(); _consentLastPos=p; }, { passive:false });
  canvas.addEventListener('touchend',   () => { _consentDrawing=false; _consentSignature=canvas.toDataURL(); });
}

function consentClearSig() {
  const canvas = document.getElementById('consent-sig-canvas');
  if (canvas) {
    canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
    _consentSignature = null;
  }
}

async function consentSave() {
  if (!_consentCurrentPatient || !_consentType) { showToast('warning','Sélectionnez un patient et un type'); return; }
  if (!_consentSignature) { showToast('warning','Signature requise','Le patient doit signer dans le cadre.'); return; }
  const tpl = CONSENT_TEMPLATES[_consentType];
  const obj = {
    patient_id:    _consentCurrentPatient,
    user_id:       APP?.user?.id || '',
    type:          _consentType,
    type_label:    tpl.label,
    texte:         tpl.texte,
    patient_nom:   document.getElementById('consent-patient-nom')?.value?.trim() || '',
    qualite:       document.getElementById('consent-qualite')?.value?.trim() || '',
    date:          document.getElementById('consent-date')?.value || new Date().toISOString().slice(0,10),
    inf_nom:       `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim(),
    signature:     _consentSignature,
    horodatage:    new Date().toISOString(),
  };
  try {
    await _consentSave(obj);
    showToast('success', 'Consentement archivé', `${tpl.label} · Signé`);
    await consentLoadHistory();
  } catch (err) {
    showToast('error','Erreur',err.message);
  }
}

function consentPrint() {
  const tpl = CONSENT_TEMPLATES[_consentType];
  if (!tpl) return;
  const sig = _consentSignature || '';
  const patNom = document.getElementById('consent-patient-nom')?.value || '—';
  const d = document.getElementById('consent-date')?.value || new Date().toISOString().slice(0,10);
  const infNom = `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim() || '—';

  const w = window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Consentement AMI</title>
    <style>body{font-family:Arial,sans-serif;padding:30px;color:#000;max-width:680px;margin:0 auto}h1{font-size:16px}p{font-size:13px;line-height:1.7}ul{font-size:12px}@media print{@page{margin:15mm}}</style>
    </head><body>
    <h1>${tpl.icon} Formulaire de consentement éclairé — ${tpl.label}</h1>
    <p><strong>Patient :</strong> ${patNom} · <strong>Date :</strong> ${d}</p>
    <p><strong>Infirmier(ère) :</strong> ${infNom}</p>
    <h2>Risques expliqués</h2><ul>${tpl.risques.map(r=>`<li>${r}</li>`).join('')}</ul>
    <h2>Alternatives</h2><p>${tpl.alternatives}</p>
    <h2>Consentement</h2><p>${tpl.texte}</p>
    ${sig ? `<h2>Signature du patient</h2><img src="${sig}" style="border:1px solid #ccc;border-radius:4px;max-width:300px;height:auto">` : ''}
    <p style="font-size:10px;color:#888;margin-top:20px">Généré par AMI · ${new Date().toLocaleString('fr-FR')}</p>
    </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

async function consentLoadHistory() {
  if (!_consentCurrentPatient) return;
  const list = document.getElementById('consent-history-list');
  if (!list) return;
  try {
    const all = await _consentGetAll(_consentCurrentPatient);
    if (!all.length) { list.innerHTML = '<div class="empty"><p>Aucun consentement archivé.</p></div>'; return; }
    list.innerHTML = all.slice(0,20).map(c => {
      const d = new Date(c.date).toLocaleDateString('fr-FR');
      const tpl = CONSENT_TEMPLATES[c.type] || {};
      return `
        <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:600">${tpl.icon||'📋'} ${c.type_label}</div>
            <div style="font-size:12px;color:var(--m);margin-top:2px">${d} · ${c.patient_nom} · Signé ✅</div>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="msg e">Erreur : ${err.message}</div>`;
  }
}

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'consentements') renderConsentements();
});
