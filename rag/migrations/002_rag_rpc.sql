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