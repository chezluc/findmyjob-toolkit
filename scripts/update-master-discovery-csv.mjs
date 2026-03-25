#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { MASTER_CSV_PATH } from './config.mjs';

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
  if (/[\",\\n]/.test(text)) return `\"${text.replace(/\"/g, '\"\"')}\"`;
  return text;
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\"') {
      if (inQuotes && line[i + 1] === '\"') {
        current += '\"';
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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readExistingCsv(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split('\\n').map((line) => line.replace(/\\r$/, '')).filter(Boolean);
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

const aggregatedPath = getArg('aggregated');
const outputPath = getArg('output', MASTER_CSV_PATH);

if (!aggregatedPath) {
  console.error('Usage: node scripts/update-master-discovery-csv.mjs --aggregated=/path/to/aggregated-candidates.json');
  process.exit(1);
}

const aggregated = await readJson(aggregatedPath);
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

for (const item of aggregated.candidates || []) {
  const url = item.canonicalUrl || item.url || `${aggregated.title}-${item.rank}`;
  const existing = byPostingUrl.get(url) || {};
  byPostingUrl.set(url, {
    'Title Query': aggregated.title || existing['Title Query'] || '',
    'Run Created At': aggregated.createdAt || existing['Run Created At'] || '',
    'Rank': existing['Rank'] || '',
    'Company': existing['Company'] || item.company || '',
    'Role Title': existing['Role Title'] || item.text || '',
    'Posting URL': item.url || '',
    'Activity Status': existing['Activity Status'] || 'discovered',
    'Score Total': existing['Score Total'] || '',
    'Score Raw Total': existing['Score Raw Total'] || '',
    'Score Title': existing['Score Title'] || '',
    'Score Evidence': existing['Score Evidence'] || '',
    'Score Activity': existing['Score Activity'] || '',
    'Top Evidence Titles': existing['Top Evidence Titles'] || '',
    'Posting Path': existing['Posting Path'] || '',
    'Application Structure Path': existing['Application Structure Path'] || '',
    'Links Path': existing['Links Path'] || '',
    'Evidence Path': existing['Evidence Path'] || '',
    'Candidate Dir': existing['Candidate Dir'] || '',
  });
}

const rows = Array.from(byPostingUrl.values());
const csv = [
  headers.map(csvEscape).join(','),
  ...rows.map((row) => headers.map((header) => csvEscape(row[header] || '')).join(',')),
].join('\\n');

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${csv}\\n`, 'utf8');

console.log(JSON.stringify({ outputPath, rows: rows.length }, null, 2));
