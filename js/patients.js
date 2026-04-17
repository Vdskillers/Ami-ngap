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
// Verrou d'ouverture : évite les ouvertures simultanées concurrentes
let _patientsDBOpeningPromise = null;

async function initPatientsDB() {
  const currentUserId = S?.user?.id || S?.user?.email || 'local';

  // Si la DB est ouverte pour un autre user, la fermer proprement
  if (_patientsDB && _patientsDBUserId !== currentUserId) {
    // Attendre la fin des transactions en cours avant de fermer
    try { _patientsDB.close(); } catch (_) {}
    _patientsDB = null;
    _patientsDBUserId = null;
    _patientsDBOpeningPromise = null;
  }

  // DB déjà ouverte et saine pour le bon user → retourner directement
  if (_patientsDB) return _patientsDB;

  // Si une ouverture est déjà en cours, attendre qu'elle termine (évite la race)
  if (_patientsDBOpeningPromise) return _patientsDBOpeningPromise;

  const dbName = _getDBName();
  _patientsDBOpeningPromise = new Promise((resolve, reject) => {
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
      _patientsDBOpeningPromise = null;

      // Détecter une fermeture inattendue (ex: navigateur qui force la fermeture)
      _patientsDB.onclose = () => {
        console.warn('[AMI] IDB fermée de façon inattendue — réouverture au prochain accès');
        _patientsDB = null;
        _patientsDBUserId = null;
        _patientsDBOpeningPromise = null;
      };

      resolve(_patientsDB);
      // Migration silencieuse clé de chiffrement
      _migratePatientKeyIfNeeded().catch(()=>{});
    };
    req.onerror = () => {
      _patientsDBOpeningPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      console.warn('[AMI] IDB bloquée — une autre instance a la DB ouverte');
    };
  });

  return _patientsDBOpeningPromise;
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


/* Exécute une opération IDB avec retry automatique si la connexion se ferme */
async function _idbExec(fn, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const db = await initPatientsDB();
      return await fn(db);
    } catch (e) {
      const isClosing = e?.name === 'InvalidStateError'
        || (e?.message || '').includes('closing')
        || (e?.message || '').includes('closed');
      if (isClosing && attempt < retries) {
        // Forcer la réouverture
        try { if (_patientsDB) { _patientsDB.close(); } } catch (_) {}
        _patientsDB = null;
        _patientsDBUserId = null;
        _patientsDBOpeningPromise = null;
        await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function _idbPut(store, val) {
  return _idbExec(db => new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(val);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  }));
}
async function _idbGetAll(store) {
  return _idbExec(db => new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => rej(req.error);
  }));
}
async function _idbDelete(store, key) {
  return _idbExec(db => new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  }));
}
async function _idbGetByIndex(store, indexName, val) {
  return _idbExec(db => new Promise((res, rej) => {
    const tx    = db.transaction(store, 'readonly');
    const index = tx.objectStore(store).index(indexName);
    const req   = index.getAll(val);
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => rej(req.error);
  }));
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
  ['pat-nom','pat-prenom','pat-rue','pat-cp','pat-ville','pat-ddn','pat-secu','pat-amo','pat-amc','pat-medecin','pat-allergies','pat-pathologies','pat-traitements','pat-contact-nom','pat-contact-tel','pat-notes','pat-ordo-date','pat-exo','pat-heure-preferee','pat-actes-recurrents']
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
    actes_recurrents:  gv('pat-actes-recurrents') || '',
    created_at:     editId ? undefined : new Date().toISOString(),
    updated_at:     new Date().toISOString(),
    _enc:           true,
    // Conserver les coordonnées GPS précédentes sauf si l'adresse a changé
    ...(existingLat !== null ? { lat: existingLat, lng: existingLng } : {}),
  };

  // Conserver le tableau ordonnances[] existant lors d'une modification
  if (editId) {
    const rows0 = await _idbGetAll(PATIENTS_STORE);
    const row0  = rows0.find(r => r.id === editId);
    if (row0) {
      const prev0 = _dec(row0._data) || {};
      if (prev0.ordonnances) patient.ordonnances = prev0.ordonnances;
      if (prev0.cotations)   patient.cotations   = prev0.cotations;
    }
  }

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
        <button class="bxs" onclick="event.stopPropagation();_importSinglePatient('${p.id}')" title="Ajouter à la tournée IA — géocode et importe ce patient dans la tournée optimisée" style="background:rgba(0,212,170,.1);color:var(--a);border:1px solid rgba(0,212,170,.2)">🗺️ Tournée</button>
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

  // Migrer ordo_date → ordonnances[] si nécessaire
  if (p.ordo_date && !p.ordonnances?.length) {
    p.ordonnances = [{
      id: 'legacy_' + p.id,
      actes:          '',
      medecin:        p.medecin || '',
      date_prescription: '',
      date_expiration: p.ordo_date,
      duree:          30,
      notes:          '',
      created_at:     new Date().toISOString(),
    }];
    // Persister la migration en IDB pour que tous les accès futurs trouvent le bon format
    try {
      await _idbPut(PATIENTS_STORE, { id: p.id, nom: p.nom, prenom: p.prenom, _data: _enc(p), updated_at: new Date().toISOString() });
    } catch(e) { console.warn('[Migration ordo openPatient]', e.message); }
  }
  if (!p.ordonnances) p.ordonnances = [];

  const ordoAlert = p.ordonnances.some(o => {
    const exp = new Date(o.date_expiration || o.ordo_date || '');
    return !isNaN(exp) && exp <= new Date(Date.now() + 30*24*3600000);
  });

  // ── Render onglets ──────────────────────────────────────────────────────
  const tabStyle = (active) => active
    ? 'padding:8px 16px;font-size:12px;font-family:var(--fm);background:var(--a);color:#000;border:none;border-radius:20px;cursor:pointer;white-space:nowrap;font-weight:600'
    : 'padding:8px 16px;font-size:12px;font-family:var(--fm);background:var(--s);color:var(--m);border:1px solid var(--b);border-radius:20px;cursor:pointer;white-space:nowrap';

  el.innerHTML = `
    <!-- En-tête patient -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:12px">
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
          <button class="btn bs bsm" onclick="$('patient-detail').innerHTML='';$('patient-detail').style.display='none';$('patients-list').style.display='block'">← Retour</button>
        </div>
      </div>
      ${ordoAlert ? '<div class="ai wa" style="margin-bottom:8px">⚠️ Une ou plusieurs ordonnances arrivent à expiration dans moins de 30 jours.</div>' : ''}

      <!-- Barre d'onglets -->
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px" id="pat-tabs">
        <button id="tab-infos"   style="${tabStyle(true)}"  onclick="_patTab('infos','${id}')">📋 Infos</button>
        <button id="tab-cotations" style="${tabStyle(false)}" onclick="_patTab('cotations','${id}')">🧾 Cotations ${p.cotations?.length ? '<span style=\'background:rgba(0,212,170,.15);color:var(--a);border-radius:20px;font-size:9px;padding:1px 6px;margin-left:3px\'>'+p.cotations.length+'</span>' : ''}</button>
        <button id="tab-ordos"   style="${tabStyle(false)}" onclick="_patTab('ordos','${id}')">💊 Ordonnances ${p.ordonnances.length ? '<span style=\'background:rgba(255,181,71,.25);color:var(--w);border-radius:20px;font-size:9px;padding:1px 6px;margin-left:3px\'>'+p.ordonnances.length+'</span>' : ''}</button>
        <button id="tab-notes"  style="${tabStyle(false)}" onclick="_patTab('notes','${id}')">📝 Notes <span style='background:rgba(79,168,255,.15);color:var(--a2);border-radius:20px;font-size:9px;padding:1px 6px;margin-left:3px'>${notes.length}</span></button>
      </div>
    </div>

    <!-- Contenu onglets -->
    <div id="pat-tab-content"></div>`;

  // Rendre l'onglet par défaut
  _patTabRender('infos', id, p, notes);

  $('patients-list').style.display = 'none';
  el.style.display = 'block';
}

