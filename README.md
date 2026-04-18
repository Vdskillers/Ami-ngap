# AMI NGAP — Documentation Architecture

> Application web progressive (PWA) pour infirmières libérales.  
> Gestion de tournée, cotation NGAP, carnet patients chiffré, signatures électroniques, copilote IA, **mode cabinet multi-IDE**.

---

## Versions

| Composant | Version | Notes |
|---|---|---|
| Worker backend | **v6.5** | Routes cabinet multi-IDE + sync sélective, guards admin |
| Agent IA N8N | **v9** | Router Cabinet + Split by IDE + Merge Cabinet — pipeline solo inchangé |
| Module cabinet | **v1.0** | Nouveau — `cabinet.js` — gestion membres, sync sélective, cotation multi-IDE |
| Moteur tournée IA | **v6.0** | Cabinet multi-IDE, clustering intelligent €, prédiction retard live, surge scoring |
| Cotation | **v8** | Mode cabinet multi-IDE intégré, sélecteur "Qui fait quoi ?" par acte |
| Dashboard | **v2.0** | Section cabinet : KPIs multi-IDE, simulateur revenus, objectif CA |
| Heatmap zones | **v1.0** | Nouveau — Leaflet.heat, zones rentables €/h |
| Assistant vocal IA | v1.1 | NLP embarqué (WebLLM retiré) |
| PWA / Service Worker | v3.6 | Cache offline, tiles carte |
| Sécurité RGPD | v2.0 | Isolation multi-users IndexedDB par userId |
| Admin panel | v4.0 | Admins invisibles entre eux dans le panneau |

---

## Modèle de sécurité & isolation des données

### Rôles utilisateurs

| Rôle | Accès données patients | Accès fonctionnalités | Cabinet |
|---|---|---|---|
| **Infirmière** | Ses propres patients uniquement (isolés par `infirmiere_id`) | Toutes les vues métier | Peut créer / rejoindre un cabinet |
| **Admin** | Ses propres patients de test uniquement — jamais ceux des infirmières | Toutes les vues en mode démo, panneau admin | Peut créer un cabinet de test (isolation par `user.id`) |

### Règles d'isolation strictes

- Chaque infirmière ne voit **que ses propres données** — isolation par `infirmiere_id` côté backend (`worker.js`)
- Les admins peuvent tester toutes les fonctionnalités avec **leurs propres patients de test** sans voir les données des infirmières
- Les admins sont **invisibles entre eux** — le panneau admin n'affiche que les comptes infirmières
- Le panneau admin affiche les statistiques globales, noms et prénoms des **infirmières uniquement**
- **Mode cabinet** : les admins peuvent créer un cabinet de test — isolation garantie par `user.id` comme pour le reste

### Architecture Privacy by Design

```
Données de santé → chiffrées AES-256 → stockage local (IndexedDB)
                                        jamais transmises aux serveurs

Serveur (Cloudflare Worker) → métadonnées & cotations uniquement
Supabase → données non-sensibles + cotations chiffrées côté champ
N8N (Render) → traitement IA stateless — ne stocke aucune donnée de santé brute

Mode cabinet sync → données partagées anonymisées uniquement
                    consentement explicite requis
                    aucun partage automatique
```

---

## Architecture N8N v9 — Agent IA AMI (Cabinet-Ready)

> Workflow : `AI Agent AMI v9 (Cabinet)` · versionId `c52ef1b7-9a4d-4f1e-b7c3-749ac6639e88`
> Instance : `https://n8n-6fyl.onrender.com` · Statut : **active** · **35 nœuds**
> 3 nouveaux nœuds cabinet ajoutés — pipeline solo **100% inchangé**

### Pipeline principal — flux `/ami-calcul`

