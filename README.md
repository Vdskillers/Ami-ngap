# AMI — Documentation Architecture v8.0

> **Application web progressive (PWA) pour infirmières libérales.**
> Cotation NGAP automatique, tournée optimisée, carnet patients chiffré, signatures électroniques, **mode cabinet multi-IDE**, moteur hybride Smart Engine IA, planning hebdomadaire cabinet.

---

## Versions

| Composant | Version | Nouveautés |
|---|---|---|
| **Worker backend** | **v7.0** | Smart Engine hybride, State Engine, RL Logger, Heatmap Scoring |
| **Agent IA N8N** | **v10** | 51 nœuds — RL Decision Logger + Heatmap Zone Scorer |
| Module cabinet | **v2.0** | Cotation multi-IDE, tournée cabinet, sync sélective, admin seul |
| Cotation | **v8** | NLP 17 patterns, sélecteur IDE par acte, estimation NGAP correcte côté client |
| Planning hebdomadaire | **v2.0** | Navigation semaine, vue cabinet multi-IDE, bouton Coter réparé |
| Tournée IA | **v6.0** | Cabinet multi-IDE, clustering, fatigue, surge, prédiction retard |
| Dashboard | **v2.0** | KPIs multi-IDE, simulateur revenus, objectif CA (après Stats avancées) |
| Heatmap zones | **v2.0** | Scoring décisionnel enrichHeatmap + scorePatientZone |
| Admin panel | v4.0 | Stats Smart Engine + RL, admins invisibles |
| PWA / Service Worker | v3.6 | Cache offline, tiles carte |
| Sécurité RGPD | v2.0 | Isolation multi-users IndexedDB par userId |

---

## Architecture globale

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        TERMINAL UTILISATEUR                             │
│  FRONTEND (GitHub Pages)                                                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────────────┐  │
│  │cotation.js│ │tournee.js│ │patients.j│ │  cabinet.js v2.0         │  │
│  │NGAP v8   │ │planning  │ │IndexedDB │ │  multi-IDE · sync · test  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────────────┐  │
│  │dashboard │ │map.js v2 │ │ai-tournee│ │  security.js AES-256-GCM  │  │
│  │KPIs+Cab  │ │Heatmap   │ │Smart TSP │ │                           │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────────────┘  │
│  STOCKAGE LOCAL (jamais transmis aux serveurs)                         │
│  ├── IndexedDB ami_patients_db_<userId>  ← données santé AES-256      │
│  ├── IndexedDB ami_sig_db_<userId>       ← signatures AES-256         │
│  └── localStorage ami_dash_<userId>_*   ← cache non-sensible          │
└─────────────────────────────────────────────────────────────────────────┘
                               │ HTTPS · JWT
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│               CLOUDFLARE WORKER v7.0  (Edge Computing)                  │
│  SMART ENGINE HYBRIDE                                                   │
│  [1] Cache sha256 ──── HIT ────────────────────→ Réponse               │
│  [2] Rule Engine (~60%) ── OK ─────────────────→ Réponse               │
│  [3] ML Rapide (confidence > 0.82) ── OK ──────→ Réponse               │
│  [4] N8N Fallback ──────────────────────────────→ Réponse              │
│  Résultat → RL Logger → State Engine update                            │
│  Auth · Isolation infirmiere_id · Cabinet multi-IDE · Sync PC↔Mobile  │
└─────────────────────────────────────────────────────────────────────────┘
          │ SQL REST                    │ HTTP POST
          ▼                             ▼
┌─────────────────────┐   ┌──────────────────────────────────────────┐
│  SUPABASE           │   │  N8N v10  (Render · stateless)           │
│  planning_patients  │   │  Pipeline NGAP 51 nœuds                 │
│  cabinets           │   │  RL Decision Logger + Heatmap Scorer    │
│  cabinet_members    │   │  ~20% des appels ami-calcul             │
│  weekly_planning    │   └──────────────────────────────────────────┘
│  signatures_sync    │
└─────────────────────┘
```

---

## Architecture N8N v10 — Pipeline complet (51 nœuds)

```
[POST /ami-calcul] ← Webhook
        │
[0] Router Cabinet — _cabinet_mode → solo (0) ou Split by IDE (1)
        │
