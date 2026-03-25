import path from 'node:path';

export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : process.cwd();

export const SUBDOMAIN_LIST = process.env.SUBDOMAIN_LIST
  ? path.resolve(process.env.SUBDOMAIN_LIST)
  : path.join(WORKSPACE_ROOT, 'config', 'subdomains.txt');

export const RUNS_DIR = process.env.RUNS_DIR
  ? path.resolve(process.env.RUNS_DIR)
  : path.join(WORKSPACE_ROOT, 'runs');

export const MASTER_CSV_PATH = process.env.MASTER_CSV_PATH
  ? path.resolve(process.env.MASTER_CSV_PATH)
  : path.join(WORKSPACE_ROOT, 'trackers', 'job-research-master.csv');

export const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || 'http://127.0.0.1:4471';
