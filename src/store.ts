import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from './config.js';
import type { Creator, Source, Clip } from './types.js';

export function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

export function readJsonOr<T>(p: string, d: T): T {
  try {
    return readJson<T>(p);
  } catch {
    return d;
  }
}

export function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

export function appendJsonl(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(v) + '\n');
}

export function newId(prefix: string): string {
  const bytes = crypto.randomBytes(8);
  let n = BigInt('0x' + bytes.toString('hex'));
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const base = BigInt(alphabet.length);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out = alphabet[Number(n % base)] + out;
    n /= base;
  }
  return `${prefix}_${out}`;
}

export function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export const paths = {
  creator(slug: string): string {
    return path.join(DATA, 'creators', slug);
  },
  source(id: string): string {
    return path.join(DATA, 'sources', id);
  },
  clip(id: string): string {
    return path.join(DATA, 'clips', id);
  },
};

function creatorFile(slug: string): string {
  return path.join(paths.creator(slug), 'creator.json');
}
function sourceFile(id: string): string {
  return path.join(paths.source(id), 'source.json');
}
function clipFile(id: string): string {
  return path.join(paths.clip(id), 'clip.json');
}

export function loadCreator(slug: string): Creator {
  return readJson<Creator>(creatorFile(slug));
}

export function saveCreator(c: Creator): void {
  writeJson(creatorFile(c.slug), c);
}

export function listCreators(): Creator[] {
  const dir = path.join(DATA, 'creators');
  return listDirs(dir)
    .map((slug) => readJsonOr<Creator | null>(creatorFile(slug), null))
    .filter((c): c is Creator => c !== null);
}

export function loadSource(id: string): Source {
  return readJson<Source>(sourceFile(id));
}

export function saveSource(s: Source): void {
  writeJson(sourceFile(s.id), s);
}

export function loadClip(id: string): Clip {
  return readJson<Clip>(clipFile(id));
}

export function saveClip(c: Clip): void {
  c.updatedAt = new Date().toISOString();
  writeJson(clipFile(c.id), c);
}

export function listClips(filter?: (c: Clip) => boolean): Clip[] {
  const dir = path.join(DATA, 'clips');
  const clips = listDirs(dir)
    .map((id) => readJsonOr<Clip | null>(clipFile(id), null))
    .filter((c): c is Clip => c !== null)
    .filter((c) => (filter ? filter(c) : true));
  clips.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return clips;
}
