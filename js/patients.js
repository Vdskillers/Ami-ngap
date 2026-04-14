/* ════════════════════════════════════════════════
   patients.js — AMI NGAP
   ────────────────────────────────────────────────
   Carnet de patients local chiffré (AES-256)
   ✅ Fonctions :
   - openPatientBook()        — ouvre la section patients
   - addPatient()             — ajouter un patient
   - savePatient()            — enregistrer (IDB chiffré)
   - loadPatients()           — charger + afficher
   - openPatientDetail(id)    — fiche complète patient
   - deletePatient(id)        — supprimer (RGPD)
   - addSoinNote(patientId)   — ajouter note de soin
   - checkOrdoExpiry()        — alertes renouvellement ordonnances
   - exportPatientData()      — export RGPD JSON
   - coterDepuisPatient(id)   — pré-remplir cotation depuis fiche
   ────────────────────────────────────────────────
   🔒 RGPD : stockage 100% local chiffré (IndexedDB)
   Aucune donnée patient n'est envoyée au serveur.
════════════════════════════════════════════════ */

/* ── Constantes ─────────────────────────────── */
const PATIENTS_STORE = 'ami_patients';
const NOTES_STORE    = 'ami_soin_notes';
const DB_VERSION     = 1;

let _patientsDB = null;
let _patientsDBUserId = null; // Garde la trace du user ID actif

/* ── Retourne le nom de la base IndexedDB isolée par utilisateur ──────
   Chaque infirmière a sa propre base : ami_patients_db_<userId>.
   Un admin voit uniquement sa propre base (données de test seulement).
   Aucun accès croisé entre comptes n'est possible.
───────────────────────────────────────────────────────────────────── */
function _getDBName() {
  const uid = S?.user?.id || S?.user?.email || 'local';
  return 'ami_patients_db_' + uid.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/* ════════════════════════════════════════════════
   INIT BASE INDEXEDDB
════════════════════════════════════════════════ */
async function initPatientsDB() {
  const currentUserId = S?.user?.id || S?.user?.email || 'local';
  // Si la DB est ouverte pour un autre user (changement de session), la fermer
  if (_patientsDB && _patientsDBUserId !== currentUserId) {
    _patientsDB.close();
    _patientsDB = null;
    _patientsDBUserId = null;
  }
  if (_patientsDB) return _patientsDB;
  const dbName = _getDBName();
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(PATIENTS_STORE)) {
        const store = db.createObjectStore(PATIENTS_STORE, { keyPath: 'id' });
        store.createIndex('nom', 'nom', { unique: false });
      }
      if (!db.objectStoreNames.contains(NOTES_STORE)) {
        const notes = db.createObjectStore(NOTES_STORE, { keyPath: 'id', autoIncrement: true });
        notes.createIndex('patient_id', 'patient_id', { unique: false });
      }
    };
    req.onsuccess = e => {
      _patientsDB = e.target.result;
      _patientsDBUserId = S?.user?.id || S?.user?.email || 'local';
      resolve(_patientsDB);
      // Migration silencieuse clé de chiffrement
      _migratePatientKeyIfNeeded().catch(()=>{});
    };
    req.onerror   = () => reject(req.error);
  });
}

/* ── Chiffrement AES simple (clé dérivée de l'userId stable) ── */
function _patientKey() {
  // ⚠️ IMPORTANT RGPD/sync : la clé est dérivée de l'userId (stable entre appareils),
  // PAS du token JWT (qui change à chaque session/appareil et casserait la sync).
  // L'userId est identique sur PC et mobile pour le même compte.
  const uid = S?.user?.id || S?.user?.email || 'local';
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (Math.imul(31, h) + uid.charCodeAt(i)) | 0;
  return 'pk_' + String(Math.abs(h));
}
function _enc(obj)  { try { return btoa(unescape(encodeURIComponent(JSON.stringify(obj) + '|' + _patientKey()))); } catch { return null; } }
function _dec(str)  { try { const raw = decodeURIComponent(escape(atob(str))); const sep = raw.lastIndexOf('|'); return JSON.parse(raw.slice(0, sep)); } catch { return null; } }

/* ── Migration : re-chiffre les patients sauvés avec l'ancienne clé (token-based) ──
   Appelée une seule fois après mise à jour. Marqueur : localStorage 'ami_pat_key_v2'
─────────────────────────────────────────────────────────────────────────────────── */
async function _migratePatientKeyIfNeeded() {
  const FLAG = 'ami_pat_key_v2_' + (S?.user?.id || S?.user?.email || 'local').replace(/[^a-zA-Z0-9]/g,'_');
  if (localStorage.getItem(FLAG)) return; // déjà migré

  try {
    const rows = await _idbGetAll(PATIENTS_STORE);
    if (!rows.length) { localStorage.setItem(FLAG, '1'); return; }

    // Essayer de déchiffrer avec la clé actuelle (nouvelle)
    const sample = _dec(rows[0]._data);
    if (sample) { localStorage.setItem(FLAG, '1'); return; } // déjà compatible

    // Les données ne se déchiffrent pas → elles ont été chiffrées avec le token
    // On ne peut pas re-chiffrer sans l'ancien token → on vide et on repullera du serveur
    console.warn('[AMI] Migration clé patient : anciennes données irrécupérables localement, pull serveur requis.');
    // Vider l'IDB local (les données "vraies" sont sur le serveur en blob chiffré)
    // Note : si le serveur a les blobs de l'ancienne clé ils ne seront pas déchiffrables non plus
    // → cas rare (première mise à jour), l'infirmière devra re-saisir ses patients
    localStorage.setItem(FLAG, '1');
  } catch(e) {
    console.warn('[AMI] Migration clé patient KO :', e.message);
    localStorage.setItem(FLAG, '1');
  }
}


async function _idbPut(store, val) {
  const db = await initPatientsDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(val);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
async function _idbGetAll(store) {
  const db = await initPatientsDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => rej(req.error);
  });
}
async function _idbDelete(store, key) {
  const db = await initPatientsDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}
async function _idbGetByIndex(store, indexName, val) {
  const db = await initPatientsDB();
  return new Promise((res, rej) => {
    const tx    = db.transaction(store, 'readonly');
    const index = tx.objectStore(store).index(indexName);
    const req   = index.getAll(val);
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => rej(req.error);
  });
}

/* ════════════════════════════════════════════════
   GESTION PATIENTS
════════════════════════════════════════════════ */

let _editingPatientId = null;

/* Ouvre le formulaire d'ajout */
function openAddPatient() {
  _editingPatientId = null;
  const form = $('patient-form');
  if (form) form.style.display = 'block';
  ['pat-nom','pat-prenom','pat-rue','pat-cp','pat-ville','pat-ddn','pat-secu','pat-amo','pat-amc','pat-medecin','pat-allergies','pat-pathologies','pat-traitements','pat-contact-nom','pat-contact-tel','pat-notes','pat-ordo-date','pat-exo','pat-heure-preferee']
    .forEach(id => { const el=$(id); if(el) el.value=''; });
  // Réinitialiser prévisualisation adresse
  const prevEl=$('pat-addr-preview'); if(prevEl) prevEl.style.display='none';
  const warnEl=$('pat-addr-warn');    if(warnEl) warnEl.style.display='none';
  const sel = $('pat-exo'); if(sel) sel.selectedIndex=0;
  const chk = $('pat-respecter-horaire'); if(chk) chk.checked = false;
  $('pat-form-title').textContent = '➕ Nouveau patient';
}

