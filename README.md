# AMI — Documentation Architecture v7.0

> **Application web progressive (PWA) pour infirmières libérales.**  
> Cotation NGAP automatique, tournée optimisée, carnet patients chiffré, signatures électroniques, mode cabinet multi-IDE, **moteur hybride Smart Engine IA**.

---

## Versions

| Composant | Version | Nouveautés |
|---|---|---|
| **Worker backend** | **v7.0** | Smart Engine hybride, State Engine, RL Logger, Heatmap Scoring, 3 nouvelles routes |
| **Agent IA N8N** | **v10** | +2 nœuds : RL Decision Logger + Heatmap Zone Scorer — pipeline NGAP intact |
| Module cabinet | v1.0 | Gestion membres, sync sélective, cotation multi-IDE |
| Moteur tournée IA | v6.0 | Cabinet multi-IDE, clustering, fatigue, surge, prédiction retard |
| Cotation | v8 | Mode cabinet multi-IDE, sélecteur "Qui fait quoi ?" |
| Dashboard | v2.0 | KPIs multi-IDE, simulateur revenus, objectif CA |
| Heatmap zones | **v2.0** | Scoring décisionnel automatique (enrichHeatmap + scorePatientZone) |
| Assistant vocal IA | v1.1 | NLP embarqué |
| PWA / Service Worker | v3.6 | Cache offline, tiles carte |
| Sécurité RGPD | v2.0 | Isolation multi-users IndexedDB par userId |
| Admin panel | v4.0 | Admins invisibles entre eux + stats Smart Engine |

---

## Architecture globale de l'application

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        TERMINAL UTILISATEUR                             │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    FRONTEND (GitHub Pages)                        │  │
│  │  index.html · style.css · mobile-premium.css · desktop-premium   │  │
│  │                                                                   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │  │
│  │  │cotation.js│ │tournee.js│ │patients.j│ │  cabinet.js      │   │  │
│  │  │NGAP v8   │ │planning  │ │IndexedDB │ │  multi-IDE v1.0  │   │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │  │
│  │                                                                   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │  │
│  │  │dashboard │ │map.js    │ │ai-tournee│ │  security.js     │   │  │
│  │  │KPIs+CA   │ │Leaflet   │ │Smart TSP │ │  AES-256-GCM     │   │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │  │
│  │                                                                   │  │
│  │  STOCKAGE LOCAL (jamais transmis aux serveurs)                   │  │
│  │  ├── IndexedDB ami_patients_db_<userId>  ← données santé AES    │  │
│  │  ├── IndexedDB ami_sig_db_<userId>       ← signatures AES       │  │
│  │  └── localStorage ami_dash_<userId>_*   ← cache non-sensible    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                               │ HTTPS · JWT
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│               CLOUDFLARE WORKER v7.0  (Edge Computing)                  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  🧠 SMART ENGINE HYBRIDE (NOUVEAU v7.0)                          │  │
│  │                                                                   │  │
│  │  REQUEST ami-calcul mode:ngap                                     │  │
│  │       │                                                           │  │
│  │       ▼                                                           │  │
│  │  [1] CACHE sha256 ──── HIT ──────────────────────→ Réponse       │  │
│  │       │ MISS                                                      │  │
│  │       ▼                                                           │  │
│  │  [2] RULE ENGINE (cas simples ~60%) ── OK ────────→ Réponse      │  │
│  │       │ cas complexe                                              │  │
│  │       ▼                                                           │  │
│  │  [3] ML RAPIDE (confidence > 0.82) ── OK ─────────→ Réponse      │  │
│  │       │ faible confiance                                          │  │
│  │       ▼                                                           │  │
│  │  [4] N8N FALLBACK ─────────────────────────────────→ Réponse     │  │
│  │                                                                   │  │
│  │  Résultat → RL Logger → State Engine update                      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌────────────────┐  ┌─────────────────┐  ┌────────────────────────┐  │
│  │  STATE ENGINE  │  │   RL LOGGER     │  │   HEATMAP SCORING      │  │
│  │  (nouveau v7)  │  │  (nouveau v7)   │  │   (nouveau v7)         │  │
│  │  Map userId→   │  │  Q-table ε-     │  │  enrichHeatmap()       │  │
│  │  {version,     │  │  greedy         │  │  scorePatientZone()    │  │
│  │   heatmap,     │  │  reward réel    │  │  > 30 → high priority  │  │
│  │   last_cotat.} │  │  → system_logs  │  │  10-30 → normal        │  │
│  └────────────────┘  └─────────────────┘  └────────────────────────┘  │
│                                                                         │
│  Auth · Isolation infirmiere_id · NGAP rules · Fraud detection          │
│  Cabinet multi-IDE · Sync PC↔Mobile · Invoice generation               │
└─────────────────────────────────────────────────────────────────────────┘
          │                              │
          │ SQL REST                     │ HTTP POST
          ▼                              ▼