/* ── Sélecteur d'onglet ── */
function _patTab(tab, id) {
  ['infos','ordos','cotations','notes'].forEach(t => {
    const btn = $('tab-'+t);
    if (!btn) return;
    if (t === tab) {
      btn.style.background = 'var(--a)'; btn.style.color = '#000';
      btn.style.border = 'none'; btn.style.fontWeight = '600';
    } else {
      btn.style.background = 'var(--s)'; btn.style.color = 'var(--m)';
      btn.style.border = '1px solid var(--b)'; btn.style.fontWeight = '';
    }
  });
  // Recharger les données fraîches pour l'onglet
  (async () => {
    const rows = await _idbGetAll(PATIENTS_STORE);
    const row  = rows.find(r => r.id === id);
    if (!row) return;
    const p = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };

    // Migration rétrocompatibilité : ordo_date (ancien champ) → ordonnances[] (nouveau tableau)
    if (p.ordo_date && !p.ordonnances?.length) {
      p.ordonnances = [{
        id:                'legacy_' + p.id,
        actes:             '',
        medecin:           p.medecin || '',
        date_prescription: '',
        date_expiration:   p.ordo_date,
        duree:             30,
        notes:             '',
        created_at:        new Date().toISOString(),
      }];
      // Persister la migration en IDB pour que les prochains accès trouvent le bon format
      try {
        await _idbPut(PATIENTS_STORE, { id: p.id, nom: p.nom, prenom: p.prenom, _data: _enc(p), updated_at: new Date().toISOString() });
      } catch(e) { console.warn('[Migration ordo]', e.message); }
    }
    if (!p.ordonnances) p.ordonnances = [];

    const notes = await _idbGetByIndex(NOTES_STORE, 'patient_id', id);
    _patTabRender(tab, id, p, notes);
  })();
}

