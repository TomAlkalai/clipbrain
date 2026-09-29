# Clip Brain — status & handoff (2026-09-29)

For anyone (human or cloud agent) continuing this work from GitHub only.
The detailed build ledger is in `docs/status/sdd-ledger.md`, and the dead-air root-cause write-up is in `docs/status/debug-dead-air.md`.

## What exists
The full MVP loop is implemented and was run on real DOAC episodes (see README.md for commands):

creator mining (official Shorts ↔ episode alignment) → learned playbook → ingest → whisper.cpp transcription → silences + shots + faces → selection → hooks → EDL → Remotion render → QC → review UI → YouTube publish → metrics → learn → scout

Selection steps: 600 s windows → boundary verifier → visual fitness + vision keyframe check → Opus ranking calibrated on the channel's top Shorts.

QC has these parts:
- technical, audio, content and vision critique;
- batched auto-fix: silence-aware pauses, fit layout, move_hook_up, next hook, extend/trim;
- max 2 rounds.

`npm test` reports ~282 tests passing (the vitest suite), and `tsc` is clean.

## Real-data results (local machine; `data/` is gitignored and not in this repo)
- **Mining:** 80 DOAC Shorts, 69 aligned to their episodes (86 %). Playbook v1: ideal duration 95–130 s, with channel-specific hook patterns.
- **Hormozi episode (3.2 h):** 6 shortlisted clips. At handoff, 5 were `ready` after the dead-air fix and requalify. One (`clip_g5babhgx`) was `qc_failed` on a legitimate content/framing judgement.
- **Ray Dalio episode (1.5 h), end-to-end:** transcription ran at 8.5× realtime. Rendering took ≈ 2.7–3.2× the clip length when not CPU-contended. Selection was evaluated against DOAC's 5 official Shorts from that episode: recall 40 % → 80 % after the window change, but precision was 0/5 (the ranker prefers geopolitics over the channel's personal-finance picks).
- **LLM spend for the whole build + runs:** ≈ $10.8 (`npx tsx src/cli.ts ledger`).

## Open items (in priority order)
1. **Render robustness follow-up (Important, not yet fixed).** `fetchAndReplaceHires` in `src/render/render.ts`:
   - The `fs.renameSync` over `hires.mp4` needs a short retry/backoff for Windows file locks (EBUSY/EPERM). Right now a locked rename discards a good download.
   - Also: sweep stale `hires.tmp-*.mp4` files.
   - In `src/cli.ts` `installCrashGuards`: flush output before `process.exit`, and only attach the EPERM guard to `uncaughtException`.
2. **Production chain was mid-run at handoff (local).** `clip_4v1cw97c` failed with "Failed to fetch" (network) and resume will retry it. The Dalio clips `clip_qlgb9gwj` (stale-hires bug, fixed in da1cc09; needs `requalify`) and ranks 3–5 (hook generation hit a usage limit) need `produce src_xrq3w2z7` / `requalify`.
3. **Local-file input path** (`run <file>`) is implemented but not yet exercised end to end.
4. **Final whole-branch code review** has not been run yet. The deferred minor findings are listed in the ledger.
5. **Ranking precision (highest-value product improvement).** Build an offline ranking benchmark over the 29 recent episodes that have aligned official Shorts: transcript-only (YouTube json3 subs, no video), cheap to run. Use it to tune the ranker/weights instead of anecdotes from one episode.
6. **Render speed.** Chrome frame rendering dominates. Consider an ffmpeg-native crop/concat path with a Remotion (or ASS) overlay for captions and hook only.

## Environment notes for cloud sessions
The pipeline needs these, none of which are in the repo:
- Windows paths for ffmpeg (`FFMPEG_PATH`/`FFPROBE_PATH` env override the winget default);
- `bin/` tools installed via `npx tsx src/cli.ts setup`: yt-dlp, whisper.cpp 1.9.2 + base.en model, UltraFace ONNX. The whisper 1.9.2 layout was copied from a local scratch folder; on a fresh machine `setup` prints instructions;
- the `claude` CLI logged in (the LLM backend is `claude -p`; there is no API key);
- network access to YouTube.

Unit tests (`npx vitest run`) need none of these.
