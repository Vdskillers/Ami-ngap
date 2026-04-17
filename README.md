# AMI NGAP — Documentation Architecture

> Application web progressive (PWA) pour infirmières libérales.  
> Gestion de tournée, cotation NGAP, carnet patients chiffré, signatures électroniques, copilote IA.

---

## Versions

| Composant | Version | Notes |
|---|---|---|
| Worker backend | v6.1 | Proxy N8N sécurisé, retry 1×, normalisation codes AMI/AIS, fallback enrichi |
| **Agent IA N8N** | **v8** | `invoice_number` dans INSERT + RETURNING, `db_invoice_number` dans réponse finale |
| Moteur tournée IA | v5.1 | Heuristique trafic CEREMA intégrée |
| Assistant vocal IA | v1.1 | NLP embarqué (WebLLM retiré) |
| PWA / Service Worker | v3.6 | Cache offline, tiles carte |
| Sécurité RGPD | v2.0 | Isolation multi-users IndexedDB par userId |
| Admin panel | v4.0 | Admins invisibles entre eux dans le panneau |

---

## Changelog N8N v7 → v8

| Nœud | Modification |
|---|---|
| **Sauvegarder en BDD** | `invoice_number` ajouté dans les colonnes INSERT + dans le `RETURNING` |
| **Fusionner réponse** | Récupère `invoice_number` du RETURNING → expose `db_invoice_number` dans la réponse finale |
| *Autres nœuds* | Inchangés (v7) |

### Correction bug cotation (worker.js)

Le NLP N8N v7/v8 renvoie le code `"AMI"` (générique) avec un coefficient (`coeff: 1`, `coeff: 4`…) au lieu de `AMI1`, `AMI4`. Le `normalizeNGAPCodes()` du worker marquait ces actes `_unknown` → total = 0 → `isHallucination()` → fallback systématique avec le message *"Réponse IA incohérente corrigée automatiquement"*.

**Correction :** `normalizeNGAPCodes` détecte `code === "AMI"` + `coeff: N` et convertit en `AMI{N}` avant tout traitement.

```
AMI coeff:1 → AMI1  (3,15 €)
AMI coeff:2 → AMI2  (6,30 €)
AMI coeff:3 → AMI3  (9,45 €)
AMI coeff:4 → AMI4  (12,60 €)
AMI coeff:6 → AMI6  (18,90 €)
AIS coeff:1 → AIS1  (2,65 €)
AIS coeff:3+ → AIS3 (7,95 €)
```

---

## Modèle de sécurité & isolation des données

### Rôles utilisateurs

| Rôle | Accès données patients | Accès fonctionnalités |
|---|---|---|
| **Infirmière** | Ses propres patients uniquement (isolés par `infirmiere_id`) | Toutes les vues métier |
| **Admin** | Ses propres patients de test uniquement — jamais ceux des infirmières | Toutes les vues en mode démo, panneau admin |

### Règles d'isolation strictes

- Chaque infirmière ne voit **que ses propres données** — isolation par `infirmiere_id` côté backend (`worker.js`)
- Les admins peuvent tester toutes les fonctionnalités avec **leurs propres patients de test** sans voir les données des infirmières
- Les admins sont **invisibles entre eux** — le panneau admin n'affiche que les comptes infirmières
- Le panneau admin affiche les statistiques globales, noms et prénoms des **infirmières uniquement** (jamais les admins)
- La vue Signatures en mode admin masque les `invoiceId` réels et désactive la suppression

### Architecture Privacy by Design

```
Données de santé → chiffrées AES-256 → stockage local (IndexedDB)
                                        jamais transmises aux serveurs

Serveur (Cloudflare Worker) → métadonnées & cotations uniquement
Supabase → données non-sensibles + cotations chiffrées côté champ
N8N (Render) → traitement IA stateless — ne stocke aucune donnée de santé brute
```

---

## Architecture N8N v8 — Agent IA AMI

> Workflow : `AI Agent AMI` · ID `f13PXDr0OAbRTqky` · versionId `b41bf0a6-7e53-4d8e-9c18-638c3b528ff0`  
> Instance : `https://n8n-6fyl.onrender.com` · Statut : **active** · 32 nœuds

### Pipeline principal — flux `/ami-calcul`