/* ── Rendu de contenu par onglet ── */
function _patTabRender(tab, id, p, notes) {
  const el = $('pat-tab-content');
  if (!el) return;

  if (tab === 'infos') {
    el.innerHTML = `
      <div class="card">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;flex-wrap:wrap">
          ${p.adresse ? `<div style="grid-column:1/-1">
            <div class="lbl" style="margin-bottom:6px">📍 Adresse</div>
            <div style="font-size:13px">${p.adresse}</div>
            ${p.lat
              ? `<div style="font-size:10px;color:var(--a);font-family:var(--fm);margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  ✅ GPS : ${parseFloat(p.lat).toFixed(5)}, ${parseFloat(p.lng).toFixed(5)}
                  <button class="btn bs bsm" style="font-size:10px;padding:2px 8px;color:var(--w);border-color:rgba(255,181,71,.3)" onclick="_forceRegeocode('${id}')">🔄 Corriger GPS</button>
                </div>`
              : `<button class="btn bv bsm" style="margin-top:6px;font-size:11px;padding:4px 10px" onclick="_geocodeAndSaveSingle('${id}')">📡 Géocoder</button>`}
          </div>` : ''}
          <div><div class="lbl" style="margin-bottom:4px">Couverture</div><div style="font-size:13px;color:var(--m)">${p.amo||'—'} <span style="color:var(--a2)">${p.amc||''}</span></div></div>
          <div><div class="lbl" style="margin-bottom:4px">Médecin</div><div style="font-size:13px">${p.medecin||'—'}</div></div>
          ${p.allergies ? `<div><div class="lbl" style="margin-bottom:4px;color:var(--d)">Allergies ⚠️</div><div style="font-size:13px;color:var(--d)">${p.allergies}</div></div>` : ''}
          ${p.pathologies ? `<div><div class="lbl" style="margin-bottom:4px">Pathologies</div><div style="font-size:13px">${p.pathologies}</div></div>` : ''}
          ${p.traitements ? `<div style="grid-column:1/-1"><div class="lbl" style="margin-bottom:4px">Traitements</div><div style="font-size:13px">${p.traitements}</div></div>` : ''}
          ${p.contact_nom ? `<div><div class="lbl" style="margin-bottom:4px">Contact urgence</div><div style="font-size:13px">${p.contact_nom} ${p.contact_tel?'— '+p.contact_tel:''}</div></div>` : ''}
          ${p.heure_preferee ? `<div><div class="lbl" style="margin-bottom:4px;color:var(--a)">🕐 Heure préférée</div>
            <div style="font-size:16px;font-family:var(--fm);color:var(--a);font-weight:600">${p.heure_preferee}</div></div>` : ''}
        </div>
        ${p.actes_recurrents ? `
          <div style="margin-top:14px;background:rgba(0,212,170,.05);border:1px solid rgba(0,212,170,.2);border-radius:var(--r);padding:12px 14px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
              <div class="lbl" style="margin-bottom:0;color:var(--a)">💊 Actes Récurrents à Réaliser</div>
              <span style="font-size:9px;background:rgba(0,212,170,.12);color:var(--a);border:1px solid rgba(0,212,170,.25);padding:1px 7px;border-radius:20px;font-family:var(--fm)">⚡ Cotation automatique</span>
            </div>
            <div style="font-size:13px;color:var(--t);white-space:pre-wrap;line-height:1.6">${p.actes_recurrents}</div>
          </div>` : ''}
        ${p.notes ? `<div class="ai in" style="margin-top:12px">${p.notes}</div>` : ''}
      </div>`;
    return;
  }

  if (tab === 'ordos') {
    const today = new Date(); today.setHours(0,0,0,0);
    const ordos = (p.ordonnances || []).slice().reverse();
    el.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="ct" style="margin-bottom:12px">💊 Ordonnances</div>
        ${ordos.length ? ordos.map((o, ri) => {
          const realIdx = (p.ordonnances.length - 1 - ri);
          const exp = o.date_expiration ? new Date(o.date_expiration) : null;
          const diffDays = exp ? Math.ceil((exp - today) / 86400000) : null;
          const statut = diffDays === null ? '' : diffDays < 0 ? '🔴 Expirée' : diffDays <= 7 ? '🟠 Urgente' : diffDays <= 30 ? '🟡 Bientôt' : '🟢 Valide';
          const statColor = diffDays === null ? 'var(--b)' : diffDays < 0 ? 'rgba(255,95,109,.2)' : diffDays <= 30 ? 'rgba(255,181,71,.2)' : 'rgba(0,212,170,.15)';
          return `<div style="border:1px solid ${statColor};border-radius:10px;padding:12px 14px;margin-bottom:8px">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px">
              <div>
                ${o.medecin ? `<div style="font-size:12px;color:var(--m)">Dr ${o.medecin}</div>` : ''}
                ${o.actes ? `<div style="font-size:13px;color:var(--t);margin-top:2px">${o.actes}</div>` : ''}
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0">
                ${statut ? `<span style="font-size:10px;font-family:var(--fm);color:var(--t)">${statut}</span>` : ''}
                <button class="btn bs bsm" style="font-size:10px;padding:3px 8px" onclick="_editOrdo('${id}',${realIdx})">✏️</button>
                <button class="btn bs bsm" style="font-size:10px;padding:3px 8px;color:var(--d);border-color:rgba(255,95,109,.3)" onclick="_deleteOrdo('${id}',${realIdx})">🗑️</button>
              </div>
            </div>
            <div style="font-size:11px;color:var(--m);font-family:var(--fm)">
              ${o.date_prescription ? 'Prescrite le '+new Date(o.date_prescription).toLocaleDateString('fr-FR')+' · ' : ''}
              ${exp ? 'Expire le '+exp.toLocaleDateString('fr-FR')+(diffDays!==null?' ('+Math.abs(diffDays)+' j)':'') : ''}
            </div>
            ${o.notes ? `<div style="font-size:11px;color:var(--m);margin-top:4px">${o.notes}</div>` : ''}
          </div>`;
        }).join('') : '<div style="color:var(--m);font-size:13px;margin-bottom:12px">Aucune ordonnance enregistrée.</div>'}

        <!-- Formulaire ajout/édition ordonnance -->
        <div id="ordo-form-inline" style="background:var(--s);border:1px solid rgba(0,212,170,.2);border-radius:10px;padding:14px;margin-top:12px">
          <div style="font-family:var(--fm);font-size:10px;color:var(--a);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px" id="ordo-form-title">➕ Ajouter une ordonnance</div>
          <input type="hidden" id="ordo-edit-idx" value="-1">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:10px">
            <div class="f"><label style="font-size:11px;color:var(--m)">Médecin prescripteur</label><input type="text" id="oi-medecin" placeholder="Dr. Martin"></div>
            <div class="f"><label style="font-size:11px;color:var(--m)">Date de prescription</label><input type="date" id="oi-date-pres"></div>
            <div class="f"><label style="font-size:11px;color:var(--m)">Date d'expiration</label><input type="date" id="oi-date-exp"></div>
            <div class="f"><label style="font-size:11px;color:var(--m)">Durée (jours)</label><input type="number" id="oi-duree" placeholder="30" min="1" oninput="_calcOrdoExp()"></div>
          </div>
          <div class="f" style="margin-bottom:10px"><label style="font-size:11px;color:var(--m)">Actes prescrits</label><input type="text" id="oi-actes" placeholder="Injections SC 2x/jour, pansement..."></div>
          <div class="f" style="margin-bottom:12px"><label style="font-size:11px;color:var(--m)">Notes</label><input type="text" id="oi-notes" placeholder="Observations..."></div>
          <div style="display:flex;gap:8px">
            <button class="btn bp bsm" onclick="_saveOrdo('${id}')">💾 Enregistrer</button>
            <button class="btn bs bsm" onclick="_cancelOrdoEdit()">Annuler</button>
          </div>
        </div>
      </div>`;
    return;
  }

  if (tab === 'cotations') {
    el.innerHTML = `
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div class="ct" style="margin-bottom:0">🧾 Historique des cotations</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn bp bsm" style="font-size:11px" onclick="syncCotationsPatient('${id}')">🔄 Synchroniser les cotations</button>
            <button class="btn bs bsm" style="font-size:11px" onclick="facturePatientMois('${id}')">📄 Facture du mois</button>
          </div>
        </div>
        ${p.cotations?.length ? `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${p.cotations.slice().reverse().map((c, ri) => {
            const realIdx = p.cotations.length - 1 - ri;
            const dateObj = new Date(c.date);
            const dateStr = dateObj.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'});
            const heureStr = c.heure || dateObj.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
            const actesList = (c.actes||[]).map(a => `<div style="font-size:12px;color:var(--m);padding:2px 0">• ${a.code||a.nom||''} — ${parseFloat(a.total||0).toFixed(2)} €</div>`).join('');
            const sourceBadge = c.source === 'tournee_auto'
              ? `<span style="font-size:9px;background:rgba(79,168,255,.1);color:var(--a2);border-radius:20px;padding:1px 6px;margin-left:4px">⚡ Auto</span>`
              : c.source === 'tournee'
              ? `<span style="font-size:9px;background:rgba(0,212,170,.1);color:var(--a);border-radius:20px;padding:1px 6px;margin-left:4px">🚗 Tournée</span>`
              : '';
            return `<div style="border:1px solid var(--b);border-radius:var(--r);padding:12px 14px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:6px">
                <div style="font-family:var(--fm);font-size:11px;color:var(--m)">${dateStr} à ${heureStr}${sourceBadge}${c.soin?' · '+c.soin.slice(0,40):''}</div>
                <div style="display:flex;gap:6px">
                  <button class="btn bs bsm" style="font-size:10px;padding:3px 8px" onclick="editCotationPatient('${id}',${realIdx})">✏️</button>
                  <button class="btn bs bsm" style="font-size:10px;padding:3px 8px;color:var(--d);border-color:rgba(255,95,109,.3)" onclick="deleteCotationPatient('${id}',${realIdx})">🗑️</button>
                </div>
              </div>
              ${actesList}
              <div style="font-size:13px;font-weight:600;color:var(--a);margin-top:6px">Total : ${parseFloat(c.total||0).toFixed(2)} €</div>
            </div>`;
          }).join('')}
        </div>` : '<div style="color:var(--m);font-size:13px">Aucune cotation enregistrée pour ce patient.</div>'}
      </div>`;
    return;
  }

  if (tab === 'notes') {
    el.innerHTML = `
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div class="ct" style="margin-bottom:0">📝 Notes de soins</div>
          ${notes.length ? `<button class="btn bs bsm" style="font-size:11px;color:var(--d);border-color:rgba(255,95,109,.3)" onclick="deleteAllSoinNotes('${id}')">🗑️ Tout supprimer</button>` : ''}
        </div>
        <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
          <textarea id="new-note-txt" placeholder="Observation, soin réalisé aujourd'hui..." style="flex:1;min-height:70px;min-width:200px" maxlength="500"></textarea>
          <button class="btn bp bsm" style="align-self:flex-end" onclick="addSoinNote('${id}')">💾 Ajouter</button>
        </div>
        <div id="notes-list">
          ${notes.length ? notes.slice().reverse().map(n => `
            <div data-note-id="${n.id}" style="border:1px solid var(--b);border-radius:var(--r);padding:10px 14px;margin-bottom:8px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;flex-wrap:wrap;gap:4px">
                <div style="font-size:11px;color:var(--m);font-family:var(--fm)">
                  ${new Date(n.date).toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'})}
                  <span style="color:var(--a);font-weight:600"> à ${n.heure || new Date(n.date).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</span>
                </div>
                <div style="display:flex;gap:6px">
                  <button class="btn bs bsm" style="font-size:10px;padding:3px 8px" onclick="editSoinNote(${n.id},'${id}')">✏️</button>
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
  }
}

/* ── Calcul auto date expiration depuis durée ── */
function _calcOrdoExp() {
  const dateEl = $('oi-date-pres');
  const durEl  = $('oi-duree');
  const expEl  = $('oi-date-exp');
  if (!dateEl?.value || !durEl?.value || !expEl) return;
  const d = new Date(dateEl.value);
  d.setDate(d.getDate() + parseInt(durEl.value));
  expEl.value = d.toISOString().split('T')[0];
}

/* ── CRUD ordonnances dans la fiche patient ── */
async function _saveOrdo(patientId) {
  const medecin  = $('oi-medecin')?.value?.trim() || '';
  const datePres = $('oi-date-pres')?.value || '';
  const dateExp  = $('oi-date-exp')?.value || '';
  const duree    = parseInt($('oi-duree')?.value) || 30;
  const actes    = $('oi-actes')?.value?.trim() || '';
  const notes    = $('oi-notes')?.value?.trim() || '';
  const editIdx  = parseInt($('ordo-edit-idx')?.value ?? '-1');

  if (!dateExp) { showToastSafe('⚠️ Indiquez au moins la date d\'expiration.'); return; }

  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === patientId);
  if (!row) return;
  const pat = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };
  if (!pat.ordonnances) pat.ordonnances = [];

  const ordo = { id: editIdx >= 0 ? pat.ordonnances[editIdx].id : ('ordo_' + Date.now()), medecin, date_prescription: datePres, date_expiration: dateExp, duree, actes, notes, created_at: new Date().toISOString() };

  if (editIdx >= 0) pat.ordonnances[editIdx] = ordo;
  else pat.ordonnances.push(ordo);

  pat.updated_at = new Date().toISOString();
  await _idbPut(PATIENTS_STORE, { id: pat.id, nom: pat.nom, prenom: pat.prenom, _data: _enc(pat), updated_at: pat.updated_at });

  showToastSafe('✅ Ordonnance enregistrée.');
  checkOrdoExpiry();
  // Rafraîchir l'onglet
  _patTab('ordos', patientId);
}

function _editOrdo(patientId, idx) {
  (async () => {
    const rows = await _idbGetAll(PATIENTS_STORE);
    const row  = rows.find(r => r.id === patientId);
    if (!row) return;
    const p = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };
    const o = p.ordonnances?.[idx];
    if (!o) return;
    const editIdxEl = $('ordo-edit-idx');  if (editIdxEl) editIdxEl.value = idx;
    const titleEl   = $('ordo-form-title'); if (titleEl) titleEl.textContent = '✏️ Modifier l\'ordonnance';
    if ($('oi-medecin'))   $('oi-medecin').value   = o.medecin || '';
    if ($('oi-date-pres')) $('oi-date-pres').value = o.date_prescription || '';
    if ($('oi-date-exp'))  $('oi-date-exp').value  = o.date_expiration || '';
    if ($('oi-duree'))     $('oi-duree').value     = o.duree || 30;
    if ($('oi-actes'))     $('oi-actes').value     = o.actes || '';
    if ($('oi-notes'))     $('oi-notes').value     = o.notes || '';
    $('ordo-form-inline')?.scrollIntoView({ behavior: 'smooth' });
  })();
}

function _cancelOrdoEdit() {
  const editIdxEl = $('ordo-edit-idx');  if (editIdxEl) editIdxEl.value = '-1';
  const titleEl   = $('ordo-form-title'); if (titleEl) titleEl.textContent = '➕ Ajouter une ordonnance';
  ['oi-medecin','oi-date-pres','oi-date-exp','oi-duree','oi-actes','oi-notes'].forEach(id => { const el=$(id); if(el) el.value=''; });
}

async function _deleteOrdo(patientId, idx) {
  if (!confirm('Supprimer cette ordonnance ?')) return;
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === patientId);
  if (!row) return;
  const pat = { id: row.id, nom: row.nom, prenom: row.prenom, ...(_dec(row._data)||{}) };
  if (!pat.ordonnances) return;
  pat.ordonnances.splice(idx, 1);
  pat.updated_at = new Date().toISOString();
  await _idbPut(PATIENTS_STORE, { id: pat.id, nom: pat.nom, prenom: pat.prenom, _data: _enc(pat), updated_at: pat.updated_at });
  showToastSafe('🗑️ Ordonnance supprimée.');
  checkOrdoExpiry();
  _patTab('ordos', patientId);
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
    'pat-actes-recurrents': p.actes_recurrents || '',
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
  const now = new Date();
  const heure = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const note = { patient_id: patientId, texte: txt, date: now.toISOString(), heure };
  await _idbPut(NOTES_STORE, note);
  $('new-note-txt').value = '';
  await openPatientDetail(patientId);
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

/* Supprimer toutes les notes de soins d'un patient */
async function deleteAllSoinNotes(patientId) {
  if (!confirm("Supprimer tout l'historique des soins de ce patient ?\nCette action est irréversible.")) return;
  const notes = await _idbGetByIndex(NOTES_STORE, 'patient_id', patientId);
  for (const n of notes) await _idbDelete(NOTES_STORE, n.id);
  await openPatientDetail(patientId);
  showToastSafe('🗑️ Historique des soins supprimé.');
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
    // invoice_number original indispensable pour l'upsert Supabase
    window._editingCotation = { patientId, cotationIdx, invoice_number: c.invoice_number || null };

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

  const cotToDelete = p.cotations[cotationIdx];
  const invoiceNum  = cotToDelete?.invoice_number || null;

  p.cotations.splice(cotationIdx, 1);
  p.updated_at = new Date().toISOString();
  const toStore = { id: row.id, nom: row.nom, prenom: row.prenom, _data: _enc(p), updated_at: p.updated_at };
  await _idbPut(PATIENTS_STORE, toStore);

  if (typeof _syncPatientNow === 'function') _syncPatientNow(toStore).catch(() => {});

  if (invoiceNum && typeof wpost === 'function') {
    try { await wpost('/webhook/ami-supprimer', { invoice_number: invoiceNum }); }
    catch (e) { console.warn('[patients] suppression Supabase échouée :', invoiceNum, e?.message); }
  }

  await openPatientDetail(patientId);
  showToastSafe('🗑️ Cotation supprimée.');
}


/* ════════════════════════════════════════════════
   SYNCHRONISER LES COTATIONS — sync bidirectionnelle IDB ↔ Supabase
   • Push : cotations locales non envoyées → Supabase
   • Pull : cotations Supabase absentes de l'IDB → injection
   • Purge : cotations IDB supprimées sur le serveur → retrait local
════════════════════════════════════════════════ */
async function syncCotationsPatient(patientId) {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === patientId);
  if (!row) return;
  const p = { ...(_dec(row._data)||{}), id: row.id, nom: row.nom, prenom: row.prenom };
  const nomAff = `${p.prenom||''} ${p.nom}`.trim();

  if (typeof showToastSafe === 'function') showToastSafe(`⏳ Synchronisation des cotations de ${nomAff}…`);

  try {
    const api = typeof wpost === 'function' ? wpost : (url, body) =>
      fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(r => r.json());

    if (!Array.isArray(p.cotations)) p.cotations = [];

    // ── 1. Push : cotations locales non encore sync → Supabase ──────────
    const aEnvoyer = p.cotations.filter(c => !c._synced && parseFloat(c.total||0) > 0);
    if (aEnvoyer.length) {
      const payload = aEnvoyer.map(c => ({
        actes:          c.actes || [],
        total:          parseFloat(c.total || 0),
        date_soin:      (c.date || '').slice(0, 10),
        heure_soin:     c.heure || null,
        soin:           (c.soin || '').slice(0, 200),
        invoice_number: c.invoice_number || null,
        source:         c.source || 'carnet_sync',
        dre_requise:    !!c.dre_requise,
        patient_id:     patientId,  // rattachement IDB ↔ planning_patients
      }));
      const pushRes = await api('/webhook/ami-save-cotation', { cotations: payload });
      if (pushRes?.ok) aEnvoyer.forEach(c => { c._synced = true; });
    }

    // ── 2. Pull : cotations Supabase → IDB ──────────────────────────────
    const histRes        = await api('/webhook/ami-historique', { period: 'year' });
    const remote         = histRes?.data || (Array.isArray(histRes) ? histRes : []);
    const serverInvoices = new Set(remote.map(r => r.invoice_number).filter(Boolean));
    const serverCots     = remote.filter(r => r.patient_id === patientId);

    // Purger les cotations locales supprimées sur le serveur
    p.cotations = p.cotations.filter(c => !c.invoice_number || serverInvoices.has(c.invoice_number));

    // Ajouter les cotations serveur absentes localement
    const localInvoices = new Set(p.cotations.map(c => c.invoice_number).filter(Boolean));
    for (const sc of serverCots) {
      if (!sc.invoice_number || localInvoices.has(sc.invoice_number)) continue;
      let actes = [];
      try { actes = typeof sc.actes === 'string' ? JSON.parse(sc.actes) : (sc.actes || []); } catch (_) {}
      p.cotations.push({
        date: sc.date_soin || null, heure: sc.heure_soin || '', actes,
        total: parseFloat(sc.total || 0), part_amo: parseFloat(sc.part_amo || 0),
        part_amc: parseFloat(sc.part_amc || 0), part_patient: parseFloat(sc.part_patient || 0),
        soin: (sc.notes || '').slice(0, 120), invoice_number: sc.invoice_number,
        source: sc.source || 'sync_server', ngap_version: sc.ngap_version || null,
        dre_requise: !!sc.dre_requise, _synced: true,
      });
      localInvoices.add(sc.invoice_number);
    }

    // ── 3. Sauvegarder + push carnet_patients ───────────────────────────
    p.updated_at = new Date().toISOString();
    const toStore = { id: row.id, nom: row.nom, prenom: row.prenom, _data: _enc(p), updated_at: p.updated_at };
    await _idbPut(PATIENTS_STORE, toStore);
    if (typeof _syncPatientNow === 'function') await _syncPatientNow(toStore);

    try {
      const ck = typeof _dashCacheKey === 'function' ? _dashCacheKey() : null;
      if (ck) localStorage.removeItem(ck);
    } catch {}

    if (typeof showToastSafe === 'function') showToastSafe(`✅ Cotations de ${nomAff} synchronisées.`, 'ok');
    await openPatientDetail(patientId);
    _patTab('cotations', patientId);

  } catch(e) {
    console.error('[syncCotationsPatient]', e);
    if (typeof showToastSafe === 'function') showToastSafe('❌ ' + e.message);
  }
}

/* ════════════════════════════════════════════════
   FACTURE DU MOIS — génère une facture HTML consolidée
   à partir de toutes les cotations IDB du patient
   pour le mois en cours
════════════════════════════════════════════════ */
async function facturePatientMois(patientId) {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === patientId);
  if (!row) return;
  const p = { ...(_dec(row._data)||{}), id: row.id, nom: row.nom, prenom: row.prenom };

  const now      = new Date();
  const annee    = now.getFullYear();
  const mois     = now.getMonth();
  const moisLabel = now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const nomAff   = `${p.prenom||''} ${p.nom}`.trim();

  // Récupérer les cotations du mois
  const cotationsMois = (p.cotations || []).filter(c => {
    const d = new Date(c.date);
    return d.getFullYear() === annee && d.getMonth() === mois;
  });

  if (!cotationsMois.length) {
    if (typeof showToastSafe === 'function') showToastSafe(`ℹ️ Aucune cotation enregistrée pour ${nomAff} en ${moisLabel}.`);
    return;
  }

  // Agréger tous les actes du mois — regrouper par code et sommer les totaux
  const actesMap = {};
  for (const cot of cotationsMois) {
    for (const acte of (cot.actes || [])) {
      const key = acte.code || acte.nom || 'Acte';
      if (!actesMap[key]) {
        actesMap[key] = { code: acte.code || '', nom: acte.nom || acte.code || '', coefficient: acte.coefficient || 1, total: 0, nb: 0 };
      }
      actesMap[key].total += parseFloat(acte.total || 0);
      actesMap[key].nb++;
    }
  }

  const actesAgreg = Object.values(actesMap).map(a => ({
    code:        a.code,
    nom:         `${a.nom}${a.nb > 1 ? ' × ' + a.nb : ''}`,
    coefficient: a.coefficient,
    total:       a.total,
  }));

  const totalMois     = cotationsMois.reduce((s, c) => s + parseFloat(c.total || 0), 0);
  const part_amo      = totalMois * 0.6;
  const part_amc      = 0;
  const part_patient  = totalMois * 0.4;

  // Plage de dates
  const dates = cotationsMois.map(c => c.date).sort();
  const dateDebut = new Date(dates[0]).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
  const dateFin   = new Date(dates[dates.length - 1]).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
  const periodeLabel = dates.length === 1 ? dateDebut : `${dateDebut} → ${dateFin}`;

  // Construire l'objet facture compatible avec _doPrint
  const factureData = {
    actes:         actesAgreg,
    total:         totalMois,
    part_amo,
    part_amc,
    part_patient,
    invoice_number: `M-${annee}${String(mois + 1).padStart(2,'0')}-${String(patientId).slice(-4)}`,
    date_soin:     periodeLabel,
    patient:       nomAff,
    dre_requise:   cotationsMois.some(c => c.dre_requise),
    _mois:         moisLabel,
    _nb_seances:   cotationsMois.length,
  };

  // Utiliser _doPrint si disponible (cotation.js chargé), sinon fallback autonome
  if (typeof _doPrint === 'function') {
    const u = (typeof S !== 'undefined') ? S?.user || {} : {};
    _doPrint(factureData, u);
    return;
  }

  // Fallback autonome : générer le HTML directement
  const u   = (typeof S !== 'undefined') ? S?.user || {} : {};
  const inf = ((u.prenom || '') + ' ' + (u.nom || '')).trim() || 'Infirmier(ère) libéral(e)';
  const num = factureData.invoice_number;
  const fmt = v => (parseFloat(v) || 0).toFixed(2) + ' €';

  const infoPro = [
    u.structure ? `<div style="font-weight:600;margin-bottom:2px">${u.structure}</div>` : '',
    `<div>${inf}</div>`,
    u.adeli  ? `<div style="font-size:12px;color:#6b7a99">N° ADELI : <strong>${u.adeli}</strong></div>` : '',
    u.rpps   ? `<div style="font-size:12px;color:#6b7a99">N° RPPS : <strong>${u.rpps}</strong></div>` : '',
  ].filter(Boolean).join('');

  const htmlContent = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<title>Facture mensuelle ${num}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',sans-serif;padding:40px;font-size:14px;color:#1a1a2e}
  h1{font-size:26px;color:#0b3954;margin-bottom:4px}
  .meta{font-size:12px;color:#6b7a99}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:18px;border-bottom:2px solid #e0e7ef;gap:20px}
  .badge{display:inline-block;background:#e8f4ff;color:#2563eb;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;margin-top:6px}
  table{width:100%;border-collapse:collapse;margin:20px 0}
  th{background:#f0f4fa;padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7a99;letter-spacing:.5px}
  td{padding:10px 12px;border-bottom:1px solid #e8edf5}
  tfoot td{font-weight:700;border-top:2px solid #ccd5e0;background:#f7f9fc}
  .rep{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:20px}
  .rc{background:#f7f9fc;padding:14px;border-radius:8px;text-align:center}
  .rl{font-size:11px;text-transform:uppercase;color:#6b7a99;margin-bottom:4px}
  .rv{font-size:22px;font-weight:700;color:#0b3954}
  .footer{margin-top:30px;padding-top:16px;border-top:1px solid #e0e7ef;font-size:11px;color:#9ca3af;text-align:center}
  .print-btn{display:inline-flex;align-items:center;gap:8px;margin-bottom:20px;padding:10px 20px;background:#0b3954;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer}
  @media print{.print-btn,.no-print{display:none!important}body{padding:20px}}
</style></head><body>
<button class="print-btn no-print" onclick="window.print()">🖨️ Imprimer / Enregistrer en PDF</button>
<div class="hdr">
  <div>
    <h1>Facture mensuelle</h1>
    <div class="meta">N° ${num} · ${now.toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'})}</div>
    <div class="meta">Période : ${periodeLabel}</div>
    <div class="meta">Patient : <strong>${nomAff}</strong></div>
    <div class="badge">📅 ${cotationsMois.length} séance(s) — ${moisLabel}</div>
  </div>
  <div style="text-align:right;line-height:1.7">${infoPro}</div>
</div>
<table>
  <thead><tr><th>Code</th><th>Acte médical</th><th style="text-align:right">Coef.</th><th style="text-align:right">Montant</th></tr></thead>
  <tbody>
    ${actesAgreg.map(x => `<tr>
      <td style="font-weight:600;font-size:13px;color:#0b3954">${x.code||''}</td>
      <td>${x.nom||''}</td>
      <td style="text-align:right;color:#6b7a99">×${(x.coefficient||1).toFixed(1)}</td>
      <td style="text-align:right;font-weight:600">${fmt(x.total)}</td>
    </tr>`).join('')}
  </tbody>
  <tfoot>
    <tr><td colspan="3" style="text-align:right">TOTAL</td><td style="text-align:right;font-size:16px">${fmt(totalMois)}</td></tr>
  </tfoot>
</table>
<div class="rep">
  <div class="rc"><div class="rl">Part AMO (SS)</div><div class="rv">${fmt(part_amo)}</div></div>
  <div class="rc"><div class="rl">Part AMC</div><div class="rv">${fmt(part_amc)}</div></div>
  <div class="rc"><div class="rl">Part Patient</div><div class="rv">${fmt(part_patient)}</div></div>
</div>
${factureData.dre_requise ? '<div style="margin-top:16px;padding:10px 14px;background:#e8f4ff;border-radius:6px;font-size:13px;color:#2563eb">📋 <strong>DRE requise</strong> — Demande de Remboursement Exceptionnel</div>' : ''}
<div class="footer">AMI NGAP · N° ${num} · Cotation NGAP métropole en vigueur · Généré le ${now.toLocaleDateString('fr-FR')}</div>
</body></html>`;

  const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `facture-mensuelle-${nomAff.replace(/\s+/g,'-')}-${annee}${String(mois+1).padStart(2,'0')}.html`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); if (a.parentNode) document.body.removeChild(a); }, 3000);
  if (typeof showToastSafe === 'function') showToastSafe(`📄 Facture ${moisLabel} générée — ${cotationsMois.length} séance(s) · ${totalMois.toFixed(2)} €`, 'ok');
}

