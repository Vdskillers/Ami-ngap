# AMI NGAP — Documentation Architecture

> Application web progressive (PWA) pour infirmières libérales.  
> Gestion de tournée, cotation NGAP, carnet patients chiffré, signatures électroniques, copilote IA.

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
- Le panneau admin affiche les statistiques globales, noms et prénoms des infirmières uniquement (pas des admins)
- La vue Signatures en mode admin masque les `invoiceId` réels et désactive la suppression

### Architecture Privacy by Design

```
Données de santé → chiffrées AES-256 → stockage local (IndexedDB)
                                        jamais transmises aux serveurs

Serveur (Cloudflare Worker) → métadonnées & cotations uniquement
Supabase → données non-sensibles + cotations chiffrées côté champ
```

---

## Checklist RGPD / HDS

### A. Gouvernance
- ✅ Registre des traitements
- ✅ Responsable de traitement défini
- ✅ DPO si applicable

### B. Sécurité
- ✅ HTTPS partout (Cloudflare Worker + GitHub Pages)
- ✅ Chiffrement données AES-256-GCM (`security.js` + `worker.js`)
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
| `worker.js` | Cloudflare Worker v6.1 — toutes les routes API, auth, isolation des données, chiffrement côté serveur, logs |
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
| `patients.js` | Carnet patients chiffré AES-256 (IndexedDB local) — CRUD, notes soins, cotations patient, ordonnances, export |
| `patient-form.js` | Formulaire nouveau/édition patient — adresse structurée, suggestions CP/ville, géocodage, sauvegarde |
| `notes.js` | Notes par patient (général / accès / médical / urgent) — CRUD avec confirmation |
| `signature.js` | Signatures électroniques — canvas tactile/souris/stylet, stockage chiffré local, liste admin masquée |

### Cotation & Finances

| Fichier | Rôle |
|---|---|
| `cotation.js` | Cotation NGAP — appel API calcul, rendu résultat, vérification IA, impression facture, modale infos pro |
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
| `ai-assistant.js` | Assistant vocal IA — NLP embarqué (WebLLM supprimé), détection d'intention, commandes vocales, mode mains-libres, TTS |
| `voice.js` | Dictée médicale vocale — normalisation texte médical, toggle, cache dashboard |

### Rapports & Administration

| Fichier | Rôle |
|---|---|
| `rapport.js` | Rapport mensuel PDF — génération HTML, prévisualisation, santé système, nomenclature NGAP |
| `dashboard.js` | Dashboard & statistiques — cache, détection anomalies, IA explicative, prévisions revenus, pertes estimées |
| `admin.js` | Panneau administration — liste comptes infirmières, stats globales, logs, actions (bloquer/débloquer/supprimer), messagerie admin→infirmière |
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

### Styles

| Fichier | Rôle |
|---|---|
| `style.css` | Styles principaux de l'application |
| `notes.css` | Styles notes patient, formulaire adresse, suggestions CP |

---

## Routes API (Cloudflare Worker)

### Authentification
| Route | Rôle | Permissions |
|---|---|---|
| `POST /webhook/auth-login` | Connexion, retourne JWT + rôle | Public |
| `POST /webhook/infirmiere-register` | Inscription infirmière | Public |
| `POST /webhook/change-password` | Changement mot de passe | `change_password` |
| `POST /webhook/delete-account` | Suppression compte | `delete_account` |

### Profil
| Route | Rôle | Permissions |
|---|---|---|
| `POST /webhook/profil-get` | Récupération profil | Auth |
| `POST /webhook/profil-save` | Sauvegarde profil | Auth |

### Cotations & Historique
| Route | Rôle | Permissions |
|---|---|---|
| `POST /webhook/ami-calcul` | Calcul cotation NGAP via N8N (+ fallback) | `create_invoice` — infirmières uniquement |
| `POST /webhook/ami-historique` | Historique cotations de l'infirmière connectée | `view_own_data` |
| `POST /webhook/ami-supprimer` | Suppression cotation unitaire (`force:true` bypass verrou CPAM) | `view_own_data` — propres données uniquement |
| `POST /webhook/ami-supprimer-tout` | Suppression en masse par période (`force:true` requis) | `view_own_data` — propres données uniquement |
| `POST /webhook/ami-live` | Cotation en direct (mode live tournée) | Auth |

### Tournée & Calendrier
| Route | Rôle | Permissions |
|---|---|---|
| `POST /webhook/ami-tournee-ia` | Optimisation tournée IA — retourne route + alertes + adresses GPS | `manage_tournee` |
| `POST /webhook/import-calendar` | Import calendrier ICS/CSV avec géocodage | `import_calendar` — infirmières uniquement |

### Patients (sync)
| Route | Rôle | Permissions |
|---|---|---|
| `POST /webhook/patients-push` | Sync patients local → serveur (sauvegarde chiffrée) | Auth |
| `POST /webhook/patients-pull` | Sync patients serveur → local (restauration) | Auth |
| `POST /webhook/patients-delete` | Suppression patient | Auth |

