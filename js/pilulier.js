/* ════════════════════════════════════════════════
   pilulier.js — AMI v1.0
   ────────────────────────────────────────────────
   Module Semainier / Pilulier
   ────────────────────────────────────────────────
   Fonctionnalités :
   1. Création et gestion de piluliers hebdomadaires
   2. Liste médicaments par patient avec horaires
   3. Cases à cocher par prise (M/Mi/S/N)
   4. Impression / export PDF du semainier
   5. Historique des préparations
   6. IDB isolée par userId (ami_piluliers_<uid>) + sync Supabase cross-appareils
   ────────────────────────────────────────────────
════════════════════════════════════════════════ */

const PILULIER_STORE = 'piluliers';

/* ── IDB isolée par userId — même pattern que patients.js ── */
let _pilulierDB         = null;
let _pilulierDBUserId   = null;
let _pilulierDBOpening  = null;

function _pilulierDbName() {
  const uid = S?.user?.id || S?.user?.email || 'local';
  return 'ami_piluliers_' + uid.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function _pilulierDb() {
  const currentUid = S?.user?.id || S?.user?.email || 'local';

  // Fermer si changement d'utilisateur
  if (_pilulierDB && _pilulierDBUserId !== currentUid) {
    try { _pilulierDB.close(); } catch (_) {}
    _pilulierDB = null; _pilulierDBUserId = null; _pilulierDBOpening = null;
  }
  if (_pilulierDB) return _pilulierDB;
  if (_pilulierDBOpening) return _pilulierDBOpening;

  _pilulierDBOpening = new Promise((resolve, reject) => {
    const req = indexedDB.open(_pilulierDbName(), 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(PILULIER_STORE)) {
        const s = db.createObjectStore(PILULIER_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('patient_id', 'patient_id', { unique: false });
        s.createIndex('user_id',    'user_id',    { unique: false });
      }
    };
    req.onsuccess = e => {
      _pilulierDB       = e.target.result;
      _pilulierDBUserId = currentUid;
      _pilulierDBOpening = null;
      _pilulierDB.onclose = () => {
        _pilulierDB = null; _pilulierDBUserId = null; _pilulierDBOpening = null;
      };
      resolve(_pilulierDB);
    };
    req.onerror  = () => { _pilulierDBOpening = null; reject(req.error); };
    req.onblocked = () => console.warn('[AMI] ami_piluliers IDB bloquée');
  });
  return _pilulierDBOpening;
}

/* Fermer la DB au logout (auth.js dispatche ami:logout) */
document.addEventListener('ami:logout', () => {
  try { if (_pilulierDB) _pilulierDB.close(); } catch (_) {}
  _pilulierDB = null; _pilulierDBUserId = null; _pilulierDBOpening = null;
});

/* ── Chiffrement stable pour sync cross-appareils ─────────────────────
   Clé dérivée de l'userId (stable entre appareils et sessions),
   PAS du token JWT qui change à chaque connexion et casserait la sync.
   Identique au pattern de patients.js (_enc/_dec).
─────────────────────────────────────────────────────────────────────── */
function _pilSyncKey() {
  const uid = S?.user?.id || S?.user?.email || 'local';
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (Math.imul(31, h) + uid.charCodeAt(i)) | 0;
  return 'sk_pil_' + String(Math.abs(h));
}
function _pilEnc(obj) {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(obj) + '|' + _pilSyncKey()))); } catch { return null; }
}
function _pilDec(str) {
  try { const raw = decodeURIComponent(escape(atob(str))); const sep = raw.lastIndexOf('|'); return JSON.parse(raw.slice(0, sep)); } catch { return null; }
}


async function _pilulierSave(obj) {
  const db = await _pilulierDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PILULIER_STORE, 'readwrite');
    const req = tx.objectStore(PILULIER_STORE).put(obj);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function _pilulierGetAll(patientId) {
  const db = await _pilulierDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(PILULIER_STORE, 'readonly');
    const idx = tx.objectStore(PILULIER_STORE).index('patient_id');
    const req = idx.getAll(patientId);
    // La base est déjà isolée par userId — pas de filtre supplémentaire
    req.onsuccess = e => resolve((e.target.result||[]).sort((a,b) => new Date(b.date_creation) - new Date(a.date_creation)));
    req.onerror   = e => reject(e.target.error);
  });
}

