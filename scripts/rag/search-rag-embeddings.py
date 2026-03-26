#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path

import numpy as np

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from sentence_transformers import SentenceTransformer


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--query", required=True)
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2")
    return ap.parse_args()


def main():
    args = parse_args()
    base = Path(args.base).expanduser().resolve()
    idx_path = base / "supporting-materials" / "index"
    npz_path = idx_path / "embeddings.npz"
    ids_path = idx_path / "embeddings.chunk_ids.json"
    chunks_meta_path = idx_path / "embeddings.chunks_meta.json"

    emb = np.load(npz_path)["embeddings"].astype(np.float32)
    chunk_ids = json.loads(ids_path.read_text())
    chunks_meta = {c["chunk_id"]: c for c in json.loads(chunks_meta_path.read_text())}

    model = SentenceTransformer(args.model)
    q = model.encode([args.query], normalize_embeddings=True)
    q = np.asarray(q, dtype=np.float32)[0]

    sims = emb @ q
    top = int(max(1, min(args.limit, sims.shape[0])))
    idxs = np.argpartition(-sims, top - 1)[:top]
    idxs = idxs[np.argsort(-sims[idxs])]

    results = []
    for i in idxs:
        cid = chunk_ids[int(i)]
        meta = chunks_meta.get(cid, {})
        results.append(
            {
                "score": float(sims[int(i)]),
                "chunk_id": cid,
                "material_id": meta.get("material_id", ""),
                "material_title": meta.get("material_title", ""),
                "source_path": meta.get("source_path", ""),
                "snippet": meta.get("snippet", ""),
            }
        )

    print(json.dumps({"query": args.query, "total": len(results), "results": results}, indent=2))


if __name__ == "__main__":
    main()

