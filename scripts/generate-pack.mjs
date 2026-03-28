#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE, ensureDir, normalizeResumeText, readJson, slugify } from './agent-utils.mjs';

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
const postingPath = getArg('posting');
const evidencePath = getArg('evidence');

if (!runDir || !postingPath || !evidencePath) {
  console.error('Usage: node scripts/generate-pack.mjs --runDir=/path --posting=/path/posting.json --evidence=/path/evidence.json');
  process.exit(1);
}

const profile = await readJson(path.join(WORKSPACE, 'resume', 'profile.json'));
const posting = await readJson(postingPath);
const evidence = await readJson(evidencePath);
const canonicalResumePath = profile.canonical_resume_sources?.find((file) => file.endsWith('.txt'));
const resumeText = canonicalResumePath ? await fs.readFile(canonicalResumePath, 'utf8') : '';

const packDir = path.join(runDir, 'artifacts');
await ensureDir(packDir);

const resumeOutputPath = path.join(packDir, `${slugify(posting.company)}-${slugify(posting.roleTitle)}-resume.txt`);
const emailOutputPath = path.join(packDir, `${slugify(posting.company)}-${slugify(posting.roleTitle)}-outreach-email.html`);
const evidenceOutputPath = path.join(packDir, `${slugify(posting.company)}-${slugify(posting.roleTitle)}-evidence.json`);

const evidenceList = evidence.results || [];
const tailoredResume = normalizeResumeText(resumeText, posting, evidenceList);

const emailHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${posting.roleTitle} Outreach</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1d1d1f; background: #f5f5f7; margin: 0; padding: 24px; }
    .card { max-width: 760px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 32px; box-shadow: 0 8px 32px rgba(0,0,0,0.08); }
    h1 { font-size: 22px; margin: 0 0 16px; }
    p { line-height: 1.55; margin: 0 0 14px; }
    ul { margin: 0 0 16px 20px; }
    li { margin-bottom: 8px; }
    .meta { color: #666; font-size: 14px; margin-bottom: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${posting.roleTitle}</h1>
    <div class="meta">${posting.company} ${posting.postingUrl ? `• <a href="${posting.postingUrl}">${posting.postingUrl}</a>` : ''}</div>
    <p>Hello,</p>
    <p>I’m a Production Designer with 22 years of experience across design systems, shared libraries, QA, workflow automation, and design education. I’m reaching out because the ${posting.roleTitle} opening at ${posting.company} aligns closely with the work I’ve done building and maintaining production-quality design resources and supporting teams through systems, tooling, and enablement.</p>
    <p>The strongest evidence from my background for this role includes:</p>
    <ul>
      ${evidenceList.slice(0, 5).map((item) => `<li><strong>${item.material_title}</strong>: ${item.snippet.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</li>`).join('')}
    </ul>
    <p>If useful, I can share a tighter role-specific resume and a smaller set of supporting links focused on the most relevant systems, libraries, and workflow examples.</p>
    <p>Best,<br />Luke Carter</p>
  </div>
</body>
</html>`;

await fs.writeFile(resumeOutputPath, tailoredResume, 'utf8');
await fs.writeFile(emailOutputPath, emailHtml, 'utf8');
await fs.writeFile(evidenceOutputPath, JSON.stringify(evidence, null, 2), 'utf8');

console.log(JSON.stringify({ resumeOutputPath, emailOutputPath, evidenceOutputPath }, null, 2));