### Prescripteurs
| Route | Rôle | Permissions |
|---|---|---|
| `POST /webhook/prescripteur-get` | Récupération liste prescripteurs | `manage_prescripteurs` — infirmières |
| `POST /webhook/prescripteur-liste` | Liste prescripteurs | `manage_prescripteurs` — infirmières |
| `POST /webhook/prescripteur-add` | Ajout prescripteur | `manage_prescripteurs` — infirmières |

### Messagerie
| Route | Rôle | Permissions |
|---|---|---|
| `POST /webhook/contact-send` | Infirmière → envoi message admin | Auth |
| `POST /webhook/contact-mes-messages` | Infirmière → consultation de ses messages | Auth |
| `POST /webhook/admin-messages` | Admin → lecture messages entrants | `view_users_list` |
| `POST /webhook/admin-message-read` | Admin → marquer message lu | `view_users_list` |
| `POST /webhook/admin-message-reply` | Admin → répondre à un message | `view_users_list` |

### Administration
| Route | Rôle | Permissions |
|---|---|---|
| `POST /webhook/admin-liste` | Liste des comptes infirmières (admins exclus) | `view_users_list` |
| `POST /webhook/admin-stats` | Statistiques globales tous utilisateurs | `view_stats` |
| `POST /webhook/admin-logs` | Logs audit + système | `view_stats` |
| `POST /webhook/admin-security-stats` | Statistiques sécurité (fraudes, anomalies) | `view_stats` |
| `POST /webhook/admin-bloquer` | Blocage d'un compte infirmière | `view_users_list` |
| `POST /webhook/admin-debloquer` | Déblocage d'un compte infirmière | `view_users_list` |
| `POST /webhook/admin-supprimer` | Suppression d'un compte infirmière | `view_users_list` |
| `POST /webhook/admin-system-reset` | Reset logs système | `view_stats` |

### IA & Analytics
| Route | Rôle | Permissions |
|---|---|---|
| `POST /webhook/ami-copilot` | Copilote IA conversationnel | Auth |
| `POST /webhook/ami-week-analytics` | Analyse hebdomadaire IA | Auth |

### Monitoring
| Route | Rôle | Permissions |
|---|---|---|
| `POST /webhook/log` | Log frontend → `system_logs` | Sans auth requise |

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

## Ordre d'inclusion dans le HTML

```html
<!-- Leaflet -->
<link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>

<!-- Styles -->
<link rel="stylesheet" href="style.css" />
<link rel="stylesheet" href="notes.css" />

<!-- Couche de base -->
<script src="utils.js"></script>         <!-- 1. Store APP + helpers -->
<script src="security.js"></script>      <!-- 2. Crypto + consentement + PIN -->

<!-- Auth & UI -->
<script src="auth.js"></script>          <!-- 3. Login / register / session -->
<script src="ui.js"></script>            <!-- 4. Navigation + layout -->

<!-- Patients & données santé -->
<script src="geocode.js"></script>       <!-- 5. Géocodage pipeline -->
<script src="patient-form.js"></script>  <!-- 6. Formulaire patient -->
<script src="patients.js"></script>      <!-- 7. CRUD patients chiffré -->
<script src="notes.js"></script>         <!-- 8. Notes par patient -->
<script src="signature.js"></script>     <!-- 9. Signatures électroniques -->

<!-- Cartographie -->
<script src="map.js"></script>           <!-- 10. Carte Leaflet + corrections -->
<script src="navigation.js"></script>    <!-- 11. GPS navigation -->

<!-- Tournée IA -->
<script src="ai-tournee.js"></script>    <!-- 12. Moteur optimisation tournée -->
<script src="ai-layer.js"></script>      <!-- 13. Couche IA silencieuse (APRÈS ai-tournee.js) -->
<script src="uber.js"></script>          <!-- 14. Mode Uber médical -->
<script src="extras.js"></script>        <!-- 15. Helpers carte départ + scoring -->
<script src="tournee.js"></script>       <!-- 16. Tournée UI + import calendrier -->

<!-- Cotation & Finances -->
<script src="cotation.js"></script>      <!-- 17. Cotation NGAP -->
<script src="tresorerie.js"></script>    <!-- 18. Trésorerie + comptabilité -->
<script src="offline-queue.js"></script> <!-- 19. File attente offline -->
<script src="onboarding.js"></script>      <!-- 32. Onboarding premier lancement -->
<script src="infirmiere-tools.js"></script> <!-- 33. Outils professionnels IDEL -->

<!-- IA & Vocal -->
<script src="voice.js"></script>         <!-- 32. Dictée vocale médicale -->
<script src="ai-assistant.js"></script>  <!-- 33. Assistant vocal IA + NLP -->
<script src="copilote.js"></script>      <!-- 32. Copilote IA chat -->

<!-- Rapports & Admin -->
<script src="rapport.js"></script>       <!-- 33. Rapport mensuel PDF + NGAP -->
<script src="dashboard.js"></script>     <!-- 32. Dashboard + statistiques -->
<script src="admin.js"></script>         <!-- 33. Panneau administration -->
<script src="contact.js"></script>       <!-- 32. Messagerie infirmière→admin -->
<script src="profil.js"></script>        <!-- 33. Profil utilisateur -->

<!-- PWA -->
<script src="pwa.js"></script>           <!-- 32. Install + offline + tiles -->
```

