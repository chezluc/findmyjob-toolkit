#!/usr/bin/env node

import path from 'node:path';
import { callBridge, getCurrentPageInfoFromBridge } from '../scripts/bridge-utils.mjs';
import { ensureDir, openChromeUrl, readJson, writeJson } from './agent-utils.mjs';

const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

const runDir = getArg('runDir');
const queryFile = getArg('queryFile');
const bridgeBaseUrl = getArg('bridgeBaseUrl', 'http://127.0.0.1:4471');

if (!runDir || !queryFile) {
  console.error('Usage: node scripts/open-discovery-search.mjs --runDir=/path --queryFile=/path/to/queries.json');
  process.exit(1);
}

await ensureDir(runDir);
const queryData = await readJson(queryFile);
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
    if (text.includes(hint) || template.includes(hint)) {
      return index;
    }
  }

  if (/talentnet\.community|willhire\.com|fiverr\.com|upwork\.com|freelancer\.com|toptal\.com/.test(text)) {
    return 999;
  }

  return 500;
}

const sortedQueries = [...(queryData.queries || [])].sort((a, b) => queryPriority(a) - queryPriority(b));
const firstQuery = sortedQueries?.[0]?.query;

if (!firstQuery) {
  throw new Error(`No queries found in ${queryFile}`);
}

const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(firstQuery)}`;
let targetTabId;
try {
  const navigationResult = await callBridge(
    {
      type: 'OPEN_URL',
      payload: {
        url: searchUrl,
        active: true,
      },
    },
    { baseUrl: bridgeBaseUrl, timeoutMs: 10000 },
  );
  targetTabId = navigationResult?.run?.tabId;
} catch {
  // Fall back to direct Chrome tab creation if the extension navigation handler is unavailable.
}

if (!targetTabId) {
  const opened = await openChromeUrl(searchUrl);
  targetTabId = opened.tabId;
}

let after = null;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const page = await getCurrentPageInfoFromBridge({ bridgeBaseUrl, targetTabId });
  if (page?.url && page.url !== 'chrome://newtab/' && page.url !== 'about:blank') {
    after = page;
    break;
  }
}

const outputPath = path.join(runDir, 'search-page.json');
await writeJson(outputPath, {
  queryFile,
  query: firstQuery,
  availableQueryCount: sortedQueries.length,
  targetTabId,
  searchUrl,
  currentUrl: after?.url || searchUrl,
  currentTitle: after?.title || '',
});

console.log(JSON.stringify({ outputPath, query: firstQuery, searchUrl, currentUrl: after?.url || searchUrl, targetTabId }, null, 2));