┌─────────────────────┐     ┌──────────────────────────────────────────┐
│  SUPABASE           │     │  N8N v10  (Render · stateless)           │
│  (PostgreSQL)       │     │                                          │
│                     │     │  ami-calcul → Pipeline NGAP complet      │
│  planning_patients  │     │  [NLP → RAG → Grok → Validate →         │
│  infirmieres        │     │   Recalcul → Fraud → CPAM → FSE →       │
│  sessions           │     │   RL Decision Logger ← NOUVEAU v10      │
│  audit_logs         │     │   Heatmap Zone Scorer ← NOUVEAU v10     │
│  system_logs        │     │   → Respond]                            │
│  cabinets           │     │                                          │
│  cabinet_members    │     │  Utilisé uniquement pour cas complexes  │
│  signatures_sync    │     │  (~20% des appels ami-calcul)           │
│  weekly_planning    │     │                                          │
│  km_journal         │     └──────────────────────────────────────────┘
│  heure_cache        │
│  carnet_patients    │
└─────────────────────┘
```

---

## Architecture N8N v10 — Pipeline complet

> Workflow : `AI_Agent_AMI_v10` · **51 nœuds**
> Instance : `https://n8n-6fyl.onrender.com` · Statut : **active**
> **2 nouveaux nœuds v10** — pipeline NGAP **100% inchangé**

### Flux principal `/ami-calcul`

