# AMI RAG — Migration vers pgvector (phase OVH)

Plan pour migrer le RAG inline (actuellement 62 chunks Base64 dans le Code node) vers une architecture **Supabase pgvector** avec recherche hybride SQL. À déclencher quand :

- Le corpus dépasse ~500 chunks (inline Base64 devient trop lourd)
- Tu ajoutes les corpus scrapés Legifrance/Judilibre/CNAM (cible ~19 000 chunks)
- Tu veux pouvoir mettre à jour les chunks sans redéployer le workflow

## Vue d'ensemble

```
AVANT (inline) :
  Code node (148 KB)
    ├─ 62 chunks embarqués
    ├─ 62 vecteurs Base64
    └─ BM25 + cosine + RRF en JS

APRÈS (pgvector) :
  Code node (5 KB, léger)
    ├─ fetch embedding API (query)
    └─ appel RPC Supabase match_ngap_hybrid()

  Supabase Postgres
    ├─ table ngap_rag_chunks (id, text, metadata, fts, embedding)
    ├─ index BM25 via tsvector + GIN
    ├─ index dense via HNSW sur embedding
    └─ fonction RPC match_ngap_hybrid(query_text, query_embedding, k)
          └─ fait BM25 + cosine + RRF en SQL, retourne top-K
```

**Avantages** :
- Scale linéaire jusqu'à des millions de chunks (HNSW ≈ O(log n))
- Mise à jour à chaud (INSERT/UPDATE sans redéploiement)
- Filtrage par metadata (autorité, date_effet, chapitre NGAP, etc.)
- Tout le scoring côté DB → N8N devient orchestrateur pur

## Étape 1 : Migration SQL

À exécuter dans Supabase → SQL Editor.

```sql
-- =============================================================
-- 001_rag_setup.sql
-- =============================================================

-- Extensions (idempotent)
create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- Configuration FTS française avec unaccent + stemming
drop text search configuration if exists french_unaccent cascade;
create text search configuration french_unaccent (copy = french);
alter text search configuration french_unaccent
    alter mapping for hword, hword_part, word
    with unaccent, french_stem;

-- Table principale
create table if not exists ngap_rag_chunks (
    id              text primary key,
    text            text not null,
    metadata        jsonb not null default '{}'::jsonb,
    embedding       vector(384) not null,  -- MiniLM multilingual dim
    fts             tsvector generated always as (
                        to_tsvector('french_unaccent', coalesce(text, ''))
                    ) stored,
    source          text,                   -- 'ngap_officiel' | 'cnam_circulaire' | 'legifrance' | 'judilibre' | 'has' | 'ami_internal'
    autorite        text,                   -- 'UNCAM' | 'CNAM' | 'HAS' | 'Cass' | 'CE' | ...
    date_effet      date,
    chapitre        text,                   -- pour chunks NGAP
    article         text,
    verified        boolean default false,  -- marqué true pour chunks internes validés
    rulesetVersion  text default 'NGAP_2026.3',
    created_at      timestamptz default now(),
    updated_at      timestamptz default now()
);

-- Index BM25 (GIN sur tsvector)
create index if not exists ngap_rag_fts_idx
    on ngap_rag_chunks using gin (fts);

-- Index dense (HNSW cosine)
create index if not exists ngap_rag_embedding_idx
    on ngap_rag_chunks using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

-- Index metadata fréquents
create index if not exists ngap_rag_source_idx on ngap_rag_chunks (source);
create index if not exists ngap_rag_date_effet_idx on ngap_rag_chunks (date_effet);

-- Trigger updated_at
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists ngap_rag_updated_at on ngap_rag_chunks;
create trigger ngap_rag_updated_at before update on ngap_rag_chunks
    for each row execute function touch_updated_at();

-- RLS : aucun user final n'y touche, seul le service role via RPC
alter table ngap_rag_chunks enable row level security;

-- Lecture via la fonction match_ngap_hybrid (security definer) — pas d'accès direct
create policy "deny all direct" on ngap_rag_chunks for all to anon, authenticated using (false);
```

## Étape 2 : Fonction RPC hybride

