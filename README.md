# AMI NGAP — Documentation Architecture

> Application web progressive (PWA) pour infirmières libérales.  
> Gestion de tournée, cotation NGAP, carnet patients chiffré, signatures électroniques, copilote IA.

---

## ⚠️ Points de vigilance N8N v7 (audit 17 avril 2026)

### ✅ Routes alignées frontend ↔ N8N v7
| Route N8N | Méthode | Frontend | Statut |
|---|---|---|---|
| `/webhook/ami-calcul` | POST | `cotation.js`, `tournee.js`, `extras.js`, `offline-queue.js` | ✅ OK |
| `/webhook/ami-historique` | GET | `dashboard.js`, `rapport.js`, `tresorerie.js`, `offline-queue.js` | ✅ OK (bypassed Supabase direct) |
| `/webhook/ami-supprimer` | POST | `worker.js` route interne | ✅ OK |

### ⚠️ Nouveau champ v7 — `preuve_soin` non encore envoyé
Le workflow N8N v7 introduit un champ `preuve_soin` (type, timestamp, hash, force_probante).  
**Actuellement `cotation.js` ne l'envoie pas** → N8N utilise le défaut `auto_declaration` (force_probante: STANDARD).  
À intégrer dans `cotation.js` payload pour activer le bouclier anti-redressement CPAM complet.

```javascript
// À ajouter dans cotation.js — payload apiCall('/webhook/ami-calcul', {...})
preuve_soin: {
  type: 'auto_declaration',       // ou 'signature_patient' / 'photo'
  timestamp: new Date().toISOString(),
  certifie_ide: true,
  geo_zone: 'Finistère-29'        // département uniquement — jamais coordonnées précises
}
```

### ℹ️ `invoice_number` absent de l'INSERT N8N
Le nœud **"Sauvegarder en BDD"** dans N8N n'insère pas `invoice_number` dans la table `cotations`.  
Ce champ est géré côté **worker.js via Supabase** (`planning_patients`). Les deux bases restent cohérentes — pas de bug, mais la table N8N ne permet pas de lier une cotation à son numéro de facture. À corriger si un accès direct à la table `cotations` N8N est prévu.

### ✅ Règles cotation() — logique upsert validée
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
N8N (Render) → traitement IA stateless — ne stocke aucune donnée patient
```

---

## Architecture N8N v7 — Agent IA AMI

> Workflow ID : `f13PXDr0OAbRTqky` · Instance : `https://n8n-6fyl.onrender.com`  
> Tag : `AMI NGAP` + `Admin` · Statut : `active`

### Vue d'ensemble du pipeline (flux principal)

```
[Webhook POST /ami-calcul]
        ↓
[NLP Médical v6]          ← extraction actes, contexte, distance km
        ↓                    + nouveau v7 : extraction preuve_soin
[RAG NGAP Retriever]      ← base documentaire NGAP BM25
        ↓
[AI Agent — xAI Grok]     ← raisonnement NGAP + historique patient
        ↓
[Parser résultat IA]      ← normalisation JSON, détection hallucinations
        ↓
[Validateur NGAP V1]      ← règles d'exclusion (AIS+BSI, IFD unique, etc.)
        ↓
[Optimisateur €]          ← ajout MCI / IFD / IK / MIE manquants
        ↓
[Validateur NGAP V2]      ← second passage validation post-optimisation
        ↓
[Recalcul NGAP Officiel]  ← tarifs 2026 officiels, source de vérité
        ↓
[Analyse Pattern Patient] ← historique répétitif, évolution dépendance
        ↓
[Suggestions alternatives]← gains potentiels, preuve soin
        ↓
[Fraude Detector v7]      ← score 0-N, preuve soin intégrée
        ↓
[CPAM Simulator v5]       ← simulation contrôle, défense preuve forte
        ↓
[Scoring Infirmière v4]   ← score global IDE, metrics historique
        ↓
[Blocage FSE si HIGH]     ← bloque si fraude=HIGH ou MEDIUM+CRITIQUE
        ↓
[FSE Generator v6]        ← génération FSE-1.40, justification horodatée
        ↓
[Mode spécial ?]──────────→ [Sauvegarder en BDD] ← INSERT PostgreSQL
        ↓                                                    ↓
[Fusionner réponse]←─────────────────────────────────────────
        ↓
[Respond to Webhook]      ← réponse JSON finale au worker
```