async function _pilulierDelete(id) {
  const db = await _pilulierDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PILULIER_STORE, 'readwrite');
    tx.objectStore(PILULIER_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = e  => reject(e.target.error);
  });
}

/* ── État ────────────────────────────────────── */
let _pilCurrentPatient = null;
let _pilMeds = []; // [{ nom, matin, midi, soir, nuit, remarque }]

const JOURS = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'];
const PRISES = [
  { key: 'matin', label: '🌅 Matin', short: 'M' },
  { key: 'midi',  label: '☀️ Midi',  short: 'Mi' },
  { key: 'soir',  label: '🌆 Soir',  short: 'S' },
  { key: 'nuit',  label: '🌙 Nuit',  short: 'N' },
];

/* ════════════════════════════════════════════════
   RENDU PRINCIPAL
════════════════════════════════════════════════ */
async function renderPilulier() {
  const wrap = document.getElementById('pilulier-root');
  if (!wrap) return;

  // Pull silencieux depuis Supabase au chargement du module
  pilSyncPull().catch(() => {});

  let patients = [];
  try { if (typeof getAllPatients === 'function') patients = await getAllPatients(); } catch (_) {}

  wrap.innerHTML = `
    <h1 class="pt">Semainier <em>pilulier</em></h1>
    <p class="ps">Préparation des doses hebdomadaires · Impression · Traçabilité locale</p>

    <div class="card">
      <div class="priv"><span style="font-size:16px;flex-shrink:0">🔒</span><p>Données médicaments chiffrées AES-256 sur votre appareil, synchronisées de façon sécurisée entre vos appareils. Aucune donnée lisible côté serveur.</p></div>

      <!-- Sélecteur patient -->
      <div class="lbl" style="margin-bottom:8px">Patient</div>
      <select id="pil-patient-sel" onchange="pilSelectPatient(this.value)" style="width:100%;margin-bottom:20px;padding:10px 14px;background:var(--dd);border:1px solid var(--b);border-radius:10px;color:var(--t);font-size:14px;font-family:var(--ff)">
        <option value="">— Sélectionner un patient —</option>
        ${patients.map(p => `<option value="${p.id}">${p.nom||''} ${p.prenom||''}</option>`).join('')}
      </select>

      <!-- Section médicaments -->
      <div id="pil-meds-section" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div class="lbl">💊 Médicaments du pilulier</div>
          <button class="btn bp bsm" onclick="pilAddMed()"><span>+</span> Ajouter un médicament</button>
        </div>
        <div id="pil-meds-list" style="margin-bottom:16px"></div>

        <!-- Semainier visuel -->
        <div class="lbl" style="margin-bottom:12px">📅 Semainier</div>
        <div id="pil-semainier-wrap" style="overflow-x:auto;margin-bottom:16px">
          <div id="pil-semainier"></div>
        </div>

        <!-- Options semaine -->
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
          <div class="f" style="margin:0;flex:1;min-width:160px">
            <label style="font-size:12px;color:var(--m);font-family:var(--fm)">Semaine du</label>
            <input type="date" id="pil-semaine-debut" value="${_getMondayISO()}" onchange="pilRenderSemainier()" style="padding:8px 12px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:13px;font-family:var(--fm);width:100%">
          </div>
          <div class="f" style="margin:0">
            <label style="font-size:12px;color:var(--m);font-family:var(--fm)">Préparée par</label>
            <input type="text" id="pil-preparateur" value="${APP?.user?.prenom||''} ${APP?.user?.nom||''}".trim()" placeholder="Nom infirmière" style="padding:8px 12px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:13px;font-family:var(--fm)">
          </div>
        </div>

        <div id="pil-msg" class="msg e" style="display:none"></div>
        <div class="ar-row">
          <button class="btn bp" onclick="pilSaveAndPrint()"><span>🖨️</span> Sauvegarder et imprimer</button>
          <button class="btn bs" onclick="pilSave()"><span>💾</span> Sauvegarder</button>
        </div>
      </div>
    </div>

    <!-- Historique -->
    <div id="pil-history-wrap" class="card" style="display:none">
      <div class="lbl" style="margin-bottom:14px">📋 Piluliers précédents</div>
      <div id="pil-history-list"></div>
    </div>
  `;
}

