# AMI — Documentation Architecture v10.1

> **Application web progressive (PWA) pour infirmières libérales.**
> Cotation NGAP automatique, tournée optimisée, carnet patients chiffré, signatures électroniques, **mode cabinet multi-IDE**, moteur hybride Smart Engine IA, planning hebdomadaire, modules cliniques avancés (transmissions, constantes, pilulier, BSI, consentements, alertes médicamenteuses, simulateur audit CPAM, compte-rendu de passage).

---

## Versions

| Composant | Version | Nouveautés |
|---|---|---|
| **Worker backend** | **v7.1** | Fix `isHallucination` — suppression du test regex `/unknown/` qui déclenchait le fallback sur les réponses légitimes |
| **Agent IA N8N** | **v10** | 51 nœuds — RL Decision Logger + Heatmap Zone Scorer · fix `Fusionner réponse` `.first()` + parallélisation |
| **Preuve Update** | **v1** | Workflow séparé — UPDATE `preuve_soin` sur cotation existante via `invoice_number` (signature post-cotation) |
| **ML Nightly** | **v1** | Workflow Cron 2h — entraînement SGD depuis RL_DECISION + staffing + rapport Supabase |
| **utils.js** | **v5.1** | `_PATHO_MAP` v2.0 — 23 catégories, 80+ abréviations médicales couvertes |
| **tournee.js** | **v6.1** | Fix enrichissement `texteForCot` pathologies → actes · `autoCotationLocale` aligné sur `_PATHO_MAP` v2 |
| **cotation.js** | **v8.1** | Doctrine upsert stricte — résolution index `cotationIdx > invoice_number > invoice_number original > date YYYY-MM-DD` |
| **ui.js** | **v5.2** | Fix parser Markdown FAQ — rendu tableau unifié (thead/tbody), suppression `<br>` parasites |
| Module cabinet | v2.1 | Démo solo admin, mode cabinet sans membres réels |
| Cotation | v8 | NLP 17 patterns, sélecteur IDE par acte, estimation NGAP correcte côté client |
| Planning hebdomadaire | v2.0 | Navigation semaine, vue cabinet multi-IDE |
| Tournée IA | v6.1 | Cabinet multi-IDE, clustering, fatigue, surge, prédiction retard |
| Dashboard | v2.0 | KPIs multi-IDE, simulateur revenus, objectif CA |
| Heatmap zones | v2.0 | Scoring décisionnel enrichHeatmap + scorePatientZone |
| Admin panel | v4.1 | Accès complet aux modules cliniques v2 |
| patients.js | v2.0 | Onglets Constantes + Semainier dans la fiche patient |
| transmissions.js | v2.0 | Cabinet multi-IDE, destinataire, badge non-lus |
| constantes.js | v1.0 | Suivi TA, glycémie, SpO2, poids, T°, EVA, FC — graphiques canvas |
| pilulier.js | v1.0 | Semainier hebdomadaire, impression, archivage fiche patient |
| bsi.js | v1.0 | Bilan de Soins Infirmiers, grille dépendance, BSI 1/2/3 |
| consentements.js | v1.0 | Consentements éclairés, signature canvas, archivage |
| alertes-medicaments.js | v1.0 | Détection interactions ANSM, 14 règles CI/DANGER/ATTENTION |
| audit-cpam.js | v1.0 | Compte-rendu de passage + Simulateur audit CPAM 8 règles |
| PWA / Service Worker | v3.6 | Cache offline, tiles carte |
| Sécurité RGPD | v2.0 | Isolation multi-users IndexedDB par userId |

---

## Architecture globale

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TERMINAL UTILISATEUR                               │
│  FRONTEND (GitHub Pages)                                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────────────────┐ │
│  │cotation.js│ │tournee.js│ │patients.j│ │  cabinet.js v2.1               │ │
│  │NGAP v8   │ │v6.1      │ │v2.0 IDB  │ │  multi-IDE · démo solo admin   │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────────────────┐ │
│  │dashboard │ │map.js v2 │ │ai-tournee│ │  security.js AES-256-GCM       │ │
│  │KPIs+Cab  │ │Heatmap   │ │Smart TSP │ │                                │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────────────────────┘ │
│  ┌──────────┐ ──────────────────────────────────────────────────────────── │
│  │utils.js  │  _PATHO_MAP v2.0 — 23 catégories · 80+ abréviations méd.   │ │
│  │v5.1      │  pathologiesToActes() → texte NGAP → tournée/pilotage       │ │
│  └──────────┘                                                              │ │
│                                                                             │
│  ── MODULES CLINIQUES v2 (100% local, jamais transmis) ─────────────────── │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐│
│  │transmissions│ │  constantes │ │   pilulier   │ │       bsi.js         ││
│  │.js v2.0     │ │  .js v1.0   │ │   .js v1.0   │ │       v1.0           ││
│  │SOAP/DAR cab │ │TA,Gly,SpO2  │ │  Semainier   │ │ Grille dépendance    ││
│  └─────────────┘ └─────────────┘ └──────────────┘ └──────────────────────┘│
│  ┌─────────────┐ ┌──────────────────────────────┐ ┌──────────────────────┐│
│  │consentements│ │  alertes-medicaments.js v1.0  │ │    audit-cpam.js     ││
│  │.js v1.0     │ │  14 règles ANSM CI/DANGER     │ │    v1.0              ││
│  │Signature    │ └──────────────────────────────┘ │ CR passage + Audit   ││
│  └─────────────┘                                   └──────────────────────┘│
│                                                                             │
│  STOCKAGE LOCAL (jamais transmis aux serveurs)                              │
│  ├── IndexedDB ami_patients_db_<userId>     ← données santé AES-256        │
│  │    └── champs: constantes[], piluliers[]                                │
│  ├── IndexedDB ami_sig_db_<userId>          ← signatures AES-256           │
│  ├── IndexedDB ami_transmissions v2         ← SOAP/DAR + destinataire      │
│  ├── IndexedDB ami_constantes               ← mesures TA/Gly/SpO2…         │
│  ├── IndexedDB ami_piluliers                ← semainiers hebdo              │
│  ├── IndexedDB ami_bsi                      ← évaluations BSI              │
│  ├── IndexedDB ami_consentements            ← consentements signés         │
│  └── localStorage ami_dash_<userId>_*      ← cache non-sensible            │
└─────────────────────────────────────────────────────────────────────────────┘
                               │ HTTPS · JWT
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│               CLOUDFLARE WORKER v7.1  (Edge Computing)                      │
│  SMART ENGINE HYBRIDE                                                       │
│  [1] Cache sha256 ──── HIT ────────────────────→ Réponse                   │
│  [2] Rule Engine (~60%) ── OK ─────────────────→ Réponse                   │
│  [3] ML Rapide (confidence > 0.82) ── OK ──────→ Réponse                   │
│  [4] N8N Fallback ──────────────────────────────→ Réponse                  │
│  Résultat → RL Logger → State Engine update                                │
│  Auth · Isolation infirmiere_id · Cabinet multi-IDE · Sync PC↔Mobile      │
│  Fix v7.1 : isHallucination() — test /unknown/ supprimé                    │
└─────────────────────────────────────────────────────────────────────────────┘
          │ SQL REST                    │ HTTP POST
          ▼                             ▼