### Flux secondaires

| Webhook | Méthode | Chemin | Description |
|---|---|---|---|
| Webhook Historique | GET | `/ami-historique` | Requête cotations par `user_id` + `limit` |
| Webhook Supprimer | POST | `/ami-supprimer` | Suppression par `id` (delete_one) ou `patient_id` |
| Créer table si absente | — | Déclenché manuellement | Migration DDL PostgreSQL |

### Nœuds N8N — détail

| Nœud | Type | Rôle |
|---|---|---|
| **NLP Médical v6** | Code | Extraction actes/contexte par regex médicale, hash texte, preuve_soin v7 |
| **RAG NGAP Retriever** | Code | Retrieval BM25 sur base NGAP 2026 pour enrichir le prompt IA |
| **AI Agent** | LangChain Agent | Grok-3 (xAI) — raisonnement NGAP avec historique patient |
| **Parser résultat IA** | Code | Parse JSON Grok, détection hallucinations, normalisation `normalizeAI()` |
| **Validateur NGAP V1** | Code | AIS+BSI exclusion, IFD unique, nuit+dimanche interdit, IK sans distance |
| **Optimisateur €** | Code | Ajout automatique MCI/IFD/IK/MIE si critères présents et absents |
| **Validateur NGAP V2** | Code | Second passage identique V1 post-optimisation |
| **Recalcul NGAP Officiel** | Code | Tarifs 2026 officiels (AMI=3.15€, BSA=13€, BSB=18.20€, BSC=28.70€…) |
| **Analyse Pattern Patient** | Code | Répétition ≥7j, dépendance statique, incohérence pathologie |
| **Suggestions alternatives** | Code | Gains € non réalisés, conseils preuve soin |
| **Fraude Detector v7** | Code | Score multicritères — **nouveau v7** : preuve absente +3pts, preuve forte -3pts |
| **CPAM Simulator v5** | Code | Simulation contrôle CPAM — **nouveau v7** : preuve forte supprime 1 anomalie |
| **Scoring Infirmière v4** | Code | Score global IDE — **nouveau v7** : preuve impacte score |
| **Blocage FSE si HIGH** | Code | Bloque si fraud=HIGH ou (MEDIUM + CPAM=CRITIQUE) |
| **FSE Generator v6** | Code | FSE-1.40, justification médicale horodatée, **nouveau v7** : preuve_soin dans FSE |
| **Mode spécial ?** | IF | Bypass DB si `_mode ≠ ngap` ou `_skip_db=true` ou `blocked=true` |
| **Sauvegarder en BDD** | PostgreSQL | INSERT dans `cotations` (table Supabase via Postgres direct) |
| **Fusionner réponse** | Code | Assemblage réponse finale normalisée |

### Tarifs NGAP 2026 (intégrés dans le nœud "Recalcul NGAP Officiel")

| Code | Libellé | Tarif |
|---|---|---|
| AMI | Acte infirmier de soins | 3,15 € × coefficient |
| AIS | Aide infirmier soins | 2,65 € |
| BSA | Bilan soins infirmiers A (dépendance légère) | 13,00 € |
| BSB | Bilan soins infirmiers B (dépendance intermédiaire) | 18,20 € |
| BSC | Bilan soins infirmiers C (dépendance lourde) | 28,70 € |
| IFD | Indemnité forfaitaire déplacement | 2,75 € |
| MCI | Majoration coordination infirmière | 5,00 € |
| MIE | Majoration enfant (< 7 ans) | 3,15 € |
| NUIT | Majoration nuit (20h–23h, 5h–7h) | 9,15 € |
| NUIT_PROF | Majoration nuit profonde (23h–5h) | 18,30 € |
| DIM | Majoration dimanche/férié | 8,50 € |
| IK | Indemnité kilométrique | dist_km × 2 × 0,35 € |

