import path from 'node:path';
import { doctor as runDoctor, setup as runSetup } from './tools/bins.js';
import { isIgnorableKillEperm } from './tools/proc.js';
import { log, step } from './log.js';
import { llmJson, setBackend, ledgerSummary } from './llm/llm.js';
import { claudeBackend } from './llm/claude.js';
import { listChannel, fetchSubs } from './yt/ytdlp.js';
import { saveCreator, listCreators, paths, readJson, loadSource, loadCreator, newId, saveClip, loadClip, listClips } from './store.js';
import { mineCreator } from './mine/mine.js';
import { loadPlaybook, savePlaybook, renderPlaybookMd } from './playbook/playbook.js';
import { distill } from './playbook/distill.js';
import { ingest } from './ingest.js';
import { transcribeSource } from './analyze/transcribe.js';
import { scanVisual, computeFaceStats, writeFaceDebugSheets } from './analyze/visual.js';
import { analyzeSource } from './analyze/analyze.js';
import { selectSource, openingClosing } from './select/select.js';
import { mmss } from './select/propose.js';
import { DEFAULT_WINDOW_SEC } from './select/snap.js';
import { generateHooks } from './hooks/hooks.js';
import { buildEdl } from './edit/edl.js';
import { ensureHires, renderClip, truncateEdl } from './render/render.js';
import { qcClip } from './qc/qc.js';
import { produceSource, requalifyClip, requalifySource, runPipeline, scout } from './produce.js';
import { evalSource } from './eval.js';
import { createReviewServer } from './review/server.js';
import { authorize } from './publish/oauth.js';
import { publish } from './publish/youtube.js';
import { collectStats, importCsv } from './metrics/stats.js';
import { learn } from './learn/learn.js';
import type { Creator, Shot, FaceSample, Sentence, Candidate, Word, Clip, ClipStatus } from './types.js';

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