```
[POST /ami-calcul]  ← Webhook
        │
        ▼
[1] NLP Médical v6+v7
    Extraction actes (regex médicale), contexte, distance km
    + preuve_soin : type / timestamp / hash / geo_zone / force_probante
        │
        ▼
[2] RAG NGAP Retriever v7
    Base documentaire NGAP 2026 — retrieval BM25
    Injecte rulesetHash + rulesetVersion dans le contexte IA
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
    Ajout automatique MCI / IFD / IK / MIE si critères présents et codes absents
        │
        ▼
[7] Validateur NGAP V2
    Second passage post-optimisation (règles identiques V1)
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
[16] Sauvegarder en BDD v8  ←────────────────── NOUVEAU v8
     INSERT cotations avec invoice_number
     RETURNING id, invoice_number, created_at
     │
     ▼
[17] Fusionner réponse v11  ←───────────────────────────────┘
     Assemble réponse finale
     Expose db_invoice_number ← NOUVEAU v8
     │
     ▼
[18] Respond to Webhook → réponse JSON au worker
```

### Flux secondaires

| Webhook | Méthode | Chemin | Description |
|---|---|---|---|
| Webhook Historique | GET | `/ami-historique` | Cotations par `user_id` + `limit`, order DESC |
| Webhook Supprimer | POST | `/ami-supprimer` | Suppression par `id` (delete_one) ou `patient_id` |
| Créer table si absente | — | Manuel | DDL idempotent + ALTER TABLE colonnes additionnelles |

---

### Nœuds N8N v8 — détail complet

| # | Nœud | Version | Rôle |
|---|---|---|---|
| 1 | **NLP Médical** | v6+v7 | Regex médicale, hash djb2, extraction `preuve_soin` depuis le body |
| 2 | **RAG NGAP Retriever** | v7 | BM25 sur référentiel NGAP 2026, `rulesetHash` + `rulesetVersion` |
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
| 18 | **Sauvegarder en BDD** | **v8** | INSERT + `invoice_number`, RETURNING `id, invoice_number, created_at` |
| 19 | **Fusionner réponse** | v11 | Réponse finale + `db_invoice_number` |
| 20 | **Respond to Webhook** | — | JSON → worker |
| 21 | **Webhook Historique** | — | GET `/ami-historique` |
| 22 | **Requête historique** | — | SELECT cotations par `user_id` LIMIT 50 |
| 23 | **Préparer historique** | — | Filtre rows valides → `{ok, data[], count}` |
| 24 | **Retourner historique** | — | JSON historique |
| 25 | **Webhook Supprimer** | — | POST `/ami-supprimer` |
| 26 | **Supprimer** | — | Détermine `_delete_one` |
| 27 | **IF delete_one?** | — | Branche DELETE by ID / by Patient |
| 28 | **Delete by ID** | — | `DELETE WHERE id=X AND user_id=Y` |
| 29 | **Delete by Patient** | — | `DELETE WHERE texte_soin ILIKE patient_id` |
| 30 | **Répondre suppression** | — | `{ok: true, deleted: true, id}` |
| 31 | **Créer table si absente** | — | DDL idempotent `cotations` + ALTER TABLE |

---

### Schéma base de données — table `cotations`

```sql
CREATE TABLE IF NOT EXISTS cotations (
  id                SERIAL PRIMARY KEY,
  user_id           TEXT,
  infirmiere        TEXT,
  texte_soin        TEXT,
  actes             TEXT,            -- JSON stringify
  total             NUMERIC(10,2),
  amo               NUMERIC(10,2),
  amc               NUMERIC(10,2),
  amo_amount        NUMERIC(10,2),
  amc_amount        NUMERIC(10,2),
  part_patient      NUMERIC(10,2),
  dre_requise       BOOLEAN DEFAULT false,
  date_soin         DATE,
  heure_soin        TEXT,
  prescripteur_nom  TEXT,
  prescripteur_rpps TEXT,
  date_prescription DATE,
  prescripteur_id   TEXT,
  exo               TEXT,
  regl              TEXT,
  adeli             TEXT,
  rpps_infirmiere   TEXT,
  structure         TEXT,
  ddn               TEXT,
  amo_num           TEXT,
  amc_num           TEXT,
  alerts            TEXT,            -- JSON stringify
  optimisations     TEXT,            -- JSON stringify
  ngap_version      TEXT DEFAULT '2026.1',
  invoice_number    TEXT,            -- ← ajouté v8 (lien facture ↔ Supabase)
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
```

---

### Réponse finale — champs renvoyés au worker

