// ─────────────────────────────────────────────────────────────
//  patient-form.js
//  Formulaire nouveau / édition patient
//  Adresse structurée : rue | complément | CP | ville | France
//  Suggestions automatiques codes postaux / villes
// ─────────────────────────────────────────────────────────────

// ─── Base codes postaux France (à étendre avec votre zone) ───
const CP_DATA = [
  {cp:"01000",ville:"Bourg-en-Bresse"},
  {cp:"06000",ville:"Nice"},{cp:"06100",ville:"Nice"},{cp:"06200",ville:"Nice"},
  {cp:"13001",ville:"Marseille"},{cp:"13002",ville:"Marseille"},{cp:"13003",ville:"Marseille"},
  {cp:"13004",ville:"Marseille"},{cp:"13005",ville:"Marseille"},{cp:"13006",ville:"Marseille"},
  {cp:"13007",ville:"Marseille"},{cp:"13008",ville:"Marseille"},{cp:"13009",ville:"Marseille"},
  {cp:"13010",ville:"Marseille"},{cp:"13011",ville:"Marseille"},{cp:"13012",ville:"Marseille"},
  {cp:"13013",ville:"Marseille"},{cp:"13014",ville:"Marseille"},{cp:"13015",ville:"Marseille"},
  {cp:"13016",ville:"Marseille"},{cp:"13100",ville:"Aix-en-Provence"},
  {cp:"21000",ville:"Dijon"},{cp:"25000",ville:"Besançon"},{cp:"26000",ville:"Valence"},
  {cp:"31000",ville:"Toulouse"},{cp:"31100",ville:"Toulouse"},{cp:"31200",ville:"Toulouse"},
  {cp:"31300",ville:"Toulouse"},{cp:"31400",ville:"Toulouse"},{cp:"31500",ville:"Toulouse"},
  {cp:"33000",ville:"Bordeaux"},{cp:"33100",ville:"Bordeaux"},{cp:"33200",ville:"Bordeaux"},
  {cp:"33300",ville:"Bordeaux"},
  {cp:"34000",ville:"Montpellier"},{cp:"34080",ville:"Montpellier"},{cp:"34090",ville:"Montpellier"},
  {cp:"35000",ville:"Rennes"},{cp:"35200",ville:"Rennes"},
  {cp:"37000",ville:"Tours"},{cp:"38000",ville:"Grenoble"},{cp:"38100",ville:"Grenoble"},
  {cp:"44000",ville:"Nantes"},{cp:"44100",ville:"Nantes"},{cp:"44200",ville:"Nantes"},
  {cp:"44300",ville:"Nantes"},{cp:"45000",ville:"Orléans"},{cp:"49000",ville:"Angers"},
  {cp:"51100",ville:"Reims"},{cp:"54000",ville:"Nancy"},{cp:"57000",ville:"Metz"},
  {cp:"59000",ville:"Lille"},{cp:"59800",ville:"Lille"},
  {cp:"63000",ville:"Clermont-Ferrand"},
  {cp:"67000",ville:"Strasbourg"},{cp:"67100",ville:"Strasbourg"},{cp:"67200",ville:"Strasbourg"},
  {cp:"69001",ville:"Lyon"},{cp:"69002",ville:"Lyon"},{cp:"69003",ville:"Lyon"},
  {cp:"69004",ville:"Lyon"},{cp:"69005",ville:"Lyon"},{cp:"69006",ville:"Lyon"},
  {cp:"69007",ville:"Lyon"},{cp:"69008",ville:"Lyon"},{cp:"69009",ville:"Lyon"},
  {cp:"69100",ville:"Villeurbanne"},{cp:"69110",ville:"Sainte-Foy-lès-Lyon"},
  {cp:"69120",ville:"Vaulx-en-Velin"},{cp:"69130",ville:"Écully"},
  {cp:"69200",ville:"Vénissieux"},{cp:"69300",ville:"Caluire-et-Cuire"},
  {cp:"75001",ville:"Paris"},{cp:"75002",ville:"Paris"},{cp:"75003",ville:"Paris"},
  {cp:"75004",ville:"Paris"},{cp:"75005",ville:"Paris"},{cp:"75006",ville:"Paris"},
  {cp:"75007",ville:"Paris"},{cp:"75008",ville:"Paris"},{cp:"75009",ville:"Paris"},
  {cp:"75010",ville:"Paris"},{cp:"75011",ville:"Paris"},{cp:"75012",ville:"Paris"},
  {cp:"75013",ville:"Paris"},{cp:"75014",ville:"Paris"},{cp:"75015",ville:"Paris"},
  {cp:"75016",ville:"Paris"},{cp:"75017",ville:"Paris"},{cp:"75018",ville:"Paris"},
  {cp:"75019",ville:"Paris"},{cp:"75020",ville:"Paris"},
  {cp:"76000",ville:"Rouen"},{cp:"76100",ville:"Rouen"},
  {cp:"80000",ville:"Amiens"},{cp:"83000",ville:"Toulon"},{cp:"83100",ville:"Toulon"},
  {cp:"87000",ville:"Limoges"},
  {cp:"92100",ville:"Boulogne-Billancourt"},{cp:"92200",ville:"Neuilly-sur-Seine"},
  {cp:"93100",ville:"Montreuil"},{cp:"93200",ville:"Saint-Denis"},{cp:"94000",ville:"Créteil"},
];

