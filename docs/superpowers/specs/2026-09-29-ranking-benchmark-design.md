# Ranking Benchmark — Design Spec (2026-09-29)

**Status: proposed, awaiting approval. Not built.** Addresses HANDOFF open item #5 (ranking precision).

## 1. Problem

Selection finds the right moments but doesn't rank them well. On the Ray Dalio episode:
- candidate recall rose from 40 % to 80 % after the window change;
- shortlist precision was 0/5: the ranker preferred geopolitics over the personal-finance moments DOAC's own team clipped.

That verdict rests on one episode and five labels, which is too little to tune on. Every ranker or weight change so far has been judged by anecdote.

## 2. Goal

Build a repeatable, offline, transcript-only benchmark that:
- scores **how well selection ranks** across all mined episodes that have aligned official Shorts (29 at handoff), not one;
- keeps expensive work (proposals) separate from cheap work (ranking), so a ranker or weight variant costs one LLM call per episode, or none;
- compares variants on identical inputs, with confidence intervals and a written decision rule for promoting a variant to production.

**Out of scope:**
- clip boundaries, hook text, visual fitness, rendering and QC;
- our own published clips' performance (that's `learn`);
- building the benchmark itself (this document asks for approval first).

## 3. Dataset

**Source:** the creator's mining outputs (`data/creators/<slug>/`) plus the cached YouTube subtitles in `data/cache/subs/`. Nothing new is downloaded, and no audio or video is needed.

| Field | Where it comes from |
|---|---|
| Episodes | Every `episodeId` with ≥ 1 entry in `alignments.json` (29 at handoff). |
| Official moments | Per aligned Short: its `segments` (`srcStart`/`srcEnd`), `shortId`, title, and `perf` from `features.json` (`null` if it was too young to score). |
| Transcript | `fetchSubs(episodeId)`: the same json3 words the alignment used, so ground truth and candidates share one timebase. `buildSentences()` as in production. |
| Episode metadata | Title and duration from the `listChannel` cache, falling back to `videoInfo`. |

It's written once to `data/bench/<slug>/dataset.json`, together with a per-episode transcript report:
- word count;
- **punctuation density** (share of words ending in `.?!`);
- median sentence length;
- episode age at mining time.

**Transcript fidelity.** Production transcribes with whisper, which has punctuation. YouTube auto-captions often don't. Without punctuation, `buildSentences` falls back to 1.2 s gaps and 45-word caps, so the proposer sees coarser "sentences". The pilot (§10) measures punctuation density. If it's below 2 %, we switch to gap-based segmentation (maxGap 0.6 s, maxWords 30) and log that in the manifest. We don't add whisper. This is a known, recorded bias; because it's the same for every variant, paired comparisons stay valid.

**Label completeness.** DOAC keeps clipping an episode for weeks, so a recent episode has fewer official Shorts than it will eventually have, and its precision looks worse than it is. Episodes younger than 21 days when mined are flagged `young`. The report shows every metric with and without them.

## 4. Ground truth and matching

A candidate `c` **matches** an official moment `o` when

```
coverage(c, o) = Σ_seg overlap(c, seg) / Σ_seg (seg.srcEnd − seg.srcStart)  ≥  0.3
```

This measures coverage per aligned segment, deliberately unlike today's `eval.ts`, which uses one min→max span. A cold-open Short lifts a line from, say, minute 45 and places it before a moment at minute 12. As one span that covers 33+ minutes, so nothing could ever reach 30 % of it. Per segment, the main body carries the match. The threshold 0.3 matches `eval.ts`; the report also shows 0.5 as a sensitivity check.

**Graded relevance** of a moment, from its performance (`perf = ln(views / channel median)`):

| grade | condition | gain (2^g − 1) |
|---|---|---|
| 3 | perf ≥ ln 2 (≥ 2× median) | 7 |
| 2 | 0 ≤ perf < ln 2 | 3 |
| 1 | perf < 0, or perf unknown (young Short) | 1 |

A moment is credited **once**, to its highest-ranked matching candidate. Later candidates matching the same moment gain nothing, so ranking two near-duplicates of the same idea earns no extra credit.

## 5. Metrics

For each episode:
- `P` is the candidate pool;
- `R` is a variant's ranked list over `P`;
- `k = 6` (the production `--top`).

| Metric | Definition | What it isolates |
|---|---|---|
| **Pool recall** | share of official moments matched by any candidate in `P` | Candidate generation: the ceiling for any ranker |
| **nDCG@6 \| pool** (primary) | DCG of `R`'s top 6 ÷ the best possible DCG using only moments `P` contains | Ranker quality, independent of generation misses |
| nDCG@6 \| all | the same, but the ideal uses every official moment | End-to-end quality |
| Precision@6 | share of the top 6 that match any official moment | Comparable to today's `eval` precision |
| Recall@6 | share of official moments matched in the top 6 | What the shortlist actually recovers |
| MRR | 1 / rank of the first matching candidate | "Is anything good near the top?" |

