# Spreadsheet Setup

Use a single master spreadsheet for discovery and scoring.

## Suggested Columns

- Title Query
- Run Created At
- Rank
- Company
- Role Title
- Posting URL
- Activity Status
- Score Total
- Score Raw Total
- Score Title
- Score Evidence
- Score Activity
- Top Evidence Titles
- Posting Path
- Application Structure Path
- Links Path
- Evidence Path
- Candidate Dir

## Recommended Pattern

1. Write discovery rows into a local master CSV first.
2. Reuse one spreadsheet instead of creating a new sheet every run.
3. Upload incrementally as new rows are discovered.
4. Score rows after discovery.

## Integration

This repo does not include your credentialed Google Sheets uploader.
Point `GOOGLE_SHEETS_PYTHON` and `GOOGLE_SHEETS_UPLOADER` in `.env` to your own uploader stack.