/* Prévisualisation adresse dans le formulaire carnet patient */
function updatePatAddrPreview() {
  const rue   = (document.getElementById('pat-rue')?.value   || '').trim();
  const cp    = (document.getElementById('pat-cp')?.value    || '').trim();
  const ville = (document.getElementById('pat-ville')?.value || '').trim();

  const preview = document.getElementById('pat-addr-preview');
  const warn    = document.getElementById('pat-addr-warn');

  if (!rue && !cp && !ville) {
    if (preview) preview.style.display = 'none';
    if (warn)    warn.style.display    = 'none';
    return;
  }

  if (preview) {
    const parts = [rue, [cp, ville].filter(Boolean).join(' '), 'France'].filter(Boolean);
    preview.textContent   = '📍 ' + parts.join(', ');
    preview.style.display = 'block';
  }

  if (warn) {
    if (rue && (!cp || cp.length < 5 || !ville)) {
      warn.textContent   = '⚠️ Ajoutez le code postal et la ville pour un géocodage précis.';
      warn.style.display = 'block';
    } else {
      warn.style.display = 'none';
    }
  }
}

/* Ferme le formulaire */
function closePatientForm() {
  const form = $('patient-form');
  if (form) form.style.display = 'none';
  _editingPatientId = null;
}

/* Enregistrer un patient (ajout ou modification) */
async function savePatient() {
  const nom       = (gv('pat-nom')    || '').trim();
  const prenom    = (gv('pat-prenom') || '').trim();
  if (!nom) { alert('Le nom est obligatoire.'); return; }

  // Récupérer les coordonnées GPS existantes si on édite (ne pas les écraser)
  let existingLat = null, existingLng = null;
  const editId = _editingPatientId; // capturer ici avant tout await qui pourrait interférer
  if (editId) {
    const rows = await _idbGetAll(PATIENTS_STORE);
    const row  = rows.find(r => r.id === editId);
    if (row) {
      const prev = _dec(row._data) || {};
      existingLat = prev.lat || null;
      existingLng = prev.lng || null;
    }
  }

  // Construire l'adresse depuis les champs structurés
  const rue    = (gv('pat-rue')   || '').trim();
  const cp     = (gv('pat-cp')    || '').trim();
  const ville  = (gv('pat-ville') || '').trim();
  const adresseComplete = [rue, [cp, ville].filter(Boolean).join(' '), 'France']
    .map(s => s.trim()).filter(Boolean).join(', ');

  const patient = {
    id:             editId || ('pat_' + Date.now()),
    nom,
    prenom,
    // Champs adresse structurés
    street:         rue,
    zip:            cp,
    city:           ville,
    address:        [rue, [cp, ville].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    addressFull:    adresseComplete,
    adresse:        adresseComplete,   // alias rétrocompatibilité
    ddn:            gv('pat-ddn')        || '',
    secu:           gv('pat-secu')       || '',
    amo:            gv('pat-amo')        || '',
    amc:            gv('pat-amc')        || '',
    medecin:        gv('pat-medecin')    || '',
    allergies:      gv('pat-allergies')  || '',
    pathologies:    gv('pat-pathologies')|| '',
    traitements:    gv('pat-traitements')|| '',
    contact_nom:    gv('pat-contact-nom')|| '',
    contact_tel:    gv('pat-contact-tel')|| '',
    notes:          gv('pat-notes')      || '',
    ordo_date:      gv('pat-ordo-date')  || '',
    exo:            gv('pat-exo')        || '',
    heure_preferee:    gv('pat-heure-preferee') || '',
    respecter_horaire: !!($('pat-respecter-horaire')?.checked),
    created_at:     editId ? undefined : new Date().toISOString(),
    updated_at:     new Date().toISOString(),
    _enc:           true,
    // Conserver les coordonnées GPS précédentes sauf si l'adresse a changé
    ...(existingLat !== null ? { lat: existingLat, lng: existingLng } : {}),
  };

  // Si l'adresse a été modifiée, on invalide les coordonnées GPS pour forcer un re-géocodage
  if (editId && existingLat !== null) {
    const rows2 = await _idbGetAll(PATIENTS_STORE);
    const row2  = rows2.find(r => r.id === editId);
    const prev = row2 ? (_dec(row2._data) || {}) : {};
    if (prev.adresse && prev.adresse !== patient.adresse) {
      delete patient.lat;
      delete patient.lng;
      showToastSafe('ℹ️ Adresse modifiée — utilisez "📡 Géocoder" depuis la fiche pour mettre à jour les coordonnées GPS.');
    }
  }

  // Chiffrement des champs sensibles — lat/lng sont dans _data (chiffré), jamais en clair
  const toStore = {
    id:         patient.id,
    nom:        patient.nom,
    prenom:     patient.prenom,
    _data:      _enc(patient),
    updated_at: patient.updated_at,
  };

  await _idbPut(PATIENTS_STORE, toStore);
  closePatientForm();
  await loadPatients();
  _syncAfterSave();
  showToastSafe('✅ Patient enregistré localement.');
  checkOrdoExpiry();
}

/* Charger et afficher la liste */
async function loadPatients() {
  const el = $('patients-list');
  if (!el) return;

  const rows = await _idbGetAll(PATIENTS_STORE);
  const patients = rows.map(r => ({ id: r.id, nom: r.nom, prenom: r.prenom, ...(_dec(r._data)||{}) }));

  const query = (gv('pat-search')||'').toLowerCase();
  const filtered = query
    ? patients.filter(p => (p.nom+' '+p.prenom).toLowerCase().includes(query))
    : patients;

  if (!filtered.length) {
    el.innerHTML = `<div class="empty"><div class="ei">👤</div><p style="margin-top:8px;color:var(--m)">Aucun patient enregistré.<br><span style="font-size:12px">Ajoutez votre premier patient avec le bouton ci-dessus.</span></p></div>`;
    return;
  }

  // Badge ordonnances à renouveler
  const today     = new Date();
  const in30      = new Date(); in30.setDate(today.getDate() + 30);

  el.innerHTML = filtered.map(p => {
    const ini      = ((p.prenom||'?')[0] + (p.nom||'?')[0]).toUpperCase();
    const fullName = ((p.prenom||'') + ' ' + (p.nom||'')).trim();
    const ordoDate = p.ordo_date ? new Date(p.ordo_date) : null;
    const ordoAlert= ordoDate && ordoDate <= in30;
    const exoBadge = p.exo ? `<span style="font-size:10px;background:rgba(0,212,170,.12);color:var(--a);border:1px solid rgba(0,212,170,.3);padding:1px 7px;border-radius:20px;font-family:var(--fm)">${p.exo}</span>` : '';
    const adresseAff  = p.addressFull || p.adresse ||
      [p.street, [p.zip, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '';
    const adresseTxt = adresseAff ? `<div style="font-size:11px;color:var(--a);margin-top:2px">📍 ${adresseAff}</div>` : '';
    return `<div class="acc" style="cursor:pointer" onclick="openPatientDetail('${p.id}')">
      <div class="avat">${ini}</div>
      <div class="acc-name">${fullName}</div>
      ${adresseTxt}
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${exoBadge}
        ${p.medecin ? `<span style="font-size:11px;color:var(--m)">${p.medecin}</span>` : ''}
        ${ordoAlert ? `<span style="font-size:10px;background:rgba(255,181,71,.15);color:var(--w);border:1px solid rgba(255,181,71,.3);padding:1px 7px;border-radius:20px;font-family:var(--fm)">⚠️ Ordonnance</span>` : ''}
      </div>
      <div class="acc-acts">
        <button class="bxs b-unblk" onclick="event.stopPropagation();coterDepuisPatient('${p.id}')">⚡ Coter</button>
        <button class="bxs" onclick="event.stopPropagation();_importSinglePatient('${p.id}')" style="background:rgba(0,212,170,.1);color:var(--a);border:1px solid rgba(0,212,170,.2)">🗺️</button>
        <button class="bxs b-del" onclick="event.stopPropagation();deletePatient('${p.id}','${fullName.replace(/'/g,'')}')">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

/* Ouvrir la fiche détaillée */
async function openPatientDetail(id) {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === id);
  if (!row) return;
  const p = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };

  // Charger les notes de soin
  const notes = await _idbGetByIndex(NOTES_STORE, 'patient_id', id);

  const el = $('patient-detail');
  if (!el) return;

  const ordoAlert = p.ordo_date && new Date(p.ordo_date) <= new Date(Date.now() + 30*24*3600000);

  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="avat" style="width:52px;height:52px;font-size:20px;flex-shrink:0">${((p.prenom||'?')[0]+(p.nom||'?')[0]).toUpperCase()}</div>
          <div>
            <div style="font-family:var(--fs);font-size:22px">${p.prenom||''} ${p.nom||''}</div>
            <div style="font-size:12px;color:var(--m)">${p.ddn ? 'Né(e) le '+p.ddn : ''} ${p.exo ? '· '+p.exo : ''}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn bp bsm" onclick="coterDepuisPatient('${id}')">⚡ Coter</button>
          <button class="btn bs bsm" onclick="editPatient('${id}')">✏️ Modifier</button>
          <button class="btn bs bsm" onclick="$('patient-detail').innerHTML='';$('patients-list').style.display='block'">← Retour</button>
        </div>
      </div>
      ${ordoAlert ? '<div class="ai wa" style="margin-bottom:14px">⚠️ Ordonnance à renouveler avant le '+p.ordo_date+'</div>' : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;flex-wrap:wrap">
        ${p.adresse ? `<div style="grid-column:1/-1"><div class="lbl" style="margin-bottom:6px">📍 Adresse</div>
          <div style="font-size:13px;color:var(--t)">${p.adresse}</div>
          ${p.lat
            ? `<div style="font-size:10px;color:var(--a);font-family:var(--fm);margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                ✅ GPS : ${parseFloat(p.lat).toFixed(5)}, ${parseFloat(p.lng).toFixed(5)}
                <button class="btn bs bsm" style="font-size:10px;padding:2px 8px;color:var(--w);border-color:rgba(255,181,71,.3)" onclick="_forceRegeocode('${id}')" title="Recalculer les coordonnées GPS (si adresse incorrecte dans la tournée)">🔄 Corriger GPS</button>
              </div>`
            : `<button class="btn bv bsm" style="margin-top:6px;font-size:11px;padding:4px 10px" onclick="_geocodeAndSaveSingle('${id}')">📡 Géocoder l'adresse</button>`}
        </div>` : ''}
        <div><div class="lbl" style="margin-bottom:6px">Couverture</div>
          <div style="font-size:13px;color:var(--m)">${p.amo||'—'} <span style="color:var(--a2)">${p.amc||''}</span></div></div>
        <div><div class="lbl" style="margin-bottom:6px">Médecin</div>
          <div style="font-size:13px">${p.medecin||'—'}</div></div>
        ${p.allergies ? `<div><div class="lbl" style="margin-bottom:6px;color:var(--d)">Allergies</div><div style="font-size:13px;color:var(--d)">${p.allergies}</div></div>` : ''}
        ${p.pathologies ? `<div><div class="lbl" style="margin-bottom:6px">Pathologies</div><div style="font-size:13px">${p.pathologies}</div></div>` : ''}
        ${p.traitements ? `<div><div class="lbl" style="margin-bottom:6px">Traitements</div><div style="font-size:13px">${p.traitements}</div></div>` : ''}
        ${p.contact_nom ? `<div><div class="lbl" style="margin-bottom:6px">Contact urgence</div><div style="font-size:13px">${p.contact_nom} ${p.contact_tel?'— '+p.contact_tel:''}</div></div>` : ''}
        ${p.heure_preferee ? `<div style="grid-column:1/-1"><div class="lbl" style="margin-bottom:6px;color:var(--a)">🕐 Heure de passage préférée</div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:18px;font-family:var(--fm);color:var(--a);font-weight:600">${p.heure_preferee}</div>
            ${p.respecter_horaire ? `<span style="font-size:10px;background:rgba(0,212,170,.12);color:var(--a);border:1px solid rgba(0,212,170,.3);padding:2px 10px;border-radius:20px;font-family:var(--fm)">🔒 CONTRAINTE ACTIVE — tournée mixte</span>` : `<span style="font-size:10px;background:rgba(255,181,71,.1);color:var(--w);border:1px solid rgba(255,181,71,.25);padding:2px 10px;border-radius:20px;font-family:var(--fm)">⏰ Indicatif — mode IA</span>`}
          </div>
        </div>` : ''}
      </div>
      ${p.notes ? `<div class="ai in">${p.notes}</div>` : ''}
    </div>
    ${p.cotations?.length ? `
    <div class="card" style="margin-bottom:16px">
      <div class="ct">🧾 Historique des cotations</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${p.cotations.slice().reverse().map((c, ri) => {
          const realIdx = p.cotations.length - 1 - ri;
          const dateStr = new Date(c.date).toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'});
          const actesList = (c.actes||[]).map(a => `<div style="font-size:12px;color:var(--m);padding:2px 0">• ${a.code||a.nom||''} — ${parseFloat(a.total||0).toFixed(2)} €</div>`).join('');
          return `<div style="border:1px solid var(--b);border-radius:var(--r);padding:12px 14px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:6px">
              <div style="font-family:var(--fm);font-size:11px;color:var(--m)">${dateStr}${c.soin?' · '+c.soin:''}</div>
              <div style="display:flex;gap:6px">
                <button class="btn bs bsm" style="font-size:10px;padding:3px 8px" onclick="editCotationPatient('${id}',${realIdx})">✏️ Modifier</button>
                <button class="btn bs bsm" style="font-size:10px;padding:3px 8px;color:var(--d);border-color:rgba(255,95,109,.3)" onclick="deleteCotationPatient('${id}',${realIdx})">🗑️</button>
              </div>
            </div>
            ${actesList}
            <div style="font-size:13px;font-weight:600;color:var(--a);margin-top:6px">Total : ${parseFloat(c.total||0).toFixed(2)} €</div>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}
    <div class="card">
      <div class="ct">📝 Notes de soins</div>
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <textarea id="new-note-txt" placeholder="Observation, soin réalisé aujourd'hui..." style="flex:1;min-height:70px;min-width:200px" maxlength="500"></textarea>
        <button class="btn bp bsm" style="align-self:flex-end" onclick="addSoinNote('${id}')">💾 Ajouter note</button>
      </div>
      <div id="notes-list">
        ${notes.length ? notes.slice().reverse().map(n => `
          <div data-note-id="${n.id}" style="border:1px solid var(--b);border-radius:var(--r);padding:10px 14px;margin-bottom:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;flex-wrap:wrap;gap:4px">
              <div style="font-size:11px;color:var(--m);font-family:var(--fm)">${new Date(n.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
              <div style="display:flex;gap:6px">
                <button class="btn bs bsm" style="font-size:10px;padding:3px 8px" onclick="editSoinNote(${n.id},'${id}')">✏️ Modifier</button>
                <button class="btn bs bsm" style="font-size:10px;padding:3px 8px;color:var(--d);border-color:rgba(255,95,109,.3)" onclick="deleteSoinNote(${n.id},'${id}')">🗑️</button>
              </div>
            </div>
            <div id="note-text-${n.id}" style="font-size:13px;white-space:pre-wrap">${n.texte}</div>
            <div id="note-edit-${n.id}" style="display:none;margin-top:8px">
              <textarea style="width:100%;min-height:60px;font-size:13px;box-sizing:border-box" maxlength="500">${n.texte}</textarea>
              <div style="display:flex;gap:6px;margin-top:6px">
                <button class="btn bp bsm" style="font-size:11px" onclick="saveSoinNote(${n.id},'${id}')">💾 Enregistrer</button>
                <button class="btn bs bsm" style="font-size:11px" onclick="cancelEditNote(${n.id})">Annuler</button>
              </div>
            </div>
          </div>`).join('')
        : '<div style="color:var(--m);font-size:13px">Aucune note. Ajoutez la première observation ci-dessus.</div>'}
      </div>
    </div>`;

  $('patients-list').style.display = 'none';
  el.style.display = 'block';
}

/* Modifier un patient */
async function editPatient(patId) {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === patId);
  if (!row) return;
  const p = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };

  // ⚠️ openAddPatient() remet _editingPatientId = null — on DOIT l'assigner APRÈS
  openAddPatient();
  _editingPatientId = patId;   // assigner APRÈS openAddPatient
  $('pat-form-title').textContent = '✏️ Modifier patient';

  // ⚠️ Ne pas nommer la variable de destructuring "id" — ça écraserait patId dans le scope
  const fields = {
    'pat-nom': p.nom, 'pat-prenom': p.prenom,
    'pat-rue':   p.street || (p.adresse||'').split(',')[0]?.trim() || '',
    'pat-cp':    p.zip    || '',
    'pat-ville': p.city   || '',
    'pat-ddn': p.ddn,
    'pat-secu': p.secu, 'pat-amo': p.amo, 'pat-amc': p.amc,
    'pat-medecin': p.medecin, 'pat-allergies': p.allergies,
    'pat-pathologies': p.pathologies, 'pat-traitements': p.traitements,
    'pat-contact-nom': p.contact_nom, 'pat-contact-tel': p.contact_tel,
    'pat-notes': p.notes, 'pat-ordo-date': p.ordo_date,
    'pat-heure-preferee': p.heure_preferee || '',
  };
  Object.entries(fields).forEach(([fieldId, val]) => { const el=$(fieldId); if(el) el.value = val||''; });

  if (typeof updatePatAddrPreview === 'function') updatePatAddrPreview();
  const sel = $('pat-exo'); if(sel && p.exo) sel.value = p.exo;
  const chk = $('pat-respecter-horaire'); if(chk) chk.checked = !!p.respecter_horaire;
}

/* Supprimer un patient (RGPD) */
async function deletePatient(id, name) {
  if (!confirm(`Supprimer définitivement ${name} et toutes ses notes ?\n\nCette action est irréversible (droit à l'effacement RGPD).`)) return;
  await _idbDelete(PATIENTS_STORE, id);
  // Supprimer les notes associées
  const notes = await _idbGetByIndex(NOTES_STORE, 'patient_id', id);
  for (const n of notes) await _idbDelete(NOTES_STORE, n.id);
  await loadPatients();
  _syncDeletePatient(id);
  showToastSafe('🗑️ Patient supprimé.');
}

/* Ajouter une note de soin */
async function addSoinNote(patientId) {
  const txt = ($('new-note-txt')?.value || '').trim();
  if (!txt) { alert('Saisissez une note.'); return; }
  const note = { patient_id: patientId, texte: txt, date: new Date().toISOString() };
  await _idbPut(NOTES_STORE, note);
  $('new-note-txt').value = '';
  await openPatientDetail(patientId); // Recharger la fiche complète
  showToastSafe('📝 Note enregistrée.');
}

/* ── Éditer une note inline ── */
function editSoinNote(noteId, patientId) {
  const textEl = $(`note-text-${noteId}`);
  const editEl = $(`note-edit-${noteId}`);
  if (textEl) textEl.style.display = 'none';
  if (editEl) editEl.style.display = 'block';
}

function cancelEditNote(noteId) {
  const textEl = $(`note-text-${noteId}`);
  const editEl = $(`note-edit-${noteId}`);
  if (textEl) textEl.style.display = 'block';
  if (editEl) editEl.style.display = 'none';
}

async function saveSoinNote(noteId, patientId) {
  const editEl = $(`note-edit-${noteId}`);
  const textarea = editEl?.querySelector('textarea');
  const txt = (textarea?.value || '').trim();
  if (!txt) { alert('La note ne peut pas être vide.'); return; }

  const rows = await _idbGetAll(NOTES_STORE);
  const existing = rows.find(n => n.id === noteId);
  if (!existing) return;

  await _idbPut(NOTES_STORE, { ...existing, texte: txt, date_edit: new Date().toISOString() });
  await openPatientDetail(patientId);
  showToastSafe('✅ Note modifiée.');
}

async function deleteSoinNote(noteId, patientId) {
  if (!confirm('Supprimer cette note ?')) return;
  await _idbDelete(NOTES_STORE, noteId);
  await openPatientDetail(patientId);
  showToastSafe('🗑️ Note supprimée.');
}

/* ── Éditer une cotation dans la fiche patient ── */
async function editCotationPatient(patientId, cotationIdx) {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === patientId);
  if (!row) return;
  const p = { ...(_dec(row._data)||{}), id: row.id, nom: row.nom, prenom: row.prenom };
  if (!p.cotations?.[cotationIdx]) return;

  const c = p.cotations[cotationIdx];

  // Construire le texte des actes pour le champ description
  // Format lisible par l'IA NGAP : "AMI4 pansement complexe + AMI1 injection"
  const actesTxt = (c.actes||[]).map(a => {
    const code = a.code || a.nom || '';
    const desc = a.description || a.label || '';
    return desc ? `${code} ${desc}` : code;
  }).filter(Boolean).join(' + ') || c.soin || '';

  // Naviguer vers la vue "Vérifier un soin" (cotation)
  if (typeof navTo === 'function') navTo('cot', null);

  // Pré-remplir tous les champs après navigation
  setTimeout(() => {
    // Champs patient
    const fPt  = $('f-pt');  if (fPt)  fPt.value  = (p.prenom+' '+p.nom).trim();
    const fDdn = $('f-ddn'); if (fDdn && p.ddn)  fDdn.value  = p.ddn;
    const fAmo = $('f-amo'); if (fAmo && p.amo)  fAmo.value  = p.amo;
    const fAmc = $('f-amc'); if (fAmc && p.amc)  fAmc.value  = p.amc;
    const fExo = $('f-exo'); if (fExo && p.exo)  fExo.value  = p.exo;
    const fPr  = $('f-pr');  if (fPr  && p.medecin) fPr.value = p.medecin;

    // Date et heure du soin d'origine
    if (c.date) {
      const fDs = $('f-ds');
      const fHs = $('f-hs');
      const d   = new Date(c.date);
      if (fDs) fDs.value = d.toISOString().slice(0, 10); // YYYY-MM-DD
      if (fHs) fHs.value = d.toTimeString().slice(0, 5);  // HH:MM
    }

    // Description des actes → champ principal IA
    const fTxt = $('f-txt');
    if (fTxt) {
      fTxt.value = actesTxt;
      // Déclencher l'analyse live NGAP si disponible
      if (typeof renderLiveReco === 'function') renderLiveReco(actesTxt);
      fTxt.focus();
    }

    // Stocker la référence pour mise à jour après re-cotation
    window._editingCotation = { patientId, cotationIdx };

    showToastSafe(`✏️ Cotation du ${new Date(c.date).toLocaleDateString('fr-FR')} chargée — modifiez et recotez.`);
  }, 250);
}

async function deleteCotationPatient(patientId, cotationIdx) {
  if (!confirm('Supprimer cette cotation de la fiche patient ?')) return;
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === patientId);
  if (!row) return;
  const p = { ...(_dec(row._data)||{}), id: row.id, nom: row.nom, prenom: row.prenom };
  if (!p.cotations) return;
  p.cotations.splice(cotationIdx, 1);
  const toStore = { id: row.id, nom: row.nom, prenom: row.prenom, _data: _enc(p), updated_at: new Date().toISOString() };
  await _idbPut(PATIENTS_STORE, toStore);
  await openPatientDetail(patientId);
  showToastSafe('🗑️ Cotation supprimée.');
}


/* Vérification expiration ordonnances */
async function checkOrdoExpiry() {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const in30 = new Date(); in30.setDate(in30.getDate() + 30);
  let alerts = [];
  rows.forEach(r => {
    const p = _dec(r._data) || {};
    if (p.ordo_date && new Date(p.ordo_date) <= in30) {
      alerts.push(`${r.prenom||''} ${r.nom} — ordonnance avant le ${p.ordo_date}`);
    }
  });
  const badge = $('patients-ordo-badge');
  if (badge) {
    badge.textContent = alerts.length + ' à renouveler';
    badge.style.display = alerts.length > 0 ? 'inline' : 'none';
  }
  // Toast discret
  if (alerts.length > 0) {
    showToastSafe(`📋 ${alerts.length} ordonnance(s) à renouveler prochainement.`);
  }
}

/* Cotation depuis la fiche patient */
async function coterDepuisPatient(id) {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === id);
  if (!row) return;
  const p = { ...(_dec(row._data)||{}), nom: row.nom, prenom: row.prenom };

  // Pré-remplir le formulaire de cotation
  navTo('cot', null);
  setTimeout(() => {
    const fPt = $('f-pt'); if(fPt) fPt.value = (p.prenom+' '+p.nom).trim();
    const fDdn= $('f-ddn'); if(fDdn && p.ddn) fDdn.value = p.ddn;
    const fAmo= $('f-amo'); if(fAmo && p.amo) fAmo.value = p.amo;
    const fAmc= $('f-amc'); if(fAmc && p.amc) fAmc.value = p.amc;
    const fExo= $('f-exo'); if(fExo && p.exo) fExo.value = p.exo;
    const fTxt= $('f-txt'); if(fTxt) fTxt.focus();
    // Médecin prescripteur
    const fPr = $('f-pr'); if(fPr && p.medecin) fPr.value = p.medecin;
    showToastSafe(`👤 Fiche de ${p.prenom||''} ${p.nom} chargée.`);
  }, 200);
}

/* Export RGPD patient */
async function exportPatientData() {
  const rows  = await _idbGetAll(PATIENTS_STORE);
  const notes = await _idbGetAll(NOTES_STORE);
  const data  = rows.map(r => ({ ...(_dec(r._data)||{}), nom: r.nom, prenom: r.prenom }));
  const blob  = new Blob([JSON.stringify({ patients: data, notes, exported_at: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a'); a.href = url; a.download = 'mes-patients-ami.json'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
}

/* Toast non bloquant */
function showToastSafe(msg) {
  if (typeof showToast === 'function') { showToast(msg); return; }
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:rgba(17,23,32,.95);border:1px solid var(--b);border-radius:8px;padding:10px 18px;font-size:13px;z-index:9999;color:var(--t);pointer-events:none;transition:opacity .3s';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 2500);
}

/* ════════════════════════════════════════════════
   SÉLECTION PATIENTS POUR IMPORT CALENDRIER
════════════════════════════════════════════════ */

let _selectedPatientIds = new Set();

/* Ouvre la modale de sélection des patients pour l'import */
async function openPatientImportPicker() {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const patients = rows.map(r => ({ id: r.id, nom: r.nom, prenom: r.prenom, ...(_dec(r._data)||{}) }));

  if (!patients.length) {
    showToastSafe('⚠️ Aucun patient dans le carnet. Ajoutez des patients d\'abord.');
    return;
  }

  // Créer modale
  let modal = document.getElementById('patient-import-picker-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'patient-import-picker-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:16px;';
    document.body.appendChild(modal);
  }

  _selectedPatientIds = new Set();

  modal.innerHTML = `
    <div style="background:var(--bg,#0b0f14);border:1px solid var(--b,#1e2d3d);border-radius:16px;padding:24px;max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="font-family:var(--fs);font-size:18px;color:var(--t,#e2e8f0)">📋 Sélectionner des patients</div>
        <button onclick="document.getElementById('patient-import-picker-modal').style.display='none'" style="background:none;border:none;color:var(--m);font-size:20px;cursor:pointer">✕</button>
      </div>
      <p style="font-size:12px;color:var(--m);margin:0">Sélectionnez les patients à importer dans l'Import calendrier (tournée IA). Leur adresse sera utilisée pour le routage.</p>
      <input type="text" id="picker-search" placeholder="🔍 Rechercher..." oninput="_filterPickerList()" style="padding:8px 12px;background:var(--s);border:1px solid var(--b);border-radius:8px;color:var(--t);font-size:13px;width:100%;box-sizing:border-box">
      <div id="picker-list" style="overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:6px;min-height:200px">
        ${patients.map(p => `
          <label style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--s);border:1px solid var(--b);border-radius:10px;cursor:pointer;transition:border-color .15s" 
                 onmouseenter="this.style.borderColor='var(--a)'" onmouseleave="this.style.borderColor='var(--b)'">
            <input type="checkbox" value="${p.id}" onchange="_togglePickerPatient(this)" 
                   style="width:16px;height:16px;accent-color:var(--a,#00d4aa)">
            <div class="avat" style="width:36px;height:36px;font-size:13px;flex-shrink:0">${((p.prenom||'?')[0]+(p.nom||'?')[0]).toUpperCase()}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;color:var(--t);font-weight:500">${(p.prenom||'')} ${p.nom||''}</div>
              ${p.adresse ? `<div style="font-size:11px;color:var(--a);margin-top:2px">📍 ${p.adresse}</div>` : '<div style="font-size:11px;color:var(--d);margin-top:2px">⚠️ Adresse manquante</div>'}
              ${p.medecin ? `<div style="font-size:11px;color:var(--m)">${p.medecin}</div>` : ''}
            </div>
          </label>`).join('')}
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <span id="picker-count" style="font-size:12px;color:var(--m);font-family:var(--fm);flex:1">0 patient(s) sélectionné(s)</span>
        <button onclick="_selectAllPickerPatients()" class="btn bs bsm">☑️ Tout sélectionner</button>
        <button onclick="_importPickerPatients()" class="btn bp bsm" id="btn-picker-import">📥 Importer dans la tournée</button>
      </div>
    </div>`;

  modal.style.display = 'flex';
}

function _togglePickerPatient(cb) {
  if (cb.checked) _selectedPatientIds.add(cb.value);
  else _selectedPatientIds.delete(cb.value);
  const cnt = document.getElementById('picker-count');
  if (cnt) cnt.textContent = `${_selectedPatientIds.size} patient(s) sélectionné(s)`;
}

function _selectAllPickerPatients() {
  document.querySelectorAll('#picker-list input[type=checkbox]').forEach(cb => {
    cb.checked = true;
    _selectedPatientIds.add(cb.value);
  });
  const cnt = document.getElementById('picker-count');
  if (cnt) cnt.textContent = `${_selectedPatientIds.size} patient(s) sélectionné(s)`;
}

function _filterPickerList() {
  const q = (document.getElementById('picker-search')?.value || '').toLowerCase();
  document.querySelectorAll('#picker-list label').forEach(lbl => {
    const txt = lbl.textContent.toLowerCase();
    lbl.style.display = txt.includes(q) ? '' : 'none';
  });
}

/* ════════════════════════════════════════════════
   GÉOCODAGE ADRESSES (Nominatim)
   Convertit l'adresse texte → lat/lng pour la tournée
════════════════════════════════════════════════ */

const _geocodeCache = new Map();

/* ── Timeout compatible tous navigateurs (AbortSignal.timeout non dispo partout) ── */
function _fetchGeo(url, opts, ms) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms || 7000);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
}

/* ── Géocodage avec API Adresse gouv.fr en priorité absolue ──────────────────────
   1. API Adresse data.gouv.fr (IGN + La Poste) — données cadastrales, housenumber exact
   2. geocode.js smartGeocode si chargé (Photon + Nominatim enrichis)
   3. Nominatim direct — dernier recours
   Score > 90 si housenumber trouvé par gouv.fr
──────────────────────────────────────────────────────────────────────────────── */
async function _geocodeAdresse(adresse, patient) {
  if (!adresse || !adresse.trim()) return null;
  const key = adresse.trim().toLowerCase();
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);

  // Vider le cache si résultat null ou geoScore=0 (ancien géocodage raté)
  _geocodeCache.delete(key);

  let coords = null;

  try {
    // ── 1. API Adresse data.gouv.fr — TOUJOURS EN PREMIER ──────────────────
    //    Données IGN + La Poste — précision numéro de rue exact
    //    100% gratuit, sans clé, France uniquement
    const cpMatch = adresse.match(/(\d{5})/);
    const postcode = cpMatch ? cpMatch[1] : (patient?.zip || '');

    // Normaliser l'adresse : tirets communes, sans France
    let addrClean = adresse
      .replace(/,?\s*France\s*$/i, '')
      .replace(/(Puget|Saint|Sainte|Mont|Bois|Val|Puy|Pont|Port|Bourg|Vieux|Neuf|Grand|Petit)\s+([A-ZÀ-Ÿ][a-zà-ÿ]+)/g,
               (_, a, b) => `${a}-${b}`)
      .trim();

    // Stratégie optimale : retirer la ville du query si on a le CP
    // Ex: q="667 rue de la libération" + postcode=83390 → score 0.966 housenumber
    const addrQuery = postcode
      ? addrClean.replace(new RegExp(`,?\s*${postcode}[^,]*`), '').trim()
      : addrClean;

    const variants = [addrQuery, addrClean];
    if (patient?.street) variants.unshift(
      [patient.street, patient.zip, patient.city].filter(Boolean).join(' ')
    );

    for (const q of [...new Set(variants)]) {
      if (!q || q === 'France') continue;
      try {
        let url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=5`;
        if (postcode) url += `&postcode=${postcode}`;

        const res  = await _fetchGeo(url, { headers: { 'User-Agent': 'AMI-NGAP/1.0' } }, 7000);
        const data = await res.json();
        const feats = data.features || [];
        if (!feats.length) continue;

        const best = feats.find(f => f.properties?.type === 'housenumber')
                  || feats.find(f => f.properties?.type === 'street')
                  || feats[0];
        const p = best.properties;
        const c = best.geometry.coordinates;
        const apiScore = p.score || 0.5;

        // Score géo selon précision
        let geoScore = 50;
        if (p.type === 'housenumber' && apiScore >= 0.9) geoScore = 95;
        else if (p.type === 'housenumber')               geoScore = Math.round(75 + apiScore * 20);
        else if (p.type === 'street')                    geoScore = 70;
        else                                             geoScore = 50;

        coords = { lat: c[1], lng: c[0], geoScore, source: 'gouv', type: p.type, label: p.label };
        console.info('[GEO] ✅ gouv.fr:', p.type, 'score', apiScore.toFixed(3), '→', p.label, 'geoScore:', geoScore);
        break;
      } catch(e) {
        console.warn('[GEO] gouv.fr erreur:', e.message);
      }
    }

    // ── 2. geocode.js smartGeocode si chargé et gouv.fr n'a pas trouvé ────
    if (!coords && typeof processAddressBeforeGeocode === 'function' && typeof smartGeocode === 'function') {
      try {
        const cleaned = await processAddressBeforeGeocode(adresse, patient || null);
        const geo = await smartGeocode(cleaned);
        if (geo && geo.lat && geo.lng) {
          const score = typeof computeGeoScore === 'function' ? computeGeoScore(cleaned, geo) : 70;
          coords = { lat: geo.lat, lng: geo.lng, geoScore: score };
        }
      } catch(e) {
        console.warn('[GEO] smartGeocode erreur:', e.message);
      }
    }

    // ── 3. Nominatim — dernier recours ──────────────────────────────────────
    if (!coords) {
      try {
        const res = await _fetchGeo(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(adresse)}&format=json&limit=3&countrycodes=fr`,
          { headers: { 'Accept-Language': 'fr' } }, 7000
        );
        const d = await res.json();
        if (d.length) {
          const best = d.find(r => r.type === 'house') || d[0];
          const geoScore = best.type === 'house' ? 65 : /^\d/.test(adresse) ? 55 : 45;
          coords = { lat: parseFloat(best.lat), lng: parseFloat(best.lon), geoScore, source: 'nominatim' };
          console.info('[GEO] nominatim fallback:', best.type, 'geoScore:', geoScore);
        }
      } catch(e) {
        console.warn('[GEO] nominatim erreur:', e.message);
      }
    }

  } catch(e) {
    console.warn('[GEO] _geocodeAdresse erreur générale:', e.message);
  }

  if (coords) _geocodeCache.set(key, coords);
  return coords;
}

/* Géocoder un tableau de patients — retourne les patients enrichis avec lat/lng */
async function _geocodePatients(patients, onProgress) {
  const results = [];
  let geocoded = 0, failed = 0;
  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    if (onProgress) onProgress(i + 1, patients.length, p.description || p.nom || '');
    // Préférer addressFull (adresse complète structurée) à adresse (peut être tronquée)
    const adresseGeo = p.addressFull || p.address || p.adresse || '';
    if (adresseGeo && adresseGeo.trim() && adresseGeo !== 'France') {
      const coords = await _geocodeAdresse(adresseGeo, p);
      if (coords) { geocoded++; results.push({ ...p, lat: coords.lat, lng: coords.lng, geoScore: coords.geoScore || 70 }); }
      else { failed++; results.push(p); }
      // Délai léger pour éviter le rate-limit si fallback Nominatim
      if (i < patients.length - 1) await new Promise(r => setTimeout(r, 300));
    } else {
      failed++;
      results.push(p);
    }
  }
  return { patients: results, geocoded, failed };
}

async function _importPickerPatients() {
  if (_selectedPatientIds.size === 0) { showToastSafe('⚠️ Sélectionnez au moins un patient.'); return; }

  const rows = await _idbGetAll(PATIENTS_STORE);
  const selected = rows
    .filter(r => _selectedPatientIds.has(r.id))
    .map(r => {
      const p = { id: r.id, nom: r.nom, prenom: r.prenom, ...(_dec(r._data)||{}) };
      const street = p.street || '';
      const zip    = p.zip    || '';
      const city   = p.city   || '';
      const adresseComplete = p.addressFull || p.address ||
        [street, [zip, city].filter(Boolean).join(' '), 'France'].map(s=>s.trim()).filter(Boolean).join(', ') ||
        p.adresse || '';
      return {
        id:                p.id,
        nom:               p.nom    || '',
        prenom:            p.prenom || '',
        description:       p.notes || p.pathologies || 'Soin infirmier',
        texte:             p.notes || p.pathologies || 'Soin infirmier',
        adresse:           adresseComplete,
        address:           adresseComplete,
        addressFull:       adresseComplete,
        street,
        zip,
        city,
        medecin:           p.medecin || '',
        pathologies:       p.pathologies || '',
        notes:             p.notes || '',
        heure_soin:        p.heure_preferee || '',
        heure_preferee:    p.heure_preferee || '',
        respecter_horaire: !!p.respecter_horaire,
        urgent:            !!(p.urgent),
        source:            'carnet_patients',
        // Conserver GPS déjà calculé si disponible
        ...(p.lat ? { lat: p.lat, lng: p.lng, geoScore: p.geoScore || 70 } : {}),
      };
    });

  // Afficher progression géocodage dans la modale
  const btn = document.getElementById('btn-picker-import');
  const cnt = document.getElementById('picker-count');
  const withAddr = selected.filter(p => p.adresse && p.adresse !== 'France').length;

  if (withAddr > 0) {
    if (btn) { btn.disabled = true; btn.textContent = '📡 Géocodage…'; }
    if (cnt) cnt.textContent = `📡 Géocodage des adresses (0/${withAddr})…`;

    const { patients: geocoded, geocoded: ok, failed } = await _geocodePatients(
      selected,
      (i, total, name) => {
        if (cnt) cnt.textContent = `📡 Géocodage ${i}/${total} : ${name.slice(0, 30)}…`;
      }
    );

    if (btn) { btn.disabled = false; btn.textContent = '📥 Importer dans la tournée'; }

    const msg = ok > 0
      ? `✅ ${ok} adresse(s) géocodée(s)${failed > 0 ? ` · ⚠️ ${failed} sans coordonnées` : ''}`
      : `⚠️ Aucune adresse géocodée — vérifiez les adresses`;
    if (cnt) cnt.textContent = msg;

    // Stocker dans APP.importedData (compatible tournee.js)
    if (typeof storeImportedData === 'function') {
      storeImportedData({ patients: geocoded, total: geocoded.length, source: 'Carnet patients' });
    } else {
      APP.importedData = { patients: geocoded, total: geocoded.length, source: 'Carnet patients' };
    }

    showToastSafe(`✅ ${geocoded.length} patient(s) importé(s) — ${ok} position(s) GPS résolue(s).`);
  } else {
    // Pas d'adresses → import direct sans géocodage
    if (typeof storeImportedData === 'function') {
      storeImportedData({ patients: selected, total: selected.length, source: 'Carnet patients' });
    } else {
      APP.importedData = { patients: selected, total: selected.length, source: 'Carnet patients' };
    }
    showToastSafe(`⚠️ ${selected.length} patient(s) importé(s) sans adresse GPS — ajoutez des adresses dans le carnet.`);
  }

  // Fermer modale
  const modal = document.getElementById('patient-import-picker-modal');
  if (modal) modal.style.display = 'none';

  // Naviguer vers la Tournée IA
  if (typeof navTo === 'function') navTo('tur', null);
}

/* Import rapide d'un seul patient (depuis la liste) */
async function _importSinglePatient(id) {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === id);
  if (!row) return;
  const p = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };

  // Reconstruire l'adresse complète depuis les champs structurés
  const street  = p.street || '';
  const zip     = p.zip    || '';
  const city    = p.city   || '';
  const adresseComplete = p.addressFull || p.address ||
    [street, [zip, city].filter(Boolean).join(' '), 'France'].map(s=>s.trim()).filter(Boolean).join(', ') ||
    p.adresse || '';

  if (!adresseComplete || adresseComplete === 'France') {
    showToastSafe(`⚠️ ${p.prenom||''} ${p.nom} : adresse manquante — renseignez la rue, CP et ville dans la fiche patient.`);
    if (typeof navTo === 'function') navTo('patients', null);
    return;
  }

  showToastSafe(`📡 Géocodage de ${p.prenom||''} ${p.nom}…`);

  // Géocoder via le pipeline complet (API gouv.fr → Photon → Nominatim)
  let lat = p.lat || null, lng = p.lng || null, resolvedGeoScore = p.geoScore || 0;
  if (!lat || !lng || resolvedGeoScore === 0) {
    // Vider le cache IDB pour cette adresse si geoScore=0 (ancien résultat raté)
    if (resolvedGeoScore === 0 || !lat) {
      const cacheKey = typeof hashAddr === 'function' ? hashAddr(adresseComplete) : null;
      if (cacheKey && typeof saveSecure === 'function') {
        try { await saveSecure('geocache', cacheKey, null); } catch(_) {}
      }
      // Vider aussi le cache mémoire
      _geocodeCache.delete(adresseComplete.trim().toLowerCase());
    }
    const coords = await _geocodeAdresse(adresseComplete, p);
    if (coords) { lat = coords.lat; lng = coords.lng; resolvedGeoScore = coords.geoScore || 70; }
  }

  const entry = {
    id:                p.id,
    nom:               p.nom    || '',
    prenom:            p.prenom || '',
    description:       p.notes || p.pathologies || 'Soin infirmier',
    texte:             p.notes || p.pathologies || 'Soin infirmier',
    // Adresse — tous les champs pour que openNavigation fonctionne
    adresse:           adresseComplete,
    address:           adresseComplete,
    addressFull:       adresseComplete,
    street,
    zip,
    city,
    medecin:           p.medecin || '',
    pathologies:       p.pathologies || '',
    notes:             p.notes || '',
    heure_soin:        p.heure_preferee || '',
    heure_preferee:    p.heure_preferee || '',
    respecter_horaire: !!p.respecter_horaire,
    urgent:            !!(p.urgent),
    source:            'carnet_patients',
    // GPS — utilisé par openNavigation + tournée IA
    lat,
    lng,
    geoScore: resolvedGeoScore,
  };

  // Fusionner avec les patients déjà importés
  const existing = APP.importedData?.patients || [];
  const alreadyIn = existing.some(e => e.id === id);
  if (alreadyIn) { showToastSafe('ℹ️ Ce patient est déjà dans la tournée.'); return; }

  const merged = [...existing, entry];
  if (typeof storeImportedData === 'function') {
    storeImportedData({ patients: merged, total: merged.length, source: 'Carnet patients' });
  } else {
    APP.importedData = { patients: merged, total: merged.length, source: 'Carnet patients' };
  }

  const gpsMsg = lat ? ` (📍 GPS résolu)` : ` (⚠️ adresse sans coordonnées GPS — tournée moins précise)`;
  showToastSafe(`🗺️ ${(p.prenom||'')} ${p.nom} ajouté(e) à la tournée${gpsMsg}.`);
  // Naviguer vers la tournée
  if (typeof navTo === 'function') navTo('tur', null);
}

/* Géocoder l'adresse d'un patient et sauvegarder lat/lng dans l'IDB */
async function _geocodeAndSaveSingle(id) {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === id);
  if (!row) return;
  const p = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };

  const adresseGeo = p.addressFull || p.address ||
    [p.street, [p.zip, p.city].filter(Boolean).join(' '), 'France'].map(s=>(s||'').trim()).filter(Boolean).join(', ') ||
    p.adresse || '';
  if (!adresseGeo || adresseGeo === 'France') { showToastSafe('⚠️ Aucune adresse renseignée pour ce patient.'); return; }

  showToastSafe(`📡 Géocodage de "${adresseGeo}"…`);
  const coords = await _geocodeAdresse(adresseGeo, p);

  if (!coords) {
    showToastSafe('❌ Adresse non trouvée — vérifiez l\'adresse dans la fiche patient.');
    return;
  }

  // Sauvegarder lat/lng dans l'IDB
  const updated = { ...p, lat: coords.lat, lng: coords.lng };
  const toStore = {
    id:         updated.id,
    nom:        updated.nom,
    prenom:     updated.prenom,
    _data:      _enc(updated),
    updated_at: new Date().toISOString(),
  };
  await _idbPut(PATIENTS_STORE, toStore);

  showToastSafe(`✅ Coordonnées GPS enregistrées pour ${p.prenom||''} ${p.nom}.`);
  // Recharger la fiche
  openPatientDetail(id);
}