┌─────────────────────┐   ┌──────────────────────────────────────────────────┐
│  SUPABASE           │   │  N8N v10  (Render · stateless)                   │
│  planning_patients  │   │  Pipeline NGAP 51 nœuds                         │
│  cabinets           │   │  Fusionner réponse v12 — .first() fix            │
│  cabinet_members    │   │  Respond to Webhook en parallèle de Merge Cabinet│
│  weekly_planning    │   │  ~20% des appels ami-calcul                     │
│  signatures_sync    │   └──────────────────────────────────────────────────┘
└─────────────────────┘
```

---

## Architecture N8N v10 — Pipeline complet (51 nœuds)

```
[POST /ami-calcul] ← Webhook
        │
[0] Router Cabinet (IF node) — _cabinet_mode → solo (false) ou Split by IDE (true)
        │
[1] NLP Médical v6+v7     [2] RAG NGAP Retriever v7 (BM25)
[3] AI Agent — xAI Grok   [4] Parser résultat IA v5.5
[5] Validateur NGAP V1    [6] Optimisateur € v3 (MCI/IFD/IK/MIE auto)
[7] Validateur NGAP V2    [8] Recalcul NGAP Officiel v5 ← SOURCE DE VÉRITÉ
[9] Analyse Pattern Patient v2     [10] Suggestions alternatives v4
[11] Fraude Detector v7            [12] CPAM Simulator v5
[13] Scoring Infirmière v4         [14] Blocage FSE si HIGH
[15] FSE Generator v6+v7
[16] Mode spécial ?  ← bypass DB si _skip_db / blocked / mode≠ngap
[17] Sauvegarder en BDD v8
[18] Fusionner réponse v12  ← .first()?.json fix · try/catch BDD indépendant
        │
        ├─→ [19] Respond to Webhook  ← chemin CRITIQUE (réponse immédiate)
        └─→ [20] Merge Cabinet  ← parallèle non-bloquant
                      └─→ [21] RL Decision Logger
                                └─→ [22] Heatmap Zone Scorer  (terminal)
```

---

## Workflows N8N auxiliaires

### Workflow — `AMI_Cotation_Preuve_Update_v1`

> **Route :** `POST /webhook/cotation-preuve-update`
> **Déclencheur :** l'infirmière signe un patient **après** que la cotation ait déjà été créée (cas nominal — signature UX post-cotation).
> **Objectif :** mettre à jour le champ `preuve_soin` (JSONB) d'une cotation existante, identifiée par son `invoice_number`, sans créer de doublon dans l'historique des soins.

**Pipeline (8 nœuds) :**
```
[🎣 Webhook Preuve Update]
        │
[✅ Valider payload] ── invoice_number + user_id + preuve_soin{type,timestamp,hash,…}
        │
[🔀 Payload valide ?]
        ├── false → [⛔ Respond 400]
        └── true  → [🗄️ Ensure colonne preuve_soin]  ← ALTER TABLE IF NOT EXISTS (idempotent)
                          │
                          ▼
                   [🔐 UPDATE preuve_soin]  ← WHERE invoice_number=$1 AND user_id=$2
                          │
                          ▼
                   [🔍 Résultat UPDATE]  ← 0 rows → 404 · 1 row → 200
                          │
                          ▼
                   [📤 Respond Update]