let _sugTimeout = null;

// ─────────────────────────────────────────────────────────────
//  Initialisation du formulaire
// ─────────────────────────────────────────────────────────────
function initPatientForm(patientToEdit = null) {
  // listener code postal
  document.getElementById('f-cp').addEventListener('input', function () {
    const val = this.value.replace(/\D/g, '').slice(0, 5);
    this.value = val;
    clearTimeout(_sugTimeout);
    if (val.length < 2) { hideSuggestions('sug-cp'); return; }

    _sugTimeout = setTimeout(() => {
      const matches = CP_DATA.filter(d => d.cp.startsWith(val)).slice(0, 7);
      showSuggestions('sug-cp', matches, m => {
        document.getElementById('f-cp').value    = m.cp;
        document.getElementById('f-ville').value = m.ville;
        hideSuggestions('sug-cp');
        validateCpVille();
        updateAdressePreview();
        checkFormValidity();
      });
      // auto-remplissage ville si CP exact reconnu
      if (val.length === 5) {
        const exact = CP_DATA.find(d => d.cp === val);
        if (exact && !document.getElementById('f-ville').value.trim()) {
          document.getElementById('f-ville').value = exact.ville;
          validateCpVille();
        }
      }
    }, 150);

    updateAdressePreview();
    checkFormValidity();
  });

  // listener ville
  document.getElementById('f-ville').addEventListener('input', function () {
    const v = this.value.toLowerCase();
    clearTimeout(_sugTimeout);
    if (v.length < 2) { hideSuggestions('sug-ville'); return; }

    _sugTimeout = setTimeout(() => {
      // dédoublonner par ville
      const seen    = new Set();
      const matches = CP_DATA
        .filter(d => d.ville.toLowerCase().startsWith(v))
        .filter(d => {
          if (seen.has(d.ville)) return false;
          seen.add(d.ville); return true;
        })
        .slice(0, 7);

      showSuggestions('sug-ville', matches, m => {
        document.getElementById('f-ville').value = m.ville;
        document.getElementById('f-cp').value    = m.cp;
        hideSuggestions('sug-ville');
        validateCpVille();
        updateAdressePreview();
        checkFormValidity();
      });
    }, 150);

    updateAdressePreview();
    checkFormValidity();
  });

  // listeners autres champs
  ['f-rue', 'f-comp', 'f-nom', 'f-prenom'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      updateAdressePreview();
      checkFormValidity();
    });
  });

  // fermer suggestions au clic extérieur
  document.addEventListener('click', e => {
    if (!e.target.closest('.suggest-box')) {
      hideSuggestions('sug-cp');
      hideSuggestions('sug-ville');
    }
  });

  // pré-remplissage si édition
  if (patientToEdit) fillForm(patientToEdit);
}

