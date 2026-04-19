/* ════════════════════════════════════════════════
   audit-cpam.js — AMI v1.0
   ────────────────────────────────────────────────
   Module Compte-rendu de Passage
   + Simulateur d'audit CPAM
   ════════════════════════════════════════════════ */

/* ──────────────────────────────────────────────
   COMPTE-RENDU DE PASSAGE
   Génère un CR structuré : actes réalisés,
   observations, constantes, transmissions
   Exportable PDF pour médecin ou entourage
   ────────────────────────────────────────────── */

const CR_STORE = 'comptes_rendus';

async function _crDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ami_cr', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CR_STORE)) {
        const s = db.createObjectStore(CR_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('patient_id', 'patient_id', { unique: false });
        s.createIndex('user_id',    'user_id',    { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _crSave(obj) {
  const db = await _crDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CR_STORE, 'readwrite');
    const req = tx.objectStore(CR_STORE).put(obj);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _crGetAll(patientId) {
  const db  = await _crDb();
  const uid = APP?.user?.id || '';
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(CR_STORE, 'readonly');
    const idx = tx.objectStore(CR_STORE).index('patient_id');
    const req = idx.getAll(patientId);
    req.onsuccess = e => resolve(
      (e.target.result||[]).filter(c => c.user_id === uid).sort((a,b) => new Date(b.date) - new Date(a.date))
    );
    req.onerror = e => reject(e.target.error);
  });
}

let _crCurrentPatient = null;

async function renderCompteRendu() {
  const wrap = document.getElementById('compte-rendu-root');
  if (!wrap) return;

  let patients = [];
  try { if (typeof getAllPatients === 'function') patients = await getAllPatients(); } catch (_) {}

  wrap.innerHTML = `
    <h1 class="pt">Compte-rendu <em>de passage</em></h1>
    <p class="ps">CR structuré pour médecin traitant · Export PDF · Archivage local</p>

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">📋</span><p>Générez un compte-rendu structuré de chaque passage, exportable pour le médecin traitant ou l'entourage.</p></div>

      <div class="lbl" style="margin-bottom:8px">Patient</div>
      <select id="cr-patient-sel" onchange="crSelectPatient(this.value)" style="width:100%;margin-bottom:16px;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
        <option value="">— Sélectionner un patient —</option>
        ${patients.map(p => `<option value="${p.id}">${p.nom||''} ${p.prenom||''}</option>`).join('')}
      </select>

      <div id="cr-form-section" style="display:none">
        <div class="fg" style="margin-bottom:16px">
          <div class="f"><label>Date / Heure de passage</label><input type="datetime-local" id="cr-date" value="${new Date().toISOString().slice(0,16)}"></div>
          <div class="f"><label>Médecin traitant (destinataire)</label><input type="text" id="cr-medecin" placeholder="Dr. ..."></div>
        </div>

        <div class="lbl" style="margin-bottom:8px">Actes réalisés</div>
        <div class="f" style="margin-bottom:14px">
          <textarea id="cr-actes" placeholder="Ex : Injection insuline SC 20UI, Surveillance glycémie (1.3 g/L), Pansement plaie jambe gauche..." style="min-height:90px;resize:vertical"></textarea>
        </div>

        <div class="lbl" style="margin-bottom:8px">Constantes relevées</div>
        <div class="fg" style="margin-bottom:14px">
          <div class="f"><label>TA (mmHg)</label><input type="text" id="cr-ta" placeholder="130/80"></div>
          <div class="f"><label>Glycémie (g/L)</label><input type="text" id="cr-gly" placeholder="1.10"></div>
          <div class="f"><label>SpO2 (%)</label><input type="text" id="cr-spo2" placeholder="97%"></div>
          <div class="f"><label>T° (°C)</label><input type="text" id="cr-temp" placeholder="36.8"></div>
          <div class="f"><label>FC (bpm)</label><input type="text" id="cr-fc" placeholder="72"></div>
          <div class="f"><label>Douleur EVA</label><input type="text" id="cr-eva" placeholder="2/10"></div>
        </div>

        <div class="lbl" style="margin-bottom:8px">Observations cliniques</div>
        <div class="f" style="margin-bottom:14px">
          <textarea id="cr-observations" placeholder="État général, comportement, changements observés..." style="min-height:80px;resize:vertical"></textarea>
        </div>

        <div class="lbl" style="margin-bottom:8px">Transmissions / À signaler</div>
        <div class="f" style="margin-bottom:16px">
          <textarea id="cr-transmissions" placeholder="Points à signaler au médecin, soins à prévoir, alertes..." style="min-height:80px;resize:vertical"></textarea>
        </div>

        <!-- Niveau urgence -->
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <label style="font-size:13px;color:var(--m)">Niveau :</label>
          <select id="cr-urgence" style="padding:8px 12px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:13px;font-family:var(--fm)">
            <option value="normal">✅ RAS — Situation stable</option>
            <option value="attention">⚡ Attention — Surveiller</option>
            <option value="urgent">🚨 Urgent — Contacter médecin</option>
          </select>
        </div>

        <div class="ar-row">
          <button class="btn bp" onclick="crSave()"><span>💾</span> Sauvegarder</button>
          <button class="btn bv" onclick="crGeneratePDF()"><span>🖨️</span> Générer PDF</button>
          <button class="btn bs" onclick="crReset()">↺ Effacer</button>
        </div>
      </div>
    </div>

    <!-- Historique -->
    <div id="cr-history-wrap" class="card" style="display:none">
      <div class="lbl" style="margin-bottom:14px">📋 Comptes-rendus précédents</div>
      <div id="cr-history-list"></div>
    </div>
  `;
}

async function crSelectPatient(pid) {
  _crCurrentPatient = pid || null;
  const section  = document.getElementById('cr-form-section');
  const histWrap = document.getElementById('cr-history-wrap');
  if (!pid) {
    if (section) section.style.display = 'none';
    if (histWrap) histWrap.style.display = 'none';
    return;
  }
  if (section) section.style.display = 'block';
  if (histWrap) histWrap.style.display = 'block';
  await crLoadHistory();
}

async function crSave() {
  if (!_crCurrentPatient) { showToast('warning','Patient requis'); return; }
  const get = id => document.getElementById(id)?.value?.trim() || '';
  const obj = {
    patient_id:    _crCurrentPatient,
    user_id:       APP?.user?.id || '',
    date:          get('cr-date') || new Date().toISOString(),
    medecin:       get('cr-medecin'),
    actes:         get('cr-actes'),
    ta:            get('cr-ta'),
    glycemie:      get('cr-gly'),
    spo2:          get('cr-spo2'),
    temperature:   get('cr-temp'),
    fc:            get('cr-fc'),
    eva:           get('cr-eva'),
    observations:  get('cr-observations'),
    transmissions: get('cr-transmissions'),
    urgence:       get('cr-urgence'),
    inf_nom:       `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim(),
  };
  try {
    await _crSave(obj);
    showToast('success','Compte-rendu sauvegardé');
    await crLoadHistory();
  } catch (err) { showToast('error','Erreur',err.message); }
}

function crReset() {
  ['cr-actes','cr-observations','cr-transmissions','cr-medecin','cr-ta','cr-gly','cr-spo2','cr-temp','cr-fc','cr-eva'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  const dt = document.getElementById('cr-date');
  if (dt) dt.value = new Date().toISOString().slice(0,16);
}

function crGeneratePDF() {
  const get = id => document.getElementById(id)?.value?.trim() || '—';
  const patSel = document.getElementById('cr-patient-sel');
  const patNom = patSel?.options[patSel.selectedIndex]?.text || 'Patient';
  const urgLabels = { normal:'✅ RAS — Situation stable', attention:'⚡ À surveiller', urgent:'🚨 URGENT — Contacter médecin' };

  const w = window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>CR Infirmier AMI</title>
    <style>body{font-family:Arial,sans-serif;padding:30px;color:#000;max-width:680px;margin:0 auto}h1{font-size:16px;color:#007a6a}h2{font-size:13px;color:#555;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:18px}p,li{font-size:12px;line-height:1.7}.urgence{padding:8px 12px;border-radius:6px;font-weight:bold;font-size:13px;margin:12px 0}.ras{background:#e6f9f4;color:#007a6a}.attention{background:#fff8e6;color:#b45309}.urgent{background:#fee;color:#c00}@media print{@page{margin:15mm}}</style>
    </head><body>
    <h1>🩺 Compte-rendu de Passage Infirmier</h1>
    <p><strong>Patient :</strong> ${patNom} · <strong>Date :</strong> ${get('cr-date')} · <strong>Infirmier(ère) :</strong> ${`${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim()||'—'}</p>
    ${get('cr-medecin')!=='—'?`<p><strong>Destinataire :</strong> Dr. ${get('cr-medecin')}</p>`:''}
    <div class="urgence ${get('cr-urgence')||'normal'}">${urgLabels[get('cr-urgence')]||urgLabels.normal}</div>
    <h2>Actes réalisés</h2><p>${get('cr-actes')}</p>
    <h2>Constantes</h2>
    <table style="border-collapse:collapse;font-size:12px;margin-bottom:8px"><tr>
      ${[['TA',get('cr-ta')],['Glycémie',get('cr-gly')],['SpO2',get('cr-spo2')],['T°',get('cr-temp')],['FC',get('cr-fc')],['EVA',get('cr-eva')]].map(([l,v])=>`<td style="border:1px solid #ddd;padding:6px 10px"><strong>${l}</strong><br>${v}</td>`).join('')}
    </tr></table>
    <h2>Observations</h2><p>${get('cr-observations')}</p>
    <h2>Transmissions</h2><p>${get('cr-transmissions')}</p>
    <p style="font-size:10px;color:#888;margin-top:24px;border-top:1px solid #ddd;padding-top:8px">Généré par AMI · ${new Date().toLocaleString('fr-FR')}</p>
    </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

async function crLoadHistory() {
  if (!_crCurrentPatient) return;
  const list = document.getElementById('cr-history-list');
  if (!list) return;
  try {
    const all = await _crGetAll(_crCurrentPatient);
    if (!all.length) { list.innerHTML = '<div class="empty"><p>Aucun compte-rendu.</p></div>'; return; }
    const urgColors = { normal:'var(--ok)', attention:'var(--w)', urgent:'var(--d)' };
    list.innerHTML = all.slice(0,20).map(c => {
      const d = new Date(c.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
      return `
        <div style="background:var(--s);border:1px solid var(--b);border-left:3px solid ${urgColors[c.urgence]||'var(--b)'};border-radius:10px;padding:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-size:13px;font-weight:600">${d}</div>
            <div style="font-size:12px;color:var(--m);margin-top:2px">${(c.actes||'').slice(0,60)}${(c.actes||'').length>60?'…':''}</div>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="msg e">Erreur : ${err.message}</div>`;
  }
}

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'compte-rendu') renderCompteRendu();
  if (e.detail?.view === 'audit-cpam') renderAuditCPAM();
});


/* ══════════════════════════════════════════════
   MODULE SIMULATEUR D'AUDIT CPAM
   Analyse l'historique des 6 derniers mois et
   identifie les patterns à risque de contrôle
   ══════════════════════════════════════════════ */

/* ── Règles de risque CPAM (NGAP 2026) ──────── */
const AUDIT_RULES = [
  {
    id: 'bsi_sans_renouvellement',
    label: 'BSI sans renouvellement trimestriel',
    description: 'Un BSI doit être renouvelé tous les 3 mois maximum. Un BSI non renouvelé sur un patient actif est un signal fort de contrôle.',
    gravite: 'CRITIQUE',
    check: (cotations, _patients) => {
      const bsiCots = cotations.filter(c => (c.actes||[]).some(a => /\bBSI\b/i.test(a.code||a.description||'')));
      const patientsBSI = {};
      bsiCots.forEach(c => {
        const pid = c.patient_id;
        if (!patientsBSI[pid] || new Date(c.date_soin) > new Date(patientsBSI[pid])) patientsBSI[pid] = c.date_soin;
      });
      const now = new Date();
      const risques = Object.entries(patientsBSI).filter(([, d]) => (now - new Date(d)) / 86400000 > 90);
      return { score: Math.min(100, risques.length * 25), details: risques.length ? `${risques.length} patient(s) avec BSI non renouvelé depuis >90j` : null };
    },
  },
  {
    id: 'ifd_systematique',
    label: 'IFD facturée de façon systématique',
    description: 'L\'Indemnité Forfaitaire de Déplacement ne peut être facturée qu\'une fois par jour et par patient. Un taux d\'IFD > 95% sur un patient est suspect.',
    gravite: 'ELEVE',
    check: (cotations) => {
      const parPatient = {};
      cotations.forEach(c => {
        const pid = c.patient_id || 'inconnu';
        if (!parPatient[pid]) parPatient[pid] = { total: 0, ifd: 0 };
        parPatient[pid].total++;
        if ((c.actes||[]).some(a => /\bIFD\b/i.test(a.code||''))) parPatient[pid].ifd++;
      });
      const suspects = Object.entries(parPatient).filter(([, s]) => s.total >= 5 && (s.ifd / s.total) > 0.95);
      return { score: Math.min(100, suspects.length * 20), details: suspects.length ? `${suspects.length} patient(s) avec IFD >95% des passages` : null };
    },
  },
  {
    id: 'ami4_sans_justification',
    label: 'AMI 4 sans dépendance documentée',
    description: 'La cotation AMI 4 (soins nursing lourd) exige une dépendance lourde documentée (grabataire, Alzheimer avancé, soins palliatifs). Sans BSI de niveau 3, cette cotation est très risquée.',
    gravite: 'CRITIQUE',
    check: (cotations) => {
      const ami4 = cotations.filter(c => (c.actes||[]).some(a => /\bAMI\s*4\b/i.test(a.code||a.description||'')));
      return { score: Math.min(100, ami4.length * 10), details: ami4.length ? `${ami4.length} cotation(s) AMI 4 — vérifier que chaque patient a un BSI 3 valide` : null };
    },
  },
  {
    id: 'taux_majoration_nuit',
    label: 'Taux de majorations nuit/dimanche anormalement élevé',
    description: 'Un taux de majorations nuit profonde ou dimanche > 40% de l\'activité totale est statistiquement atypique et déclencheur de contrôle.',
    gravite: 'ELEVE',
    check: (cotations) => {
      const total = cotations.length;
      if (!total) return { score: 0, details: null };
      const nuitDim = cotations.filter(c => (c.actes||[]).some(a => /\b(NUIT|DIM|NUI)\b/i.test(a.code||''))).length;
      const taux = nuitDim / total;
      const score = taux > 0.4 ? Math.round((taux - 0.4) * 250) : 0;
      return { score: Math.min(100, score), details: taux > 0.4 ? `${Math.round(taux*100)}% de majorations nuit/dimanche (seuil : 40%)` : null };
    },
  },
  {
    id: 'double_cotation_meme_jour',
    label: 'Double cotation pour un même patient le même jour',
    description: 'Deux passages facturés le même jour chez le même patient sont acceptables mais doivent être justifiés médicalement. Un pattern répétitif est suspect.',
    gravite: 'MOYEN',
    check: (cotations) => {
      const vus = {};
      let doublons = 0;
      cotations.forEach(c => {
        const key = `${c.patient_id||'_'}_${(c.date_soin||'').slice(0,10)}`;
        if (vus[key]) doublons++; else vus[key] = true;
      });
      return { score: Math.min(100, doublons * 8), details: doublons ? `${doublons} jour(s) avec double facturation pour un même patient` : null };
    },
  },
  {
    id: 'perfusion_sans_prescription',
    label: 'Perfusions sans ordonnance jointe',
    description: 'Les actes de perfusion (IFD + acte technique) doivent systématiquement être associés à une ordonnance valide. L\'absence de traçabilité prescripteur est risquée.',
    gravite: 'ELEVE',
    check: (cotations) => {
      const perf = cotations.filter(c => (c.actes||[]).some(a => /perf|perfusion/i.test(a.description||a.code||'')));
      const sansPrescripteur = perf.filter(c => !c.prescripteur && !c.medecin);
      return { score: Math.min(100, sansPrescripteur.length * 15), details: sansPrescripteur.length ? `${sansPrescripteur.length} perfusion(s) sans prescripteur renseigné` : null };
    },
  },
  {
    id: 'km_excessifs',
    label: 'Indemnités kilométriques disproportionnées',
    description: 'Des indemnités kilométriques représentant plus de 30% du CA total peuvent déclencher une vérification de cohérence géographique.',
    gravite: 'MOYEN',
    check: (cotations) => {
      const totalCA = cotations.reduce((s, c) => s + (parseFloat(c.total)||0), 0);
      const totalKm = cotations.reduce((s, c) => s + (parseFloat(c.km)||0) * 0.674, 0); // IK 2026
      if (!totalCA) return { score: 0, details: null };
      const ratio = totalKm / totalCA;
      const score = ratio > 0.3 ? Math.round((ratio - 0.3) * 200) : 0;
      return { score: Math.min(100, score), details: ratio > 0.3 ? `IK représentent ${Math.round(ratio*100)}% du CA (seuil : 30%)` : null };
    },
  },
  {
    id: 'actes_complexes_repetitifs',
    label: 'Actes complexes répétitifs sans évolution de situation',
    description: 'Pansements complexes (BSB) ou perfusions cotés chaque jour pendant plus de 30 jours pour le même patient sans trace d\'évolution de la prescription.',
    gravite: 'MOYEN',
    check: (cotations) => {
      const parPatient = {};
      cotations.forEach(c => {
        if (!(c.actes||[]).some(a => /BSB|perf|pansement complexe/i.test(a.description||a.code||''))) return;
        const pid = c.patient_id || '_';
        parPatient[pid] = (parPatient[pid]||0) + 1;
      });
      const suspects = Object.values(parPatient).filter(n => n > 30).length;
      return { score: Math.min(100, suspects * 30), details: suspects ? `${suspects} patient(s) avec actes complexes >30 fois sur la période` : null };
    },
  },
];

/* ── Score global → niveau de risque ─────────── */
function _auditGlobalRisk(results) {
  const critiques = results.filter(r => r.gravite === 'CRITIQUE' && r.score > 0);
  const eleves    = results.filter(r => r.gravite === 'ELEVE'    && r.score > 0);
  const moyens    = results.filter(r => r.gravite === 'MOYEN'    && r.score > 0);
  const scoreTotal = critiques.reduce((s,r)=>s+r.score*1.5,0) + eleves.reduce((s,r)=>s+r.score,0) + moyens.reduce((s,r)=>s+r.score*0.5,0);
  const norm = Math.min(100, Math.round(scoreTotal / AUDIT_RULES.length));
  if (critiques.length >= 2 || norm >= 70) return { niveau: 'CRITIQUE', label: '🔴 RISQUE CPAM CRITIQUE', color: '#ef4444', bg: 'rgba(239,68,68,.08)', border: 'rgba(239,68,68,.3)', score: norm };
  if (critiques.length >= 1 || norm >= 40) return { niveau: 'ELEVE',    label: '🟠 RISQUE ÉLEVÉ',        color: '#f97316', bg: 'rgba(249,115,22,.08)', border: 'rgba(249,115,22,.3)', score: norm };
  if (eleves.length >= 1 || norm >= 20)    return { niveau: 'MOYEN',    label: '🟡 RISQUE MODÉRÉ',       color: '#f59e0b', bg: 'rgba(245,158,11,.08)', border: 'rgba(245,158,11,.3)', score: norm };
  return { niveau: 'FAIBLE', label: '🟢 RISQUE FAIBLE', color: '#22c55e', bg: 'rgba(34,197,94,.08)', border: 'rgba(34,197,94,.3)', score: norm };
}

function _gravColor(g) {
  return g === 'CRITIQUE' ? '#ef4444' : g === 'ELEVE' ? '#f97316' : '#f59e0b';
}
function _gravBg(g) {
  return g === 'CRITIQUE' ? 'rgba(239,68,68,.07)' : g === 'ELEVE' ? 'rgba(249,115,22,.07)' : 'rgba(245,158,11,.07)';
}
function _gravBorder(g) {
  return g === 'CRITIQUE' ? 'rgba(239,68,68,.25)' : g === 'ELEVE' ? 'rgba(249,115,22,.25)' : 'rgba(245,158,11,.25)';
}

/* ── Score bar ───────────────────────────────── */
function _scoreBar(score, color) {
  return `<div style="height:6px;background:rgba(255,255,255,.08);border-radius:3px;margin-top:6px;overflow:hidden"><div style="height:100%;width:${score}%;background:${color};border-radius:3px;transition:width .6s"></div></div>`;
}

/* ════════════════════════════════════════════════
   RENDU PRINCIPAL
════════════════════════════════════════════════ */
async function renderAuditCPAM() {
  const wrap = document.getElementById('audit-cpam-root');
  if (!wrap) return;

  wrap.innerHTML = `
    <h1 class="pt">Simulateur <em>d'audit CPAM</em></h1>
    <p class="ps">Analyse de risque sur 6 mois · 8 règles NGAP 2026 · Recommandations préventives</p>

    <div class="card">
      <div class="priv" style="border-color:rgba(239,68,68,.2);background:rgba(239,68,68,.04)">
        <span style="font-size:16px;flex-shrink:0">🛡️</span>
        <p><strong>Simulation locale uniquement.</strong> L'analyse porte sur votre historique de cotations stocké localement. Aucune donnée n'est transmise. Ce simulateur ne remplace pas un conseil juridique ou comptable.</p>
      </div>

      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        <div class="f" style="margin:0;flex:1;min-width:160px">
          <label style="font-size:12px;color:var(--m);font-family:var(--fm)">Période d'analyse</label>
          <select id="audit-periode" style="width:100%;padding:8px 12px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:13px;font-family:var(--fm)">
            <option value="3">3 derniers mois</option>
            <option value="6" selected>6 derniers mois</option>
            <option value="12">12 derniers mois</option>
          </select>
        </div>
        <div style="padding-top:18px">
          <button class="btn bp" onclick="auditLancer()"><span>🔍</span> Lancer l'audit</button>
        </div>
      </div>

      <div id="audit-result"></div>
    </div>

    <!-- Référentiel des règles -->
    <div class="card">
      <div class="lbl" style="margin-bottom:14px">📚 Règles de contrôle CPAM surveillées</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${AUDIT_RULES.map(r => `
          <div style="background:var(--s);border:1px solid ${_gravBorder(r.gravite)};border-radius:10px;padding:12px 14px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-size:10px;font-weight:800;color:${_gravColor(r.gravite)};font-family:var(--fm);background:${_gravBg(r.gravite)};padding:2px 8px;border-radius:20px">${r.gravite}</span>
              <span style="font-size:13px;font-weight:600;color:var(--t)">${r.label}</span>
            </div>
            <div style="font-size:12px;color:var(--m);line-height:1.5">${r.description}</div>
          </div>`).join('')}
      </div>
    </div>
  `;
}

async function auditLancer() {
  const resultEl = document.getElementById('audit-result');
  if (!resultEl) return;

  resultEl.innerHTML = `<div style="text-align:center;padding:32px"><div class="spin spinw" style="width:32px;height:32px;margin:0 auto 12px"></div><div style="font-size:13px;color:var(--m)">Analyse de votre historique…</div></div>`;

  // Charger les cotations depuis l'API
  const mois = parseInt(document.getElementById('audit-periode')?.value || '6');
  const depuis = new Date(Date.now() - mois * 30 * 86400000).toISOString().slice(0,10);

  let cotations = [];
  try {
    if (typeof apiCall === 'function') {
      const res = await apiCall('/webhook/ami-historique', { limit: 500, depuis });
      cotations = Array.isArray(res?.cotations) ? res.cotations : Array.isArray(res) ? res : [];
    }
  } catch (_) {}

  if (!cotations.length) {
    resultEl.innerHTML = `<div class="ai in">Aucune cotation trouvée sur la période. Cotez des soins pour générer un rapport d'audit.</div>`;
    return;
  }

  // Exécuter toutes les règles
  const results = AUDIT_RULES.map(rule => {
    try {
      const { score, details } = rule.check(cotations, []);
      return { ...rule, score: Math.max(0, Math.min(100, score||0)), details };
    } catch (_) {
      return { ...rule, score: 0, details: null };
    }
  });

  const global = _auditGlobalRisk(results);
  const actives = results.filter(r => r.score > 0).sort((a,b) => b.score - a.score);
  const ok      = results.filter(r => r.score === 0);

  resultEl.innerHTML = `
    <!-- Score global -->
    <div style="background:${global.bg};border:1px solid ${global.border};border-radius:14px;padding:24px;margin-bottom:20px;text-align:center">
      <div style="font-size:12px;font-family:var(--fm);color:${global.color};letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">Résultat de simulation</div>
      <div style="font-family:var(--fs);font-size:42px;color:${global.color};line-height:1">${global.score}<span style="font-size:20px">/100</span></div>
      <div style="font-size:16px;font-weight:700;color:${global.color};margin-top:8px">${global.label}</div>
      <div style="font-size:12px;color:var(--m);margin-top:6px">${cotations.length} cotations analysées · ${mois} derniers mois</div>
    </div>

    <!-- Alertes actives -->
    ${actives.length ? `
    <div class="lbl" style="margin-bottom:12px">⚠️ Points de vigilance détectés (${actives.length})</div>
    ${actives.map(r => `
      <div style="background:${_gravBg(r.gravite)};border:1px solid ${_gravBorder(r.gravite)};border-radius:10px;padding:14px;margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:10px;font-weight:800;color:${_gravColor(r.gravite)};font-family:var(--fm)">${r.gravite}</span>
            <span style="font-size:13px;font-weight:600;color:var(--t)">${r.label}</span>
          </div>
          <span style="font-family:var(--fs);font-size:18px;color:${_gravColor(r.gravite)}">${r.score}/100</span>
        </div>
        ${_scoreBar(r.score, _gravColor(r.gravite))}
        <div style="font-size:12px;color:var(--m);margin-top:8px;line-height:1.5">${r.description}</div>
        ${r.details ? `<div style="font-size:12px;font-weight:600;color:${_gravColor(r.gravite)};margin-top:6px;font-family:var(--fm)">→ ${r.details}</div>` : ''}
      </div>`).join('')}` : ''}

    <!-- Points OK -->
    ${ok.length ? `
    <div class="lbl" style="margin-bottom:10px;margin-top:16px">✅ Points conformes (${ok.length})</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${ok.map(r => `
        <div style="background:rgba(34,197,94,.04);border:1px solid rgba(34,197,94,.15);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px">
          <span style="color:#22c55e;font-size:14px;flex-shrink:0">✓</span>
          <span style="font-size:12px;color:var(--t)">${r.label}</span>
        </div>`).join('')}
    </div>` : ''}

    <!-- Recommandations -->
    <div style="background:rgba(0,212,170,.04);border:1px solid rgba(0,212,170,.15);border-radius:12px;padding:16px;margin-top:20px">
      <div class="lbl" style="margin-bottom:10px">💡 Recommandations préventives</div>
      <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">
        ${actives.filter(r=>r.gravite==='CRITIQUE').length ? '<li style="font-size:12px;color:var(--t);line-height:1.5">🔴 <strong>Actions urgentes :</strong> Corrigez les points critiques avant le prochain relevé CPAM.</li>' : ''}
        <li style="font-size:12px;color:var(--t);line-height:1.5">Vérifiez que chaque patient avec BSI a une évaluation datant de moins de 3 mois.</li>
        <li style="font-size:12px;color:var(--t);line-height:1.5">Documentez systématiquement la dépendance pour les cotations AMI 4 (BSI 3 obligatoire).</li>
        <li style="font-size:12px;color:var(--t);line-height:1.5">Assurez-vous que chaque perfusion est associée à une ordonnance valide dans votre carnet.</li>
        <li style="font-size:12px;color:var(--t);line-height:1.5">Relancez l'audit tous les mois pour anticiper les signalements CPAM.</li>
      </ul>
    </div>

    <!-- Export -->
    <div style="margin-top:16px;text-align:right">
      <button class="btn bs bsm" onclick="auditExportPDF(${global.score}, '${global.niveau}', ${cotations.length}, ${mois})">🖨️ Imprimer le rapport</button>
    </div>
  `;
}

function auditExportPDF(score, niveau, nbCots, mois) {
  const w = window.open('','_blank');
  const infNom = `${APP?.user?.prenom||''} ${APP?.user?.nom||''}`.trim() || '—';
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Audit CPAM AMI</title>
    <style>body{font-family:Arial,sans-serif;padding:30px;color:#000;max-width:680px;margin:0 auto}h1{font-size:16px;color:#007a6a}h2{font-size:13px;color:#555;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:18px}p,li{font-size:12px;line-height:1.7}@media print{@page{margin:15mm}}</style>
    </head><body>
    <h1>🛡️ Rapport Simulation Audit CPAM — AMI</h1>
    <p><strong>Infirmier(ère) :</strong> ${infNom} · <strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
    <p><strong>Période analysée :</strong> ${mois} derniers mois · <strong>Cotations :</strong> ${nbCots}</p>
    <p><strong>Score de risque :</strong> ${score}/100 — Niveau ${niveau}</p>
    <h2>Détail par règle</h2>
    <ul>${AUDIT_RULES.map(r=>`<li><strong>${r.label}</strong> (${r.gravite}) — ${r.description}</li>`).join('')}</ul>
    <p style="font-size:10px;color:#888;margin-top:24px">Simulation AMI — Ne remplace pas un audit officiel CPAM ni un conseil juridique.</p>
    </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}
