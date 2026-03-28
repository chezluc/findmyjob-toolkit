#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './agent-utils.mjs';

const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function classifyLink(url, text = '') {
  const value = `${url} ${text}`.toLowerCase();
  if (/greenhouse|lever|workday|smartrecruiters|ashby|apply/.test(value)) return 'application';
  if (/linkedin|portfolio|github|youtube|vimeo|behance|dribbble/.test(value)) return 'profile';
  if (/privacy|terms|legal|eeo|accessibility/.test(value)) return 'policy';
  if (/careers|jobs/.test(value)) return 'company-jobs';
  if (/\.(css|js|png|jpg|jpeg|svg|webp|gif|woff|woff2)(\?|$)/.test(value)) return 'asset';
  return 'other';
}

const postingPath = getArg('posting');
const htmlPathArg = getArg('html');
const outputPathArg = getArg('output');

if (!postingPath && !htmlPathArg) {
  console.error('Usage: node scripts/extract-html-links.mjs --posting=/path/to/posting.json [--output=/path/to/links.json]');
  process.exit(1);
}

const posting = postingPath ? await readJson(postingPath) : null;
const htmlPath = htmlPathArg || posting?.rawHtmlPath;
if (!htmlPath) {
  throw new Error('No raw HTML path available');
}

const html = await fs.readFile(htmlPath, 'utf8');
const baseUrl = posting?.postingUrl || '';
const matches = Array.from(html.matchAll(/<a\b([^>]*?)href=(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi));
const byHref = new Map();

for (const match of matches) {
  const href = decodeEntities(match[3] || '').trim();
  if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;

  let resolvedHref = href;
  try {
    resolvedHref = new URL(href, baseUrl || undefined).toString();
  } catch {
    resolvedHref = href;
  }

  const text = stripTags(match[5] || '');
  const relMatch = `${match[1] || ''} ${match[4] || ''}`.match(/\brel=(["'])(.*?)\1/i);
  const targetMatch = `${match[1] || ''} ${match[4] || ''}`.match(/\btarget=(["'])(.*?)\1/i);

  const existing = byHref.get(resolvedHref);
  const next = {
    href: resolvedHref,
    rawHref: href,
    text,
    rel: relMatch?.[2] || '',
    target: targetMatch?.[2] || '',
    kind: classifyLink(resolvedHref, text),
  };

  if (!existing || (next.text.length > existing.text.length)) {
    byHref.set(resolvedHref, next);
  }
}

const links = Array.from(byHref.values()).sort((a, b) => a.kind.localeCompare(b.kind) || a.href.localeCompare(b.href));
const outputPath = outputPathArg || path.join(path.dirname(htmlPath), 'links.json');

await writeJson(outputPath, {
  createdAt: new Date().toISOString(),
  sourceHtmlPath: htmlPath,
  postingPath: postingPath || '',
  baseUrl,
  total: links.length,
  links,
});

console.log(JSON.stringify({ outputPath, total: links.length }, null, 2));
