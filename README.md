# AMI NGAP — Documentation technique v5.0

> Assistant infirmier intelligent · Cotation NGAP · Tournée IA · PWA offline · Sécurité HDS

---

## Sommaire

1. [Structure du projet](#1-structure-du-projet)
2. [Ordre de chargement](#2-ordre-de-chargement)
3. [Architecture globale](#3-architecture-globale)
4. [Store APP observable (utils.js)](#4-store-app-observable-utilsjs)
5. [Modules frontend — référence](#5-modules-frontend--référence)
6. [Backend Cloudflare Worker](#6-backend-cloudflare-worker)
7. [Base de données Supabase](#7-base-de-données-supabase)
8. [Moteur IA de tournée (ai-tournee.js)](#8-moteur-ia-de-tournée-ai-tourneejs)
9. [Assistant vocal IA (ai-assistant.js)](#9-assistant-vocal-ia-ai-assistantjs)
10. [Sécurité RGPD / HDS (security.js)](#10-sécurité-rgpd--hds-securityjs)
11. [PWA & Offline (pwa.js + sw.js)](#11-pwa--offline-pwajs--swjs)
12. [Carte premium (map.js)](#12-carte-premium-mapjs)
13. [RBAC — Permissions](#13-rbac--permissions)
14. [API Endpoints — référence complète](#14-api-endpoints--référence-complète)
15. [Variables d'environnement & configuration](#15-variables-denvironnement--configuration)
16. [Déploiement](#16-déploiement)
17. [Guide "je veux modifier…"](#17-guide-je-veux-modifier)
18. [Debug & développement](#18-debug--développement)

---

## 1. Structure du projet

```
Ami-ngap/
│
├── index.html              # Shell HTML — structure + liens scripts uniquement
├── manifest.json           # PWA — installable sur mobile/desktop
├── sw.js                   # Service Worker — offline, cache tiles, sync
│
├── css/
│   └── style.css           # Tout le CSS : variables, layout, composants, mobile
│
└── js/
    ├── utils.js            # ⭐ Utilitaires globaux — chargé EN PREMIER
    ├── auth.js             # Authentification, session, RBAC client
    ├── security.js         # RGPD/HDS — AES-256, consentement, PIN, audit
    ├── admin.js            # Panel administrateur
    ├── profil.js           # Modale profil utilisateur
    ├── cotation.js         # Cotation NGAP + PDF + Vérification IA
    ├── voice.js            # Dictée vocale — pont vers ai-assistant.js
    ├── dashboard.js        # Dashboard & statistiques
    ├── ui.js               # Navigation, mobile, bindings — chargé EN DERNIER
    ├── map.js              # Carte Leaflet premium + GPS     ← dépend de Leaflet
    ├── uber.js             # Mode Uber Médical temps réel    ← dépend de map.js
    ├── ai-tournee.js       # Moteur IA tournée VRPTW + 2-opt ← dépend de utils.js
    ├── ai-assistant.js     # NLP + ML prédictif + LLM + TTS  ← dépend de utils.js
    ├── pwa.js              # PWA : install, IDB, cartes offline, sync
    └── tournee.js          # Tournée + Import + Live         ← dépend de tout
```

> **Règle d'emplacement :**
> - **Racine** → `index.html`, `manifest.json`, `sw.js` uniquement
> - **`js/`** → tous les modules JavaScript
> - **`css/`** → feuilles de style

---

## 2. Ordre de chargement

L'ordre dans `index.html` est **critique** — chaque module dépend de ceux chargés avant lui.

```html
<!-- ① Base absolue — aucune dépendance -->
<script src="js/utils.js"></script>

<!-- ② Modules fonctionnels — dépendent de utils.js -->
<script src="js/auth.js"></script>
<script src="js/security.js"></script>  <!-- doit être après auth.js -->
<script src="js/admin.js"></script>
<script src="js/profil.js"></script>
<script src="js/cotation.js"></script>
<script src="js/voice.js"></script>
<script src="js/dashboard.js"></script>

<!-- ③ UI — doit être après TOUS les modules (contient checkAuth + bindings) -->
<script src="js/ui.js"></script>

<!-- ④ Leaflet CDN — requis avant map/uber/tournee -->
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<!-- ⑤ Modules Leaflet-dépendants -->
<script src="js/map.js"></script>
<script src="js/uber.js"></script>

<!-- ⑥ Moteurs IA (pas de dépendance Leaflet) -->
<script src="js/ai-tournee.js"></script>
<script src="js/ai-assistant.js"></script>
<script src="js/pwa.js"></script>

<!-- ⑦ Tournée — dépend de tout ce qui précède -->
<script src="js/tournee.js"></script>
```

---

## 3. Architecture globale

```
┌─────────────────────────────────────────────────────────┐
│                     FRONTEND PWA                        │
│                                                         │
│  ┌─────────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │ utils.js│  │security.js│  │     ai-tournee.js      │ │
│  │ APP store│  │AES-256   │  │  VRPTW + 2-opt + cache │ │
│  │observable│  │RGPD/HDS  │  │  OSRM + lookahead      │ │
│  └────┬────┘  └──────────┘  └────────────────────────┘ │
│       │                                                 │
│  ┌────▼──────────────────────────────────────────────┐  │
│  │              APP.state (observable)               │  │
│  │  userPos · startPoint · uberPatients · nextPatient│  │
│  └────┬──────────────────────────────────────────────┘  │
│       │ APP.set() → CustomEvent('app:update')           │
│  ┌────▼────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │  map.js │  │  uber.js │  │    ai-assistant.js     │ │
│  │ Leaflet │  │ GPS live │  │  NLP + ML + LLM + TTS  │ │
│  │ premium │  │ throttlé │  │  Navigation vocale      │ │
│  └─────────┘  └──────────┘  └────────────────────────┘ │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │                   pwa.js + sw.js                 │   │
│  │  Service Worker · IDB chiffré · Tiles offline    │   │
│  │  Sync queue · Install prompt · Bannière réseau   │   │
│  └──────────────────────────────────────────────────┘   │
└────────────────────┬────────────────────────────────────┘
                     │ HTTPS (Bearer token)
┌────────────────────▼────────────────────────────────────┐
│              Cloudflare Worker v4.0                     │
│  Auth · RBAC · NGAP · Prescripteurs · Factures         │
│  Fraud score · Audit logs · Admin sécurisé             │
└────────────────────┬────────────────────────────────────┘
          ┌──────────┴──────────┐
          │                     │
┌─────────▼──────┐   ┌─────────▼──────┐
│   Supabase DB  │   │    N8N (n8n-   │
│  infirmieres   │   │  l678.onrender)│
│  sessions      │   │  Cotation IA   │
│  planning_pats │   │  Historique    │
│  prescripteurs │   │  Planning      │
│  audit_logs    │   └────────────────┘
│  invoice_cntrs │
└────────────────┘
```

---

## 4. Store APP observable (utils.js)

### Lecture / Écriture

```js
// Écriture réactive → dispatch CustomEvent('app:update')
APP.set('userPos', { lat: 43.7, lng: 7.25 });

// Lecture
const pos = APP.get('userPos');

// Accès direct (propriétés avec getter/setter)
APP.startPoint = { lat, lng };  // équivalent à APP.set('startPoint', ...)
```

### Écoute réactive

```js
// S'abonner à un changement de clé
APP.on('userPos', (newPos, prevPos) => {
  updateMapMarker(newPos);
});

APP.on('nextPatient', (patient) => {
  renderPatientCard(patient);
});
```

### Clés disponibles dans `APP.state`

| Clé | Type | Description |
|---|---|---|
| `user` | Object | Utilisateur connecté `{id, email, nom, prenom, adeli, rpps}` |
| `token` | String | JWT session |
| `role` | String | `'nurse'` ou `'admin'` |
| `startPoint` | `{lat,lng}` | Point de départ tournée |
| `userPos` | `{lat,lng}` | Position GPS live (throttlée 3s) |
| `importedData` | Object | Données importées depuis calendrier |
| `uberPatients` | Array | Patients du mode Uber (avec done/absent/late) |
| `nextPatient` | Object | Prochain patient recommandé par l'IA |

### Namespace `APP.map`

Défini par `map.js` après `initDepMap()` :

```js
APP.map.instance       // Instance L.map Leaflet
APP.map.setUserMarker(lat, lng)   // Marker position infirmière
APP.map.centerMap(lat, lng, zoom) // Centrer la carte
```

### Mode debug

```js
APP.debug = true;   // Activer les logs [AMI] dans la console
```

### Alias rétrocompatibles (anciens accès directs)

```js
window.START_POINT    // → APP.state.startPoint (réactif)
window.USER_POS       // → APP.state.userPos (réactif)
window.IMPORTED_DATA  // → APP.state.importedData (réactif)
window.UBER_PATIENTS  // → APP.state.uberPatients (réactif)
window.NEXT_PATIENT   // → APP.state.nextPatient (réactif)
```

---

## 5. Modules frontend — référence

### `utils.js` — Socle commun

| Fonction | Description |
|---|---|
| `APP.set(key, value)` | Écriture réactive |
| `APP.get(key)` | Lecture état |
| `APP.on(key, fn)` | Écoute réactive |
| `assertDep(cond, msg)` | Guard dépendances inter-modules |
| `requireAuth()` | Guard session — redirige login si expiré |
| `wpost(path, body)` | POST API avec retry ×2 (timeout 35s) |
| `apiCall(path, body)` | Alias de `wpost` |
| `fetchAPI(url, opts)` | GET API avec auth |
| `sanitize(str)` | Échappe `< > ' "` |
| `debounce(fn, ms)` | Anti-rebond |
| `throttle(fn, ms)` | Limite fréquence (GPS) |
| `log(...args)` | Console.log si `APP.debug` |
| `logWarn(...args)` | Console.warn si `APP.debug` |
| `logErr(...args)` | Console.error (toujours actif) |
| `showM(id, txt, type)` | Affiche message (`'e'`=erreur, `'o'`=succès) |
| `hideM(...ids)` | Masque des éléments |
| `ld(id, on)` | État loading d'un bouton |
| `$(id)` | `document.getElementById` |
| `gv(id)` | Valeur d'un input (trimmed) |
| `fmt(n)` | Nombre → `"12.50 €"` |

### `auth.js` — Authentification v4.0

| Fonction | Description |
|---|---|
| `checkAuth()` | Vérifie consentement RGPD + session au démarrage |
| `login()` | POST `/webhook/auth-login` + `initSecurity()` |
| `register()` | POST `/webhook/infirmiere-register` |
| `logout()` | Vide session, store APP, localStorage partiel |
| `showApp()` | Affiche l'app après login (adapte UI selon rôle) |
| `showAdm()` | Affiche le panel admin |
| `clientHasPermission(perm)` | Vérifie permission côté client (miroir worker) |
| `loadPrescripteurs()` | Charge la liste des médecins (nurse only) |
| `addPrescripteur()` | Ajoute un médecin prescripteur |
| `displayInvoiceNumber(num)` | Affiche le N° facture retourné par le worker |
| `refreshMapSize()` | `invalidateSize()` Leaflet après changement layout |

### `security.js` — RGPD / HDS v1.0

| Fonction | Description |
|---|---|
| `initSecurity(token)` | Initialise clé AES + audit log + timer PIN |
| `encryptData(obj)` | Chiffre objet JS → `{data, iv}` base64 |
| `decryptData(payload)` | Déchiffre → objet JS |
| `encryptField(str)` | Chiffre un champ string |
| `decryptField(json)` | Déchiffre un champ string |
| `saveSecure(store, id, val)` | IDB chiffré — écriture |
| `loadSecure(store, id)` | IDB chiffré — lecture |
| `loadAllSecure(store)` | IDB chiffré — lecture complète |
| `clearSecureStore(store)` | Vide un store IDB |
| `checkConsent()` | Vérifie consentement RGPD — bloque si absent |
| `showConsentModal()` | Modale onboarding RGPD |
| `acceptConsent()` | Accepte + init clé AES |
| `revokeConsent()` | Purge données + réaffiche modale |
| `exportMyData()` | Télécharge JSON export RGPD |
| `purgeLocalData()` | Efface IDB + caches PWA + ML stats |
| `cleanOldLogs()` | Purge auto audit > 90 jours |
| `auditLocal(action, detail)` | Log chiffré action sensible |
| `setupPIN(pin)` | Hache + sauvegarde PIN (SHA-256) |
| `checkPIN(pin)` | Vérifie PIN |
| `lockApp()` | Affiche écran verrouillage |
| `unlockApp()` | Vérifie PIN + déverrouille |
| `stripSensitive(data)` | Masque NIR, ADELI, champs patients |

### `admin.js` — Panel admin v4.0

| Fonction | Description |
|---|---|
| `loadAdm()` | Liste comptes infirmiers + stats sécurité |
| `loadAdmStats()` | KPIs globaux anonymisés |
| `loadAdmLogs()` | Journal d'audit (200 derniers) |
| `loadAdmSecurityStats()` | Échecs login + alertes fraude |
| `admAct(action, id, name)` | Bloquer / débloquer / supprimer compte |
| `filterAccs()` | Filtre la liste par nom |

> ⚠️ **RGPD** : les admins ne voient jamais de données patient. `toAdminView()` côté worker garantit que seuls `id`, `nom`, `prenom`, `is_blocked` sont retournés.

### `cotation.js` — Cotation NGAP

| Fonction | Description |
|---|---|
| `cotation()` | Appel IA NGAP + affichage résultat + `displayInvoiceNumber()` |
| `renderCot(d)` | Rendu HTML résultat cotation |
| `printInv(d)` | Vérifie infos pro → PDF dans nouvelle fenêtre |
| `openVerify()` | Ouvre modale vérification IA |
| `applyVerify()` | Applique corrections IA dans le formulaire |
| `clrCot()` | Réinitialise formulaire + masque N° facture |
| `coterDepuisRoute(desc)` | Pré-remplit cotation depuis tournée |
| `verifyStandalone()` | Vérification IA indépendante |

> **Prescripteur** : le `prescripteur_id` du select est envoyé dans le payload. Le worker hydrate les infos du médecin (nom, RPPS, spécialité) depuis la table `prescripteurs` et les inclut dans la facture PDF.

> **N° de facture** : généré côté worker (`F{ANNÉE}-{ID6}-{SEQ6}`), jamais côté client. Unique, séquentiel, verrouillé après génération.

### `voice.js` — Dictée vocale

| Fonction | Description |
|---|---|
| `toggleVoice()` | Démarre / arrête la reconnaissance |
| `startVoice()` | Initialise SR + active `startHandsFree()` |
| `stopVoice()` | Arrête SR + `stopHandsFree()` + `stopVoiceNavigation()` |
| `handleVoice(transcript, confidence)` | Délègue à `handleAICommand()` (si chargé) sinon règles NGAP natives |
| `normalizeMedical(txt)` | Normalise terminologie médicale vocale |

### `dashboard.js` — Statistiques

| Fonction | Description |
|---|---|
| `loadDash()` | Charge données API + cache 1 min |
| `renderDashboard(arr)` | KPIs, graphique 30j, top actes, prévision |
| `detectAnomalies(rows, daily)` | Détection écarts-types (σ) |
| `explainAnomalies(rows, result)` | Explication contextuelle |
| `suggestOptimizations(rows)` | IFD oubliés, majorations, ALD |
| `forecastRevenue(daily)` | Prévision linéaire fin de mois |
| `computeLoss(rows)` | Perte estimée (IFD/IK/majorations) |

### `ui.js` — Navigation v5.0

| Fonction | Description |
|---|---|
| `navTo(v, triggerEl)` | Navigation + dispatch `CustomEvent('ui:navigate')` |
| `updateNavMode()` | Affiche/masque bottom nav mobile |
| `toggleMobileMenu()` | Menu "Plus" mobile |
| `filterFaq()` | Recherche dans l'aide |

> Les effets de bord de navigation (loadDash, initDepMap, invalidateSize) sont dans un listener `ui:navigate` — pas dans `navTo()` directement.

### `map.js` — Carte premium v5.0

| Fonction | Description |
|---|---|
| `initDepMap()` | Init Leaflet + `APP.map.register()` |
| `getGPS()` | GPS avec contrôle précision (±100m/500m/5km) |
| `geocodeAddress()` | Adresse → coordonnées (Nominatim) |
| `reverseGeocode(lat, lng)` | Coordonnées → adresse lisible |
| `setDepCoords(lat, lng)` | Met à jour `APP.startPoint` (réactif) |
| `createPatientMarker(p)` | Marker card style Uber (heure + nom) |
| `addNumberedMarkers(patients)` | Cercles numérotés verts sur carte |
| `drawRoute(points)` | Tracé OSRM ligne `#00d4aa` |
| `renderTimeline(patients)` | Timeline tournée sous la carte |
| `focusPatient(p)` | `flyTo` animé vers patient |
| `toggleMapFullscreen()` | Mode plein écran (Échap pour fermer) |
| `renderPatientsOnMap(patients, start)` | Pipeline complet : markers + route + timeline + zoom |

> **Hauteur map** : `clamp(220px, 50vh, 560px)` — mobile 220px, desktop ~500px.

### `uber.js` — Mode Uber Médical v5.0

| Fonction | Description |
|---|---|
| `startLiveTracking()` | GPS continu throttlé 3s, `maximumAge:10000` |
| `stopLiveTracking()` | Arrête watchPosition + intervalle |
| `selectBestPatient()` | Tri euclidien + OSRM top5 + `APP.set('nextPatient')` |
| `loadUberPatients()` | Charge depuis `APP.importedData` |
| `markUberDone()` | Patient terminé + `selectBestPatient()` |
| `markUberAbsent()` | Patient absent + `selectBestPatient()` |
| `recalcRouteUber()` | Recalcul OSRM complet des patients restants |
| `openNavigation(p)` | Google Maps direct vers le patient |
| `detectDelaysUber()` | Marque `p.late = true` si > 15min de dépassement |

---

## 6. Backend Cloudflare Worker

- **URL** : `https://raspy-tooth-1a2f.vdskillers.workers.dev`
- **Auth** : `Authorization: Bearer <token>` sur toutes les routes sauf `/auth-login` et `/infirmiere-register`
- **NGAP version courante** : `2025.1`

### Constantes

| Constante | Valeur |
|---|---|
| `SALT` | `'inf2026salt'` |
| `PATIENT_SALT` | `'patient_anon_salt_2026'` |
| `SUPA_URL` | `https://ycsprblaruusaegohcid.supabase.co/rest/v1` |
| `N8N_URL` | `https://n8n-l678.onrender.com` |
| `ADMIN_EMAILS` | `['vdskillers@hotmail.com', 'julien.bonomelli@gmail.com']` |

### RBAC — Permissions worker

```
nurse : create_invoice · view_own_data · import_calendar
        manage_tournee · change_password · delete_account
        manage_prescripteurs

admin : block_user · unblock_user · delete_user
        view_stats · view_logs · view_users_list
        ⚠️ view_patient_data intentionnellement ABSENT
```

### Score fraude (automatique sur cotation NGAP)

| Condition | Points |
|---|---|
| Total > 100€ | +15 |
| Total > 200€ | +25 |
| Acte de nuit sans heure | +30 |
| Distance > 150km | +25 |
| > 20 patients/jour | +40 |
| > 50km ET > 20 patients | +40 |
| Acte en double | +50 |

> Score ≥ 70 → log dans `audit_logs` avec `event: 'COTATION_FRAUD_ALERT'`

### N° facture séquentiel

Format : `F{ANNÉE}-{ID_COURT}-{SEQ6}`
Exemple : `F2026-A3F2B1-000042`

Généré côté serveur uniquement, stocké avec `locked: true` dans `planning_patients`. Utilisé tel quel par la CPAM.

---

## 7. Base de données Supabase

### Tables principales

| Table | Description |
|---|---|
| `infirmieres` | Comptes infirmières (email, password_hash, adeli, rpps, role) |
| `sessions` | Tokens de session (`infirmiere_id`, `token`) |
| `planning_patients` | Cotations / passages (`invoice_number`, `ngap_version`, `locked`) |
| `prescripteurs` | Médecins prescripteurs (`nom`, `rpps`, `specialite`) |
| `invoice_counters` | Compteurs séquentiels par infirmière |
| `audit_logs` | Journal d'audit (`user_id`, `event`, `score`, `ip`, `meta`) |

### SQL requis (à exécuter dans Supabase SQL Editor)

```sql
-- Désactiver RLS (ou utiliser service_role key)
ALTER TABLE infirmieres DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE planning_patients DISABLE ROW LEVEL SECURITY;

-- Tables v4.0
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID, event TEXT, score INT, ip TEXT,
  meta JSONB, created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prescripteurs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL, rpps TEXT UNIQUE,
  specialite TEXT, adresse TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_counters (
  infirmiere_id UUID PRIMARY KEY,
  last_seq INT DEFAULT 0
);

-- Colonnes ajoutées à planning_patients
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS prescripteur_id UUID;
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS invoice_number TEXT UNIQUE;
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS ngap_version TEXT DEFAULT '2025.1';
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false;

-- Index performance
CREATE INDEX IF NOT EXISTS idx_user_id_planning    ON planning_patients(user_id);
CREATE INDEX IF NOT EXISTS idx_infirmiere_planning ON planning_patients(infirmiere_id);
CREATE INDEX IF NOT EXISTS idx_invoice_number      ON planning_patients(invoice_number);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user     ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event    ON audit_logs(event);
```

### Variable Cloudflare Workers (obligatoire)

```
Nom   : SUPABASE_SERVICE_KEY
Valeur: [service_role key Supabase]
        Dashboard Supabase → Settings → API → service_role
Cocher "Chiffrer"
```

---

## 8. Moteur IA de tournée (ai-tournee.js)

Architecture **VRPTW** (Vehicle Routing Problem with Time Windows) 100% client-side.

### Pipeline d'optimisation

```
patients importés
      ↓
optimizeTour()        ← Greedy VRPTW + OSRM + cache + lookahead 2 niveaux
      ↓
twoOpt()              ← Amélioration post-greedy (max 50 itérations)
      ↓
scoreTourneeRentabilite() ← €/h, €/km, km totaux
      ↓
renderPatientsOnMap() ← Markers + route + timeline
      ↓
startLiveOptimization() ← Recalcul réactif via APP.on('userPos')
```

### Fonctions clés

| Fonction | Description |
|---|---|
| `optimizeTour(patients, start)` | Greedy VRPTW avec fenêtres temporelles |
| `twoOpt(route)` | Optimisation 2-opt (O(n²), cap 50 iter) |
| `cachedTravel(a, b)` | OSRM + cache 10 min (clé arrondie 4 décimales) |
| `medicalWeight(p)` | Score priorité médicale NGAP (+200 urgent, +80 insuline…) |
| `dynamicScore({currentTime, travelTime, patient, userPos})` | Score multi-critères |
| `simulateLookahead(from, remaining, depth)` | Anticipation N étapes (depth=2) |
| `recomputeRoute()` | Recalcul live (top 6 candidats euclidiens → OSRM) |
| `startLiveOptimization()` | Listener `APP.on('userPos')` throttlé 5s + fallback 20s |
| `addUrgentPatient(patient)` | Insertion urgente + recalcul |
| `cancelPatient(patientId)` | Suppression + recalcul |
| `learnFromVisit(log)` | Mise à jour `USER_STATS` (moyenne mobile α=0.2) |
| `scoreTourneeRentabilite(route)` | `{euro_heure, euro_km, total_km, nb_patients}` |

### Fenêtres temporelles

Les heures patients (`heure_soin: "09:30"`) sont converties en fenêtre `[start-30, start+90]` minutes. Si arrivée > fenêtre haute → pénalité `+2000`. Si arrivée < fenêtre basse → pénalité proportionnelle `×0.5`.

---

## 9. Assistant vocal IA (ai-assistant.js)

### Pipeline NLP

```
parole → voice.js → handleVoice()
                         ↓
                  handleAICommand(transcript, confidence)
                         ↓
                    processNLP()
                   ┌────────────────────────┐
                   │ normalize()            │  synonymes, accents
                   │ detectIntent()         │  scoring multi-mots-clés
                   │ extractEntities()      │  actes NGAP, heure, km, nom
                   └────────────────────────┘
                         ↓
                  _dispatchIntent()  →  action
                         ↓
                   generateVocalResponse()
                         ↓
                    speak()  (TTS fr-FR)
```

### Intentions reconnues

| Intent | Mots-clés déclencheurs | Action |
|---|---|---|
| `ADD_CARE` | ajoute, réalise, acte, soin | Pré-remplit `f-txt` |
| `NAVIGATE` | vas, suivant, prochain, route | `startVoiceNavigation()` |
| `PATIENT_DONE` | terminé, fini, vu, ok | `liveAction('patient_done')` |
| `PATIENT_ABSENT` | absent, personne, pas là | `liveAction('patient_absent')` |
| `URGENT` | urgence, urgent, prioritaire | `addUrgentPatient()` |
| `COTATION` | facture, coter, calculer | `cotation()` |
| `VERIFY` | vérifier, corriger | `openVerify()` |
| `STATUS` | combien, restant, état | Annonce nb patients restants |
| `CLEAR` | effacer, réinitialiser, reset | `clrCot()` |
| `STOP` | stop, arrêter, couper | `stopVoice()` |

### ML prédictif (apprentissage local)

Les statistiques sont persistées dans `localStorage` (`ami_ml_stats`) :

```js
ML.duration[type]   // durée moyenne par type de soin
ML.travel[zone]     // ratio trajet réel/estimé par zone 2km
ML.delays[hour]     // taux de retard par heure
```

Mise à jour après chaque visite avec `learnFromVisit()`.

### LLM offline (optionnel)

- **Modèle** : `Llama-3.2-1B-Instruct-q4f16_1` (~600 Mo)
- **Pré-requis** : Chrome avec WebGPU activé
- **Activation** : bouton "🤖 Activer IA locale" dans le voice-toast
- **Cache** : 50 réponses LRU en mémoire
- **Usage** : fallback uniquement quand NLP local ne reconnaît pas la commande

### Navigation GPS vocale

`startVoiceNavigation(patient)` :
1. Récupère étapes OSRM (`steps=true`)
2. Traduit manœuvres en français (`_osrmManeuverToFR`)
3. Annonce à < 200m (pré-annonce) et < 80m (exécution)
4. `checkDeviation()` toutes les 15s — recalcul si > 300m du prochain point

---

## 10. Sécurité RGPD / HDS (security.js)

### Architecture "Privacy by Design"

```
Token login
    ↓
initSessionKey(token)   ← PBKDF2 (100k itérations) → clé AES-256
    ↓
_sessionKey             ← en mémoire vive UNIQUEMENT (jamais persistée)
    ↓
encryptData() / decryptData()   ← AES-256-GCM, IV aléatoire par opération
    ↓
saveSecure('s_patients', id, data)   ← IDB chiffré (ami-secure v2)
```

### Stores IndexedDB chiffrés (`ami-secure`)

| Store | Contenu | TTL |
|---|---|---|
| `s_patients` | Données patients offline | Session |
| `s_sync` | Queue sync offline | Jusqu'à envoi |
| `s_audit` | Journal actions sensibles | 90 jours (purge auto) |
| `prefs` | Consentement, préférences | Permanent |

### Consentement RGPD

- Vérifié à **chaque démarrage** (`checkAuth()`)
- Sans consentement → app bloquée
- Révocation → purge complète + réaffichage modale

### PIN local

- Verrouillage auto après **10 min d'inactivité**
- PIN haché SHA-256 + sel avant stockage
- Réinitialisation timer à chaque `click`, `keydown`, `touchstart`

### Actions auditées localement

`LOGIN`, `APP_UNLOCK`, `APP_LOCK`, `EXPORT_DATA`, `COTATION_NGAP`, `PRESCRIPTEUR_ADD`, `PASSWORD_CHANGE`, `ACCOUNT_DELETED_SELF`, `ADMIN_BLOCK_USER`, `ADMIN_DELETE_USER`

### Ce que les admins ne peuvent PAS voir

- Données patients (nom, prénom, NIR, DDN)
- Détail des factures
- Données prescripteurs des patients
- Logs de cotation individuels

---

## 11. PWA & Offline (pwa.js + sw.js)

### Stratégies de cache (sw.js)

| Type de ressource | Stratégie |
|---|---|
| Assets app (HTML, CSS, JS) | Cache-first |
| API Cloudflare Worker | Network-first (timeout 8s) |
| Tiles OpenStreetMap | Stale-while-revalidate |
| Polices Google / Leaflet CDN | Cache-first |

### Installation PWA

Bouton "📱 Installer AMI" apparaît automatiquement sur les navigateurs compatibles (Chrome Android, Edge, Chrome desktop). Shortcuts configurés : Cotation rapide, Tournée du jour.

### Cartes offline

```js
// Télécharge ~15km autour du point de départ (zooms 12-14)
await downloadCurrentArea();

// Ou une zone personnalisée
await downloadMapArea({
  minLat: 43.6, maxLat: 43.8,
  minLng: 7.1,  maxLng: 7.4
}, [12, 13, 14]);
```

> Estimation : ~200-400 tiles pour 15km de rayon aux zooms 12-14.

### Sync offline

Les données créées hors ligne sont mises en queue dans `s_sync` (IDB). À la reconnexion :
1. `window.addEventListener('online', ...)` déclenche `_flushOfflineQueue()`
2. Ou le Service Worker via Background Sync tag `ami-offline-sync`

### Stockage chiffré (intégration pwa.js ↔ security.js)

`saveOfflinePatients()` et `loadOfflinePatients()` détectent automatiquement si `security.js` est chargé et utilisent `saveSecure()` / `loadSecure()` à la place de l'IDB non chiffré.

---

## 12. Carte premium (map.js)

### Hauteur responsive

```css
#dep-map { height: clamp(220px, 50vh, 560px); }
@media(max-width:768px) { #dep-map { height: 220px; } }
```

### Mode plein écran

```js
toggleMapFullscreen();   // Active/désactive
// Fermer avec bouton "✕ Réduire" ou touche Échap
```

### Rendu tournée complète

```js
// Appelé automatiquement après optimiserTournee()
await renderPatientsOnMap(route, startPoint);
// → markers numérotés + tracé OSRM + timeline + zoom auto
```

---

## 13. RBAC — Permissions

### Côté client (auth.js)

```js
clientHasPermission('manage_prescripteurs')  // nurse only
clientHasPermission('view_stats')            // admin only
```

### Côté serveur (worker.js)

```js
hasPermission('nurse', 'create_invoice')     // true
hasPermission('admin', 'view_patient_data')  // false (intentionnel)
```

> La vérification client est **uniquement cosmétique** (afficher/masquer UI). Chaque route worker re-valide les permissions indépendamment.

---

## 14. API Endpoints — référence complète

### Routes publiques (sans auth)

| Méthode | Endpoint | Description |
|---|---|---|
| POST | `/webhook/auth-login` | Connexion — retourne token + role + user |
| POST | `/webhook/infirmiere-register` | Inscription |

### Routes infirmière (nurse)

| Méthode | Endpoint | Description |
|---|---|---|
| POST | `/webhook/profil-get` | Récupère profil |
| POST | `/webhook/profil-save` | Met à jour profil |
| POST | `/webhook/change-password` | Changement mot de passe |
| POST | `/webhook/delete-account` | Suppression compte |
| POST | `/webhook/prescripteur-liste` | Liste médecins prescripteurs |
| POST | `/webhook/prescripteur-add` | Ajoute un médecin |
| POST | `/webhook/prescripteur-get` | Détails d'un médecin |
| POST | `/webhook/import-calendar` | Import ICS/CSV/JSON/TXT |
| POST | `/webhook/ami-tournee-ia` | Optimisation tournée (fallback API) |
| POST | `/webhook/ami-live` | Pilotage live (done/absent/status) |
| POST | `/webhook/ami-calcul` | Cotation NGAP + génération N° facture |
| POST | `/webhook/ami-historique` | Historique cotations |
| POST | `/webhook/ami-supprimer` | Suppression cotation |

### Routes admin uniquement

| Méthode | Endpoint | Description |
|---|---|---|
| POST | `/webhook/admin-liste` | Liste comptes (nom+prénom+statut) |
| POST | `/webhook/admin-stats` | KPIs anonymisés |
| POST | `/webhook/admin-logs` | Journal d'audit (200 derniers) |
| POST | `/webhook/admin-security-stats` | Échecs login + alertes fraude |
| POST | `/webhook/admin-bloquer` | Suspend un compte |
| POST | `/webhook/admin-debloquer` | Réactive un compte |
| POST | `/webhook/admin-supprimer` | Supprime définitivement un compte |

### Format réponse standard

```json
{ "ok": true, "data": ... }
{ "ok": false, "error": "Message d'erreur lisible" }
```

---

## 15. Variables d'environnement & configuration

### Cloudflare Workers

| Variable | Description | Où configurer |
|---|---|---|
| `SUPABASE_SERVICE_KEY` | Clé service_role Supabase | Workers → Settings → Variables |

### Fichiers à modifier pour changer de projet

| Fichier | Variable | Description |
|---|---|---|
| `worker.js` | `SUPA_URL` | URL Supabase REST |
| `worker.js` | `N8N_URL` | URL instance n8n |
| `worker.js` | `ADMIN_EMAILS` | Emails administrateurs |
| `worker.js` | `NGAP_VERSION_CURRENT` | Version NGAP active |
| `utils.js` | `W` | URL Cloudflare Worker |

---

## 16. Déploiement

### Structure de déploiement recommandée

```
Cloudflare Pages / GitHub Pages / Render
├── index.html
├── manifest.json        ← racine obligatoire
├── sw.js                ← racine obligatoire (scope SW)
├── css/style.css
└── js/
    ├── utils.js
    ├── auth.js
    ├── security.js
    ├── admin.js
    ├── profil.js
    ├── cotation.js
    ├── voice.js
    ├── dashboard.js
    ├── ui.js
    ├── map.js
    ├── uber.js
    ├── ai-tournee.js
    ├── ai-assistant.js
    ├── pwa.js
    └── tournee.js
```

### Prérequis

- **HTTPS obligatoire** — Service Worker, GPS, Web Crypto API, Speech Recognition ne fonctionnent qu'en HTTPS
- **Chrome / Edge recommandé** — pour Speech Recognition et WebGPU (LLM offline)
- **WebGPU optionnel** — uniquement pour le LLM local (Llama)

### Checklist déploiement

- [ ] Variable `SUPABASE_SERVICE_KEY` configurée dans Cloudflare Workers
- [ ] Tables Supabase créées (SQL section 7)
- [ ] RLS désactivé ou service_role key configurée
- [ ] `ADMIN_EMAILS` mis à jour dans `worker.js`
- [ ] URL Worker (`W` dans `utils.js`) correcte
- [ ] Icônes PWA créées dans `/icons/` (72, 96, 128, 144, 152, 192, 384, 512px)
- [ ] Domaine en HTTPS

---

## 17. Guide "je veux modifier…"

| Je veux modifier… | Fichier(s) |
|---|---|
| Le formulaire de cotation | `js/cotation.js` |
| Le PDF de facture | `js/cotation.js` → `_doPrint()` |
| Le calcul de tournée | `js/ai-tournee.js` |
| La carte / GPS | `js/map.js` |
| Le mode Uber temps réel | `js/uber.js` |
| L'assistant vocal | `js/ai-assistant.js` |
| La dictée (pipeline voix) | `js/voice.js` |
| Les commandes vocales | `js/ai-assistant.js` → `NLP_INTENTS` + `_dispatchIntent()` |
| L'import calendrier | `js/tournee.js` |
| Le pilotage live | `js/tournee.js` |
| Le dashboard | `js/dashboard.js` |
| La connexion / inscription | `js/auth.js` |
| Les prescripteurs | `js/auth.js` + worker routes `/prescripteur-*` |
| Le panel admin | `js/admin.js` |
| La sécurité / chiffrement | `js/security.js` |
| Le consentement RGPD | `js/security.js` → `showConsentModal()` |
| Le PIN de verrouillage | `js/security.js` → `setupPIN()` / `lockApp()` |
| L'offline / cache PWA | `js/pwa.js` + `sw.js` |
| Les cartes offline | `js/pwa.js` → `downloadMapArea()` |
| La navigation mobile | `js/ui.js` |
| Les couleurs / design | `css/style.css` |
| La structure HTML | `index.html` |
| Les routes API | `worker.js` |
| La base de données | Supabase SQL Editor |
| La version NGAP | `worker.js` → `NGAP_VERSION_CURRENT` |
| Les tarifs NGAP | Workflow n8n connecté à `/webhook/ami-calcul` |

---

## 18. Debug & développement

### Activer les logs

```js
APP.debug = true;
// Tous les log('[AMI]', ...) s'affichent dans la console
```

### Tester sans session

```js
// Dans la console navigateur après avoir mis APP.debug = true :
S = { token: 'test', role: 'nurse', user: { nom: 'Test', prenom: 'Dev' } };
showApp();
```

### Forcer le recalcul de tournée

```js
APP.set('userPos', { lat: 43.7102, lng: 7.2620 });
// → déclenche recomputeRoute() via APP.on('userPos')
```

### Tester le PIN

```js
setupPIN('1234');     // Configurer
lockApp();            // Verrouiller manuellement
// Déverrouiller avec 1234 dans l'UI
```

### Vider les données locales

```js
await purgeLocalData();    // Efface IDB + caches
localStorage.clear();      // Efface ML stats + consentement
```

### Simuler un patient urgent

```js
await addUrgentPatient({
  description: 'Injection insuline urgente',
  lat: 43.715,
  lng: 7.258,
  duration: 10,
});
```

### Inspecter le store APP

```js
console.table(APP.state);
console.log('Patients Uber:', APP.get('uberPatients'));
console.log('Prochain:', APP.get('nextPatient'));
```

### Inspecter le ML local

```js
const ml = JSON.parse(localStorage.getItem('ami_ml_stats') || '{}');
console.table(ml.duration);   // Durées par type de soin
console.table(ml.delays);     // Retards par heure
```

---

*AMI NGAP v5.0 — Architecture modulaire · Privacy by Design · IA embarquée*