```
[POST /ami-calcul]  ← Webhook
        │
        ▼
[0] Router Cabinet  ← NOUVEAU v9
    Détecte _cabinet_mode=true (injecté par le worker après split)
    Output 0 → pipeline solo (comportement existant, inchangé)
    Output 1 → Split by IDE (mode cabinet)
        │
    ┌───┴─────────────────────────────────┐
    │ MODE SOLO (output 0)                │ MODE CABINET (output 1)
    │                                     ▼
    │                             [0b] Split by IDE  ← NOUVEAU v9
    │                                 Prépare payload mono-IDE
    │                                 Passe au pipeline existant
    │                                     │
    ▼                                     ▼
[1] NLP Médical v6+v7
    Extraction actes (regex médicale), contexte, distance km
    + preuve_soin : type / timestamp / hash / geo_zone / force_probante
        │
        ▼
[2] RAG NGAP Retriever v7
    Base documentaire NGAP 2026 — retrieval BM25
    rulesetHash + rulesetVersion dans le contexte IA
        │
        ▼
[3] AI Agent — xAI Grok-3
    Raisonnement NGAP avec historique patient
    Renvoie : actes[] avec code "AMI"+coeff, total, dre_requise, horaire_type
        │
        ▼
[4] Parser résultat IA v5.5
    Parse JSON Grok, détection hallucinations, normalisation
        │
        ▼
[5] Validateur NGAP V1
    AIS+BSI exclusion, IFD unique, NUIT+DIM interdit, IK sans distance
        │
        ▼
[6] Optimisateur € v3
    Ajout automatique MCI / IFD / IK / MIE si critères présents
        │
        ▼
[7] Validateur NGAP V2
    Second passage post-optimisation
        │
        ▼
[8] Recalcul NGAP Officiel v5  ← SOURCE DE VÉRITÉ
    Tarifs 2026 officiels, tri acte principal, coefficients
    IK = km × 2 × 0,35 €, audit trail complet
        │
        ▼
[9] Analyse Pattern Patient v2
    Répétition ≥ 7j, évolution dépendance, cohérence pathologie
        │
        ▼
[10] Suggestions alternatives v4
     Gains € non réalisés, conseils preuve soin
        │
        ▼
[11] Fraude Detector v7
     Score multicritères — preuve absente +3 pts, preuve forte −3 pts
        │
        ▼
[12] CPAM Simulator v5
     Simulation contrôle CPAM — preuve forte supprime 1 anomalie
        │
        ▼
[13] Scoring Infirmière v4
     Score global IDE — preuve impacte niveau SAFE/SURVEILLANCE/DANGER
        │
        ▼
[14] Blocage FSE si HIGH
     Bloque si fraud=HIGH ou (MEDIUM + CPAM=CRITIQUE)
        │
        ▼
[15] FSE Generator v6+v7
     FSE-1.40, justification médicale horodatée
     preuve_soin intégrée (type, hash, force_probante)
        │
        ▼
[Mode spécial ?] — bypass DB si _mode≠ngap OR _skip_db=true OR blocked=true
     │                    │
     │ NON                │ OUI
     ▼                    │
[16] Sauvegarder en BDD v8  ←──────────────────────┘
     INSERT cotations avec invoice_number
     RETURNING id, invoice_number, created_at
        │
        ▼
[17] Fusionner réponse v11
     Assemble réponse finale, expose db_invoice_number
        │
        ▼
[18] Merge Cabinet  ← NOUVEAU v9
     Mode cabinet : enrichit la réponse avec ide_id + cabinet_mode:true
     Mode solo : laisse passer sans modification
        │
        ▼
[19] Respond to Webhook → réponse JSON au worker
```

### Logique cabinet dans le worker (avant N8N)

En mode cabinet (`cabinet_mode=true` + plusieurs `performed_by` distincts), le **worker** effectue le split AVANT d'appeler N8N :

```javascript
// worker.js — pipeline cabinet inline
groupByIDE(actes)                    // split par performed_by
→ appels N8N parallèles (Promise.all) // un appel par IDE
→ merge résultats                    // total_global + cotations[]
→ sauvegarde Supabase par IDE        // 1 ligne planning_patients par IDE
```

Chaque IDE passe dans le **pipeline solo existant** (nœuds 1–19) — rien n'est modifié dans le pipeline NGAP.

### Flux secondaires

| Webhook | Méthode | Chemin | Description |
|---|---|---|---|
| Webhook Historique | GET | `/ami-historique` | Cotations par `user_id` + `limit`, order DESC |
| Webhook Supprimer | POST | `/ami-supprimer` | Suppression par `id` (delete_one) ou `patient_id` |
| Créer table si absente | — | Manuel | DDL idempotent + ALTER TABLE colonnes additionnelles |

---

### Nœuds N8N v9 — détail complet (35 nœuds)