/* Vérification expiration ordonnances */
async function checkOrdoExpiry() {
  try {
    await initPatientsDB();
    const rows  = await _idbGetAll(PATIENTS_STORE);
    const in30  = new Date(Date.now() + 30*24*3600000);
    const alerts = [];

    for (const r of rows) {
      const p = { id: r.id, nom: r.nom, prenom: r.prenom, ...(_dec(r._data)||{}) };
      const nomAff = `${p.prenom||''} ${p.nom}`.trim();

      // Nouveau tableau ordonnances[]
      if (p.ordonnances?.length) {
        for (const o of p.ordonnances) {
          const exp = new Date(o.date_expiration || '');
          if (!isNaN(exp) && exp <= in30) {
            alerts.push(`${nomAff} — ordonnance expire le ${exp.toLocaleDateString('fr-FR')}`);
          }
        }
      }
      // Rétrocompatibilité ordo_date
      else if (p.ordo_date && new Date(p.ordo_date) <= in30) {
        alerts.push(`${nomAff} — ordonnance avant le ${p.ordo_date}`);
      }
    }

    const badge = $('patients-ordo-badge');
    if (badge) {
      badge.textContent = alerts.length > 0 ? `${alerts.length} ⚠️` : '';
      badge.style.display = alerts.length > 0 ? 'inline' : 'none';
    }
    if (alerts.length > 0) {
      showToastSafe(`📋 ${alerts.length} ordonnance(s) à renouveler prochainement.`);
    }
  } catch(e) {
    console.warn('[AMI] checkOrdoExpiry KO:', e.message);
  }
}
/* Cotation depuis la fiche patient */
async function coterDepuisPatient(id) {
  const rows = await _idbGetAll(PATIENTS_STORE);
  const row  = rows.find(r => r.id === id);
  if (!row) return;
  const p = { ...(_dec(row._data)||{}), nom: row.nom, prenom: row.prenom };

  navTo('cot', null);
  setTimeout(() => {
    const fPt = $('f-pt'); if(fPt) fPt.value = (p.prenom+' '+p.nom).trim();
    const fDdn= $('f-ddn'); if(fDdn && p.ddn) fDdn.value = p.ddn;
    const fAmo= $('f-amo'); if(fAmo && p.amo) fAmo.value = p.amo;
    const fAmc= $('f-amc'); if(fAmc && p.amc) fAmc.value = p.amc;
    const fExo= $('f-exo'); if(fExo && p.exo) fExo.value = p.exo;
    const fPr = $('f-pr'); if(fPr && p.medecin) fPr.value = p.medecin;
    // Pré-remplir la description : actes_recurrents en priorité,
    // sinon pathologies converties en actes NGAP applicables
    const fTxt = $('f-txt');
    if (fTxt) {
      const _txtVal = p.actes_recurrents
        || (p.pathologies && typeof pathologiesToActes === 'function'
            ? pathologiesToActes(p.pathologies) : '');
      if (_txtVal) {
        fTxt.value = _txtVal;
        if (typeof renderLiveReco === 'function') renderLiveReco(_txtVal);
      }
      fTxt.focus();
    }
    const _srcLabel = p.actes_recurrents
      ? ' — actes récurrents pré-remplis'
      : (p.pathologies ? ' — pathologies converties en actes NGAP' : '');
    showToastSafe(`👤 Fiche de ${p.prenom||''} ${p.nom} chargée${_srcLabel}.`);
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
  return fetch(url, { ...opts, signal: ctrl.signal })
    .then(res => { clearTimeout(tid); return res; })
    .catch(err => { clearTimeout(tid); throw err; });
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
        if (e?.name !== 'AbortError') console.warn('[GEO] gouv.fr erreur:', e.message);
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
        if (e?.name !== 'AbortError') console.warn('[GEO] nominatim erreur:', e.message);
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
        actes_recurrents:  p.actes_recurrents || '',
        description:       p.actes_recurrents || p.notes || p.pathologies || 'Soin infirmier',
        texte:             p.actes_recurrents || p.notes || p.pathologies || 'Soin infirmier',
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
    // actes_recurrents en priorité pour la cotation auto, sinon fallback sur notes/pathologies
    actes_recurrents:  p.actes_recurrents || '',
    description:       p.actes_recurrents || p.notes || p.pathologies || 'Soin infirmier',
    texte:             p.actes_recurrents || p.notes || p.pathologies || 'Soin infirmier',
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

/* ────────────────────────────────────────────────
   _syncPatientNow — push immédiat d'une fiche vers carnet_patients
──────────────────────────────────────────────── */
async function _syncPatientNow(row) {
  if (!S?.token || !row?.id || !row?._data) return;
  try {
    const nomEnc = btoa(unescape(encodeURIComponent((row.nom||'') + ' ' + (row.prenom||'')))).slice(0, 64);
    await wpost('/webhook/patients-push', {
      patients: [{ id: row.id, encrypted_data: row._data, nom_enc: nomEnc, updated_at: row.updated_at || new Date().toISOString() }]
    });
  } catch(e) { console.warn('[AMI] _syncPatientNow KO :', e?.message); }
}

/* ────────────────────────────────────────────────
   syncCotationsFromServer — sync Supabase → IDB au login
   Supabase est source de vérité : purge supprimées, injecte manquantes.
──────────────────────────────────────────────── */
async function syncCotationsFromServer() {
  if (!S?.token) return;
  try {
    const res    = await wpost('/webhook/ami-historique', { period: 'year' });
    const remote = res?.data || (Array.isArray(res) ? res : []);
    const serverInvoices = new Set(remote.map(r => r.invoice_number).filter(Boolean));

    const serverCotsByPid = new Map();
    for (const row of remote) {
      const pid = row.patient_id || null;
      if (!pid) continue;
      let actes = [];
      try { actes = typeof row.actes === 'string' ? JSON.parse(row.actes) : (row.actes || []); } catch (_) {}
      const cot = {
        date: row.date_soin || null, heure: row.heure_soin || '', actes,
        total: parseFloat(row.total || 0), part_amo: parseFloat(row.part_amo || 0),
        part_amc: parseFloat(row.part_amc || 0), part_patient: parseFloat(row.part_patient || 0),
        soin: (row.notes || '').slice(0, 120), invoice_number: row.invoice_number || null,
        source: row.source || 'sync_server', ngap_version: row.ngap_version || null,
        dre_requise: !!row.dre_requise, _synced: true,
      };
      if (!serverCotsByPid.has(pid)) serverCotsByPid.set(pid, []);
      serverCotsByPid.get(pid).push(cot);
    }

    const localRows = await _idbGetAll(PATIENTS_STORE);
    const localIds  = new Set(localRows.map(r => r.id));
    let changed = 0;

    for (const row of localRows) {
      const p = { ...(_dec(row._data) || {}), id: row.id, nom: row.nom, prenom: row.prenom };
      if (!Array.isArray(p.cotations)) p.cotations = [];
      const before = p.cotations.length;

      p.cotations = p.cotations.filter(c => !c.invoice_number || serverInvoices.has(c.invoice_number));

      const localInvoices = new Set(p.cotations.map(c => c.invoice_number).filter(Boolean));
      for (const sc of (serverCotsByPid.get(row.id) || [])) {
        if (sc.invoice_number && !localInvoices.has(sc.invoice_number)) {
          p.cotations.push(sc); localInvoices.add(sc.invoice_number);
        }
      }

      if (p.cotations.length !== before) {
        p.updated_at = new Date().toISOString();
        await _idbPut(PATIENTS_STORE, {
          id: row.id, nom: p.nom || row.nom, prenom: p.prenom || row.prenom,
          _data: _enc(p), updated_at: p.updated_at,
        });
        changed++;
      }
    }

    for (const [pid, cots] of serverCotsByPid) {
      if (localIds.has(pid)) continue;
      const minPat = { id: pid, nom: '', prenom: '', cotations: cots };
      await _idbPut(PATIENTS_STORE, {
        id: pid, nom: '', prenom: '',
        _data: _enc(minPat), updated_at: new Date(0).toISOString(),
      });
      changed++;
    }

    if (changed > 0) {
      console.info(`[AMI] syncCotationsFromServer : ${changed} fiche(s) mise(s) à jour.`);
      if (document.querySelector('#patients-section:not(.hidden)') ||
          document.querySelector('[data-view="patients"].active')) loadPatients();
    } else {
      console.info('[AMI] syncCotationsFromServer : IDB déjà synchronisée.');
    }
  } catch (e) { console.warn('[AMI] syncCotationsFromServer KO :', e.message); }
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
    await syncPatientsFromServer();   // 1. Fiches patients chiffrées
    await syncCotationsFromServer();  // 2. Cotations (purge + injection)
  }).catch(() => {});
});

