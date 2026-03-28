#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { callBridge } from '../scripts/bridge-utils.mjs';
import { ensureDir, writeJson } from './agent-utils.mjs';

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

function isGenericUiText(value) {
  const text = String(value || '').trim().toLowerCase();
  return [
    'read more',
    'past 24 hours',
    'past week',
    'past month',
    'past year',
    'short videos',
    'ai mode',
    'images',
    'videos',
    'news',
    'shopping',
    'forums',
    'maps',
    'tools',
    'more',
    'jobs',
    'all',
  ].includes(text) || /repeat the search with the omitted results included/.test(text);
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
const targetTabId = targetTabIdValue ? Number(targetTabIdValue) : undefined;
const limit = Number(getArg('limit', '12'));

if (!runDir || !title) {
  console.error('Usage: node scripts/extract-search-candidates.mjs --runDir=/path --title="production designer" [--targetTabId=123]');
  process.exit(1);
}

await ensureDir(runDir);
const bridgeResult = await callBridge(
  {
    type: 'RUN_SNIPPET',
    targetTabId,
    payload: {
      world: 'MAIN',
      snippetName: 'extract search candidates',
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
  throw new Error(bridgeResult.error?.message || bridgeResult.error || 'Search candidate extraction failed');
}

const rawItems = bridgeResult.run?.result?.items || [];
const titleTerms = tokenize(title);
const atsHints = await loadAtsHints();
const deduped = new Map();

for (const item of rawItems) {
  const decodedUrl = decodeSearchRedirect(item.href || '');
  if (!decodedUrl.startsWith('http')) continue;
  if (isSearchEngineUrl(decodedUrl)) continue;
  if (isGenericUiText(item.text || '')) continue;
  if (/#:~:text=/i.test(decodedUrl) && isGenericUiText(item.text || 'read more')) continue;
  const key = decodedUrl;
  if (!deduped.has(key)) deduped.set(key, { url: decodedUrl, text: item.text || '' });
}

const candidates = Array.from(deduped.values())
  .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, titleTerms, atsHints) }))
  .filter((candidate) => candidate.score > 0)
  .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
  .slice(0, limit);

const outputPath = path.join(runDir, 'search-candidates.json');
await writeJson(outputPath, {
  sourceUrl: bridgeResult.run?.result?.pageUrl || '',
  sourceTitle: bridgeResult.run?.result?.pageTitle || '',
  targetTabId,
  title,
  total: candidates.length,
  candidates,
});

console.log(JSON.stringify({ outputPath, total: candidates.length, targetTabId }, null, 2));