| # | Nœud | Version | Rôle |
|---|---|---|---|
| 0 | **Router Cabinet** | **v1 — NOUVEAU** | Détecte `_cabinet_mode` → route vers pipeline solo ou Split by IDE |
| 0b | **Split by IDE** | **v1 — NOUVEAU** | Prépare payload mono-IDE pour le pipeline NGAP existant |
| 1 | **NLP Médical** | v6+v7 | Regex médicale, hash djb2, extraction `preuve_soin` |
| 2 | **RAG NGAP Retriever** | v7 | BM25 sur référentiel NGAP 2026 |
| 3 | **AI Agent** | — | xAI Grok-3, raisonnement NGAP avec historique |
| 4 | **xAI Grok Chat Model** | — | Modèle LLM sous-jacent |
| 5 | **Parser résultat IA** | v5.5 | Parse JSON, hallucinations, `normalizeAI()` |
| 6 | **Validateur NGAP V1** | — | AIS+BSI, IFD unique, NUIT+DIM, IK sans distance |
| 7 | **Optimisateur €** | v3 | Ajout auto MCI/IFD/IK/MIE |
| 8 | **Validateur NGAP V2** | — | Second passage post-optimisation |
| 9 | **Recalcul NGAP Officiel** | v5 | Tarifs officiels 2026, coefficients, IK aller-retour |
| 10 | **Analyse Pattern Patient** | v2 | Répétition ≥ 7j, dépendance statique |
| 11 | **Suggestions alternatives** | v4 | Gains € manquants, conseils preuve |
| 12 | **Fraude Detector** | v7 | Score multicritères + preuve_soin |
| 13 | **CPAM Simulator** | v5 | Simulation contrôle + preuve forte |
| 14 | **Scoring Infirmière** | v4 | Score global IDE |
| 15 | **Blocage FSE si HIGH** | — | Blocage si fraud HIGH ou MEDIUM+CRITIQUE |
| 16 | **FSE Generator** | v6+v7 | FSE-1.40, justification horodatée, preuve_soin |
| 17 | **Mode spécial ?** | — | Bypass DB si `_mode≠ngap` / `_skip_db` / `blocked` |
| 18 | **Sauvegarder en BDD** | v8 | INSERT + `invoice_number`, RETURNING |
| 19 | **Fusionner réponse** | v11 | Réponse finale + `db_invoice_number` |
| 20 | **Merge Cabinet** | **v1 — NOUVEAU** | Enrichit réponse cabinet ou laisse passer en solo |
| 21 | **Respond to Webhook** | — | JSON → worker |
| 22 | **Webhook Historique** | — | GET `/ami-historique` |
| 23 | **Requête historique** | — | SELECT cotations par `user_id` LIMIT 50 |
| 24 | **Préparer historique** | — | Filtre rows valides → `{ok, data[], count}` |
| 25 | **Retourner historique** | — | JSON historique |
| 26 | **Webhook Supprimer** | — | POST `/ami-supprimer` |
| 27 | **Supprimer** | — | Détermine `_delete_one` |
| 28 | **IF delete_one?** | — | Branche DELETE by ID / by Patient |
| 29 | **Delete by ID** | — | `DELETE WHERE id=X AND user_id=Y` |
| 30 | **Delete by Patient** | — | `DELETE WHERE texte_soin ILIKE patient_id` |
| 31 | **Répondre suppression** | — | `{ok: true, deleted: true, id}` |
| 32 | **Créer table si absente** | — | DDL idempotent `cotations` + ALTER TABLE |

---

## Schema base de données Supabase — tables complètes

### Tables existantes (inchangées)

```sql
-- Cotations N8N (table legacy)
CREATE TABLE IF NOT EXISTS cotations (
  id SERIAL PRIMARY KEY, user_id TEXT, infirmiere TEXT, texte_soin TEXT,
  actes TEXT, total NUMERIC(10,2), amo NUMERIC(10,2), amc NUMERIC(10,2),
  amo_amount NUMERIC(10,2), amc_amount NUMERIC(10,2), part_patient NUMERIC(10,2),
  dre_requise BOOLEAN DEFAULT false, date_soin DATE, heure_soin TEXT,
  prescripteur_nom TEXT, prescripteur_rpps TEXT, date_prescription DATE,
  prescripteur_id TEXT, exo TEXT, regl TEXT, adeli TEXT, rpps_infirmiere TEXT,
  structure TEXT, ddn TEXT, amo_num TEXT, amc_num TEXT,
  alerts TEXT, optimisations TEXT, ngap_version TEXT DEFAULT '2026.1',
  invoice_number TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cotations worker (table principale)
CREATE TABLE IF NOT EXISTS planning_patients (
  id BIGSERIAL PRIMARY KEY, infirmiere_id UUID NOT NULL,
  date_soin DATE, heure_soin TEXT, notes TEXT, actes TEXT,
  total NUMERIC(10,2), part_amo NUMERIC(10,2), part_amc NUMERIC(10,2),
  part_patient NUMERIC(10,2), dre_requise BOOLEAN DEFAULT false,
  source TEXT, ngap_version TEXT, fraud_score NUMERIC, ai_score NUMERIC,
  alerts TEXT, invoice_number TEXT, locked BOOLEAN DEFAULT false,
  patient_id TEXT, lat NUMERIC, lng NUMERIC, adresse TEXT, done BOOLEAN,
  absent BOOLEAN, cabinet_id UUID DEFAULT NULL,  -- ← NOUVEAU v6.5
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(infirmiere_id, invoice_number)
);
```

### Nouvelles tables cabinet (v6.5)