```

**Doctrine AMI respectée :**
- **UPDATE uniquement** (jamais d'INSERT) — pas de doublon dans l'Historique des soins
- **Double isolation** : `invoice_number + user_id` (RGPD / HDS)
- **Hash SHA-256 opaque** uniquement — jamais l'image de signature ni la photo
- **ALTER TABLE IF NOT EXISTS** → idempotent, compatible BDD existante
- **CORS `*`**, `responseNode`, erreurs explicites (400 / 404 / 200)

---

### Workflow — `AMI_ML_Nightly_v1`

> **Déclencheur :** `Cron schedule` — chaque nuit à **2h00** (pas de charge diurne).
> **Objectif :** entraîner le modèle ML du Smart Engine sur les logs RL_DECISION de la veille, générer un rapport staffing, et notifier le Worker.

**Pipeline (9 nœuds) :**
```
[🕑 Cron Nightly 2h]
        │
        ├─→ [📥 Fetch RL_DECISION Logs]     ← system_logs table Supabase (24h window)
        └─→ [📥 Fetch Cotations]            ← planning_patients table Supabase
                          │
                          ▼
                   [🔧 Build ML Dataset]     ← features : injection, perfusion, heure,
                          │                    domicile, ambiguïté, contexte cabinet
                          ▼
                   [🧠 ML Retrain (SGD)]     ← Stochastic Gradient Descent
                          │                    nouveau jeu de poids → model_weights
                          ▼
                   [👥 Staffing + Rapport]   ← forecast besoin IDE / zone / créneau
                          │
                          ▼
                   [💾 Save Report → Supabase]  ← table ml_reports
                          │
                          ▼
                   [📡 Notify Worker (optional)] ← POST /webhook/ml-model-updated