[1] NLP Médical v6+v7     [2] RAG NGAP Retriever v7 (BM25)
[3] AI Agent — xAI Grok   [4] Parser résultat IA v5.5
[5] Validateur NGAP V1    [6] Optimisateur € v3 (MCI/IFD/IK/MIE auto)
[7] Validateur NGAP V2    [8] Recalcul NGAP Officiel v5 ← SOURCE DE VÉRITÉ
[9] Analyse Pattern Patient v2     [10] Suggestions alternatives v4
[11] Fraude Detector v7            [12] CPAM Simulator v5
[13] Scoring Infirmière v4         [14] Blocage FSE si HIGH
[15] FSE Generator v6+v7
[16] Sauvegarder en BDD v8         [17] Fusionner réponse v11
[18] Merge Cabinet
[19] RL Decision Logger  ← NOUVEAU v10
     reward = revenue - km_cost - delay_cost → system_logs (RL_DECISION)
[20] Heatmap Zone Scorer ← NOUVEAU v10
     revenue_per_hour · delay_risk · zone_score → zone_data dans réponse
[21] Respond to Webhook
```

---

## Modèle de sécurité & isolation

### Rôles

| Rôle | Accès données patients | Cabinet | Admin |
|---|---|---|---|
| **Infirmière** | Ses propres patients (`infirmiere_id`) | Créer/rejoindre, même seule | Non |
| **Admin** | Ses propres données de test uniquement | Cabinet de test, seul ou avec membres | Oui |

### Règles critiques

- Chaque infirmière ne voit que ses propres données — filtrage strict `infirmiere_id=eq.${user.id}`
- Les admins sont **invisibles entre eux** dans le panneau d'administration
- **Mode cabinet activable dès que cabinet existe, même avec un seul membre (admin seul)**
- RL Logger désactivé pour les admins — les décisions de test ne polluent pas la Q-table

---

## Module cotation.js v8 — Fonctions

### Cotation solo

| Fonction | Description |
|---|---|
| `cotation()` | Pipeline principal — Smart Engine → Rule/ML/N8N |
| `renderCot(d)` | Résultat complet : fraud, CPAM, suggestions, scoring IDE, horaire |
| `openVerify()` / `applyVerify()` / `closeVM()` | Modale vérification IA |
| `verifyStandalone()` | Vérification indépendante du formulaire principal |
| `clrCot()` | Réinitialise formulaire ET panneau cabinet |
| `printInv(d)` | Génère et télécharge la facture PDF |
| `coterDepuisRoute(desc, nom)` | Pré-remplit depuis la tournée |
| `_saveEditedCotation(d)` | Met à jour une cotation existante (IDB + Supabase) |

### Cabinet multi-IDE

| Fonction | Description |
|---|---|
| `initCotationCabinetToggle()` | Toggle visible dès que cabinet existe (admin inclus) |
| `cotationToggleCabinetMode(active)` | Ouvre/ferme panneau "Qui réalise chaque acte ?" |
| `cotationRenderCabinetActes()` | Sélecteurs IDE par acte — NLP 17 patterns, groupés (actes/bsi/majorations) |
| `cotationUpdateCabinetTotal()` | Totaux live par IDE avec coefficients NGAP corrects + gain vs solo |
| `cotationOptimizeDistribution()` | Répartition IA : actes par valeur décroissante alternés |
| `_cotEstimateNGAP(actesIDE)` | Calcule l'estimation NGAP correcte (acte principal ×1, suivants ×0,5) |
| `_cotDetectActes(texte)` | NLP — 17 types : AMI1-6, AIS, BSA/B/C, IFD, NUIT, NUIT_PROF, DIM, MIE, MCI |
| `cotationCabinet(txt)` | Pipeline multi-IDE → `/webhook/cabinet-calcul` |
| `renderCotCabinet(d)` | Résultat enrichi : carte par IDE, détail coefficients, gain vs solo, actions |

---

## Module tournee.js — Fonctions

### Planning hebdomadaire v2.0

| Fonction | Description |
|---|---|
| `renderPlanning(d)` | Rendu complet : filtrage semaine, vue solo ou cabinet multi-IDE |
| `refreshPlanning()` | Actualise + init UI cabinet |
| `planningWeekNav(delta)` | Navigation semaine (-1/+1) — label dynamique |
| `planningToggleCabinetView(active)` | Active la grille jours × IDEs |
| `_planningInitCabinetUI()` | Toggle + "Répartir" visibles dès que cabinet existe — retry 1s async |
| `planningGenerateCabinet()` | Active vue cabinet — accepte admin seul |
| `planningOptimiseCabinetWeek()` | `smartCluster()` sur la semaine → re-rend |
| `generatePlanningFromImport()` | Génère depuis données importées |
| `openCotationPatient(idx)` | Résout dans : uberPatients → **_planningData** → importedData → _planIdx |
| `openCotationPatientFromPatient(p)` | Corps cotation : IDB → API → modal |
| `_planningDeleteCotation(idx)` | Supprime cotation sans retirer le patient |
| `_planningRemovePatient(idx)` | Retire un patient |
| `_planningResetAll()` | Efface tout le planning |

### Sync planning PC ↔ mobile

| Fonction | Description |
|---|---|
| `_savePlanning(patients)` | localStorage (TTL 7 jours) |
| `_loadPlanning()` | Charge depuis localStorage |
| `_syncPlanningToServer(patients)` | Push chiffré AES → `/webhook/planning-push` |
| `_syncPlanningFromServer()` | Pull + fusion si données locales existent |

### Tournée optimisée

| Fonction | Description |
|---|---|
| `optimiserTournee()` | Optimisation OSRM + IA (modes : ia/heure/mixte) |
| `recalculTournee()` | Recalcule sans changer les paramètres |
| `getOsrmRoute(waypoints)` | Itinéraire OSRM |
| `_renderRouteHTML(route, osrm, ca, rentab, mode)` | HTML tournée |
| `removeFromTournee(encodedId, idx)` | Retire un patient |
| `clearTournee()` | Vide la tournée |

### Pilotage live

| Fonction | Description |
|---|---|
| `startDay()` | Démarre la journée — GPS, minuterie, tournée |
| `stopDay()` | Termine — CA final |
| `liveStatus()` | État live (local immédiat + sync arrière-plan) |
| `liveAction(action)` | done/absent/undo/cot |
| `renderLivePatientList()` | Liste pilotage |
| `autoFacturation(patient)` | Cotation automatique |
| `startLiveTimer()` / `detectDelay(p)` | Minuterie + détection retards |
| `analyzeLive(texte)` / `renderLiveReco(texte)` | NLP + recommandations temps réel |
| `autoCotationLocale(texte)` | Fallback cotation offline |

### Tournée cabinet

| Fonction | Description |
|---|---|
| `optimiserTourneeCabinet()` | Répartit patients entre IDEs — accepte membre seul (admin solo) |
| `optimiserTourneeCabinetCA()` | Optimise pour maximiser revenus — accepte membre seul |
| `_renderTourneeCabinetHTML(assignments, scoreData)` | HTML résultat multi-IDE |

### Import calendrier

| Fonction | Description |
|---|---|
| `importCalendar()` | Import ICS/CSV/JSON/TXT/texte libre |
| `_processImportData(content, source)` | Parse et normalise |
| `_autoAddImportedToCarnet(patients)` | Ajoute au carnet IDB sans doublons |
| `geocodeImportedPatients()` | Géocode les adresses importées |

---

## Module cabinet.js v2.0 — Fonctions

| Fonction | Description |
|---|---|
| `initCabinet()` | Charge l'état cabinet au login (silencieux, async) |
| `renderCabinetSection()` | Vue "Mon Cabinet" (guard : vue active) |
| `cabinetCreate()` | Crée un cabinet |
| `cabinetJoin()` | Rejoint par ID |
| `cabinetLeave()` | Quitte le cabinet |
| `cabinetCopyId(id)` | Copie l'ID cabinet |
| `cabinetToggleSyncWhat(key, checked)` | Type de données à synchroniser |
| `cabinetToggleSyncWith(memberId, checked)` | Destinataire de sync |
| `cabinetPushSync()` | Envoie données sélectionnées (consentement explicite) |
| `cabinetPullSync()` | Reçoit données des collègues |
| `cabinetSyncStatus()` | Dernière sync de chaque membre |
| `cabinetCotation(basePayload, actes)` | Cotation multi-IDE → `/webhook/cabinet-calcul` |
| `cabinetTournee(patients)` | Tournée cabinet → `/webhook/cabinet-tournee` |
| `_updateCabinetBadge(nbMembers)` | Badge "N membres" sidebar |
| `_updateTourneeCabinetPanel()` | Panel tournée visible dès que cabinet existe |

---

## Module ai-tournee.js v6.0 — Fonctions

### Moteur de tournée

| Fonction | Description |
|---|---|
| `optimizeTour(patients, start, startTime, mode)` | TSP hybride : géo + médical + trafic + lookahead |
| `twoOpt(route)` | Optimisation 2-opt locale |
| `simulateLookahead(from, remaining, depth, depMin)` | Lookahead IA profondeur 2 |
| `recomputeRoute()` | Recalcule la route en cours |
| `startLiveOptimization()` / `stopLiveOptimization()` | Boucle live toutes les 5 min |

### Scoring et heuristiques

| Fonction | Description |
|---|---|
| `medicalWeight(p)` | Score médical (urgence, dépendance, contrainte horaire) |
| `dynamicScore({ currentTime, travelTime, patient, userPos })` | Score composite dynamique |
| `geoPenalty(patient, userPos)` | Pénalité éloignement du cluster |
| `trafficFactor(departureMin, date)` | Coefficient trafic CEREMA |
| `trafficAdjust(osrmMin, departureMin, date)` | Ajuste le temps OSRM |
| `scoreTourneeRentabilite(route)` | Score rentabilité €/km |
| `_estimateFatigueFactor(nbStops, km, minutes)` | Facteur fatigue IDE (×1.0 → ×1.4) |

### Cabinet multi-IDE

| Fonction | Description |
|---|---|
| `cabinetGeoCluster(patients, k)` | K-means géographique pour k IDEs |
| `cabinetPlanDay(patients, members)` | Plan journée multi-IDE (synchrone) |
| `cabinetScoreDistribution(assignments)` | Score €/km, pénalise les déséquilibres |
| `cabinetOptimizeRevenue(assignments, members)` | 30 itérations de swap patients |
| `cabinetBuildUI(assignments, scoreData)` | HTML résumé planning multi-IDE |

### IA avancée

| Fonction | Description |
|---|---|
| `smartCluster(patients, k)` | Clustering hybride géo + score € (20 itérations) |
| `planWithRevenueTarget({ patients, members, target })` | Planning piloté par objectif CA |
| `planWithTargetAndSurge({ patients, members, target, zones })` | Planning objectif + surge zones |
| `predictDelayLive({ ide, route })` | Prédit retards live → LOW/MEDIUM/HIGH |
| `autoReassignIfRisk({ planning, infirmieres })` | Réassigne si risque HIGH |
| `startCabinetLiveOptimization(...)` / `stopCabinetLiveOptimization()` | Boucle live 15s |
| `_surgeScore({ demand, supply, delayRisk, fatigueAvg })` | Score tension zone |

### Transport

| Fonction | Description |
|---|---|
| `getTravelTimeOSRM(a, b)` | Temps trajet OSRM en minutes |
| `cachedTravel(a, b)` | Trajet avec cache mémoire |
| `trafficAwareCachedTravel(a, b, departureMin)` | Trajet cache + trafic |
| `addUrgentPatient(patient)` | Insère un urgent dans la tournée |
| `cancelPatient(patientId)` | Retire un patient annulé |
| `completePatient(patientId, actualArrivalMin)` | Marque terminé + stats |

---

## Module map.js v2.0 — Fonctions

### Correction de position

| Fonction | Description |
|---|---|
| `enableCorrectionMode(lat, lng)` | Mode correction de position |
| `confirmCorrectedPosition(patientId)` | Sauvegarde position corrigée |
| `enablePatientCorrection(patientId, idx, lat, lng, nom)` | Correction patient spécifique |
| `enableStartPointCorrection(map, lat, lng, onConfirm)` | Correction point de départ |
| `openStartPointEditor(context)` | Éditeur point de départ |
| `useMyLocation(patientId)` | Géolocalisation GPS |

### Carte

| Fonction | Description |
|---|---|
| `renderPatientsOnMap(patients)` | Marqueurs patients Leaflet |
| `searchLiveStartPoint()` | Recherche adresse départ live |
| `useLiveMyLocation()` | GPS pilotage live |

### Heatmap zones rentables

| Fonction | Description |
|---|---|
| `computeHeatmap(cotations)` | Agrège par grille ~110m → `revenue_per_hour` |
| `renderHeatmap(grid, metric)` | Calque Leaflet.heat (bleu→orange→rouge→violet) |
| `toggleHeatmap()` | Bascule on/off — charge cache ou API |
| `gridKey(lat, lng, precision)` | Clé de grille géographique |
| `_showHeatmapPanel(grid)` | Panneau flottant top 5 zones €/h |

---

## Module dashboard.js v2.0 — Fonctions

| Fonction | Description |
|---|---|
| `loadDash()` | Charge les cotations + rend le dashboard |
| `renderDashboard(arr)` | KPIs, graphique 30j, top actes, prévision, anomalies, IA |
| `detectAnomalies(rows, daily)` | Détection statistique (σ) des anomalies |
| `renderAnomalies(result)` | Affiche les anomalies |
| `explainAnomalies(rows, result)` | Explications textuelles des anomalies |
| `suggestOptimizations(rows)` | Suggestions d'optimisation NGAP |
| `renderAI(explanations, suggestions)` | Bloc analyse IA |
| `computeLoss(rows)` / `showLossAlert(loss)` | Calcul + alerte perte de revenus |
| `forecastRevenue(daily)` | Prévision fin de mois par tendance linéaire |
| `loadDashCabinet()` | KPIs cabinet + revenus par IDE (si cabinet actif) |
| `runCabinetSimulator()` | Simulateur revenus cabinet |
| `runCabinetCATarget()` | Objectif CA mensuel avec suggestions + barre progression |

**Ordre des sections :**
1. KPIs · Graphique 30j · Top actes · Prévision · Alertes · Anomalies · Analyse IA
2. **📊 Statistiques avancées**
3. **🏥 Statistiques cabinet** (si cabinet actif)

---

## Module patients.js — Fonctions

| Fonction | Description |
|---|---|
| `initPatientsDB()` | Initialise IndexedDB `ami_patients_db_<userId>` |
| `openAddPatient()` | Formulaire ajout |
| `savePatient()` | Crée/met à jour fiche (géocodage auto) |
| `loadPatients()` | Liste avec recherche |
| `openPatientDetail(id)` | Vue détail avec onglets |
| `editPatient(patId)` | Mode édition |
| `_saveOrdo(patientId)` | Sauvegarde ordonnance |
| `_editOrdo` / `_deleteOrdo` | Gestion ordonnances |
| `_calcOrdoExp()` | Alerte expiration 30 jours |
| `_enc(obj)` / `_dec(str)` | Chiffrement/déchiffrement btoa (clé JWT) |
| `_idbPut` / `_idbGetAll` / `_idbDelete` | IDB bas niveau |

---

## Module security.js v2.0 — Fonctions

### Chiffrement AES-256-GCM

| Fonction | Description |
|---|---|
| `generateEncKey(password, saltHex)` | Dérive clé AES-256 via PBKDF2 (100k itérations) |
| `initSessionKey(token)` | Initialise la clé de session depuis JWT |
| `encryptData(obj)` / `decryptData(payload)` | Chiffrement/déchiffrement objet |
| `encryptField(str)` / `decryptField(json)` | Chiffrement champ individuel |
| `saveSecure` / `loadSecure` / `loadAllSecure` / `clearSecureStore` | IDB sécurisé |

### RGPD & PIN

| Fonction | Description |
|---|---|
| `hasConsent()` / `checkConsent()` / `showConsentModal()` | Gestion consentement |
| `acceptConsent()` / `revokeConsent()` | Accept / révoque |
| `exportMyData()` | Export RGPD complet (JSON) |
| `purgeLocalData()` | Purge toutes les données locales |
| `auditLocal(action, detail)` | Log action dans audit_logs |
| `setupPIN(pin)` / `checkPIN(pin)` / `lockApp()` / `unlockApp()` | PIN + verrouillage |

---

## Module signature.js — Fonctions

| Fonction | Description |
|---|---|
| `openSignatureModal(invoiceId)` | Canvas signature pour une facture |
| `saveSignature()` | Sauvegarde chiffrée + sync serveur |
| `injectSignatureInPDF(invoiceId)` | Injecte dans le PDF facture |
| `getSignature(invoiceId)` / `deleteSignature(invoiceId)` | Lecture/suppression |
| `syncSignaturesToServer()` / `syncSignaturesFromServer()` | Sync bidirectionnelle |

---

## Module rapport.js — Fonctions

| Fonction | Description |
|---|---|
| `generateRapportMensuel()` | Rapport PDF mensuel |
| `previewRapport()` | Prévisualisation HTML |
| `loadSystemHealth()` | Stats N8N + Smart Engine (admin) |
| `lookupNGAP(code)` | Lookup code NGAP |
| `searchNGAP(query)` | Recherche référentiel (BM25 léger) |
| `validateNGAPCumul(actes)` | Vérifie règles de cumul côté client |
| `renderNGAPSearch()` | Rendu recherche référentiel |

---

## Module infirmiere-tools.js — Fonctions

| Fonction | Description |
|---|---|
| `calculerCharges()` | Simulateur URSSAF + CARPIMKO + IR — barème 2026 |
| `addKmEntry()` / `deleteKmEntry(id)` / `renderKmJournal()` | Journal kilométrique |
| `exportKmCSV()` | Export CSV journal |
| `syncKmFromServer()` | Sync depuis `/webhook/km-pull` |
| `_getKmRate(cv, kmAnnuel, electrique)` | Barème IK selon véhicule |
| `renderModeles()` / `utiliserModele(id)` | Bibliothèque modèles de soins |
| `sauvegarderModele()` / `modifierModele(id)` / `supprimerModele(id)` | CRUD modèles |
| `simulerMajoration()` | Calcul AMI/AIS/BSx + IFD/IK/MIE/MCI selon heure/jour/contexte |
| `utiliserSimulation(...)` | Transfère vers formulaire cotation |

---

## Module admin.js v4.0 — Fonctions

| Fonction | Description |
|---|---|
| `loadAdm()` / `admTab(tab)` | Panneau admin — onglets |
| `loadAdmComptes()` | Liste infirmières (admins exclus) |
| `loadAdmStats()` | Stats globales + Smart Engine |
| `_admFilterNurses(q)` / `_admSortNurses(mode)` | Filtre + tri |
| `_admNurseCard(u, maxCA)` | Carte infirmière avec KPIs |
| `loadAdmLogs()` / `_applyAuditFilters()` | Logs d'audit avec filtres |
| `exportAuditCSV()` | Export CSV logs |
| `loadAdmSecurityStats()` | Stats sécurité |

---

## Module copilote.js — Fonctions

| Fonction | Description |
|---|---|
| `toggleCopilot()` | Ouvre/ferme panneau flottant |
| `sendCopilotMessage(text)` | Envoie un message |
| `sendCopilotFull()` | Mode page complète avec contexte enrichi |
| `clearCopilotHistory()` | Efface l'historique |
| `openCopilotSection()` / `initCopiloteSection()` | Vue copilote complète |
| `_buildContext()` | Contexte NGAP (dernières cotations, profil) |
| `_askClaude(question)` | Appel `/webhook/ami-copilot` |

---

## Module onboarding.js — Fonctions

| Fonction | Description |
|---|---|
| `checkOnboarding()` | Vérifie si les intros ont été vues |
| `resetOnboarding()` | Remet toutes les intros à zéro |
| `showMainIntro()` | Intro principale |
| `showPatientsIntro()` | Intro carnet patients |
| `showTourneeIntro()` | Intro tournée IA |
| `showLiveIntro()` | Intro pilotage live |

---

## Routes API — Cloudflare Worker v7.0

### Authentification & Profil

| Route | Permissions | Rôle |
|---|---|---|
| `POST /webhook/auth-login` | Public | Login JWT |
| `POST /webhook/infirmiere-register` | Public | Création compte |
| `POST /webhook/change-password` | Auth | Modification mot de passe |
| `POST /webhook/delete-account` | Auth | Suppression compte |
| `POST /webhook/profil-get` / `profil-save` | Auth | Profil infirmière |
| `POST /webhook/prescripteur-liste` / `-add` / `-get` | Auth | Gestion prescripteurs |

### Cotation NGAP (Smart Engine v7)

| Route | Permissions | Rôle |
|---|---|---|
| `POST /webhook/ami-calcul` | Auth | Smart Engine → Rule/ML/N8N auto |
| `POST /webhook/ami-calcul` + `cabinet_mode:true` | Auth | Split IDE → N8N parallèle → merge |
| `GET /webhook/ami-historique` | Auth | Historique cotations Supabase direct |
| `POST /webhook/ami-supprimer` | Auth | Suppression par ID ou patient_id |
| `POST /webhook/ami-supprimer-tout` | Auth | Suppression groupée |
| `POST /webhook/ami-save-cotation` | Auth | Sauvegarde cotation tournée live |

### Cabinet multi-IDE

| Route | Permissions | Rôle |
|---|---|---|
| `POST /webhook/cabinet-register` | Auth | Créer/rejoindre/quitter |
| `POST /webhook/cabinet-get` | Auth | Infos + membres |
| `POST /webhook/cabinet-calcul` | Auth | Cotation multi-IDE parallèle |
| `POST /webhook/cabinet-tournee` | Auth (`!isAdmin && manage_tournee` ou admin) | Distribution patients clustering géo |
| `POST /webhook/cabinet-sync-push` / `-pull` / `-status` | Auth | Sync sélective anonymisée (TTL 7j) |

### Tournée & IA

| Route | Permissions | Rôle |
|---|---|---|
| `POST /webhook/ami-tournee-ia` | Auth | Tournée + heatmap scoring |
| `POST /webhook/ami-live` | Auth | Pilotage live |
| `POST /webhook/ami-copilot` | Auth | Copilote NGAP |
| `POST /webhook/ami-week-analytics` | Auth | Analyse hebdomadaire |
| `POST /webhook/ami-forecast` | Auth | Prévision revenus |
| `POST /webhook/import-calendar` | Auth | Import calendrier |

### Heatmap

| Route | Permissions | Rôle |
|---|---|---|
| `POST /webhook/heatmap-push` | Infirmière | Envoyer données de zone |
| `POST /webhook/heatmap-pull` | Infirmière | Lire heatmap enrichie (avec scores) |

### Sync PC ↔ Mobile

| Route | Rôle |
|---|---|
| `POST /webhook/planning-push` / `-pull` | Planning hebdomadaire chiffré |
| `POST /webhook/km-push` / `-pull` | Journal kilométrique chiffré |
| `POST /webhook/heure-push` / `-pull` | Cache heures soins |
| `POST /webhook/signatures-push` / `-pull` / `-delete` | Signatures PNG chiffrées |
| `POST /webhook/patients-push` / `-pull` / `-delete` | Carnet patients chiffré |

### Contact & Messagerie

| Route | Permissions | Rôle |
|---|---|---|
| `POST /webhook/contact-send` | Infirmière | Message vers admin |
| `POST /webhook/contact-mes-messages` | Auth | Historique messages |
| `POST /webhook/admin-messages` | Admin | Messagerie admin |
| `POST /webhook/admin-message-read` / `-reply` | Admin | Lecture/réponse |

### Admin & Monitoring

| Route | Permissions | Rôle |
|---|---|---|
| `POST /webhook/admin-liste` | Admin | Liste comptes infirmières |
| `POST /webhook/admin-stats` | Admin | Stats globales |
| `POST /webhook/admin-logs` | Admin | Logs d'audit |
| `POST /webhook/admin-security-stats` | Admin | Stats sécurité |
| `POST /webhook/admin-bloquer` / `-debloquer` / `-supprimer` | Admin | Gestion comptes |
| `POST /webhook/admin-engine-stats` | Admin | **Stats Smart Engine + RL + State** |
| `POST /webhook/admin-system-reset` | Admin | Reset logs système |
| `POST /webhook/log` | Public | Log frontend → system_logs |

---

## Smart Engine v7.0 — Pipeline de décision

```
INPUT { texte, heure_soin, km, date_soin }
        │