```
[POST /ami-calcul]  ← Webhook
        │
        ▼
[0] Router Cabinet
    Détecte _cabinet_mode → pipeline solo (0) ou Split by IDE (1)
        │
    ┌───┴──────────────────────────────────┐
    │ MODE SOLO                            │ MODE CABINET
    │                                      ▼
    │                              [0b] Split by IDE
    │                                      │
    ▼                                      ▼
[1] NLP Médical v6+v7
    Extraction actes · contexte · distance km
    preuve_soin : type / timestamp / hash / geo_zone / force_probante
        │
        ▼
[2] RAG NGAP Retriever v7
    Base documentaire NGAP 2026 — retrieval BM25
    rulesetHash + rulesetVersion
        │
        ▼
[3] AI Agent — xAI Grok
    Raisonnement NGAP avec historique patient
    Renvoie : actes[] code "AMI"+coeff, total, dre_requise, horaire_type
        │
        ▼
[4] Parser résultat IA v5.5
    Parse JSON Grok, détection hallucinations, normalisation
        │
        ▼
[5] Validateur NGAP V1
    AIS+BSI exclusion · IFD unique · NUIT+DIM interdit · IK sans distance
        │
        ▼
[6] Optimisateur € v3
    Ajout auto MCI / IFD / IK / MIE si critères présents
        │
        ▼
[7] Validateur NGAP V2
    Second passage post-optimisation
        │
        ▼
[8] Recalcul NGAP Officiel v5  ← SOURCE DE VÉRITÉ ABSOLUE
    Tarifs 2026 officiels · tri acte principal · coefficients
    IK = km × 2 × 0,35 € · audit trail complet
        │
        ▼
[9] Analyse Pattern Patient v2
    Répétition ≥ 7j · évolution dépendance · cohérence pathologie
        │
        ▼
[10] Suggestions alternatives v4
     Gains € non réalisés · conseils preuve soin
        │
        ▼
[11] Fraude Detector v7
     Score multicritères — preuve absente +3 pts · preuve forte −3 pts
        │
        ▼
[12] CPAM Simulator v5
     Simulation contrôle CPAM — preuve forte supprime 1 anomalie
        │
        ▼
[13] Scoring Infirmière v4
     Score global IDE — niveau SAFE / SURVEILLANCE / DANGER
        │
        ▼
[14] Blocage FSE si HIGH
     Bloque si fraud=HIGH ou (MEDIUM + CPAM CRITIQUE)
        │
        ▼
[15] FSE Generator v6+v7
     FSE-1.40 · justification médicale horodatée · preuve_soin intégrée
        │
        ▼
[Mode spécial ?] — bypass DB si _mode≠ngap / _skip_db / blocked
     │ NON                │ OUI
     ▼                    ▼
[16] Sauvegarder en BDD v8
     INSERT cotations avec invoice_number · RETURNING id
        │
        ▼
[17] Fusionner réponse v11
     Réponse finale · db_invoice_number
        │
        ▼
[18] Merge Cabinet
     Enrichit réponse cabinet avec ide_id · cabinet_mode:true
     Solo : laisse passer sans modification
        │
        ▼
[19] RL Decision Logger  ◄─────────────── NOUVEAU v10
     Calcule reward réel = revenue - km_cost - delay_cost
     Log dans la réponse : _rl_decision { state, action, reward, outcome }
     Transparent — ne modifie pas la cotation
        │
        ▼
[20] Heatmap Zone Scorer  ◄────────────── NOUVEAU v10
     Estime revenue_per_hour · delay_risk · zone_score composite
     Ajoute zone_data + zone_score à la réponse
     Transparent — ne modifie pas la cotation
        │
        ▼
[21] Respond to Webhook → JSON au worker
```

### Changements v10 vs v9

| Nœud | Type | Position | Rôle |
|---|---|---|---|
| **RL Decision Logger** | Code JS | Après Merge Cabinet | Calcule reward réel, journalise décision RL |
| **Heatmap Zone Scorer** | Code JS | Après RL Decision Logger | Score zone géographique estimé, enrichit réponse |

**Connexion modifiée :**
```
AVANT v9 : Merge Cabinet → Respond to Webhook
APRÈS v10 : Merge Cabinet → RL Decision Logger → Heatmap Zone Scorer → Respond to Webhook
```

> ⚠️ Ces deux nœuds sont **entièrement transparents** : ils n'altèrent pas les actes NGAP, les montants, ni les alertes. Ils ajoutent uniquement des métadonnées `_rl_decision` et `zone_score` exploitées par le Worker v7.

### Flux secondaires (inchangés)

| Webhook | Chemin | Description |
|---|---|---|
| Webhook Historique | `/ami-historique` | Cotations par user_id + limit |
| Webhook Supprimer | `/ami-supprimer` | Suppression par id ou patient_id |

---

## Modèle Smart Engine — détail v7.0

### Pipeline de décision

```
INPUT body { texte, heure_soin, km, date_soin }
        │
        ▼
sha256(texte+heure+km+date) ──── Cache HIT? ──── OUI ──→ { source: 'cache' }
        │ NON
        ▼
_isSimpleCase(body)?
  NON si : perfusion · pansement complexe · escarre · nécrose
           toilette grabataire · bilan dépendance · 23h/nuit profonde
           dimanche · cabinet · plusieurs actes
  OUI → fallbackCotation() ──── actes > 0 & total > 0? ── OUI → { source: 'rule' }
        │ NON
        ▼
_mlPredict(body)
  features : injection +0.15 · prélèvement +0.15 · pansement +0.10
             heure_soin +0.05 · domicile +0.05
             ambiguïté -0.30
  confidence > 0.82? ── OUI → { source: 'ml' }
        │ NON
        ▼
computeCotationSmart → N8N
  POST /webhook/ami-calcul → pipeline N8N complet
  Résultat mis en cache pour 1h
  { source: 'n8n' }
```