**Aggregation:**
- metrics are averaged over episodes, with 95 % confidence intervals from a bootstrap over episodes (10,000 resamples, seeded);
- variant comparisons use a **paired** bootstrap of per-episode differences, since every variant ranks the same pools;
- two reference lines are always reported:
  - a random-order baseline (the analytic expectation over permutations of `P`);
  - an oracle that puts every relevant candidate first (equal to 1.0 for nDCG | pool; shown for R@6 and P@6).

**Noise floor.** The claude CLI exposes no temperature or seed. The production ranker (V0) is therefore re-run 3× with the cache off. The spread of its paired differences against itself is the noise floor, and a variant has to clear it.

## 6. Leakage control (required)

Official Shorts already feed the prompts under test in three ways:

1. **Hook-pattern examples** in `playbookPromptBlock`: verbatim opening lines of official Shorts, by construction of the distill prompt.
2. **Audience examples** in `finalRank`: titles of the channel's top 10 official Shorts by perf.
3. **Principles, patterns and ideal duration**, all distilled from those same Shorts (a weaker, indirect leak).

Benchmarking an episode with a playbook that saw its own Shorts would let the ranker recognise the answer. So:

- **Episode folds.** Episodes go into 3 folds, deterministically (`sha1(episodeId) mod 3`, so the split is stable across runs). For fold *f*, a **fold playbook** is distilled with the existing `distill()` from the features of Shorts whose episodes are *not* in *f*: about 2/3 of the 65 features, well above distill's minimum of 8. That costs 3 balanced-tier calls. Audience examples for fold *f* are likewise drawn only from Shorts outside *f*.
- **Weights.** V0 uses the production `pb.weights`, which come from own-results learning, not official Shorts, so they don't leak.
- **Runtime guard.** Before any proposal or rank call for episode *e*, the prompt is checked for any title or opening line (first 12 words) of *e*'s own official Shorts. A hit aborts the run with an error. The guard is covered by a unit test.

Consequence: the benchmark measures a playbook trained on about 2/3 of the data, slightly weaker than production's. That's the same for every variant, so comparisons hold; the absolute numbers are conservative.

## 7. What runs, and how it reuses production code

To make sure the benchmark measures the production code and not a copy, `selectSource` is split. Its behaviour doesn't change, and the existing select tests keep passing:

```
buildPool(input, deps)      proposals per window → range validation → fragment merge → snapBounds
                            → duration filter → dedupe → boundary check (fast tier) → re-dedupe → top 25
rankPool(pool, …)           = finalRank (unchanged)
selectSource                = buildPool → visual fitness (production only) → rankPool → write candidates.json
```

The benchmark calls `buildPool` with the episode's fold playbook and no visual stage (it's transcript-only), then runs each ranking variant over the resulting pool. Candidate ids use `candidateId('bench:<videoId>', …)`.

**Stage 1: pools (expensive, one-off).** For each episode: `buildPool` → `data/bench/<slug>/pools/<videoId>.json`, recording the fold, a hash of the fold playbook, and the transcript source. Cached: a pool is rebuilt only if its inputs' hash changes.

**Stage 2: rank variants (cheap, repeatable).** For each variant, one ranked list per episode goes to `data/bench/<slug>/runs/<runId>/<variant>/<videoId>.json`. Variants in the first batch:

| id | Variant | LLM calls per episode |
|---|---|---|
| V0 | Production `finalRank` (fold playbook + out-of-fold audience examples) | 1 strong |
| B-comp | Sort by `composite` with the production weights | 0 |
| B-rand | Random order (analytic) | 0 |
| V1 | V0 without the per-signal scores and composite (tests anchoring on a possibly miscalibrated first pass) | 1 strong |
| V2 | V0 without audience examples | 1 strong |
| V3 | V0 on the balanced tier (a cost question) | 1 balanced |
| W-cv | `composite` with weights learned by leave-one-episode-out cross-validation on the 7 signal scores against relevance (a coordinate search over w ∈ [0.25, 3], the same range as `learn.ts`) | 0 |

The W-cv variant (and a per-signal Spearman ρ between score and relevance) also shows which proposer signals actually predict the channel's picks. That feeds the weights directly, without paying for any LLM calls.

**Stage 3: report.** Written to `data/bench/<slug>/runs/<runId>/report.md` and `summary.json`:
- a per-variant table (mean and CI for every §5 metric);
- paired Δ against V0, with CIs;
- a per-episode table;
- the young / not-young split;
- the noise floor;
- the cost and wall-clock per stage.

`data/` is gitignored, so results stay local; a summary can be copied into `docs/status/`.

## 8. Decision rule

A variant replaces the production ranker (in a separate PR) only if **all** of these hold:
1. The paired Δ nDCG@6 | pool against V0 is > 0, with the 95 % CI lower bound > 0, and it exceeds the noise floor.
2. Recall@6 isn't worse (the Δ CI upper bound ≥ 0).
3. The result holds with `young` episodes excluded.
4. Its cost per episode is within 1.5× of V0's.