### Règles CPAM intégrées (Validateurs V1 + V2)
- **AIS + BSI** → AIS supprimé (incompatibles)
- **Plusieurs BSI** → seul le plus élevé conservé
- **IFD multiple** → réduit à 1 par séance
- **Nuit + Dimanche** → Dimanche supprimé
- **IK sans distance** → IK exclue
- **Coefficient demi-tarif** → tous les actes techniques après le principal à 0,5 (sauf majorations)

### Système de preuve soin (nouveau v7)

| Type | Force probante | Impact fraude | Impact CPAM |
|---|---|---|---|
| `auto_declaration` | STANDARD | neutre | Accepté |
| `signature_patient` | FORTE | -3 pts fraude | Supprime 1 anomalie |
| `photo` (hash uniquement) | FORTE | -3 pts fraude | Supprime 1 anomalie |
| Absent | ABSENTE | +3 pts fraude | Anomalie ajoutée |

> **Vie privée** : seul le hash de la preuve est transmis, jamais la photo ou la signature brute.

---

## Checklist RGPD / HDS

### A. Gouvernance
- ✅ Registre des traitements
- ✅ Responsable de traitement défini
- ✅ DPO si applicable

### B. Sécurité
- ✅ HTTPS partout (Cloudflare Worker + GitHub Pages)
- ✅ Chiffrement données AES-256-GCM (`security.js` + `worker.js`)  
  → Côté backend : `crypto.createCipheriv('aes-256-gcm', key, iv)`
- ✅ Mots de passe hashés bcrypt (côté Supabase Auth)
- ✅ JWT sécurisé avec vérification de session
- ✅ Firewall VPS / WAF Cloudflare

### C. Données de santé
- ✅ Accès restreint par rôle et par `infirmiere_id`
- ✅ Logs d'accès (`audit_logs` + `system_logs`)
- ✅ Chiffrement de champ sur les données sensibles (`encryptField` / `decryptField`)
- ✅ Anonymisation pour la vue admin (`anonymizePatient()`, `toAdminView()`, `sanitizeForAdmin()`)

### D. Accès utilisateur
- ✅ Authentification forte (JWT + PIN local)
- ✅ Gestion de sessions avec `getSession()`
- ✅ Déconnexion automatique + verrouillage par PIN (`lockApp()` / `unlockApp()`)
- ✅ Système de permissions granulaires (`PERMISSIONS` dans `worker.js`)

### E. Données
- ✅ Minimisation : seules les données nécessaires sont transmises
- ✅ Anonymisation partielle pour les admins (`sanitizeForAdmin()`)
- ✅ Séparation logique infirmière / admin

### F. Stockage
- ✅ Données patients chiffrées localement (IndexedDB, `patients.js`)
- ✅ Signatures électroniques chiffrées localement (`signature.js`)
- ✅ Backups via sync PC ↔ mobile (`patients-push` / `patients-pull`)
- ✅ Purge automatique des vieux logs (`cleanOldLogs()`)

### G. Droits utilisateurs
- ✅ Export données (`exportPatientData()`, `exportMyData()`, `exportComptable()`)
- ✅ Suppression compte (`/webhook/delete-account`)
- ✅ Modification profil (`/webhook/profil-save`)

### H. Consentement
- ✅ CGU + politique RGPD
- ✅ Consentement explicite au premier lancement (`checkConsent()`)
- ✅ Révocation du consentement (`revokeConsent()`)
- ✅ Traçabilité (`hasConsent()`)

### I. Audit & logs
- ✅ Logs d'accès dans `audit_logs` (`auditLocal()`)
- ✅ Logs système dans `system_logs` (`writeSystemLog()`)
- ✅ Surveillance anti-fraude (`fraudeScore()`, `watchFraudScore()`)
- ✅ Score qualité IA (`scoreAIQuality()`)

### J. Incident
- ✅ Plan de réponse incidents
- ✅ Notification CNIL < 72h (procédure documentée)
- ✅ Alertes fraude automatiques (`reportFraudAlert()`)

---

## Architecture des fichiers

### Backend

| Fichier | Rôle |
|---|---|
| `worker.js` | Cloudflare Worker v6.1 — toutes les routes API, auth, isolation des données, chiffrement côté serveur, proxy N8N, logs |
| `sw.js` | Service Worker PWA v3.6 — cache statique, stratégie tiles, offline |