```sql
-- Cabinets (groupes d'infirmières)
CREATE TABLE IF NOT EXISTS cabinets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nom TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE cabinets DISABLE ROW LEVEL SECURITY;

-- Membres d'un cabinet
CREATE TABLE IF NOT EXISTS cabinet_members (
  id BIGSERIAL PRIMARY KEY,
  cabinet_id UUID NOT NULL,
  infirmiere_id UUID NOT NULL,
  role TEXT DEFAULT 'membre',        -- 'titulaire' | 'membre'
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cabinet_id, infirmiere_id)
);
ALTER TABLE cabinet_members DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cabinet_members_ide ON cabinet_members(infirmiere_id);
CREATE INDEX IF NOT EXISTS idx_cabinet_members_cab ON cabinet_members(cabinet_id);

-- Synchronisation sélective inter-IDEs
-- Expiration automatique 7 jours — données anonymisées uniquement
CREATE TABLE IF NOT EXISTS cabinet_sync (
  id BIGSERIAL PRIMARY KEY,
  cabinet_id UUID NOT NULL,
  sender_id UUID NOT NULL,
  sender_nom TEXT DEFAULT '',
  sender_prenom TEXT DEFAULT '',
  target_ids TEXT NOT NULL,          -- JSON array des UUIDs destinataires
  what TEXT NOT NULL,                -- JSON array : ['planning','km','ordonnances',...]
  data TEXT NOT NULL,                -- JSON — anonymisé côté client avant envoi
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days'
);
ALTER TABLE cabinet_sync DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cabinet_sync_cab ON cabinet_sync(cabinet_id);
CREATE INDEX IF NOT EXISTS idx_cabinet_sync_exp ON cabinet_sync(expires_at);
```

---

## Module Cabinet — architecture complète (v1.0)

### Vue d'ensemble

```
Infirmière A (titulaire)          Infirmière B (membre)
        │                                  │
        └──────────── Cabinet ─────────────┘
                          │
              ┌───────────┴────────────┐
              │                        │
     Cotation multi-IDE         Sync sélective
     (actes répartis            (planning, km,
      par performed_by)          ordonnances...)
              │                        │
      N8N par IDE             cabinet_sync Supabase
      (pipeline solo           (anonymisé, consent
       inchangé × N)            explicite, 7j TTL)
```

### Fonctionnalités

| Feature | Description |
|---|---|
| Créer un cabinet | Titulaire crée, reçoit un ID à partager |
| Rejoindre | Saisir l'ID du cabinet pour rejoindre |
| Cotation multi-IDE | Sélecteur "Qui réalise cet acte ?" par acte détecté — NGAP par IDE |
| Optimiser la répartition | IA répartit les actes par valeur décroissante pour éviter les décotes |
| Tournée cabinet | Clustering géographique + score € pour distribuer les patients entre IDEs |
| Optimiser revenus tournée | `cabinetOptimizeRevenue()` — 30 itérations de swap patients |
| Dashboard cabinet | KPIs multi-IDE, revenus par infirmière, simulateur mensuel, objectif CA |
| Sync planning | Partage du planning du jour (à la demande, consentement explicite) |
| Sync km | Partage du journal kilométrique |
| Sync ordonnances | Partage liste ordonnances (noms patients anonymisés) |
| Heatmap zones rentables | `toggleHeatmap()` sur la carte — Leaflet.heat, zones €/h |

### Règles RGPD synchronisation

- **Aucun partage automatique** — uniquement à l'initiative de l'infirmière
- **Consentement granulaire** : choisir quoi partager ET avec qui
- **Noms patients jamais transmis** — uniquement métadonnées anonymisées
- **TTL 7 jours** — auto-expiration des données partagées
- **Révocable** : quitter le cabinet supprime les accès

### Calcul NGAP multi-IDE

```
1 passage = N IDEs → N cotations indépendantes

IDE A : actes [AMI4]       → tarif plein  : 12,60 €  (acte principal)
IDE B : actes [AMI1, IFD]  → tarif plein  :  3,15 € + 2,75 €

TOTAL CABINET              → 18,50 €
SANS cabinet (1 seul IDE)  → AMI4 + AMI1×0,5 + IFD = 17,93 € (décote AMI1)
GAIN optimisation          → +0,57 € (× volume × fréquence = gain mensuel significatif)
```

---

## Moteur IA avancé — ai-tournee.js v6.0

### Nouvelles fonctions

| Fonction | Description |
|---|---|
| `predictDelayLive({ ide, route })` | Prédit les retards live (heuristique trafic + fatigue) |
| `autoReassignIfRisk({ planning, infirmieres })` | Réassigne les patients si risque HIGH |
| `_estimateFatigueFactor(nbStops, km, minutes)` | Facteur fatigue IDE (×1.0 → ×1.4) |
| `smartCluster(patients, k)` | Clustering hybride géo + score € (20 itérations) |
| `planWithRevenueTarget({ patients, members, target })` | Planning piloté par objectif CA |
| `_surgeScore({ demand, supply, delayRisk, fatigueAvg })` | Score tension zone |
| `planWithTargetAndSurge({ patients, members, target, zones })` | Planning objectif + surge |
| `startCabinetLiveOptimization(getPlanning, getIDEs, onChanges)` | Boucle live 15s |
| `cabinetGeoCluster(patients, k)` | K-means géographique côté client |
| `cabinetPlanDay(patients, members)` | Planning multi-IDE avec optimizeTour() par IDE |
| `cabinetScoreDistribution(assignments)` | Score €/km d'un planning cabinet |
| `cabinetOptimizeRevenue(assignments, members)` | Amélioration itérative (swap patients) |
| `cabinetBuildUI(assignments, scoreData)` | HTML résumé planning multi-IDE |

