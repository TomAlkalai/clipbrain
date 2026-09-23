import { doctor as runDoctor, setup as runSetup } from './tools/bins.js';
import { log } from './log.js';
import { llmJson, setBackend, ledgerSummary } from './llm/llm.js';
import { claudeBackend } from './llm/claude.js';
import { listChannel, fetchSubs } from './yt/ytdlp.js';
import { saveCreator, listCreators } from './store.js';
import { mineCreator } from './mine/mine.js';
import { loadPlaybook, savePlaybook, renderPlaybookMd } from './playbook/playbook.js';
import { distill } from './playbook/distill.js';
import type { Creator } from './types.js';

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
