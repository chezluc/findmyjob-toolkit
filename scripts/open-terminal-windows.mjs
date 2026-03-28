#!/usr/bin/env node

import { spawn } from 'node:child_process';

const session = process.argv[2] || 'findmeajob-agent';

const script = `
tell application "Terminal"
  activate
  do script "tmux attach -t ${session}:main"
  delay 0.8
  do script "tmux attach -t ${session}:research"
end tell
`;

const child = spawn('osascript', ['-e', script], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