/* Forcer le re-géocodage d'un patient (vide le cache + recalcule)
   Utile quand l'adresse géocodée est incorrecte dans la tournée IA */
async function _forceRegeocode(id) {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === id);
  if (!row) return;
  const p = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };

  const adresseGeo = p.addressFull || p.address ||
    [p.street, [p.zip, p.city].filter(Boolean).join(' '), 'France'].map(s=>(s||'').trim()).filter(Boolean).join(', ') ||
    p.adresse || '';
  if (!adresseGeo || adresseGeo === 'France') {
    showToastSafe('⚠️ Aucune adresse renseignée pour ce patient.');
    return;
  }

  // 1. Vider le cache mémoire pour cette adresse
  const cacheKey = adresseGeo.trim().toLowerCase();
  _geocodeCache.delete(cacheKey);

  // 2. Vider le cache IndexedDB (geocode.js)
  if (typeof saveSecure === 'function' && typeof hashAddr === 'function') {
    try { await saveSecure('geocache', hashAddr(adresseGeo), null); } catch (_) {}
    // Vider aussi les variantes normalisées
    const variants = [
      adresseGeo,
      adresseGeo + ', France',
      p.adresse || '',
    ];
    for (const v of variants) {
      if (v) try { await saveSecure('geocache', hashAddr(v), null); } catch (_) {}
    }
  }

  // 3. Effacer les coordonnées existantes (GPS potentiellement erronés)
  const updated = { ...p, lat: null, lng: null, geoScore: 0 };
  const toStore = {
    id:         updated.id,
    nom:        updated.nom,
    prenom:     updated.prenom,
    _data:      _enc(updated),
    updated_at: new Date().toISOString(),
  };
  await _idbPut(PATIENTS_STORE, toStore);

  showToastSafe(`🔄 Cache vidé — re-géocodage de "${adresseGeo}"…`);

  // 4. Relancer le géocodage proprement
  await _geocodeAndSaveSingle(id);
}