Weight changes from W-cv are proposed as a playbook `weights` update for the user to accept. The benchmark never writes the production playbook.

## 9. Interface

```
cb bench dataset <slug> [--folds 3] [--min-age-days 21]      build dataset.json + transcript report (no LLM)
cb bench pools   <slug> [--episodes N] [--max-usd X]         stage 1 (resumable; stops cleanly at the budget)
cb bench rank    <slug> --variant <id>[,<id>] [--repeat 3]   stage 2
cb bench report  <slug> [--run <runId>]                      stage 3
```

New modules:
- `src/bench/dataset.ts`
- `src/bench/folds.ts`
- `src/bench/metrics.ts` (pure)
- `src/bench/variants.ts`
- `src/bench/report.ts`

Two small extractions from existing code, with production behaviour unchanged:
- `buildPool` from `selectSource` (§7);
- `distillFeatures(features, prior)` from `distill(slug)`, which today always reads the creator's full `features.json`. Fold playbooks need to distill from a subset.

## 10. Cost, time, pilot

**Scale:** 29 episodes of about 1.5–3 h each → roughly 10–20 windows per episode → about 300–450 proposal calls (balanced tier), plus up to 25 boundary calls per episode (fast tier).

**Cost:** the Dalio selection run cost about $2 for a 1.5 h episode. Extrapolating, stage 1 is on the order of $30–60 once. Each LLM ranker variant is 29 strong-tier calls (a few dollars). B-comp, B-rand and W-cv are free. Everything goes through the existing LLM disk cache and ledger, so an interrupted run resumes without paying twice.

**Time and limits:** with `CB_LLM_CONCURRENCY=3`, stage 1 takes a few hours of wall-clock. The `claude -p` backend is subject to plan usage limits (one hit a limit during hook generation earlier), so stage 1 stops cleanly and resumes, and `--max-usd` caps spending.

**Pilot first:** 3 episodes (one per fold) to:
- measure the real cost and time per episode;
- check punctuation density and choose the segmentation (§3);
- sanity-check that the labels match by hand (open 3 matched and 3 unmatched candidates next to the official Shorts);
- make sure the leakage guard fires on a deliberately leaked prompt.

The full run happens only after the pilot's numbers are reported back.

## 11. Testing

Unit tests (pure, no LLM):
- **Matching:** per-segment coverage, cold-open Shorts, the threshold boundary.
- **Credit:** once per moment, duplicates earn nothing.
- **Metrics:** nDCG against a hand-computed example (pool and all), P@k, R@k, MRR, the analytic random baseline checked against a brute-force permutation mean on a small pool, bootstrap determinism under a fixed seed.
- **Folds:** deterministic and complete.
- **Leakage:** a fold playbook's examples and audience titles never come from held-out episodes; the runtime guard throws on an injected leak.
- **`buildPool` extraction:** the existing select tests pass unchanged, plus a fake-backend test that `buildPool` + `finalRank` reproduces `selectSource`'s shortlist on a fixture.
- **End to end:** the `bench` stages on a synthetic 2-episode dataset with a fake backend.

## 12. Risks and limitations

- **Official Shorts are one team's picks, not ground truth.** A moment they didn't clip can still be excellent, so precision underestimates quality. The benchmark measures agreement with a strong reference editor. That's useful for catching the observed failure (topic mismatch), but it isn't the final word. Our own published results (`learn`) remain the real signal.
- **Small n:** about 2.4 official moments per episode across 29 episodes. Confidence intervals will be wide, and only large effects (roughly ≥ 0.1 nDCG) will be detectable. The pilot gives the real variance.
- **Transcript and playbook differ from production** (§3, §6). Deliberate and recorded; it affects absolute numbers, not paired comparisons.
- **Candidate pools are frozen** per playbook hash. Proposal-side changes (window size, proposer prompt) need a stage 1 rebuild, which is a separate and more expensive experiment.
- **Overfitting to 29 episodes.** Mitigated by leave-one-episode-out cross-validation for weights, the paired decision rule and the young-episode check. Before any change ships, it should also be confirmed on the next newly-mined episodes.

## 13. Decisions needed before building

1. **Leakage handling:** fold re-distillation (recommended, about 3 balanced-tier calls), or the cheaper "strip" option (production playbook with held-out Shorts' examples and audience titles removed; principles stay, a weaker guarantee)?
2. **Relevance:** graded by perf (recommended; it rewards picking what performed well), or binary (any official pick counts equally)?
3. **Boundary check in pools:** keep it (recommended, matches production; about 25 fast-tier calls per episode), or skip it to save cost?
4. **Budget:** the `--max-usd` cap for stage 1 (suggested: $60, with the pilot's numbers reported before the full run).
5. **First variants:** V0, B-comp, B-rand, V1, V2, W-cv? V3 (balanced-tier ranking) adds a cost comparison.