```json
{
  "ok": true,
  "actes": [
    { "code": "AMI1", "nom": "Injection SC/IM", "coefficient": 1, "total": 3.15 },
    { "code": "IFD",  "nom": "Forfait déplacement", "coefficient": 1, "total": 2.75 }
  ],
  "total": 15.05,
  "amo_amount": 9.03,
  "amc_amount": 0,
  "part_amo": 9.03,
  "part_amc": 0,
  "part_patient": 6.02,
  "taux_amo": 0.6,
  "dre_requise": false,
  "horaire_type": "jour",
  "alerts": [],
  "optimisations": ["💰 IFD ajoutée (+2,75 €)"],
  "suggestions_optimisation": [
    { "gain": "+5,00€", "reason": "MCI applicable si coordination", "action": "Ajouter MCI" }
  ],
  "justification": { "dependance": false, "domicile": true, "timestamp": "..." },
  "preuve_soin": { "type": "auto_declaration", "force_probante": "STANDARD", "certifie_ide": true },
  "fraud": { "score": 0, "level": "LOW", "flags": [] },
  "cpam_simulation": { "niveau": "OK", "decision": "ACCEPTÉ", "anomalies": [] },
  "infirmiere_scoring": { "score": 0, "level": "SAFE", "metrics": { "preuve_strength": "STANDARD" } },
  "patient_pattern": { "repetition_score": 0, "flags": [], "analysed": false },
  "fse": { "version": "FSE-1.40", "preuve_soin": { "type": "auto_declaration", ... } },
  "scor_ready": true,
  "audit": { "version": "NGAP_2026.1", "engine": "SAFE_MODE_V7_FINAL", "validated": true },
  "ngap_version": "2026.1",
  "cotation_id": 42,
  "saved_at": "2026-04-17T10:23:00Z",
  "db_invoice_number": "F2026-ABC123-000042"
}
```

---

### Tarifs NGAP 2026 officiels (Recalcul NGAP Officiel)

| Code | Libellé | Tarif | Règle coefficient |
|---|---|---|---|
| AMI | Acte infirmier de soins | 3,15 € × coeff | Principal ×1, secondaire ×0,5 |
| AIS | Aide infirmier soins | 2,65 € × coeff | Principal ×1, secondaire ×0,5 |
| BSA | Bilan soins — dépendance légère | 13,00 € | Forfait fixe |
| BSB | Bilan soins — dépendance modérée | 18,20 € | Forfait fixe |
| BSC | Bilan soins — dépendance lourde | 28,70 € | Forfait fixe |
| IFD | Indemnité forfaitaire déplacement | 2,75 € | Fixe |
| IK | Indemnité kilométrique | km × 2 × 0,35 € | Fixe (aller-retour) |
| MCI | Majoration coordination | 5,00 € | Fixe |
| MIE | Majoration enfant < 7 ans | 3,15 € | Fixe |
| NUIT | Majoration nuit (20h–23h / 5h–8h) | 9,15 € | Fixe |
| NUIT_PROF | Majoration nuit profonde (23h–5h) | 18,30 € | Fixe |
| DIM | Majoration dimanche/férié | 8,50 € | Fixe |

**Cumuls interdits :**
- AIS + BSx → AIS supprimé
- Plusieurs BSx → seul le plus élevé conservé
- NUIT + DIM → DIM supprimé
- NUIT_PROF + DIM → DIM supprimé
- IFD multiple → réduit à 1

---

### Système preuve soin (v7/v8)

| Type | Force probante | Impact score fraude | Impact simulation CPAM |
|---|---|---|---|
| `auto_declaration` | STANDARD | neutre | Accepté |
| `signature_patient` | FORTE | −3 pts | Supprime 1 anomalie |
| `photo` (hash uniquement) | FORTE | −3 pts | Supprime 1 anomalie |
| Absent | ABSENTE | +3 pts | Anomalie ajoutée |

> Photo et signature ne sont **jamais transmises** — uniquement leur hash djb2. Géolocalisation floue (département — RGPD compatible).

---

### Détecteur de fraude — règles de scoring

| Règle | Points |
|---|---|
| AMI multiples identiques (≥ 3 actes, < 2 libellés distincts) | +3 |
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
| Flag patient pattern ⚠️ | +2 par flag |
| Dépendance statique sur historique | +3 |
| Incohérence pathologie/fréquence | +2 |
| Preuve terrain ABSENTE | +3 |
| Preuve STANDARD + montant > 20 € | +1 |
| **Preuve FORTE** | **−3** |

**Niveaux :** LOW (0–3) · MEDIUM (4–7) · HIGH (≥ 8)  
**Blocage FSE :** fraud=HIGH ou (MEDIUM + CPAM CRITIQUE)

---

## Checklist RGPD / HDS

### A. Gouvernance
- ✅ Registre des traitements — ✅ Responsable de traitement défini — ✅ DPO si applicable

