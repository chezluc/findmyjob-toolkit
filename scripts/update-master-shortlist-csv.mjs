#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson } from './agent-utils.mjs';

const MASTER_CSV_PATH = 'process.env.WORKSPACE/trackers/job-research-master.csv';

const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  result.push(current);
  return result;
}

async function readExistingCsv(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
    if (!lines.length) return [];
    const header = splitCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
      const values = splitCsvLine(line);
      return Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']));
    });
  } catch {
    return [];
  }
}

const shortlistPath = getArg('shortlist');
const outputPath = getArg('output', MASTER_CSV_PATH);

if (!shortlistPath) {
  console.error('Usage: node scripts/update-master-shortlist-csv.mjs --shortlist=/path/to/shortlist.json [--output=/path/to/master.csv]');
  process.exit(1);
}

const shortlist = await readJson(shortlistPath);
const existingRows = await readExistingCsv(outputPath);
const byPostingUrl = new Map(existingRows.map((row) => [row['Posting URL'], row]));

const headers = [
  'Title Query',
  'Run Created At',
  'Rank',
  'Company',
  'Role Title',
  'Posting URL',
  'Activity Status',
  'Score Total',
  'Score Raw Total',
  'Score Title',
  'Score Evidence',
  'Score Activity',
  'Top Evidence Titles',
  'Posting Path',
  'Application Structure Path',
  'Links Path',
  'Evidence Path',
  'Candidate Dir',
];

for (const item of shortlist.shortlist || []) {
  byPostingUrl.set(item.postingUrl || `${shortlist.title}-${item.rank}`, {
    'Title Query': shortlist.title || '',
    'Run Created At': shortlist.createdAt || '',
    'Rank': String(item.rank ?? ''),
    'Company': item.company || '',
    'Role Title': item.roleTitle || '',
    'Posting URL': item.postingUrl || '',
    'Activity Status': item.activityStatus || '',
    'Score Total': String(item.score?.total ?? ''),
    'Score Raw Total': String(item.score?.rawTotal ?? ''),
    'Score Title': String(item.score?.titleScore ?? ''),
    'Score Evidence': String(item.score?.evidenceScore ?? ''),
    'Score Activity': String(item.score?.activityScore ?? ''),
    'Top Evidence Titles': (item.topEvidence || []).map((entry) => entry.materialTitle).join(' | '),
    'Posting Path': item.postingPath || '',
    'Application Structure Path': item.applicationStructurePath || '',
    'Links Path': item.linksPath || '',
    'Evidence Path': item.evidencePath || '',
    'Candidate Dir': item.candidateDir || '',
  });
}

const rows = Array.from(byPostingUrl.values()).sort((a, b) => {
  const left = a['Run Created At'] || '';
  const right = b['Run Created At'] || '';
  return right.localeCompare(left) || (a['Company'] || '').localeCompare(b['Company'] || '');
});

const csv = [
  headers.map(csvEscape).join(','),
  ...rows.map((row) => headers.map((header) => csvEscape(row[header] || '')).join(',')),
].join('\n');

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${csv}\n`, 'utf8');

console.log(JSON.stringify({ outputPath, rows: rows.length }, null, 2));
