#!/usr/bin/env python3

import argparse
import json
import sqlite3
from pathlib import Path


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="Workspace base (contains supporting-materials/index/corpus-index.json)")
    ap.add_argument("--out", default="", help="Output sqlite path (default: supporting-materials/index/rag.sqlite3)")
    ap.add_argument("--max_text_chars", type=int, default=6000)
    ap.add_argument("--rebuild", action="store_true")
    return ap.parse_args()


SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,
  material_id TEXT,
  material_title TEXT,
  source_path TEXT,
  manifest_path TEXT,
  normalized_text_path TEXT,
  source_type TEXT,
  company TEXT,
  role TEXT,
  tags TEXT,
  claims_supported TEXT,
  terms TEXT,
  chunk_index INTEGER,
  text TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  chunk_id UNINDEXED,
  tokenize = "porter"
);

CREATE INDEX IF NOT EXISTS idx_chunks_material_id ON chunks(material_id);
"""


def main():
    args = parse_args()
    base = Path(args.base).expanduser().resolve()
    index_path = base / "supporting-materials" / "index" / "corpus-index.json"
    if not index_path.exists():
        raise SystemExit(f"Missing corpus index: {index_path}")

    out_path = Path(args.out).expanduser() if args.out else base / "supporting-materials" / "index" / "rag.sqlite3"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    index = json.loads(index_path.read_text())
    chunks = index.get("chunks", [])

    con = sqlite3.connect(out_path)
    con.execute("PRAGMA foreign_keys=OFF;")

    if args.rebuild:
        con.execute("DROP TABLE IF EXISTS chunks;")
        con.execute("DROP TABLE IF EXISTS chunks_fts;")

    con.executescript(SCHEMA_SQL)

    existing = con.execute("SELECT COUNT(1) FROM chunks;").fetchone()[0]
    if existing > 0 and not args.rebuild:
        print(json.dumps({"ok": True, "out": str(out_path), "skipped": True, "chunk_count": existing}, indent=2))
        return

    ins_chunks = """
      INSERT OR REPLACE INTO chunks (
        chunk_id, material_id, material_title, source_path, manifest_path, normalized_text_path, source_type,
        company, role, tags, claims_supported, terms, chunk_index, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    """
    ins_fts = "INSERT OR REPLACE INTO chunks_fts (rowid, text, chunk_id) VALUES (?, ?, ?);"

    def to_json(v):
        try:
            return json.dumps(v, ensure_ascii=False)
        except Exception:
            return json.dumps(str(v))

    rows_chunks = []
    rows_fts = []
    for n, c in enumerate(chunks, start=1):
        chunk_id = c.get("id", "")
        text = (c.get("text") or "").strip()
        fts_text = text[: max(0, int(args.max_text_chars))]
        rows_chunks.append(
            (
                chunk_id,
                c.get("material_id", ""),
                c.get("material_title", ""),
                c.get("source_path", ""),
                c.get("manifest_path", ""),
                c.get("normalized_text_path", ""),
                c.get("source_type", ""),
                c.get("company", ""),
                c.get("role", ""),
                to_json(c.get("tags", [])),
                to_json(c.get("claims_supported", [])),
                to_json(c.get("terms", [])),
                int(c.get("chunk_index") or 0),
                text,
            )
        )
        rows_fts.append((n, fts_text, chunk_id))

    con.execute("BEGIN;")
    con.executemany(ins_chunks, rows_chunks)
    con.execute("DELETE FROM chunks_fts;")
    con.executemany(ins_fts, rows_fts)
    con.execute("COMMIT;")
    con.close()

    print(json.dumps({"ok": True, "out": str(out_path), "chunk_count": len(rows_chunks)}, indent=2))


if __name__ == "__main__":
    main()

