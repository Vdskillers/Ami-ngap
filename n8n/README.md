# N8N Workflows — AMI

Versioning des workflows N8N utilisés par AMI.

## Workflows actifs

| Fichier | Rôle |
|---|---|
| `AI_Agent_AMI_v12_HYBRID_RAG_v1.json` | 🟢 **Production** — Cotation NGAP via IA (webhook `/ami-calcul`). Inclut le RAG hybride BM25+dense. |
| `AMI_ML_Nightly_v1.json` | Job nocturne : ML features, stats, nettoyage |
| `AMI_Cotation_Preuve_Update_v1.json` | Mise à jour des preuves de soin |
| `AMI_RL_Forecast_Workflow.json` | Q-Learning RL + demand forecasting |

## ⚠️ Pas de déploiement automatique

N8N (Render / self-hosted) **ne pull pas** ce repo. Chaque modification nécessite un **import manuel** dans l'interface N8N :

1. `Settings` → `Import from file`
2. Sélectionner le `.json` du repo
3. N8N demande si tu veux **remplacer** l'ancien workflow → **oui**
4. Activer le workflow après import (toggle en haut à droite)

## Export / backup depuis N8N

Pour committer les dernières modifs faites dans l'UI N8N :

```bash
# Dans N8N : ouvrir le workflow → menu (···) → Download
# Placer le fichier dans ce dossier (en écrasant l'ancien)
# Puis :
cd n8n/
git add AI_Agent_AMI_v12_HYBRID_RAG_v1.json
git diff --staged   # vérifier que les changements sont attendus
git commit -m "feat(n8n): <description du changement>"
git push
```

## Éditer le RAG sans toucher à ce dossier

Si tu veux seulement ajouter/modifier des chunks NGAP, **ne pas** éditer `AI_Agent_AMI_v12_HYBRID_RAG_v1.json` à la main. Utiliser :

```bash
cd ../rag/
# éditer chunks.json
make patch
# → le workflow est régénéré automatiquement
```

Ou laisser GitHub Actions le faire (cf. `.github/workflows/rag-rebuild.yml`).

## Credentials requis côté N8N

À configurer dans N8N **une seule fois** (pas committé ici) :

| Credential | Type | Utilisé par |
|---|---|---|
| `xAi account` | xAI API | AI Agent cotation |
| `Supabase AMI` | HTTP Header Auth (`apikey` + `Authorization`) | Upserts patients / cotations |
| `HF_TOKEN` | Variable d'environnement | Embeddings query RAG hybride |
| `EMBED_ENDPOINT` | Variable d'environnement (optionnel) | Override de l'endpoint par défaut |

## Versioning

Convention de nommage : `<NOM>_<SEMVER>.json` (ex : `v1`, `v2.3`). Ne pas renommer un fichier quand on modifie un workflow — écraser le même nom, le diff Git fait foi. Renommer uniquement lors d'une **breaking change** du contrat webhook.