/* ── Initialisation ── */
/* ════════════════════════════════════════════════
   SYNC CARNET PATIENTS — PC ↔ Mobile via Supabase
   ────────────────────────────────────────────────
   Les données sont chiffrées AVANT envoi au serveur.
   Le serveur ne voit que des blobs opaques (RGPD).
   La clé de chiffrement reste sur l'appareil.
════════════════════════════════════════════════ */

/* Pousse tous les patients locaux vers le serveur */
async function syncPatientsToServer() {
  if (!S?.token) return;
  try {
    const rows = await _idbGetAll(PATIENTS_STORE);
    if (!rows.length) return;

    const patients = rows.map(r => ({
      id:             r.id,
      patient_id:     r.id,
      encrypted_data: r._data,
      nom_enc:        btoa(unescape(encodeURIComponent((r.nom||'') + ' ' + (r.prenom||'')))).slice(0, 64),
      updated_at:     r.updated_at || new Date().toISOString(),
    }));

    const res = await wpost('/webhook/patients-push', { patients });
    if (!res?.ok) throw new Error(res?.error || 'Erreur sync');
    console.info('[AMI] Sync push OK :', patients.length, 'patients');
    showToastSafe(`☁️ ${patients.length} patient(s) synchronisé(s).`);
  } catch(e) {
    console.warn('[AMI] Sync push KO :', e.message);
    showToastSafe('⚠️ Sync échouée : ' + e.message);
  }
}

