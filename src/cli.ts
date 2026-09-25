import path from 'node:path';
import { doctor as runDoctor, setup as runSetup } from './tools/bins.js';
import { log } from './log.js';
import { llmJson, setBackend, ledgerSummary } from './llm/llm.js';
import { claudeBackend } from './llm/claude.js';
import { listChannel, fetchSubs } from './yt/ytdlp.js';
import { saveCreator, listCreators, paths, readJson, loadSource, loadCreator } from './store.js';
import { mineCreator } from './mine/mine.js';
import { loadPlaybook, savePlaybook, renderPlaybookMd } from './playbook/playbook.js';
import { distill } from './playbook/distill.js';
import { ingest } from './ingest.js';
import { transcribeSource } from './analyze/transcribe.js';
import { scanVisual, computeFaceStats, writeFaceDebugSheets } from './analyze/visual.js';
import { analyzeSource } from './analyze/analyze.js';
import { selectSource, openingClosing } from './select/select.js';
import { mmss } from './select/propose.js';
import { generateHooks } from './hooks/hooks.js';
import type { Creator, Shot, FaceSample, Sentence, Candidate } from './types.js';

// A flag value is a single string/boolean normally, or an array when the same
// `--flag` was passed more than once on the command line (e.g. repeated `--shorts-url`).
export type FlagValue = string | boolean | (string | boolean)[];
export type ParsedArgs = { _: string[]; flags: Record<string, FlagValue> };

export function parseArgs(argv: string[]): ParsedArgs {
  const _: string[] = [];
  const flags: Record<string, FlagValue> = {};

  const setFlag = (key: string, value: string | boolean): void => {
    const existing = flags[key];
    if (existing === undefined) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      flags[key] = [existing, value];
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        setFlag(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          setFlag(body, next);
          i++;
        } else {
          setFlag(body, true);
        }
      }
    } else {
      _.push(arg);
    }
  }

  return { _, flags };
}

// Normalize a flag value to a single string (last one wins if repeated), or undefined.
function asString(v: FlagValue | undefined): string | undefined {
  const last = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof last === 'string' ? last : undefined;
}

// Normalize a flag value to a string array, dropping bare boolean flags.
function asStringArray(v: FlagValue | undefined): string[] {
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x): x is string => typeof x === 'string');
}

async function printDoctorReport(): Promise<boolean> {
  const rows = await runDoctor();
  let allOk = true;
  for (const row of rows) {
    if (!row.ok) allOk = false;
    const status = row.ok ? 'ok  ' : 'FAIL';
    console.log(`${status}  ${row.name}  ${row.detail}`);
  }
  return allOk;
}