### Compteurs exposés dans `/webhook/admin-engine-stats`

```json
{
  "smart_engine": {
    "cache_size": 42,
    "rule_engine_hits": 1240,
    "ml_engine_hits": 380,
    "n8n_calls": 95
  },
  "state_engine": { "active_users": 7 },
  "rl_engine": {
    "q_table_states": 12,
    "action_stats": {
      "rule":  { "avg_q": 14.2, "count": 1240 },
      "ml":    { "avg_q": 11.8, "count": 380 },
      "cache": { "avg_q": 13.5, "count": 520 },
      "n8n":   { "avg_q": 18.6, "count": 95 }
    }
  }
}
```

---

## RL Engine — fonctionnement

### Reward réel

```
reward = revenue
       - km × 0.35     (coût kilométrique — remboursement CPAM)
       - fatigue × 5   (coût fatigue IDE — subjectif)
       - delay × 2     (pénalité retard patient)
```

### Q-table (ε-greedy)

```
État   = { zone, time_slot, load_level }
Action = 'cache' | 'rule' | 'ml' | 'n8n'
α = 0.1  (taux apprentissage)
γ = 0.9  (facteur actualisation)
ε = 0.10 (taux exploration)

Q(s,a) ← Q(s,a) + α × [ reward + γ × max Q(s',a') - Q(s,a) ]
```

### Log RL (`system_logs` event: `RL_DECISION`)

```json
{
  "userId": "uuid",
  "state":  { "zone": "Finistère-29", "time_slot": "day", "load_level": "normal" },
  "action": "rule",
  "reward": 12,
  "context": { "invoice": "F2026-ABCDEF-000042" }
}
```

---

## Heatmap Scoring — fonctionnement v2.0

### Flux complet

```
Tournée terminée (front)
       │ POST /webhook/heatmap-push
       ▼
Worker v7 — State Engine
       │ heatmap[gridKey] = { revenue_per_hour, km, delay_risk }
       ▼
enrichHeatmap(grid)
       │ score = revenue_per_hour - km×0.35 - delay_risk×5
       ▼
ami-tournee-ia
       │ scorePatientZone(patient, heatmap) → zone_score
       │ heatmapPriority(score) → 'high' | 'normal' | 'low'
       ▼
Tri composite : priority_horaire + (zone_score > 30 ? +20 bonus)
```

### Routes heatmap (nouvelles v7)

| Route | Permissions | Rôle |
|---|---|---|
| `POST /webhook/heatmap-push` | Infirmière seulement | Envoyer les données de zone depuis le front |
| `POST /webhook/heatmap-pull` | Infirmière seulement | Lire la heatmap enrichie (avec score) |

---

## Modèle de sécurité & isolation des données

### Rôles utilisateurs

| Rôle | Accès données patients | Accès fonctionnalités | Cabinet |
|---|---|---|---|
| **Infirmière** | Ses propres patients uniquement (`infirmiere_id`) | Toutes les vues métier | Créer / rejoindre un cabinet |
| **Admin** | Ses propres patients de test uniquement — jamais ceux des infirmières | Toutes les vues en mode démo + panneau admin | Cabinet de test (isolation `user.id`) |

### Règles d'isolation strictes

- Chaque infirmière ne voit **que ses propres données** — filtrage strict `infirmiere_id=eq.${user.id}` côté Worker
- Les admins testent toutes les fonctionnalités avec **leurs propres données de test** — pas d'accès aux données infirmières
- Les admins sont **invisibles entre eux** — le panneau admin n'affiche que les comptes infirmières
- Le panneau admin affiche statistiques globales + noms/prénoms des **infirmières uniquement**
- **RL Logger désactivé pour les admins** — les décisions de test ne polluent pas la Q-table

### Architecture Privacy by Design