### Modèle fatigue IDE

```
factor = 1.0
+ 0.10 si nbStops ≥ 10
+ 0.10 si nbStops ≥ 15
+ 0.10 si nbStops ≥ 20
+ 0.05 si heure ∈ [11h, 14h]   (creux déjeuner)
+ 0.08 si heure ≥ 17h           (fin journée)
+ 0.05 si km > 50
+ 0.05 si km > 80
max(factor, 1.4)
```

### Clustering intelligent (smartCluster)

```
clusterScore(cluster) =
  revenue                    (€ estimés pour le cluster)
  - km × 0.5                 (pénalité déplacement)
  - time × 0.1               (pénalité temps)
  + density × 1.5            (bonus densité)

20 itérations de swap patient entre clusters
→ optimisation convexe locale
```

---

## Heatmap zones rentables

```javascript
// map.js — pipeline complet
cotations (planning_patients avec lat/lng)
  → computeHeatmap(cotations)       // agrégation par grille ~110m
  → grid[key].revenue_per_hour      // KPI principal
  → renderHeatmap(grid)             // Leaflet.heat avec gradient
  → _showHeatmapPanel(grid)         // top 5 zones, panneau flottant

// Chargement données :
// 1. Cache dashboard localStorage (si disponible)
// 2. Fallback API /webhook/ami-historique?period=3month
// Prérequis : patients géocodés (lat/lng dans planning_patients)
```

**Gradient heatmap :** bleu (faible) → orange (moyen) → rouge (fort) → violet (très fort)

---

## Routes API — Cloudflare Worker v6.5

### Authentification & Profil

| Route | Méthode | Permissions |
|---|---|---|
| `/webhook/auth-login` | POST | Public |
| `/webhook/infirmiere-register` | POST | Public |
| `/webhook/change-password` | POST | Auth |
| `/webhook/delete-account` | POST | Auth |
| `/webhook/profil-get` | POST | Auth |
| `/webhook/profil-save` | POST | Auth |

### Cotation NGAP

| Route | Méthode | Permissions | Rôle |
|---|---|---|---|
| `/webhook/ami-calcul` | POST | Auth | Pipeline N8N v9 — solo ou cabinet (auto-détecté) |
| `/webhook/ami-calcul` + `cabinet_mode:true` | POST | Nurse+Admin | Split par IDE → N8N parallèle → merge |
| `/webhook/ami-historique` | GET | Auth | Historique cotations — Supabase direct |
| `/webhook/ami-supprimer` | POST | Auth | Suppression par ID ou patient_id |
| `/webhook/ami-supprimer-tout` | POST | Auth | Suppression groupée |
| `/webhook/ami-save-cotation` | POST | Auth | Sauvegarde cotation tournée live |

### Cabinet multi-IDE (NOUVEAU v6.5)

| Route | Méthode | Permissions | Rôle |
|---|---|---|---|
| `/webhook/cabinet-register` | POST | Auth | Créer / rejoindre / quitter un cabinet |
| `/webhook/cabinet-get` | POST | Auth | Infos cabinet + liste membres |
| `/webhook/cabinet-calcul` | POST | Auth | Cotation multi-IDE — appels N8N parallèles par IDE |
| `/webhook/cabinet-tournee` | POST | Auth | Distribution patients entre IDEs (clustering géo) |
| `/webhook/cabinet-sync-push` | POST | Auth | Envoyer données aux collègues (anonymisées) |
| `/webhook/cabinet-sync-pull` | POST | Auth | Recevoir données des collègues |
| `/webhook/cabinet-sync-status` | POST | Auth | Dernière sync par membre |

### Tournée & IA

| Route | Méthode | Permissions | Rôle |
|---|---|---|---|
| `/webhook/ami-tournee-ia` | POST | Auth | Optimisation tournée |
| `/webhook/ami-live` | POST | Auth | Pilotage live |
| `/webhook/ami-copilot` | POST | Auth | Copilote NGAP (Grok-3-mini + fallback statique) |
| `/webhook/ami-week-analytics` | POST | Auth | Analyse hebdomadaire |

### Sync PC ↔ Mobile

| Route | Méthode | Rôle |
|---|---|---|
| `/webhook/planning-push` / `-pull` | POST | Planning hebdomadaire chiffré |
| `/webhook/km-push` / `-pull` | POST | Journal kilométrique chiffré |
| `/webhook/heure-push` / `-pull` | POST | Cache heures soins |
| `/webhook/signatures-push` / `-pull` / `-delete` | POST | Signatures PNG chiffrées AES |
| `/webhook/carnet-push` / `-pull` | POST | Carnet patients chiffré |

### Admin & Monitoring