[🚨 Error Logger] ← branché sur tous les nœuds critiques (catch errors → system_logs)
```

**Credentials requis :** `Supabase Service Key` (HTTP Header Auth avec `apikey` + `Authorization: Bearer`).

**Pourquoi à 2h :** évite la charge diurne, les cotations de la veille sont toutes consolidées, le Worker peut récupérer le nouveau modèle avant l'activité matinale.

---

## Conversion Pathologies → Actes NGAP (`utils.js` v5.1)

### Fonctionnement

Quand le champ **Actes Récurrents** d'un patient est vide, `pathologiesToActes(pathologies)` convertit automatiquement le champ **Pathologies** en description d'actes NGAP exploitable par l'IA.

**Priorité dans `tournee.js` v6.1 :**
```
actes_recurrents  →  enrichi si vide avec _pathoConverti
texte importé court (pathologie brute)  →  enrichi avec _pathoConverti
texte importé détaillé (avec actes)  →  conservé tel quel
```

**Fix v6.1 :** Si `patient.description = "Diabète"`, le texte envoyé à N8N devient `"Diabète — Injection insuline SC, surveillance glycémie capillaire, éducation thérapeutique"` plutôt que `"Diabète"` seul qui ne générait que la majoration horaire.

### Table de conversion — `_PATHO_MAP` v2.0

| Catégorie | Pathologies / Abréviations reconnues | Actes NGAP générés |
|---|---|---|
| **Diabète** | diabète, DT1, DT2, DNID, DID, T1D, T2D, insulino-dépendant | Injection insuline SC, surveillance glycémie capillaire, éducation thérapeutique |
| **Plaies / pansements** | plaie, ulcère, escarre, pansement, nécrose, fistule, brûlure, dermite | Pansement complexe, détersion, surveillance plaie, IFD |
| **Anticoagulants** | HBPM, AVK, AOD, NACO, Lovenox, Fragmine, warfarine, apixaban, dabigatran, rivaroxaban, acenocoumarol | Injection SC HBPM, surveillance INR, éducation anticoagulant |
| **Perfusions** | perfusion, antibiotique, chimio, KT, VVP, VVC, cathéter central/périphérique, nutrition parentérale | Perfusion IV domicile, IFD, surveillance tolérance et abord veineux |
| **Nursing / dépendance** | nursing, grabataire, dépendance, GIR 1-4, démence, Alzheimer, Parkinson, tétraplégie, hémiplégie, SLA | Soins de nursing complets, AMI 4, aide toilette BSC, prévention escarres |
| **Cardio / HTA** | HTA, hypertension, IC, insuffisance cardiaque, FA, ACFA, SCA, IDM, post-IDM, angor, cardiomyopathie | Prise TA, surveillance cardiaque, surveillance poids/œdèmes, éducation traitement |
| **Soins palliatifs** | palliatif, fin de vie, soins confort, phase terminale, cancer stade terminal | Soins palliatifs, AMI 4, gestion douleur, nursing complet, surveillance EVA |
| **Prélèvements / bilans** | NFS, CRP, HbA1c, INR, TP, TCA, CK, BNP, ionogramme, créatinine, glycémie veineuse/capillaire | Prélèvement veineux à domicile, BSA, IFD |
| **Sonde / appareillage** | SAD, SAV, stomie, colostomie, iléostomie, trachéotomie, gastrostomie, PEG, SNG | Soin appareillage, surveillance et entretien sonde, AMI 2 |
| **Douleur / morphine** | morphine, oxycodone, fentanyl, antalgique, PCA, patch morphine | Injection antalgique SC/IV, surveillance EVA, gestion PCA |
| **Respiratoire** | asthme, BPCO, MPOC, VNI, OHD, oxygénothérapie, aérosol, nébulisation, dyspnée | Aérosol médicamenteux, surveillance saturation SpO2, éducation inhalateurs |
| **Post-op / chirurgie** | post-op, chirurgie, TVP, EP, embolie pulmonaire, phlébite, suture, agrafes, drain, J0-Jx post | Soins post-opératoires, pansement, surveillance cicatrice, injection HBPM si prescrite |
| **Psychiatrie** | psychiatrie, dépression, schizophrénie, trouble bipolaire, psychose, TSA, TOC, addiction | Suivi infirmier psychiatrique, surveillance observance, éducation thérapeutique |
| **Insuffisance rénale** | IRC, IRT, MRC, DFG, hémodialyse, dialyse péritonéale, fistule dialyse | Surveillance paramètres rénaux, TA, poids/œdèmes, gestion fistule |
| **Oncologie** | cancer, carcinome, lymphome, leucémie, tumeur, néoplasie, HAD oncologique, chimio | Soins oncologiques, perfusion chimio, surveillance tolérance, gestion cathéter |
| **Neurologie** | AVC, AIT, SEP, SLA, séquelles AVC, sclérose en plaques, neuropathie | Soins rééducation infirmière, nursing, surveillance neurologique, prévention escarres |
| **Veineuse / lymphœdème** | insuffisance veineuse, varices, lymphœdème, bandage compressif, contention | Pose bandage compressif, surveillance circulation |
| **Nutrition** | NE, NP, nutrition entérale/parentérale, dénutrition, malnutrition, sonde nasogastrique | Gestion nutrition entérale/parentérale, entretien sonde, surveillance digestive |
| **Urologie** | HBP, LUTS, rétention urinaire, incontinence, troubles mictionnels | Sondage urinaire évacuateur, soins SAD, éducation patient |
| **Apnée du sommeil** | SAS, SAOS, PPC, CPAP, BPAP, VNI | Surveillance appareillage PPC/VNI, éducation utilisation masque |
| **Escarres préventif** | prévention escarre, Braden, matelas anti-escarre, risque cutané | Soins préventifs escarres, nursing, changements de position |
| **Contexte domicile** | SSIAD, HAD, maintien à domicile, retour domicile, sortie d'hospit | Soins infirmiers à domicile, évaluation globale, coordination HAD/SSIAD |

> **Fallback :** si aucune correspondance n'est trouvée, les pathologies brutes sont passées telles quelles à l'IA avec le préfixe `"Soins infirmiers pour : "` afin qu'elle tente une cotation par contexte.

---

## Modèle de sécurité & isolation

### Rôles

| Rôle | Accès données patients | Cabinet | Admin | Modules cliniques v2 |
|---|---|---|---|---|
| **Infirmière** | Ses propres patients (`infirmiere_id`) | Créer/rejoindre, même seule | Non | Oui — données locales |
| **Admin** | Ses propres données de test uniquement | Cabinet de test, solo ou membres réels, mode démo | Oui | Oui — démo complète |

### Règles critiques

- Chaque infirmière ne voit que ses propres données — filtrage strict `infirmiere_id=eq.${user.id}`
- Les admins sont **invisibles entre eux** dans le panneau d'administration
- **Mode cabinet activable dès que cabinet existe, même avec un seul membre (admin seul)**
- **Mode démo solo admin** : cabinet synthétique en mémoire (`_demo: true`) — 2 IDEs simulés, aucune écriture en base
- RL Logger désactivé pour les admins — les décisions de test ne polluent pas la Q-table
- Tous les modules cliniques v2 sont accessibles en mode admin pour la démo et la vérification
- Bannières `🛡️ Mode admin — démo` affichées automatiquement sur chaque module clinique

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

## Module tournee.js v6.1 — Fonctions

### Nouveautés v6.1

- **`texteForCot` enrichi** : si `patient.description` est une pathologie brute (ex : "Diabète"), le texte envoyé à N8N est automatiquement complété avec `pathologiesToActes()` pour garantir un acte principal correct.
- **`autoCotationLocale` v2** : aligné sur `_PATHO_MAP` v2 — reconnaît "surveillance glycémie capillaire", "détersion", "HBPM", "BSA/BSB/BSC", "aérosol". Filet de sécurité AMI1 si rien n'est détecté.

### Planning hebdomadaire v2.0

| Fonction | Description |
|---|---|
| `renderPlanning(d)` | Rendu complet : filtrage semaine, vue solo ou cabinet multi-IDE |
| `refreshPlanning()` | Actualise + init UI cabinet |
| `planningWeekNav(delta)` | Navigation semaine (-1/+1) — label dynamique |
| `planningToggleCabinetView(active)` | Active la grille jours × IDEs |
| `generatePlanningFromImport()` | Génère depuis données importées |
| `openCotationPatient(idx)` | Résout dans : uberPatients → _planningData → importedData → _planIdx |
| `openCotationPatientFromPatient(p)` | Corps cotation : IDB → API → modal |

### Pilotage live

| Fonction | Description |
|---|---|
| `startDay()` | Démarre la journée — GPS, minuterie, tournée |
| `stopDay()` | Termine — CA final |
| `liveAction(action)` | done/absent/undo/cot |
| `autoCotationLocale(texte)` | Fallback cotation offline v2 — aligné _PATHO_MAP |
| `openCotationPatient(idx)` | Génère cotation avec enrichissement pathologies automatique |

### Tournée optimisée

| Fonction | Description |
|---|---|
| `optimiserTournee()` | Optimisation OSRM + IA (modes : ia/heure/mixte) |
| `recalculTournee()` | Recalcule sans changer les paramètres |
| `addUrgentPatient(patient)` | Insère un urgent dans la tournée |

---

## Module utils.js v5.1 — Nouvelles fonctions

| Fonction | Description |
|---|---|
| `pathologiesToActes(pathologies)` | Convertit les pathologies en texte NGAP — `_PATHO_MAP` v2.0 (23 entrées, 80+ abréviations) |
| `window.pathologiesToActes` | Exposée globalement pour `tournee.js`, `extras.js`, `patients.js`, `index.html` |

### `_PATHO_MAP` v2.0 — Nouvelles catégories (v5.1)

| Catégorie | Nouvelles abréviations couvertes |
|---|---|
| Diabète | DT1, DT2, DNID, DID, T1D, T2D |
| Anticoagulants | AOD, NACO, apixaban, dabigatran, rivaroxaban, acenocoumarol |
| Perfusion | KT, VVP, VVC, cathéter central, nutrition parentérale |
| Nursing | GIR 1-4, SLA, tétraplégie, hémiplégie |
| Cardio | FA, ACFA, SCA, IDM, post-IDM, angor |
| Respiratoire | MPOC, VNI, OHD, oxygénothérapie, dyspnée |
| Chirurgie | TVP, EP, embolie pulmonaire, J0-Jx post-op |
| Rein | IRC, IRT, MRC, DFG, hémodialyse, dialyse péritonéale |
| Oncologie | cancer, chimio, HAD oncologique, lymphome, leucémie |
| Neurologie | AVC, AIT, SEP, SLA, neuropathie |
| Veineuse/lymphe | insuffisance veineuse, lymphœdème, bandage compressif |
| Nutrition | NE, NP, dénutrition, sonde naso-gastrique |
| Urologie | HBP, LUTS, rétention urinaire, incontinence |
| Apnée | SAS, SAOS, PPC, CPAP, BPAP |
| Escarres préventif | Braden, matelas anti-escarre, risque cutané |
| Contexte domicile | SSIAD, HAD, maintien à domicile, sortie d'hospit |

---

## Module cabinet.js v2.1 — Fonctions

| Fonction | Description |
|---|---|
| `initCabinet()` | Charge l'état cabinet au login (silencieux, async) |
| `cabinetCreate()` / `cabinetJoin()` / `cabinetLeave()` | Gestion cabinet |
| `cabinetDemoSolo()` | Mode démo admin : cabinet synthétique 2 IDEs en mémoire, aucune écriture BDD |
| `cabinetPushSync()` / `cabinetPullSync()` | Sync sélective par consentement explicite |
| `cabinetCotation(basePayload, actes)` | Cotation multi-IDE → `/webhook/cabinet-calcul` |
| `cabinetTournee(patients)` | Tournée cabinet → `/webhook/cabinet-tournee` |

---

## Module ai-tournee.js v6.0 — Fonctions

### Moteur de tournée

| Fonction | Description |
|---|---|
| `optimizeTour(patients, start, startTime, mode)` | TSP hybride : géo + médical + trafic + lookahead |
| `twoOpt(route)` | Optimisation 2-opt locale |
| `startLiveOptimization()` / `stopLiveOptimization()` | Boucle live toutes les 5 min |

### Scoring et heuristiques

| Fonction | Description |
|---|---|
| `medicalWeight(p)` | Score médical (urgence, dépendance, contrainte horaire) |
| `dynamicScore(...)` | Score composite dynamique |
| `trafficFactor(departureMin, date)` | Coefficient trafic CEREMA |
| `scoreTourneeRentabilite(route)` | Score rentabilité €/km |
| `_estimateFatigueFactor(nbStops, km, minutes)` | Facteur fatigue IDE (×1.0 → ×1.4) |

### Cabinet multi-IDE

| Fonction | Description |
|---|---|
| `cabinetGeoCluster(patients, k)` | K-means géographique pour k IDEs |
| `cabinetPlanDay(patients, members)` | Plan journée multi-IDE |
| `cabinetOptimizeRevenue(assignments, members)` | 30 itérations de swap patients |
| `smartCluster(patients, k)` | Clustering hybride géo + score € (20 itérations) |
| `planWithRevenueTarget(...)` | Planning piloté par objectif CA |
| `predictDelayLive(...)` | Prédit retards live → LOW/MEDIUM/HIGH |

---

## Module map.js v2.0 — Fonctions

| Fonction | Description |
|---|---|
| `renderPatientsOnMap(patients)` | Marqueurs patients Leaflet |
| `computeHeatmap(cotations)` | Agrège par grille ~110m → `revenue_per_hour` |
| `renderHeatmap(grid, metric)` | Calque Leaflet.heat (bleu→orange→rouge→violet) |
| `toggleHeatmap()` | Bascule on/off — charge cache ou API |

---

## Module dashboard.js v2.0 — Fonctions

| Fonction | Description |
|---|---|
| `loadDash()` | Charge les cotations + rend le dashboard |
| `renderDashboard(arr)` | KPIs, graphique 30j, top actes, prévision, anomalies, IA |
| `detectAnomalies(rows, daily)` | Détection statistique (σ) des anomalies |
| `forecastRevenue(daily)` | Prévision fin de mois par tendance linéaire |
| `loadDashCabinet()` | KPIs cabinet + revenus par IDE |
| `runCabinetSimulator()` | Simulateur revenus cabinet |
| `runCabinetCATarget()` | Objectif CA mensuel avec suggestions + barre progression |

---

## Module patients.js v2.0 — Fonctions

| Fonction | Description |
|---|---|
| `initPatientsDB()` | Initialise IndexedDB `ami_patients_db_<userId>` |
| `savePatient()` | Crée/met à jour fiche (géocodage auto) |
| `loadPatients()` | Liste avec recherche |
| `openPatientDetail(id)` | Vue détail avec onglets : Infos · Cotations · Ordonnances · Notes · Constantes · Semainier |
| `getAllPatients()` | Retourne tous les patients déchiffrés — accessible par les modules cliniques v2 |
| `getPatientById(id)` | Retourne un patient déchiffré par son ID |
| `patientAddConstante(patientId, mesure)` | Ajoute une mesure dans `p.constantes[]` → IDB |
| `patientAddPilulier(patientId, pilulier)` | Ajoute/met à jour un pilulier dans `p.piluliers[]` |
| `_enc(obj)` / `_dec(str)` | Chiffrement/déchiffrement AES (clé userId) |

---

## Modules cliniques v1.0

### constantes.js

| Métrique | Seuils normaux | Unité |
|---|---|---|
| TA Systolique | 90–140 | mmHg |
| TA Diastolique | 60–90 | mmHg |
| Glycémie | 0,7–1,8 | g/L |
| SpO2 | 94–100 | % |
| Température | 36–37,5 | °C |
| Fréquence cardiaque | 50–100 | bpm |
| Douleur EVA | — / max 3 | /10 |
| Poids | variable | kg |

### bsi.js — Niveaux BSI (NGAP 2026)

| Score total | Niveau | Code NGAP | ≈ Tarif |
|---|---|---|---|
| 0–4 pts | BSI 1 | BSI1 | 9,77 € |
| 5–8 pts | BSI 2 | BSI2 | 16,07 € |
| ≥9 pts | BSI 3 | BSI3 | 22,37 € |

### alertes-medicaments.js — 14 règles ANSM 2026

AVK+AINS · Insuline+Sulfamide · Metformine+Iode · Lithium+AINS · IEC+AINS · Digoxine+Amiodarone · HBPM+AINS · IPP+Clopidogrel · Potassium+IEC · Tramadol+IRS · Opioïde+Benzodiazépine · Méthotrexate+AINS · Ciclosporine+AINS · Alpha-bloquant+IPDE5

### audit-cpam.js — 8 règles CPAM

| ID | Gravité |
|---|---|
| `bsi_sans_renouvellement` | CRITIQUE |
| `ifd_systematique` | ÉLEVÉ |
| `ami4_sans_justification` | CRITIQUE |
| `taux_majoration_nuit` | ÉLEVÉ |
| `double_cotation_meme_jour` | MOYEN |
| `perfusion_sans_prescription` | ÉLEVÉ |
| `km_excessifs` | MOYEN |
| `actes_complexes_repetitifs` | MOYEN |

---

## Smart Engine v7.1 — Pipeline de décision

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

Fix v7.1 : isHallucination() ne déclenche plus sur "unknown" légitime
  (geo_zone:"unknown", distance_km_source:"NON_DISPONIBLE", etc.)
```