```
Données de santé → chiffrées AES-256-GCM → stockage local (IndexedDB)
                                            JAMAIS transmises aux serveurs

Cloudflare Worker → métadonnées & cotations uniquement
Supabase          → données non-sensibles + cotations (chiffrement champ)
N8N (Render)      → traitement IA stateless — aucune donnée santé brute stockée

Smart Engine      → cache mémoire Worker (TTL 1h) — anonymisé par sha256
State Engine      → mémoire Worker (reset au redéploiement) — pas de persistance DB
RL Logger         → system_logs (userId + reward seulement — jamais de texte médical)

Mode cabinet sync → données anonymisées uniquement
                    consentement explicite requis · TTL 7 jours
```

---

## Checklist RGPD / HDS — audit-ready

### A. Gouvernance
- ✅ Registre des traitements — ✅ Responsable de traitement défini — ✅ DPO si applicable

### B. Sécurité
- ✅ HTTPS partout (Cloudflare + GitHub Pages)
- ✅ Chiffrement **AES-256-GCM** — `crypto.createCipheriv('aes-256-gcm', key, iv)` (PBKDF2, 100k itérations)
- ✅ Mots de passe hashés (SHA-256 salé) — ✅ JWT sécurisé + vérification session Supabase
- ✅ Firewall WAF Cloudflare

### C. Données de santé
- ✅ Accès restreint par rôle et `infirmiere_id`
- ✅ Logs d'accès (`audit_logs` + `system_logs`)
- ✅ Chiffrement de champ (`encryptField` / `decryptField`)
- ✅ Anonymisation admin (`anonymizePatient()`, `sanitizeForAdmin()`)
- ✅ **Smart Engine** : cache sha256 (texte anonymisé) — jamais en clair
- ✅ **RL Logger** : system_logs ne contient jamais le texte libre médical

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
- ✅ CGU + politique RGPD — ✅ Consentement explicite
- ✅ **Consentement sync cabinet** : case à cocher par donnée + par collègue

### I. Audit & logs
- ✅ `audit_logs` — ✅ `system_logs` — ✅ Anti-fraude — ✅ Score qualité IA
- ✅ **RL decisions loguées** : event `RL_DECISION` dans system_logs (admin visible)
- ✅ **Heatmap push/pull audités** : event `HEATMAP_PUSH` dans audit_logs

### J. Incident
- ✅ Plan de réponse — ✅ Notification CNIL < 72h — ✅ Alertes fraude

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

---

## Routes API — Cloudflare Worker v7.0

### Authentification & Profil

| Route | Méthode | Permissions |
|---|---|---|
| `/webhook/auth-login` | POST | Public |
| `/webhook/infirmiere-register` | POST | Public |
| `/webhook/change-password` | POST | Auth |
| `/webhook/delete-account` | POST | Auth |
| `/webhook/profil-get` / `profil-save` | POST | Auth |

### Cotation NGAP

| Route | Méthode | Permissions | Rôle |
|---|---|---|---|
| `/webhook/ami-calcul` | POST | Auth | **Smart Engine v7** → Rule/ML/N8N auto-sélectionné |
| `/webhook/ami-calcul` + `cabinet_mode:true` | POST | Auth | Split IDE → N8N parallèle → merge |
| `/webhook/ami-historique` | GET | Auth | Historique — Supabase direct (pas N8N) |
| `/webhook/ami-supprimer` | POST | Auth | Suppression par ID ou patient_id |
| `/webhook/ami-supprimer-tout` | POST | Auth | Suppression groupée |
| `/webhook/ami-save-cotation` | POST | Auth | Sauvegarde cotation tournée live |

### Cabinet multi-IDE

| Route | Méthode | Permissions | Rôle |
|---|---|---|---|
| `/webhook/cabinet-register` | POST | Auth | Créer / rejoindre / quitter |
| `/webhook/cabinet-get` | POST | Auth | Infos + membres |
| `/webhook/cabinet-calcul` | POST | Auth | Cotation multi-IDE parallèle |
| `/webhook/cabinet-tournee` | POST | Auth | Distribution patients clustering géo |
| `/webhook/cabinet-sync-push` / `-pull` / `-status` | POST | Auth | Sync sélective anonymisée |

### Tournée & IA