| Route | Méthode | Permissions | Rôle |
|---|---|---|---|
| `/webhook/admin-stats` | GET | Admin | Stats globales infirmières |
| `/webhook/admin-users` | GET | Admin | Liste comptes infirmières (pas les admins) |
| `/webhook/admin-action` | POST | Admin | Bloquer / débloquer / supprimer |
| `/webhook/admin-messages` | POST | Admin | Messagerie admin |
| `/webhook/log` | POST | Public | Log frontend → `system_logs` |
| `/webhook/system-logs` | GET | Admin | Consultation logs + stats N8N |

---

## Matrice des permissions

```javascript
// worker.js — PERMISSIONS
nurse:  ['create_invoice', 'view_own_data', 'import_calendar',
         'manage_tournee', 'manage_prescripteurs',
         'change_password', 'delete_account']

admin:  ['view_users_list', 'view_stats', 'manage_tournee',
         'change_password', 'delete_account']

// Cabinet : !isAdmin && !hasPermission('create_invoice') → bloqué
// Les admins accèdent aux routes cabinet pour tester (isolation user.id garantie)
// Les admins NE voient PAS les données infirmières
// Les admins sont INVISIBLES dans le panneau d'administration
```

---

## Architecture des fichiers

### Backend & PWA

| Fichier | Rôle | Version |
|---|---|---|
| `worker.js` | Cloudflare Worker — routes API, auth, isolation, proxy N8N v9, routes cabinet | **v6.5** |
| `sw.js` | Service Worker PWA — cache statique, tiles, offline | v3.6 |

### Auth & Sécurité

| Fichier | Rôle | Notes |
|---|---|---|
| `auth.js` | Login / register / logout, session, navigation par rôle | Cabinet init au login, nurse-only fix |
| `security.js` | AES-256-GCM (Web Crypto), PIN local, RGPD, export/purge, audit logs | — |

### Cabinet (NOUVEAU)

| Fichier | Rôle |
|---|---|
| `cabinet.js` | Module cabinet complet — gestion membres, sync sélective, cotation multi-IDE, UX |

### UI & Navigation

| Fichier | Rôle |
|---|---|
| `ui.js` | `navTo()`, handler cabinet (`renderCabinetSection()`), `loadFaqGuide()` |
| `navigation.js` | GPS patients — coordonnées directes ou adresse texte |
| `utils.js` | Store `APP` (+ `APP.cabinet`), helpers, `apiFetch`, `apiCall` |

### Patients & Données de santé

| Fichier | Rôle |
|---|---|
| `patients.js` | IndexedDB `ami_patients_db_<userId>` — CRUD, cotations, ordonnances |
| `patient-form.js` | Formulaire patient — adresse structurée, géocodage |
| `notes.js` | Notes patient (Général / Accès / Médical / Urgent) |
| `signature.js` | Signatures canvas — `ami_sig_db_<userId>` |

### Cotation & Finances

| Fichier | Rôle | Version |
|---|---|---|
| `cotation.js` | Cotation NGAP + mode cabinet multi-IDE (toggle, sélecteur IDE par acte, résultat multi-IDE) | **v8** |
| `tresorerie.js` | Trésorerie — paiements, remboursements, export CSV | — |
| `offline-queue.js` | File attente hors-ligne — sync auto | — |

### Tournée & Cartographie

| Fichier | Rôle | Version |
|---|---|---|
| `tournee.js` | Tournée IA + import ICS/CSV — planning, pilotage live, tournée cabinet multi-IDE | **v5.1+** |
| `ai-tournee.js` | Moteur TSP, OSRM, trafic + cabinet : clustering, fatigue, surge, prédiction retard | **v6.0** |
| `map.js` | Leaflet — tap/drag, reverse geocoding, **heatmap zones rentables** | **v1.1** |
| `ai-layer.js` | Couche IA silencieuse — habitScore/geoScore | — |
| `uber.js` | Mode Uber Médical | — |
| `extras.js` | Carte départ, OSRM, scoring fraude front | — |
| `geocode.js` | Pipeline Photon → Nominatim → cache IndexedDB | — |

### IA & Copilote

| Fichier | Rôle |
|---|---|
| `copilote.js` | Chat Copilote NGAP |
| `ai-assistant.js` | Assistant vocal NLP, commandes, TTS |
| `voice.js` | Dictée médicale vocale |

### Rapports & Administration

| Fichier | Rôle | Version |
|---|---|---|
| `dashboard.js` | Dashboard, anomalies, prévisions + **section cabinet** (KPIs, simulateur, objectif CA) | **v2.0** |
| `rapport.js` | Rapport mensuel PDF, santé N8N/IA | — |
| `admin.js` | Panneau admin — infirmières uniquement, stats globales | v4.0 |
| `contact.js` | Messagerie infirmière → admin | — |

### Profil & PWA

| Fichier | Rôle |
|---|---|
| `profil.js` | Profil, mot de passe, suppression compte |
| `pwa.js` | Install, offline, sync, tiles |
| `onboarding.js` | Onboarding premier lancement |
| `infirmiere-tools.js` | Simulateur charges, journal km, modèles soins, majorations, ordonnances |