---

## Logique cotation — doctrine upsert stricte

> Règle fondamentale : **jamais de doublon dans l'Historique des soins**.
> Un soin donné pour un patient donné à une date donnée = **une seule cotation**.

### Arbre de décision

```
Patient existe dans le carnet ?
├── OUI → Upsert (mise à jour de la cotation existante)
│         Jamais de push(), jamais de doublon
│         Résolution index :
│           1. cotationIdx (si fourni explicitement)
│           2. invoice_number retourné par l'API
│           3. invoice_number original du _editRef (cas correction post-tournée/planning)
│           4. date YYYY-MM-DD (fallback robuste : couvre ISO complet vs date courte)
│         Si aucun index trouvé ET mode édition (_editRef) → ne rien faire
│
└── NON → Créer la fiche patient + la cotation (une seule fois)
          Uniquement si ce n'est PAS une correction (_editRef absent)
```

### Matrice de comportement `cotation()` — ⚡ Coter avec l'IA

| Patient | Mode édition (`_editRef`) | Index trouvé | Comportement |
|---|---|---|---|
| Existant | ✅ Oui | ✅ Oui | **Mise à jour** de la cotation existante |
| Existant | ❌ Non | — | **Ajout** de la cotation (1ère fois) |
| Existant | ✅ Oui | ❌ Non | **Rien** (évite doublon) |
| Absent | ❌ Non | — | **Crée fiche patient + cotation** |
| Absent | ✅ Oui | — | **Rien** (évite fiche fantôme) |