function _getMondayISO() {
  const d = new Date();
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

async function pilSelectPatient(patientId) {
  _pilCurrentPatient = patientId || null;
  _pilMeds = [];

  const section = document.getElementById('pil-meds-section');
  const histWrap = document.getElementById('pil-history-wrap');

  if (!patientId) {
    if (section) section.style.display = 'none';
    if (histWrap) histWrap.style.display = 'none';
    return;
  }

  // Tenter de charger les meds depuis la fiche patient
  try {
    if (typeof getPatientById === 'function') {
      const p = await getPatientById(patientId);
      if (p && p.medicaments) {
        // Parser les médicaments : une ligne = un méd
        _pilMeds = p.medicaments.split('\n').filter(Boolean).map(line => ({
          nom: line.trim(), matin: false, midi: false, soir: false, nuit: false, remarque: ''
        }));
      }
    }
  } catch (_) {}

  if (section) section.style.display = 'block';
  pilRenderMedsList();
  pilRenderSemainier();
  await pilLoadHistory();
  if (histWrap) histWrap.style.display = 'block';
}

function pilRenderMedsList() {
  const el = document.getElementById('pil-meds-list');
  if (!el) return;
  if (!_pilMeds.length) {
    el.innerHTML = '<div class="ai in" style="font-size:12px">Aucun médicament. Cliquez sur "Ajouter" pour commencer.</div>';
    return;
  }
  el.innerHTML = _pilMeds.map((m, i) => `
    <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <input type="text" value="${m.nom}" onchange="_pilMedSet(${i},'nom',this.value)" placeholder="Nom du médicament / dosage" style="flex:2;min-width:160px;padding:7px 10px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:13px;font-family:var(--ff)">
      ${PRISES.map(pr => `
        <label style="display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;font-size:11px;color:var(--m);font-family:var(--fm)">
          <input type="checkbox" ${m[pr.key]?'checked':''} onchange="_pilMedSet(${i},'${pr.key}',this.checked)" style="accent-color:var(--a);width:16px;height:16px">
          ${pr.short}
        </label>`).join('')}
      <input type="text" value="${m.remarque||''}" onchange="_pilMedSet(${i},'remarque',this.value)" placeholder="Remarque" style="flex:1;min-width:100px;padding:7px 10px;background:var(--dd);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:12px;font-family:var(--fm)">
      <button onclick="_pilMedRemove(${i})" style="background:none;border:none;color:var(--d);cursor:pointer;font-size:16px;padding:2px 6px" title="Supprimer">🗑</button>
    </div>`).join('');
}

function _pilMedSet(idx, key, val) {
  if (!_pilMeds[idx]) return;
  _pilMeds[idx][key] = val;
  // Si on active/désactive une prise globale, initialiser jours à false si pas encore défini
  // (l'utilisateur cochera manuellement les jours qu'il veut)
  if (['matin','midi','soir','nuit'].includes(key)) {
    if (!_pilMeds[idx].jours) _pilMeds[idx].jours = {};
    if (!Array.isArray(_pilMeds[idx].jours[key])) {
      _pilMeds[idx].jours[key] = Array(7).fill(false);
    }
  }
  pilRenderSemainier();
}

/* Met à jour l'état d'une case spécifique jour×prise dans le semainier */
function _pilSetJour(medIdx, priseKey, jourIdx, checked) {
  if (!_pilMeds[medIdx]) return;
  if (!_pilMeds[medIdx].jours) _pilMeds[medIdx].jours = {};
  if (!Array.isArray(_pilMeds[medIdx].jours[priseKey])) {
    _pilMeds[medIdx].jours[priseKey] = Array(7).fill(false);
  }
  _pilMeds[medIdx].jours[priseKey][jourIdx] = checked;
}

function _pilMedRemove(idx) {
  _pilMeds.splice(idx, 1);
  pilRenderMedsList();
  pilRenderSemainier();
}

function pilAddMed() {
  _pilMeds.push({ nom: '', matin: false, midi: false, soir: false, nuit: false, remarque: '' });
  pilRenderMedsList();
  pilRenderSemainier();
}

function pilRenderSemainier() {
  const el = document.getElementById('pil-semainier');
  if (!el) return;
  const debutISO = document.getElementById('pil-semaine-debut')?.value || _getMondayISO();
  const debut = new Date(debutISO);

  const meds = _pilMeds.filter(m => m.nom && (m.matin || m.midi || m.soir || m.nuit));
  if (!meds.length) {
    el.innerHTML = '<div class="ai in" style="font-size:12px">Ajoutez des médicaments avec au moins une prise pour afficher le semainier.</div>';
    return;
  }

  const prises = PRISES.filter(pr => meds.some(m => m[pr.key]));

  // Initialiser jours uniquement si vraiment absent (nouveau médicament)
  // → toujours à false : l'utilisateur coche manuellement case par case
  // Ne PAS pré-cocher selon la prise globale (c'est le bug)
  meds.forEach(m => {
    if (!m.jours) m.jours = {};
    PRISES.forEach(pr => {
      if (!Array.isArray(m.jours[pr.key])) {
        m.jours[pr.key] = Array(7).fill(false);
      }
    });
  });

  let html = `<table style="border-collapse:collapse;min-width:520px;font-size:12px;font-family:var(--fm)">
    <thead>
      <tr style="background:var(--s)">
        <th style="padding:8px 10px;text-align:left;border:1px solid var(--b);color:var(--m)">Médicament</th>
        ${JOURS.map((j, ji) => {
          const d = new Date(debut);
          d.setDate(debut.getDate() + ji);
          return `<th style="padding:8px 6px;text-align:center;border:1px solid var(--b);color:var(--m);min-width:60px">${j}<br><span style="font-size:10px;font-weight:400">${d.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'})}</span></th>`;
        }).join('')}
      </tr>
    </thead>
    <tbody>`;

  meds.forEach((m, mi) => {
    prises.filter(pr => m[pr.key]).forEach((pr, pi) => {
      html += `<tr style="${pi===0?'border-top:2px solid var(--b)':''}">
        <td style="padding:7px 10px;border:1px solid var(--b);color:var(--t)">
          ${pi===0?`<strong>${m.nom}</strong>`:''}
          <span style="color:var(--m);font-size:10px;display:block">${pr.label}${m.remarque&&pi===0?` · ${m.remarque}`:''}</span>
        </td>
        ${JOURS.map((_, ji) => {
          // Lire l'état sauvegardé par jour
          const checked = m.jours?.[pr.key]?.[ji] ?? !!m[pr.key];
          const medIdx = _pilMeds.indexOf(m);
          return `<td style="text-align:center;border:1px solid var(--b);padding:4px">
            <input type="checkbox" ${checked ? 'checked' : ''}
              style="accent-color:var(--a);width:16px;height:16px;cursor:pointer"
              id="pil-check-${medIdx}-${pr.key}-${ji}"
              onchange="_pilSetJour(${medIdx},'${pr.key}',${ji},this.checked)">
          </td>`;
        }).join('')}
      </tr>`;
    });
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

async function pilSave() {
  if (!_pilCurrentPatient || !_pilMeds.length) {
    showToast('warning', 'Données incomplètes', 'Sélectionnez un patient et ajoutez des médicaments.'); return;
  }

  // S'assurer que jours est initialisé avant sauvegarde
  // Les cases non encore touchées restent à false (pas pré-cochées)
  _pilMeds.forEach(m => {
    if (!m.jours) m.jours = {};
    ['matin','midi','soir','nuit'].forEach(pr => {
      if (!Array.isArray(m.jours[pr])) m.jours[pr] = Array(7).fill(false);
    });
  });

  const obj = {
    patient_id:     _pilCurrentPatient,
    user_id:        APP?.user?.id || '',
    meds:           JSON.parse(JSON.stringify(_pilMeds)), // inclut jours[]
    semaine_debut:  document.getElementById('pil-semaine-debut')?.value || _getMondayISO(),
    preparateur:    document.getElementById('pil-preparateur')?.value?.trim() || '',
    date_creation:  new Date().toISOString(),
  };
  try {
    await _pilulierSave(obj);
    // ── Écriture dans la fiche patient du carnet ──────────────────────
    if (typeof patientAddPilulier === 'function') {
      await patientAddPilulier(_pilCurrentPatient, obj);
    }
    showToast('success', 'Pilulier sauvegardé');
    await pilLoadHistory();
    // Sync cross-appareils en arrière-plan (silencieux)
    pilSyncPush().catch(() => {});
  } catch (err) {
    showToast('error', 'Erreur', err.message);
  }
}

async function pilSaveAndPrint() {
  await pilSave();
  pilPrint();
}

function pilPrint() {
  const semainierEl = document.getElementById('pil-semainier');
  if (!semainierEl) return;

  const patSel = document.getElementById('pil-patient-sel');
  const patNom = patSel?.options[patSel.selectedIndex]?.text || 'Patient';
  const prep   = document.getElementById('pil-preparateur')?.value || '';
  const sem    = document.getElementById('pil-semaine-debut')?.value || '';

  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Pilulier AMI</title>
    <style>body{font-family:Arial,sans-serif;padding:20px;color:#000}h1{font-size:18px}h2{font-size:14px;color:#555}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 8px;font-size:12px}th{background:#f0f0f0}input[type=checkbox]{width:14px;height:14px}@media print{@page{margin:15mm}}</style>
    </head><body>
    <h1>🩺 Pilulier AMI — ${patNom}</h1>
    <h2>Semaine du ${sem} · Préparé par : ${prep} · ${new Date().toLocaleDateString('fr-FR')}</h2>
    ${semainierEl.innerHTML}
    <p style="font-size:10px;color:#888;margin-top:20px">Généré par AMI — Données locales · Ne pas transmettre sans accord du patient</p>
    </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

async function pilLoadHistory() {
  if (!_pilCurrentPatient) return;
  const list = document.getElementById('pil-history-list');
  if (!list) return;
  try {
    const all = await _pilulierGetAll(_pilCurrentPatient);
    if (!all.length) { list.innerHTML = '<div class="empty"><p>Aucun pilulier enregistré.</p></div>'; return; }
    list.innerHTML = all.slice(0, 10).map(p => {
      const d = new Date(p.date_creation).toLocaleDateString('fr-FR');
      const nbMeds = (p.meds||[]).filter(m=>m.nom).length;
      return `
        <div style="background:var(--s);border:1px solid var(--b);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:600">Semaine du ${p.semaine_debut||'—'}</div>
            <div style="font-size:12px;color:var(--m);margin-top:2px">${nbMeds} médicament(s) · Préparé le ${d}${p.preparateur?' par '+p.preparateur:''}</div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn bs bsm" onclick="pilLoadFromHistory(${p.id})">📂 Charger</button>
            <button onclick="pilDeleteHistory(${p.id})" style="background:none;border:none;color:var(--d);cursor:pointer;font-size:14px;padding:2px 8px">🗑</button>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="msg e">Erreur : ${err.message}</div>`;
  }
}

async function pilLoadFromHistory(id) {
  const db = await _pilulierDb();
  const obj = await new Promise((res, rej) => {
    const tx = db.transaction(PILULIER_STORE, 'readonly');
    const req = tx.objectStore(PILULIER_STORE).get(id);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
  if (!obj) return;

  // Charger les méds avec leurs états jours sauvegardés
  _pilMeds = JSON.parse(JSON.stringify(obj.meds || []));

  // Restaurer jours si absent (rétrocompat anciens piluliers sans jours)
  _pilMeds.forEach(m => {
    if (!m.jours) m.jours = {};
    ['matin','midi','soir','nuit'].forEach(pr => {
      if (!m.jours[pr]) m.jours[pr] = Array(7).fill(!!m[pr]);
    });
  });

  // Restaurer la semaine
  const sd = document.getElementById('pil-semaine-debut');
  if (sd && obj.semaine_debut) sd.value = obj.semaine_debut;

  // Restaurer le préparateur
  const prep = document.getElementById('pil-preparateur');
  if (prep && obj.preparateur) prep.value = obj.preparateur;

  pilRenderMedsList();
  pilRenderSemainier();
  showToast('info', 'Pilulier chargé', `Semaine du ${obj.semaine_debut || '—'}`);
}

async function pilDeleteHistory(id) {
  if (!confirm('Supprimer ce pilulier ?')) return;
  await _pilulierDelete(id);
  showToast('info', 'Pilulier supprimé');
  await pilLoadHistory();
}


/* ════════════════════════════════════════════════
   SYNC CROSS-APPAREILS — Piluliers / Semainier
   Blob chiffré AES-256-GCM côté client,
   stocké opaque dans Supabase (piluliers_sync).
   Isolation stricte par user.id — admins inclus pour leurs propres données de test.
════════════════════════════════════════════════ */

async function pilSyncPush() {
  const uid = APP?.user?.id;
  if (!uid) return;

  try {
    // Récupérer tous les piluliers de l'utilisateur
    const db  = await _pilulierDb();
    const all = await new Promise((res, rej) => {
      // Base isolée par userId — getAll() retourne uniquement les données de cet user
      const tx  = db.transaction(PILULIER_STORE, 'readonly');
      const req = tx.objectStore(PILULIER_STORE).getAll();
      req.onsuccess = e => res(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    });

    if (!all.length) return;

    // Chiffrement stable (clé dérivée userId, pas du token JWT)
    const encrypted_data = _pilEnc(all);
    if (!encrypted_data) return;

    await wpost('/webhook/piluliers-push', {
      encrypted_data,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[pilSyncPush]', e.message);
  }
}

async function pilSyncPull() {
  const uid = APP?.user?.id;
  if (!uid) return;

  try {
    const resp = await wpost('/webhook/piluliers-pull', {});
    const { data } = resp;
    if (!data?.encrypted_data) return;

    // Déchiffrement stable (clé dérivée userId)
    const remote = _pilDec(data.encrypted_data);

    if (!Array.isArray(remote) || !remote.length) return;

    // Merge : insérer uniquement les piluliers absents localement
    const db       = await _pilulierDb();
    const existing = await new Promise((res2, rej) => {
      // Base isolée par userId — getAll() retourne uniquement les données de cet user
      const tx  = db.transaction(PILULIER_STORE, 'readonly');
      const req = tx.objectStore(PILULIER_STORE).getAll();
      req.onsuccess = e => res2(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    });

    // Clé de déduplication : patient_id + semaine_debut + user_id
    const existSet = new Set(existing.map(p => `${p.patient_id}|${p.semaine_debut}|${p.user_id}`));

    let imported = 0;
    const txW   = db.transaction(PILULIER_STORE, 'readwrite');
    const store = txW.objectStore(PILULIER_STORE);
    for (const p of remote) {
      const key = `${p.patient_id}|${p.semaine_debut}|${p.user_id}`;
      if (!existSet.has(key)) {
        // Supprimer l'id pour laisser autoIncrement assigner un nouvel id local
        const { id: _drop, ...pWithoutId } = p;
        store.add({ ...pWithoutId, _synced: true });
        imported++;
      }
    }
    await new Promise((res3, rej) => {
      txW.oncomplete = () => res3();
      txW.onerror    = e  => rej(e.target.error);
    });

    if (imported > 0) {
      console.log(`[pilSyncPull] ${imported} pilulier(s) importé(s) depuis le serveur`);
    }
  } catch (e) {
    console.warn('[pilSyncPull]', e.message);
  }
}

document.addEventListener('ui:navigate', e => {
  if (e.detail?.view === 'pilulier') renderPilulier();
});

/* Sync pull au login — attend que la session soit disponible */
document.addEventListener('ami:login', () => {
  pilSyncPull().catch(() => {});
});

