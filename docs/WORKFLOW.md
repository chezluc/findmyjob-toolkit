# Workflow

## Core Flow

1. Generate job-search queries from a title
2. Search ATS / careers-platform subdomains
3. Collect and dedupe candidate URLs
4. Write discovery rows into a master CSV
5. Inspect and score the real job pages
6. Build application materials only for shortlisted jobs

## Separation Of Concerns

- Browser bridge:
  - navigation
  - page HTML extraction
  - snippet execution
- Agent scripts:
  - query generation
  - CSV update
  - scoring
  - application-pack generation
- External integrations:
  - Google Sheets
  - SMTP / IMAP
  - hosting / FTP

## Recommended Defaults

- Keep discovery and application prep as two separate stages.
- Upload discovery rows incrementally.
- Score only real job URLs, never search-result URLs.
- Keep browser automation to one active browser target where possible.
