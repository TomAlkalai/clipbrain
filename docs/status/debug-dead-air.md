# Root-cause investigation: dead_air QC failures (2026-09-26)

## Symptom
clip_ci705ak1 and clip_g5babhgx both end `qc_failed` with `dead_air` (silence ≥1.2 s in the render), even after the `loosen_pauses` fix (maxPause 0.3) was applied twice (two no-op 15-min re-renders).

## Evidence (output time → source time via EDL segments + hiresOffset)
- clip_ci705ak1:
  - dead air at out 5.89–7.76 s maps to source 3077.70–3079.57.
  - silences.json (silencedetect −35 dB, d 0.35) has a real silence at **3077.56–3079.50 (1.94 s)**.
  - whisper words cover it: `as[3077.60-3077.84] a[3077.84-3077.96] business[3077.96-3078.93] grows,[3078.93-3079.78]`, so no word gap exists.
- clip_g5babhgx:
  - dead air at out 19.08–20.60 s maps to source 7277.61–7279.13.
  - silence **7277.46–7279.08 (1.63 s)**.
  - words cover it: `they[7277.19-7277.47] have[7277.47-7277.77] across[7277.77-7278.22] the[7278.22-7278.41] company,[7278.41-7279.06]`.
  - This clip's middle EDL segment runs 51.5 s (out 5.33–56.87) with **no tightening at all**, even though silences.json lists ~19 silences of 0.4–1.6 s in that range.

## Root cause
`buildEdl` tightens pauses only where consecutive whisper words have a gap > maxPause. whisper.cpp base.en DTW word timings smear across real pauses (adjacent words absorb the silence), so word gaps are ~0 and real silences survive. The audio silences, already detected in `data/sources/<id>/silences.json`, are never used by the EDL.

Secondary effect: captions are timed from the same smeared words, so the words shown during a silence are out of sync by up to ~1.5 s.

## Also observed in the QC loop
1. `planFix` re-applied `loosen_pauses` with the same maxPause 0.3 (no change), wasting a full re-render.
2. Only one fix is applied per round, so valid vision complaints never got a round:
   - ci705ak1: speaker cropped at the left edge (→ fit_layout); hook over the forehead (→ move_hook_up).
3. From the Task 14 review: `produce` never retries errored non-terminal clips.
