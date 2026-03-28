#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { callBridge, getCurrentPageInfoFromBridge, saveCurrentPageFromBridge } from '../scripts/bridge-utils.mjs';
import { ensureDir, openChromeUrl, slugify, writeJson } from './agent-utils.mjs';

const WORKSPACE = 'process.env.WORKSPACE';
const SITE_LIST = 'process.env.WORKSPACE/github-projects/lukes-tools/job-search-sites/subdomains.txt';

const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
}

function decodeSearchRedirect(rawHref) {
  try {
    const parsed = new URL(rawHref);
    if (/google\./i.test(parsed.hostname) && parsed.pathname === '/url') {
      return parsed.searchParams.get('q') || parsed.searchParams.get('url') || rawHref;
    }
    if (/duckduckgo\.com/i.test(parsed.hostname) && parsed.pathname.startsWith('/l/')) {
      return parsed.searchParams.get('uddg') || rawHref;
    }
    return rawHref;
  } catch {
    return rawHref;
  }
}

function isSearchEngineUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '');
    return ['google.com', 'bing.com', 'duckduckgo.com', 'search.yahoo.com'].some((engine) => host === engine || host.endsWith(`.${engine}`));
  } catch {
    return false;
  }
}

function isLikelyJobUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const value = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    return /(careers?|jobs?|job-boards?|greenhouse|lever|workday|myworkdayjobs|ashby|smartrecruiters|boards\.greenhouse|jobs\.lever)/.test(value);
  } catch {
    return false;
  }
}

function isGenericCommunityUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const value = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    return /talentnet\.community/.test(value);
  } catch {
    return false;
  }
}

async function loadAtsHints() {
  const raw = await fs.readFile(SITE_LIST, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/^site:/, '').replace(/[" ].*$/, '').trim())
    .filter(Boolean);
}

function scoreCandidate(candidate, titleTerms, atsHints) {
  const text = `${candidate.text || ''} ${candidate.url || ''}`.toLowerCase();
  let score = 0;
  let termMatches = 0;

  for (const term of titleTerms) {
    if (text.includes(term)) {
      score += 4;
      termMatches += 1;
    }
  }

  if (isLikelyJobUrl(candidate.url)) score += 10;
  if (candidate.url && !isSearchEngineUrl(candidate.url)) score += 2;
  if ((candidate.text || '').length >= 12) score += 1;

  for (const hint of atsHints) {
    if (hint && candidate.url.includes(hint)) {
      score += 6;
      break;
    }
  }

  if (/apply|view job|job opening|career/i.test(candidate.text || '')) score += 2;
  if (/talent community|community/i.test(candidate.text || '')) score -= 6;
  if (/contract/.test(candidate.text || '')) score -= 1;
  if (/read more/i.test(candidate.text || '')) score -= 8;
  if (isGenericCommunityUrl(candidate.url)) score -= 5;
  if (/linkedin|facebook|instagram|youtube|reddit|x\.com|twitter/i.test(candidate.url)) score -= 8;
  if (/google\./i.test(candidate.url) || /bing\./i.test(candidate.url)) score -= 10;
  if (termMatches === 0) score -= 20;
  if (titleTerms.length >= 2 && termMatches < 2) score -= 6;

  return score;
}

const runDir = getArg('runDir');
const title = getArg('title');
const bridgeBaseUrl = getArg('bridgeBaseUrl', 'http://127.0.0.1:4471');
const targetTabIdValue = getArg('targetTabId');
const explicitTargetTabId = targetTabIdValue ? Number(targetTabIdValue) : undefined;

if (!runDir || !title) {
  console.error('Usage: node scripts/resolve-search-result.mjs --runDir=/path --title="production designer"');
  process.exit(1);
}

await ensureDir(runDir);

const snapshot = await getCurrentPageInfoFromBridge({ bridgeBaseUrl, targetTabId: explicitTargetTabId });
const currentUrl = snapshot.url || '';
const currentTitle = snapshot.title || '';

if (!isSearchEngineUrl(currentUrl) && isLikelyJobUrl(currentUrl)) {
  const passthroughPath = path.join(runDir, 'search-selection.json');
  await writeJson(passthroughPath, {
    mode: 'passthrough',
    selectedUrl: currentUrl,
    selectedTitle: currentTitle,
    candidates: [],
  });
  console.log(JSON.stringify({ mode: 'passthrough', selectedUrl: currentUrl, selectedTitle: currentTitle, outputPath: passthroughPath }, null, 2));
  process.exit(0);
}

const bridgeResult = await callBridge(
  {
    type: 'RUN_SNIPPET',
    targetTabId: explicitTargetTabId,
    payload: {
      world: 'MAIN',
      snippetName: 'extract search results',
      code: `
        const items = Array.from(document.querySelectorAll('a[href]'))
          .map((anchor) => ({
            href: anchor.href || '',
            text: (anchor.innerText || anchor.textContent || '').replace(/\\s+/g, ' ').trim()
          }))
          .filter((item) => item.href && item.text)
          .slice(0, 400);
        return {
          pageUrl: location.href,
          pageTitle: document.title,
          items
        };
      `,
    },
  },
  { baseUrl: bridgeBaseUrl, timeoutMs: 20000 },
);

if (!bridgeResult.ok) {
  throw new Error(bridgeResult.error?.message || bridgeResult.error || 'Search result extraction failed');
}

const rawItems = bridgeResult.run?.result?.items || [];
const titleTerms = tokenize(title);
const atsHints = await loadAtsHints();
const deduped = new Map();

for (const item of rawItems) {
  const decodedUrl = decodeSearchRedirect(item.href || '');
  if (!decodedUrl.startsWith('http')) continue;
  const key = decodedUrl;
  if (!deduped.has(key)) {
    deduped.set(key, { url: decodedUrl, text: item.text || '' });
  }
}

const candidates = Array.from(deduped.values())
  .map((candidate) => ({
    ...candidate,
    score: scoreCandidate(candidate, titleTerms, atsHints),
  }))
  .filter((candidate) => candidate.score > 0)
  .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
  .slice(0, 20);

if (!candidates.length) {
  throw new Error('No likely job listing candidates were found on the active search results page.');
}

const selected = candidates[0];

let navigationTabId = explicitTargetTabId;
try {
  const navigationResult = await callBridge(
    {
      type: 'OPEN_URL',
      targetTabId: explicitTargetTabId,
      payload: {
        url: selected.url,
        active: true,
      },
    },
    { baseUrl: bridgeBaseUrl, timeoutMs: 10000 },
  );
  navigationTabId = navigationResult?.run?.tabId || explicitTargetTabId;
} catch {
  const opened = await openChromeUrl(selected.url);
  navigationTabId = opened.tabId;
}

let finalPage = null;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const page = await getCurrentPageInfoFromBridge({ bridgeBaseUrl, targetTabId: navigationTabId });
  if (page?.url && page.url !== currentUrl && !isSearchEngineUrl(page.url)) {
    finalPage = page;
    break;
  }
}

const outputPath = path.join(runDir, 'search-selection.json');
await writeJson(outputPath, {
  mode: 'resolved',
  sourceUrl: currentUrl,
  sourceTitle: currentTitle,
  selectedUrl: finalPage?.url || selected.url,
  selectedTitle: finalPage?.title || selected.text,
  selectedCandidate: selected,
  candidates,
});

console.log(
  JSON.stringify(
    {
      mode: 'resolved',
      selectedUrl: finalPage?.url || selected.url,
      selectedTitle: finalPage?.title || selected.text,
      targetTabId: navigationTabId,
      outputPath,
    },
    null,
    2,
  ),
);