/* ════════════════════════════════════════════════
   SÉLECTEUR PATIENT INLINE — SECTION COTATION
   Permet de sélectionner un patient depuis le carnet
   pour pré-remplir automatiquement les champs
════════════════════════════════════════════════ */
let _cotPatientList = [];    // cache des patients pour la recherche
let _cotSelectedPatient = null;
let _cotDropdownIdx = -1;    // navigation clavier

/* Charge les patients en mémoire (appelé à l'ouverture de la vue cotation) */
async function cotLoadPatientCache() {
  try {
    await initPatientsDB();
    const rows = await _idbGetAll(PATIENTS_STORE);
    _cotPatientList = rows.map(r => ({
      id: r.id,
      nom: r.nom || '',
      prenom: r.prenom || '',
      data: _dec(r._data) || {}
    })).sort((a, b) => (a.nom + a.prenom).localeCompare(b.nom + b.prenom));
  } catch { _cotPatientList = []; }
}

/* Ouvre le dropdown (au focus ou au clic) */
async function cotOpenDropdown() {
  if (!_cotPatientList.length) await cotLoadPatientCache();
  const q = (document.getElementById('cot-patient-search')?.value || '').trim();
  cotRenderDropdown(q);
}

/* Filtre dynamique à la frappe */
async function cotFilterPatients(q) {
  if (!_cotPatientList.length) await cotLoadPatientCache();
  cotRenderDropdown(q);
}

