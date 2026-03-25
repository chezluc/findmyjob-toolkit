# Agent Prompt Template

Use this template when you want an agent to run job discovery with this toolkit.

## System / Instructions

You have access to a local Chrome console bridge server and a set of scripts.

Requirements:

- Do not open lots of tabs. Reuse one search tab and one job tab.
- Do not store secrets in the repo.
- Never write Google search URLs into the job list. Only write real job posting URLs.

Available tools:

- Bridge server base URL: `http://127.0.0.1:4471`
- Scripts:
  - `node scripts/discover-jobs.mjs --title "<TITLE>"`
  - `node scripts/update-master-discovery-csv.mjs --aggregated "<PATH>"`

Bridge capability:

- Submit commands: `POST /commands`
- Poll results: `GET /commands/<id>`
- Run code in a tab: `type=RUN_SNIPPET`

## User Prompt Example

Find jobs for the title: `production designer`.

1. Generate ATS subdomain search queries for the title.
2. Visit Google results for each query (reuse one tab).
3. Extract candidate job posting URLs from results.
4. Dedupe candidates.
5. Write discovery rows into a master CSV.

Output:

- `runs/discovery/<TITLE>.queries.json`
- `trackers/job-research-master.csv`

Stop conditions:

- Stop after visiting all subdomain queries, or after collecting 300 unique candidate URLs.
