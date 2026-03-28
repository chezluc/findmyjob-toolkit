#!/usr/bin/env node

import fs from 'node:fs/promises';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const WORKSPACE = 'process.env.WORKSPACE';
const SYSTEM_PROMPT_PATH = path.join(WORKSPACE, 'findmeajob-agent', 'prompts', 'research-system-prompt.md');
const DEFAULT_ENGINE_ORDER = ['gemini', 'codex', 'claude', 'deepseek-api'];

const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const long = `--${name}=`;
  const direct = args.find((item) => item.startsWith(long));
  if (direct) return direct.slice(long.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn('zsh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function detectEngines() {
  const available = [];
  if (await commandExists('gemini')) available.push('gemini');
  if (await commandExists('codex')) available.push('codex');
  if (await commandExists('claude')) available.push('claude');
  if (process.env.DEEPSEEK_API_KEY) available.push('deepseek-api');
  return available;
}

async function readSystemPrompt() {
  return fs.readFile(SYSTEM_PROMPT_PATH, 'utf8');
}

function formatPrompt(systemPrompt, userPrompt) {
  return `${systemPrompt.trim()}\n\nUser task:\n${userPrompt.trim()}`;
}

async function runProcess(command, commandArgs, { cwd = WORKSPACE } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });

    child.on('error', (error) => {
      resolve({ ok: false, code: -1, stdout, stderr: String(error) });
    });
  });
}

async function runDeepSeek(fullPrompt) {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      messages: [{ role: 'user', content: fullPrompt }],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, code: response.status, stdout: '', stderr: body };
  }

  const data = await response.json();
  return {
    ok: true,
    code: 0,
    stdout: data.choices?.[0]?.message?.content || '',
    stderr: '',
  };
}

async function executeWithEngine(engine, promptText) {
  const systemPrompt = await readSystemPrompt();
  const fullPrompt = formatPrompt(systemPrompt, promptText);

  if (engine === 'gemini') {
    return runProcess('gemini', ['-p', fullPrompt, '-C', WORKSPACE], { cwd: WORKSPACE });
  }

  if (engine === 'codex') {
    return runProcess(
      'codex',
      ['exec', '-C', WORKSPACE, '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-a', 'never', fullPrompt],
      { cwd: WORKSPACE },
    );
  }

  if (engine === 'claude') {
    return runProcess(
      'claude',
      ['-p', '--add-dir', WORKSPACE, '--permission-mode', 'bypassPermissions', '--append-system-prompt', systemPrompt, promptText],
      { cwd: WORKSPACE },
    );
  }

  if (engine === 'deepseek-api') {
    return runDeepSeek(fullPrompt);
  }

  return { ok: false, code: -1, stdout: '', stderr: `Unsupported engine: ${engine}` };
}

async function runPrompt(promptText, preferredEngine = 'auto') {
  const available = await detectEngines();
  const engineOrder =
    preferredEngine === 'auto'
      ? DEFAULT_ENGINE_ORDER.filter((engine) => available.includes(engine))
      : [preferredEngine, ...DEFAULT_ENGINE_ORDER.filter((engine) => engine !== preferredEngine && available.includes(engine))];

  if (engineOrder.length === 0) {
    throw new Error('No research engines are available. Install gemini, codex, or claude, or set DEEPSEEK_API_KEY.');
  }

  const attempts = [];
  for (const engine of engineOrder) {
    const result = await executeWithEngine(engine, promptText);
    attempts.push({ engine, ok: result.ok, code: result.code, stderr: result.stderr.slice(0, 500) });
    if (result.ok && result.stdout.trim()) {
      return { engine, result, attempts };
    }
  }

  const summary = attempts.map((attempt) => `${attempt.engine}: ${attempt.code} ${attempt.stderr}`).join('\n');
  throw new Error(`All research engines failed.\n${summary}`);
}

async function interactiveRepl() {
  const available = await detectEngines();
  let engine = 'auto';

  console.log('FindMeAJob research shell');
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Available engines: ${available.join(', ') || '(none)'}`);
  console.log('Commands: /engines, /engine <name|auto>, /exit');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'research> ',
  });

  rl.prompt();
  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === '/exit') {
      rl.close();
      return;
    }

    if (input === '/engines') {
      const engines = await detectEngines();
      console.log(`Available: ${engines.join(', ') || '(none)'}`);
      console.log(`Current: ${engine}`);
      rl.prompt();
      return;
    }

    if (input.startsWith('/engine ')) {
      engine = input.slice('/engine '.length).trim() || 'auto';
      console.log(`Engine set to ${engine}`);
      rl.prompt();
      return;
    }

    try {
      console.log(`Running with ${engine}...`);
      const { engine: usedEngine, result } = await runPrompt(input, engine);
      console.log(`\n--- ${usedEngine} ---\n`);
      process.stdout.write(result.stdout.trim());
      process.stdout.write('\n\n');
    } catch (error) {
      console.error(String(error.message || error));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('Research shell closed.');
    process.exit(0);
  });
}

const promptFromArgs = getArg('prompt');
const engineFromArgs = getArg('engine', 'auto');
const listOnly = hasFlag('list-engines');

if (listOnly) {
  const engines = await detectEngines();
  console.log(JSON.stringify({ workspace: WORKSPACE, engines }, null, 2));
  process.exit(0);
}

if (promptFromArgs) {
  const { engine, result } = await runPrompt(promptFromArgs, engineFromArgs);
  console.log(JSON.stringify({ engine, output: result.stdout.trim() }, null, 2));
  process.exit(0);
}

await interactiveRepl();
