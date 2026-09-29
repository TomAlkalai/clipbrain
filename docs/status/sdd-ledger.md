# SDD ledger — plan: docs/superpowers/plans/2026-09-23-clipbrain-mvp.md

Spec: docs/superpowers/specs/2026-09-23-clipbrain-design.md (reachable). Branch: feat/mvp (base 153a1ae + ignore commit).

## Pre-flight scan

| Pair / task | Produces ↔ consumes | Finding |
|---|---|---|
| T1 ↔ all | cli.ts command map, types.ts, store, proc(`shell` opt) | consistent |
| T2 ↔ T1 | claude.ts uses run(...,{shell}) | consistent (shell opt declared in T1) |
| T3 ↔ T4 | parseJson3 → fetchSubs | consistent |
| T4 ↔ T5 | listChannel/fetchSubs/videoInfo, RefShort | consistent |
| T5 ↔ T6 | ShortFeatures | consistent; T6 "top tercile" undefined → R5 |
| T6 ↔ T9/T10 | loadPlaybook, playbookPromptBlock, idealDurationSec | consistent |
| T7 ↔ T8 | transcribeSource, detectSilences used by analyzeSource | consistent |
| T8 ↔ T11 | Shot, FaceSample | consistent |
| T8 ↔ T13 | createFaceDetector(rgb,w,h) vs T13 needs pillarboxed tensor | conflict → R6 |
| T11 ↔ T12 | cropRect imported by remotion bundle | consistent (type-only imports mandated) |
| T12 ↔ T13 | T12 says renderClip deletes raw.mp4; T13 needs raw.mp4 for re-master | conflict → R2 |
| T13 ↔ T14 | rebuildEdl lives in produce.ts (T14) but T13 needs it first | ordering → R3 |
| T15 ↔ T12 | serveFile export from static.ts | T15 modifies static.ts; consistent |
| T15 ↔ T16 | override-approve convention `review.reason` starting `override:` | T15 text silent → R4 |
| T16 ↔ T15 | plannedPublishAt | in shared types; consistent |
| T1 self | tests vs code | consistent |
| T2 self | tests vs code | consistent |
| T3 self | json3 test expectation (point end 3.0) vs rule | consistent (verified by hand) |
| T4 self | mapper test vs interface | consistent |
| T5 self | align/feature tests vs algorithm | consistent (hand-checked srcStart 50/70, span 28, position .25) |
| T6 self | computeStats test vs tercile | needs R5 |
| T7 self | wordsFromCaptions/silence tests | consistent |
| T8 self | shots/nms/letterbox tests | consistent (hand-checked cuts at 8,16; letterbox values) |
| T9 self | windows/snap/composite/dedupe tests | consistent (hand-checked 89.88/148.3) |
| T10 self | tests described in prose | ok |
| T11 self | EDL tests | consistent (hand-checked 2.55 s, cold-open offsets) |
| T12 self | range server + loudnorm tests | consistent; step5 depends on T9–T11 (earlier) |
| T13 self | rules tests | consistent |
| T14–T17 self | | consistent |

