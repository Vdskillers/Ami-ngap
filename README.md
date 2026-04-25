# AMI NGAP — Assistant Médical Infirmier

> **Application web professionnelle pour infirmières libérales (IDEL).**  
> Cotation NGAP IA, simulation d'audit CPAM, preuve de soin médico-légale, optimisation de tournée, dashboard CA & analytique avancée.

---

## 🎯 Positionnement

> **« Tu fais le soin. AMI s'occupe du reste. »**  
> *Système expert médico-légal prédictif — Conçu pour les infirmier(e)s libérales.*

AMI n'est pas un simple logiciel de facturation : c'est un **bouclier anti-redressement CPAM** couplé à un copilote IA qui industrialise la cotation, anticipe les contrôles et sécurise chaque acte.

### Trois marchés cibles

| Marché | Public | Valeur clé |
|---|---|---|
| **SaaS infirmières** | IDEL France | Cotation IA + tournée + dashboard |
| **Optimisation premium** | IDEL haut volume | Détection de pertes & objectif de CA |
| **B2B juridique** | Cabinets comptables, avocats santé | Audit CPAM simulé + traçabilité forensic |

---

## 📚 Sommaire

1. [Vue d'ensemble fonctionnelle](#1-vue-densemble-fonctionnelle)
2. [Architecture technique](#2-architecture-technique)
3. [Stack & dépendances](#3-stack--dépendances)
4. [Modules frontend (JS)](#4-modules-frontend-js)
5. [Cloudflare Worker — backend](#5-cloudflare-worker--backend)
6. [Workflows N8N](#6-workflows-n8n)
7. [Moteur NGAP 2026 déclaratif](#7-moteur-ngap-2026-déclaratif)
8. [Modèle de sécurité & isolation](#8-modèle-de-sécurité--isolation)
9. [Cotation — règles d'upsert](#9-cotation--règles-dupsert)
10. [API endpoints — référence](#10-api-endpoints--référence)
11. [Schémas de données](#11-schémas-de-données)
12. [PWA & Offline](#12-pwa--offline)
13. [Checklist RGPD / HDS](#13-checklist-rgpd--hds)
14. [Déploiement](#14-déploiement)
15. [Versioning](#15-versioning)

---

## 1. Vue d'ensemble fonctionnelle

### Pillars

| Pilier | Description courte |
|---|---|
| 🩺 **Cotation NGAP IA** | Saisie texte/voix → IA Grok → tarification 2026 + Circulaire CIR-9/2025 |
| 🛡️ **Bouclier CPAM** | Simulateur d'audit, score de fraude, blocage FSE si HIGH risk |
| 🗺️ **Tournée intelligente** | VRPTW + 2-opt + Q-Learning RL + forecast hebdo |
| ▶️ **Pilotage Live** | Mode "Uber médical" GPS temps réel + insertion patient urgent |
| 👥 **Carnet patients** | IDB chiffré AES-256-GCM, jamais transmis aux serveurs |
| 💸 **Trésorerie & CA** | Suivi AMO/AMC, export CSV comptable, détection pertes |
| 📊 **Dashboard analytique** | KPIs, top codes, panier moyen, taux DRE, comparatifs M/M-1 |
| 🤖 **Copilote IA** | Conversationnel xAI Grok (via worker) — questions NGAP libres |
| 🎤 **Assistant vocal** | NLP médical + TTS + commandes mains-libres |
| ✍️ **Signatures électroniques** | Touch / stylet → PDF + hash forensic |
| 🔐 **Preuve de soin** | Photo + signature → hash SHA-256 horodaté (RGPD : hash uniquement) |
| 🏢 **Mode Cabinet** | Multi-IDE, KPIs consolidés, sync PC ↔ mobile |
| 📡 **Forecast & RL** | Apprentissage par renforcement + prédiction demande hebdomadaire |
| 📋 **Référentiel NGAP** | Nomenclature complète chargeable & éditable par admin |
| 💬 **Messagerie admin** | Contact infirmière ↔ admin avec accusés de lecture |

### Vues principales (UI)

| Vue | Module | Rôle |
|---|---|---|
| Auth + Landing | `index.html` (overlay `#auth-ov`) | Login + pitch commercial |
| Cotation | `cotation.js` | Saisie acte → IA → PDF + DRE |
| Tournée | `tournee.js` + `extras.js` | Planning J/J+1 + carte + pilotage |
| Carnet | `patients.js` | Fiche patient locale chiffrée |
| Dashboard | `dashboard.js` | KPIs + détection pertes |
| Trésorerie | `tresorerie.js` | AMO/AMC + export CSV |
| Rapport mensuel | `rapport.js` | Synthèse activité + nomenclature |
| Statistiques | `dashboard.js` (avancé) | Comparatifs, courbes, top patients |
| Copilote | `copilote.js` | Chat IA NGAP |
| Signatures | `signature.js` | Touch + IDB |
| Admin | `admin.js` + `admin-ngap.js` | Cohorte IDE + édition NGAP |
| Sécurité | `security.js` | PIN + RGPD + logs accès |
| Aide | `index.html` | CGU + RGPD + tutoriels |

---

## 2. Architecture technique

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         FRONTEND  PWA  (vanilla JS)                     │
│                                                                         │
│  utils.js · auth.js · security.js · admin.js · profil.js · cotation.js  │
│  voice.js · dashboard.js · rapport.js · offline-queue.js · ui.js        │
│  map.js · extras.js · uber.js · ai-tournee.js · ai-assistant.js         │
│  copilote.js · pwa.js · tournee.js · patients.js · tresorerie.js        │
│  contact.js · signature.js · geocode.js · navigation.js                 │
│  ngap_engine.js · ngap-update-manager.js · ngap-ref-explorer.js         │
│  admin-ngap.js  +  ngap_referentiel_2026.json                           │
│                                                                         │
│  STOCKAGE LOCAL (jamais transmis aux serveurs en clair)                 │
│  ├─ IndexedDB ami_patients_db_<userId>   ← AES-256-GCM                  │
│  ├─ IndexedDB ami_sig_db_<userId>        ← AES-256-GCM                  │
│  ├─ IndexedDB ami-secure (s_patients, s_sync, s_audit)                  │
│  └─ localStorage ami_dash_<userId>_*     ← cache non-sensible           │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ HTTPS · JWT (Bearer)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                CLOUDFLARE WORKER v8.4  (Edge Computing)                 │
│                                                                         │
│  SMART ENGINE HYBRIDE (4 étages)                                        │
│   ├─ [1] Cache LRU (sha256, TTL 30s)   ── HIT ───────► réponse          │
│   ├─ [2] Rule Engine (~60 % cas simples) ── OK ──────► réponse          │
│   ├─ [3] ML scoring (confidence > 0.82)  ── OK ──────► réponse          │
│   └─ [4] N8N AI Agent (xAI Grok + RAG dual) ─────────► réponse          │
│  Logger RL · State Engine · Circuit breaker DNS · Fail-soft             │
│                                                                         │
│  Auth · RBAC · Isolation infirmiere_id · Cabinet multi-IDE              │
│  Audit logs · System logs · Forensic timestamp · Sync PC↔Mobile         │
│  Référentiel NGAP 2026 embarqué + moteur déclaratif Engine              │
└────────────────────┬────────────────────────────┬───────────────────────┘
                     │                            │
        ┌────────────▼────────────┐    ┌──────────▼────────────────────┐
        │   SUPABASE (Postgres)    │    │   N8N — n8n-6fyl.onrender.com │
        │   infirmieres            │    │                                │
        │   sessions               │    │  ┌──────────────────────────┐ │
        │   planning_patients      │    │  │  AI Agent v15 DUAL RAG   │ │
        │   prescripteurs          │    │  │  (NGAP_2026.4)           │ │
        │   audit_logs             │    │  │  • NLP médical           │ │
        │   system_logs            │    │  │  • RAG STRICT + ENRICHI  │ │
        │   invoice_counters       │    │  │  • xAI Grok              │ │
        │   contact_messages       │    │  │  • Validateur V1+V2      │ │
        │   forecast_models        │    │  │  • Optimisateur €        │ │
        │   incidents              │    │  │  • Fraud Detector        │ │
        │   subscriptions          │    │  │  • CPAM Simulator        │ │
        │   cabinet_*              │    │  │  • FSE Generator         │ │
        │   ngap_*                 │    │  │  • RL Trainer + Forecast │ │
        └──────────────────────────┘    │  └──────────────────────────┘ │
                                        │  ┌──────────────────────────┐ │
                                        │  │ Cotation Preuve Update v1│ │
                                        │  └──────────────────────────┘ │
                                        │  ┌──────────────────────────┐ │
                                        │  │  ML Nightly Training v1  │ │
                                        │  │  (cron 02:00 — SGD)      │ │
                                        │  └──────────────────────────┘ │
                                        └────────────────────────────────┘
```

---

## 3. Stack & dépendances

### Frontend
- **Vanilla JavaScript** (pas de framework) — performance et taille minimale
- **HTML / CSS** — `index.html`, `style.css`, `mobile-premium.css`
- **PWA** — `manifest.json` + `sw.js` (Service Worker)
- **Leaflet** — cartographie (`map.js`)
- **OSRM** — routing (HTTP API publique + cache 5 min)
- **Web Speech API** — reconnaissance + synthèse vocale (`voice.js`, `ai-assistant.js`)

### Backend
- **Cloudflare Workers** — edge computing global, runtime V8
- **Supabase (PostgreSQL)** — données structurées non sensibles + cotations
- **N8N** (self-hosted Render) — orchestration IA + workflows
- **xAI Grok** — LLM cotation + copilote (via env `XAI_API_KEY`)
- **PostgreSQL pgvector** — RAG (BM25 + embeddings)

### Sécurité
- **AES-256-GCM** — chiffrement local & backend (`security.js`, `worker.js`)
- **PBKDF2 600 000 itérations** — hash de mots de passe (worker)
- **SHA-256** — hash de preuves de soin
- **JWT** — sessions
- **PIN local** — verrouillage 10 min d'inactivité

### Hébergement
- **GitHub Pages** — frontend (`Vdskillers/Ami-ngap`)
- **Cloudflare Workers** — backend (`raspy-tooth-1a2f`)
- **Supabase Cloud** — DB
- **Render** — N8N self-hosted

---

## 4. Modules frontend (JS)

> Ordre de chargement critique — `index.html` charge `utils.js` en premier, `ui.js` en dernier.

### Couche fondamentale
| Fichier | Rôle |
|---|---|
| `utils.js` | Store observable `APP.state`, helpers globaux, `APP.set()` → `CustomEvent('app:update')` |
| `auth.js` | Login, logout, session refresh, RBAC client |
| `security.js` | PBKDF2 → AES-256-GCM, PIN, IDB chiffré, droit RGPD (export/suppression), audit local |
| `ui.js` | Navigation, mobile, bindings, gestionnaires globaux |
| `pwa.js` | PWA install, IDB cartes, sync offline, gestion `beforeinstallprompt` |

### Métier
| Fichier | Rôle |
|---|---|
| `cotation.js` | Pipeline cotation : saisie → IA → preview → upsert IDB + worker |
| `voice.js` | Pont vers `ai-assistant.js` (dictée) |
| `patients.js` | Carnet patient local (IDB AES-256), CRUD + recherche |
| `tournee.js` | Planning J/J+1, import, optimisation, **mode Pilotage Live**, **insertion urgent** |
| `extras.js` | Carte tournée dédiée + intelligence métier front |
| `uber.js` | Mode "Uber médical" — patient suivant, GPS temps réel |
| `dashboard.js` | KPIs, courbes, **détection de pertes de revenu**, top patients/codes |
| `rapport.js` | Rapport mensuel + nomenclature NGAP |
| `tresorerie.js` | Suivi AMO/AMC, marquage paiements, export CSV comptable |
| `signature.js` | Signatures touch/stylet, IDB chiffré |
| `contact.js` | Messagerie infirmière ↔ admin |
| `copilote.js` | Chat IA conversationnel (xAI via worker) |
| `offline-queue.js` | File d'attente offline + onboarding |

### IA & Tournée
| Fichier | Rôle |
|---|---|
| `ai-tournee.js` | **VRPTW + 2-opt + Q-Learning RL**, forecast hebdo (EMA + saisonnalité), optimiseur profit net (URSSAF, CARPIMKO, IK, TVA) |
| `ai-assistant.js` | NLP médical, ML prédictif léger, navigation vocale OSRM |
| `geocode.js` | Géocodage Nominatim avec scoring (`smartGeocode`, `processAddressBeforeGeocode`, `hashAddr`) |
| `navigation.js` | Helpers navigation OSRM |
| `map.js` | Leaflet premium + GPS |

### NGAP — édition admin & moteur
| Fichier | Rôle |
|---|---|
| `ngap_engine.js` | **Moteur déclaratif** : indexation duale, application 11B, dérogations, CIR-9/2025 |
| `ngap_referentiel_2026.json` | Source canonique (tarifs, actes, règles) — version `NGAP_2026.4_CIR9_2025` |
| `ngap-update-manager.js` | Sync serveur ↔ client du référentiel |
| `ngap-ref-explorer.js` | Explorateur visuel de la nomenclature |
| `admin-ngap.js` | Édition admin du référentiel + tests + rollback |
| `admin.js` | Panneau admin : cards IDE, KPIs cohorte, filtre/tri, RGPD |

### Service Worker & PWA
| Fichier | Rôle |
|---|---|
| `sw.js` | Cache stratégies (cache-first, network-first, stale-while-revalidate), tiles offline |
| `manifest.json` | PWA installable mobile/desktop |

---

## 5. Cloudflare Worker — backend

### Version actuelle : **v8.4** (Production Ready)

Fichier : `worker.js` (~10 000 lignes)

### Nouveautés v8.4
- **DNS cache overflow protection** — solution structurelle :
  - Cache global JS LRU 100 entrées TTL 30 s avant `fetch()`
  - Backoff exponentiel sur 503 DNS (100 ms → 300 ms → 800 ms)
  - Fail-soft sur `SELECT` (retourne `[]` au lieu de cascader 503)
  - Circuit breaker global (3 erreurs DNS en 5 s → coupe 10 s)
- **HTTP cache conditionnel** sur reads Supabase (sessions, infirmieres, audit_logs, system_logs)
- **Headers CORS garantis** même sur 503 upstream

### Smart Engine hybride (4 étages)

```
┌──────────────────────────┐
│ [1] Cache LRU (sha256)   │ ← HIT → réponse immédiate (0 ms)
│     TTL 30 s, 100 entr.  │
└────────────┬─────────────┘
             │ MISS
┌────────────▼─────────────┐
│ [2] Rule Engine           │ ← cas simples (≤ 3 mots-clés clairs)
│     ~60 % du trafic       │
└────────────┬─────────────┘
             │ NOK
┌────────────▼─────────────┐
│ [3] ML scoring (SGD)      │ ← confidence > 0.82 → OK
│     features 7 dim        │
└────────────┬─────────────┘
             │ low confidence
┌────────────▼─────────────┐
│ [4] N8N AI Agent v15      │ ← Grok + RAG DUAL
│     timeout 50 s          │
└──────────────────────────┘
```

### Fonctions clés (extraits)
- `computeCotationSmart(body, n8nTarget, fwdHeaders, debug, rlState)` — orchestration des 4 étages
- `computeWithDeclarativeEngine(body, opts)` — moteur déclaratif local (NGAP 2026)
- `predictOutcome(body)` — prédiction multi-output (revenue, delay, fatigue)
- `forecastWeek(userId, D)` — forecast hebdo Lun→Dim
- `computeStaffing(forecastDay)` — besoins en IDE/jour
- `buildRLDataset(rlLogs, cotations)` — dataset entraînement RL/ML
- `optimizeForTarget(plan, target, constraints)` — optimisation objectif CA
- `netProfitScore({ revenue, km, delay, fatigue })` — score profit net
- `normalizeNGAPCodes(actes, totalInput)` — résolution alias → codes officiels
- `isHallucination(data)` — détection IA hallucinée
- `parseAIResponse(raw)` — parser universel (GPT/Grok/Claude)



## 6. Workflows N8N

### 6.1 — `AI Agent AMI v15 NGAP2026.4 DUAL RAG`

**Endpoint principal** : `POST /webhook/ami-calcul`

Pipeline (51 nodes) :
```
Webhook
  → NLP Médical (preprocess texte)
  → RAG NGAP Dual (STRICT opposable + ENRICHI pédagogique)
  → AI Agent (xAI Grok)
  → Parser résultat IA
  → Validateur NGAP V1
  → Optimisateur € (max revenue dans le respect des règles)
  → Validateur NGAP V2 (post-optimisation)
  → Recalcul NGAP Officiel (tarifs 2026 stricts)
  → Analyse Pattern Patient (longitudinal)
  → Suggestions alternatives
  → Fraud Detector (score 0-100)
  → CPAM Simulator (probabilité contrôle)
  → Scoring Infirmière
  → Blocage FSE si HIGH (>70/100)
  → FSE Generator
  → Sauvegarder en BDD (postgres)
  → Fusionner réponse → Respond
```

Webhooks exposés :
| Méthode | Path | Rôle |
|---|---|---|
| POST | `/webhook/ami-calcul` | Cotation principale |
| GET  | `/webhook/ami-historique` | Historique cotations patient |
| POST | `/webhook/ami-supprimer` | Suppression cotation |
| POST | `/webhook/ami-rl-train` | Entraînement RL |
| POST | `/webhook/ami-forecast-update` | Mise à jour forecast |
| GET  | `/webhook/ami-forecast-query` | Lecture forecast |

Architecture **DUAL RAG** : 2 sections injectées dans le prompt
- **STRICT** — tarifs/règles officiels 2026, opposable en audit CPAM
- **ENRICHI** — exemples cliniques, cas limites, jurisprudence (NON opposable)

### 6.2 — `AMI Cotation Preuve Update v1`

**Endpoint** : `POST /webhook/cotation-preuve-update`

Met à jour la colonne `preuve_soin` (hash + signatures) sur `planning_patients`. 8 nodes : webhook → validation payload → check colonne → UPDATE → respond.

### 6.3 — `AMI ML Nightly Training v1`

**Trigger** : Cron `0 2 * * *` (02:00 chaque nuit)

Pipeline :
```
Cron 02:00
  → Fetch RL_DECISION Logs (Supabase, 500 dernières)
  → Fetch Cotations (planning_patients, 2000 dernières)
  → Build ML Dataset (fusion logs + cotations)
  → ML Retrain SGD (mise à jour poids feature par feature)
  → Staffing + Rapport (forecast semaine + perf RL)
  → Save Report → Supabase (system_logs)
  → Notify Worker (optionnel /webhook/ami-ml-status)
  → Error Logger (catch)
```

---

## 7. Moteur NGAP 2026 déclaratif

### Référentiel : `ngap_referentiel_2026.json`

**Version actuelle** : `NGAP_2026.4_CIR9_2025`

Contenu :
- **Lettres-clés** : AMI 3,15 € / AMX 3,15 € / AIS 2,65 € / DI 10,00 € / TMI 3,15 € (+ tarifs OM)
- **Forfaits BSI** : BSA 13,00 € / BSB **18,20 €** / BSC **28,70 €**
- **Forfaits DI** : initial (×2,5) / renouvellement (×1,2) / intermédiaire (×1,2)
- **Déplacements** : IFD 2,75 € / IFI 2,75 € / IK plaine 0,35 €/km / IK montagne 0,50 €/km / IK pied-ski 3,40 €/km
- **Plafonnement IK** : <300 km abattement 0 % / 300-399 km abattement 50 % / ≥400 km abattement 100 %
- **Majorations** : MAU 1,35 € / MCI 5,00 € / MIE **3,15 €** / ISD 8,50 € / ISN_NUIT 9,15 € / ISN_NUIT_PROFONDE 18,30 €
- **Télésoin** : TLS 10 € / TLL 12 € / TLD 15 € / RQD 10 €
- **Actes Chap I & II** : ~150 actes avec coefficient, tarif, dérogations, incompatibilités
- **Règles Article 11B** : décote à 50 % du 2ᵉ acte sauf dérogation taux plein
- **Règles CIR-9/2025** : forfait journalier perfusion (AMI 14/15 max 1×/jour)
- **Incompatibilités** : 12 règles critiques (AIS+BSI, BSB+BSC, NUIT+DIM, AMI14+AMI15, MCI+BSI, etc.)
- **Dérogations taux plein** : 9 catégories (pansement+analgésie, BSI+perfusion, art. 5bis, etc.)

### Moteur (`ngap_engine.js` + worker)

Fonctions :
- `normalizeCode(raw)` — `AMI 4,1` → `AMI4_1`
- `lookupActe(code)` — recherche par code de facturation OU code interne
- `getTarif(code, isOM)` — tarif zone-aware (OM = +5 % en moyenne)
- `computeIK(distance, zone)` — aller-retour avec plafonnement automatique
- `detectHoraire(heure, jourSemaine)` — NUIT / NUIT_PROF / DIM
- `applyDerogation(actes)` — match dérogations taux plein
- `apply11B(actes)` — décote 50 % du 2ᵉ acte si pas de dérogation
- `validateCIR9(actes, date)` — règles forfait journalier
- `compute(body)` — pipeline complet end-to-end

### Indexation duale (perf)

Index par **code de facturation** (`AMI4`, `BSC`, `IK_PLAINE`) et par **code interne** (`AMI4_PANS_AUTRE`, etc.) — permet fallback en cas d'ambiguïté ou d'alias N8N.

### Auto-tests (worker)
- `_runNGAPSelfTests(ref)` — sanity checks structure
- `_runNGAPClinicalTests(ref)` — 50 cas cliniques (objectif 50/50 = 100 %)

---

## 8. Modèle de sécurité & isolation

### Rôles

| Rôle | Accès patients | Accès fonctionnalités | Visibilité dans admin |
|---|---|---|---|
| **Infirmière** | Ses patients uniquement (filtre `infirmiere_id` côté worker) | Toutes les vues métier | Visible (nom, prénom, KPIs) |
| **Admin** | Ses propres patients de test uniquement (jamais ceux des IDE) | Toutes vues + panneau admin + édition NGAP | **Invisible** dans la liste admin |

### Règles d'isolation absolues

1. **Admins voient TOUTES les pages mais aucune donnée patient des infirmières** (anonymisation `toAdminView()` / `sanitizeForAdmin()`)
2. **Admins peuvent ajouter leurs propres patients de test** pour démo/QA
3. **Chaque infirmière ne voit que ses propres données** — jamais celles des autres IDE
4. **Les admins sont invisibles entre eux** dans le panneau admin
5. **Le panneau admin affiche** : stats globales + nom/prénom des **infirmières uniquement**
6. **Vue Signatures admin** : `invoiceId` masqués, suppression désactivée

### Privacy by Design

```
Données de santé  →  AES-256-GCM  →  IndexedDB (terminal utilisateur)
                                       JAMAIS transmises en clair aux serveurs

Worker (Cloudflare)  →  métadonnées chiffrées + cotations (chiffrement de champ)
Supabase  →  données pseudonymisées + cotations (encryptField/decryptField)
Preuve de soin  →  HASH SHA-256 uniquement (pas de photo brute, pas de signature brute)
```

### Authentification

- Login Supabase Auth (bcrypt) → JWT
- PBKDF2 600 000 itérations côté worker pour hash spécifiques
- PIN local (4-6 chiffres, hash SHA-256+sel) — verrouillage 10 min d'inactivité
- Session refresh `/webhook/session-refresh`

### Audit

| Table | Contenu |
|---|---|
| `audit_logs` | Actions utilisateurs (LOGIN, COTATION, DELETE, ADMIN_*) |
| `system_logs` | Événements techniques (N8N_FAILURE, IA_FALLBACK, FRAUD_ALERT, INTERNAL_ERROR, RL_DECISION) |
| `s_audit` (IDB) | Journal local actions sensibles, purge auto 90 jours |
| Forensic | `/webhook/forensic-timestamp` + `/webhook/forensic-log` — horodatage opposable |

---

## 9. Cotation — règles d'upsert

### Doctrine stricte (`cotation.js`)

```
Patient existe dans le carnet ?
├── OUI
│    ├── _editRef (mode édition) + index trouvé → UPDATE de la cotation
│    ├── _editRef + index introuvable          → RIEN (évite doublon)
│    └── pas _editRef                           → ADD (1ʳᵉ fois)
│
└── NON
     ├── pas _editRef → CREATE fiche patient + cotation (une seule fois)
     └── _editRef     → RIEN (pas de fiche fantôme)
```

### Résolution d'index (ordre)

1. `cotationIdx` (référence directe)
2. `invoice_number` (clé fonctionnelle)
3. `invoice_number` original (avant édition)

### Règles techniques

- **Jamais de `push()`** dans le tableau cotations
- **Jamais de doublons** — vérification systématique avant `add`
- Toute correction transite par `_editRef` (référence à la cotation existante)
- Le patient est créé une seule fois — toute cotation ultérieure est un `update`

---

## 10. API endpoints — référence

### Webhooks Worker (94 routes)

**Auth & session**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/auth-login` | POST | Login |
| `/webhook/infirmiere-register` | POST | Inscription IDE |
| `/webhook/session-refresh` | POST | Renouvellement JWT |
| `/webhook/sw-version` | GET | Version SW courante |

**Cotation**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/ami-calcul` | POST | Cotation Smart Engine |
| `/webhook/ami-historique` | GET | Historique patient |
| `/webhook/ami-save-cotation` | POST | Persistance |
| `/webhook/ami-supprimer` | POST | Suppression unitaire |
| `/webhook/ami-supprimer-tout` | POST | Suppression totale |
| `/webhook/cotation-preuve-update` | POST | MAJ preuve_soin |
| `/webhook/ami-precheck` | POST | Précheck cotation |
| `/webhook/ngap-active` | GET | Référentiel actif (public) |

**Tournée & forecast**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/ami-tournee-optimize` | POST | Optimisation tournée |
| `/webhook/ami-forecast` | GET | Forecast hebdo |
| `/webhook/ami-week-analytics` | GET | Analytics semaine |
| `/webhook/ami-premium-snapshot` | GET | Snapshot premium |

**Sync mobile ↔ PC**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/patients-push` `/-pull` `/-delete` | POST/GET | Sync carnet |
| `/webhook/planning-push` `/-pull` | POST/GET | Sync planning |
| `/webhook/km-push` `/-pull` | POST/GET | Sync kilométrage |
| `/webhook/heure-push` `/-pull` | POST/GET | Sync horaires |
| `/webhook/heatmap-push` `/-pull` | POST/GET | Sync heatmap zones |
| `/webhook/constantes-push` `/-pull` | POST/GET | Sync constantes |
| `/webhook/piluliers-push` `/-pull` | POST/GET | Sync piluliers |
| `/webhook/consentements-push` `/-pull` | POST/GET | Sync consentements |
| `/webhook/signatures-push` `/-pull` `/-delete` | POST/GET | Sync signatures |

**RL & ML**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/rl-log-reward` | POST | Log récompense RL |
| `/webhook/rl-decision` | POST | Décision ε-greedy |

**Cabinet (multi-IDE)**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/cabinet-register` `/-get` | POST/GET | Cabinet |
| `/webhook/cabinet-promote-member` `/-demote-member` | POST | Roles |
| `/webhook/cabinet-consolidated-stats` | GET | Stats consolidées |
| `/webhook/cabinet-calcul` `/-tournee` | POST | Cotation/tournée cabinet |
| `/webhook/cabinet-sync-push` `/-pull` `/-status` | POST/GET | Sync cabinet |
| `/webhook/cabinet-consent-push` `/-pull` | POST/GET | Consentements cabinet |

**Messagerie**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/contact-send` | POST | Envoyer message admin |
| `/webhook/contact-mes-messages` | GET | Messages reçus |
| `/webhook/contact-message-delete` | POST | Suppression |
| `/webhook/admin-messages` | GET | Inbox admin |
| `/webhook/admin-message-read` `/-reply` | POST | Lecture / réponse |

**Copilote**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/ami-copilot` | POST | Chat IA NGAP (xAI Grok) |

**Abonnement**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/subscription-status` | GET | Statut abonnement |
| `/webhook/subscription-upgrade` | POST | Upgrade |
| `/webhook/admin-subscription-mode` `/-list` `/-override` | POST | Admin abonnements |

**Admin**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/admin-engine-stats` | GET | Stats Smart Engine (cache, rule, ml, n8n) |
| `/webhook/admin-system-reset` | POST | Reset système |
| `/webhook/admin-bump-sw-version` | POST | Bump version SW |
| `/webhook/admin-cleanup-orphans` | POST | Cleanup orphelins |
| `/webhook/admin-fix-patient-nom` | POST | Correction noms |
| `/webhook/admin-ngap-get` `/-save` `/-rollback` `/-test` | GET/POST | Édition NGAP |
| `/webhook/admin-ngap-parse-instruction` `/-apply-patch` | POST | Parsing IA d'instructions NGAP |
| `/webhook/admin-ngap-analyze-real` `/-auto-correct` `/-auto-correct-direct` | POST | Audit cotations réelles |
| `/webhook/ngap-correction-action` | POST | Action de correction |
| `/webhook/ngap-suggest-submit` `/-list` `/-decide` `/-my` | POST/GET | Suggestions communauté |

**Forensic & logs**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/forensic-timestamp` | POST | Horodatage opposable |
| `/webhook/forensic-log` | POST | Log forensic |
| `/webhook/my-audit-logs` | GET | Mes logs |
| `/webhook/incident-report` `/-list` `/-update` | POST/GET | Incidents |
| `/webhook/log` | POST | Log frontend (sans auth) |

**Planning**
| Route | Méthode | Description |
|---|---|---|
| `/webhook/planning-passages` | GET | Passages planning |

---

## 11. Schémas de données

### Tables Supabase principales

```sql
infirmieres (id, email, role, nom, prenom, is_blocked, …)
sessions   (id, infirmiere_id, token, expires_at, …)
planning_patients (id, infirmiere_id, patient_hash, date_soin, heure_soin,
                   actes, total, invoice_number, notes,
                   preuve_soin (jsonb), …)
prescripteurs (id, infirmiere_id, nom, rpps, …)
audit_logs    (id, user_id, event, ip, meta, created_at)
system_logs   (id, level, source, event, message, meta, created_at)
invoice_counters (id, infirmiere_id, counter, …)
contact_messages (id, from_id, to_id, body, read_at, …)
forecast_models  (id, infirmiere_id, week_start, predictions (jsonb), …)
incidents        (id, type, status, …)
subscriptions    (id, infirmiere_id, plan, …)
cabinet_*        (multi-IDE)
ngap_*           (référentiel + suggestions)
```

### IndexedDB locales (chiffrées AES-256-GCM)

| DB | Stores | Usage |
|---|---|---|
| `ami_patients_db_<userId>` | `patients` | Carnet patient |
| `ami_sig_db_<userId>` | `signatures` | Signatures |
| `ami-secure` | `s_patients`, `s_sync`, `s_audit`, `prefs` | Secure layer générique |

---

## 12. PWA & Offline

### Stratégies de cache (`sw.js`)

| Ressource | Stratégie |
|---|---|
| Assets app (HTML/CSS/JS) | Cache-first |
| API Worker | Network-first (timeout 8 s) |
| Tiles OSM | Stale-while-revalidate |
| Polices Google / Leaflet CDN | Cache-first |

### Cartes offline (`pwa.js`)

```js
await downloadCurrentArea();  // ~15 km autour du départ, zooms 12-14
await downloadMapArea({ minLat, maxLat, minLng, maxLng }, [12, 13, 14]);
```

### Sync offline (`offline-queue.js`)

```
Cotation hors-ligne
  → queueCotation() → ami_offline_queue (localStorage)
        ↓ reconnexion
   syncOfflineQueue() → /webhook/ami-calcul
```

### Versioning Service Worker

Bump manuel ou via `/webhook/admin-bump-sw-version`. Au push GitHub, le SW peut nécessiter un hard-refresh (Ctrl+Shift+R) si la version n'est pas bumpée.

---

## 13. Checklist RGPD / HDS

### A. Gouvernance
- ✅ Registre des traitements
- ✅ Responsable de traitement défini
- ✅ DPO si applicable

### B. Sécurité
- ✅ HTTPS partout (Cloudflare + GitHub Pages)
- ✅ Chiffrement données AES-256-GCM (`security.js` + `worker.js`)
- ✅ Mots de passe hashés bcrypt (Supabase Auth) + PBKDF2 600 k itérations (worker)
- ✅ JWT sécurisé avec vérification de session
- ✅ Firewall / WAF Cloudflare

### C. Données de santé
- ✅ Accès restreint par rôle ET par `infirmiere_id`
- ✅ Logs d'accès (`audit_logs` + `system_logs`)
- ✅ Chiffrement de champ (`encryptField` / `decryptField`) côté worker
- ✅ Anonymisation pour la vue admin (`anonymizePatient()`, `toAdminView()`, `sanitizeForAdmin()`)
- ✅ Stockage local exclusif des données de santé (jamais transmises en clair)

### D. Accès utilisateur
- ✅ Authentification forte (JWT + PIN local)
- ✅ Gestion sessions avec expiration
- ✅ Déconnexion auto après 10 min d'inactivité

### E. Données
- ✅ Minimisation (champs strictement nécessaires)
- ✅ Anonymisation partielle (hash patients dans planning)
- ✅ Séparation logique (1 DB par utilisateur en local)

### F. Stockage
- ✅ Données chiffrées AES-256-GCM (au repos local + au repos backend)
- ✅ Backups réguliers Supabase
- ✅ Purge automatique `s_audit` (90 jours)

### G. Droits utilisateurs
- ✅ Export données (RGPD article 20)
- ✅ Suppression complète (RGPD article 17)
- ✅ Modification (RGPD article 16)

### H. Consentement
- ✅ CGU + politique RGPD intégrées (footer)
- ✅ Consentement explicite à l'inscription
- ✅ Traçabilité (`consentements-push`)

### I. Audit & logs
- ✅ Logs d'accès
- ✅ Logs d'actions
- ✅ Surveillance (system_logs + ML Nightly)

### J. Incident
- ✅ Plan de réponse (`/webhook/incident-report`)
- ✅ Notification CNIL <72h prévue
- ✅ Forensic timestamp opposable

### Hébergement HDS (en cours)

Migration possible vers **OVH HDS** (Hébergeur de Données de Santé certifié). Blocker actuel : remplacement de xAI Grok (US) par un LLM local (Ollama VPS) ou EU-compliant. Sous-traitance OVH formalisable.

---

## 14. Déploiement

### Frontend (GitHub Pages)
```bash
# Push vers main → GitHub Pages auto-deploy
git add . && git commit -m "feat: …" && git push
# URL : https://vdskillers.github.io/Ami-ngap/
```

### Worker (Cloudflare)
```bash
wrangler deploy worker.js
# URL : https://raspy-tooth-1a2f.<account>.workers.dev
```

### N8N (Render self-hosted)
```bash
# 1. Importer le workflow JSON dans n8n
# 2. Réassocier credentials (Postgres, xAI Grok)
# 3. Activer le workflow
# Workflows : 
#   • AI_Agent_AMI_v15_NGAP2026_4_DUAL_RAG.json
#   • AMI_Cotation_Preuve_Update_v1.json
#   • AMI_ML_Nightly_v1.json
```

### Référentiel NGAP
```bash
cd ngap-engine/
python3 build_ref.py             # régénère ngap_referentiel_2026.json
node test_engine_extended.js     # 50/50 tests cliniques requis
git commit -m "chore: bump NGAP 2026.x → 2026.y"
# Resync worker.js (référentiel embarqué) + workflow N8N
```

---

## 15. Versioning

| Composant | Version actuelle | Source |
|---|---|---|
| Frontend | v8.0 | `index.html` + `manifest.json` |
| Worker | v8.4 | `worker.js` (header) |
| Référentiel NGAP | NGAP_2026.4_CIR9_2025 | `ngap_referentiel_2026.json` |
| AI Agent N8N | v15 (DUAL RAG) | `AI_Agent_AMI_v15_NGAP2026_4_DUAL_RAG.json` |
| Cotation Preuve | v1 | `AMI_Cotation_Preuve_Update_v1.json` |
| ML Nightly | v1 | `AMI_ML_Nightly_v1.json` |
| Service Worker | bump manuel ou via `/webhook/admin-bump-sw-version` | `sw.js` |

### Bump workflow

Pour un correctif mineur (ex: NGAP 2026.4 → 2026.5) :
1. Modifier `build_ref.py` (ligne version + contenu)
2. Régénérer `ngap_referentiel_2026.json`
3. Lancer `test_engine_extended.js` → 50/50 obligatoire
4. Resynchroniser le référentiel embarqué dans `worker.js` et le workflow N8N
5. Commit + tag Git

Pour un correctif majeur (ex: 2026 → 2027), ajouter un tag Git versionné `v2027.1` et CHANGELOG.

---

## 📝 Crédits & contact

**Conçu pour les infirmier(e)s libérales** — par Bastien (vdskillers).  
Repo : `Vdskillers/Ami-ngap`  

> Pour toute question NGAP : utilise le **Copilote IA** intégré.  
> Pour les bugs : page **Contact** dans l'app.

---

*Dernière mise à jour : 25 avril 2026 — Worker v8.4 / Référentiel NGAP_2026.4_CIR9_2025 / N8N AI Agent v15 DUAL RAG.*
