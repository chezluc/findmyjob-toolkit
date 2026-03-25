# FindMyJob Toolkit

Chrome console bridge + small scripts for job discovery and tracking.

## What’s Included

- Chrome extension + local bridge server: `tools/chrome-console-bridge`
- ATS/careers subdomain query templates: `config/subdomains.txt`
- Scripts:
  - `scripts/discover-jobs.mjs` generates search queries for a title
  - `scripts/update-master-discovery-csv.mjs` merges discovered URLs into a master CSV
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

## Docs

- Setup: `docs/SETUP.md`
- Agent prompt template: `docs/AGENT_PROMPT.md`
- Resources: `docs/RESOURCES.md`