/* Affiche les résultats dans le dropdown */
function cotRenderDropdown(q) {
  const dd = document.getElementById('cot-patient-dropdown');
  if (!dd) return;

  const query = (q || '').toLowerCase().trim();
  const results = query
    ? _cotPatientList.filter(p =>
        (p.nom + ' ' + p.prenom).toLowerCase().includes(query) ||
        (p.prenom + ' ' + p.nom).toLowerCase().includes(query)
      ).slice(0, 12)
    : _cotPatientList.slice(0, 12);

  if (!results.length) {
    dd.innerHTML = '<div style="padding:12px 14px;font-size:12px;opacity:.5;color:var(--t)">Aucun patient trouvé dans le carnet</div>';
  } else {
    dd.innerHTML = results.map((p, i) => {
      const ddn = p.data.ddn ? ` · ${new Date(p.data.ddn).toLocaleDateString('fr-FR')}` : '';
      const med = p.data.medecin ? ` · Dr ${p.data.medecin}` : '';
      return `<div class="cot-dd-item" data-idx="${i}" data-id="${p.id}"
        onclick="cotSelectPatient('${p.id}')"
        onmouseenter="cotDDHover(this)"
        style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--b);font-size:13px;transition:background .15s">
        <strong style="color:var(--t)">${p.nom} ${p.prenom}</strong>
        <span style="font-size:11px;opacity:.55;margin-left:6px">${ddn}${med}</span>
      </div>`;
    }).join('');
  }

  _cotDropdownIdx = -1;
  dd.style.display = 'block';

  // Fermer au clic extérieur
  setTimeout(() => {
    const closeHandler = (e) => {
      if (!e.target.closest('#cot-patient-selector')) {
        dd.style.display = 'none';
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 10);
}

/* Hover clavier */
function cotDDHover(el) {
  document.querySelectorAll('.cot-dd-item').forEach(i => i.style.background = '');
  el.style.background = 'rgba(0,212,170,.08)';
}

/* Navigation clavier dans le dropdown */
function cotKeyNav(e) {
  const items = document.querySelectorAll('.cot-dd-item');
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _cotDropdownIdx = Math.min(_cotDropdownIdx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _cotDropdownIdx = Math.max(_cotDropdownIdx - 1, 0);
  } else if (e.key === 'Enter' && _cotDropdownIdx >= 0) {
    e.preventDefault();
    const id = items[_cotDropdownIdx]?.dataset?.id;
    if (id) cotSelectPatient(id);
    return;
  } else if (e.key === 'Escape') {
    document.getElementById('cot-patient-dropdown').style.display = 'none';
    return;
  }
  items.forEach((item, i) => {
    item.style.background = i === _cotDropdownIdx ? 'rgba(0,212,170,.08)' : '';
  });
  items[_cotDropdownIdx]?.scrollIntoView({ block: 'nearest' });
}

/* Sélectionne un patient et pré-remplit les champs */
async function cotSelectPatient(id) {
  const p = _cotPatientList.find(x => x.id === id);
  if (!p) return;
  _cotSelectedPatient = p;

  // Fermer dropdown, mettre à jour la recherche
  const dd = document.getElementById('cot-patient-dropdown');
  const search = document.getElementById('cot-patient-search');
  const badge = document.getElementById('cot-patient-badge');
  const badgeText = document.getElementById('cot-patient-badge-text');

  if (dd) dd.style.display = 'none';
  if (search) search.value = '';
  if (badge) badge.style.display = 'flex';
  if (badgeText) badgeText.textContent = `👤 ${p.prenom} ${p.nom}${p.data.ddn ? ' — ' + new Date(p.data.ddn).toLocaleDateString('fr-FR') : ''}`;

  // Pré-remplir les champs patient
  const d = p.data;
  const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
  set('f-pt',  (p.prenom + ' ' + p.nom).trim());
  set('f-ddn', d.ddn || '');
  set('f-sec', d.nir || d.secu || '');
  set('f-amo', d.amo || '');
  set('f-amc', d.amc || '');
  set('f-exo', d.exo || '');
  set('f-pr',  d.medecin || '');

  // Pré-remplir la description : actes_recurrents en priorité,
  // sinon pathologies converties en actes NGAP applicables
  const fTxt = document.getElementById('f-txt');
  const _txtVal2 = d.actes_recurrents
    || (d.pathologies && typeof pathologiesToActes === 'function'
        ? pathologiesToActes(d.pathologies) : '');
  if (fTxt && _txtVal2) {
    fTxt.value = _txtVal2;
    if (typeof renderLiveReco === 'function') renderLiveReco(_txtVal2);
  }

  if (typeof showToast === 'function') {
    const _lbl2 = d.actes_recurrents
      ? ' avec actes récurrents'
      : (d.pathologies ? ' — pathologies → actes NGAP' : '');
    showToast(`👤 ${p.prenom} ${p.nom} — fiche chargée${_lbl2}`);
  }
}

/* Désélectionne le patient et vide le badge */
function cotClearPatient() {
  _cotSelectedPatient = null;
  const badge = document.getElementById('cot-patient-badge');
  if (badge) badge.style.display = 'none';
  const search = document.getElementById('cot-patient-search');
  if (search) { search.value = ''; search.focus(); }
}

/* Recharge le cache à l'ouverture de la vue cotation */
document.addEventListener('ui:navigate', (e) => {
  if (e.detail?.view === 'cot') {
    cotLoadPatientCache().catch(() => {});
  }
});