sha256(texte+heure+km+date) ──── Cache HIT? ── OUI → { source: 'cache' }
        │ MISS
        ▼
_isSimpleCase(body)?  [NON si : perfusion, escarre, toilette grabataire,
                       nuit profonde, dimanche, cabinet, plusieurs actes]
  OUI → fallbackCotation() ── actes>0 & total>0? → { source: 'rule' }
        │ NON
        ▼
_mlPredict(body)
  features : injection +0.15, prélèvement +0.15, pansement +0.10,
             heure_soin +0.05, domicile +0.05, ambiguïté -0.30
  confidence > 0.82? → { source: 'ml' }
        │ NON
        ▼
N8N complet → résultat mis en cache 1h → { source: 'n8n' }
```

---

## Logique cotation — règles upsert

```
Patient existe dans le carnet ?
├── OUI → Upsert (cotation existante)
│         Résolution index : cotationIdx > invoice_number > invoice_number original
│         Si aucun index trouvé ET mode édition (_editRef) → ne rien faire
│
└── NON → Créer fiche patient + cotation (une seule fois)
          Uniquement si ce n'est PAS une correction (_editRef absent)
```

| Situation | Comportement |
|---|---|
| Patient existant + mode édition + index trouvé | Mise à jour |
| Patient existant + pas de mode édition | Ajout (1ère fois) |
| Patient existant + mode édition + index introuvable | Rien (évite doublon) |
| Patient absent + pas de mode édition | Crée fiche + cotation |
| Patient absent + mode édition | Rien (évite fiche fantôme) |

---

## Tarifs NGAP 2026

| Code | Libellé | Tarif | Règle |
|---|---|---|---|
| AMI1–AMI6 | Actes infirmiers de soins | 3,15 € × coeff | Principal ×1 · secondaire ×0,5 |
| AIS1, AIS3 | Aide infirmier soins | 2,65 € / 7,95 € | Principal ×1 · secondaire ×0,5 |
| BSA | Dépendance légère | 13,00 € | Forfait fixe |
| BSB | Dépendance modérée | 18,20 € | Forfait fixe |
| BSC | Dépendance lourde | 28,70 € | Forfait fixe |
| IFD | Déplacement domicile | 2,75 € | 1 seule par passage |
| IK | Kilométrique | km × 2 × 0,35 € | Distance documentée obligatoire |
| MCI | Coordination | 5,00 € | Fixe |
| MIE | Enfant < 7 ans | 3,15 € | Fixe |
| NUIT | 20h–23h / 5h–8h | 9,15 € | Non cumulable DIM |
| NUIT_PROF | 23h–5h | 18,30 € | Non cumulable DIM |
| DIM | Dimanche/Férié | 8,50 € | Non cumulable NUIT |

**Cumuls interdits :** AIS+BSx · plusieurs BSx · NUIT+DIM · NUIT_PROF+DIM · IFD multiple

---

## Système preuve soin

| Type | Force probante | Fraude | CPAM |
|---|---|---|---|
| `auto_declaration` | STANDARD | neutre | Accepté |
| `signature_patient` | FORTE | −3 pts | Supprime 1 anomalie |
| `photo` (hash uniquement) | FORTE | −3 pts | Supprime 1 anomalie |
| Absent | ABSENTE | +3 pts | Anomalie ajoutée |

> Photo et signature ne sont **jamais transmises** — uniquement leur hash djb2.

---

## Heuristique trafic

| Créneau | Jours | Coefficient |
|---|---|---|
| 7h15–9h30 | Lun–Ven | ×1.65 🔴 Pointe matin |
| 11h45–14h15 | Lun–Ven | ×1.30 🟡 Déjeuner |
| 16h30–19h30 | Lun–Ven | ×1.75 🔴 Pointe soir |
| 19h30–21h | Lun–Ven | ×1.20 🟡 Après pointe |
| 9h30–12h30 | Sam | ×1.25 🟡 Sam. matin |
| Reste | Tous | ×1.0 🟢 Fluide |

---

## Matrice des permissions

```javascript
nurse:  ['create_invoice', 'view_own_data', 'import_calendar',
         'manage_tournee', 'manage_prescripteurs',
         'change_password', 'delete_account']