### Authentification & Sécurité

| Fichier | Rôle |
|---|---|
| `auth.js` | Login / register / logout, gestion de session, navigation par rôle, injection dynamique du menu mobile admin |
| `security.js` | Chiffrement AES-256-GCM (Web Crypto), PIN local, consentement RGPD, export/purge données, audit logs, détection fraude |

### Navigation & UI

| Fichier | Rôle |
|---|---|
| `ui.js` | Orchestrateur UI — `navTo()`, navigation mobile/desktop, menu mobile, FAQ |
| `navigation.js` | Navigation GPS vers les patients — stratégie GPS direct ou adresse texte |
| `utils.js` | Store global `APP`, helpers (`debounce`, `throttle`, `sanitize`), `apiFetch`, `wpost`, `apiCall` |

### Patients & Données de santé

| Fichier | Rôle |
|---|---|
| `patients.js` | Carnet patients chiffré AES-256 (IndexedDB local, par user `ami_patients_db_<userId>`) — CRUD, notes soins, cotations patient, ordonnances, export |
| `patient-form.js` | Formulaire nouveau/édition patient — adresse structurée, suggestions CP/ville, géocodage, sauvegarde |
| `notes.js` | Notes par patient (général / accès / médical / urgent) — CRUD avec confirmation |
| `signature.js` | Signatures électroniques — canvas tactile/souris/stylet, stockage chiffré local (`ami_sig_db_<userId>`), liste admin masquée |

### Cotation & Finances

| Fichier | Rôle |
|---|---|
| `cotation.js` | Cotation NGAP — appel `/webhook/ami-calcul`, rendu résultat, vérification IA, impression facture, modale infos pro, logique upsert |
| `tresorerie.js` | Suivi trésorerie — statut paiements, statistiques remboursements, export comptable, checklist CPAM |
| `offline-queue.js` | File d'attente cotations hors-ligne — sync automatique au retour en ligne, badge compteur |

### Tournée & Cartographie

| Fichier | Rôle |
|---|---|
| `tournee.js` | Tournée IA + import calendrier ICS/CSV — planning, pilotage live, auto-facturation, rentabilité |
| `ai-tournee.js` | Moteur IA de tournée v5 — optimisation TSP, OSRM, lookahead, tournée live, ajout/annulation urgent |
| `ai-layer.js` | Couche IA silencieuse — enrichissement habitScore/geoScore, clustering, warnings tournée |
| `uber.js` | Mode Uber Médical — sélection dynamique patient suivant, tracking GPS temps réel |
| `extras.js` | Carte départ, point de départ OSRM, tracé route, score fraude front, optimisation CA |
| `map.js` | Carte Leaflet — correction position tap/drag, reverse geocoding, marqueur départ |
| `geocode.js` | Pipeline géocodage multi-source (Photon → Nominatim → cache IndexedDB) — corrections apprises |

### IA & Copilote

| Fichier | Rôle |
|---|---|
| `copilote.js` | Interface chat Copilote IA — historique, suggestions, contexte patient, mode plein écran |
| `ai-assistant.js` | Assistant vocal IA — NLP embarqué, détection d'intention, commandes vocales, mode mains-libres, TTS |
| `voice.js` | Dictée médicale vocale — normalisation texte médical, toggle, cache dashboard |

### Rapports & Administration

| Fichier | Rôle |
|---|---|
| `rapport.js` | Rapport mensuel PDF — génération HTML, prévisualisation, santé système N8N/IA, nomenclature NGAP |
| `dashboard.js` | Dashboard & statistiques — cache par userId, détection anomalies, IA explicative, prévisions revenus, pertes estimées |
| `admin.js` | Panneau administration — liste comptes infirmières uniquement (admins invisibles), stats globales, logs, actions, messagerie |
| `contact.js` | Messagerie infirmière → admin — envoi message, consultation historique |

### Profil & PWA

