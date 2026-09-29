# Addendum (2026-09-25) — coverage gaps found in the user-requested audit

Applies to `2026-09-23-clipbrain-mvp.md`. Same Global Constraints.

## Task 18 (runs after Task 10, before Task 12): Visual fitness in selection

**Why:** selection currently ignores shots/faces, so a clip can be strong on paper and bad on screen.

**Files:** Create `src/select/visual.ts`, `src/llm/vision.ts`; Modify `src/select/select.ts`, `src/select/rank.ts`, `src/types.ts` (add optional `visual` to `Candidate`); Test `tests/visualfit.test.ts`.

**Interfaces:**
- `visualMetrics(start: number, end: number, shots: Shot[], faces: FaceSample[], srcAspect: number): VisualMetrics` (pure) where
  `VisualMetrics = { faceCoverage: number; twoShotRatio: number; fitRatio: number; cutsPerMin: number; medianFaceH: number; longestNoFaceSec: number }`
  - faceCoverage = share of 1-fps samples in range with ≥1 face (score ≥ 0.7, h ≥ 0.06)
  - fitRatio = share of the range whose per-shot `planLayout` is `fit`
  - longestNoFaceSec = longest run of consecutive samples without a face
- `visualScore(m: VisualMetrics): { score: number; issues: string[] }` (pure, 0–10):
  start at 10; −3 if faceCoverage < 0.6; −2 if fitRatio > 0.4; −2 if longestNoFaceSec > 8; −1 if cutsPerMin > 20 (jittery crops); −1 if medianFaceH < 0.12 (subjects small in frame); clamp to 0–10; each deduction appends a human-readable issue.
- `llmVisionJson<T>(req: { tier; purpose; system; prompt; schema; images: string[] }): Promise<T>` (vision.ts): same cache + ledger as `llmJson` (cache key also covers sha1 of each image file). It runs the claude CLI with `--tools Read`, `--add-dir <dir of images>`, cwd = sandbox, and a prompt that lists the absolute image paths and says "Read each image file before answering".
- `visionCheck(c: Candidate, framesDir: string): Promise<{ ok: boolean; issues: string[] }>`: extracts 4 keyframes evenly across [start, end] from `proxy.mp4` (ffmpeg, 640px wide JPEG) into `data/sources/<id>/frames/<candId>/`; tier `fast`; asks for problems that metrics can't see (burned-in ads/sponsor graphics, screen-share/slides, people out of frame or looking away, very dark/blurred footage, a third party talking off-camera) and returns issues.
- In `selectSource`, after boundary checks and before finalRank, for the top-20 pool:
  - `candidate.visual = { score, metrics, issues }`, with vision issues appended; each vision issue deducts 1 (max −3).
  - If `visual.score < 5`, then `composite -= (5 − visual.score) × 0.4`.
  - The final-rank prompt shows `visual: <score>/10 — <issues>` per candidate.
- Tests: `visualMetrics` on synthetic faces/shots (coverage, longest gap, fitRatio); `visualScore` deductions.
- Live: re-run `select src_51gj6f62 --top 6 --force` (propose calls are cached). Report visual scores and whether the shortlist changed.

## Task 13 extension: QA that looks at the rendered clip

In addition to the planned technical/audio/content checks:
- `critiqueRender(clip)`:
  - Extract 4 stills from `render.mp4` (at 0.5 s, 25 %, 60 %, 90 %).
  - Call `llmVisionJson`, tier `balanced`, purpose `qc-vision`, with the stills + final transcript + hook.
  - Schema: `{ framingOk, captionsReadable, hookReadable, overlaysCoverFace, verdict: 'keep'|'improve'|'reject', improvements: ('fit_layout'|'next_hook'|'extend_end'|'trim_start')[], reason }`.
- Auto-fix mapping:
  - `fit_layout` → the failing segments use fit
  - `next_hook` → hookIndex+1
  - `extend_end` → end moves to the next sentence end
  - `trim_start` → start moves to the next sentence start, if duration allows
  - After any fix: rebuild the EDL, re-render, and re-run QC (shares the existing max-2-rounds budget).
- A `reject` verdict (or `improve` still failing after 2 rounds) → status `qc_failed` with the reason shown in the review UI.
- QcCheck names: `vision_framing`, `vision_captions`, `vision_verdict` (error severity for reject).

## Task 14 extension: automatic episode discovery (input pipeline)

- `scout(slug: string, o: { latest: number; minDurationSec?: number }): Promise<string[]>`:
  - Calls `listChannel(creator.channelUrl, 'videos', latest × 3)`.
  - Keeps episodes with `durationSec ≥ minDurationSec` (default 900) that have no existing source for that videoId.
  - Returns up to `latest` video URLs, newest first.
- CLI `scout <slug> [--latest 3]` prints them.
- `run --creator <slug> --latest N` (no URL) runs the full pipeline on each scouted episode sequentially.
