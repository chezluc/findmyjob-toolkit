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
    ap.add_argument("--base", required=True, help='Workspace base (contains "supporting-materials/index/corpus-index.json")')
    ap.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--max_chunks", type=int, default=0, help="0 = no limit")
    return ap.parse_args()


def main():
    args = parse_args()
    base = Path(args.base).expanduser().resolve()
    index_path = base / "supporting-materials" / "index" / "corpus-index.json"
    out_dir = base / "supporting-materials" / "index"
    out_dir.mkdir(parents=True, exist_ok=True)

    idx = json.loads(index_path.read_text())
    chunks = idx.get("chunks", []) or []
    if args.max_chunks and args.max_chunks > 0:
        chunks = chunks[: args.max_chunks]

    texts = [str(c.get("text", ""))[:4000] for c in chunks]
    chunk_ids = [str(c.get("id")) for c in chunks]
    meta = [
        {
            "chunk_id": str(c.get("id")),
            "material_id": str(c.get("material_id", "")),
            "material_title": str(c.get("material_title", "")),
            "source_path": str(c.get("source_path", "")),
            "snippet": str(c.get("text", ""))[:900],
        }
        for c in chunks
    ]

    model = SentenceTransformer(args.model)
    emb = model.encode(
        texts,
        batch_size=args.batch,
        show_progress_bar=False,
        normalize_embeddings=True,
    )
    emb = np.asarray(emb, dtype=np.float32)

    out_npz = out_dir / "embeddings.npz"
    np.savez_compressed(out_npz, embeddings=emb)
    (out_dir / "embeddings.chunk_ids.json").write_text(json.dumps(chunk_ids, indent=2))
    (out_dir / "embeddings.chunks_meta.json").write_text(json.dumps(meta, indent=2))
    (out_dir / "embeddings.meta.json").write_text(
        json.dumps(
            {
                "ok": True,
                "builtAt": __import__("datetime").datetime.now().isoformat(),
                "base": str(base),
                "model": args.model,
                "chunk_count": len(chunk_ids),
                "embedding_dim": int(emb.shape[1]) if emb.ndim == 2 else 0,
                "source_index": str(index_path),
                "files": {
                    "npz": str(out_npz),
                    "chunk_ids": str(out_dir / "embeddings.chunk_ids.json"),
                    "chunks_meta": str(out_dir / "embeddings.chunks_meta.json"),
                },
            },
            indent=2,
        )
    )

    print(
        json.dumps(
            {
                "ok": True,
                "base": str(base),
                "model": args.model,
                "chunk_count": len(chunk_ids),
                "embedding_dim": int(emb.shape[1]) if emb.ndim == 2 else 0,
                "out_npz": str(out_npz),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

