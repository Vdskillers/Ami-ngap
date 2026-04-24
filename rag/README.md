# AMI RAG — Corpus & Tooling

Système de retrieval hybride **BM25 + dense** pour le workflow `AI_Agent_AMI_v12_HYBRID_RAG`.

## Contenu du dossier

| Fichier | Rôle |
|---|---|
| `chunks.json` | **Source de vérité** — 62+ chunks NGAP (id + texte), édités à la main |
| `rag_payload.json` | Généré — chunks + vecteurs MiniLM 384d en Base64 (sert aussi de cache incrémental) |
| `build_embeddings.py` | Script maintenance (rebuild + injection workflow) |
| `requirements.txt` | Deps Python (fastembed) |
| `Makefile` | Commandes courantes (`make install/build/patch/stats`) |
| `migrations/` | Plan pgvector pour phase OVH (à activer quand corpus > 500 chunks) |

## Premier setup (une fois)

```bash
cd rag/
make install         # crée .venv, installe fastembed (~220 MB download 1ʳᵉ fois)
```

## Workflow courant — ajouter un chunk

```bash
cd rag/

# 1. Éditer chunks.json avec un nouvel objet {id, text}
#    Exemple d'ajout :
#    {
#      "id": "ngap_mon_nouveau_chunk",
#      "text": "AMI X = Y,ZZ €. Description complète avec vocabulaire clinique..."
#    }

# 2. Régénérer + injecter dans le workflow
make patch

# 3. Importer le nouveau workflow dans N8N
#    → n8n/AI_Agent_AMI_v12_HYBRID_RAG_v2.json
```

**Ou** laisser GitHub Actions le faire : push `chunks.json` modifié → CI rebuild + commit automatique (cf. `.github/workflows/rag-rebuild.yml`).

## Workflow courant — modifier un texte existant

Le cache `rag_payload.json` est indexé **par `id` seulement**. Si tu modifies le texte d'un chunk existant, le vecteur ne sera **pas** recalculé automatiquement.

Deux options :

```bash
# Option A : suppression ciblée dans le cache
jq 'del(.chunks[] | select(.id == "ngap_id_a_recalculer"))' rag_payload.json > tmp.json
mv tmp.json rag_payload.json
make patch

# Option B : rebuild complet
make reset   # supprime rag_payload.json
make patch
```

## Règles de qualité pour les chunks

- **Un chunk = une règle** (ne pas agglomérer plusieurs règles ensemble)
- **Répéter le code NGAP** dans le texte (ex: "AMI 14", pas seulement "perfusion longue")
- Inclure les **synonymes cliniques** que les IDEL utilisent spontanément (escarre, grabataire, cancéreux)
- **Dater** les règles conjoncturelles (ex: "CIR-9/2025 depuis le 25/06/2025")
- Longueur idéale : 100-400 caractères. Trop court → BM25 faible. Trop long → dilution sémantique.

## Tuner sans recalculer les vecteurs

Les paramètres suivants sont dans le JS du node (pas besoin de refaire `make patch` pour les changer) :

```javascript
const TOP_K_BM25   = 20;   // candidats BM25
const TOP_K_DENSE  = 20;   // candidats dense
const TOP_K_FINAL  = 12;   // retournés au LLM
const RRF_K        = 60;   // paramètre de fusion
```

Et le dictionnaire `SYNONYMS` pour ajouter des équivalences clinique↔code NGAP.

## Observabilité

La réponse du webhook `/ami-calcul` inclut maintenant :

```json
{
  "_rag_mode": "hybrid_bm25_dense_rrf",
  "_rag_counts": { "bm25": 20, "dense": 20, "final": 12 },
  "rulesetVersion": "NGAP_2026.3_CIR9_2025_HYBRID_V1",
  "rulesetHash": "a3f7e2b1"
}
```

Surveiller `_rag_mode` en prod :
- `hybrid_bm25_dense_rrf` → tout ok
- `bm25_only` → API HF en rade (token invalide, rate-limit, 503) — dégradation fonctionnelle, pas bloquant
- `empty_fallback` → aucun match, essentiels retournés — rare, investiguer la query

## Variables d'env à configurer dans N8N

| Nom | Valeur | Obligatoire |
|---|---|---|
| `HF_TOKEN` | Token HuggingFace "read" (huggingface.co/settings/tokens) | Non (fallback BM25) |
| `EMBED_ENDPOINT` | URL override (utile pour Ollama self-hosted plus tard) | Non |

## Migration future vers pgvector

Voir `migrations/README.md`. À déclencher quand :
- Corpus > 500 chunks (inline Base64 devient lourd, Code node > 500 KB)
- Tu ajoutes les corpus scrapés (Legifrance, Judilibre, CNAM, HAS) — cible ~19 000 chunks
- Phase migration OVH/HDS

L'API N8N reste identique (même webhook, même payload de sortie) — seul le Code node change.