export const commands: Record<string, { help: string; run: (a: ParsedArgs) => Promise<void> }> = {
  doctor: {
    help: 'Check that required tools and paths are available.',
    async run() {
      const ok = await printDoctorReport();
      if (!ok) process.exitCode = 1;
    },
  },
  setup: {
    help: 'Download required binaries and models, then run doctor.',
    async run() {
      await runSetup();
      const ok = await printDoctorReport();
      if (!ok) process.exitCode = 1;
    },
  },
  'llm-smoke': {
    help: 'Make one real LLM call (fast tier) and print the result and ledger summary.',
    async run() {
      setBackend(claudeBackend);
      const result = await llmJson<{ ok: boolean }>({
        tier: 'fast',
        purpose: 'smoke',
        system: 'You return JSON only.',
        prompt: 'Return ok=true.',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        noCache: true,
      });
      log('result:', JSON.stringify(result));
      log('ledger:', JSON.stringify(ledgerSummary()));
    },
  },
  ledger: {
    help: 'Print the LLM ledger summary as a table.',
    async run() {
      const s = ledgerSummary();
      log(`calls=${s.calls} cached=${s.cached} costUsd=${s.costUsd.toFixed(4)}`);
      console.log('purpose'.padEnd(24), 'calls'.padEnd(8), 'costUsd');
      for (const [purpose, v] of Object.entries(s.byPurpose)) {
        console.log(purpose.padEnd(24), String(v.calls).padEnd(8), v.costUsd.toFixed(4));
      }
    },
  },
  'yt-smoke': {
    help: 'List a channel\'s shorts and fetch subtitles for the first one (live smoke test).',
    async run(a) {
      const channelUrl = a._[0];
      if (!channelUrl) {
        log('usage: cb yt-smoke <channelUrl>');
        process.exitCode = 1;
        return;
      }
      try {
        const shorts = await listChannel(channelUrl, 'shorts', 5);
        if (shorts.length === 0) {
          log('no shorts found');
          return;
        }
        for (const s of shorts.slice(0, 3)) {
          console.log(`${s.id}  views=${s.views}  uploadDate=${s.uploadDate}  duration=${s.durationSec}s  ${s.title}`);
        }
        const words = await fetchSubs(shorts[0].id);
        log(`subs word count for ${shorts[0].id}: ${words ? words.length : 'none'}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/429|sign in to confirm|not a bot/i.test(msg)) {
          log('BLOCKED:', msg);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    },
  },
  creator: {
    help: 'creator add <slug> --name <n> --channel <url> --permission "<text>" [--shorts-url <url>]... [--publish-channel <UC…>] | creator list',
    async run(a) {
      const [sub, slug] = a._;
      if (sub === 'add') {
        if (!slug) {
          log('usage: cb creator add <slug> --name <n> --channel <url> --permission "<text>"');
          process.exitCode = 1;
          return;
        }
        const name = asString(a.flags.name);
        const channelUrl = asString(a.flags.channel);
        const permission = asString(a.flags.permission);
        if (!name || !channelUrl || !permission) {
          log('missing required flags: --name, --channel, --permission are all required');
          process.exitCode = 1;
          return;
        }
        const publishChannelId = asString(a.flags['publish-channel']);
        const creator: Creator = {
          slug,
          name,
          channelUrl,
          referenceShortsUrls: asStringArray(a.flags['shorts-url']),
          clippingPermission: permission,
          createdAt: new Date().toISOString(),
          ...(publishChannelId ? { publishChannelId } : {}),
        };
        saveCreator(creator);
        log(`creator saved: ${slug} (${name})`);
        return;
      }
      if (sub === 'list') {
        const creators = listCreators();
        if (creators.length === 0) {
          log('no creators yet — run `cb creator add ...`');
          return;
        }
        for (const c of creators) {
          console.log(`${c.slug.padEnd(16)} ${c.name.padEnd(28)} ${c.channelUrl}`);
        }
        return;
      }
      log('usage: cb creator <add|list> ...');
      process.exitCode = 1;
    },
  },
  mine: {
    help: 'mine <slug> [--shorts 80] [--episodes 60] [--include id1,id2] — align a creator\'s shorts to episodes.',
    async run(a) {
      const slug = a._[0];
      if (!slug) {
        log('usage: cb mine <slug> [--shorts 80] [--episodes 60] [--include id1,id2]');
        process.exitCode = 1;
        return;
      }
      const shorts = Number(asString(a.flags.shorts) ?? 80) || 80;
      const episodes = Number(asString(a.flags.episodes) ?? 60) || 60;
      const include = (asString(a.flags.include) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const result = await mineCreator(slug, { shorts, episodes, include });
      log(
        `mine ${slug}: nShorts=${result.nShorts} withSubs=${result.withSubs} aligned=${result.aligned} episodesIndexed=${result.episodesIndexed}`,
      );
    },
  },
  playbook: {
    help: 'playbook <slug> [--distill] — print a creator\'s playbook as markdown; --distill re-mines it from features.json first.',
    async run(a) {
      const slug = a._[0];
      if (!slug) {
        log('usage: cb playbook <slug> [--distill]');
        process.exitCode = 1;
        return;
      }
      if (a.flags.distill) {
        setBackend(claudeBackend);
        const pb = await distill(slug);
        savePlaybook(pb);
        console.log(renderPlaybookMd(pb));
        return;
      }
      const pb = loadPlaybook(slug);
      console.log(renderPlaybookMd(pb));
    },
  },
  ingest: {
    help: 'ingest <url|file> --creator <slug> — download audio + a <=360p proxy, prints the source id.',
    async run(a) {
      const input = a._[0];
      const creator = asString(a.flags.creator);
      if (!input || !creator) {
        log('usage: cb ingest <url|file> --creator <slug>');
        process.exitCode = 1;
        return;
      }
      const source = await ingest(input, creator);
      console.log(source.id);
    },
  },
  transcribe: {
    help: 'transcribe <sourceId> — whisper.cpp transcription with word timestamps (writes words.json, sentences.json).',
    async run(a) {
      const sourceId = a._[0];
      if (!sourceId) {
        log('usage: cb transcribe <sourceId>');
        process.exitCode = 1;
        return;
      }
      const words = await transcribeSource(sourceId);
      log(`words: ${words.length}`);
    },
  },
  scan: {
    help: 'scan <sourceId> [--force] — visual scan of proxy.mp4: shot boundaries + per-second face boxes.',
    async run(a) {
      const sourceId = a._[0];
      if (!sourceId) {
        log('usage: cb scan <sourceId> [--force]');
        process.exitCode = 1;
        return;
      }
      const result = await scanVisual(sourceId, { force: Boolean(a.flags.force) });
      log(`scan ${sourceId}: ${result.shots} shots, ${result.samples} face samples`);
    },
  },
  analyze: {
    help: 'analyze <sourceId> [--force] — run transcribe, silence detection and visual scan in order.',
    async run(a) {
      const sourceId = a._[0];
      if (!sourceId) {
        log('usage: cb analyze <sourceId> [--force]');
        process.exitCode = 1;
        return;
      }
      await analyzeSource(sourceId, { force: Boolean(a.flags.force) });
      log(`analyze ${sourceId}: done`);
    },
  },
  select: {
    help: 'select <sourceId> [--top 6] [--force] [--text] — propose, snap, dedupe and rank clip candidates.',
    async run(a) {
      const sourceId = a._[0];
      if (!sourceId) {
        log('usage: cb select <sourceId> [--top 6] [--force] [--text]');
        process.exitCode = 1;
        return;
      }
      setBackend(claudeBackend);
      const top = Number(asString(a.flags.top) ?? 6) || 6;
      const candidates = await selectSource(sourceId, { top, force: Boolean(a.flags.force) });
      const shortlisted = candidates.filter((c) => c.shortlisted).sort((x, y) => (x.rank ?? 0) - (y.rank ?? 0));

      console.log('rank  start–end          dur   composite  title');
      for (const c of shortlisted) {
        const dur = `${Math.round(c.end - c.start)}s`;
        console.log(
          `${String(c.rank).padEnd(5)} ${mmss(c.start)}–${mmss(c.end)}`.padEnd(24) +
            `${dur.padEnd(6)}${c.composite.toFixed(2).padEnd(11)}${c.title}`,
        );
      }

      if (a.flags.text) {
        const sentences = readJson<Sentence[]>(path.join(paths.source(sourceId), 'sentences.json'));
        for (const c of shortlisted) {
          const { opening, closing } = openingClosing(sentences, c);
          console.log(`\n[#${c.rank}] ${c.title}  (${mmss(c.start)}–${mmss(c.end)})`);
          console.log('  opening:');
          for (const s of opening) console.log(`    [${s.id}] (${mmss(s.start)}) ${s.text}`);
          console.log('  closing:');
          for (const s of closing) console.log(`    [${s.id}] (${mmss(s.start)}) ${s.text}`);
        }
      }
    },
  },
  'hooks-smoke': {
    help: 'hooks-smoke <sourceId> [--rank 1] — generate hooks/title/description/cold-open for one shortlisted candidate (live LLM call).',
    async run(a) {
      const sourceId = a._[0];
      if (!sourceId) {
        log('usage: cb hooks-smoke <sourceId> [--rank 1]');
        process.exitCode = 1;
        return;
      }
      const rank = Number(asString(a.flags.rank) ?? 1) || 1;
      const dir = paths.source(sourceId);
      const source = loadSource(sourceId);
      const creator = loadCreator(source.creator);
      const sentences = readJson<Sentence[]>(path.join(dir, 'sentences.json'));
      const candidates = readJson<Candidate[]>(path.join(dir, 'candidates.json'));
      const candidate = candidates.find((c) => c.shortlisted && c.rank === rank);
      if (!candidate) {
        log(`no shortlisted candidate with rank ${rank} in ${sourceId}`);
        process.exitCode = 1;
        return;
      }
      const pb = loadPlaybook(source.creator);
      setBackend(claudeBackend);

      const result = await generateHooks({
        creatorName: creator.name,
        episodeTitle: source.title,
        pb,
        sentences,
        startSid: candidate.startSid,
        endSid: candidate.endSid,
        candidateTitle: candidate.title,
        summary: candidate.summary,
      });

      console.log(`[#${rank}] ${candidate.title}  (${mmss(candidate.start)}–${mmss(candidate.end)})`);
      console.log('\nhooks:');
      for (const h of result.hooks) {
        console.log(`  (${h.score.toFixed(1)}) [${h.pattern}] ${h.text}`);
      }
      console.log(`\ntitle: ${result.title}`);
      console.log(`description: ${result.description}`);
      console.log(`hashtags: ${result.hashtags.join(', ')}`);
      if (result.coldOpenSid !== null) {
        const s = sentences[result.coldOpenSid];
        console.log(`\ncold open: [${result.coldOpenSid}] (${mmss(s.start)}, ${(s.end - s.start).toFixed(1)}s) ${s.text}`);
      } else {
        console.log('\ncold open: none');
      }
      console.log(`cold-open reason: ${result.coldOpenReason}`);
      log('ledger:', JSON.stringify(ledgerSummary()));
    },
  },
  'faces-smoke': {
    help: 'faces-smoke <sourceId> — print shot/face stats from an existing scan and write debug contact sheets with face boxes drawn on.',
    async run(a) {
      const sourceId = a._[0];
      if (!sourceId) {
        log('usage: cb faces-smoke <sourceId>');
        process.exitCode = 1;
        return;
      }
      const dir = paths.source(sourceId);
      const shots = readJson<Shot[]>(path.join(dir, 'shots.json'));
      const faces = readJson<FaceSample[]>(path.join(dir, 'faces.json'));
      const stats = computeFaceStats(shots, faces);
      console.log(`shots: ${stats.shots}`);
      console.log(`median shot length: ${stats.medianShotLen.toFixed(2)}s`);
      console.log(`face samples: ${stats.samples}`);
      console.log(`% samples with >=1 face: ${stats.pctWithFace.toFixed(1)}%`);
      console.log(`% samples with >=2 faces: ${stats.pctWith2Faces.toFixed(1)}%`);

      const sheets = await writeFaceDebugSheets(sourceId, 6);
      log(`wrote ${sheets.length} debug contact sheet(s):`);
      for (const s of sheets) {
        console.log(`  t=${s.t.toFixed(1)}s  faces=${s.faces.length}  ${s.jpgPath}`);
      }
    },
  },
};

function printHelp(): void {
  log('clipbrain — usage: cb <command> [...args]');
  log('commands:');
  for (const [name, cmd] of Object.entries(commands)) {
    log(`  ${name.padEnd(12)} ${cmd.help}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const [cmdName, ...rest] = parsed._;
  const cmd = cmdName ? commands[cmdName] : undefined;

  if (!cmd) {
    printHelp();
    if (cmdName) process.exitCode = 1;
    return;
  }

  await cmd.run({ _: rest, flags: parsed.flags });
}

main().catch((err) => {
  log('error:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
