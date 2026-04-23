# NGAP 2026 — Référentiel exhaustif + moteur déclaratif

## Contenu

| Fichier | Rôle |
|---|---|
| `ngap_referentiel_2026.json` | **Source de vérité** : 112 actes Titre XVI Chap I/II + 12 règles d'incompatibilité + 9 dérogations art. 11B + CIR-9/2025 |
| `ngap_engine.js` | Moteur déclaratif (363 lignes) qui consomme le référentiel JSON |
| `test_engine.js` | Banque de tests V1 (25 cas cliniques) |
| `test_engine_extended.js` | Banque étendue V2 (50 cas cliniques) |
| `build_ref.py` | Script de génération du référentiel (à relancer si maj NGAP) |

## Résultats tests

- **75/75 tests passent (100%)**
- Couverture : tous les chapitres (perfusions CIR-9/2025, BSI/dépendance, post-op avenant 6, sondes, BPCO, vaccinations, majorations temporelles, IK avec plafonnement, dérogations art. 11B)

## Usage rapide

```javascript
const NGAPEngine = require('./ngap_engine.js');
const ref = require('./ngap_referentiel_2026.json');
const engine = new NGAPEngine(ref);

const result = engine.compute({
  codes: [{ code: 'AMI14' }, { code: 'IFD' }],
  date_soin: '2026-04-23',
  heure_soin: '07:00',
  historique_jour: [],
  mode: 'permissif',  // ou 'strict'
  zone: 'metropole',
  distance_km: 5,
});

console.log(result.total);          // 56.00
console.log(result.actes_finaux);   // [{code: 'AMI14', tarif_final: 44.10, ...}, ...]
console.log(result.alerts);         // ['ℹ️ Majoration NUIT ajoutée automatiquement (heure/date)', ...]
console.log(result.audit);          // {version_referentiel: 'NGAP_2026.3_CIR9_2025', ...}
```

## Modes

- **`permissif`** (défaut) : codes inconnus acceptés avec alerte, 2e AMI14/jour signalé mais facturé
- **`strict`** : codes inconnus bloqués (renvoyés dans `warnings_strict`), pour mode "audit-ready"

## Mise à jour

Quand la NGAP évolue (nouvelle circulaire CNAM, avenant) :
1. Éditer `build_ref.py` pour ajouter/modifier les actes
2. Relancer `python3 build_ref.py` → régénère `ngap_referentiel_2026.json`
3. Relancer les tests : `node test_engine_extended.js`
4. Si tout passe → déployer le nouveau JSON dans le worker / n8n

Aucune modification du moteur (`ngap_engine.js`) nécessaire pour ajouter un acte.

## Prochaines étapes (intégration AMI)

1. **Worker.js** : remplacer `NGAP_TARIFS` + `fallbackCotation` par un appel à `NGAPEngine`
2. **n8n** : ajouter un nœud "NGAP Engine v2" qui consomme ce référentiel
3. **Cotation.js / tournee.js** : remplacer ACTES_RAPIDES par lecture dynamique du JSON
4. **UI admin** : exposer une interface "Référentiel NGAP" pour que tu puisses ajouter/modifier sans relancer le pipeline

## Source officielle

NGAP Titre XVI - ameli.fr  
Intègre arrêtés UNCAM jusqu'au 08/02/2023 + Circulaire **CIR-9/2025** du 25/06/2025  
Document : <https://convergenceinfirmiere.com/wp-content/uploads/2023/11/NGAP-2024.pdf>