// Mirrors types.ts's ClipStatus union exactly — used to validate `--status` on `requalify`
// (and `clips --status`, informally) against a real value instead of silently casting a typo.
const CLIP_STATUSES: ClipStatus[] = ['planned', 'rendered', 'qc_failed', 'ready', 'approved', 'rejected', 'published'];

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
    help:
      'select <sourceId> [--top 6] [--force] [--text] [--window-sec 600] [--overlap-sec 60] — propose, snap, dedupe and rank clip candidates.',
    async run(a) {
      const sourceId = a._[0];
      if (!sourceId) {
        log('usage: cb select <sourceId> [--top 6] [--force] [--text] [--window-sec 600] [--overlap-sec 60]');
        process.exitCode = 1;
        return;
      }
      const top = Number(asString(a.flags.top) ?? 6) || 6;
      const windowSecStr = asString(a.flags['window-sec']);
      const overlapSecStr = asString(a.flags['overlap-sec']);
      const windowSec = windowSecStr !== undefined ? Number(windowSecStr) : undefined;
      const overlapSec = overlapSecStr !== undefined ? Number(overlapSecStr) : undefined;
      if (windowSec !== undefined && !(Number.isFinite(windowSec) && windowSec >= 60)) {
        log(`select ${sourceId}: --window-sec must be a finite number >= 60 (got ${windowSecStr})`);
        process.exitCode = 1;
        return;
      }
      const effectiveWindowSec = windowSec ?? DEFAULT_WINDOW_SEC;
      if (overlapSec !== undefined && !(Number.isFinite(overlapSec) && overlapSec >= 0 && overlapSec < effectiveWindowSec)) {
        log(
          `select ${sourceId}: --overlap-sec must be a finite number >= 0 and < window-sec ` +
            `(${effectiveWindowSec}) (got ${overlapSecStr})`,
        );
        process.exitCode = 1;
        return;
      }
      setBackend(claudeBackend);
      const candidates = await selectSource(sourceId, {
        top,
        force: Boolean(a.flags.force),
        windowSec,
        overlapSec,
      });
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
  render: {
    help: 'render <clipId> — render a clip\'s EDL to a mastered MP4 (requires clip.edl already built).',
    async run(a) {
      const clipId = a._[0];
      if (!clipId) {
        log('usage: cb render <clipId>');
        process.exitCode = 1;
        return;
      }
      const started = Date.now();
      await renderClip(clipId);
      log(`render ${clipId}: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    },
  },
  'render-test': {
    help: 'render-test <sourceId> [--max-sec N] — build a Clip from the rank-1 shortlisted candidate and render it end-to-end (live smoke test); --max-sec truncates the EDL for fast iteration.',
    async run(a) {
      const sourceId = a._[0];
      if (!sourceId) {
        log('usage: cb render-test <sourceId>');
        process.exitCode = 1;
        return;
      }
      const dir = paths.source(sourceId);
      const source = loadSource(sourceId);
      const creator = loadCreator(source.creator);
      const candidates = readJson<Candidate[]>(path.join(dir, 'candidates.json'));
      const candidate = candidates.find((c) => c.shortlisted && c.rank === 1);
      if (!candidate) {
        log(`no shortlisted candidate with rank 1 in ${sourceId}`);
        process.exitCode = 1;
        return;
      }
      const words = readJson<Word[]>(path.join(dir, 'words.json'));
      const shots = readJson<Shot[]>(path.join(dir, 'shots.json'));
      const faces = readJson<FaceSample[]>(path.join(dir, 'faces.json'));

      const id = newId('clip');
      const now = new Date().toISOString();
      const clip: Clip = {
        id,
        sourceId,
        creator: source.creator,
        candidateId: candidate.id,
        start: candidate.start,
        end: candidate.end,
        coldOpen: null,
        title: candidate.title,
        description: '',
        hashtags: [],
        hooks: [{ text: candidate.title, pattern: 'test', score: 0 }],
        hookIndex: 0,
        scores: candidate.scores,
        composite: candidate.composite,
        rankReason: candidate.rankReason ?? '',
        patterns: candidate.patterns,
        hiresOffset: 0,
        status: 'planned',
        renders: 0,
        createdAt: now,
        updatedAt: now,
      };

      const doneHires = step(`ensureHires (${id})`);
      await ensureHires(clip, source);
      doneHires();

      clip.edl = buildEdl({
        start: clip.start,
        end: clip.end,
        coldOpen: clip.coldOpen,
        words,
        shots,
        faces,
        srcAspect: source.width / source.height,
        hiresOffset: clip.hiresOffset,
        videoSrc: 'hires.mp4',
        hook: clip.hooks[clip.hookIndex].text,
        style: 'default',
        override: creator.layoutOverride,
      });
      const maxSec = Number(asString(a.flags['max-sec']) ?? '');
      if (Number.isFinite(maxSec) && maxSec > 0) {
        clip.edl = truncateEdl(clip.edl, maxSec);
        log(`render-test ${id}: truncated to ${maxSec}s for fast iteration (--max-sec)`);
      }
      saveClip(clip);

      log(`render-test ${id}: edl built (${clip.edl.segments.length} segments, ${clip.edl.durationSec.toFixed(1)}s)`);
      const started = Date.now();
      await renderClip(id);
      const elapsed = (Date.now() - started) / 1000;
      log(`render-test ${id}: rendered in ${elapsed.toFixed(1)}s`);
      console.log(id);
    },
  },
  qc: {
    help: 'qc <clipId> — measure + evaluate a rendered clip (technical/audio/visual/content + vision critique), auto-fixing and re-rendering up to 2 rounds; prints the check table.',
    async run(a) {
      const clipId = a._[0];
      if (!clipId) {
        log('usage: cb qc <clipId>');
        process.exitCode = 1;
        return;
      }
      setBackend(claudeBackend);
      const started = Date.now();
      const report = await qcClip(clipId);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      const nameW = Math.max(8, ...report.checks.map((c) => c.name.length));
      console.log('name'.padEnd(nameW), 'ok'.padEnd(5), 'sev'.padEnd(6), 'detail');
      for (const c of report.checks) {
        console.log(c.name.padEnd(nameW), (c.ok ? 'ok' : 'FAIL').padEnd(5), c.severity.padEnd(6), c.detail);
      }

      if (report.fixesApplied.length > 0) {
        console.log('\nfixes applied:');
        for (const f of report.fixesApplied) console.log(`  - ${f}`);
      } else {
        console.log('\nfixes applied: none');
      }

      console.log(`\nverdict: ${report.ok ? 'READY' : 'QC_FAILED'}  (${elapsed}s)`);
    },
  },
  produce: {
    help: 'produce <sourceId> [--limit N] — for each shortlisted candidate without a clip yet: hooks→edl→render→qc.',
    async run(a) {
      const sourceId = a._[0];
      if (!sourceId) {
        log('usage: cb produce <sourceId> [--limit N]');
        process.exitCode = 1;
        return;
      }
      setBackend(claudeBackend);
      const limitStr = asString(a.flags.limit);
      const limit = limitStr !== undefined ? Number(limitStr) : undefined;
      const started = Date.now();
      const clips = await produceSource(sourceId, limit !== undefined ? { limit } : undefined);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      console.log('id'.padEnd(14), 'status'.padEnd(11), 'dur'.padEnd(8), 'composite'.padEnd(10), 'hook');
      for (const c of clips) {
        const dur = c.edl ? `${c.edl.durationSec.toFixed(1)}s` : '-';
        const hook = c.error ? `ERROR: ${c.error}` : (c.hooks[c.hookIndex]?.text ?? '(no hook)');
        console.log(c.id.padEnd(14), c.status.padEnd(11), dur.padEnd(8), c.composite.toFixed(2).padEnd(10), hook);
      }
      log(`produce ${sourceId}: ${clips.length} clip(s) in ${elapsed}s`);
    },
  },
  requalify: {
    help:
      'requalify <clipId> | requalify --source <sourceId> [--status qc_failed] — rebuild the EDL with the current code and re-run render+QC for a clip (or every clip of a source in the given status, default qc_failed).',
    async run(a) {
      setBackend(claudeBackend);
      const clipId = a._[0];
      const sourceId = asString(a.flags.source);
      const statusStr = asString(a.flags.status);

      if (clipId && sourceId) {
        log('usage: cb requalify <clipId> | cb requalify --source <sourceId> [--status qc_failed] — not both');
        process.exitCode = 1;
        return;
      }
      if (!clipId && !sourceId) {
        log('usage: cb requalify <clipId> | cb requalify --source <sourceId> [--status qc_failed]');
        process.exitCode = 1;
        return;
      }

      let status: ClipStatus = 'qc_failed';
      if (statusStr !== undefined) {
        if (!CLIP_STATUSES.includes(statusStr as ClipStatus)) {
          log(`requalify: invalid --status "${statusStr}" — must be one of: ${CLIP_STATUSES.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        status = statusStr as ClipStatus;
      }

      let clips: Clip[];
      if (clipId) {
        try {
          clips = [await requalifyClip(clipId)];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`requalify ${clipId}: failed: ${message}`);
          try {
            const failed = loadClip(clipId);
            failed.error = message;
            saveClip(failed);
          } catch {
            // clip couldn't even be loaded (bad id?) — nothing on disk to record the error on
          }
          process.exitCode = 1;
          return;
        }
      } else {
        clips = await requalifySource(sourceId!, status);
        if (clips.length === 0) {
          log(`requalify ${sourceId}: no clips with status=${status}`);
          return;
        }
      }

      console.log('id'.padEnd(14), 'status'.padEnd(11), 'dur'.padEnd(8), 'composite'.padEnd(10), 'hook');
      for (const c of clips) {
        const dur = c.edl ? `${c.edl.durationSec.toFixed(1)}s` : '-';
        const hook = c.error ? `ERROR: ${c.error}` : (c.hooks[c.hookIndex]?.text ?? '(no hook)');
        console.log(c.id.padEnd(14), c.status.padEnd(11), dur.padEnd(8), c.composite.toFixed(2).padEnd(10), hook);
      }
      if (clips.some((c) => c.error)) process.exitCode = 1;
    },
  },
  run: {
    help: 'run <url|file> --creator <slug> [--top 6] | run --creator <slug> --latest N [--top 6] — full pipeline: ingest→analyze→select→produce (or scout+run per episode).',
    async run(a) {
      setBackend(claudeBackend);
      const creator = asString(a.flags.creator);
      const top = Number(asString(a.flags.top) ?? 6) || 6;
      const input = a._[0];
      const latestStr = asString(a.flags.latest);

      if (!creator) {
        log('usage: cb run <url|file> --creator <slug> [--top 6]  |  cb run --creator <slug> --latest N [--top 6]');
        process.exitCode = 1;
        return;
      }

      if (input) {
        await runPipeline(input, creator, { top });
        return;
      }

      if (!latestStr) {
        log('usage: cb run <url|file> --creator <slug> [--top 6]  |  cb run --creator <slug> --latest N [--top 6]');
        process.exitCode = 1;
        return;
      }
      const latest = Number(latestStr) || 3;
      const urls = await scout(creator, { latest });
      if (urls.length === 0) {
        log(`run ${creator}: scout found no new episodes (>= 900s, not yet ingested)`);
        return;
      }
      log(`run ${creator}: scouted ${urls.length} episode(s), running the pipeline on each sequentially`);
      for (const url of urls) {
        await runPipeline(url, creator, { top });
      }
    },
  },
  eval: {
    help: "eval <sourceId> — compare mined candidates against the creator's official Shorts from this episode.",
    async run(a) {
      const sourceId = a._[0];
      if (!sourceId) {
        log('usage: cb eval <sourceId>');
        process.exitCode = 1;
        return;
      }
      await evalSource(sourceId);
    },
  },
  clips: {
    help: 'clips [--status s] — list produced clips as a table.',
    async run(a) {
      const status = asString(a.flags.status) as ClipStatus | undefined;
      const clips = listClips(status ? (c) => c.status === status : undefined);
      if (clips.length === 0) {
        log(status ? `no clips with status=${status}` : 'no clips yet — run `cb produce <sourceId>` first');
        return;
      }
      console.log(
        'id'.padEnd(14),
        'status'.padEnd(11),
        'source'.padEnd(14),
        'dur'.padEnd(8),
        'composite'.padEnd(10),
        'title',
      );
      for (const c of clips) {
        const dur = c.edl ? `${c.edl.durationSec.toFixed(1)}s` : '-';
        console.log(
          c.id.padEnd(14),
          c.status.padEnd(11),
          c.sourceId.padEnd(14),
          dur.padEnd(8),
          c.composite.toFixed(2).padEnd(10),
          c.title,
        );
      }
    },
  },
  scout: {
    help: "scout <slug> [--latest 3] [--min-duration 900] — list a creator's newest long-form episodes not yet ingested.",
    async run(a) {
      const slug = a._[0];
      if (!slug) {
        log('usage: cb scout <slug> [--latest 3] [--min-duration 900]');
        process.exitCode = 1;
        return;
      }
      const latest = Number(asString(a.flags.latest) ?? 3) || 3;
      const minDurationSec = Number(asString(a.flags['min-duration']) ?? 900) || 900;
      const urls = await scout(slug, { latest, minDurationSec });
      if (urls.length === 0) {
        log(`scout ${slug}: no new episodes found (>= ${minDurationSec}s, not yet ingested)`);
        return;
      }
      for (const url of urls) console.log(url);
    },
  },
  review: {
    help: 'review [--port 4777] — start the local human-in-the-loop review server (approve/reject/hook re-render UI).',
    async run(a) {
      setBackend(claudeBackend); // the hook-switch job runner's qcClip/renderClip path needs an LLM backend
      const port = Number(asString(a.flags.port) ?? 4777) || 4777;
      const server = await createReviewServer({ port });
      log(`review server listening at ${server.url}`);
    },
  },
  auth: {
    help: 'auth youtube — run the Google OAuth installed-app flow and save .secrets/youtube-token.json.',
    async run(a) {
      const sub = a._[0];
      if (sub !== 'youtube') {
        log('usage: cb auth youtube');
        process.exitCode = 1;
        return;
      }
      await authorize();
    },
  },
  publish: {
    help: 'publish [--live] [--clip <id>] — upload approved, QC-passed clips to YouTube (dry-run unless --live).',
    async run(a) {
      const live = Boolean(a.flags.live);
      const clipId = asString(a.flags.clip);
      await publish({ live, clipId });
    },
  },
  stats: {
    help: 'stats | stats import <csv> — collect YouTube view/analytics metrics for published clips.',
    async run(a) {
      const sub = a._[0];
      if (sub === 'import') {
        const csvPath = a._[1];
        if (!csvPath) {
          log('usage: cb stats import <csv>');
          process.exitCode = 1;
          return;
        }
        const n = await importCsv(csvPath);
        log(`stats import: updated ${n} clip(s) from ${csvPath}`);
        return;
      }
      const n = await collectStats();
      log(`stats: updated ${n} clip(s)`);
    },
  },
  learn: {
    help: 'learn <slug> — combine published outcomes + review labels into the creator\'s playbook (signal weights + findings).',
    async run(a) {
      const slug = a._[0];
      if (!slug) {
        log('usage: cb learn <slug>');
        process.exitCode = 1;
        return;
      }
      const or = await learn(slug);
      log(`learn ${slug}: nPublished=${or.nPublished} nReviewed=${or.nReviewed}`);
      if (or.findings.length === 0) {
        log('no findings yet');
      } else {
        for (const f of or.findings) console.log(`  - ${f}`);
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

// Bug 3 fix (important): a renderer failure used to kill the whole CLI. @remotion/renderer's
// browser/compositor teardown can emit an 'error' event (code EPERM, syscall 'kill') on a
// Windows ChildProcess with no 'error' listener — e.g. right after Bug 1's crash, while Remotion
// is tearing itself down. Node re-emits an unlistened 'error' event as an uncaughtException,
// which crashed the whole process before the per-clip try/catch in produce/requalify ever ran,
// abandoning every remaining clip in a batch. These handlers swallow ONLY that exact shape
// (isIgnorableKillEperm — src/tools/proc.ts) with a one-line warning; everything else still logs
// and exits non-zero, same as before.
function installCrashGuards(): void {
  const handle = (err: unknown): void => {
    if (isIgnorableKillEperm(err)) {
      log('warning: ignoring EPERM from a child-process kill during renderer teardown (Bug 3 mitigation)');
      return;
    }
    log('error:', err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
    process.exit(1);
  };
  process.on('uncaughtException', handle);
  process.on('unhandledRejection', handle);
}

async function main(): Promise<void> {
  installCrashGuards();
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
