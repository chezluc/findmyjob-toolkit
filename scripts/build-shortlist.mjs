#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { callBridge, getCurrentPageInfoFromBridge } from '../scripts/bridge-utils.mjs';
import { RUNS_DIR, ensureDir, openChromeUrl, runLocalNode, runNodeScript, slugify, stamp, writeJson, readJson, setChromeTabUrl } from './agent-utils.mjs';

const args = process.argv.slice(2);
function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function scoreInspectedCandidate(candidate, posting, evidence) {
  const titleText = `${candidate.text || ''} ${posting.roleTitle || ''} ${posting.pageTitle || ''}`.toLowerCase();
  const titleTerms = String(posting.roleTitle || '').toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length >= 3);
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
    titleMatchRaw: titleMatch,
    evidenceTotalRaw: evidenceTotal,
    activityBonusRaw: activityBonus,
    rawTotal,
    titleScore,
    evidenceScore,
    activityScore,
    total: normalizedTotal,
  };
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

async function syncShortlistArtifacts({ shortlistPath, title, locale, inspections, noUpload }) {
  const shortlist = inspections
    .filter((item) => item.ok)
    .sort((a, b) => (b.score?.total || 0) - (a.score?.total || 0))
    .map((item, rank) => ({
      rank: rank + 1,
      index: item.index,
      company: item.company,
      roleTitle: item.roleTitle,
      postingUrl: item.postingUrl,
      activityStatus: item.activityStatus,
      candidateDir: item.candidateDir,
      postingPath: item.postingPath,
      applicationStructurePath: item.applicationStructurePath,
      linksPath: item.linksPath,
      evidencePath: item.evidencePath,
      score: item.score,
      topEvidence: item.topEvidence,
    }));

  await writeJson(shortlistPath, {
    createdAt: new Date().toISOString(),
    title,
    locale,
    totalCandidatesInspected: inspections.filter((item) => item.ok).length,
    shortlist,
    failedInspections: inspections.filter((item) => !item.ok),
  });

  let csvOutputPath = '';
  let masterCsvPath = '';
  let spreadsheetUrl = '';

  if (!noUpload) {
    const exportCsv = await runLocalNode(
      './scripts/export-shortlist-csv.mjs',
      [`--shortlist=${shortlistPath}`],
      '.',
      30000,
    );
    if (!exportCsv.ok) throw new Error(exportCsv.stderr || 'export-shortlist-csv failed');
    const exportJson = JSON.parse(exportCsv.stdout);
    csvOutputPath = exportJson.outputPath;

    const updateMasterCsv = await runLocalNode(
      './scripts/update-master-shortlist-csv.mjs',
      [`--shortlist=${shortlistPath}`],
      '.',
      30000,
    );
    if (!updateMasterCsv.ok) throw new Error(updateMasterCsv.stderr || 'update-master-shortlist-csv failed');
    const masterJson = JSON.parse(updateMasterCsv.stdout);
    masterCsvPath = masterJson.outputPath;

    const uploadSheet = await runLocalNode(
      './scripts/upload-shortlist-sheet.mjs',
      [`--shortlist=${shortlistPath}`, `--csv=${masterCsvPath}`, '--name=FindMeAJob Research', '--noOpen'],
      '.',
      180000,
    );
    if (!uploadSheet.ok) throw new Error(uploadSheet.stderr || 'upload-shortlist-sheet failed');
    const uploadJson = JSON.parse(uploadSheet.stdout);
    spreadsheetUrl = uploadJson.spreadsheetUrl || '';
  }

  return { shortlist, csvOutputPath, masterCsvPath, spreadsheetUrl };
}

const title = getArg('title');
const locale = getArg('locale');
const noUpload = args.includes('--noUpload');
const inspectLimit = Number(getArg('inspectLimit', '0'));
const perCandidateTimeoutMs = Number(getArg('perCandidateTimeoutMs', '90000'));
const queryLimit = Number(getArg('queryLimit', '0'));
const betweenCandidatesMs = Number(getArg('betweenCandidatesMs', '4000'));
const candidatePollMs = Number(getArg('candidatePollMs', '2500'));

