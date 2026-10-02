# Clip Brain

A local-first CLI that learns a specific creator's clipping playbook from their **official YouTube Shorts** — matching each short back to its exact source moment in the long-form episode, and analysing why that moment was chosen — then applies that playbook to a creator's long-form episodes to produce ranked, reframed, captioned, QC-checked vertical clips. Clips go through a local review UI for human approval before an optional, safeguarded publish to YouTube (private or scheduled), and results feed back into the playbook.

## How it works

```
LEARN (per creator)
  reference channels (official Shorts, optional extra clip channels)
    └─ yt-dlp: list shorts (id,title,views,date) + auto-subs (json3)   [no video download]
  creator's recent long-form episodes
    └─ yt-dlp: auto-subs (json3)
  ALIGN (local n-gram index) → per short: episode, source segments, reorder (cold-open), coverage
  FEATURES: duration, #segments, cold-open, starts at sentence start, context skipped, position in episode
  PERFORMANCE: log(views / channel median views), shorts < 7 days excluded
  DISTILL (balanced model): playbook.json + playbook.md (principles, hook patterns, length range, anti-patterns, exemplars)

PRODUCE (per source video)
  INGEST   URL or local file → audio (wav 16k) + 360p proxy; source.json
  ANALYZE  whisper.cpp word timestamps → sentences; ffmpeg scene detection → shots;
           faces per shot (sampled proxy frames); silences
  SELECT   balanced model proposes candidates per ~20-min window (parallel) using playbook
           → deterministic snap to sentence boundaries → duration filter → dedupe (IoU>0.5)
           → strong model ranks final shortlist (top N, default 6)
  HOOK     balanced model: 5 overlay hooks + title + optional cold-open sentence; ranked
  EDIT     EDL: segments with pause tightening, split at shot boundaries, per-segment 9:16 crop
           (face-centred / split-stack for 2 faces / manual stream layout), word-timed captions,
           hook overlay
  RENDER   hi-res fetch of the clip window only → Remotion composition → H.264/AAC 1080x1920
  QC       technical (ffprobe), audio (EBU R128 loudness, silence), visual (black/freeze, face-in-frame),
           content (fast model: standalone? clean ending? hook matches?) → auto-fix + rerender (max 2) or flag
  REVIEW   local web UI: play clip, scores + reasons, switch hook (re-render), approve / reject (+reason)
  PUBLISH  approved + QC-passed only → YouTube Data API, private or scheduled; dry-run unless --live
  MEASURE  YouTube Analytics (views, engagedViews, averageViewPercentage) if authorised, else public views
  LEARN    join clip features × performance × review labels → playbook "ownResults" + selection weights
```

What makes the pipeline different from a generic auto-clipper:

- **Learned per-creator playbook**, distilled from the creator's own official Shorts matched back to their source episodes (deterministic local n-gram alignment, not an LLM guess) and normalised against that channel's own view baseline.
- **Boundary verifier**: candidate windows from the LLM are deterministically snapped to real sentence starts/ends and deduplicated (IoU > 0.5) before anything is ranked or rendered.
- **Visual fitness scoring**: shot/face data (face coverage, two-shot ratio, crop-fit ratio, cuts/min, longest no-face run) penalises candidates that read fine as text but look bad on screen, before the final rank.
- **Vision QA with auto-fix**: a vision-capable LLM call looks at actual keyframes/stills — at selection time and again on the rendered clip — to catch burned-in ads, off-camera speakers, bad framing, or unreadable captions, and can trigger an automatic re-edit (layout switch, next hook, trim/extend) and re-render, up to 2 rounds.
- **Human approval gate**: nothing publishes without an explicit approve in the local review UI, on top of QC having already passed.
- **Learning loop**: published clips' own performance plus review approve/reject labels flow back into the creator's playbook and selection weights (with shrinkage toward the prior and a minimum sample size), so the system improves on real outcomes, not just the official-Shorts prior.
- **Cost-aware model tiering**: cheap/local work stays local and deterministic; LLM calls are split across haiku/sonnet/opus by task, cached on disk, and logged to a ledger.
- **Everything stays local**: no third-party SaaS in the loop — yt-dlp, ffmpeg, whisper.cpp, Remotion, and the `claude` CLI, all against JSON files on disk.

## Prerequisites

- Windows, Node 22.
- The `claude` CLI installed and logged in to your Claude plan (used as the default, no-API-key LLM backend for every tiered call).
- Full FFmpeg with the filters this project needs (`scdet`, `ebur128`, `blackdetect`, `freezedetect`, `silencedetect`, `loudnorm`) — install with `winget install Gyan.FFmpeg`.
- About 5 GB of free disk per episode processed (audio, proxy, hi-res clip fetches, renders).

## Setup

```
npm install
npx tsx src/cli.ts setup
npx tsx src/cli.ts doctor
```

`setup` downloads yt-dlp, whisper.cpp + the transcription model, and the UltraFace face-detection model into `bin/`. `doctor` checks node, ffmpeg (and its required filters), ffprobe, yt-dlp, whisper.cpp, the UltraFace model, the `claude` CLI, and that `data/` is writable with enough free disk — run it again any time something seems off.

## Workflow

Run these in order, per creator, then per episode:

```
# 1. Register a creator you have permission to clip (once per creator)
npx tsx src/cli.ts creator add doac --name "The Diary Of A CEO" --channel https://www.youtube.com/@TheDiaryOfACEO --permission "..."

# 2. Mine their official Shorts against their long-form episodes
npx tsx src/cli.ts mine doac

# 3. Distill the playbook from the mined features
npx tsx src/cli.ts playbook doac --distill

# 4. Produce clips from an episode (either a specific URL, or the creator's latest N)
npx tsx src/cli.ts run <url> --creator doac --top 6
npx tsx src/cli.ts run --creator doac --latest 3 --top 6

# 5. Review candidates in the local UI (approve / reject / switch hook)
npx tsx src/cli.ts review

# 6. Publish approved + QC-passed clips (dry-run first, then live)
npx tsx src/cli.ts publish
npx tsx src/cli.ts publish --live

# 7. Pull view/analytics stats for published clips
npx tsx src/cli.ts stats

# 8. Feed results + review labels back into the playbook
npx tsx src/cli.ts learn doac
```

`creator add` accepts `--shorts-url <url>` (repeatable, for extra reference clip channels) and `--publish-channel <UC…>` (the channel ID publishing is restricted to). `run <url|file> --creator <slug> --top N` runs the full ingest→analyze→select→produce pipeline on one source; `run --creator <slug> --latest N` instead scouts the creator's newest not-yet-ingested long-form episodes and runs the pipeline on each in turn. See `npx tsx src/cli.ts help` for every command (including the lower-level `ingest`, `transcribe`, `scan`, `analyze`, `select`, `render`, `qc`, `produce`, `scout`, `eval`, and `clips` steps `run` composes).

## YouTube publishing setup

Publishing is optional and off by default (dry-run). To enable live uploads:

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. **APIs & Services → Library**: enable "YouTube Data API v3" and "YouTube Analytics API".
3. **APIs & Services → OAuth consent screen**: configure it (External is fine; add your own Google account as a test user while the app is unverified).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type **Desktop app**.
5. Download the client JSON and save it as `.secrets/google-client.json`.
6. Run `npx tsx src/cli.ts auth youtube` — this opens a browser for consent and saves the resulting token to `.secrets/youtube-token.json`.

Safeguards enforced by `publish`, regardless of the above:

- Only clips that are `approved` (human review) **and** QC `ready` are ever eligible.
- Dry-run by default — it only prints the exact upload requests it would make. Nothing is uploaded unless you pass `--live`.
- A daily cap, `CB_PUBLISH_DAILY_CAP` (default 10), limits live uploads in any rolling 24h window; set it to `0` to pause publishing entirely.
- The authenticated YouTube channel must match the creator's configured `publishChannelId`, or the publish is refused.
- Uploads are always `private` or scheduled (`publishAt`) — never public on upload.
- Every published description ends with an attribution block naming the source creator and linking the full episode.

## Costs

Every LLM call goes through a disk cache (an identical prompt is never billed twice) and is logged to `data/ledger.jsonl` with its tier, model, purpose, cost, duration, and whether it was a cache hit. Run `npx tsx src/cli.ts ledger` for your own real numbers — don't rely on numbers in this README.

Model tiers, by task:
- **fast (haiku)**: QC content checks, tagging.
- **balanced (sonnet)**: playbook distillation, candidate proposal + rubric, hooks, vision QA critique.
- **strong (opus)**: final shortlist ranking — one call per source.

Everything else (transcription, scene/silence/face detection, alignment, boundary snapping, EDL building, loudness, technical QC) is local and free. As a rough starting point on this project, the first full selection pass on a new episode (including investigation) has run around $5–7; re-running against already-cached prompts costs less. Check `ledger` for what your own runs actually cost.

## Performance notes

Measured on this development machine (i5-10300H):
- Transcription (whisper.cpp, `base.en`): roughly 1.7x realtime — a 3.2h episode took about 1.9h.
- Render: roughly 6.5x the clip's own length — a 144s clip took about 15.5 minutes.
- Visual scan: roughly 11.5 minutes for a 3.2h episode.

Your own hardware will vary; treat these as ballpark, not guarantees.

Renders have timeouts, so one stuck render can't stall a whole `produce` run. A render fails if Remotion reports no progress for `CB_RENDER_STALL_MIN` minutes (default 5), or if it runs longer than `CB_RENDER_TIMEOUT_MIN` minutes in total (default 60). When that happens, that render's Chrome is closed, the reason is saved in the clip's `error`, and the run continues with the next clip. A later `produce` retries the clip. Raise the limits in `.env` if your machine renders much slower than the numbers above.

## Data layout

Everything lives under `data/` (gitignored):

```
creators/<slug>/creator.json  shorts.json  episodes/<videoId>.json3  alignments.json  playbook.json  playbook.md
sources/<sourceId>/source.json  audio.wav  proxy.mp4  words.json  sentences.json  shots.json  faces.json  candidates.json
clips/<clipId>/clip.json  hires.mp4  render.mp4  poster.jpg
ledger.jsonl   (every LLM call: tier, model, cost, duration, cache hit)
```

Clip status machine: `candidate → rendered → qc_failed | ready → approved | rejected → scheduled/published`.

## Safety

- Secrets (`google-client.json`, `youtube-token.json`) live in `.secrets/`, which is gitignored; the OAuth token is never logged.
- Every LLM subprocess runs in an isolated, empty working directory with no tools enabled by default (pure text in/out). The one exception is vision calls, which get `Read`-only access limited to the specific frames directory they need to inspect — no other tools, no write access.
- The system never deletes anything remote (no remote video/asset deletion is automated); local cleanup is a separate, explicit, manual step.
- Only creators listed under `data/creators/` with a recorded `clippingPermission` are ever processed.

## Known limitations

- No active-speaker detection for static wide two-shots (V2 item) — a static two-person frame is cropped, not intelligently switched between speakers.
- TikTok and Instagram are not published to automatically; export for those platforms is manual.
- Live YouTube upload is untested end-to-end until you add your own OAuth client (see above) — until then, `publish` only runs in dry-run.
- Clips longer than roughly 2 minutes render noticeably slower (render time scales with clip length, see Performance notes).
