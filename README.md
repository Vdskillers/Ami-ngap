# App Infirmière — Guide d'intégration

## Fichiers générés

| Fichier | Rôle |
|---|---|
| `navigation.js` | Navigation GPS vers les patients |
| `geocode.js` | Géocodage multi-source + cache + corrections apprises |
| `patient-form.js` | Fiche patient avec adresse structurée + suggestions CP |
| `notes.js` | CRUD notes par patient (ajout / modification / suppression) |
| `map.js` | Carte Leaflet + tap-to-correct + drag marker |
| `ai-layer.js` | Couche IA silencieuse sur les 3 modes de tournée |
| `notes.css` | Styles pour notes, formulaire adresse, suggestions |

---

## Ordre d'inclusion dans votre HTML

```html
<!-- Leaflet (déjà présent) -->
<link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>

<!-- Styles -->
<link rel="stylesheet" href="notes.css" />

<!-- Modules app (ordre important) -->
<script src="geocode.js"></script>       <!-- 1. géocodage, pipeline adresse -->
<script src="navigation.js"></script>    <!-- 2. navigation GPS -->
<script src="patient-form.js"></script>  <!-- 3. formulaire patient -->
<script src="notes.js"></script>         <!-- 4. gestion notes -->
<script src="map.js"></script>           <!-- 5. carte + correction position -->
<script src="ai-tournee.js"></script>    <!-- 6. votre fichier IA existant -->
<script src="ai-layer.js"></script>      <!-- 7. couche IA silencieuse (APRÈS ai-tournee.js) -->
```

---

## Intégration fiche nouveau patient

### HTML du formulaire

```html
<div class="card">
  <div class="section-title">Identité</div>
  <div class="row2">
    <div class="field">
      <label>Nom</label>
      <input type="text" id="f-nom" placeholder="Dupont" />
    </div>
    <div class="field">
      <label>Prénom</label>
      <input type="text" id="f-prenom" placeholder="Marie" />
    </div>
  </div>
  <div class="row2">
    <div class="field">
      <label>Date de naissance</label>
      <input type="date" id="f-dob" />
    </div>
    <div class="field">
      <label>Téléphone</label>
      <input type="tel" id="f-tel" placeholder="06 00 00 00 00" />
    </div>
  </div>
</div>

<div class="card">
  <div class="section-title">Adresse</div>

  <!-- Ligne 1 : numéro + rue -->
  <div class="field">
    <label>Numéro et nom de rue</label>
    <input type="text" id="f-rue" placeholder="12 Rue Victor Hugo"
           autocomplete="street-address" />
  </div>

  <!-- Ligne 2 : complément -->
  <div class="field">
    <label>Complément</label>
    <input type="text" id="f-comp"
           placeholder="Bâtiment B, Appartement 14, Résidence Les Pins…" />
  </div>

  <!-- Ligne 3 : CP + ville + pays -->
  <div class="addr-full">
    <div class="field suggest-box">
      <label>Ville</label>
      <input type="text" id="f-ville" placeholder="Lyon"
             autocomplete="address-level2" />
      <div class="suggestions" id="sug-ville" style="display:none"></div>
    </div>

    <div class="field suggest-box">
      <label>Code postal</label>
      <input type="text" id="f-cp" placeholder="69003" maxlength="5"
             inputmode="numeric" autocomplete="postal-code" />
      <div class="suggestions" id="sug-cp" style="display:none"></div>
    </div>

    <div class="field">
      <label>Pays</label>
      <div class="country-badge">🇫🇷 France</div>
    </div>
  </div>

  <div class="warn-addr" id="warn-addr" style="display:none"></div>

  <div class="addr-preview" id="addr-preview" style="display:none">
    <strong>Adresse complète :</strong>
    <span id="preview-text"></span>
  </div>

  <div class="geo-status" id="geo-status" style="display:none">
    <div class="dot" id="geo-dot"></div>
    <span id="geo-label"></span>
  </div>
</div>

<!-- Champs cachés coordonnées GPS (correction manuelle) -->
<input type="hidden" id="t-lat" />
<input type="hidden" id="t-lng" />

<!-- Boutons correction position -->
<button onclick="enableCorrectionMode(
  parseFloat(document.getElementById('t-lat').value) || 48.8566,
  parseFloat(document.getElementById('t-lng').value) || 2.3522
)">
  Corriger position sur la carte
</button>
<button id="btn-confirm-pos" onclick="confirmCorrectedPosition(null)" style="display:none">
  Valider la position
</button>

<!-- Bouton save -->
<button id="btn-save-patient" disabled onclick="savePatient()">
  Enregistrer le patient
</button>
```

### Initialisation (dans votre DOMContentLoaded)

```javascript
document.addEventListener('DOMContentLoaded', () => {
  initPatientForm();           // active les suggestions CP/ville
});
```

---

## Intégration notes dans la fiche patient

### Dans la fiche patient existante, injecter :

```javascript
// après avoir chargé le patient
const notesHTML = getNoteFormHTML(patient.id);
document.getElementById('notes-wrapper').innerHTML = notesHTML;

// charger et afficher les notes existantes
renderNotes(patient, 'notes-container');

// mettre à jour le compteur
updateNotesCount(patient.id, patient.notes.length);
```

---

## Intégration navigation GPS

### Remplacer votre openNavigation() existant :

```javascript
// Dans votre bouton "Naviguer" sur la carte ou la liste patients :
openNavigation(patient);
// → utilise coordonnées GPS si geoScore >= 70
// → sinon adresse texte complète vers Google Maps (0€)
```

---

## Intégration couche IA dans la tournée

### Dans votre ai-tournee.js, remplacer l'appel à l'optimiseur :

```javascript
// AVANT (appel existant)
const sorted = optimiseTournee(patients, mode);

// APRÈS (avec couche IA)
const { patients: sorted, warnings, clusters } = await prepareSmartTournee(
  patients,
  mode,        // 'auto' | 'horaire' | 'mixte'
  context      // { distanceTo: fn, now: Date.now() }
);

// afficher les warnings si nécessaire
if (warnings.length) {
  warnings.forEach(w => console.warn('[IA]', w.message));
  // ou afficher dans votre UI
}
```

### Après chaque visite terminée :

```javascript
// appeler pour mémoriser les habitudes
await updateHabitScore(patient.id, Date.now());
```

---

## Flux adresse complet (du formulaire à la navigation)

```
Saisie utilisateur
    ↓
patient-form.js → buildPatientObject()
    → patient.street / .extra / .zip / .city
    → patient.addressFull  ("12 Rue Victor Hugo, 69003 Lyon, France")
    ↓
geocode.js → processAddressBeforeGeocode()
    → vérifie corrections apprises
    → normalise les abréviations
    → enrichit avec CP + ville + pays
    ↓
geocode.js → smartGeocode()
    → Photon → Nominatim → cache IndexedDB
    → patient.lat / .lng / .geoScore
    ↓
navigation.js → openNavigation()
    → si geoScore >= 70 : coordonnées GPS directes
    → sinon : addressFull → Google Maps géocode
```

---

## Codes postaux — étendre la base

Le fichier `patient-form.js` contient `CP_DATA`. Pour ajouter votre département :

```javascript
// Exemple ajout département 01 (Ain)
{cp:"01000",ville:"Bourg-en-Bresse"},
{cp:"01100",ville:"Oyonnax"},
{cp:"01200",ville:"Bellegarde-sur-Valserine"},
// ...
```

Pour une base complète, la liste officielle La Poste est disponible gratuitement :
https://datanova.laposte.fr/datasets/laposte-hexasmal
