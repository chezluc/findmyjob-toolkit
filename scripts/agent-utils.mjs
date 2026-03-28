#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { callBridge } from '../scripts/bridge-utils.mjs';

export const WORKSPACE = 'process.env.WORKSPACE';
export const EXTENSION_DIR = path.join(WORKSPACE, 'findmeajob-gemini-extension');
export const RUNS_DIR = path.join(WORKSPACE, 'runs');

export function slugify(value) {
  return String(value || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function stamp() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function runNodeScript(scriptName, args = []) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(EXTENSION_DIR, 'scripts', scriptName), ...args], {
      cwd: WORKSPACE,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => resolve({ code, ok: code === 0, stdout, stderr }));
    child.on('error', (error) => resolve({ code: -1, ok: false, stdout, stderr: String(error) }));
  });
}

export async function runLocalNode(scriptPath, args = [], cwd = WORKSPACE, timeoutMs = 0) {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath, ...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          resolve({ code: -2, ok: false, stdout, stderr: `${stderr}${stderr ? '\n' : ''}Timed out after ${timeoutMs}ms` });
        }, timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, ok: code === 0, stdout, stderr });
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: -1, ok: false, stdout, stderr: String(error) });
    });
  });
}

export async function openChromeUrl(url) {
  const bridgeResult = await callBridge(
    {
      type: 'OPEN_URL',
      payload: {
        url,
        active: false,
      },
    },
    { baseUrl: 'http://127.0.0.1:4471', timeoutMs: 10000 },
  );

  if (!bridgeResult?.ok || !bridgeResult?.run?.tabId) {
    throw new Error('Bridge failed to open URL');
  }

  return {
    tabId: Number(bridgeResult.run.tabId) || undefined,
    url,
  };
}

export async function setChromeTabUrl(tabId, url) {
  const bridgeResult = await callBridge(
    {
      type: 'OPEN_URL',
      targetTabId: Number(tabId),
      payload: {
        url,
        active: false,
      },
    },
    { baseUrl: 'http://127.0.0.1:4471', timeoutMs: 10000 },
  );

  if (!bridgeResult?.ok || !bridgeResult?.run?.tabId) {
    throw new Error('Bridge failed to reuse tab URL');
  }

  return {
    tabId: Number(bridgeResult.run.tabId) || Number(tabId) || undefined,
    url,
  };
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export function htmlToText(raw) {
  return String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(div|section|article|li|h1|h2|h3|h4|h5|h6)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTitle(html, fallback = '') {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) return htmlToText(h1[1]).slice(0, 200);
  return fallback;
}

export function extractCompany(pageUrl, pageTitle = '') {
  try {
    const url = new URL(pageUrl);
    const host = url.hostname.replace(/^www\./, '');
    const parts = host.split('.');
    const base = parts.length >= 2 ? parts[parts.length - 2] : host;
    const fromTitle = pageTitle.split(/[\-|–|—|·]/).map((s) => s.trim()).filter(Boolean);
    const titleGuess = fromTitle.find((part) => part.length > 2 && !/job|careers?|apply|opening/i.test(part));
    return titleGuess || base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return '';
  }
}

export function normalizeResumeText(resumeText, posting, evidence) {
  const lead = [
    `${posting.roleTitle || 'Role'} at ${posting.company || 'Company'}`,
    posting.postingUrl ? `Posting URL: ${posting.postingUrl}` : '',
    '',
    resumeText.trim(),
    '',
    'Selected supporting evidence for this role:',
    ...evidence.slice(0, 8).map((item, index) => {
      const tags = (item.tags || []).join(', ');
      return `${index + 1}. ${item.material_title}${tags ? ` [${tags}]` : ''}\n${item.snippet}`;
    }),
  ].filter(Boolean);
  return lead.join('\n');
}