---

## Flux données patient (du formulaire à la navigation)

```
Saisie formulaire (patient-form.js)
    ↓ buildPatientObject()
    → patient.street / .extra / .zip / .city / .addressFull
    ↓
Géocodage (geocode.js)
    → processAddressBeforeGeocode() — corrections apprises
    → smartGeocode() : Photon → Nominatim → cache IndexedDB
    → patient.lat / .lng / .geoScore
    ↓
Chiffrement local (security.js)
    → encryptData() → stockage IndexedDB (patients.js)
    ↓
Sync optionnelle (pwa.js / patients-push)
    → données chiffrées envoyées au serveur pour backup
    ↓
Navigation (navigation.js)
    → geoScore ≥ 70 : coordonnées GPS directes
    → sinon : addressFull → Google Maps géocode
```

---

## Flux cotation NGAP

```
Saisie actes + texte libre (cotation.js)
    ↓ cotation()
    → /webhook/ami-calcul (worker.js)
    → N8N IA → calcul NGAP
    → fallback local si N8N KO (IK + majorations auto)
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

## Sécurité du stockage local

| Données | Stockage | Chiffrement |
|---|---|---|
| Patients | IndexedDB (`patientsDB`) | AES-256 — clé dérivée du token JWT |
| Signatures | IndexedDB (`signaturesDB`) | AES-256 — même clé de session |
| Corrections GPS apprises | IndexedDB (`geocodeDB`) | Non chiffré (données non-sensibles) |
| Historique cotations | Supabase | Chiffrement de champ AES-256-GCM côté worker |
| Logs audit locaux | IndexedDB | Non chiffré (métadonnées uniquement) |
| Historique copilote | localStorage | Non chiffré (conversations IA sans données patient) |

---


---

## Heuristique trafic temporelle

Intégrée dans `ai-tournee.js` — zéro API externe, fonctionne hors-ligne.

Les temps OSRM (trafic idéal) sont corrigés par des coefficients basés sur les patterns CEREMA/INSEE :

| Créneau | Jours | Coefficient | Label |
|---|---|---|---|
| 7h15–9h30 | Lun–Ven | ×1.65 | 🔴 Pointe matin |
| 11h45–14h15 | Lun–Ven | ×1.30 | 🟡 Déjeuner |
| 16h30–19h30 | Lun–Ven | ×1.75 | 🔴 Pointe soir |
| 19h30–21h | Lun–Ven | ×1.20 | 🟡 Après pointe |
| 9h30–12h30 | Sam | ×1.25 | 🟡 Sam. matin |
| Reste | Tous | ×1.0 | 🟢 Fluide |

Le coefficient USER_STATS (retard moyen constaté) s'applique en supplément.
Propagé dans : `trafficAwareCachedTravel()`, `optimizeTour()`, `simulateLookahead()`, `recomputeRoute()`.

---

## Outils professionnels (`infirmiere-tools.js`)

| Outil | Fonctionnalité |
|---|---|
| Charges & net réel | Simulateur annuel URSSAF + CARPIMKO + IR — barème 2024/2026 |
| Journal kilométrique | Saisie trajets, barème IK par CV (3→7+), véhicule électrique, export CSV |
| Modèles de soins | Bibliothèque CRUD de descriptions pré-remplies, cotation 1 clic |
| Simulateur majorations | Calcul instantané AMI/AIS/BSx + IFD/IK/MIE/MCI selon heure/jour |
| Suivi ordonnances | Enregistrement, alertes expiration 30j, lien carnet patient |

## Codes postaux — étendre la base

Le fichier `patient-form.js` contient `CP_DATA`. Pour ajouter un département :

```javascript
{cp:"01000", ville:"Bourg-en-Bresse"},
{cp:"01100", ville:"Oyonnax"},
// ...
```

Base complète La Poste (gratuite) :
https://datanova.laposte.fr/datasets/laposte-hexasmal

---

## Versions

| Composant | Version |
|---|---|
| Worker backend | v6.1 |
| Moteur tournée IA | v5.1 (heuristique trafic) |
| Assistant vocal IA | v1.1 (WebLLM retiré — NLP embarqué) |
| PWA / Service Worker | v3.6 |
| Sécurité RGPD | v2.0 |
| Admin panel | v4.0 |
