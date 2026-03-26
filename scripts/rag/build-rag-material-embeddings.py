#!/usr/bin/env python3

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--out_dir", default="", help="Default: supporting-materials/index")
    return ap.parse_args()


def _l2_normalize(x: np.ndarray, eps: float = 1e-12) -> np.ndarray:
    n = np.linalg.norm(x, axis=1, keepdims=True)
    n = np.maximum(n, eps)
    return x / n


def main():
    args = parse_args()
    base = Path(args.base).expanduser().resolve()
    idx_path = (Path(args.out_dir).expanduser() if args.out_dir else base / "supporting-materials" / "index").resolve()

    npz_path = idx_path / "embeddings.npz"
    ids_path = idx_path / "embeddings.chunk_ids.json"
    chunks_meta_path = idx_path / "embeddings.chunks_meta.json"

    if not (npz_path.exists() and ids_path.exists() and chunks_meta_path.exists()):
        raise SystemExit("Missing embedding artifacts. Build embeddings first with scripts/rag/build-rag-embeddings.py")

    emb = np.load(npz_path)["embeddings"].astype(np.float32)
    chunk_ids = json.loads(ids_path.read_text())
    chunks_meta = {c["chunk_id"]: c for c in json.loads(chunks_meta_path.read_text())}

    by_material = defaultdict(list)
    material_meta = {}
    for i, cid in enumerate(chunk_ids):
        meta = chunks_meta.get(cid, {})
        mid = meta.get("material_id") or ""
        if not mid:
            continue
        by_material[mid].append(int(i))
        if mid not in material_meta:
            material_meta[mid] = {
                "material_id": mid,
                "material_title": meta.get("material_title", ""),
                "source_path": meta.get("source_path", ""),
            }

    material_ids = sorted(by_material.keys())
    out_emb = []
    out_meta = []
    for mid in material_ids:
        idxs = by_material[mid]
        v = emb[idxs].mean(axis=0, keepdims=True)
        out_emb.append(v.astype(np.float32))
        out_meta.append({**material_meta.get(mid, {"material_id": mid}), "chunk_count": len(idxs)})

    out_emb = np.vstack(out_emb).astype(np.float32)
    out_emb = _l2_normalize(out_emb)

    np.savez_compressed(idx_path / "materials.embeddings.npz", embeddings=out_emb)
    (idx_path / "materials.ids.json").write_text(json.dumps(material_ids, indent=2))
    (idx_path / "materials.materials_meta.json").write_text(json.dumps(out_meta, indent=2))

    print(json.dumps({"ok": True, "material_count": len(material_ids), "out_dir": str(idx_path)}, indent=2))


if __name__ == "__main__":
    main()