### N8N

| Fichier | Rôle |
|---|---|
| `AI_Agent_AMI_v9.json` | Workflow N8N v9 — 35 nœuds, 3 nouveaux nœuds cabinet |

---

## Stockage local — isolation multi-utilisateurs

| Données | Base | Isolation | Chiffrement |
|---|---|---|---|
| Patients | IndexedDB `ami_patients_db_<userId>` | Par userId | AES-256 (clé JWT) |
| Signatures | IndexedDB `ami_sig_db_<userId>` | Par userId | AES-256 |
| Corrections GPS | IndexedDB `geocodeDB` | Partagé (non-sensible) | Non |
| Cotations | Supabase `planning_patients` | `infirmiere_id` | Chiffrement champ |
| Cache dashboard | localStorage `ami_dash_<userId>_*` | Par userId | Non |
| Préférences sync cabinet | localStorage `ami_cabinet_sync_<userId>` | Par userId | Non (non-sensible) |
| Planning partagé reçu | localStorage `ami_cabinet_planning_<senderId>` | Par sender | Non |
| Km partagés reçus | localStorage `ami_cabinet_km_<senderId>` | Par sender | Non |
| État cabinet | `APP.state.cabinet` | Session mémoire | Non (non-sensible) |

> **Règle fondamentale :** la déconnexion ne supprime jamais les données d'une infirmière. La connexion d'un autre compte ferme la connexion DB précédente sans effacement.

---

## Logique cotation — règles upsert

```
Patient existe dans le carnet ?
├── OUI → Upsert (mise à jour de la cotation existante)
│         Jamais de push(), jamais de doublon
│         Résolution index : cotationIdx > invoice_number > invoice_number original
│         Si aucun index trouvé ET mode édition (_editRef) → ne rien faire
│
└── NON → Créer la fiche patient + la cotation (une seule fois)
          Uniquement si ce n'est PAS une correction (_editRef absent)
```

| Situation | Comportement |
|---|---|
| Patient existant + mode édition + index trouvé | Mise à jour de la cotation |
| Patient existant + pas de mode édition | Ajout de la cotation (1ère fois) |
| Patient existant + mode édition + index introuvable | Rien (évite doublon) |
| Patient absent + pas de mode édition | Crée la fiche patient + la cotation |
| Patient absent + mode édition | Rien (ne crée pas de fiche fantôme) |

**Mode cabinet :** 1 ligne `planning_patients` par IDE, isolation par `infirmiere_id` de chaque IDE.

---

## Tarifs NGAP 2026 officiels

| Code | Libellé | Tarif | Règle coefficient |
|---|---|---|---|
| AMI1–AMI6 | Actes infirmiers de soins | 3,15 € × coeff | Principal ×1, secondaire ×0,5 |
| AIS1, AIS3 | Aide infirmier soins | 2,65 € / 7,95 € × coeff | Principal ×1, secondaire ×0,5 |
| BSA | Bilan soins — dépendance légère | 13,00 € | Forfait fixe |
| BSB | Bilan soins — dépendance modérée | 18,20 € | Forfait fixe |
| BSC | Bilan soins — dépendance lourde | 28,70 € | Forfait fixe |
| IFD | Indemnité forfaitaire déplacement | 2,75 € | Fixe, 1 seule par passage |
| IK | Indemnité kilométrique | km × 2 × 0,35 € | Fixe (aller-retour) |
| MCI | Majoration coordination | 5,00 € | Fixe |
| MIE | Majoration enfant < 7 ans | 3,15 € | Fixe |
| NUIT | Majoration nuit (20h–23h / 5h–8h) | 9,15 € | Fixe |
| NUIT_PROF | Majoration nuit profonde (23h–5h) | 18,30 € | Fixe |
| DIM | Majoration dimanche/férié | 8,50 € | Fixe |

**Cumuls interdits :** AIS+BSx · plusieurs BSx · NUIT+DIM · NUIT_PROF+DIM · IFD multiple

---

## Système preuve soin (v7/v8)

| Type | Force probante | Impact score fraude | Impact simulation CPAM |
|---|---|---|---|
| `auto_declaration` | STANDARD | neutre | Accepté |
| `signature_patient` | FORTE | −3 pts | Supprime 1 anomalie |
| `photo` (hash uniquement) | FORTE | −3 pts | Supprime 1 anomalie |
| Absent | ABSENTE | +3 pts | Anomalie ajoutée |

> Photo et signature ne sont **jamais transmises** — uniquement leur hash djb2. Géolocalisation floue (département — RGPD compatible).

---

## Détecteur de fraude — règles de scoring