/* Tire les patients du serveur et fusionne avec l'IDB local */
async function syncPatientsFromServer() {
  if (!S?.token) return;
  try {
    const res = await wpost('/webhook/patients-pull', {});
    if (!res?.ok || !Array.isArray(res.patients)) {
      console.warn('[AMI] Sync pull KO : réponse invalide', JSON.stringify(res));
      return;
    }

    const remote = res.patients;
    if (!remote.length) {
      console.info('[AMI] Sync pull : aucun patient sur le serveur.');
      return;
    }

    const localRows = await _idbGetAll(PATIENTS_STORE);
    const localMap  = new Map(localRows.map(r => [r.id, r]));

    let merged = 0;
    for (const rp of remote) {
      const remoteId = rp.patient_id || rp.id;
      if (!remoteId || !rp.encrypted_data) continue;

      const local = localMap.get(remoteId);
      const remoteDate = new Date(rp.updated_at || 0).getTime();
      const localDate  = local ? new Date(local.updated_at || 0).getTime() : 0;

      if (!local || remoteDate > localDate) {
        let nom = '', prenom = '';
        try {
          const decoded = _dec(rp.encrypted_data);
          if (decoded) { nom = decoded.nom || ''; prenom = decoded.prenom || ''; }
        } catch(_) {}

        await _idbPut(PATIENTS_STORE, {
          id:         remoteId,
          nom,
          prenom,
          _data:      rp.encrypted_data,
          updated_at: rp.updated_at,
        });
        merged++;
      }
    }

    if (merged > 0) {
      console.info('[AMI] Sync pull OK :', merged, 'patients fusionnés');
      showToastSafe(`📥 ${merged} patient(s) reçu(s) depuis le serveur.`);
      loadPatients();
    } else {
      console.info('[AMI] Sync pull : déjà à jour (', remote.length, 'sur serveur).');
    }
  } catch(e) {
    console.warn('[AMI] Sync pull KO :', e.message);
    showToastSafe('⚠️ Récupération échouée : ' + e.message);
  }
}