```sql
-- =============================================================
-- 002_rag_rpc.sql — match_ngap_hybrid (RRF BM25 + cosine)
-- =============================================================

create or replace function match_ngap_hybrid(
    query_text        text,
    query_embedding   vector(384),
    match_count       int default 12,
    rrf_k             int default 60,
    candidate_pool    int default 20,
    filter_source     text[] default null,
    filter_min_date   date default null
) returns table (
    id           text,
    text         text,
    metadata     jsonb,
    source       text,
    bm25_rank    int,
    dense_rank   int,
    rrf_score    double precision
) language plpgsql security definer as $$
begin
    return query
    with
    -- Candidats BM25
    bm25 as (
        select
            c.id,
            row_number() over (order by ts_rank_cd(c.fts, q.query) desc) as rnk
        from ngap_rag_chunks c,
             plainto_tsquery('french_unaccent', query_text) q
        where c.fts @@ q.query
          and (filter_source is null or c.source = any(filter_source))
          and (filter_min_date is null or c.date_effet >= filter_min_date or c.date_effet is null)
        order by ts_rank_cd(c.fts, q.query) desc
        limit candidate_pool
    ),
    -- Candidats dense
    dense as (
        select
            c.id,
            row_number() over (order by c.embedding <=> query_embedding) as rnk
        from ngap_rag_chunks c
        where (filter_source is null or c.source = any(filter_source))
          and (filter_min_date is null or c.date_effet >= filter_min_date or c.date_effet is null)
        order by c.embedding <=> query_embedding
        limit candidate_pool
    ),
    -- Fusion RRF : score = sum(1 / (k + rank))
    fused as (
        select
            coalesce(b.id, d.id) as id,
            b.rnk as bm25_rank,
            d.rnk as dense_rank,
            coalesce(1.0 / (rrf_k + b.rnk), 0)
          + coalesce(1.0 / (rrf_k + d.rnk), 0) as rrf_score
        from bm25 b
        full outer join dense d on b.id = d.id
    )
    select
        c.id,
        c.text,
        c.metadata,
        c.source,
        f.bm25_rank::int,
        f.dense_rank::int,
        f.rrf_score
    from fused f
    join ngap_rag_chunks c on c.id = f.id
    order by f.rrf_score desc
    limit match_count;
end;
$$;

-- Exposer la RPC
grant execute on function match_ngap_hybrid to service_role;
-- Ne pas exposer à anon/authenticated si la table est sensible
```

## Étape 3 : Seeding initial depuis l'existant

Script Python one-shot pour migrer les 62 chunks inline vers Supabase.

```python
# seed_pgvector.py
import base64, json, os, struct
from supabase import create_client  # pip install supabase

SB_URL = os.environ["SUPABASE_URL"]
SB_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
sb = create_client(SB_URL, SB_SERVICE_KEY)

with open("rag_payload.json", encoding="utf-8") as f:
    payload = json.load(f)

n, dim = payload["n"], payload["dim"]
raw = base64.b64decode(payload["vectors_b64"])
floats = struct.unpack(f"<{n*dim}f", raw)
vectors = [list(floats[i*dim:(i+1)*dim]) for i in range(n)]

# Détection basique de metadata depuis l'id
def infer_source(cid):
    if cid.startswith("ngap_perf"): return "ngap_officiel"
    if "cir_9_2025" in cid: return "cnam_circulaire"
    if cid.startswith("ngap_fraude"): return "ami_internal"
    return "ngap_officiel"

rows = []
for chunk, vec in zip(payload["chunks"], vectors):
    rows.append({
        "id": chunk["id"],
        "text": chunk["text"],
        "embedding": vec,
        "source": infer_source(chunk["id"]),
        "metadata": {"origin": "inline_migration"},
        "verified": True,
        "rulesetVersion": "NGAP_2026.3",
    })

# Upsert par batch de 50
for i in range(0, len(rows), 50):
    batch = rows[i:i+50]
    sb.table("ngap_rag_chunks").upsert(batch).execute()
    print(f"Upserted {i+len(batch)}/{len(rows)}")

print("✅ Seeding complete")
```

## Étape 4 : Nouveau Code node léger

Remplace le Code node inline (148 KB) par cette version allégée (~5 KB) :

