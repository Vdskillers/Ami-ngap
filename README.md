# AMI NGAP — Documentation technique v6.0

> Assistant infirmier intelligent · Cotation NGAP · Tournée IA · Copilote xAI Grok · PWA offline · Sécurité HDS

---

## Sommaire

1. [Structure du projet](#1-structure-du-projet)
2. [Ordre de chargement](#2-ordre-de-chargement)
3. [Architecture globale](#3-architecture-globale)
4. [Store APP observable (utils.js)](#4-store-app-observable-utilsjs)
5. [Modules frontend — référence](#5-modules-frontend--référence)
6. [Backend Cloudflare Worker v6.0](#6-backend-cloudflare-worker-v60)
7. [Base de données Supabase](#7-base-de-données-supabase)
8. [Moteur IA de tournée (ai-tournee.js)](#8-moteur-ia-de-tournée-ai-tourneejs)
9. [Assistant vocal IA (ai-assistant.js)](#9-assistant-vocal-ia-ai-assistantjs)
10. [Sécurité RGPD / HDS (security.js)](#10-sécurité-rgpd--hds-securityjs)
11. [PWA & Offline (pwa.js + sw.js)](#11-pwa--offline-pwajs--swjs)
12. [Carte premium (map.js + extras.js)](#12-carte-premium-mapjs--extrasjs)
13. [RBAC — Permissions](#13-rbac--permissions)
14. [API Endpoints — référence complète](#14-api-endpoints--référence-complète)
15. [Variables d'environnement & configuration](#15-variables-denvironnement--configuration)
16. [Déploiement](#16-déploiement)
17. [Guide "je veux modifier…"](#17-guide-je-veux-modifier)
18. [Debug & développement](#18-debug--développement)
19. [Checklist RGPD / HDS](#19-checklist-rgpd--hds)

---

## 1. Structure du projet

```
Ami-ngap/
│
├── index.html              # Shell HTML — structure + liens scripts
├── manifest.json           # PWA — installable sur mobile/desktop
├── sw.js                   # Service Worker — offline, cache tiles, sync
├── style.css               # CSS global : variables, layout, composants, mobile
├── worker.js               # Cloudflare Worker — backend sécurisé (déployé séparément)
│
├── utils.js                # ⭐ Utilitaires globaux — chargé EN PREMIER
├── auth.js                 # Authentification, session, RBAC client
├── security.js             # RGPD/HDS — AES-256-GCM, consentement, PIN, audit
├── admin.js                # Panel administrateur
├── profil.js               # Modale profil utilisateur
├── cotation.js             # Cotation NGAP + PDF + Vérification IA
├── voice.js                # Dictée vocale — pont vers ai-assistant.js
├── dashboard.js            # Dashboard & statistiques avancées
├── rapport.js              # Rapport mensuel + monitoring système + NGAP nomenclature
├── offline-queue.js        # File d'attente offline + stats avancées + onboarding
├── ui.js                   # Navigation, mobile, bindings — chargé EN DERNIER
├── map.js                  # Carte Leaflet premium + GPS      ← dépend de Leaflet
├── extras.js               # Carte tournée + intelligence métier front
├── uber.js                 # Mode Uber Médical temps réel     ← dépend de map.js
├── ai-tournee.js           # Moteur IA tournée VRPTW + 2-opt  ← dépend de utils.js
├── ai-assistant.js         # NLP + ML prédictif + LLM + TTS   ← dépend de utils.js
├── copilote.js             # Copilote IA conversationnel (xAI Grok via worker)
├── pwa.js                  # PWA : install, IDB, cartes offline, sync
├── tournee.js              # Tournée + Import + Planning + Live  ← dépend de tout
├── patients.js             # Carnet patients local chiffré (IDB)
├── tresorerie.js           # Trésorerie, remboursements AMO/AMC, export CSV
├── contact.js              # Messagerie infirmière ↔ admin
└── signature.js            # Signatures électroniques sur factures (IDB)
```

---

## 2. Ordre de chargement

L'ordre dans `index.html` est **critique**.

```html
<!-- ① Base absolue -->
<script src="utils.js"></script>

<!-- ② Modules fonctionnels -->
<script src="auth.js"></script>
<script src="security.js"></script>
<script src="admin.js"></script>
<script src="profil.js"></script>
<script src="cotation.js"></script>
<script src="voice.js"></script>
<script src="dashboard.js"></script>
<script src="rapport.js"></script>
<script src="offline-queue.js"></script>
<script src="patients.js"></script>
<script src="tresorerie.js"></script>
<script src="contact.js"></script>
<script src="signature.js"></script>

<!-- ③ UI — après TOUS les modules -->
<script src="ui.js"></script>

<!-- ④ Leaflet CDN — requis avant map/uber/tournee -->
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<!-- ⑤ Modules Leaflet-dépendants -->
<script src="map.js"></script>
<script src="extras.js"></script>
<script src="uber.js"></script>

<!-- ⑥ Moteurs IA -->
<script src="ai-tournee.js"></script>
<script src="ai-assistant.js"></script>
<script src="copilote.js"></script>
<script src="pwa.js"></script>

<!-- ⑦ Tournée — dépend de tout ce qui précède -->
<script src="tournee.js"></script>
```

---

## 3. Architecture globale

```
┌─────────────────────────────────────────────────────────────┐
│                       FRONTEND PWA                          │
│                                                             │
│  ┌──────────┐  ┌───────────┐  ┌────────────────────────┐   │
│  │ utils.js │  │security.js│  │     ai-tournee.js      │   │
│  │ APP store│  │AES-256-GCM│  │  VRPTW + 2-opt + cache │   │
│  │observable│  │RGPD / HDS │  │  OSRM + lookahead      │   │
│  └────┬─────┘  └───────────┘  └────────────────────────┘   │
│       │                                                     │
│  ┌────▼──────────────────────────────────────────────────┐  │
│  │              APP.state (observable)                   │  │
│  │  userPos · startPoint · uberPatients · nextPatient    │  │
│  └────┬──────────────────────────────────────────────────┘  │
│       │ APP.set() → CustomEvent('app:update')               │
│  ┌────▼────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │  map.js │  │extras.js │  │  uber.js │  │copilote.js │  │
│  │ Leaflet │  │ Tournée  │  │ GPS live │  │ xAI Grok   │  │
│  │ premium │  │ dédiée   │  │ throttlé │  │ via worker │  │
│  └─────────┘  └──────────┘  └──────────┘  └────────────┘  │
│                                                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              offline-queue.js + pwa.js + sw.js         │ │
│  │  File offline · Onboarding · Cartes offline · Sync     │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS (Bearer token)
┌──────────────────────────▼──────────────────────────────────┐
│             Cloudflare Worker v6.0 — raspy-tooth-1a2f       │
│  Auth · RBAC · NGAP · Prescripteurs · Factures séquentielles│
│  Fraud score · Audit logs · System logs · Copilote xAI      │
│  AMI_SYSTEM Guard · ami-historique → Supabase direct        │
└───────────────────┬────────────────────┬────────────────────┘
                    │                    │
        ┌───────────▼──────┐   ┌─────────▼──────────┐
        │   Supabase DB    │   │  N8N (n8n-6fyl)    │
        │  infirmieres     │   │  Cotation IA NGAP  │
        │  sessions        │   │  Grok-3 + RAG BM25 │
        │  planning_pats   │   └────────────────────┘
        │  prescripteurs   │
        │  audit_logs      │   ┌────────────────────┐
        │  invoice_cntrs   │   │  xAI API (Grok)    │
        │  system_logs     │   │  Copilote NGAP     │
        │  contact_messages│   │  via env.XAI_API_KEY│
        └──────────────────┘   └────────────────────┘
```

---

## 4. Store APP observable (utils.js)

### Lecture / Écriture

```js
APP.set('userPos', { lat: 43.7, lng: 7.25 }); // → dispatch CustomEvent('app:update')
const pos = APP.get('userPos');
APP.startPoint = { lat, lng }; // équivalent à APP.set('startPoint', ...)
```

### Écoute réactive

```js
APP.on('userPos', (newPos, prevPos) => { updateMapMarker(newPos); });
APP.on('nextPatient', (patient) => { renderPatientCard(patient); });
```

### Clés disponibles

| Clé | Type | Description |
|---|---|---|
| `user` | Object | `{id, email, nom, prenom, adeli, rpps}` |
| `token` | String | JWT session |
| `role` | String | `'nurse'` ou `'admin'` |
| `startPoint` | `{lat,lng}` | Point de départ tournée |
| `userPos` | `{lat,lng}` | Position GPS live (throttlée 3s) |
| `importedData` | Object | Données importées depuis calendrier |
| `uberPatients` | Array | Patients du mode Uber |
| `nextPatient` | Object | Prochain patient recommandé |

---

## 5. Modules frontend — référence

### `utils.js` — Socle commun

| Fonction | Description |
|---|---|
| `APP.set(key, value)` | Écriture réactive |
| `APP.get(key)` | Lecture état |
| `APP.on(key, fn)` | Écoute réactive |
| `requireAuth()` | Guard session — redirige login si expiré |
| `wpost(path, body)` | POST API avec retry ×2 (timeout 35s) |
| `apiCall(path, body)` | Alias de `wpost` |
| `fetchAPI(url, opts)` | GET API avec auth |
| `sanitize(str)` | Échappe `< > ' "` |
| `debounce(fn, ms)` | Anti-rebond |
| `throttle(fn, ms)` | Limite fréquence (GPS) |
| `$(id)` | `document.getElementById` |
| `gv(id)` | Valeur d'un input (trimmed) |
| `fmt(n)` | Nombre → `"12.50 €"` |

**Constante :** `W = 'https://raspy-tooth-1a2f.vdskillers.workers.dev'`

### `auth.js` — Authentification v4.0

| Fonction | Description |
|---|---|
| `checkAuth()` | Vérifie consentement RGPD + session au démarrage |
| `login()` | POST `/webhook/auth-login` + `initSecurity()` |
| `register()` | POST `/webhook/infirmiere-register` |
| `logout()` | Vide session, store APP, localStorage partiel |
| `showApp()` | Affiche l'app après login — adapte UI selon rôle |
| `showAdm()` | Affiche le panel admin |
| `goToApp()` | Retour app depuis panel admin |
| `clientHasPermission(perm)` | Vérifie permission côté client (miroir worker) |
| `loadPrescripteurs()` | Charge la liste des médecins (nurse only) |
| `displayInvoiceNumber(num)` | Affiche le N° facture retourné par le worker |

**Comportement admin (mode RGPD) :**
- Champs patients masqués (`f-pt`, `f-ddn`, `f-sec`, `f-amo`, `f-amc`) en `readOnly`
- Bouton **👤 Mon compte** injecté dans la sidebar au-dessus du Panneau admin
- Bouton **⚙️ Panneau admin** injecté dans la sidebar
- Les admins ne voient **jamais** les données patients

### `security.js` — RGPD / HDS

| Fonction | Description |
|---|---|
| `initSecurity(token)` | Clé AES-256-GCM via PBKDF2 (100k itérations) |
| `encryptData(obj)` | Chiffre → `{data, iv}` base64 |
| `decryptData(payload)` | Déchiffre → objet JS |
| `saveSecure(store, id, val)` | IDB chiffré — écriture |
| `loadSecure(store, id)` | IDB chiffré — lecture |
| `loadAllSecure(store)` | IDB chiffré — lecture complète |
| `checkConsent()` | Vérifie consentement RGPD |
| `showConsentModal()` | Modale onboarding RGPD |
| `exportMyData()` | Export JSON RGPD utilisateur |
| `purgeLocalData()` | Efface IDB + caches |
| `setupPIN(pin)` | Configure PIN verrouillage (SHA-256) |
| `lockApp()` | Verrouille après 10 min d'inactivité |
| `stripSensitive(data)` | Retire champs NIR, ADELI, patients |

### `admin.js` — Panel admin v4.0

| Fonction | Description |
|---|---|
| `loadAdm()` | Liste comptes infirmiers (nurses uniquement) |
| `loadAdmStats()` | KPIs anonymisés globaux |
| `loadAdmLogs()` | Journal d'audit (200 derniers) |
| `loadAdmSecurityStats()` | Échecs login + alertes fraude |
| `loadAdmMessages()` | Messages des infirmières |
| `admAct(action, id, name)` | Bloquer / débloquer / supprimer compte |
| `replyToMessage(id, name)` | Répondre à un message infirmière |
| `filterAccs()` | Filtre la liste par nom/prénom |

> ⚠️ `loadAdm()` filtre `role=nurse` — les admins ne voient **pas** les autres admins.

### `cotation.js` — Cotation NGAP

| Fonction | Description |
|---|---|
| `cotation()` | Appel N8N via worker + affichage + `displayInvoiceNumber()` |
| `renderCot(d)` | Rendu HTML feuille de soins |
| `printInv(d)` | Vérifie infos pro → PDF |
| `openVerify()` | Ouvre modale vérification IA |
| `applyVerify()` | Applique corrections IA |
| `clrCot()` | Réinitialise formulaire |
| `coterDepuisRoute(desc)` | Pré-remplit depuis tournée |
| `verifyStandalone()` | Vérification IA indépendante |

> Le `prescripteur_id` est envoyé dans le payload. Le worker hydrate nom, RPPS, spécialité depuis `prescripteurs`. Le N° facture (`F{ANNÉE}-{ID6}-{SEQ6}`) est généré côté serveur, jamais côté client.

### `rapport.js` — Rapport + Monitoring + NGAP nomenclature

| Fonction | Description |
|---|---|
| `generateRapportMensuel()` | Génère rapport HTML/PDF mensuel |
| `previewRapport()` | Aperçu avant impression |
| `loadSystemHealth()` | Charge monitoring N8N/IA/worker |
| `resetSystemLogs()` | Vide `system_logs` via `/webhook/admin-system-reset` |
| `lookupNGAP(code)` | Recherche un acte NGAP 2026 |
| `searchNGAP(query)` | Recherche full-text NGAP |
| `validateNGAPCumul(actes)` | Validateur cumuls CPAM |
| `renderNGAPSearch()` | Rendu résultats recherche NGAP |

**Nomenclature NGAP 2026 intégrée :** AMI1–6, AIS1–3, BSA/BSB/BSC, IFD, IK, MN, MN2, MD, MIE, MCI, SI, PIV.

### `offline-queue.js` — File offline + Stats + Onboarding

| Fonction | Description |
|---|---|
| `queueCotation(payload)` | Mise en file si hors-ligne |
| `syncOfflineQueue()` | Sync automatique à la reconnexion |
| `loadStatsAvancees()` | Statistiques comparatives mois/mois |
| `showToast(msg, type)` | Toast système global |
| `checkOnboarding()` | Détecte première connexion (clé par email) |
| `showOnboarding()` | Assistant guidé 4 étapes |
| `completeOnboarding()` | Marque intro terminée |
| `resetOnboarding()` | Réinitialise l'intro pour l'utilisateur courant |
| `requestNotifPermission()` | Demande permissions notifications |

> L'intro est liée à chaque compte via une clé `ami_onboarding_done_<hash_email>`. Chaque infirmière voit l'intro uniquement à sa toute première connexion.

### `copilote.js` — Copilote IA conversationnel

| Fonction | Description |
|---|---|
| `toggleCopilot()` | Ouvre/ferme le panel flottant |
| `sendCopilotMessage(text)` | Envoie via panel flottant |
| `sendCopilotFull()` | Envoie depuis la section dédiée |
| `clearCopilotHistory()` | Efface la conversation |
| `initCopiloteSection()` | Monte l'interface dans `#copilote-chat-area` |
| `openCopilotSection()` | Navigue vers la section copilote |

**Architecture :**
```
Navigateur → apiCall('/webhook/ami-copilot') → Worker → xAI Grok API
                                               Clé XAI_API_KEY (env Cloudflare, jamais exposée)
```
L'historique conversationnel (10 derniers échanges) est transmis au worker pour un vrai contexte. Fallback automatique sur règles NGAP statiques si xAI est indisponible.

**Init robuste (3 déclencheurs) :** `app:nav` + `MutationObserver` sur la section + `setTimeout 300ms`.

### `patients.js` — Carnet patients local

| Fonction | Description |
|---|---|
| `openAddPatient()` | Ouvre formulaire d'ajout |
| `savePatient()` | Enregistre en IDB chiffré |
| `loadPatients()` | Charge + affiche avec filtrage |
| `openPatientDetail(id)` | Fiche complète + notes de soin |
| `editPatient(id)` | Pré-remplit formulaire de modification |
| `deletePatient(id, name)` | Suppression RGPD (patient + notes) |
| `addSoinNote(patientId)` | Ajoute note de soin horodatée |
| `checkOrdoExpiry()` | Alertes renouvellement ordonnances (30j) |
| `exportPatientData()` | Export JSON RGPD complet |
| `coterDepuisPatient(id)` | Pré-remplit cotation depuis fiche patient |

> 🔒 Stockage 100% local IndexedDB (`ami_patients_db`). Chiffrement AES dérivé du token de session. Aucune donnée ne quitte le navigateur.

### `tresorerie.js` — Trésorerie & Comptabilité

| Fonction | Description |
|---|---|
| `loadTresorerie()` | Charge cotations avec statut remboursement |
| `renderTresorerie(arr)` | Tableau AMO/AMC avec marquage payé |
| `markPaid(id, who)` | Marque un remboursement reçu |
| `statsRemboursements(arr)` | Calcul CA, en attente, reçu |
| `exportComptable()` | Export CSV comptable |
| `checklistCPAM()` | Checklist conformité CPAM |

### `contact.js` — Messagerie infirmière ↔ admin

| Fonction | Description |
|---|---|
| `sendContactMessage()` | Envoie message à l'admin |
| `loadMyMessages()` | Charge historique échanges |

### `signature.js` — Signatures électroniques

| Fonction | Description |
|---|---|
| `openSignatureModal(invoiceId)` | Ouvre le canvas de signature |
| `saveSignature()` | Enregistre signature en IDB |
| `getSignature(invoiceId)` | Récupère signature |
| `deleteSignature(invoiceId)` | Supprime signature |
| `injectSignatureInPDF(invoiceId)` | Intègre dans la facture PDF |
| `clearSignature()` | Efface le canvas |

### `map.js` — Carte premium v5.0

| Fonction | Description |
|---|---|
| `initDepMap()` | Init Leaflet + `APP.map.register()` |
| `getGPS()` | GPS avec contrôle précision (±100m/500m/5km) |
| `geocodeAddress()` | Adresse → coordonnées (Nominatim) |
| `reverseGeocode(lat, lng)` | Coordonnées → adresse lisible |
| `setDepCoords(lat, lng)` | Met à jour `APP.startPoint` |
| `_setDepMarker(lat, lng)` | Marker draggable vert sur carte |
| `createPatientMarker(p)` | Marker card style Uber |
| `addNumberedMarkers(patients)` | Cercles numérotés sur carte |
| `drawRoute(points)` | Tracé OSRM ligne `#00d4aa` |
| `renderTimeline(patients)` | Timeline tournée sous la carte |
| `toggleMapFullscreen()` | Mode plein écran (Échap pour fermer) |
| `renderPatientsOnMap(patients, start)` | Pipeline complet markers + route + zoom |

### `extras.js` — Carte tournée + Intelligence métier

| Fonction | Description |
|---|---|
| `initTurMap()` | Init carte tournée (partage `dep-map` ou dédiée) |
| `_rebindMapClick(map)` | Branche handler clic carte pour point de départ |
| `setDepartPoint(lat, lng, label)` | Définit point de départ + marker + coordonnées |
| `searchAddress()` | Géocodage Nominatim depuis `dep-addr` |
| `useMyLocation()` | GPS → point de départ |
| `drawRouteOSRM(data)` | Tracé GeoJSON OSRM sur carte tournée |
| `renderTourneeOSRM(data)` | Rendu waypoints + fraude + coter |
| `fraudeScore(p)` | Score fraude par patient (côté front) |
| `suggestOptimizationsFront()` | Suggestions CA depuis IMPORTED_DATA |
| `updateCAEstimate()` | Box CA estimé journée |
| `generatePlanningLocal()` | Planning hebdo depuis IMPORTED_DATA |

> **Fix pointeur carte :** `_rebindMapClick` ajoute le handler extras.js **sans supprimer** le handler map.js (`_setDepMarker`, `setDepCoords`, `reverseGeocode`). Le curseur passe en `crosshair` avec hint "👆 Cliquez sur la carte". 

### `uber.js` — Mode Uber Médical v5.0

| Fonction | Description |
|---|---|
| `startLiveTracking()` | GPS continu throttlé 3s |
| `stopLiveTracking()` | Arrête watchPosition |
| `selectBestPatient()` | Tri euclidien + OSRM top5 |
| `markUberDone()` | Patient terminé + recalcul |
| `markUberAbsent()` | Patient absent + recalcul |
| `recalcRouteUber()` | Recalcul OSRM complet |
| `openNavigation(p)` | Google Maps direct patient |
| `detectDelaysUber()` | Marque `p.late = true` si > 15min |

### `voice.js` — Dictée vocale

| Fonction | Description |
|---|---|
| `toggleVoice()` | Démarre / arrête la reconnaissance |
| `startVoice()` | Initialise SR + `startHandsFree()` |
| `stopVoice()` | Arrête SR + `stopHandsFree()` |
| `normalizeMedical(txt)` | Normalise terminologie médicale vocale |
| `handleVoice(transcript, confidence)` | Délègue à `handleAICommand()` ou règles natives |

### `dashboard.js` — Statistiques

| Fonction | Description |
|---|---|
| `loadDash()` | Charge données API + cache 1 min |
| `renderDashboard(arr)` | KPIs, graphique 30j, top actes, prévision |
| `detectAnomalies(rows, daily)` | Détection écarts-types (σ) |
| `suggestOptimizations(rows)` | IFD oubliés, majorations, ALD |
| `forecastRevenue(daily)` | Prévision linéaire fin de mois |

### `ui.js` — Navigation v5.0

| Fonction | Description |
|---|---|
| `navTo(v, triggerEl)` | Navigation + dispatch `CustomEvent('app:nav')` |
| `updateNavMode()` | Affiche/masque bottom nav mobile |
| `toggleMobileMenu()` | Menu "Plus" mobile |

---

## 6. Backend Cloudflare Worker v6.0

- **URL** : `https://raspy-tooth-1a2f.vdskillers.workers.dev`
- **Auth** : `Authorization: Bearer <token>` sur toutes les routes sauf `/auth-login`, `/infirmiere-register`, `/webhook/log`
- **Version NGAP** : `2026.1`
- **Debug** : `?debug=1` ou header `x-ami-debug: 1`

### Constantes

| Constante | Valeur |
|---|---|
| `SALT` | `'inf2026salt'` |
| `PATIENT_SALT` | `'patient_anon_salt_2026'` |
| `SUPA_URL` | `https://ycsprblaruusaegohcid.supabase.co/rest/v1` |
| `N8N_URL` | `https://n8n-6fyl.onrender.com` |
| `N8N_TIMEOUT_MS` | `30000` (30s) |
| `NGAP_VERSION_CURRENT` | `'2026.1'` |
| `ADMIN_EMAILS` | `['vdskillers@hotmail.com', 'julien.bonomelli@gmail.com']` |

### AMI_SYSTEM Guard (v6.0)

Cerveau de monitoring en mémoire du worker. S'alimente automatiquement sur les événements :

```js
AMI_SYSTEM.recordN8NError('timeout')     // timeout N8N
AMI_SYSTEM.recordN8NError('parse_fail')  // JSON invalide
AMI_SYSTEM.recordN8NError('empty')       // réponse vide
AMI_SYSTEM.recordN8NError('http_error')  // code HTTP non-2xx
AMI_SYSTEM.recordN8NError('html')        // workflow cassé (HTML reçu)
AMI_SYSTEM.recordFallback()              // fallback NGAP local déclenché
AMI_SYSTEM.recordFraud()                 // alerte fraude ≥ 70
AMI_SYSTEM.recordFrontErr()              // erreur frontend loguée
```

`AMI_SYSTEM.getStats()` est exposé dans `/webhook/admin-logs` et fusionné avec les compteurs DB `system_logs`.

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
| Total > 400€ | +20 |
| Acte de nuit sans heure documentée | +30 |
| Distance > 100km | +20 |
| Distance > 150km | +25 |
| > 20 patients/jour | +40 |
| > 50km ET > 20 patients | +40 |
| Acte en double | +50 |

> Score ≥ 70 → log dans `audit_logs` (`COTATION_FRAUD_ALERT`) + `system_logs` (`FRAUD_ALERT`)

### N° facture séquentiel

Format : `F{ANNÉE}-{ID_COURT}-{SEQ6}`  
Exemple : `F2026-A3F2B1-000042`

Généré côté serveur uniquement via `invoice_counters`. Stocké avec `locked: true` dans `planning_patients`. Non modifiable après génération.

### Spécificités v6.0

- **`/ami-historique`** — lecture directe Supabase (plus de proxy N8N) → 0 erreur `N8N_FAILURE` pour l'historique
- **`/ami-supprimer`** — suppression directe Supabase, vérifie `locked` avant suppression
- **`/webhook/ami-copilot`** — appel xAI Grok (`grok-3-mini`) avec historique conversationnel + fallback règles statiques
- **`/webhook/admin-system-reset`** — vide `system_logs` + remet à zéro `AMI_SYSTEM.counters`
- **Mode admin sur `/ami-calcul`** — court-circuit N8N, utilise `fallbackCotation()` local, données patient masquées

---

## 7. Base de données Supabase

**URL :** `https://ycsprblaruusaegohcid.supabase.co`

### Tables

| Table | Description | RLS |
|---|---|---|
| `infirmieres` | Comptes (email, password_hash, adeli, rpps, role) | Désactivé |
| `sessions` | Tokens de session (`infirmiere_id`, `token`) | Désactivé |
| `planning_patients` | Cotations / passages + invoice_number + locked | Désactivé |
| `prescripteurs` | Médecins prescripteurs (nom, rpps, specialite) | Désactivé |
| `invoice_counters` | Compteurs séquentiels par infirmière | Désactivé |
| `audit_logs` | Journal d'audit (user_id, event, score, ip, meta) | Désactivé |
| `system_logs` | Logs système (level, source, event, message, meta) | Désactivé |
| `contact_messages` | Messagerie infirmière ↔ admin | Désactivé |

> ⚠️ **RLS doit rester désactivé** — le worker utilise la `service_role` key qui bypass le RLS. Activer le RLS sans policies bloque toutes les requêtes.

### SQL initial (à exécuter dans Supabase SQL Editor)

```sql
-- Désactiver RLS sur toutes les tables
ALTER TABLE infirmieres        DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions           DISABLE ROW LEVEL SECURITY;
ALTER TABLE planning_patients  DISABLE ROW LEVEL SECURITY;
ALTER TABLE prescripteurs      DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_counters   DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         DISABLE ROW LEVEL SECURITY;
ALTER TABLE system_logs        DISABLE ROW LEVEL SECURITY;
ALTER TABLE contact_messages   DISABLE ROW LEVEL SECURITY;

-- Tables complémentaires
CREATE TABLE IF NOT EXISTS system_logs (
  id SERIAL PRIMARY KEY, level TEXT DEFAULT 'info',
  source TEXT, event TEXT, message TEXT, meta TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  infirmiere_id UUID, infirmiere_nom TEXT, infirmiere_prenom TEXT,
  categorie TEXT, sujet TEXT, message TEXT,
  status TEXT DEFAULT 'sent',
  reply_message TEXT, replied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Colonnes planning_patients
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS prescripteur_id UUID;
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS invoice_number TEXT UNIQUE;
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS ngap_version TEXT DEFAULT '2026.1';
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false;
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS fraud_score INT DEFAULT 0;
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS ai_score INT DEFAULT 0;
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'ia';
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS done BOOLEAN DEFAULT false;
ALTER TABLE planning_patients ADD COLUMN IF NOT EXISTS absent BOOLEAN DEFAULT false;

-- Index performance
CREATE INDEX IF NOT EXISTS idx_infirmiere_planning ON planning_patients(infirmiere_id);
CREATE INDEX IF NOT EXISTS idx_invoice_number      ON planning_patients(invoice_number);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event    ON audit_logs(event);
CREATE INDEX IF NOT EXISTS idx_system_logs_event   ON system_logs(event);
```

---

## 8. Moteur IA de tournée (ai-tournee.js)

Architecture **VRPTW** (Vehicle Routing Problem with Time Windows) 100% client-side.

- **2-opt** — optimisation locale des échanges de segments
- **Lookahead** — évaluation des N prochains patients (N=3)
- **Cache** — résultats OSRM mis en cache 5 min
- **Fallback** — tri chronologique si OSRM indisponible

```js
// Optimisation complète
const route = await optimizeTour(patients, startLat, startLng);

// Score de priorité patient
const score = priorityScore({ heure, description }); // insuline+50, urgent+50, <9h+30
```

---

## 9. Assistant vocal IA (ai-assistant.js)

Pipeline : **Voix → WebSpeech API → NLP → ML → Commande → TTS**

- `NLP_INTENTS` — intentions reconnues (cotation, navigation, dates, heures…)
- `_dispatchIntent(intent, entities)` — routing des commandes
- `startHandsFree()` / `stopHandsFree()` — mode mains-libres
- Navigation vocale OSRM avec annonces à < 200m et < 80m
- `checkDeviation()` toutes les 15s — recalcul si > 300m

---

## 10. Sécurité RGPD / HDS (security.js)

### Architecture "Privacy by Design"

```
Token login
    ↓
initSessionKey(token) ← PBKDF2 (100k itérations) → clé AES-256-GCM
    ↓
_sessionKey           ← en mémoire vive UNIQUEMENT (jamais persistée)
    ↓
encryptData() / decryptData() ← AES-256-GCM, IV aléatoire par opération
    ↓
saveSecure('s_patients', id, data) ← IDB chiffré (ami-secure v2)
```

### Stores IndexedDB chiffrés

| Store | Contenu | TTL |
|---|---|---|
| `s_patients` | Données patients offline | Session |
| `s_sync` | Queue sync offline | Jusqu'à envoi |
| `s_audit` | Journal actions sensibles | 90 jours (purge auto) |
| `prefs` | Consentement, préférences | Permanent |

### PIN local

- Verrouillage auto après **10 min d'inactivité**
- PIN haché SHA-256 + sel avant stockage
- Réinitialisation timer à chaque `click`, `keydown`, `touchstart`

### Ce que les admins ne peuvent PAS voir

- Données patients (nom, prénom, NIR, DDN, N° sécu)
- Détail des factures et prescripteurs des patients
- Logs de cotation individuels
- Autres comptes administrateurs

---

## 11. PWA & Offline (pwa.js + sw.js)

### Stratégies de cache

| Type de ressource | Stratégie |
|---|---|
| Assets app (HTML, CSS, JS) | Cache-first |
| API Cloudflare Worker | Network-first (timeout 8s) |
| Tiles OpenStreetMap | Stale-while-revalidate |
| Polices Google / Leaflet CDN | Cache-first |

### Cartes offline

```js
await downloadCurrentArea();             // ~15km autour du départ, zooms 12-14
await downloadMapArea({ minLat, maxLat, minLng, maxLng }, [12, 13, 14]);
```

### Sync offline

```
Cotation hors-ligne → queueCotation() → ami_offline_queue (localStorage)
                                              ↓ reconnexion
                                       syncOfflineQueue() → worker
```

---

## 12. Carte premium (map.js + extras.js)

### Hauteur responsive

```css
#dep-map { height: clamp(220px, 50vh, 560px); }
@media(max-width:768px) { #dep-map { height: 220px; } }
```

### Point de départ — 3 méthodes cumulables

1. **Clic carte** — curseur `crosshair`, marker draggable vert, géocodage inverse automatique
2. **Recherche adresse** — champ `dep-addr` → Nominatim → `setDepartPoint()`
3. **GPS** — bouton 📍 → `getGPS()` → `setDepartPoint()`

Les 3 méthodes appellent `setDepartPoint()` qui synchronise `APP.startPoint`, les inputs cachés `t-lat`/`t-lng`, et le texte `dep-coords`.

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

> La vérification client est **uniquement cosmétique**. Chaque route worker re-valide les permissions indépendamment.

---

## 14. API Endpoints — référence complète

### Routes publiques (sans auth)

| Endpoint | Description |
|---|---|
| POST `/webhook/auth-login` | Connexion — retourne token + role + user |
| POST `/webhook/infirmiere-register` | Inscription (admins bloqués) |
| POST `/webhook/log` | Log erreur frontend → `system_logs` |

### Routes infirmière (nurse)

| Endpoint | Description |
|---|---|
| POST `/webhook/profil-get` | Récupère profil |
| POST `/webhook/profil-save` | Met à jour profil |
| POST `/webhook/change-password` | Changement mot de passe |
| POST `/webhook/delete-account` | Suppression compte + données |
| POST `/webhook/prescripteur-liste` | Liste médecins prescripteurs |
| POST `/webhook/prescripteur-add` | Ajoute un médecin (RPPS unique) |
| POST `/webhook/prescripteur-get` | Détails d'un médecin |
| POST `/webhook/import-calendar` | Import ICS/CSV/JSON/TXT |
| POST `/webhook/ami-tournee-ia` | Optimisation tournée (Supabase → sort) |
| POST `/webhook/ami-live` | Pilotage live (done/absent/status/recalcul) |
| POST `/webhook/ami-calcul` | Cotation NGAP + N° facture (N8N + fallback) |
| POST `/webhook/ami-historique` | Historique cotations (**Supabase direct**, plus N8N) |
| POST `/webhook/ami-supprimer` | Suppression cotation (vérifie `locked`) |
| POST `/webhook/ami-copilot` | Copilote IA NGAP (xAI Grok + fallback règles) |
| POST `/webhook/ami-week-analytics` | Analytique tournée hebdomadaire |
| POST `/webhook/contact-send` | Envoie message à l'admin |
| POST `/webhook/contact-mes-messages` | Historique échanges infirmière |

### Routes admin uniquement

| Endpoint | Description |
|---|---|
| POST `/webhook/admin-liste` | Liste comptes **nurses** uniquement (RGPD) |
| POST `/webhook/admin-stats` | KPIs anonymisés (CA, actes, top codes) |
| POST `/webhook/admin-logs` | Audit logs + system logs + stats AMI_SYSTEM |
| POST `/webhook/admin-security-stats` | Échecs login + alertes fraude |
| POST `/webhook/admin-bloquer` | Suspend un compte (sessions révoquées) |
| POST `/webhook/admin-debloquer` | Réactive un compte |
| POST `/webhook/admin-supprimer` | Supprime définitivement (planning + sessions) |
| POST `/webhook/admin-messages` | Tous les messages infirmières |
| POST `/webhook/admin-message-read` | Marque un message comme lu |
| POST `/webhook/admin-message-reply` | Répond à un message |
| POST `/webhook/admin-system-reset` | Vide `system_logs` + remet compteurs à zéro |

### Format réponse standard

```json
{ "ok": true, "data": ... }
{ "ok": false, "error": "Message d'erreur lisible" }
```

---

## 15. Variables d'environnement & configuration

### Cloudflare Workers — Variables (Settings → Variables and Secrets)

| Variable | Description | Obligatoire |
|---|---|---|
| `SUPABASE_SERVICE_KEY` | Clé service_role Supabase | ✅ Oui |
| `XAI_API_KEY` | Clé API xAI (Grok) pour le copilote | Recommandé |

> Toujours cocher **Encrypt** pour les clés secrètes.

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

### Prérequis

- **HTTPS obligatoire** — Service Worker, GPS, Web Crypto API, Speech Recognition
- **Chrome / Edge recommandé** — Speech Recognition + WebGPU (LLM offline optionnel)

### Checklist déploiement

- [ ] Variable `SUPABASE_SERVICE_KEY` configurée dans Cloudflare Workers (chiffrée)
- [ ] Variable `XAI_API_KEY` configurée dans Cloudflare Workers (chiffrée)
- [ ] Tables Supabase créées (SQL section 7)
- [ ] RLS désactivé sur toutes les tables
- [ ] `ADMIN_EMAILS` mis à jour dans `worker.js`
- [ ] URL Worker (`W` dans `utils.js`) correcte
- [ ] `N8N_URL` à jour dans `worker.js`
- [ ] Icônes PWA dans `/icons/` (72, 96, 128, 144, 152, 192, 384, 512px)
- [ ] Domaine en HTTPS

---

## 17. Guide "je veux modifier…"

| Je veux modifier… | Fichier(s) |
|---|---|
| Le formulaire de cotation | `cotation.js` |
| Le PDF de facture | `cotation.js` → `_doPrint()` |
| Le calcul de tournée | `ai-tournee.js` |
| La carte / GPS / pointeur départ | `map.js` + `extras.js` |
| Le mode Uber temps réel | `uber.js` |
| L'assistant vocal | `ai-assistant.js` |
| La dictée (pipeline voix) | `voice.js` |
| Les commandes vocales | `ai-assistant.js` → `NLP_INTENTS` |
| L'import calendrier | `tournee.js` |
| Le pilotage live | `tournee.js` |
| Le dashboard | `dashboard.js` |
| Le rapport mensuel | `rapport.js` |
| Le monitoring système | `rapport.js` → `loadSystemHealth()` |
| La nomenclature NGAP | `rapport.js` → `NGAP_NOMENCLATURE` |
| La connexion / inscription | `auth.js` |
| Les boutons sidebar admin | `auth.js` → `showApp()` |
| Les prescripteurs | `auth.js` + worker `/prescripteur-*` |
| Le panel admin | `admin.js` |
| La messagerie contact | `contact.js` + worker `/contact-*` |
| Les signatures électroniques | `signature.js` |
| La trésorerie | `tresorerie.js` |
| Le carnet patients | `patients.js` |
| Le copilote IA | `copilote.js` + worker `/ami-copilot` |
| Le modèle IA copilote | `worker.js` → route `/ami-copilot` → `model: 'grok-3-mini'` |
| La sécurité / chiffrement | `security.js` |
| Le consentement RGPD | `security.js` → `showConsentModal()` |
| Le PIN de verrouillage | `security.js` → `setupPIN()` / `lockApp()` |
| L'onboarding première connexion | `offline-queue.js` → `checkOnboarding()` |
| L'offline / file d'attente | `offline-queue.js` |
| Les cartes offline | `pwa.js` → `downloadMapArea()` |
| La navigation mobile | `ui.js` |
| Les couleurs / design | `style.css` |
| La structure HTML | `index.html` |
| Les routes API | `worker.js` |
| La base de données | Supabase SQL Editor |
| La version NGAP | `worker.js` → `NGAP_VERSION_CURRENT` |
| L'IA de cotation (N8N) | Workflow n8n → `/webhook/ami-calcul` |

---

## 18. Debug & développement

### Activer les logs

```js
APP.debug = true;
// Tous les log('[AMI]', ...) s'affichent dans la console
```

### Debug worker

```
GET https://raspy-tooth-1a2f.vdskillers.workers.dev/webhook/health?debug=1
// Retourne état AMI_SYSTEM + compteurs N8N + version
```

### Tester sans session

```js
S = { token: 'test', role: 'nurse', user: { nom: 'Test', prenom: 'Dev' } };
showApp();
```

### Forcer le recalcul de tournée

```js
APP.set('userPos', { lat: 43.7102, lng: 7.2620 });
// → déclenche recomputeRoute() via APP.on('userPos')
```

### Vider les données locales

```js
await purgeLocalData();  // IDB + caches PWA
localStorage.clear();    // ML stats + consentement + onboarding
```

### Inspecter AMI_SYSTEM (worker)

```js
// Dans la console après appel /admin-logs :
const stats = (await wpost('/webhook/admin-logs', {})).stats;
console.table(stats.n8n_diag_detail); // timeout / parse_fail / empty / http_error / html
```

### Réinitialiser les logs système

```js
// Via l'UI : Santé système → bouton "🗑️ Réinitialiser les logs"
// Via API : wpost('/webhook/admin-system-reset', {})
// Via SQL : DELETE FROM system_logs;
```

### Inspecter le store APP

```js
console.table(APP.state);
console.log('nextPatient:', APP.get('nextPatient'));
```

---

## 19. Checklist RGPD / HDS

### A. Gouvernance
- ✅ Registre des traitements
- ✅ Responsable de traitement défini
- ✅ Mentions légales + CGU + politique RGPD

### B. Sécurité technique
- ✅ HTTPS partout (obligatoire)
- ✅ Chiffrement AES-256-GCM côté client (security.js)
- ✅ Mots de passe hashés SHA-256 + sel côté serveur (worker.js)
- ✅ Tokens JWT Bearer — jamais de cookie
- ✅ Clés API chiffrées dans Cloudflare Workers env

### C. Données de santé (HDS)
- ✅ Accès restreint par rôle (RBAC nurse/admin)
- ✅ Admins sans accès données patients
- ✅ Carnet patients 100% local chiffré (IDB — aucun envoi serveur)
- ✅ Patients anonymisés SHA-256 dans `planning_patients`
- ✅ Logs d'accès (audit_logs + system_logs)

### D. Accès utilisateur
- ✅ Authentification obligatoire (token Bearer)
- ✅ Gestion sessions (table `sessions`)
- ✅ Déconnexion auto + PIN verrouillage (10 min)
- ✅ Comptes bloqués → sessions révoquées

### E. Droits utilisateurs
- ✅ Export données (cotations CSV, patients JSON RGPD)
- ✅ Suppression compte + données (`/webhook/delete-account`)
- ✅ Droit à l'oubli patients (`deletePatient()` IDB)
- ✅ Consentement explicite à chaque démarrage

### F. Audit & logs
- ✅ `audit_logs` : LOGIN, REGISTER, COTATION, FRAUDE, ADMIN actions
- ✅ `system_logs` : N8N_FAILURE, IA_FALLBACK, FRAUD_ALERT, INTERNAL_ERROR
- ✅ Logs sans données patient (filtrés côté worker)
- ✅ Purge auto logs > 90 jours (security.js `cleanOldLogs()`)

### G. Incident
- ✅ Plan de réponse défini
- ✅ Notification CNIL < 72h
- ✅ Monitoring temps réel (santé système admin)

---

*AMI NGAP v6.0 — Architecture modulaire · Privacy by Design · IA embarquée · xAI Grok Copilote*
