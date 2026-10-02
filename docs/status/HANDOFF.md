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

## PRs from the 2026-09-29 cloud session: all MERGED into `main` (2026-10-02)
These came from a cloud session with no ffmpeg pipeline, `bin/` tools, logged-in `claude` CLI or `data/`.

- **Merged:** #3–#8, plus #9. #9 carries #7's benchmark into `main`, because #7 was stacked on #5's branch.
- **Verified on Windows** before merging: the combined result typechecks clean, and **346/346 tests pass**.
- **Not yet verified:** none of it has been run through the real pipeline yet. Do the post-merge checks below.

| PR | What | Status |
|---|---|---|
| TomAlkalai/clipbrain#3 | Open item #1: locked-rename retry and stale-temp sweep in `fetchAndReplaceHires`; crash guards flush output before exit, and the EPERM ignore applies to `uncaughtException` only | Ready for review |
| TomAlkalai/clipbrain#4 | Open item #4: whole-branch review. It fixes `--live=false` → live upload, published clips being re-uploadable, playlist URLs downloading whole playlists, and `run --latest` aborting on the first failure; it also makes the suite green on Linux. It lists all remaining minors. | Ready for review |
| TomAlkalai/clipbrain#6 | Five of #4's new minors: signal-killed child = failure, `finalRank` id filtering, transcribe write order, the review API refusing DNS rebinding and cross-site POSTs, and local-file rotation plus audio-only handling (touches open item #3) | Ready for review |
| TomAlkalai/clipbrain#5 | Open item #5: ranking-benchmark **design**, approved 2026-10-02 with the recommended options (§13) | Ready (approved) |
| TomAlkalai/clipbrain#7 | Stacked on #5: the full benchmark (metrics, folds + leak guard, dataset, `buildPool` extraction, stages 1–3, `cb bench pilot`) | Ready for review |

Suggested order: #4 → #3 → #6 (they merge cleanly in any order), then #5 → #7. With all of them merged together, `tsc` is clean and 346/346 tests pass (checked on Linux). After merging, on the Windows machine:
- `npx vitest run`;
- `requalify` one clip (#3 retry/sweep path);
- `publish` without `--live` (#4 flag parsing);
- **the benchmark pilot:** `npx tsx src/cli.ts bench pilot doac`. It covers 3 episodes, its default cap is $15 of plan usage, and it writes `data/bench/doac/report/report.md`. Review that report (cost and time per episode, pool recall, label sanity) before the full run: `bench pools doac --max-usd 60` → `bench rank doac --repeat 1` → `bench report doac`.

## Open items (in priority order)
1. **Render robustness follow-up: fixed in TomAlkalai/clipbrain#3 (merged). Still to do: verify with one real `requalify` on Windows.** `fetchAndReplaceHires` in `src/render/render.ts`:
   - The `fs.renameSync` over `hires.mp4` needs a short retry/backoff for Windows file locks (EBUSY/EPERM). Right now a locked rename discards a good download.
   - Also: sweep stale `hires.tmp-*.mp4` files.
   - In `src/cli.ts` `installCrashGuards`: flush output before `process.exit`, and only attach the EPERM guard to `uncaughtException`.
2. **Render can hang forever: fixed in TomAlkalai/clipbrain#10 (branch `claude/render-watchdog`, 2026-10-03). Still to do: verify on Windows.** The local `produce src_51gj6f62` (resume) step hung for 5 days while rendering `clip_4v1cw97c`, with headless Chrome left open.
   - **Root cause:** `selectComposition`/`renderMedia` had no timeout or cancel signal, so a lost Chrome connection waited forever. Separately, the static server's `close()` waited for every open connection, so a stalled Chrome request could also hang the `finally` (reproduced in a test).
   - **Fix:**
     - `renderClip` opens its own Chrome and runs launch, composition and frame rendering under a watchdog (`src/render/watchdog.ts`).
     - **Stall timeout:** no Remotion progress for `CB_RENDER_STALL_MIN` (default 5 min).
     - **Hard cap:** `CB_RENDER_TIMEOUT_MIN` (default 60 min).
     - **On timeout:** cancels `renderMedia`, closes that Chrome (also one that only finishes launching after the timeout), and throws a `RenderTimeoutError` with the last progress (stage and frame).
     - **Teardown:** Chrome and the server are always torn down, with a bound; the static server force-closes its connections.
     - **ffmpeg post-steps:** loudness, probe and poster each get a 10-min kill-on-timeout.
   - **What callers do:** unchanged. `produce` keeps the clip `planned` with `clip.error` = the timeout reason and continues with the next clip; a later `produce` retries it. `requalify`, the QC fix loop and the review UI job record the error the same way.
   - **Tests:** 17 new, 363/363 passing on Linux.
   - **Not yet bounded** (lower risk, not part of this fix): webpack bundling, the local-file hi-res re-encode in `ensureHires`, and QC's ffmpeg measurements.
   - **Verify on Windows:**
     - `npx vitest run`
     - `npx tsx src/cli.ts requalify clip_qlgb9gwj`: a normal render must finish and not time out.
     - Optional forced timeout, in PowerShell: `$env:CB_RENDER_STALL_MIN="0.05"; npx tsx src/cli.ts requalify clip_qlgb9gwj; Remove-Item Env:CB_RENDER_STALL_MIN`. Expect "render timed out…", no leftover `chrome-headless-shell` processes, and the error recorded on the clip. Then re-run without the override.
     - `npx tsx src/cli.ts produce src_51gj6f62` to resume `clip_4v1cw97c`.
3. **Production chain at handoff (local).** `clip_4v1cw97c` is still `planned` (see item 2). Resume will retry it; with the watchdog it now either renders or fails cleanly within minutes. The Dalio clips `clip_qlgb9gwj` (stale-hires bug, fixed in da1cc09; needs `requalify`) and ranks 3–5 (hook generation hit a usage limit) need `produce src_xrq3w2z7` / `requalify`.
4. **Local-file input path** (`run <file>`) is implemented but not yet exercised end to end. TomAlkalai/clipbrain#6 fixes rotated phone videos and audio-only files at ingest (checked with real ffmpeg); transcription → render on a local file is still unverified.
5. **Final whole-branch code review**: done in TomAlkalai/clipbrain#4 (with follow-ups in #6); the remaining minors are listed in #4's description.
6. **Ranking precision (highest-value product improvement; design in TomAlkalai/clipbrain#5, benchmark built in #7 — next step: run `bench pilot doac`).** Build an offline ranking benchmark over the 29 recent episodes that have aligned official Shorts: transcript-only (YouTube json3 subs, no video), cheap to run. Use it to tune the ranker/weights instead of anecdotes from one episode.
7. **Render speed.** Chrome frame rendering dominates. Consider an ffmpeg-native crop/concat path with a Remotion (or ASS) overlay for captions and hook only.

## Environment notes for cloud sessions
The pipeline needs these, none of which are in the repo:
- Windows paths for ffmpeg (`FFMPEG_PATH`/`FFPROBE_PATH` env override the winget default);
- `bin/` tools installed via `npx tsx src/cli.ts setup`: yt-dlp, whisper.cpp 1.9.2 + base.en model, UltraFace ONNX. The whisper 1.9.2 layout was copied from a local scratch folder; on a fresh machine `setup` prints instructions;
- the `claude` CLI logged in (the LLM backend is `claude -p`; there is no API key);
- network access to YouTube.

Unit tests (`npx vitest run`) need none of these.
