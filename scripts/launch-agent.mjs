#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';

const WORKSPACE = 'process.env.WORKSPACE';
const ROOT = path.join(WORKSPACE, 'findmeajob-agent');
const SESSION = 'findmeajob-agent';
const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function run(command, commandArgs, { stdio = 'pipe' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: WORKSPACE, stdio });
    let stdout = '';
    let stderr = '';

    if (stdio === 'pipe') {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
  });
}

async function sessionExists() {
  const result = await run('tmux', ['has-session', '-t', SESSION]);
  return result.code === 0;
}

async function ensureSession() {
  if (hasFlag('--reset') && (await sessionExists())) {
    await run('tmux', ['kill-session', '-t', SESSION]);
  }

  if (await sessionExists()) {
    return;
  }

  const mainCommand = `${ROOT}/scripts/start-main-agent.sh`;
  const researchCommand = `${ROOT}/scripts/start-research-shell.sh`;

  await run('tmux', ['new-session', '-d', '-s', SESSION, '-n', 'main', 'zsh']);
  await run('tmux', ['set-option', '-t', SESSION, 'remain-on-exit', 'on']);
  await run('tmux', ['new-window', '-t', SESSION, '-n', 'research', 'zsh']);
  await run('tmux', ['send-keys', '-t', `${SESSION}:main`, mainCommand, 'C-m']);
  await run('tmux', ['send-keys', '-t', `${SESSION}:research`, researchCommand, 'C-m']);
}

async function main() {
  await ensureSession();

  if (!hasFlag('--no-open')) {
    await run('node', [`${ROOT}/scripts/open-terminal-windows.mjs`, SESSION], { stdio: 'inherit' });
  }

  const list = await run('tmux', ['list-windows', '-t', SESSION, '-F', '#{window_index}:#{window_name}:#{pane_current_command}']);
  if (list.code !== 0) {
    console.error(list.stderr || 'Unable to inspect tmux session');
    process.exit(1);
  }

  console.log(`Started tmux session: ${SESSION}`);
  console.log(list.stdout.trim());
  console.log(`Main window: tmux attach -t ${SESSION}:main`);
  console.log(`Research window: tmux attach -t ${SESSION}:research`);
}

await main();