// ─────────────────────────────────────────────────────────────
//  Suggestions
// ─────────────────────────────────────────────────────────────
function showSuggestions(containerId, matches, onSelect) {
  const box = document.getElementById(containerId);
  if (!matches.length) { box.style.display = 'none'; return; }

  box.innerHTML = '';
  matches.forEach(m => {
    const item      = document.createElement('div');
    item.className  = 'sug-item';
    item.innerHTML  = `<span class="sug-cp">${m.cp}</span>
                       <span class="sug-ville">${m.ville}</span>`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();   // évite le blur avant le click
      onSelect(m);
    });
    box.appendChild(item);
  });
  box.style.display = 'block';
}

function hideSuggestions(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────
//  Validation CP / Ville
// ─────────────────────────────────────────────────────────────
function validateCpVille() {
  const cp    = document.getElementById('f-cp').value.trim();
  const ville = document.getElementById('f-ville').value.trim().toLowerCase();
  const warn  = document.getElementById('warn-addr');
  if (!warn) return;

  if (cp.length === 5 && ville.length > 1) {
    const match = CP_DATA.find(
      d => d.cp === cp && d.ville.toLowerCase() === ville
    );
    warn.style.display = match ? 'none' : 'block';
    warn.textContent   = 'Code postal et ville ne correspondent pas — vérifiez la saisie.';
  } else {
    warn.style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────
//  Prévisualisation adresse complète
// ─────────────────────────────────────────────────────────────
function updateAdressePreview() {
  const rue   = document.getElementById('f-rue').value.trim();
  const comp  = (document.getElementById('f-comp')?.value || '').trim();
  const cp    = document.getElementById('f-cp').value.trim();
  const ville = document.getElementById('f-ville').value.trim();

  const parts = [rue, comp, [cp, ville].filter(Boolean).join(' '), 'France']
    .map(s => s.trim())
    .filter(Boolean);

  const preview = document.getElementById('addr-preview');
  const geoSt   = document.getElementById('geo-status');
  const geoDot  = document.getElementById('geo-dot');
  const geoLbl  = document.getElementById('geo-label');

  if (!parts.length) {
    if (preview)  preview.style.display = 'none';
    if (geoSt)    geoSt.style.display   = 'none';
    return;
  }

  if (preview) {
    preview.style.display    = 'block';
    const span = preview.querySelector('#preview-text');
    if (span) span.textContent = parts.join(', ');
  }

  if (geoSt && geoDot && geoLbl) {
    geoSt.style.display = 'flex';
    if (rue && cp.length === 5 && ville) {
      geoDot.className    = 'dot green';
      geoLbl.textContent  = 'Adresse complète — localisation précise garantie';
    } else {
      geoDot.className    = 'dot orange';
      geoLbl.textContent  = 'Compléter le code postal et la ville';
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Validation globale du formulaire
// ─────────────────────────────────────────────────────────────
function checkFormValidity() {
  const nom    = document.getElementById('f-nom')?.value.trim();
  const prenom = document.getElementById('f-prenom')?.value.trim();
  const rue    = document.getElementById('f-rue')?.value.trim();
  const cp     = document.getElementById('f-cp')?.value.trim();
  const ville  = document.getElementById('f-ville')?.value.trim();

  const valid  = nom && prenom && rue && cp?.length === 5 && ville;
  const btn    = document.getElementById('btn-save-patient');
  if (btn) btn.disabled = !valid;
}

// ─────────────────────────────────────────────────────────────
//  Construction de l'objet patient final
// ─────────────────────────────────────────────────────────────
function buildPatientObject() {
  const nom    = document.getElementById('f-nom').value.trim();
  const prenom = document.getElementById('f-prenom').value.trim();
  const rue    = document.getElementById('f-rue').value.trim();
  const comp   = (document.getElementById('f-comp')?.value || '').trim();
  const cp     = document.getElementById('f-cp').value.trim();
  const ville  = document.getElementById('f-ville').value.trim();
  const tel    = (document.getElementById('f-tel')?.value || '').trim();
  const dob    = (document.getElementById('f-dob')?.value || '');
  const soin   = (document.getElementById('f-soin')?.value || '');
  const heure  = (document.getElementById('f-heure')?.value || '08:00');
  const prio   = (document.getElementById('f-priorite')?.value || 'Normale');
  const reg    = (document.getElementById('f-regulier')?.value || 'Oui') === 'Oui';
  const notes  = [];

  const noteText = (document.getElementById('f-notes')?.value || '').trim();
  if (noteText) {
    notes.push({
      id:   Date.now().toString(),
      cat:  'general',
      text: noteText,
      date: new Date().toLocaleDateString('fr-FR'),
    });
  }

  // adresse ligne affichage
  const address = [rue, comp].filter(Boolean).join(', ');

  // adresse navigation complète pour Google Maps
  const addressFull = [rue, comp, cp + ' ' + ville, 'France']
    .map(s => s.trim()).filter(Boolean).join(', ');

  return {
    id:          Date.now().toString(),
    nom,
    prenom,
    name:        `${prenom} ${nom}`,
    tel,
    dob,

    // adresse structurée
    street:      rue,
    extra:       comp,
    zip:         cp,
    city:        ville,
    country:     'France',
    address,           // affichage court dans l'app
    addressFull,       // navigation Google Maps

    // coordonnées GPS (remplies après géocodage ou correction manuelle)
    lat:         null,
    lng:         null,
    geoScore:    0,

    // soins
    soin,
    preferredTime: heure,
    priority:    prio,
    urgent:      prio === 'Urgente',
    locked:      prio === 'Horaire fixe impératif',
    isRegular:   reg,

    // notes
    notes,

    // méta IA
    habitScore:  0,
    aiMeta:      { geoScore: 0, habitScore: 0, reliability: 0 },
  };
}

// ─────────────────────────────────────────────────────────────
//  Pré-remplissage en mode édition
// ─────────────────────────────────────────────────────────────
function fillForm(patient) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || '';
  };
  set('f-nom',      patient.nom);
  set('f-prenom',   patient.prenom);
  set('f-tel',      patient.tel);
  set('f-dob',      patient.dob);
  set('f-rue',      patient.street);
  set('f-comp',     patient.extra);
  set('f-cp',       patient.zip);
  set('f-ville',    patient.city);
  set('f-soin',     patient.soin);
  set('f-heure',    patient.preferredTime);
  set('f-priorite', patient.priority);
  set('f-regulier', patient.isRegular ? 'Oui' : 'Non');

  updateAdressePreview();
  validateCpVille();
  checkFormValidity();
}

// ─────────────────────────────────────────────────────────────
//  Sauvegarde patient (nouveau ou édition)
// ─────────────────────────────────────────────────────────────
async function savePatient(existingId = null) {
  const patient  = buildPatientObject();

  // géocodage immédiat en arrière-plan
  try {
    const addrForGeo = await processAddressBeforeGeocode(patient.addressFull, patient);
    const geo        = await smartGeocode(addrForGeo);
    const snapped    = await snapToRoad(geo.lat, geo.lng);

    patient.lat      = snapped.lat;
    patient.lng      = snapped.lng;
    patient.geoScore = computeGeoScore(addrForGeo, geo);
  } catch (e) {
    console.warn('[Geocode] Échec, patient enregistré sans coordonnées :', e.message);
    patient.geoScore = 0;
  }

  // sauvegarde IndexedDB
  const patients = await loadSecure('patients', 'list') || [];

  if (existingId) {
    const idx = patients.findIndex(p => p.id === existingId);
    if (idx !== -1) {
      patient.id    = existingId;
      patient.notes = patients[idx].notes; // préserver les notes existantes
      patients[idx] = patient;
    }
  } else {
    patients.push(patient);
  }

  await saveSecure('patients', 'list', patients);
  showToast(existingId ? 'Patient mis à jour' : 'Patient enregistré');
  return patient;
}

// ─────────────────────────────────────────────────────────────
//  Reset formulaire
// ─────────────────────────────────────────────────────────────
function resetPatientForm() {
  ['f-nom','f-prenom','f-tel','f-dob','f-rue','f-comp',
   'f-cp','f-ville','f-soin','f-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const heure = document.getElementById('f-heure');
  if (heure) heure.value = '08:00';

  const preview = document.getElementById('addr-preview');
  if (preview) preview.style.display = 'none';

  const geoSt = document.getElementById('geo-status');
  if (geoSt) geoSt.style.display = 'none';

  const warn = document.getElementById('warn-addr');
  if (warn)  warn.style.display = 'none';

  const btn = document.getElementById('btn-save-patient');
  if (btn)   btn.disabled = true;
}
