#!/usr/bin/env python3

import argparse
import json
import os
import sqlite3
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
    ap.add_argument("--limit", type=int, default=12)
    ap.add_argument("--semantic_limit", type=int, default=16)
    ap.add_argument("--lexical_limit", type=int, default=16)
    ap.add_argument("--semantic_weight", type=float, default=0.7)
    ap.add_argument("--lexical_weight", type=float, default=0.3)
    ap.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2")
    ap.add_argument("--sqlite", default="", help="Default: supporting-materials/index/rag.sqlite3")
    ap.add_argument("--use_materials", action="store_true")
    ap.add_argument("--materials_limit", type=int, default=6)
    return ap.parse_args()


def _safe_int(x, fallback=0):
    try:
        return int(x)
    except Exception:
        return fallback


def _load_embeddings(idx_path: Path):
    emb = np.load(idx_path / "embeddings.npz")["embeddings"].astype(np.float32)
    chunk_ids = json.loads((idx_path / "embeddings.chunk_ids.json").read_text())
    chunks_meta = {c["chunk_id"]: c for c in json.loads((idx_path / "embeddings.chunks_meta.json").read_text())}
    return emb, chunk_ids, chunks_meta


def _semantic_search(emb, chunk_ids, chunks_meta, model, query, limit):
    q = model.encode([query], normalize_embeddings=True)
    q = np.asarray(q, dtype=np.float32)[0]
    sims = emb @ q
    top = int(max(1, min(limit, sims.shape[0])))
    idxs = np.argpartition(-sims, top - 1)[:top]
    idxs = idxs[np.argsort(-sims[idxs])]
    out = []
    for rank, i in enumerate(idxs.tolist(), start=1):
        cid = chunk_ids[int(i)]
        meta = chunks_meta.get(cid, {})
        out.append(
            {
                "chunk_id": cid,
                "rank": rank,
                "score": float(sims[int(i)]),
                "material_id": meta.get("material_id", ""),
                "material_title": meta.get("material_title", ""),
                "source_path": meta.get("source_path", ""),
                "snippet": meta.get("snippet", ""),
            }
        )
    return out


def _lexical_search_sqlite(db_path: Path, query: str, limit: int):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        SELECT
          c.chunk_id,
          c.material_id,
          c.material_title,
          c.source_path,
          c.manifest_path,
          c.company,
          c.role,
          c.tags,
          c.claims_supported,
          substr(c.text, 1, 900) AS snippet,
          bm25(chunks_fts) AS bm25
        FROM chunks_fts
        JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
        WHERE chunks_fts MATCH ?
        ORDER BY bm25
        LIMIT ?;
        """,
        (query, int(max(1, limit))),
    ).fetchall()
    con.close()

    out = []
    for rank, r in enumerate(rows, start=1):
        bm25 = float(r["bm25"])
        out.append(
            {
                "chunk_id": r["chunk_id"],
                "rank": rank,
                "bm25": bm25,
                "score": float(-bm25),
                "material_id": r["material_id"],
                "material_title": r["material_title"],
                "source_path": r["source_path"],
                "manifest_path": r["manifest_path"],
                "company": r["company"],
                "role": r["role"],
                "tags": r["tags"],
                "claims_supported": r["claims_supported"],
                "snippet": r["snippet"],
            }
        )
    return out


def _rank_score(rank: int) -> float:
    return 1.0 / float(max(1, rank))


def _material_band(idx_path: Path, model, query: str, limit: int):
    npz = idx_path / "materials.embeddings.npz"
    ids = idx_path / "materials.ids.json"
    meta = idx_path / "materials.materials_meta.json"
    if not (npz.exists() and ids.exists() and meta.exists()):
        return []

    emb = np.load(npz)["embeddings"].astype(np.float32)
    material_ids = json.loads(ids.read_text())
    material_meta = {m["material_id"]: m for m in json.loads(meta.read_text())}

    q = model.encode([query], normalize_embeddings=True)
    q = np.asarray(q, dtype=np.float32)[0]
    sims = emb @ q
    top = int(max(1, min(limit, sims.shape[0])))
    idxs = np.argpartition(-sims, top - 1)[:top]
    idxs = idxs[np.argsort(-sims[idxs])]

    out = []
    for rank, i in enumerate(idxs.tolist(), start=1):
        mid = material_ids[int(i)]
        m = material_meta.get(mid, {})
        out.append(
            {
                "material_id": mid,
                "rank": rank,
                "score": float(sims[int(i)]),
                "material_title": m.get("material_title", ""),
                "source_path": m.get("source_path", ""),
                "chunk_count": _safe_int(m.get("chunk_count"), 0),
            }
        )
    return out


def main():
    args = parse_args()
    base = Path(args.base).expanduser().resolve()
    idx_path = base / "supporting-materials" / "index"

    db_path = Path(args.sqlite).expanduser() if args.sqlite else idx_path / "rag.sqlite3"
    if not db_path.exists():
        raise SystemExit(
            f"Missing sqlite index: {db_path}\n"
            f"Build it first:\n"
            f"  python3 scripts/rag/build-rag-sqlite.py --base \"{base}\" --rebuild\n"
        )

    emb, chunk_ids, chunks_meta = _load_embeddings(idx_path)
    model = SentenceTransformer(args.model)

    semantic = _semantic_search(emb, chunk_ids, chunks_meta, model, args.query, int(args.semantic_limit))
    lexical = _lexical_search_sqlite(db_path, args.query, int(args.lexical_limit))
    materials = _material_band(idx_path, model, args.query, int(args.materials_limit)) if args.use_materials else []

    merged = {}
    for r in semantic:
        cid = r["chunk_id"]
        merged[cid] = {
            "chunk_id": cid,
            "material_id": r.get("material_id", ""),
            "material_title": r.get("material_title", ""),
            "source_path": r.get("source_path", ""),
            "snippet": r.get("snippet", ""),
            "bands": {"semantic": {"rank": r["rank"], "score": r["score"]}},
        }

    for r in lexical:
        cid = r["chunk_id"]
        item = merged.get(cid) or {
            "chunk_id": cid,
            "material_id": r.get("material_id", ""),
            "material_title": r.get("material_title", ""),
            "source_path": r.get("source_path", ""),
            "snippet": r.get("snippet", ""),
            "bands": {},
        }
        item["bands"]["lexical"] = {"rank": r["rank"], "bm25": r["bm25"], "score": r["score"]}
        if len((item.get("snippet") or "")) < len((r.get("snippet") or "")):
            item["snippet"] = r.get("snippet") or item.get("snippet", "")
        merged[cid] = item

    for cid, item in merged.items():
        sem = item["bands"].get("semantic")
        lex = item["bands"].get("lexical")
        sem_s = float(sem["score"]) if sem else 0.0
        sem_r = _rank_score(int(sem["rank"])) if sem else 0.0
        lex_r = _rank_score(int(lex["rank"])) if lex else 0.0
        combined = (float(args.semantic_weight) * sem_s) + (0.15 * sem_r) + (float(args.lexical_weight) * lex_r)
        item["combined_score"] = float(combined)

    results = sorted(merged.values(), key=lambda x: (-x["combined_score"], x.get("material_title", "")))[: int(max(1, args.limit))]

    print(
        json.dumps(
            {
                "query": args.query,
                "total": len(results),
                "bands": {"semantic": len(semantic), "lexical": len(lexical), "materials": len(materials)},
                "materials": materials,
                "results": results,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