| Fichier | Rôle |
|---|---|
| `profil.js` | Modale profil — modification infos, changement mot de passe, suppression compte |
| `pwa.js` | PWA — install prompt, banner offline, sync patients hors-ligne, téléchargement tiles carte, estimation route offline |
| `onboarding.js` | Onboarding premier lancement — intro tournée, guide interactif étapes, modal intro VRPTW |

### Outils professionnels

| Fichier | Rôle |
|---|---|
| `infirmiere-tools.js` | Outils IDEL — simulateur charges/net réel, journal kilométrique (CEREMA barème), modèles de soins, simulateur majorations, suivi ordonnances & renouvellements |

---

## Routes API (Cloudflare Worker)

### Authentification
| Route | Méthode | Rôle | Permissions |
|---|---|---|---|
| `/webhook/auth-login` | POST | Connexion, retourne JWT + rôle | Public |
| `/webhook/infirmiere-register` | POST | Inscription infirmière | Public |
| `/webhook/change-password` | POST | Changement mot de passe | `change_password` |
| `/webhook/delete-account` | POST | Suppression compte | `delete_account` |

### Profil
| Route | Méthode | Rôle | Permissions |
|---|---|---|---|
| `/webhook/profil-get` | POST | Récupération profil | Auth |
| `/webhook/profil-save` | POST | Mise à jour profil | Auth |

### Patients
| Route | Méthode | Rôle | Permissions |
|---|---|---|---|
| `/webhook/patients-push` | POST | Backup patients chiffrés → serveur | Auth |
| `/webhook/patients-pull` | GET | Restauration patients depuis serveur | Auth |

### Cotation NGAP (proxy → N8N v7)
| Route | Méthode | Cible N8N | Rôle |
|---|---|---|---|
| `/webhook/ami-calcul` | POST | `POST /ami-calcul` | Cotation NGAP complète — pipeline IA 14 nœuds |
| `/webhook/ami-historique` | GET | Supabase direct (bypass N8N) | Historique cotations par user_id |
| `/webhook/ami-supprimer` | POST | `POST /ami-supprimer` | Suppression cotation par ID ou patient_id |
| `/webhook/ami-supprimer-tout` | POST | — | Suppression groupée (worker gère) |
| `/webhook/ami-save-cotation` | POST | — | Sauvegarde cotation depuis tournée live |

### Tournée & Pilotage
| Route | Méthode | Rôle |
|---|---|---|
| `/webhook/ami-tournee-ia` | POST | Optimisation tournée IA → retourne route ordonnée |
| `/webhook/ami-live` | POST | Actions pilotage live (recalcul, get_status, patient_done, etc.) |

### IA
| Route | Méthode | Rôle |
|---|---|---|
| `/webhook/ami-copilot` | POST | Copilote IA conversationnel (questions métier NGAP) |
| `/webhook/ami-week-analytics` | POST | Analyse hebdomadaire IA |

### Admin
| Route | Méthode | Rôle |
|---|---|---|
| `/webhook/admin-stats` | GET | Statistiques globales — infirmières uniquement, codes NGAP validés |
| `/webhook/admin-users` | GET | Liste utilisateurs (rôle=infirmière) |
| `/webhook/admin-action` | POST | Bloquer/débloquer/supprimer compte |
| `/webhook/admin-message` | POST | Messagerie admin → infirmière |

### Monitoring
| Route | Méthode | Rôle |
|---|---|---|
| `/webhook/log` | POST | Log frontend → `system_logs` |
| `/webhook/system-logs` | GET | Consultation logs + stats N8N (admin) |

---

## Matrice des permissions

```javascript
// worker.js — PERMISSIONS
nurse:  ['view_own_data', 'create_invoice', 'manage_tournee', 'import_calendar',
         'manage_prescripteurs', 'change_password', 'delete_account']

admin:  ['view_users_list', 'view_stats', 'manage_tournee',
         'change_password', 'delete_account']
```

---

## Stockage local — isolation multi-utilisateurs

