import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const BIN = path.join(ROOT, 'bin');
export const SECRETS = path.join(ROOT, '.secrets');

let envLoaded = false;
let envFile: Record<string, string> = {};

function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    envFile[key] = value;
  }
}

export function env(name: string, fallback?: string): string | undefined {
  loadEnvFile();
  if (process.env[name] !== undefined) return process.env[name];
  if (envFile[name] !== undefined && envFile[name] !== '') return envFile[name];
  return fallback;
}

export const DATA = env('CB_DATA') || path.join(ROOT, 'data');
