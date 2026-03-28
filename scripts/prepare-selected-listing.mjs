#!/usr/bin/env node

import path from 'node:path';
import { ensureDir, readJson, runLocalNode, writeJson } from './agent-utils.mjs';

const args = process.argv.slice(2);
function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

const shortlistPath = getArg('shortlist');
const rank = Number(getArg('rank', '1'));

if (!shortlistPath) {
  console.error('Usage: node scripts/prepare-selected-listing.mjs --shortlist=/path/to/shortlist.json [--rank=1]');
  process.exit(1);
}

const shortlistData = await readJson(shortlistPath);
const selected = (shortlistData.shortlist || []).find((item) => Number(item.rank) === rank);
if (!selected) {
  throw new Error(`No shortlist item found for rank ${rank}`);
}

const candidateDir = selected.candidateDir;
await ensureDir(path.join(candidateDir, 'artifacts'));

const pack = await runLocalNode(
  './scripts/generate-pack.mjs',
  [`--runDir=${candidateDir}`, `--posting=${selected.postingPath}`, `--evidence=${selected.evidencePath}`],
  '.',
);
if (!pack.ok) throw new Error(pack.stderr || 'generate-pack failed');
const packJson = JSON.parse(pack.stdout);

const answerPlan = await runLocalNode(
  './scripts/plan-application-answers.mjs',
  [
    `--runDir=${candidateDir}`,
    `--posting=${selected.postingPath}`,
    `--application=${selected.applicationStructurePath}`,
    `--evidence=${selected.evidencePath}`,
    `--resumeOutputPath=${packJson.resumeOutputPath}`,
  ],
  '.',
);
if (!answerPlan.ok) throw new Error(answerPlan.stderr || 'plan-application-answers failed');
const answerPlanJson = JSON.parse(answerPlan.stdout);

const preparedPath = path.join(candidateDir, 'prepared.json');
await writeJson(preparedPath, {
  preparedAt: new Date().toISOString(),
  shortlistPath,
  rank,
  selected,
  outputs: {
    ...packJson,
    applicationAnswerPlanPath: answerPlanJson.outputPath,
  },
});

console.log(JSON.stringify({ candidateDir, preparedPath, outputs: { ...packJson, applicationAnswerPlanPath: answerPlanJson.outputPath } }, null, 2));
