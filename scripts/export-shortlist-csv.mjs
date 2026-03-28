#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson } from './agent-utils.mjs';

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
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

const shortlistPath = getArg('shortlist');
const outputPathArg = getArg('output');

if (!shortlistPath) {
  console.error('Usage: node scripts/export-shortlist-csv.mjs --shortlist=/path/to/shortlist.json [--output=/path/to/file.csv]');
  process.exit(1);
}

const shortlist = await readJson(shortlistPath);
const outputPath = outputPathArg || path.join(path.dirname(shortlistPath), 'shortlist.csv');

const headers = [
  'Rank',
  'Title Query',
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

const rows = [headers];
for (const item of shortlist.shortlist || []) {
  rows.push([
    item.rank,
    shortlist.title || '',
    item.company || '',
    item.roleTitle || '',
    item.postingUrl || '',
    item.activityStatus || '',
    item.score?.total ?? '',
    item.score?.rawTotal ?? '',
    item.score?.titleScore ?? '',
    item.score?.evidenceScore ?? '',
    item.score?.activityScore ?? '',
    (item.topEvidence || []).map((entry) => entry.materialTitle).join(' | '),
    item.postingPath || '',
    item.applicationStructurePath || '',
    item.linksPath || '',
    item.evidencePath || '',
    item.candidateDir || '',
  ]);
}

const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
await fs.writeFile(outputPath, `${csv}\n`, 'utf8');

console.log(JSON.stringify({ outputPath, rows: rows.length - 1 }, null, 2));
