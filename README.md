# FindMyJob Toolkit

Private starter kit for a job-search and application workflow.

This repo packages the reusable pieces from a working setup:

- Chrome console bridge for page control and extraction
- title-first job discovery via ATS/subdomain search
- CSV-based discovery tracking
- Google Sheets integration notes
- HTML outreach email setup notes
- a generic HTML outreach example

## Repo Layout

- `tools/chrome-console-bridge`
  - Chrome extension plus local bridge server
- `scripts`
  - small reusable scripts for query generation, bridge access, and CSV updates
- `config/subdomains.txt`
  - ATS / careers-platform search templates
- `docs`
  - setup notes for email, spreadsheets, hosting, and workflow
- `examples`
  - generic HTML outreach example

## Quick Start

1. Copy `.env.example` to `.env` and fill in your local paths.
2. Install the Chrome bridge:
   - `cd tools/chrome-console-bridge`
   - `npm install`
   - `npm run build`
   - load `tools/chrome-console-bridge/dist` as an unpacked extension in Chrome
3. Start the local bridge server:
   - `cd tools/chrome-console-bridge`
   - `node bridge/server.mjs`
4. Generate search queries:
   - `node scripts/discover-jobs.mjs --title "production designer"`
5. Merge discovered URLs into a master CSV:
   - `node scripts/update-master-discovery-csv.mjs --aggregated ./runs/example/aggregated-candidates.json`

## Notes

- This repo does not include a personal memory layer or resume corpus.
- Google Sheets upload and outbound email are documented, but credential material is intentionally omitted.
- The Chrome bridge is the first browser target in this repo. Firefox can be added later as a separate port.
