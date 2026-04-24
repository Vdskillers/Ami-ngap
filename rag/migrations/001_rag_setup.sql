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