if (!title) {
  console.error('Usage: node scripts/build-shortlist.mjs --title="production designer" [--locale="san francisco"] [--inspectLimit=5]');
  process.exit(1);
}

const runDir = path.join(RUNS_DIR, `${stamp()}-${slugify(title)}-research`);
const candidatesDir = path.join(runDir, 'candidates');
await ensureDir(runDir);
await ensureDir(candidatesDir);

const manifest = {
  createdAt: new Date().toISOString(),
  title,
  locale,
  mode: 'research',
  status: 'started',
  steps: [],
};
const manifestPath = path.join(runDir, 'run.json');
await writeJson(manifestPath, manifest);

const discover = await runLocalNode('./scripts/discover-jobs.mjs', [`--title=${title}`, ...(locale ? [`--locale=${locale}`] : [])], '.');
if (!discover.ok) throw new Error(discover.stderr || 'discover failed');
const discoverJson = JSON.parse(discover.stdout);
manifest.steps.push({ step: 'discover', ok: true, outputPath: discoverJson.outputPath });
await writeJson(manifestPath, manifest);

const ragBuild = await runNodeScript('build-rag-index.mjs', []);
if (!ragBuild.ok) throw new Error(ragBuild.stderr || 'rag build failed');
manifest.steps.push({ step: 'rag-build', ok: true });
await writeJson(manifestPath, manifest);

const collectCandidates = await runLocalNode(
  './scripts/collect-discovery-urls.mjs',
  [`--runDir=${runDir}`, `--queryFile=${discoverJson.outputPath}`, `--title=${title}`, `--queryLimit=${queryLimit}`],
  '.',
);
if (!collectCandidates.ok) throw new Error(collectCandidates.stderr || 'collect-discovery-urls failed');
const candidatesJson = JSON.parse(collectCandidates.stdout);
const searchCandidates = await readJson(candidatesJson.outputPath);
manifest.steps.push({
  step: 'collect-discovery-urls',
  ok: true,
  queriesVisited: searchCandidates.queriesVisited,
  successfulQueries: searchCandidates.successfulQueries,
  total: searchCandidates.totalCandidates,
  outputPath: candidatesJson.outputPath,
});
await writeJson(manifestPath, manifest);

const inspections = [];
const allCandidates = searchCandidates.candidates || [];
const selectedCandidates = inspectLimit > 0 ? allCandidates.slice(0, inspectLimit) : allCandidates;
let reusableListingTabId = candidatesJson.reusableTabId || searchCandidates.reusableTabId || undefined;
const shortlistPath = path.join(runDir, 'shortlist.json');
let csvOutputPath = '';
let masterCsvPath = '';
let spreadsheetUrl = '';