### Fix historique — comparaison de date (v8.1)

**Bug résolu :** `c.date` stocké en ISO complet `"2026-04-19T13:00:00.000Z"` vs `_dateCheck` au format `"2026-04-19"` → `===` toujours `false` → INSERT systématique au lieu de PATCH.

**Correction :** `.slice(0, 10)` des deux côtés dans `checkDoublon`, `auto-détection`, et `upsert IDB`.

### Fix complémentaire — tournée/planning (v8.1)

`_fromTournee` seul ne suffit **pas** comme signal de mise à jour : il est posé dès l'ouverture de la page, **avant** qu'une cotation existe. La doctrine est :
```javascript
if (_ref?.cotationIdx != null && _ref.cotationIdx >= 0) → bypass modale doublon
if (_ref?.invoice_number)                              → bypass modale doublon
// _fromTournee SEUL → toujours vérifier IDB d'abord
```

---

## Tarifs NGAP 2026

| Code | Libellé | Tarif | Règle |
|---|---|---|---|
| AMI1–AMI6 | Actes infirmiers de soins | 3,15 € × coeff | Principal ×1 · secondaire ×0,5 |
| AIS1, AIS3 | Aide infirmier soins | 2,65 € / 7,95 € | Principal ×1 · secondaire ×0,5 |
| BSA | Dépendance légère | 13,00 € | Forfait fixe |
| BSB | Dépendance modérée | 18,20 € | Forfait fixe |
| BSC | Dépendance lourde | 28,70 € | Forfait fixe |
| BSI1 | Bilan soins infirmiers niv.1 | ≈ 9,77 € | 3,1c — dépendance partielle |
| BSI2 | Bilan soins infirmiers niv.2 | ≈ 16,07 € | 5,1c — dépendance importante |
| BSI3 | Bilan soins infirmiers niv.3 | ≈ 22,37 € | 7,1c — grande dépendance |
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