admin:  ['view_users_list', 'view_stats', 'view_logs',
         'change_password', 'delete_account']

// Règles spéciales v8 :
// - Routes cabinet : !isAdmin && !hasPermission → admins autorisés pour tests
// - cabinet-tournee : !isAdmin && !manage_tournee → admins autorisés (fix v8)
// - Mode cabinet activable même admin seul (members.length >= 0)
// - RL Logger désactivé pour les admins
// - Les admins sont INVISIBLES dans le panneau d'administration
```

---

## Stockage local — isolation multi-utilisateurs

| Données | Base | Isolation | Chiffrement |
|---|---|---|---|
| Patients | IndexedDB `ami_patients_db_<userId>` | Par userId | AES-256 (clé JWT) |
| Signatures | IndexedDB `ami_sig_db_<userId>` | Par userId | AES-256 |
| Corrections GPS | IndexedDB `geocodeDB` | Partagé (non-sensible) | Non |
| Cotations | Supabase `planning_patients` | `infirmiere_id` | Chiffrement champ |
| Cache dashboard | localStorage `ami_dash_<userId>_*` | Par userId | Non |
| Planning | localStorage `ami_planning_<userId>` | Par userId | Non |
| Smart Engine cache | Worker memory Map (TTL 1h) | Anonymisé sha256 | sha256 |
| RL Q-table | Worker memory | Global (reset deploy) | Non |
| Cabinet sync prefs | localStorage `ami_cabinet_sync_<userId>` | Par userId | Non |

> **Règle fondamentale :** les données de santé sont stockées exclusivement sur le terminal de l'utilisateur et ne sont jamais transmises à nos serveurs.

---

## Architecture des fichiers

| Fichier | Rôle | Version |
|---|---|---|
| `worker.js` | Cloudflare Worker — Smart Engine, RL, State, Heatmap, toutes les routes | v7.0 |
| `sw.js` | Service Worker PWA | v3.6 |
| `auth.js` | Login/logout/session/navigation | — |
| `security.js` | AES-256-GCM, PIN, RGPD, export, audit | v2.0 |
| `cabinet.js` | Cabinet multi-IDE complet | v2.0 |
| `cotation.js` | Cotation NGAP + mode cabinet | v8 |
| `tournee.js` | Tournée + planning hebdomadaire + cabinet | v6.0 |
| `ai-tournee.js` | TSP, clustering, fatigue, surge, prédiction retard | v6.0 |
| `map.js` | Leaflet + heatmap zones rentables | v2.0 |
| `dashboard.js` | KPIs + stats cabinet + simulateur | v2.0 |
| `patients.js` | Carnet patients IndexedDB chiffré | — |
| `signature.js` | Signatures canvas + sync | — |
| `rapport.js` | Rapport PDF + référentiel NGAP | — |
| `admin.js` | Panneau admin + Smart Engine stats | v4.0 |
| `infirmiere-tools.js` | Charges, km, modèles, majorations | — |
| `copilote.js` | Chat Copilote NGAP | — |
| `ui.js` | Navigation + handlers spéciaux | — |
| `utils.js` | Store APP, helpers, apiCall | — |
| `ai-assistant.js` | Assistant vocal NLP + TTS | v1.1 |
| `voice.js` | Dictée médicale | — |
| `onboarding.js` | Introductions guidées (4 modules) | — |
| `geocode.js` | Photon → Nominatim → cache IDB | — |
| `extras.js` | OSRM, scoring fraude front | — |
| `uber.js` | Mode Uber Médical | — |
| `contact.js` | Messagerie infirmière → admin | — |
| `AI_Agent_AMI_v10.json` | Workflow N8N — 51 nœuds | v10 |
| `README.md` | Documentation technique (ce fichier) | **v8.0** |
| `GUIDE_INFIRMIERES.md` | Guide pratique & FAQ (chargé dynamiquement) | — |
