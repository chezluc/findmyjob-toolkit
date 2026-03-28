#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
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

function runPython(pythonPath, scriptPath, runArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(pythonPath, [scriptPath, ...runArgs], {
      cwd: 'process.env.CLAUDEPROJECTS',
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
    child.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    child.on('error', (error) => resolve({ ok: false, code: -1, stdout, stderr: String(error) }));
  });
}

function extractSpreadsheetUrl(output) {
  const match = String(output || '').match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[^\s]+/);
  return match?.[0] || '';
}

function openInChrome(url) {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', 'Google Chrome', url], (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const SHEET_TRACKER_PATH = 'process.env.WORKSPACE/trackers/google-sheet-target.json';

const shortlistPath = getArg('shortlist');
const csvPath = getArg('csv');
const spreadsheetNameArg = getArg('name');
const noOpen = args.includes('--noOpen');

if (!shortlistPath || !csvPath) {
  console.error('Usage: node scripts/upload-shortlist-sheet.mjs --shortlist=/path/to/shortlist.json --csv=/path/to/shortlist.csv [--name="Spreadsheet Name"] [--noOpen]');
  process.exit(1);
}

const shortlist = await readJson(shortlistPath);
const spreadsheetName = spreadsheetNameArg || `${shortlist.title || 'Job Research'} Research ${new Date().toISOString().slice(0, 10)}`;
const pythonPath = 'process.env.CLAUDEPROJECTS/gsheets_venv/bin/python';
const uploaderPath = 'process.env.CLAUDEPROJECTS/upload_csv_to_google_sheets.py';
const existingUploaderPath = './scripts/upload_csv_to_existing_google_sheet.py';

let existingSheetUrl = '';
try {
  const tracker = JSON.parse(await fs.readFile(SHEET_TRACKER_PATH, 'utf8'));
  existingSheetUrl = tracker.spreadsheetUrl || '';
} catch {
  // No saved target yet.
}

const run = existingSheetUrl
  ? await runPython(pythonPath, existingUploaderPath, [csvPath, existingSheetUrl])
  : await runPython(pythonPath, uploaderPath, [csvPath, spreadsheetName]);
if (!run.ok) {
  console.error(run.stderr || run.stdout || 'Spreadsheet upload failed');
  process.exit(run.code || 1);
}

const spreadsheetUrl = extractSpreadsheetUrl(`${run.stdout}\n${run.stderr}`);
if (spreadsheetUrl) {
  await writeJson(SHEET_TRACKER_PATH, {
    spreadsheetName,
    spreadsheetUrl,
    updatedAt: new Date().toISOString(),
    csvPath,
  });
}
if (!noOpen && spreadsheetUrl) {
  try {
    await openInChrome(spreadsheetUrl);
  } catch {
    // Non-fatal.
  }
}

console.log(JSON.stringify({ spreadsheetName, spreadsheetUrl, reusedExisting: Boolean(existingSheetUrl), stdout: run.stdout.trim() }, null, 2));
