#!/usr/bin/env python3

import argparse
import json
import sqlite3
from pathlib import Path


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--query", required=True)
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--sqlite", default="", help="Default: supporting-materials/index/rag.sqlite3")
    return ap.parse_args()


def main():
    args = parse_args()
    base = Path(args.base).expanduser().resolve()
    db_path = Path(args.sqlite).expanduser() if args.sqlite else base / "supporting-materials" / "index" / "rag.sqlite3"
    if not db_path.exists():
        raise SystemExit(
            f"Missing sqlite index: {db_path}\n"
            f"Build it first:\n"
            f"  python3 scripts/rag/build-rag-sqlite.py --base \"{base}\" --rebuild\n"
        )

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
        (args.query, int(max(1, args.limit))),
    ).fetchall()
    con.close()

    out = []
    for r in rows:
        bm25 = float(r["bm25"])
        out.append(
            {
                "bm25": bm25,
                "score": float(-bm25),
                "chunk_id": r["chunk_id"],
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

    print(json.dumps({"query": args.query, "total": len(out), "results": out}, indent=2))


if __name__ == "__main__":
    main()

