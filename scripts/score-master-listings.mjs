#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getCurrentPageInfoFromBridge } from '../scripts/bridge-utils.mjs';
import { WORKSPACE, ensureDir, openChromeUrl, readJson, setChromeTabUrl, writeJson } from './agent-utils.mjs';

const MASTER_CSV_PATH = 'process.env.WORKSPACE/trackers/job-research-master.csv';
const SHEET_TRACKER_PATH = 'process.env.WORKSPACE/trackers/google-sheet-target.json';

const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
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

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function readCsv(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((key, index) => [key, values[index] ?? '']));
  });
  return { headers, rows };
}

async function writeCsv(filePath, headers, rows) {
  const csv = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header] || '')).join(',')),
  ].join('\n');
  await fs.writeFile(filePath, `${csv}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyPostingActivity(posting, structure, links) {
  const haystack = [
    posting.pageTitle || '',
    posting.postingText || '',
    structure?.descriptionText || '',
    ...((links?.links || []).map((item) => `${item.text} ${item.href}`)),
  ].join('\n').toLowerCase();

  if (/job is no longer available|position has been filled|this job is closed|no longer accepting applications|not accepting applications/i.test(haystack)) {
    return 'inactive';
  }
  if (/apply for this job|submit application|upload resume|resume\/cv|cover letter|application submitted|apply now/i.test(haystack)) {
    return 'active';
  }
  return 'unknown';
}

function scoreInspectedCandidate(row, posting, evidence) {
  const titleText = `${row['Role Title'] || ''} ${posting.roleTitle || ''} ${posting.pageTitle || ''}`.toLowerCase();
  const titleTerms = String(posting.roleTitle || row['Role Title'] || '').toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length >= 3);
  let titleMatch = 0;
  for (const term of titleTerms) {
    if (titleText.includes(term)) titleMatch += 4;
  }
  const evidenceScores = (evidence.results || []).slice(0, 5).map((item) => Number(item.score || 0));
  const evidenceTotal = evidenceScores.reduce((sum, value) => sum + value, 0);
  let activityBonus = 0;
  if (posting.activityStatus === 'active') activityBonus += 25;
  if (posting.activityStatus === 'unknown') activityBonus += 5;
  if (/\/apply($|[/?#])/i.test(posting.postingUrl || '')) activityBonus -= 8;
  const rawTotal = titleMatch + evidenceTotal + activityBonus;

  const titleScore = Math.max(0, Math.min(25, Math.round((titleMatch / 20) * 25)));
  const evidenceScore = Math.max(0, Math.min(60, Math.round(evidenceTotal / 140)));
  const activityScore = Math.max(0, Math.min(15, Math.round(((activityBonus + 8) / 33) * 15)));
  const normalizedTotal = Math.max(0, Math.min(100, titleScore + evidenceScore + activityScore));

  return {
    rawTotal,
    titleScore,
    evidenceScore,
    activityScore,
    total: normalizedTotal,
  };
}

function runLocalNode(scriptPath, runArgs = [], cwd = '.', timeoutMs = 0) {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath, ...runArgs], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          resolve({ code: -2, ok: false, stdout, stderr: `${stderr}${stderr ? '\n' : ''}Timed out after ${timeoutMs}ms` });
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, ok: code === 0, stdout, stderr });
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: -1, ok: false, stdout, stderr: String(error) });
    });
  });
}

async function uploadMasterCsv(csvPath) {
  const tracker = JSON.parse(await fs.readFile(SHEET_TRACKER_PATH, 'utf8'));
  const spreadsheetUrl = tracker.spreadsheetUrl;
  const pythonPath = 'process.env.CLAUDEPROJECTS/gsheets_venv/bin/python';
  const scriptPath = './scripts/upload_csv_to_existing_google_sheet.py';
  const run = await new Promise((resolve) => {
    const child = spawn(pythonPath, [scriptPath, csvPath, spreadsheetUrl], {
      cwd: 'process.env.CLAUDEPROJECTS',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    child.on('error', (error) => resolve({ ok: false, code: -1, stdout, stderr: String(error) }));
  });
  if (!run.ok) {
    throw new Error(run.stderr || run.stdout || 'Google Sheets upload failed');
  }
}

const titleFilter = getArg('title');
const limit = Number(getArg('limit', '0'));
const onlyUnscored = !args.includes('--all');
const uploadEvery = Number(getArg('uploadEvery', '5'));
const betweenListingsMs = Number(getArg('betweenListingsMs', '2000'));
const candidatePollMs = Number(getArg('candidatePollMs', '2500'));

const { headers, rows } = await readCsv(MASTER_CSV_PATH);
if (!headers.length) {
  throw new Error('Master CSV is empty');
}

let candidates = rows.filter((row) => row['Posting URL']);
if (titleFilter) {
  candidates = candidates.filter((row) => row['Title Query'] === titleFilter);
}
if (onlyUnscored) {
  candidates = candidates.filter((row) => !row['Score Total']);
}
if (limit > 0) {
  candidates = candidates.slice(0, limit);
}

const runDir = path.join(WORKSPACE, 'runs', `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-master-score-pass`);
await ensureDir(runDir);
const progressPath = path.join(runDir, 'progress.json');

let reusableTabId;
let processed = 0;
let uploaded = 0;
const progress = [];

for (const row of candidates) {
  const url = row['Posting URL'];
  const candidateDir = path.join(runDir, `${String(processed + 1).padStart(3, '0')}-${(row['Company'] || row['Role Title'] || 'listing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)}`);
  await ensureDir(candidateDir);
  await writeJson(path.join(candidateDir, 'search-selection.json'), {
    selectedCandidate: {
      text: `${row['Role Title'] || ''} - ${row['Company'] || ''}`.trim(),
      url,
    },
  });

  try {
    let tabId;
    if (reusableTabId) {
      const reused = await setChromeTabUrl(reusableTabId, url);
      tabId = reused.tabId;
    } else {
      const opened = await openChromeUrl(url);
      tabId = opened.tabId;
      reusableTabId = tabId;
    }

    const deadline = Date.now() + 30000;
    let currentPage = null;
    while (Date.now() < deadline) {
      await sleep(candidatePollMs);
      const page = await getCurrentPageInfoFromBridge({ targetTabId: tabId });
      if (page?.url && !/google\./i.test(page.url)) {
        currentPage = page;
        break;
      }
    }
    if (!currentPage?.url) {
      throw new Error('Navigation did not reach a non-search page');
    }

    const capture = await runLocalNode('./scripts/capture-current-listing.mjs', [`--runDir=${candidateDir}`, `--title=${row['Title Query'] || row['Role Title'] || ''}`, `--targetTabId=${tabId}`], undefined, 90000);
    if (!capture.ok) throw new Error(capture.stderr || 'capture failed');
    const captureJson = JSON.parse(capture.stdout);

    const applicationStructure = await runLocalNode('./scripts/extract-application-structure.mjs', [`--runDir=${candidateDir}`, `--posting=${captureJson.runPath}`], undefined, 90000);
    const evidence = await runLocalNode('../scripts/posting-to-evidence.mjs', [`--posting=${captureJson.runPath}`], WORKSPACE, 90000);
    if (!evidence.ok) throw new Error(evidence.stderr || 'evidence failed');
    const linkExtraction = await runLocalNode('./scripts/extract-html-links.mjs', [`--posting=${captureJson.runPath}`], undefined, 90000);

    const evidenceJson = JSON.parse(evidence.stdout);
    const evidencePath = path.join(candidateDir, 'evidence.json');
    await writeJson(evidencePath, evidenceJson);

    const posting = await readJson(captureJson.runPath);
    const structureJson = applicationStructure.ok ? JSON.parse(applicationStructure.stdout) : null;
    const linksJson = linkExtraction.ok ? await readJson(JSON.parse(linkExtraction.stdout).outputPath) : null;
    posting.activityStatus = classifyPostingActivity(posting, structureJson, linksJson);
    await writeJson(captureJson.runPath, posting);

    const score = scoreInspectedCandidate(row, posting, evidenceJson);
    row['Company'] = posting.company || row['Company'];
    row['Role Title'] = posting.roleTitle || row['Role Title'];
    row['Activity Status'] = posting.activityStatus || row['Activity Status'];
    row['Score Total'] = String(score.total);
    row['Score Raw Total'] = String(score.rawTotal);
    row['Score Title'] = String(score.titleScore);
    row['Score Evidence'] = String(score.evidenceScore);
    row['Score Activity'] = String(score.activityScore);
    row['Top Evidence Titles'] = (evidenceJson.results || []).slice(0, 3).map((item) => item.material_title).join(' | ');
    row['Posting Path'] = captureJson.runPath || row['Posting Path'];
    row['Application Structure Path'] = structureJson?.outputPath || row['Application Structure Path'];
    row['Links Path'] = linkExtraction.ok ? JSON.parse(linkExtraction.stdout).outputPath : row['Links Path'];
    row['Evidence Path'] = evidencePath;
    row['Candidate Dir'] = candidateDir;

    processed += 1;
    progress.push({ ok: true, url, score: score.total, company: row['Company'], roleTitle: row['Role Title'] });
    await writeCsv(MASTER_CSV_PATH, headers, rows);
    if (uploadEvery > 0 && processed % uploadEvery === 0) {
      await uploadMasterCsv(MASTER_CSV_PATH);
      uploaded += 1;
    }
  } catch (error) {
    progress.push({ ok: false, url, error: String(error) });
    await writeCsv(MASTER_CSV_PATH, headers, rows);
  }

  await writeJson(progressPath, {
    startedAt: progress[0]?.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    processed,
    attempted: progress.length,
    remaining: candidates.length - progress.length,
    progress,
  });

  if (betweenListingsMs > 0) await sleep(betweenListingsMs);
}

await uploadMasterCsv(MASTER_CSV_PATH);

console.log(JSON.stringify({
  runDir,
  progressPath,
  processed,
  attempted: progress.length,
  remaining: candidates.length - progress.length,
  uploaded,
  masterCsvPath: MASTER_CSV_PATH,
}, null, 2));
