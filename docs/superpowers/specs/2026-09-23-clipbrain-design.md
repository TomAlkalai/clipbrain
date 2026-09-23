# Clip Brain — Design Spec (2026-09-23)

## 1. Purpose

A local-first system that turns long-form videos from creators who permit clipping (podcasts, interviews, solo talking-heads, streams) into high-quality vertical shorts for the user's own clip channels, and **learns what works per creator** from two sources of ground truth:

1. The creator's **official Shorts** (editorial decisions made by professional clip teams, paired with their view counts).
2. The user's **own published clips** (retention + views) and their **approve/reject decisions**.

Secondary goal (V2): repurpose the user's own narrated long-form channels into shorts.

## 2. What we learned from the reference (Oliver Merrick, TikTok 2026-07-28)

Verified from the post's caption and auto-transcript (the footage itself could not be viewed): scrape the last ~100 official clips of Bartlett / Williamson / Hormozi with views; scrape the full episodes' timestamped transcripts; have Claude match each clip to its exact source moment; analyse why that moment was chosen (start point, cut context, payoff moved earlier, hook, overlay, format, performance vs account baseline); turn the patterns into a Claude skill that returns moments + timestamps + hooks + overlays + edit instructions for new transcripts. Tools named: Apify, Claude Code, Supabase, Notion, Remotion.

Kept: learning from **real editorial decisions + real results** (the core insight).
Changed:
- Matching is done by **deterministic local n-gram alignment**, not an LLM (free, exact, repeatable).
- Performance is **normalised against the channel median** (log view ratio), with young shorts (<7 days) excluded.
- The system goes past recommendations: boundary snapping, reframing, rendering, QC, review, publishing, measurement.
- The feedback loop is concrete: own results + approve/reject labels update the playbook and the selection weights, with minimum-sample guards.
- No Apify/Supabase/Notion: yt-dlp + JSON files + a local review UI.
- No B-roll or generative video for podcast clips (research: generic stock inserts push toward "templated/inauthentic" content and add little).

## 3. Architecture

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

## 4. Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `config` | paths, env, per-creator config | — |
| `store` | JSON read/write (atomic), ids, directory layout | config |
| `bin/tools` | locate/install yt-dlp, ffmpeg/ffprobe (Remotion-bundled), whisper.cpp + model | config |
| `llm` | tiered model calls (`fast`=haiku, `balanced`=sonnet, `strong`=opus) through `claude -p`, JSON extraction + schema validation, disk cache keyed by hash, cost ledger, concurrency limit; adapter interface so an API backend can replace it | tools |
| `youtube` (yt-dlp wrapper) | list channel shorts/videos, fetch json3 subs, download audio/proxy, download a time section | tools |
| `mine` | shorts ↔ episode alignment, features, performance normalisation | youtube, text |
| `playbook` | distill + load + merge ownResults | llm, mine |
| `ingest` / `analyze` | audio/proxy, transcription, sentences, shots, faces, silences | tools |
| `select` | candidate proposal, snapping, dedupe, final ranking | llm, playbook |
| `hooks` | hook variants, title, cold-open | llm, playbook |
| `edl` | build the edit decision list (pure function, unit-tested) | analyze outputs |
| `render` | fetch hi-res window, bundle + render Remotion comp | edl, remotion |
| `qc` | checks + auto-fixes | tools, llm |
| `review` | HTTP server + single-page UI + job runner for re-renders | store, render |
| `publish` | OAuth installed-app flow, resumable upload, safeguards | store |
| `metrics` / `learn` | stats collection and learning update | publish, playbook |
| `cli` | `cb <command>` entry points; `cb run` = ingest→analyze→select→hooks→render→qc | all |

Data layout (`data/`, gitignored):
```
creators/<slug>/creator.json  shorts.json  episodes/<videoId>.json3  alignments.json  playbook.json  playbook.md
sources/<sourceId>/source.json  audio.wav  proxy.mp4  words.json  sentences.json  shots.json  faces.json  candidates.json
clips/<clipId>/clip.json  hires.mp4  render.mp4  poster.jpg
ledger.jsonl   (every LLM call: tier, model, cost, duration, cache hit)
```
Clip status machine: `candidate → rendered → qc_failed | ready → approved | rejected → scheduled/published`.

## 5. Scoring

Per candidate the balanced model returns 0–10 per signal with a one-line reason each:
hook, standalone_clarity, payoff, novelty, emotional_intensity, information_density, audience_fit.
Composite = weighted mean with weights from `playbook.json.weights` (default equal). Weights change only through `learn`, with shrinkage toward the prior and a minimum of 8 labelled clips. The UI shows every signal and reason; there is no single "viral %".

## 6. Model hierarchy / cost

| Task | Where |
|---|---|
| transcription, scene/silence/face detection, alignment, boundary snapping, EDL, loudness, technical QC | local, deterministic |
| QC content check, tagging | fast (haiku) |
| playbook distillation, candidate proposal + rubric, hooks | balanced (sonnet) |
| final shortlist ranking | strong (opus), one call per source |

Every call goes through a disk cache (identical prompt → no second call) and is logged in `ledger.jsonl` with its reported cost. Default backend is the `claude` CLI (the user's plan, no API key); the adapter allows an API-key backend later.

## 7. Rendering choice

Remotion (React) for composition and ffmpeg for pre/post-processing. Why: per-segment crop transforms, animated word captions, and hook overlays are declarative and restyleable through a style-token JSON (reusable per-channel templates). The user already runs Remotion 4 locally, and it is free for individuals and companies of up to 3 people. Pure ffmpeg+ASS would render faster but makes animated overlays and per-segment crops fragile to maintain. Cost is roughly 1–3 min render per 45 s clip on this laptop, which is acceptable because only the shortlist is rendered.

## 8. Safety & reliability

- Secrets in `.env` / `.secrets/` (gitignored); OAuth token never logged.
- LLM subprocesses run in an isolated empty working directory with no tools enabled (pure text in/out).
- Publishing requires: clip `approved` + QC `ready`, `--live` flag (else dry-run prints the exact request), a daily cap, and the authenticated channel id to equal the creator config's `publishChannelId`. Default privacy `private`, optional `publishAt`.
- No destructive automation: the system never deletes remote videos; local cleanup is a separate explicit command.
- Only sources from creators listed in `creators/` with `clippingPermission` recorded are processed.
- yt-dlp calls are rate-limited (sleep between requests) and cached on disk.

## 9. Scope

**MVP (this build):** everything in §3; formats: podcast/talking-head auto (per-shot face crop, split-stack when two faces share a shot), stream layout via manual regions in config; YouTube publish implemented (real upload needs the user's Google OAuth client → dry-run until provided); metrics via Analytics API if authorised else public views.

**V2:** active-speaker detection for static wide shots; automatic facecam detection; overlay-text mining from official Shorts frames (vision); hook A/B experiments; own long-form mode (script/beats/B-roll); Gemini multimodal pass.

**V3:** per-channel autopilot; TikTok inbox-upload + Instagram publishing; caption-style learning from frames; local learned ranker after ≥200 labelled clips.

## 10. Testing

- Unit tests for pure logic: alignment, performance normalisation, sentence building, boundary snapping, dedupe, EDL building, QC decision rules, learn weight update.
- Real end-to-end run on The Diary Of A CEO — Alex Hormozi episode (`Kl-I7sUcAOY`), mining DOAC official Shorts.
- Quality evaluation: compare selected candidates against the DOAC official shorts cut from the same episode (overlap of chosen moments), plus manual viewing of rendered clips.
