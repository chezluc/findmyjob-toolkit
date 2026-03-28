#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const WORKSPACE = 'process.env.WORKSPACE';
const SITE_LIST = 'process.env.WORKSPACE/github-projects/lukes-tools/job-search-sites/subdomains.txt';
const OUTPUT_DIR = path.join(WORKSPACE, 'runs', 'discovery');

const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const long = `--${name}=`;
  const direct = args.find((item) => item.startsWith(long));
  if (direct) return direct.slice(long.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function slugify(value) {
  return String(value || 'query')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const title = getArg('title');
const locale = getArg('locale');

if (!title) {
  console.error('Usage: node scripts/discover-jobs.mjs --title="production designer" [--locale="san francisco"]');
  process.exit(1);
}

const raw = await fs.readFile(SITE_LIST, 'utf8');
const templates = raw
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

const queries = templates.map((template) => {
  let query = template;
  if (query.includes('"job title"')) {
    query = query.replace(/"job title"/g, `"${title}"`);
  } else {
    query = `${query} "${title}"`;
  }
  if (locale) query = `${query} "${locale}"`;
  return {
    template,
    query: query.trim(),
  };
});

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const outputPath = path.join(OUTPUT_DIR, `${slugify(title)}${locale ? `-${slugify(locale)}` : ''}.queries.json`);

const payload = {
  generatedAt: new Date().toISOString(),
  title,
  locale,
  siteList: SITE_LIST,
  total: queries.length,
  queries,
};

await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
console.log(JSON.stringify({ outputPath, total: queries.length }, null, 2));