### B. Sécurité
- ✅ HTTPS partout (Cloudflare Worker + GitHub Pages)
- ✅ Chiffrement AES-256-GCM — backend : `crypto.createCipheriv('aes-256-gcm', key, iv)`
- ✅ Mots de passe hashés bcrypt (Supabase Auth)
- ✅ JWT sécurisé avec vérification de session — ✅ Firewall VPS / WAF Cloudflare

### C. Données de santé
- ✅ Accès restreint par rôle et `infirmiere_id`
- ✅ Logs d'accès (`audit_logs` + `system_logs`)
- ✅ Chiffrement de champ (`encryptField` / `decryptField`)
- ✅ Anonymisation admin (`anonymizePatient()`, `sanitizeForAdmin()`)

### D. Accès utilisateur
- ✅ Auth forte (JWT + PIN local) — ✅ Sessions `getSession()`
- ✅ Déconnexion auto + verrouillage PIN — ✅ Permissions granulaires `PERMISSIONS`

### E–F. Données & Stockage
- ✅ Minimisation — ✅ Anonymisation partielle admins — ✅ Séparation infirmière/admin
- ✅ Patients IndexedDB `ami_patients_db_<userId>` chiffré — ✅ Signatures `ami_sig_db_<userId>`
- ✅ Backup sync PC ↔ mobile — ✅ Purge auto vieux logs

### G. Droits utilisateurs
- ✅ Export (`exportPatientData()`, `exportMyData()`, `exportComptable()`)
- ✅ Suppression compte — ✅ Modification profil

### H. Consentement
- ✅ CGU + politique RGPD — ✅ Consentement explicite (`checkConsent()`)
- ✅ Révocation (`revokeConsent()`) — ✅ Traçabilité (`hasConsent()`)

### I. Audit & logs
- ✅ `audit_logs` (`auditLocal()`) — ✅ `system_logs` (`writeSystemLog()`)
- ✅ Anti-fraude (`fraudeScore()`, `watchFraudScore()`) — ✅ Score qualité IA

### J. Incident
- ✅ Plan de réponse — ✅ Notification CNIL < 72h — ✅ Alertes fraude (`reportFraudAlert()`)

---

## Architecture des fichiers

### Backend & PWA

| Fichier | Rôle |
|---|---|
| `worker.js` | Cloudflare Worker v6.1 — routes API, auth, isolation, proxy N8N v8, normalisation codes AMI/AIS, logs |
| `sw.js` | Service Worker PWA v3.6 — cache statique, tiles, offline |

### Auth & Sécurité

| Fichier | Rôle |
|---|---|
| `auth.js` | Login / register / logout, session, navigation par rôle, menu mobile admin |
| `security.js` | AES-256-GCM (Web Crypto), PIN local, RGPD, export/purge, audit logs, fraude |

### UI & Navigation

| Fichier | Rôle |
|---|---|
| `ui.js` | `navTo()`, `loadFaqGuide()` (charge `GUIDE_INFIRMIERES.md`), `filterFaq()` |
| `navigation.js` | GPS patients — coordonnées directes ou adresse texte |
| `utils.js` | Store `APP`, helpers, `apiFetch`, `apiCall` |

### Patients & Données de santé

| Fichier | Rôle |
|---|---|
| `patients.js` | IndexedDB `ami_patients_db_<userId>` — CRUD, cotations, ordonnances |
| `patient-form.js` | Formulaire patient — adresse structurée, géocodage |
| `notes.js` | Notes patient (Général / Accès / Médical / Urgent) |
| `signature.js` | Signatures canvas — `ami_sig_db_<userId>`, liste admin masquée |

### Cotation & Finances

| Fichier | Rôle |
|---|---|
| `cotation.js` | Cotation v7/v8 — payload `preuve_soin`, rendu `fraud`/`cpam_simulation`/`suggestions_optimisation`, upsert IDB |
| `tresorerie.js` | Trésorerie — paiements, remboursements, export CSV |
| `offline-queue.js` | File attente hors-ligne — sync auto |

### Tournée & Cartographie

| Fichier | Rôle |
|---|---|
| `tournee.js` | Tournée IA + import ICS/CSV — planning, pilotage live |
| `ai-tournee.js` | Moteur TSP, OSRM, lookahead, heuristique trafic |
| `ai-layer.js` | Couche IA silencieuse — habitScore/geoScore |
| `uber.js` | Mode Uber Médical |
| `extras.js` | Carte départ, OSRM, scoring fraude front |
| `map.js` | Leaflet — tap/drag, reverse geocoding |
| `geocode.js` | Pipeline Photon → Nominatim → cache IndexedDB |

### IA & Copilote

| Fichier | Rôle |
|---|---|
| `copilote.js` | Chat Copilote NGAP |
| `ai-assistant.js` | Assistant vocal NLP, commandes, TTS |
| `voice.js` | Dictée médicale vocale |

