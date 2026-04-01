# FindMyJob Toolkit

Chrome console bridge + small scripts for job discovery and tracking.

## What’s Included

- Chrome extension + local bridge server: `tools/chrome-console-bridge`
- ATS/careers subdomain query templates: `config/subdomains.txt`
- Scripts:
  - `scripts/discover-jobs.mjs` generates search queries for a title
  - `scripts/update-master-discovery-csv.mjs` merges discovered URLs into a master CSV
- LinkedIn time-based search (SONAR): `scripts/linkedin-time-search.py`
- Generic HTML outreach example: `examples/example-outreach-email.html`

## Quick Start

1. Copy `.env.example` to `.env` and set paths.
2. Build and load the Chrome extension:
   - `cd tools/chrome-console-bridge && npm install && npm run build`
   - Load `tools/chrome-console-bridge/dist` as an unpacked extension in Chrome
3. Start the bridge server:
   - `cd tools/chrome-console-bridge && node bridge/server.mjs`
4. Generate queries:
   - `node scripts/discover-jobs.mjs --title "production designer"`

## SONAR — LinkedIn Time-Based Search

Searches LinkedIn at decreasing time intervals (24h → 10m) to detect when jobs were posted.

```bash
# Basic search
python3 scripts/linkedin-time-search.py --title "production designer"

# US only
python3 scripts/linkedin-time-search.py --title "UX designer" --geo-id 103644278

# Remote only
python3 scripts/linkedin-time-search.py --title "design systems" --remote
```

### Common geoId values

| Region | geoId |
|--------|-------|
| United States | `103644278` |
| England | `102299470` |
| Scotland | `100752109` |
| Ireland | `104738515` |

Outputs CSV + JSON to `runs/linkedin-searches/`.

## Docs

- Setup: `docs/SETUP.md`
- Agent prompt template: `docs/AGENT_PROMPT.md`
- Resources: `docs/RESOURCES.md`