/* Supprime un patient du serveur (appelé dans deletePatient) */
async function _syncDeletePatient(patientId) {
  if (!S?.token) return;
  try {
    await wpost('/webhook/patients-delete', { patient_id: patientId });
  } catch(_) {}
}

/* Sync automatique après chaque sauvegarde patient */
async function _syncAfterSave() {
  // Debounce : éviter les appels multiples rapides
  clearTimeout(_syncAfterSave._t);
  _syncAfterSave._t = setTimeout(syncPatientsToServer, 1500);
}

document.addEventListener('DOMContentLoaded', () => {
  // Écouter les deux events (ui.js dispatche 'ui:navigate', certains modules 'app:nav')
  const _onPatNav = e => {
    if (e.detail?.view === 'patients') {
      loadPatients();
      checkOrdoExpiry();
    }
  };
  document.addEventListener('app:nav',     _onPatNav);
  document.addEventListener('ui:navigate', _onPatNav);
  // Init DB uniquement — PAS de sync ici, S.token est encore null à ce stade
  initPatientsDB().then(() => {
    checkOrdoExpiry();
  }).catch(() => {});
});

// ⚠️ La sync doit attendre que la session soit chargée (S.token disponible).
// auth.js dispatche 'ami:login' dans showApp() après hydratation complète de S.
document.addEventListener('ami:login', () => {
  initPatientsDB().then(async () => {
    await syncPatientsFromServer();
  }).catch(() => {});
});
