# Validate — Ollama + Chrome Bridge Job Listing Validation

Validate discovered job URLs by loading them in Chrome, extracting page text, and scoring with a local LLM (llama3 via Ollama).

## Prerequisites

- Chrome bridge running (`node bridge/server.mjs` in `tools/chrome-console-bridge/`)
- Bridge tab open (`chrome-extension://<EXTENSION_ID>/bridge.html`)
- Ollama running with `llama3:latest` model (`http://127.0.0.1:11434`)

## Scripts

### radar-validate-chrome.py
Main validation script. Opens each URL via Chrome bridge, extracts text, sends to llama3 for classification.

```bash
python3 scripts/validate/radar-validate-chrome.py --csv /path/to/discovery.csv
```

llama3 returns for each URL:
- `is_active` — true only if it's a single job listing (not an index, search, help page)
- `job_title` — detected job title
- `company` — detected company name
- `city` — city/location or "Remote"
- `date_posted` — posting date if found

Saves after every batch. Uploads to Google Sheets when done.

### radar-validate-v2.py
Alternative that opens URLs via AppleScript (forces Chrome to render JS), then uses bridge to extract. Use when background tabs don't render JS properly.

```bash
python3 scripts/validate/radar-validate-v2.py --csv /path/to/discovery.csv
```

### capture-pages.py
Captures page text from URLs via Firefox AppleScript (Cmd+A, Cmd+C). Saves each page to a text file for offline analysis.

```bash
python3 scripts/validate/capture-pages.py START COUNT
# e.g. python3 scripts/validate/capture-pages.py 0 50
```

Uses AppleScript style guide patterns:
- `set delayOne to 0.4` / `set pageDelay to 7`
- Single System Events block
- Clipboard paste for URLs
- Reuses same tab (no close/reopen)

### radar-search.py
RADAR discovery — searches Google for job URLs across ATS platforms, validates with Firefox + DeepSeek/llama3.

```bash
python3 scripts/validate/radar-search.py \
  --queries /path/to/queries.json \
  --tab TAB_ID \
  --title "product designer" \
  --resume /path/to/existing.csv
```

### radar-deep-search.py
Paginates through all ATS sites on Google (20 pages x 10 results per site).

```bash
python3 scripts/validate/radar-deep-search.py --tab TAB_ID
```

- 60-120s random delays to avoid Google captcha
- Saves after every page
- Skips already-done queries on resume

### eures-search.py
Searches the EURES European job portal via Chrome bridge.

```bash
python3 scripts/validate/eures-search.py
```

- 20 pages per search term (up to 1000 results per term)
- Adds Google Translate `url_english` column
- Uploads to Google Sheets after each term

## Ollama Configuration

Uses `llama3:latest` via `/api/chat` endpoint:
```bash
curl -s http://127.0.0.1:11434/api/chat -d '{
  "model": "llama3:latest",
  "messages": [{"role": "user", "content": "..."}],
  "stream": false,
  "options": {"temperature": 0.1, "num_predict": 150}
}'
```

~3 seconds per classification. No API costs.

## Best Practices

1. Always test 5 URLs first, check results, then scale
2. Save after every page/batch so progress is never lost
3. Use `--resume` to pick up where you left off
4. Random delays (60-120s) for Google searches to avoid captcha
5. Dedupe: strip `#:~:text=` fragments and query params
6. Filter out index pages, help articles, blog posts
7. Reuse one background tab — don't open/close tabs
