#!/usr/bin/env node

import path from 'node:path';
import { RUNS_DIR, ensureDir, runNodeScript, slugify, stamp, writeJson } from './agent-utils.mjs';
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

function runLocal(command, commandArgs, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    child.on('error', (error) => resolve({ ok: false, code: -1, stdout, stderr: String(error) }));
  });
}

const title = getArg('title');
const locale = getArg('locale');

if (!title) {
  console.error('Usage: node scripts/run-job-cycle.mjs --title="production designer" [--locale="san francisco"]');
  process.exit(1);
}

const runDir = path.join(RUNS_DIR, `${stamp()}-${slugify(title)}`);
await ensureDir(runDir);
await ensureDir(path.join(runDir, 'artifacts'));

const manifest = {
  createdAt: new Date().toISOString(),
  title,
  locale,
  status: 'started',
  steps: [],
};
const manifestPath = path.join(runDir, 'run.json');
await writeJson(manifestPath, manifest);

const discover = await runLocal('node', ['./scripts/discover-jobs.mjs', `--title=${title}`, ...(locale ? [`--locale=${locale}`] : [])], '.');
if (!discover.ok) {
  manifest.status = 'failed';
  manifest.steps.push({ step: 'discover', ok: false, stderr: discover.stderr });
  await writeJson(manifestPath, manifest);
  process.exit(1);
}
const discoverJson = JSON.parse(discover.stdout);
manifest.steps.push({ step: 'discover', ok: true, outputPath: discoverJson.outputPath });

const openSearch = await runLocal('node', ['./scripts/open-discovery-search.mjs', `--runDir=${runDir}`, `--queryFile=${discoverJson.outputPath}`], '.');
if (!openSearch.ok) {
  manifest.status = 'failed';
  manifest.steps.push({ step: 'open-discovery-search', ok: false, stderr: openSearch.stderr });
  await writeJson(manifestPath, manifest);
  process.exit(1);
}
const openSearchJson = JSON.parse(openSearch.stdout);
manifest.steps.push({ step: 'open-discovery-search', ok: true, searchUrl: openSearchJson.searchUrl, currentUrl: openSearchJson.currentUrl, targetTabId: openSearchJson.targetTabId });

const ragBuild = await runNodeScript('build-rag-index.mjs', []);
if (!ragBuild.ok) {
  manifest.status = 'failed';
  manifest.steps.push({ step: 'rag-build', ok: false, stderr: ragBuild.stderr });
  await writeJson(manifestPath, manifest);
  process.exit(1);
}
manifest.steps.push({ step: 'rag-build', ok: true });

const resolveSearch = await runLocal('node', ['./scripts/resolve-search-result.mjs', `--runDir=${runDir}`, `--title=${title}`, ...(openSearchJson.targetTabId ? [`--targetTabId=${openSearchJson.targetTabId}`] : [])], '.');
if (!resolveSearch.ok) {
  manifest.status = 'failed';
  manifest.steps.push({ step: 'resolve-search-result', ok: false, stderr: resolveSearch.stderr });
  await writeJson(manifestPath, manifest);
  process.exit(1);
}
const resolveJson = JSON.parse(resolveSearch.stdout);
manifest.steps.push({ step: 'resolve-search-result', ok: true, selectedUrl: resolveJson.selectedUrl, selectedTitle: resolveJson.selectedTitle, targetTabId: resolveJson.targetTabId || openSearchJson.targetTabId });

const capture = await runLocal('node', ['./scripts/capture-current-listing.mjs', `--runDir=${runDir}`, `--title=${title}`, ...((resolveJson.targetTabId || openSearchJson.targetTabId) ? [`--targetTabId=${resolveJson.targetTabId || openSearchJson.targetTabId}`] : [])], '.');
if (!capture.ok) {
  manifest.status = 'failed';
  manifest.steps.push({ step: 'capture', ok: false, stderr: capture.stderr });
  await writeJson(manifestPath, manifest);
  process.exit(1);
}
const captureJson = JSON.parse(capture.stdout);
manifest.steps.push({ step: 'capture', ok: true, postingPath: captureJson.runPath, trackerPath: captureJson.trackerPath });

const applicationStructure = await runLocal('node', ['./scripts/extract-application-structure.mjs', `--runDir=${runDir}`, `--posting=${captureJson.runPath}`], '.');
if (!applicationStructure.ok) {
  manifest.status = 'failed';
  manifest.steps.push({ step: 'application-structure', ok: false, stderr: applicationStructure.stderr });
  await writeJson(manifestPath, manifest);
  process.exit(1);
}
const applicationStructureJson = JSON.parse(applicationStructure.stdout);
manifest.steps.push({ step: 'application-structure', ok: true, outputPath: applicationStructureJson.outputPath, vendor: applicationStructureJson.vendor });

const evidence = await runNodeScript('posting-to-evidence.mjs', [`--posting=${captureJson.runPath}`]);
if (!evidence.ok) {
  manifest.status = 'failed';
  manifest.steps.push({ step: 'evidence', ok: false, stderr: evidence.stderr });
  await writeJson(manifestPath, manifest);
  process.exit(1);
}
const evidencePath = path.join(runDir, 'evidence.json');
await writeJson(evidencePath, JSON.parse(evidence.stdout));
manifest.steps.push({ step: 'evidence', ok: true, evidencePath });

const pack = await runLocal('node', ['./scripts/generate-pack.mjs', `--runDir=${runDir}`, `--posting=${captureJson.runPath}`, `--evidence=${evidencePath}`], '.');
if (!pack.ok) {
  manifest.status = 'failed';
  manifest.steps.push({ step: 'pack', ok: false, stderr: pack.stderr });
  await writeJson(manifestPath, manifest);
  process.exit(1);
}
const packJson = JSON.parse(pack.stdout);
manifest.steps.push({ step: 'pack', ok: true, outputs: packJson });

const answerPlan = await runLocal(
  'node',
  [
    './scripts/plan-application-answers.mjs',
    `--runDir=${runDir}`,
    `--posting=${captureJson.runPath}`,
    `--application=${applicationStructureJson.outputPath}`,
    `--evidence=${evidencePath}`,
    `--resumeOutputPath=${packJson.resumeOutputPath}`,
  ],
  '.',
);
if (!answerPlan.ok) {
  manifest.status = 'failed';
  manifest.steps.push({ step: 'application-answer-plan', ok: false, stderr: answerPlan.stderr });
  await writeJson(manifestPath, manifest);
  process.exit(1);
}
const answerPlanJson = JSON.parse(answerPlan.stdout);
manifest.steps.push({ step: 'application-answer-plan', ok: true, outputPath: answerPlanJson.outputPath });

manifest.status = 'completed';
await writeJson(manifestPath, manifest);

console.log(JSON.stringify({ runDir, manifestPath, steps: manifest.steps }, null, 2));
