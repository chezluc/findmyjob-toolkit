#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { saveCurrentPageFromBridge } from '../scripts/bridge-utils.mjs';
import { WORKSPACE, extractCompany, extractTitle, htmlToText, slugify, writeJson } from './agent-utils.mjs';

const args = process.argv.slice(2);
function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function isGenericListingTitle(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  return [
    'talent community',
    'wells fargo talent community',
    'careers',
    'jobs',
    'job search',
  ].includes(text);
}

function deriveFromSelectedCandidate(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { roleTitle: '', company: '' };
  let cleaned = raw.replace(/\s+https?:\/\/\S+$/i, '').trim();
  cleaned = cleaned.replace(/\s+Greenhouse$/i, '').trim();
  const parts = cleaned.split(/\s+-\s+/).map((item) => item.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      roleTitle: parts[0],
      company: parts[1],
    };
  }
  return { roleTitle: '', company: '' };
}

function deriveFromPageTitle(pageTitle) {
  const text = String(pageTitle || '').trim();
  const match = text.match(/^Job Application for\s+(.+?)\s+at\s+(.+)$/i);
  if (match) {
    return {
      roleTitle: match[1].trim(),
      company: match[2].trim(),
    };
  }
  const dashParts = text.split(/\s[-–—]\s/).map((item) => item.trim()).filter(Boolean);
  if (dashParts.length >= 2) {
    const [first, ...rest] = dashParts;
    const tail = rest.join(' - ').trim();
    if (first && tail) {
      return {
        roleTitle: tail,
        company: first,
      };
    }
  }
  return { roleTitle: '', company: '' };
}

const runDir = getArg('runDir');
const titleHint = getArg('title');
const targetTabIdValue = getArg('targetTabId');
const targetTabId = targetTabIdValue ? Number(targetTabIdValue) : undefined;
const bridgeBaseUrl = getArg('bridgeBaseUrl', 'http://127.0.0.1:4471');

if (!runDir) {
  console.error('Usage: node scripts/capture-current-listing.mjs --runDir=/path/to/run [--title="production designer"]');
  process.exit(1);
}

await fs.mkdir(runDir, { recursive: true });

const page = await saveCurrentPageFromBridge({ targetTabId, bridgeBaseUrl });
let roleTitle = extractTitle(page.html || '', page.title || titleHint || '').trim() || titleHint || 'Untitled Role';
let company = extractCompany(page.url || '', page.title || '').trim() || 'Unknown Company';
let selectedCandidateText = '';
const titleDerived = deriveFromPageTitle(page.title || '');

if (titleDerived.roleTitle) roleTitle = titleDerived.roleTitle;
if (titleDerived.company) company = titleDerived.company;

try {
  const selectionPath = path.join(runDir, 'search-selection.json');
  const selection = JSON.parse(await fs.readFile(selectionPath, 'utf8'));
  selectedCandidateText = selection?.selectedCandidate?.text || '';
  const derived = deriveFromSelectedCandidate(selection?.selectedCandidate?.text || '');
  if (derived.roleTitle && isGenericListingTitle(roleTitle)) {
    roleTitle = derived.roleTitle;
  }
  if (derived.company && /talent community|unknown company|greenhouse/i.test(company)) {
    company = derived.company;
  }
} catch {
  // No search selection metadata available for this run.
}

const postingText = [selectedCandidateText, htmlToText(page.html || '')].filter(Boolean).join('\n\n').trim();
const rawHtmlPath = path.join(runDir, 'posting.raw.html');

const posting = {
  capturedAt: new Date().toISOString(),
  company,
  roleTitle,
  postingUrl: page.url || '',
  pageTitle: page.title || '',
  postingText,
  rawHtmlLength: (page.html || '').length,
  rawHtmlPath,
  source: 'active-browser-page',
  titleHint,
};

const postingsDir = path.join(WORKSPACE, 'trackers', 'postings');
await fs.mkdir(postingsDir, { recursive: true });
const trackerPath = path.join(postingsDir, `${slugify(company)}-${slugify(roleTitle)}.json`);
const runPath = path.join(runDir, 'posting.json');

await fs.writeFile(rawHtmlPath, page.html || '', 'utf8');
await writeJson(trackerPath, posting);
await writeJson(runPath, posting);

console.log(JSON.stringify({ runPath, trackerPath, rawHtmlPath, company, roleTitle, postingUrl: posting.postingUrl, targetTabId }, null, 2));