// Règles spéciales :
// - Routes cabinet : admins autorisés sur toutes les routes
// - Mode démo solo : cabinet synthétique en mémoire, aucune écriture BDD
// - Modules cliniques v2 : accessibles admin ET infirmière (données IDB isolées)
// - RL Logger désactivé pour les admins
// - Les admins sont INVISIBLES dans le panneau d'administration
```

---

## Stockage local — isolation multi-utilisateurs

| Données | Base | Isolation | Chiffrement |
|---|---|---|---|
| Patients (+ constantes[], piluliers[]) | IndexedDB `ami_patients_db_<userId>` | Par userId | AES-256 (clé userId) |
| Signatures | IndexedDB `ami_sig_db_<userId>` | Par userId | AES-256 |
| Transmissions v2 | IndexedDB `ami_transmissions` v2 | user_id + destinataire_id | Non (local) |
| Constantes patients | IndexedDB `ami_constantes` | user_id | Non (local) |
| Semainiers piluliers | IndexedDB `ami_piluliers` | user_id | Non (local) |
| Évaluations BSI | IndexedDB `ami_bsi` | user_id | Non (local) |
| Consentements | IndexedDB `ami_consentements` | user_id | Non (local) |
| Corrections GPS | IndexedDB `geocodeDB` | Partagé (non-sensible) | Non |
| Cotations | Supabase `planning_patients` | `infirmiere_id` | Chiffrement champ |
| Cache dashboard | localStorage `ami_dash_<userId>_*` | Par userId | Non |
| Planning | localStorage `ami_planning_<userId>` | Par userId | Non |
| Smart Engine cache | Worker memory Map (TTL 1h) | Anonymisé sha256 | sha256 |
| Cabinet sync prefs | localStorage `ami_cabinet_sync_<userId>` | Par userId | Non |

> **Règle fondamentale :** les données de santé sont stockées exclusivement sur le terminal de l'utilisateur et ne sont jamais transmises à nos serveurs.

---

## Checklist RGPD / HDS (audit-ready)

> Classification A–J inspirée de la méthodologie CNIL / référentiel HDS.
> Chaque point est mappé à une implémentation technique dans le codebase.

### 📜 A. Gouvernance
| Exigence | État | Implémentation |
|---|---|---|
| Registre des traitements | ✅ | `GUIDE_INFIRMIERES.md` + CGU footer `index.html` |
| Responsable de traitement défini | ✅ | Mentions légales CGU (Ai BonoVan — éditeur) |
| DPO (si >250 employés OU données sensibles massives) | ⚠️ | Non obligatoire à ce stade — à prévoir avant commercialisation B2B |
| CGU + politique RGPD | ✅ | `#cgv-footer` (8 articles + mentions légales) |

### 🔐 B. Sécurité technique
| Exigence | État | Implémentation |
|---|---|---|
| HTTPS partout | ✅ | GitHub Pages + Cloudflare Workers (TLS 1.3) |
| Chiffrement données (AES) | ✅ | `security.js` — AES-256-GCM (IV aléatoire par opération) |
| Mots de passe hashés | ✅ | `worker.js` — PBKDF2 100k itérations + sel unique |
| JWT sécurisé | ✅ | Token Bearer, jamais en cookie, TTL 24h |
| Firewall / clés API | ✅ | Cloudflare Workers `env.XAI_API_KEY` + `env.SUPABASE_SERVICE_KEY` (jamais exposés client) |

### 🏥 C. Données de santé (HDS)
| Exigence | État | Implémentation |
|---|---|---|
| Accès restreint par rôle | ✅ | RBAC `nurse`/`admin` dans `worker.js` (tableau `PERMISSIONS`) |
| Logs d'accès | ✅ | `audit_logs` (LOGIN, REGISTER, COTATION, FRAUDE, ADMIN actions) |
| Carnet patients 100% local | ✅ | IndexedDB `ami_patients_db_<userId>` chiffré, jamais transmis |
| Admins sans accès aux données patients | ✅ | Isolation `infirmiere_id=eq.${user.id}` + bannière admin sur chaque module |

### 👤 D. Accès utilisateur
| Exigence | État | Implémentation |
|---|---|---|
| Authentification forte | ✅ | Email + mot de passe + PIN local (SHA-256 + sel) |
| Gestion sessions | ✅ | Table `sessions` + `created_at` + TTL 24h |
| Déconnexion auto | ✅ | `security.js` — verrouillage PIN après 10 min d'inactivité |
| Comptes bloqués | ✅ | `is_blocked` → sessions révoquées |

### 📡 E. Données
| Exigence | État | Implémentation |
|---|---|---|
| Minimisation | ✅ | Patients NIR jamais stocké ; signature en hash opaque uniquement |
| Anonymisation partielle | ✅ | Cache Smart Engine : clé sha256(texte+heure+km+date) → pas de PII |
| Séparation logique | ✅ | IndexedDB isolé par userId ; Supabase filtré `infirmiere_id` |

### 💾 F. Stockage
| Exigence | État | Implémentation |
|---|---|---|
| Données chiffrées | ✅ | AES-256-GCM côté client ; chiffrement champ côté Supabase |
| Backups réguliers | ✅ | Supabase daily auto-backup (infra hébergeur) |
| Purge automatique | ✅ | `cleanOldLogs()` — logs > 90 jours purgés |

