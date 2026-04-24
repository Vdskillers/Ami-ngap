#!/usr/bin/env python3
"""
build_rag_embeddings.py — Recompute RAG embeddings for AMI.

Usage:
    # 1. First time / full rebuild from chunks.json
    python build_rag_embeddings.py --chunks chunks.json --out rag_payload.json

    # 2. Inject directly into the N8N workflow JSON
    python build_rag_embeddings.py --chunks chunks.json \
        --workflow AI_Agent_AMI_v12_HYBRID_RAG_v1.json \
        --node-name "RAG NGAP Retriever" \
        --out AI_Agent_AMI_v12_HYBRID_RAG_v2.json

    # 3. Add new chunks incrementally (recomputes only new ones)
    python build_rag_embeddings.py --chunks chunks.json \
        --cache rag_payload.json --out rag_payload.json

Model: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 (384d).
MUST match the model used at query time (HF_TOKEN / EMBED_ENDPOINT in N8N).

Dependencies:
    pip install fastembed
"""
import argparse
import base64
import json
import re
import struct
import sys
from pathlib import Path

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DIM = 384


def load_chunks(path: Path) -> list[dict]:
    """Load chunks from a JSON file. Expected shape: [{id, text}, ...]."""
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected a JSON array of {{id, text}} objects")
    for c in data:
        if "id" not in c or "text" not in c:
            raise ValueError(f"Chunk missing id/text: {c}")
    # Check for duplicate IDs (fatal)
    ids = [c["id"] for c in data]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise ValueError(f"Duplicate chunk IDs: {dupes}")
    return data


def load_cache(path: Path | None) -> dict[str, list[float]]:
    """Load previously-computed embeddings. Returns {id: vector}."""
    if not path or not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        payload = json.load(f)
    # Decode the packed vectors back into a dict keyed by id
    chunks = payload.get("chunks", [])
    b64 = payload.get("vectors_b64", "")
    dim = payload.get("dim", DIM)
    if not chunks or not b64:
        return {}
    raw = base64.b64decode(b64)
    n = len(chunks)
    if len(raw) != n * dim * 4:
        print(f"⚠️  Cache size mismatch, ignoring cache", file=sys.stderr)
        return {}
    floats = struct.unpack(f"<{n * dim}f", raw)
    return {c["id"]: list(floats[i * dim : (i + 1) * dim]) for i, c in enumerate(chunks)}


def embed_new(texts: list[str]) -> list[list[float]]:
    """Embed a list of passages with fastembed."""
    from fastembed import TextEmbedding

    print(f"Loading model {MODEL_NAME}...", file=sys.stderr)
    model = TextEmbedding(model_name=MODEL_NAME)
    print(f"Embedding {len(texts)} passages...", file=sys.stderr)
    return [[round(float(x), 6) for x in v] for v in model.embed(texts)]


def build_payload(chunks: list[dict], cache: dict[str, list[float]]) -> dict:
    """Build the rag_payload structure. Reuses cached vectors when chunk id+text unchanged."""
    # Hash each chunk's text, then compare against cache
    to_embed_indices: list[int] = []
    vectors: list[list[float] | None] = [None] * len(chunks)

    for i, c in enumerate(chunks):
        cached = cache.get(c["id"])
        # We use a simple rule: if id+text unchanged, reuse. We don't hash text in cache,
        # so we reuse based on id only. Safer to recompute if text changes, so we require
        # that users delete the cache when editing text. See README.
        if cached and len(cached) == DIM:
            vectors[i] = cached
        else:
            to_embed_indices.append(i)

    if to_embed_indices:
        texts_to_embed = [chunks[i]["text"] for i in to_embed_indices]
        new_vecs = embed_new(texts_to_embed)
        for idx, v in zip(to_embed_indices, new_vecs):
            vectors[idx] = v
        print(f"Embedded {len(to_embed_indices)} new chunks, reused {len(chunks) - len(to_embed_indices)} from cache", file=sys.stderr)
    else:
        print(f"All {len(chunks)} chunks reused from cache", file=sys.stderr)

    # Pack to Base64 Float32 LE
    flat = []
    for v in vectors:
        flat.extend(v)
    packed = struct.pack(f"<{len(flat)}f", *flat)
    b64 = base64.b64encode(packed).decode("ascii")

    return {
        "model": MODEL_NAME,
        "dim": DIM,
        "n": len(chunks),
        "chunks": [{"id": c["id"], "text": c["text"]} for c in chunks],
        "vectors_b64": b64,
    }


def inject_into_workflow(workflow_path: Path, node_name: str, payload: dict, out_path: Path):
    """Patch the N8N workflow JSON: replace CHUNKS and VECTORS_B64 in the named Code node."""
    with workflow_path.open(encoding="utf-8") as f:
        wf = json.load(f)

    node = next((n for n in wf["nodes"] if n.get("name") == node_name), None)
    if not node:
        raise ValueError(f"Node '{node_name}' not found in {workflow_path}")
    if node.get("type") != "n8n-nodes-base.code":
        raise ValueError(f"Node '{node_name}' is not a Code node")

    code = node["parameters"]["jsCode"]

    chunks_js = json.dumps(payload["chunks"], ensure_ascii=False, separators=(",", ":"))

    # Replace the CHUNKS literal
    code2, n1 = re.subn(
        r"(const CHUNKS = )(\[[\s\S]*?\]);",
        lambda m: m.group(1) + chunks_js + ";",
        code,
        count=1,
    )
    if n1 != 1:
        raise ValueError("Could not locate `const CHUNKS = [...];` in node code")

    # Replace the VECTORS_B64 literal
    code3, n2 = re.subn(
        r'(const VECTORS_B64 = )"[A-Za-z0-9+/=]*";',
        lambda m: m.group(1) + f'"{payload["vectors_b64"]}";',
        code2,
        count=1,
    )
    if n2 != 1:
        raise ValueError("Could not locate `const VECTORS_B64 = \"...\";` in node code")

    # Replace DIM and N constants to match
    code4 = re.sub(r"const DIM\s*=\s*\d+;", f"const DIM            = {payload['dim']};", code3)
    code5 = re.sub(r"const N\s*=\s*\d+;", f"const N              = {payload['n']};", code4)

    node["parameters"]["jsCode"] = code5

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(wf, f, ensure_ascii=False, indent=2)

    size_kb = out_path.stat().st_size / 1024
    print(f"✅ Wrote patched workflow to {out_path} ({size_kb:.1f} KB)", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chunks", required=True, help="Path to chunks.json")
    ap.add_argument("--cache", help="Path to a previous rag_payload.json (reuses vectors by id)")
    ap.add_argument("--workflow", help="Path to existing N8N workflow JSON (patches it in place of --out)")
    ap.add_argument("--node-name", default="RAG NGAP Retriever", help="Name of the Code node to patch")
    ap.add_argument("--out", required=True, help="Output path (rag_payload.json OR patched workflow JSON)")
    args = ap.parse_args()

    chunks = load_chunks(Path(args.chunks))
    print(f"Loaded {len(chunks)} chunks from {args.chunks}", file=sys.stderr)

    cache = load_cache(Path(args.cache)) if args.cache else {}
    if cache:
        print(f"Loaded {len(cache)} cached vectors from {args.cache}", file=sys.stderr)

    payload = build_payload(chunks, cache)

    out_path = Path(args.out)
    if args.workflow:
        inject_into_workflow(Path(args.workflow), args.node_name, payload, out_path)
    else:
        with out_path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        size_kb = out_path.stat().st_size / 1024
        print(f"✅ Wrote {out_path} ({size_kb:.1f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