```javascript
// ============================================================
// RAG NGAP Retriever v10 — pgvector hybrid (RPC Supabase)
// ============================================================
const body = $input.first().json;
const rawQuery = (body.texte || '').toString();

const SUPABASE_URL  = $env.SUPABASE_URL;
const SUPABASE_KEY  = $env.SUPABASE_SERVICE_KEY;
const HF_TOKEN      = $env.HF_TOKEN || '';
const HF_MODEL      = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
const EMBED_ENDPOINT = $env.EMBED_ENDPOINT ||
  ('https://api-inference.huggingface.co/pipeline/feature-extraction/' + HF_MODEL);

async function embedQuery(text) {
  if (!text || text.length < 3) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4500);
    const headers = { 'Content-Type': 'application/json' };
    if (HF_TOKEN) headers['Authorization'] = 'Bearer ' + HF_TOKEN;
    const res = await fetch(EMBED_ENDPOINT, {
      method: 'POST', headers,
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const v = await res.json();
    const vec = Array.isArray(v) && typeof v[0] === 'number' ? v
             : Array.isArray(v) && Array.isArray(v[0]) ? v[0] : null;
    return vec;
  } catch(e) { return null; }
}

async function matchHybrid(queryText, queryEmbedding) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_ngap_hybrid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      query_text: queryText,
      query_embedding: queryEmbedding,
      match_count: 12,
      candidate_pool: 20,
    }),
  });
  if (!res.ok) return [];
  return await res.json();
}

const qvec = await embedQuery(rawQuery);
let chunks = [];
let ragMode = 'empty';

if (qvec) {
  chunks = await matchHybrid(rawQuery, qvec);
  ragMode = 'hybrid_pgvector';
} else {
  // Fallback BM25-only via RPC dédiée (créer match_ngap_bm25_only si besoin)
  // Ou appel direct avec vecteur nul — Supabase rejettera, donc on saute
  ragMode = 'embed_api_down';
}

const rag_chunks = chunks.map(c => ({
  id: c.id, text: c.text, score: c.rrf_score,
  source: c.source, _bm25: c.bm25_rank, _dense: c.dense_rank,
}));
const ragContext = rag_chunks.map(c => `[${c.id}] ${c.text}`).join('\n');

return [{ json: {
  ...body, rag_chunks, ragContext,
  _rag_mode: ragMode,
  _rag_counts: { final: rag_chunks.length },
  rulesetVersion: 'NGAP_2026.3_PGVECTOR_V1',
}}];
```

## Étape 5 : Ingestion continue (quand tu scrape Legifrance etc.)

Pour chaque nouveau chunk scrapé :

```javascript
// Node N8N "Ingest chunk"
// Reçoit {id, text, source, autorite, date_effet, metadata}

// 1. Embed via HF API
const embedding = await embedQuery(text);

// 2. Upsert Supabase
await fetch(`${SUPABASE_URL}/rest/v1/ngap_rag_chunks`, {
  method: 'POST',
  headers: {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
  },
  body: JSON.stringify({ id, text, embedding, source, autorite, date_effet, metadata }),
});
```

## Étape 6 : Validation

Comparer sur les 7 requêtes de test de référence :

```sql
-- Vérifier que les 62 chunks initiaux sont bien seedés
select count(*) from ngap_rag_chunks;  -- → 62

-- Tester la RPC avec un embedding factice (tous à 0.01)
select * from match_ngap_hybrid(
    'perfusion longue cancer picc',
    array_fill(0.01, array[384])::vector,
    12
) limit 5;
```

## Performance attendue

| Corpus | Inline Base64 | pgvector HNSW |
|---|---|---|
| 62 chunks | ~5 ms (actuel) | ~10 ms (latence réseau Supabase) |
| 500 chunks | ~30 ms (JS lent) | ~12 ms |
| 5 000 chunks | ❌ timeout | ~20 ms |
| 50 000 chunks | ❌ impossible | ~40 ms |
| 500 000 chunks | ❌ impossible | ~80 ms |

Le point de bascule est entre 500 et 1000 chunks — faire la migration **avant** d'atteindre ce seuil.

## Rollback

Si la migration foire en prod, revenir au workflow inline est trivial : c'est un import JSON différent. Garder `AI_Agent_AMI_v12_HYBRID_RAG_v1.json` en backup.

## HDS / OVH

La table `ngap_rag_chunks` ne contient **aucune donnée de santé patient** — uniquement des règles NGAP publiques. Elle n'est donc pas soumise aux contraintes HDS et peut rester sur Supabase US si nécessaire.

En revanche, quand tu intègres les données de tours/patients (pour le feedback loop sur les cotations réelles), **celles-là doivent être sur OVH HDS**. C'est un chantier séparé.