| Route | Méthode | Permissions | Rôle |
|---|---|---|---|
| `/webhook/ami-tournee-ia` | POST | Auth | Tournée + **heatmap scoring v7** |
| `/webhook/ami-live` | POST | Auth | Pilotage live |
| `/webhook/ami-copilot` | POST | Auth | Copilote NGAP |
| `/webhook/ami-week-analytics` | POST | Auth | Analyse hebdomadaire |

### Heatmap (NOUVELLES v7)

| Route | Méthode | Permissions | Rôle |
|---|---|---|---|
| `/webhook/heatmap-push` | POST | Infirmière | Mettre à jour les données de zone |
| `/webhook/heatmap-pull` | POST | Infirmière | Lire la heatmap enrichie (avec scores) |

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
| `/webhook/admin-users` | GET | Admin | Liste comptes infirmières (admins exclus) |
| `/webhook/admin-action` | POST | Admin | Bloquer / débloquer / supprimer |
| `/webhook/admin-messages` | POST | Admin | Messagerie admin |
| `/webhook/admin-engine-stats` | POST | **Admin** | **Stats Smart Engine + RL + State (NOUVEAU v7)** |
| `/webhook/log` | POST | Public | Log frontend → system_logs |
| `/webhook/system-logs` | GET | Admin | Logs + stats N8N + décisions RL |

---

## Schema base de données Supabase

### Tables principales

```sql
-- Cotations worker (table principale)
CREATE TABLE IF NOT EXISTS planning_patients (
  id BIGSERIAL PRIMARY KEY, infirmiere_id UUID NOT NULL,
  date_soin DATE, heure_soin TEXT, notes TEXT, actes TEXT,
  total NUMERIC(10,2), part_amo NUMERIC(10,2), part_amc NUMERIC(10,2),
  part_patient NUMERIC(10,2), dre_requise BOOLEAN DEFAULT false,
  source TEXT, ngap_version TEXT, fraud_score NUMERIC, ai_score NUMERIC,
  alerts TEXT, invoice_number TEXT, locked BOOLEAN DEFAULT false,
  patient_id TEXT, lat NUMERIC, lng NUMERIC, adresse TEXT,
  done BOOLEAN, absent BOOLEAN, cabinet_id UUID DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(infirmiere_id, invoice_number)
);

-- Infirmières
CREATE TABLE IF NOT EXISTS infirmieres (
  id UUID PRIMARY KEY, email TEXT UNIQUE, password TEXT,
  nom TEXT, prenom TEXT, role TEXT DEFAULT 'nurse',
  is_blocked BOOLEAN DEFAULT false, adeli TEXT, rpps TEXT, structure TEXT
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY, token TEXT UNIQUE,
  infirmiere_id UUID, created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Logs audit (toutes les actions sensibles)
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY, user_id UUID, event TEXT,
  score NUMERIC, meta JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Logs système (N8N failures, IA fallbacks, RL decisions)
CREATE TABLE IF NOT EXISTS system_logs (
  id SERIAL PRIMARY KEY, level TEXT DEFAULT 'info',
  source TEXT, event TEXT, message TEXT, meta TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Tables sync PC ↔ Mobile

```sql
CREATE TABLE IF NOT EXISTS carnet_patients (
  id BIGSERIAL PRIMARY KEY, infirmiere_id UUID NOT NULL,
  patient_id TEXT NOT NULL, encrypted_data TEXT NOT NULL,
  nom_enc TEXT DEFAULT '', updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(infirmiere_id, patient_id)
);

