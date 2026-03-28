#!/usr/bin/env node

import { spawn } from 'node:child_process';

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
  });
}

const result = await run('tmux', ['list-windows', '-t', 'findmeajob-agent', '-F', '#{window_index}:#{window_name}:#{pane_current_command}']);

if (result.code !== 0) {
  console.error(result.stderr || 'findmeajob-agent tmux session not found');
  process.exit(1);
}

let bridge = { ok: false, error: 'unknown' };
try {
  const response = await fetch('http://127.0.0.1:4471/health');
  if (response.ok) {
    bridge = await response.json();
  } else {
    bridge = { ok: false, error: `HTTP ${response.status}` };
  }
} catch (error) {
  bridge = { ok: false, error: String(error.message || error) };
}

console.log(
  JSON.stringify(
    {
      tmux: result.stdout.trim().split('\n').filter(Boolean),
      bridge,
    },
    null,
    2,
  ),
);
