# RAG (Local Evidence Database)

This project supports an optional local RAG layer for “supporting materials” (notes, transcripts, portfolios, etc) so an agent can pull **relevant evidence snippets** for a job post before generating application materials.

The RAG layer is intentionally local-first:

- semantic retrieval (embeddings)
- lexical retrieval (SQLite FTS5 / BM25)
- a material-level “band” (useful when one long document/video spans many topics)

## Expected Directory Layout

These scripts assume a workspace that contains:

`<workspace>/supporting-materials/index/corpus-index.json`

`corpus-index.json` should have this shape (minimum):

- `chunks[]` with keys: `id`, `material_id`, `material_title`, `source_path`, `manifest_path`, `company`, `role`, `tags`, `claims_supported`, `text`

## Install Python Deps

```bash
python3 -m pip install -r requirements-rag.txt
```

## Build

1. Build semantic embeddings (chunk-level):

```bash
python3 scripts/rag/build-rag-embeddings.py --base "<workspace>"
```

2. Build lexical index (SQLite FTS5):

```bash
python3 scripts/rag/build-rag-sqlite.py --base "<workspace>" --rebuild
```

3. Build material-level embeddings (mean of chunk vectors):

```bash
python3 scripts/rag/build-rag-material-embeddings.py --base "<workspace>"
```

## Query

Hybrid retrieval (semantic + lexical, with optional material band):

```bash
python3 scripts/rag/search-rag-hybrid.py --base "<workspace>" --query "production designer automation" --use_materials
```

Semantic-only:

```bash
python3 scripts/rag/search-rag-embeddings.py --base "<workspace>" --query "greenhouse application form"
```

Lexical-only:

```bash
python3 scripts/rag/search-rag-sqlite.py --base "<workspace>" --query "\"design system\""
```