for (let index = 0; index < selectedCandidates.length; index += 1) {
  const candidate = selectedCandidates[index];
  const candidateDir = path.join(candidatesDir, `${String(index + 1).padStart(2, '0')}-${slugify(candidate.text || candidate.url)}`);
  await ensureDir(candidateDir);
  await writeJson(path.join(candidateDir, 'search-selection.json'), { selectedCandidate: candidate, candidates: selectedCandidates });

  let inspectionTabId;
  try {
    if (reusableListingTabId) {
      const reused = await setChromeTabUrl(reusableListingTabId, candidate.url);
      inspectionTabId = reused.tabId;
    } else {
      const opened = await openChromeUrl(candidate.url);
      inspectionTabId = opened.tabId;
      reusableListingTabId = inspectionTabId;
    }
  } catch (error) {
    inspections.push({ index: index + 1, candidate, ok: false, error: String(error) });
    continue;
  }

  const deadline = Date.now() + 30000;
  let currentPage = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, candidatePollMs));
    const page = await getCurrentPageInfoFromBridge({ targetTabId: inspectionTabId });
    if (page?.url && !/google\./i.test(page.url)) {
      currentPage = page;
      break;
    }
  }

  if (!currentPage?.url) {
    inspections.push({ index: index + 1, candidate, ok: false, error: 'Navigation did not reach a non-search page' });
    continue;
  }

  const capture = await runLocalNode(
    './scripts/capture-current-listing.mjs',
    [`--runDir=${candidateDir}`, `--title=${title}`, ...(inspectionTabId ? [`--targetTabId=${inspectionTabId}`] : [])],
    '.',
    perCandidateTimeoutMs,
  );
  if (!capture.ok) {
    inspections.push({ index: index + 1, candidate, ok: false, error: capture.stderr || 'capture failed' });
    continue;
  }
  const captureJson = JSON.parse(capture.stdout);

  const applicationStructure = await runLocalNode(
    './scripts/extract-application-structure.mjs',
    [`--runDir=${candidateDir}`, `--posting=${captureJson.runPath}`],
    '.',
    perCandidateTimeoutMs,
  );

  const evidence = await runNodeScript('posting-to-evidence.mjs', [`--posting=${captureJson.runPath}`]);
  if (!evidence.ok) {
    inspections.push({ index: index + 1, candidate, ok: false, error: evidence.stderr || 'evidence failed' });
    continue;
  }

  const linkExtraction = await runLocalNode(
    './scripts/extract-html-links.mjs',
    [`--posting=${captureJson.runPath}`],
    '.',
    perCandidateTimeoutMs,
  );

  const evidenceJson = JSON.parse(evidence.stdout);
  const evidencePath = path.join(candidateDir, 'evidence.json');
  await writeJson(evidencePath, evidenceJson);

  const posting = await readJson(captureJson.runPath);
  const structureJson = applicationStructure.ok ? JSON.parse(applicationStructure.stdout) : null;
  const linksJson = linkExtraction.ok ? await readJson(JSON.parse(linkExtraction.stdout).outputPath) : null;
  posting.activityStatus = classifyPostingActivity(posting, structureJson, linksJson);
  await writeJson(captureJson.runPath, posting);
  const score = scoreInspectedCandidate(candidate, posting, evidenceJson);

  inspections.push({
    index: index + 1,
    ok: true,
    candidate,
    postingPath: captureJson.runPath,
    applicationStructurePath: structureJson?.outputPath || '',
    linksPath: linkExtraction.ok ? JSON.parse(linkExtraction.stdout).outputPath : '',
    evidencePath,
    candidateDir,
    company: posting.company,
    roleTitle: posting.roleTitle,
    postingUrl: posting.postingUrl,
    activityStatus: posting.activityStatus,
    score,
    topEvidence: (evidenceJson.results || []).slice(0, 3).map((item) => ({
      materialTitle: item.material_title,
      score: item.score,
      snippet: item.snippet,
    })),
  });

  const sync = await syncShortlistArtifacts({ shortlistPath, title, locale, inspections, noUpload });
  csvOutputPath = sync.csvOutputPath || csvOutputPath;
  masterCsvPath = sync.masterCsvPath || masterCsvPath;
  spreadsheetUrl = sync.spreadsheetUrl || spreadsheetUrl;

  if (index < selectedCandidates.length - 1 && betweenCandidatesMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, betweenCandidatesMs));
  }
}

const { shortlist } = await syncShortlistArtifacts({ shortlistPath, title, locale, inspections, noUpload });
if (!noUpload) {
  manifest.steps.push({
    step: 'upload-shortlist-sheet',
    ok: true,
    csvOutputPath,
    masterCsvPath,
    spreadsheetUrl,
  });
}

manifest.steps.push({ step: 'inspect-candidates', ok: true, inspected: selectedCandidates.length, shortlistPath });
manifest.status = 'completed';
await writeJson(manifestPath, manifest);

console.log(JSON.stringify({ runDir, shortlistPath, csvOutputPath, masterCsvPath, spreadsheetUrl, totalShortlisted: shortlist.length }, null, 2));
