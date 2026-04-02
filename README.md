# AMI NGAP — Architecture du projet

## Structure des fichiers

```
ami-ngap/
├── index.html          # Shell HTML — structure + liens CSS/JS uniquement
├── css/
│   └── style.css       # Tout le CSS : variables, layout, composants, mobile
└── js/
    ├── utils.js        # Utilitaires globaux (chargé EN PREMIER)
    ├── auth.js         # Authentification & session
    ├── admin.js        # Panel administrateur
    ├── profil.js       # Modale profil utilisateur
    ├── cotation.js     # Cotation NGAP + Vérification IA
    ├── voice.js        # Assistant vocal & dictée médicale
    ├── dashboard.js    # Dashboard & statistiques
    ├── ui.js           # Navigation, mobile, bindings (chargé EN DERNIER avant Leaflet)
    ├── map.js          # Carte Leaflet & GPS         ← dépend de Leaflet
    ├── uber.js         # Mode Uber Médical temps réel ← dépend de Leaflet + map.js
    └── tournee.js      # Tournée IA + Import + Live  ← dépend de Leaflet + map.js + uber.js
```

## Ordre de chargement (important)

```html
<!-- 1. Base (pas de dépendances) -->
<script src="js/utils.js"></script>

<!-- 2. Modules fonctionnels (dépendent de utils.js) -->
<script src="js/auth.js"></script>
<script src="js/admin.js"></script>
<script src="js/profil.js"></script>
<script src="js/cotation.js"></script>
<script src="js/voice.js"></script>
<script src="js/dashboard.js"></script>

<!-- 3. UI — doit être après tous les modules (contient checkAuth() et les bindings) -->
<script src="js/ui.js"></script>

<!-- 4. Leaflet (CDN) — requis avant map/uber/tournee -->
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<!-- 5. Modules Leaflet-dépendants -->
<script src="js/map.js"></script>
<script src="js/uber.js"></script>
<script src="js/tournee.js"></script>
```

## Variables globales clés (définies dans utils.js)

| Variable | Description |
|---|---|
| `W` | URL du Cloudflare Worker backend |
| `S` | Session courante `{token, role, user}` |
| `ss` | Session store (sessionStorage wrapper) |
| `window.START_POINT` | Position GPS de départ `{lat, lng}` |
| `window.IMPORTED_DATA` | Données importées depuis calendrier |
| `window.UBER_PATIENTS` | Liste patients pour mode Uber Médical |
| `window.USER_POS` | Position GPS live (watchPosition) |

## Modifier un module

| Je veux modifier... | Fichier à éditer |
|---|---|
| Le formulaire de cotation | `js/cotation.js` |
| Le GPS / la carte | `js/map.js` |
| Le mode temps réel Uber | `js/uber.js` |
| L'import calendrier / tournée | `js/tournee.js` |
| Les statistiques / dashboard | `js/dashboard.js` |
| La dictée vocale | `js/voice.js` |
| La connexion / inscription | `js/auth.js` |
| Le panel admin | `js/admin.js` |
| La navigation mobile | `js/ui.js` |
| Les couleurs / design | `css/style.css` |
| La structure HTML | `index.html` |

## Backend

- **Cloudflare Worker** : `https://raspy-tooth-1a2f.vdskillers.workers.dev`
- **Authentification** : Bearer token JWT en header `Authorization`
- **Endpoints** : voir `js/utils.js` (W + `/webhook/...`)

---

## Améliorations v2

### 1. APP store centralisé (`utils.js`)
Toutes les variables globales sont maintenant dans `window.APP` :
```js
APP.startPoint    // GPS départ
APP.userPos       // GPS live
APP.importedData  // calendrier importé
APP.uberPatients  // patients tournée
APP.nextPatient   // prochain recommandé
APP.token / role / user
```
Les anciens `window.START_POINT`, `window.USER_POS` etc. restent fonctionnels via des **Property Descriptors** rétrocompatibles.

### 2. API robuste (`utils.js` — `_apiFetch`)
- ✅ **Timeout 35s** avec `AbortController`
- ✅ **Détection offline** (`navigator.onLine`)
- ✅ **Statut HTTP vérifié** (`throw` si `!res.ok`)
- ✅ **Message d'erreur explicite** (code + texte serveur)

### 3. GPS — messages d'erreur précis (`map.js`)
```
Code 1 → "autorise la localisation dans les réglages"
Code 2 → "vérifie que le GPS est activé"
Code 3 → "GPS trop lent — réessaie ou entre une adresse"
```

### 4. `requireAuth()` guard (`utils.js`)
Protège les fonctions sensibles. Si token expiré → redirect login automatique.
Utilisé dans : `loadAdm()`, `loadDash()`, `optimiserTournee()`, `loadUberPatients()`.

### 5. Checks de dépendances
Chaque fichier vérifie au chargement que ses prérequis sont présents :
```js
// Dans uber.js, map.js, tournee.js, admin.js, dashboard.js
(function checkDeps() {
  if (typeof APP === 'undefined') console.error('utils.js non chargé');
  if (typeof L === 'undefined')   console.warn('Leaflet non chargé');
})();
```