### 📤 G. Droits utilisateurs
| Exigence | État | Implémentation |
|---|---|---|
| Export données | ✅ | Cotations CSV (`tresorerie.js`) · Patients JSON RGPD (`security.js` → `exportRGPD()`) |
| Suppression compte | ✅ | `/webhook/delete-account` — purge complète serveur |
| Droit à l'oubli patients | ✅ | `deletePatient()` IDB + suppression cotations associées |
| Modification | ✅ | `savePatient()` + `profil-save` worker |

### 📜 H. Consentement
| Exigence | État | Implémentation |
|---|---|---|
| CGU + politique RGPD | ✅ | `#cgv-footer` dépliable dans l'app après login |
| Consentement explicite | ✅ | Modale consentement au premier démarrage (localStorage `ami_consent_v1`) |
| Traçabilité | ✅ | `audit_logs.event=CONSENT` avec timestamp |

### 🔍 I. Audit & logs
| Exigence | État | Implémentation |
|---|---|---|
| Logs accès | ✅ | `audit_logs` (LOGIN, REGISTER) |
| Logs actions | ✅ | `audit_logs` (COTATION, PROFIL_UPDATE, ADMIN_*) |
| Logs système | ✅ | `system_logs` (N8N_FAILURE, IA_FALLBACK, FRAUD_ALERT, INTERNAL_ERROR, RL_DECISION) |
| Logs sans PII | ✅ | Filtrage côté worker (`writeAuditLog` / `writeSystemLog`) |

### 🔁 J. Incident
| Exigence | État | Implémentation |
|---|---|---|
| Plan de réponse | ✅ | Monitoring temps réel (vue admin Santé du système) |
| Notification CNIL < 72h | ✅ | Contact admin intégré (`contact.js`) + logs horodatés exploitable |
| Surveillance | ✅ | `/webhook/admin-logs` + `/webhook/admin-engine-stats` temps réel |

### Ce que les admins ne peuvent PAS voir

- Données patients (nom, prénom, NIR, DDN, N° sécu) des infirmières
- Détail des factures et prescripteurs des patients
- Logs de cotation individuels contenant des PII
- Autres comptes administrateurs dans le panneau d'administration
- Signatures et photos de preuve soin (hash uniquement)

---

## Architecture des fichiers

| Fichier | Rôle | Version |
|---|---|---|
| `worker.js` | Cloudflare Worker — Smart Engine, RL, State, Heatmap, toutes les routes | **v7.1** |
| `utils.js` | Store APP, helpers, apiCall, `_PATHO_MAP` v2.0 | **v5.1** |
| `tournee.js` | Tournée + planning + cabinet + enrichissement pathologies | **v6.1** |
| `sw.js` | Service Worker PWA | v3.6 |
| `auth.js` | Login/logout/session/navigation | v4.1 |
| `security.js` | AES-256-GCM, PIN, RGPD, export, audit | v2.0 |
| `cabinet.js` | Cabinet multi-IDE + mode démo solo admin | v2.1 |
| `cotation.js` | Cotation NGAP + mode cabinet + doctrine upsert stricte | **v8.1** |
| `ai-tournee.js` | TSP, clustering, fatigue, surge, prédiction retard | v6.0 |
| `map.js` | Leaflet + heatmap zones rentables | v2.0 |
| `dashboard.js` | KPIs + stats cabinet + simulateur | v2.0 |
| `patients.js` | Carnet patients IDB chiffré + onglets Constantes/Semainier | v2.0 |
| `transmissions.js` | Transmissions SOAP/DAR + cabinet multi-IDE | v2.0 |
| `constantes.js` | Suivi constantes patients + graphiques canvas | v1.0 |
| `pilulier.js` | Semainier / pilulier hebdomadaire + impression | v1.0 |
| `bsi.js` | Bilan de Soins Infirmiers — grille dépendance + BSI 1/2/3 | v1.0 |
| `consentements.js` | Consentements éclairés + signature canvas | v1.0 |
| `alertes-medicaments.js` | Détection interactions ANSM 14 règles | v1.0 |
| `audit-cpam.js` | Compte-rendu de passage + simulateur audit CPAM 8 règles | v1.0 |
| `signature.js` | Signatures canvas + sync | v1.0 |
| `rapport.js` | Rapport PDF + référentiel NGAP | v1.0 |
| `admin.js` | Panneau admin + Smart Engine stats | v4.1 |
| `infirmiere-tools.js` | Charges, km, modèles, majorations | v1.0 |
| `copilote.js` | Chat Copilote NGAP | v1.0 |
| `ui.js` | Navigation + handlers + parser FAQ Markdown (fix v5.2) | **v5.2** |
| `ai-assistant.js` | Assistant vocal NLP + TTS | v1.1 |
| `voice.js` | Dictée médicale | v1.0 |
| `onboarding.js` | Introductions guidées (4 modules) | v1.0 |
| `geocode.js` | Photon → Nominatim → cache IDB | v1.0 |
| `extras.js` | OSRM, scoring fraude front | v1.0 |
| `uber.js` | Mode Uber Médical | v1.0 |
| `contact.js` | Messagerie infirmière → admin | v1.0 |
| `AI_Agent_AMI_v10.json` | Workflow N8N principal — 51 nœuds | v10 |
| `AMI_Cotation_Preuve_Update_v1.json` | Workflow N8N — UPDATE preuve_soin post-signature (8 nœuds) | **v1** |
| `AMI_ML_Nightly_v1.json` | Workflow N8N — Cron 2h : retrain SGD + rapport staffing (9 nœuds) | **v1** |
| `README.md` | Documentation technique (ce fichier) | **v10.1** |
| `GUIDE_INFIRMIERES.md` | Guide pratique & FAQ (chargé dynamiquement) | **v2.1** |