CREATE TABLE IF NOT EXISTS weekly_planning (
  id BIGSERIAL PRIMARY KEY, infirmiere_id UUID NOT NULL UNIQUE,
  encrypted_data TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS km_journal (
  id BIGSERIAL PRIMARY KEY, infirmiere_id UUID NOT NULL UNIQUE,
  encrypted_data TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS heure_cache (
  id BIGSERIAL PRIMARY KEY, infirmiere_id UUID NOT NULL UNIQUE,
  data TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signatures_sync (
  id BIGSERIAL PRIMARY KEY, infirmiere_id UUID NOT NULL,
  invoice_id TEXT NOT NULL, encrypted_data TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(infirmiere_id, invoice_id)
);
```

### Tables cabinet (v6.5)

```sql
CREATE TABLE IF NOT EXISTS cabinets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nom TEXT NOT NULL, created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cabinet_members (
  id BIGSERIAL PRIMARY KEY, cabinet_id UUID NOT NULL,
  infirmiere_id UUID NOT NULL, role TEXT DEFAULT 'membre',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cabinet_id, infirmiere_id)
);

CREATE TABLE IF NOT EXISTS cabinet_sync (
  id BIGSERIAL PRIMARY KEY, cabinet_id UUID NOT NULL,
  sender_id UUID NOT NULL, sender_nom TEXT DEFAULT '',
  sender_prenom TEXT DEFAULT '', target_ids TEXT NOT NULL,
  what TEXT NOT NULL, data TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days'
);
```

---

## Tarifs NGAP 2026

| Code | Libellé | Tarif | Règle |
|---|---|---|---|
| AMI1–AMI6 | Actes infirmiers de soins | 3,15 € × coeff | Principal ×1 · secondaire ×0,5 |
| AIS1, AIS3 | Aide infirmier soins | 2,65 € / 7,95 € | Principal ×1 · secondaire ×0,5 |
| BSA | Bilan soins — dépendance légère | 13,00 € | Forfait fixe |
| BSB | Bilan soins — dépendance modérée | 18,20 € | Forfait fixe |
| BSC | Bilan soins — dépendance lourde | 28,70 € | Forfait fixe |
| IFD | Indemnité forfaitaire déplacement | 2,75 € | Fixe · 1 seule par passage |
| IK | Indemnité kilométrique | km × 2 × 0,35 € | Distance documentée obligatoire |
| MCI | Majoration coordination | 5,00 € | Fixe |
| MIE | Majoration enfant < 7 ans | 3,15 € | Fixe |
| NUIT | Majoration nuit (20h–23h / 5h–8h) | 9,15 € | Non cumulable DIM |
| NUIT_PROF | Majoration nuit profonde (23h–5h) | 18,30 € | Non cumulable DIM |
| DIM | Majoration dimanche/férié | 8,50 € | Non cumulable NUIT |

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

## Heuristique trafic temporelle

| Créneau | Jours | Coefficient | Label |
|---|---|---|---|
| 7h15–9h30 | Lun–Ven | ×1.65 | 🔴 Pointe matin |
| 11h45–14h15 | Lun–Ven | ×1.30 | 🟡 Déjeuner |
| 16h30–19h30 | Lun–Ven | ×1.75 | 🔴 Pointe soir |
| 19h30–21h | Lun–Ven | ×1.20 | 🟡 Après pointe |
| 9h30–12h30 | Sam | ×1.25 | 🟡 Sam. matin |
| Reste | Tous | ×1.0 | 🟢 Fluide |

---

## Matrice des permissions

```javascript
nurse:  ['create_invoice', 'view_own_data', 'import_calendar',
         'manage_tournee', 'manage_prescripteurs',
         'change_password', 'delete_account']

admin:  ['view_users_list', 'view_stats', 'view_logs',
         'change_password', 'delete_account']

// Règles spéciales v7 :
// - RL Logger désactivé pour les admins (isAdmin === true)
// - Heatmap push/pull : admins exclus (retourne { ok:true, synced:0 })
// - admin-engine-stats : admin uniquement (view_stats)
// - Les admins sont INVISIBLES dans le panneau administration
```

---

## Architecture des fichiers

### Backend & Config

| Fichier | Rôle | Version |
|---|---|---|
| `worker.js` | Cloudflare Worker — Smart Engine, State Engine, RL Logger, Heatmap, routes cabinet | **v7.0** |
| `sw.js` | Service Worker PWA — cache statique, tiles, offline | v3.6 |
| `manifest.json` | PWA manifest | — |

### Auth & Sécurité

| Fichier | Rôle |
|---|---|
| `auth.js` | Login / register / logout, session, navigation par rôle |
| `security.js` | AES-256-GCM (Web Crypto), PIN local, RGPD, export/purge |

### Cabinet

| Fichier | Rôle |
|---|---|
| `cabinet.js` | Gestion membres, sync sélective, cotation multi-IDE, UX |

### UI & Navigation

| Fichier | Rôle |
|---|---|
| `ui.js` | `navTo()`, handler cabinet, `loadFaqGuide()` |
| `navigation.js` | GPS patients |
| `utils.js` | Store `APP`, helpers, `apiFetch`, `apiCall` |

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
| `cotation.js` | Cotation NGAP + mode cabinet multi-IDE | v8 |
| `tresorerie.js` | Trésorerie — paiements, remboursements, export CSV | — |
| `offline-queue.js` | File attente hors-ligne — sync auto | — |

### Tournée & Cartographie

| Fichier | Rôle | Version |
|---|---|---|
| `tournee.js` | Tournée IA + import ICS/CSV — planning, pilotage live | v5.1+ |
| `ai-tournee.js` | Moteur TSP, OSRM, trafic, clustering, fatigue, surge | v6.0 |
| `map.js` | Leaflet — tap/drag, geocoding, heatmap zones | v2.0 |
| `ai-layer.js` | Couche IA silencieuse — habitScore/geoScore | — |
| `geocode.js` | Pipeline Photon → Nominatim → cache IndexedDB | — |
| `extras.js` | Carte départ, OSRM, scoring fraude front | — |
| `uber.js` | Mode Uber Médical | — |

### IA & Copilote

| Fichier | Rôle |
|---|---|
| `copilote.js` | Chat Copilote NGAP |
| `ai-assistant.js` | Assistant vocal NLP, commandes, TTS |
| `voice.js` | Dictée médicale vocale |

### Rapports & Administration

| Fichier | Rôle | Version |
|---|---|---|
| `dashboard.js` | KPIs, anomalies, prévisions + section cabinet | v2.0 |
| `rapport.js` | Rapport mensuel PDF, santé N8N/IA | — |
| `admin.js` | Panneau admin — infirmières uniquement, stats globales + engine stats | v4.0 |
| `contact.js` | Messagerie infirmière → admin | — |

### Profil & PWA

| Fichier | Rôle |
|---|---|
| `profil.js` | Profil, mot de passe, suppression compte |
| `pwa.js` | Install, offline, sync, tiles |
| `onboarding.js` | Onboarding premier lancement |
| `infirmiere-tools.js` | Simulateur charges, journal km, modèles soins, majorations |

### N8N

| Fichier | Rôle |
|---|---|
| `AI_Agent_AMI_v10.json` | Workflow N8N v10 — 51 nœuds · 2 nouveaux nœuds v10 |

---

## Stockage local — isolation multi-utilisateurs

| Données | Base | Isolation | Chiffrement |
|---|---|---|---|
| Patients | IndexedDB `ami_patients_db_<userId>` | Par userId | AES-256 (clé JWT) |
| Signatures | IndexedDB `ami_sig_db_<userId>` | Par userId | AES-256 |
| Corrections GPS | IndexedDB `geocodeDB` | Partagé (non-sensible) | Non |
| Cotations | Supabase `planning_patients` | `infirmiere_id` | Chiffrement champ |
| Cache dashboard | localStorage `ami_dash_<userId>_*` | Par userId | Non |
| Smart Engine cache | Worker memory Map (TTL 1h) | Anonymisé sha256 | sha256 |
| State Engine | Worker memory Map | Par userId | Non (non-sensible) |
| RL Q-table | Worker memory | Global (reset deploy) | Non |

> **Règle fondamentale :** les données de santé sont stockées exclusivement sur le terminal de l'utilisateur et ne sont jamais transmises à nos serveurs.

---

## Documentation

| Fichier | Rôle |
|---|---|
| `README.md` | Documentation technique architecture (ce fichier) |
| `GUIDE_INFIRMIERES.md` | Guide pratique & FAQ — chargé dynamiquement dans la vue Aide |