| Règle | Points |
|---|---|
| AMI multiples identiques (≥ 3 actes, < 2 libellés) | +3 |
| Plus de 4 actes AMI | +2 |
| Acte complexe sans justification clinique | +3 |
| BSI sans dépendance documentée | +4 |
| IFD sans mention domicile | +2 |
| Majoration nuit sans horaire documenté | +3 |
| Distance sans mention domicile | +4 |
| IK exclue (distance non documentée) | +2 |
| Schéma répétitif ≥ 3 passages identiques | +5 |
| Montant élevé > 50 € | +2 |
| Corrections validateur NGAP | +2 par alerte |
| Flag patient pattern 🚨 | +4 par flag |
| Dépendance statique sur historique | +3 |
| Incohérence pathologie/fréquence | +2 |
| Preuve terrain ABSENTE | +3 |
| Preuve STANDARD + montant > 20 € | +1 |
| **Preuve FORTE** | **−3** |

**Niveaux :** LOW (0–3) · MEDIUM (4–7) · HIGH (≥ 8)
**Blocage FSE :** fraud=HIGH ou (MEDIUM + CPAM CRITIQUE)

---

## Heuristique trafic temporelle (ai-tournee.js)

| Créneau | Jours | Coefficient | Label |
|---|---|---|---|
| 7h15–9h30 | Lun–Ven | ×1.65 | 🔴 Pointe matin |
| 11h45–14h15 | Lun–Ven | ×1.30 | 🟡 Déjeuner |
| 16h30–19h30 | Lun–Ven | ×1.75 | 🔴 Pointe soir |
| 19h30–21h | Lun–Ven | ×1.20 | 🟡 Après pointe |
| 9h30–12h30 | Sam | ×1.25 | 🟡 Sam. matin |
| Reste | Tous | ×1.0 | 🟢 Fluide |

---

## Checklist RGPD / HDS

### A. Gouvernance
- ✅ Registre des traitements — ✅ Responsable de traitement défini — ✅ DPO si applicable

### B. Sécurité
- ✅ HTTPS partout (Cloudflare Worker + GitHub Pages)
- ✅ Chiffrement AES-256-GCM — backend : `crypto.createCipheriv('aes-256-gcm', key, iv)`
- ✅ Mots de passe hashés (SHA-256 salé) — ✅ JWT sécurisé + vérification session
- ✅ Firewall WAF Cloudflare

### C. Données de santé
- ✅ Accès restreint par rôle et `infirmiere_id`
- ✅ Logs d'accès (`audit_logs` + `system_logs`)
- ✅ Chiffrement de champ (`encryptField` / `decryptField`)
- ✅ Anonymisation admin (`anonymizePatient()`, `sanitizeForAdmin()`)
- ✅ **Cabinet sync** : données anonymisées uniquement — noms patients jamais transmis

### D. Accès utilisateur
- ✅ Auth forte (JWT + PIN local) — ✅ Sessions `getSession()`
- ✅ Déconnexion auto + verrouillage PIN — ✅ Permissions granulaires `PERMISSIONS`

### E–F. Données & Stockage
- ✅ Minimisation — ✅ Anonymisation partielle admins — ✅ Séparation infirmière/admin
- ✅ Patients IndexedDB `ami_patients_db_<userId>` chiffré — ✅ Signatures `ami_sig_db_<userId>`
- ✅ Backup sync PC ↔ mobile — ✅ Purge auto vieux logs
- ✅ **Cabinet sync TTL 7 jours** — auto-expiration

### G. Droits utilisateurs
- ✅ Export (`exportPatientData()`, `exportMyData()`, `exportComptable()`)
- ✅ Suppression compte — ✅ Modification profil

### H. Consentement
- ✅ CGU + politique RGPD — ✅ Consentement explicite (`checkConsent()`)
- ✅ Révocation (`revokeConsent()`) — ✅ Traçabilité
- ✅ **Consentement sync cabinet** : case à cocher par donnée + par collègue

### I. Audit & logs
- ✅ `audit_logs` — ✅ `system_logs` — ✅ Anti-fraude — ✅ Score qualité IA
- ✅ **Audit cabinet** : `CABINET_CREATED`, `CABINET_JOINED`, `CABINET_SYNC_PUSH`, `CABINET_SYNC_PULL`

### J. Incident
- ✅ Plan de réponse — ✅ Notification CNIL < 72h — ✅ Alertes fraude

---

## Outils professionnels (infirmiere-tools.js)

| Outil | Fonctionnalité |
|---|---|
| Charges & net réel | Simulateur annuel URSSAF + CARPIMKO + IR — barème 2026 |
| Journal kilométrique | Saisie trajets, barème IK par CV (3→7+), véhicule électrique, export CSV |
| Modèles de soins | Bibliothèque CRUD de descriptions pré-remplies, cotation 1 clic |
| Simulateur majorations | Calcul instantané AMI/AIS/BSx + IFD/IK/MIE/MCI selon heure/jour |
| Suivi ordonnances | Enregistrement, alertes expiration 30j, lien carnet patient |

---

## Documentation

| Fichier | Rôle |
|---|---|
| `README.md` | Documentation technique architecture (ce fichier) |
| `GUIDE_INFIRMIERES.md` | Guide pratique & FAQ — chargé dynamiquement dans la vue Aide |
