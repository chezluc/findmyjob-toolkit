#!/usr/bin/env node

import path from 'node:path';
import { ensureDir, openChromeUrl, readJson, writeJson, slugify, setChromeTabUrl } from './agent-utils.mjs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function runLocalNode(scriptPath, runArgs = [], cwd, timeoutMs = 0) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

function canonicalizeCandidateUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((key) => parsed.searchParams.delete(key));
    parsed.hash = '';
    if (/jobs\.lever\.co$/i.test(parsed.hostname)) {
      parsed.pathname = parsed.pathname.replace(/\/apply\/?$/i, '');
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function candidatePreferenceScore(candidate) {
  const url = String(candidate?.url || '').toLowerCase();
  let score = Number(candidate?.score || 0);
  if (/\/apply($|[/?#])/i.test(url)) score -= 8;
  if (/job-boards\.greenhouse\.io|boards\.greenhouse\.io|jobs\.lever\.co|myworkdayjobs\.com/i.test(url)) score += 4;
  return score;
}

const runDir = getArg('runDir');
const queryFile = getArg('queryFile');
const title = getArg('title');
const queryLimit = Number(getArg('queryLimit', '0'));
const noUpload = args.includes('--noUpload');
const perQueryTimeoutMs = Number(getArg('perQueryTimeoutMs', '45000'));
const searchSettleMinMs = Number(getArg('searchSettleMinMs', '10000'));
const searchSettleMaxMs = Number(getArg('searchSettleMaxMs', '30000'));
const betweenQueriesMinMs = Number(getArg('betweenQueriesMinMs', '10000'));
const betweenQueriesMaxMs = Number(getArg('betweenQueriesMaxMs', '30000'));
const extendedPauseEvery = Number(getArg('extendedPauseEvery', '4'));
const extendedPauseMinMs = Number(getArg('extendedPauseMinMs', '45000'));
const extendedPauseMaxMs = Number(getArg('extendedPauseMaxMs', '90000'));

if (!runDir || !queryFile || !title) {
  console.error('Usage: node scripts/collect-discovery-urls.mjs --runDir=/path --queryFile=/path/to/queries.json --title="production designer"');
  process.exit(1);
}

const queryData = await readJson(queryFile);
await ensureDir(runDir);
const queriesDir = path.join(runDir, 'search-pages');
await ensureDir(queriesDir);
const outputPath = path.join(runDir, 'aggregated-candidates.json');

async function persistDiscoveryArtifacts() {
  const candidates = Array.from(byUrl.values())
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.text || '').localeCompare(String(b.text || '')))
    .map((candidate, index) => ({
      rank: index + 1,
      ...candidate,
    }));

  await writeJson(outputPath, {
    createdAt: new Date().toISOString(),
    title,
    queryFile,
    reusableTabId: reusableTabId || null,
    queriesVisited: queryRuns.length,
    successfulQueries: queryRuns.filter((item) => item.ok).length,
    totalCandidates: candidates.length,
    queryRuns,
    candidates,
  });

  if (!noUpload) {
    const updateMasterCsv = await runLocalNode(
      './scripts/update-master-discovery-csv.mjs',
      [`--aggregated=${outputPath}`],
      '.',
      30000,
    );
    if (!updateMasterCsv.ok) throw new Error(updateMasterCsv.stderr || 'update-master-discovery-csv failed');
    const masterJson = JSON.parse(updateMasterCsv.stdout);

    const uploadSheet = await runLocalNode(
      './scripts/upload-shortlist-sheet.mjs',
      [`--shortlist=${outputPath}`, `--csv=${masterJson.outputPath}`, '--name=FindMeAJob Research', '--noOpen'],
      '.',
      180000,
    );
    if (!uploadSheet.ok) throw new Error(uploadSheet.stderr || 'upload-shortlist-sheet failed');
  }

  return candidates;
}

const preferredQueryOrder = [
  'greenhouse.io',
  'lever.co',
  'myworkdayjobs.com',
  'jobs.smartrecruiters.com',
  'ashbyhq.com',
  'workable.com',
  'jobvite.com',
  'icims.com',
  'breezy.hr',
  'recruitee.com',
  'clearcompany.com',
  'oraclecloud.com',
  'successfactors.com',
  'builtin.com/job',
  'wellfound.com',
  'workatastartup.com',
];

function queryPriority(query) {
  const text = String(query?.query || '').toLowerCase();
  const template = String(query?.template || '').toLowerCase();
  for (let index = 0; index < preferredQueryOrder.length; index += 1) {
    const hint = preferredQueryOrder[index];
    if (text.includes(hint) || template.includes(hint)) return index;
  }
  if (/talentnet\.community|willhire\.com|fiverr\.com|upwork\.com|freelancer\.com|toptal\.com/.test(text)) {
    return 999;
  }
  return 500;
}

const sortedQueries = [...(queryData.queries || [])].sort((a, b) => queryPriority(a) - queryPriority(b));
const selectedQueries = queryLimit > 0 ? sortedQueries.slice(0, queryLimit) : sortedQueries;
const byUrl = new Map();
const queryRuns = [];
let reusableTabId;

for (let index = 0; index < selectedQueries.length; index += 1) {
  const entry = selectedQueries[index];
  const querySlug = `${String(index + 1).padStart(2, '0')}-${slugify(entry.query)}`;
  const pageDir = path.join(queriesDir, querySlug);
  await ensureDir(pageDir);

  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(entry.query)}`;
  let targetTabId;
  if (reusableTabId) {
    const reused = await setChromeTabUrl(reusableTabId, searchUrl);
    targetTabId = reused.tabId;
  } else {
    const opened = await openChromeUrl(searchUrl);
    targetTabId = opened.tabId;
    reusableTabId = targetTabId;
  }

  await sleep(randomInt(searchSettleMinMs, searchSettleMaxMs));

  await writeJson(path.join(pageDir, 'search-page.json'), {
    query: entry.query,
    template: entry.template,
    searchUrl,
    currentUrl: searchUrl,
    currentTitle: '',
    targetTabId,
  });

  const extraction = await runLocalNode(
    './scripts/extract-search-candidates.mjs',
    [`--runDir=${pageDir}`, `--title=${title}`],
    '.',
    perQueryTimeoutMs,
  );

  if (!extraction.ok) {
    queryRuns.push({
      index: index + 1,
      ok: false,
      query: entry.query,
      searchUrl,
      targetTabId,
      error: extraction.stderr || 'candidate extraction failed',
    });
    continue;
  }

  const extractionJson = JSON.parse(extraction.stdout);
  const pageCandidates = await readJson(extractionJson.outputPath);
  const candidates = pageCandidates.candidates || [];

  for (const candidate of candidates) {
    const canonicalUrl = canonicalizeCandidateUrl(candidate.url);
    const existing = byUrl.get(canonicalUrl);
    if (!existing || candidatePreferenceScore(candidate) > candidatePreferenceScore(existing)) {
      byUrl.set(canonicalUrl, {
        ...candidate,
        canonicalUrl,
        firstSeenQuery: existing?.firstSeenQuery || entry.query,
        sourceQueries: Array.from(new Set([...(existing?.sourceQueries || []), entry.query])),
      });
    } else {
      existing.sourceQueries = Array.from(new Set([...(existing.sourceQueries || []), entry.query]));
      byUrl.set(canonicalUrl, existing);
    }
  }

  queryRuns.push({
    index: index + 1,
    ok: true,
    query: entry.query,
    searchUrl,
    targetTabId,
    outputPath: extractionJson.outputPath,
    candidateCount: candidates.length,
  });

  await persistDiscoveryArtifacts();

  if (index < selectedQueries.length - 1) {
    await sleep(randomInt(betweenQueriesMinMs, betweenQueriesMaxMs));
    if (extendedPauseEvery > 0 && (index + 1) % extendedPauseEvery === 0) {
      await sleep(randomInt(extendedPauseMinMs, extendedPauseMaxMs));
    }
  }
}

const candidates = await persistDiscoveryArtifacts();

console.log(JSON.stringify({ outputPath, totalCandidates: candidates.length, queriesVisited: queryRuns.length, reusableTabId: reusableTabId || null }, null, 2));