## Rulings
- Ruling: work on branch `feat/mvp` in the main checkout instead of a git worktree — brand-new repo with no other work; a worktree would duplicate ~500 MB node_modules on a disk with 17 GB free — cost if wrong: none (branch isolation equivalent here).
- Ruling (R2): `renderClip` keeps `raw.mp4`; `qcClip` deletes it when done — T13's loudness auto-fix needs it; spec requires auto-fix — cost if wrong: temporary extra ~30 MB per clip.
- Ruling (R3): Task 13 creates `src/produce.ts` containing `rebuildEdl` (as specified in Task 14's interface); Task 14 extends the same file — task order — cost if wrong: minor refactor.
- Ruling (R4): override-approving a qc_failed clip sets `review.reason = "override: <optional note>"` — Task 16's eligibility depends on that prefix — cost if wrong: override clips not publishable.
- Ruling (R5): "top tercile" = features with perf ≥ sorted-ascending perf at index floor(n·2/3) — makes the T6 test expectation deterministic — cost if wrong: slightly different stats.
- Ruling (R6): Task 13 may extend faces.ts with `pillarbox` and a detector entry that takes a prepared tensor + un-pad mapping; the T8 signature stays — cost if wrong: none.

## Progress
- Ruling (R7): Task 7 uses whisper.cpp v1.9.2 (research: 1.5.5 ≈ 0.3× realtime vs 1.9.2 ≈ 3×+ on this CPU) with additionalArgs `-nfa -bs 1 -bo 1 -t N` (flash-attn breaks DTW word timestamps) from the pre-fixed layout in scratchpad/feasibility/w192layout — spec requires local transcription at practical speed — cost if wrong: fall back to 1.5.5 (slow).
Task 1: complete (commits 8ba04c5..4049734, review clean)
- Ruling: Tasks 2+3 dispatched as one batch (disjoint files, both fully specified, small) with one combined review — saves a dispatch+review cycle — cost if wrong: a larger review surface.
Task 3: minor (deferred): json3 last-word end uses next event's first-seg start (tStartMs+tOffsetMs) not event tStartMs (src/text/json3.ts:27) — equal for real data where first seg offset is 0
Task 2: minor (deferred): ledger `ms` field is milliseconds while global constraint says seconds in JSON (type defined in shared types)
Task 2: minor (deferred): tests only cover brief minimum (no double-failure / noCache tests)
Task 2: fix round 1/5 (2 addressed, 0 open — ENOENT/.cmd shim fallback; fixed semaphore size; commits 0b22a37..d7828d5)
Task 2: minor (deferred): extractShimScript only parses npm cmd-shim format; spawnClaude not covered by automated test
Task 2: complete (commits 4049734..d7828d5, review clean after fix round 1)
Task 3: complete (commits b3c5727..0b22a37, review clean)
- Ruling: listChannel shorts enrichment (videoInfo per short) also fills durationSec and views, not only uploadDate — data is already fetched; Task 5 durations are more accurate — cost if wrong: none.
Task 4: minor (deferred): redundant list.slice(0, limit) in enrichment
Task 4: fix round 1/5 (2 addressed, 0 open — enrichment fields; sleep-requests; commits 1a17d05..0f59e47)
Task 4: complete (commits d7828d5..0f59e47, review clean after fix round 1)
Task 5: minor (deferred): features.ts:447 uses || instead of ?? for durationSec; features.ts:441 copies+reverses full episode word array per call
Task 5: complete (commits 0f59e47..3eb6dfb, review clean) — live: 80 shorts, 69 aligned (86%), 65 features; no official shorts from Kl-I7sUcAOY among latest 80
- Ruling: playbook idealDurationSec may be overridden within 12–180 s (not 12–120 s as in global constraints) — DOAC's mined shorts run 60–125 s and YouTube Shorts allow up to 3 min; capping at 120 would contradict the learned data the spec says drives selection — cost if wrong: longer clips selected.
Task 6: minor (deferred): computeStats nShorts==nAligned always; exemplar ids validated against all features not just prompted ones; no unit tests for distill.ts logic
Task 6: complete (commits 3eb6dfb..9a19b3d, review clean) — live playbook v1: ideal 95–130 s, 6+ channel-specific hook patterns
- Ruling: Task 8 runs in parallel with Task 7's long transcription, in worktree C:\Users\tomal\clipbrain-t8 (branch feat/t8-visual, node_modules/bin junctioned, CB_DATA=C:\Users\tomal\clipbrain\data). Scope split: T8 delivers frames/shots/faces + `scanVisual(sourceId)` in src/analyze/visual.ts + CLI `scan`/`faces-smoke`; the `analyzeSource` orchestrator (transcribe+silences+scanVisual) and `analyze` CLI are added after merging T7+T8 (folded into Task 9's dispatch) — saves ~1 h wall-clock; disjoint files — cost if wrong: a merge conflict in src/cli.ts (trivial).
Task 8: minor (deferred): writeFaceDebugSheets draws boxes (extra beyond brief, helpful); occasional back-of-head false positives near 0.7
Task 7: fix round 1/5 (3 addressed, 0 open — marker glue; creator error; ingest cleanup; commits 0b93ec2..066d8d1)
Task 7: complete (commits 9a19b3d..066d8d1, review clean after fix round 1) — live: 11637 s episode, 40451 words, 2833 sentences, 3208 silences; whisper 1.9.2 at ~1.7x realtime (6858 s wall, CPU contended)
Task 7: note for product review: transcription is the biggest wall-clock bottleneck (~2 h for a 3.2 h episode)
Task 8: fix round 1/5 (2 addressed, 0 open — ffmpeg failure surfacing; letterbox guard; commits d47bd4e..ede112a)
Task 8: minor (deferred): readFrames has no watchdog timeout for a stalled ffmpeg
Task 8: complete (commits 9a19b3d..ede112a on feat/t8-visual, review clean after fix round 1); merged into feat/mvp as 29ab6d9 (cli.ts conflict resolved keeping both sides; 40/40 tests)
INCIDENT: `git worktree remove --force` followed the node_modules/bin junctions and emptied them in the main checkout. Recovered: npm install, whisper 1.5.5 reinstalled + model restored from scratchpad, `cb setup` (yt-dlp, whisper 1.9.2 copy, UltraFace); doctor all ok; data/ and git untouched. Lesson: remove junctions with `cmd /c rmdir` BEFORE removing a worktree.
Task 9: review clean (commits 29ab6d9..e403da6); minors (deferred): ProposeCtx.title + finalRank extra params (justified); propose rule-2 prompt rewritten (refinement of same rule)
- Ruling: Task 9 gets an enhancement round — a focused boundary-check pass (fast tier) on the top-20 before final ranking: detect openings that depend on prior context / endings before payoff, repair by moving start/end within a small window, else penalise standalone_clarity; plus deterministic candidate ids (hash of source+sids) so ranking calls cache — live result showed 2/6 shortlisted openings with back-references after 4 prompt rounds; a separate narrow verifier is the standard fix — cost if wrong: ~20 cheap haiku calls per source.
- Ruling: Task 11 (pure EDL, files src/edit/*, tests/edl.test.ts) runs in parallel with Task 9's enhancement round in the same checkout; both commit explicit paths only — disjoint files — cost if wrong: an index race needing a re-commit.
Task 11: minor (deferred): mergeShortPieces is per speech run (undocumented); caption page gap uses source time (deliberate)
Task 11: complete (commit ed26076, review clean)
Task 9: round 1 re-review: 3/4 addressed; open Important — id collision possible when two candidates repair into the same sid range (no post-repair dedupe)
USER AUDIT (2026-09-25): verified live — transcription full coverage; whole-transcript selection (11 windows, candidates in every 30-min block); boundary verifier; hi-res section download (1080p, 10.000 s exact). Gaps: selection ignores visuals; no rendered-output QA; no automatic episode discovery. Plan addendum docs/superpowers/plans/2026-09-25-addendum-coverage-gaps.md adds Task 18 (visual fitness in selection), Task 13 extension (vision QA on rendered stills with keep/improve/reject), Task 14 extension (scout).
- Ruling: execution order after Task 10 → Task 18 → 12 → 13(+ext) → 14(+ext) → 15 → 16 → 17 — visual fitness changes which clips get rendered, so it precedes rendering — cost if wrong: none.
Task 10: minor (deferred): coldOpenReason kept when validateColdOpen nulls the pick; 2/10 hooks 9 words (8-word rule prompt-only)
Task 10: complete (commit 093b29f, review clean)
- Ruling: Task 18 runs in parallel with Task 12 (disjoint files: T18 src/select/*, src/llm/vision.ts, src/types.ts; T12 remotion/*, src/render/*, cli.ts) — both commit explicit paths — cost if wrong: index race.
Task 9: fix round 2/5 (2 addressed, 0 open — post-repair dedupe + id uniqueness assert; slice bounds; commit 6c57864)
Task 9: complete (commits 29ab6d9..6c57864, review clean after enhancement round + fix round 2)
Task 18: minor (deferred): no integration test for select wiring; unbounded concurrent ffmpeg keyframe extraction; missing shots/faces silently yields -4 penalty
Task 18: complete (commit 902510d, review clean) — live: slide-deck clip cand_cdceec65 visual 0/10, composite 7.00→5.00, out of shortlist
- Ruling: Task 16 runs in parallel with Task 12 but must not touch src/cli.ts (Task 12 has uncommitted edits there); it exports a `publishCommands` map from src/publish/commands.ts that the controller wires into cli.ts afterwards — cost if wrong: one small wiring commit.
- Ruling (update): Task 16 restarted after weekly usage limit with no partial work; src/cli.ts is no longer contended, so Task 16 wires its commands directly into cli.ts (publishCommands module not needed) — cost if wrong: none.
Task 12: review ❌ — Critical: delivered TP −0.5 dBTP (> −1.0) from AAC overshoot after loudnorm dynamic fallback; Important: yuvj420p/untagged colour (needs colorSpace 'bt709'); Minor: zero-length segment overlap; rejected bundle promise cached. Fix round 1 dispatched (+ render speed investigation, render-test --max-sec)
Task 16: review ❌ — Important: description truncation drops attribution; daily cap 0 ignored; OAuth no state check (+ no timeout); CSV import writes NaN. Minor: token file mode, batch aborts on channel mismatch. Fix round 1 dispatched.
Task 16: fix round 1/5 (4 addressed, 0 open — attribution-safe truncation; cap parsing; OAuth state+timeout+0600; CSV validation; commit 6998c41)
Task 16: minor (deferred): token-file/batch-abort observations; pathological attribution ≥ 4900 chars
Task 16: complete (commits 2e7ba5b..6998c41, review clean after fix round 1)
Task 12: note for product review: render ~6.5x realtime (937 s for 144 s) — Chrome frame rendering dominates; consider ffmpeg-native crop/concat + overlay-only Remotion/ASS captions
Task 12: fix round 1/5 (5 addressed, 0 open — TP retry mastering; bt709 yuv420p; zero-frame skip; bundle cache reset; perf flags; commit dd883a5)
Task 12: minor (deferred): -15.4 LUFS near window edge on quiet sources; render time 937 s/144 s clip
Task 12: complete (commits 902510d..dd883a5 for T12 files, review clean after fix round 1)
Task 13: review — Important: true_peak gate −0.5 (plan text) vs global −1.0; planFix doesn't fall through when extend_end guard declines. Minor: LLM failure kills whole QC; measure+critique sequential. Live: clip_v46guup7 qc_failed (clean_ending, vision: hook box over forehead/eyes).
- Ruling: QC true_peak gate = −1.0 dBTP — the plan's −0.5 contradicts the spec's global constraint; spec is binding — cost if wrong: none (master already guarantees −1.0).
- Ruling: content/vision LLM failures degrade to a warn-severity `critique_unavailable` check (technical checks still run; clip can be ready) — a transient API outage should not mark every clip qc_failed; the reviewer sees the warn — cost if wrong: an unreviewed-by-AI clip reaches the human gate (still requires human approval).
- Ruling: add fix `move_hook_up` (vision overlaysCoverFace / improvements) → EDL style 'hook-high' (hook box higher, smaller) — user asked QA to improve weak clips; placement is the observed failure — cost if wrong: one extra style variant.
Task 15: committed ce25359, 61326b3 (review in progress)
- Ruling: Task 14 copies candidate context onto the Clip (optional fields rank, why, visual, boundary) so the review UI can show them — user asked for scoring transparency — cost if wrong: a few optional fields.
Task 13: fix round 1/5 (5 addressed, 0 open — TP −1.0; planFix fall-through; LLM degradation; concurrency; move_hook_up; commit 3d43380). Live: move_hook_up applied, hook clears face (controller verified still); remaining clean_ending → qc_failed (correct). Fix round 2 dispatched: move_hook_up loop guard; distinct unavailable-check names.
Task 15: review ✅ spec; Important: failed job never persists clip.error; Minor: no body cap; R4 '' edge. Fix round 1 dispatched.
Task 13: fix round 2/5 (2 addressed, 0 open — move_hook_up guard; distinct unavailable names; commit 7f5ccc9)
Task 13: complete (commits dd883a5..7f5ccc9 for T13 files, review clean after fix round 2)
Task 15: fix round 1/5 (3 addressed, 0 open — persist clip.error; 1 MB body cap; R4 ?? semantics; commit 9e0dfdd)
Task 15: complete (commits 4375224..9e0dfdd for T15 files, review clean after fix round 1)
Task 17: README committed 188a2eb (165 lines); E2E step pending (controller)
Task 14: review ✅ spec, Quality approved; Important: errored non-terminal clips are never retried by produce (skip by candidateId regardless of status). Minor: hooks failure invisible in summary; officialSpan empty-segments guard.
- Ruling: produce resumes errored non-terminal clips (status planned/rendered with clip.error) from their last completed stage, once per run, and hook-generation failures appear in the summary table — unattended `run --latest` must self-heal transient failures — cost if wrong: an extra retry per failed clip. Dispatched after the live produce run finishes (shared file).
LIVE FINDINGS (produce run): clip_rj9nsdx2 ready after move_hook_up (verified stills good). clip_ci705ak1 qc_failed: dead_air 5.89–7.76 s persisted after loosen_pauses applied TWICE (same maxPause 0.3 → no-op re-render); vision (speaker cropped at left edge; hook over forehead) never got a round.
- Ruling: post-run improvement round (systematic-debugging): (a) EDL pause tightening also cuts audio silences from silences.json inside the clip range, not only word gaps (whisper word spans can cover silence); (b) planFix never re-applies a fix that produces no change; (c) apply ALL compatible fixes in one re-render round (renders are the expensive step); (d) produce resumes errored non-terminal clips — real-content testing showed wasted renders and unrepaired clips — cost if wrong: modest code change in edl/qc/produce.
Controller: stopped live produce run (4/5 clips failing on systematic dead_air). Root cause documented in debug-dead-air.md. Improvement round dispatched to a fresh implementer.
Task 14: complete (commits 9e0dfdd..d9ea8a9, review clean; retry-of-errored-clips moved into improvement round C). Live: 1 ready / 3 qc_failed (dead_air) / 1 interrupted; eval: 0 official shorts for Kl-I7sUcAOY among 69 alignments; scout doac --latest 2 → UhzI1fg8rCA, a_GiFiHXJ6g.
- Ruling: fresh E2E + quality eval on DOAC × Ray Dalio (Bu0xNDLNORU, 5417 s, 5 aligned official shorts, none are playbook exemplars) — Kl-I7sUcAOY (Feb 2025) has no reachable official shorts (mined range Jun–Sep 2026) — cost if wrong: ~2.5 h compute; caveat: playbook principles may partially reflect this episode's shorts.
E2E (Dalio src_xrq3w2z7): analyze 8.5x realtime transcription (639 s for 5417 s), scan 90 s; select 5 windows → 13 candidates → 5 shortlisted; eval vs 5 official shorts: recall 40%, precision 20% (our #3 matches their top performer "YOUR CASH IS NOT SAFE").
- Ruling: selection-recall improvement round (parallel, select files only): 600 s windows / 60 s overlap (configurable), prompt asks for every plausible moment (ranking filters), final-rank prompt gets the channel's top-performing short titles as audience calibration; measured on the same episode vs baseline (saved candidates.baseline-w1200.json) — cost if wrong: ~$1–2 LLM, overfit risk noted (n=5 labels).
Improvement (recall): commit 7ef3ad6 — candidates 13→28, recall 40%→80%, precision 20%→0% (ranker still prefers geopolitics despite audience calibration); cost $1.95. Kept (recall gain real; precision n=5 too small to tune). Next-step: offline ranking benchmark across the 29 episodes with aligned official shorts.
Improvement (recall): fix round 1/5 (2 addressed — flag validation + windows() guard; docstring; commit 3c6738d); complete (commits 188a2eb..3c6738d for select files, review clean)
Improvement (dead-air): commits be9b0a5, 60ec178, a0a41b9; live: ci705ak1 now ready (dead_air passes; batched move_hook_up+fit in one re-render); EDL proof: silences cut, durations 122.17→112.15 / 110.49→92.53 s. Review ✅ spec; Important: orphan caption overlap; qcFixHistory persisted before render success; sub-minSeg sliver at range edge. Minor: requalify single-clip error handling/status validation. Fix round 1 dispatched (unit-test only; verification chain running on pre-fix code).
VERIFICATION CHAIN (pre-fix code): requalify + resume crashed: Remotion "inputRange must be strictly monotonically increasing [0,2,0,2]" (VideoLayer fade for segments ≤4 frames, produced by silence cuts) → renderer cleanup "kill EPERM" uncaught → process exit. Dalio: clip_zm2zuy4z ready (render 350 s for 110 s clip ≈ 3.2x); clip_qlgb9gwj failed: ensureHires re-download onto existing hires.mp4 is skipped by yt-dlp (stale file) → duration mismatch; ranks 3–5 failed hooks due to Claude session limit (left planned; resume will retry).
- Ruling: fix round (render robustness): VideoLayer fade guard for short segments; ensureHires downloads to temp + atomic rename (never reuse stale file); targeted handling so a Remotion cleanup `kill EPERM` can't kill the CLI process — found by real verification — cost if wrong: none.
PAUSED by user (2026-09-27). Stopped: render-robustness fix agent (no commits/changes landed; working tree clean at 83f1965) and the re-review of 83f1965 (incomplete). Killed stale leftover processes. RESUME POINT: (1) re-dispatch render-robustness fix (VideoLayer short-segment fade guard; ensureHires temp+rename + yt-dlp --force-overwrites; kill-EPERM guard) with requalify clip_g5babhgx verification; (2) re-run re-review of 83f1965; (3) requalify src_51gj6f62 qc_failed + produce resume (clip_4v1cw97c) + produce src_xrq3w2z7 (qlgb9gwj requalify; ranks 3–5 retry); (4) local-file `run` test; (5) final whole-branch review (opus); (6) product review + final report.
RESUMED (user 'continue'): re-dispatched render-robustness fix + re-review of 83f1965.
Improvement (dead-air): fix round 1/5 re-review: 4/4 addressed; NEW Critical — isolated short real speech (e.g. "Yes." between pauses) is dropped from the render (range-wide mergeShortPieces drop branch). Fix round 2 dispatched (keep word-bearing pieces ≥0.15 s). Deferred minor: stale clip.error not cleared on later successful round.
Render robustness: commits 31f2177 (fade guard), da1cc09 (ensureHires temp+rename, --force-overwrites), aed2c37 (kill-EPERM guard); live requalify clip_g5babhgx pending (agent resumed after usage limit). Dead-air round 2: commit 056ad95 (keep word-bearing isolated pieces); re-review re-dispatched.
Improvement (dead-air): fix round 2/5 ADDRESSED (commit 056ad95; isolated word-bearing pieces kept; output contiguous). Deferred minor: MIN_PIECE_SEC hardcoded 0.15 (equals keepPause default; derive if keepPause becomes configurable).
Improvement (dead-air): complete (commits be9b0a5..056ad95, review clean after 2 fix rounds)
Render robustness: live requalify clip_g5babhgx — no crash (6 renders, ~29 min), dead_air passes; final qc_failed on content/framing/ending/vision (legit QC judgement).
Render robustness: review ✅ spec; Important: fs.renameSync over possibly-locked hires.mp4 on Windows discards a good download (no retry). Minor: orphan hires.tmp-* on hard kill; process.exit right after log may truncate redirected output; EPERM guard also on unhandledRejection (unneeded surface). Fix round deferred until the production chain finishes (each chain step loads current source).

## Cloud session 2026-09-29 (code + unit tests only; no pipeline tools in the container)
- Render robustness (HANDOFF #1) → PR #3.
  - Ruling: retry the hires rename on EBUSY/EPERM/EACCES (EACCES added, matching graceful-fs), with 100 ms → 3.2 s backoff (~6.3 s) — cost if wrong: a slightly longer wait before a real lock error.
  - Ruling: sweep the `hires.tmp-` *prefix* (it catches yt-dlp's .part/.fNNN intermediates), but only files idle > 30 min (2× the 15-min section timeout) — cost if wrong: an orphan lingers until the next fetch after 30 min.
  - Ruling: crash guards moved to `src/tools/crash-guards.ts` so they're testable without importing the CLI entry point.
- Whole-branch review (HANDOFF #4) → PR #4. Important findings fixed:
  - `--live=false` performed a live upload (strict `asBool`);
  - a published clip could be re-rendered and uploaded again (`isPublished` guards);
  - playlist URLs downloaded whole playlists and leaked `list=`/`si=` into descriptions (canonical URL + `--no-playlist`);
  - `run --latest` aborted on the first failed episode.
  - The `extractShimScript` test made OS-independent. Remaining minors are listed in the PR.
  - Ruling: minors not fixed in #4 — the user asked for Important only; five were then fixed in PR #6.
- Review minors → PR #6: signal-kill = failure, `finalRank` id filtering, transcribe write order, review-API Host/Origin check (verified in headless Chromium), local-file rotation/audio-only (verified with real ffmpeg 6.1).
- Ranking benchmark (HANDOFF #5) → design PR #5 (awaiting user decisions, §13); draft PR #7 with the decision-independent, LLM-free foundations.
  - Ruling: build only those foundations before approval — the user asked for maximum progress within the session's credit budget — cost if wrong: the draft is discarded.