| Données | Base | Clé | Chiffrement |
|---|---|---|---|
| Patients | IndexedDB `ami_patients_db_<userId>` | Par user — isolation stricte | AES-256 (clé JWT) |
| Signatures | IndexedDB `ami_sig_db_<userId>` | Par user — isolation stricte | AES-256 |
| Corrections GPS | IndexedDB `geocodeDB` | Partagé (données non-sensibles) | Non |
| Historique cotations | Supabase `planning_patients` | `infirmiere_id` | Chiffrement champ |
| Cache dashboard | localStorage `ami_dash_<userId>_*` | Par user | Non |
| Historique copilote | localStorage | Partagé session | Non |
| Logs audit | IndexedDB | Partagé local | Non (métadonnées) |

> **Règle fondamentale** : la fermeture de session ne supprime jamais les données d'une infirmière. Seule la connexion d'un autre compte ferme la connexion DB précédente (sans effacement).

---

## Flux cotation NGAP (avec N8N v7)

```
Saisie actes + texte libre (cotation.js)
    ↓ cotation() — résolution mode édition (_editRef)
    → /webhook/ami-calcul (worker.js)
        → vérifie JWT + fraude score front
        → ajoute invoice_number si nouveau
        → proxy → N8N /ami-calcul
            → NLP Médical (extraction actes + preuve_soin)
            → RAG NGAP + AI Agent Grok-3
            → Pipeline validation 14 nœuds
            → Fraude Detector v7 (preuve soin intégrée)
            → FSE Generator v6
            → Sauvegarder en BDD (PostgreSQL)
            → Réponse JSON normalisée
        ← worker valide / fallback si N8N KO
    ← résultat : actes, total, AMO/AMC, alerts, fraud, fse
    ↓
Résultat affiché → vérification IA optionnelle (openVerify)
    ↓
Impression facture → printInv()
    → displayInvoiceNumber() — numéro séquentiel par infirmière
    ↓
Signature électronique → openSignatureModal(invoiceId)
    → canvas → saveSignature() → IndexedDB chiffré local
    ↓
Si hors-ligne → queueCotation() → syncOfflineQueue() au retour en ligne
```

---

## Heuristique trafic temporelle

Intégrée dans `ai-tournee.js` — zéro API externe, fonctionne hors-ligne.

| Créneau | Jours | Coefficient | Label |
|---|---|---|---|
| 7h15–9h30 | Lun–Ven | ×1.65 | 🔴 Pointe matin |
| 11h45–14h15 | Lun–Ven | ×1.30 | 🟡 Déjeuner |
| 16h30–19h30 | Lun–Ven | ×1.75 | 🔴 Pointe soir |
| 19h30–21h | Lun–Ven | ×1.20 | 🟡 Après pointe |
| 9h30–12h30 | Sam | ×1.25 | 🟡 Sam. matin |
| Reste | Tous | ×1.0 | 🟢 Fluide |

---

## Outils professionnels (`infirmiere-tools.js`)

| Outil | Fonctionnalité |
|---|---|
| Charges & net réel | Simulateur annuel URSSAF + CARPIMKO + IR — barème 2026 |
| Journal kilométrique | Saisie trajets, barème IK par CV (3→7+), véhicule électrique, export CSV |
| Modèles de soins | Bibliothèque CRUD de descriptions pré-remplies, cotation 1 clic |
| Simulateur majorations | Calcul instantané AMI/AIS/BSx + IFD/IK/MIE/MCI selon heure/jour |
| Suivi ordonnances | Enregistrement, alertes expiration 30j, lien carnet patient |

---

## Versions

| Composant | Version | Notes |
|---|---|---|
| Worker backend | v6.1 | Proxy N8N sécurisé, retry 1×, fallback |
| Agent IA N8N | **v7** | Ajout preuve_soin, bouclier anti-redressement, 14 nœuds |
| Moteur tournée IA | v5.1 | Heuristique trafic CEREMA |
| Assistant vocal IA | v1.1 | WebLLM retiré — NLP embarqué |
| PWA / Service Worker | v3.6 | Cache offline, tiles carte |
| Sécurité RGPD | v2.0 | Isolation multi-users IndexedDB |
| Admin panel | v4.0 | Admins invisibles entre eux |

---

## Codes postaux — étendre la base

Le fichier `patient-form.js` contient `CP_DATA`. Base complète La Poste (gratuite) :  
https://datanova.laposte.fr/datasets/laposte-hexasmal