### Rapports & Administration

| Fichier | Rôle |
|---|---|
| `rapport.js` | Rapport mensuel PDF, santé N8N/IA |
| `dashboard.js` | Dashboard, cache userId, anomalies, prévisions |
| `admin.js` | Panneau admin — infirmières uniquement, stats globales |
| `contact.js` | Messagerie infirmière → admin |

### Profil & PWA

| Fichier | Rôle |
|---|---|
| `profil.js` | Profil, mot de passe, suppression compte |
| `pwa.js` | Install, offline, sync, tiles |
| `onboarding.js` | Onboarding premier lancement |
| `infirmiere-tools.js` | Simulateur charges, journal km, modèles soins, majorations, ordonnances |

### Documentation (à la racine du repo)

| Fichier | Rôle |
|---|---|
| `README.md` | Documentation technique architecture (ce fichier) |
| `GUIDE_INFIRMIERES.md` | Guide pratique & FAQ — chargé dynamiquement dans la vue Aide via `loadFaqGuide()` |

---

## Routes API (Cloudflare Worker)

### Authentification & Profil
| Route | Méthode | Permissions |
|---|---|---|
| `/webhook/auth-login` | POST | Public |
| `/webhook/infirmiere-register` | POST | Public |
| `/webhook/change-password` | POST | Auth |
| `/webhook/delete-account` | POST | Auth |
| `/webhook/profil-get` | POST | Auth |
| `/webhook/profil-save` | POST | Auth |

### Patients
| Route | Méthode | Permissions |
|---|---|---|
| `/webhook/patients-push` | POST | Auth |
| `/webhook/patients-pull` | GET | Auth |

### Cotation NGAP (proxy → N8N v8)
| Route | Méthode | Cible N8N | Rôle |
|---|---|---|---|
| `/webhook/ami-calcul` | POST | `POST /ami-calcul` | Pipeline 15 nœuds — réponse v8 avec `db_invoice_number` |
| `/webhook/ami-historique` | GET | Supabase direct | Historique cotations par `user_id` |
| `/webhook/ami-supprimer` | POST | `POST /ami-supprimer` | Suppression par ID ou patient_id |
| `/webhook/ami-supprimer-tout` | POST | — | Suppression groupée |
| `/webhook/ami-save-cotation` | POST | — | Sauvegarde cotation depuis tournée live |

### Tournée & IA
| Route | Méthode | Rôle |
|---|---|---|
| `/webhook/ami-tournee-ia` | POST | Optimisation tournée |
| `/webhook/ami-live` | POST | Pilotage live |
| `/webhook/ami-copilot` | POST | Copilote NGAP (Grok-3-mini + fallback statique) |
| `/webhook/ami-week-analytics` | POST | Analyse hebdomadaire |

### Admin & Monitoring
| Route | Méthode | Rôle |
|---|---|---|
| `/webhook/admin-stats` | GET | Stats globales — infirmières uniquement, codes NGAP validés |
| `/webhook/admin-users` | GET | Liste utilisateurs (rôle infirmière seulement) |
| `/webhook/admin-action` | POST | Bloquer / débloquer / supprimer |
| `/webhook/admin-message` | POST | Messagerie admin → infirmière |
| `/webhook/log` | POST | Log frontend → `system_logs` |
| `/webhook/system-logs` | GET | Consultation logs + stats N8N (admin) |

---

## Matrice des permissions

```javascript
// worker.js — PERMISSIONS
nurse:  ['create_invoice', 'view_own_data', 'import_calendar',
         'manage_tournee', 'manage_prescripteurs',
         'change_password', 'delete_account']

admin:  ['view_users_list', 'view_stats', 'manage_tournee',
         'change_password', 'delete_account']
// Les admins NE voient PAS les données infirmières — uniquement leurs propres données de test
// Les admins sont INVISIBLES dans le panneau d'administration (seules les infirmières y apparaissent)
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

## Outils professionnels (infirmiere-tools.js)

| Outil | Fonctionnalité |
|---|---|
| Charges & net réel | Simulateur annuel URSSAF + CARPIMKO + IR — barème 2026 |
| Journal kilométrique | Saisie trajets, barème IK par CV (3→7+), véhicule électrique, export CSV |
| Modèles de soins | Bibliothèque CRUD de descriptions pré-remplies, cotation 1 clic |
| Simulateur majorations | Calcul instantané AMI/AIS/BSx + IFD/IK/MIE/MCI selon heure/jour |
| Suivi ordonnances | Enregistrement, alertes expiration 30j, lien carnet patient |
