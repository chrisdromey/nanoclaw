# Jev Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Deal Hunter Sonnet spend by (a) measuring it, (b) suppressing immaterial price-change re-evaluations in code, and (c) plumbing TypeSafe Jev into the watcher in shadow mode with a replayable acceptance test for must-have verification.

**Architecture:** All new logic lives in the watcher (host Node process, no credential proxy needed). Jev calls are wrapped in one client module behind `JEV_ENABLED`. Shadow results are stored in a new `offer_requirement_checks` table and change nothing until Phase 3 flags are turned on. Cost is recorded per container `result` message into a new `agent_runs` table.

**Tech Stack:** TypeScript (NodeNext), better-sqlite3, vitest, `@typesafe-ai/sdk` 0.6.0.

**Spec:** `docs/delhunter/jev-integration-handoff.md` (sections 4 #1, #2 and 5 Phases 0–2).

## Global Constraints

- Jev model pinned: `JEV_MODEL` default `jev-1.13.0`; log the response `model` on every call.
- Jev disable switch: `JEV_ENABLED=0` makes every Jev entry point a no-op.
- Never send arithmetic/date questions to Jev; compute in code, pass buckets.
- Must-have verdict strings stay the verbatim `criteria.intent.must_have` values that `record_evaluation` validates against.
- Price history in `prices` must stay complete; suppression only affects notification.
- Schema changes go in `watcher/src/db.ts` `ensureSchema()`; then `cd watcher && npx tsc && systemctl restart deal-hunter-watcher.service`.
- Agent-runner changes: `./container/build.sh`, `rm -rf data/sessions/*/agent-runner-src/`, restart nanoclaw.

---

### Task 1: Phase 0 — cost instrumentation (`agent_runs`)

**Files:**
- Modify: `watcher/src/db.ts` (ensureSchema: new table)
- Modify: `container/agent-runner/src/index.ts` (result handler)
- Test: `watcher/src/db.migration.test.ts`

**Interfaces:**
- Produces table `agent_runs(id, session_id, prompt_head, models, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, duration_ms, num_turns, logged_at)`. Token/cost values are per-result deltas within one container process.

- [x] Add `it('creates agent_runs on a fresh database')` asserting column names; run, see it fail.
- [x] Add the CREATE TABLE to `ensureSchema`; run test, pass.
- [x] In `runQuery`, track `lastPromptHead` (first 200 chars of each pushed prompt) and previous cumulative totals; on `result`, insert a delta row into `/workspace/group/deal-hunter.db` if that file exists (try/catch, log on failure).

### Task 2: Phase 1 — price-change materiality gate (#1A)

**Files:**
- Modify: `watcher/src/config.ts` (`PRICE_CHANGE_MIN_PCT`, `priceChangeMinGbp(vertical)`)
- Modify: `watcher/src/db.ts` (`getPriceAtLastEvaluation`)
- Modify: `watcher/src/change-detector.ts`
- Modify: `watcher/src/scheduler.ts` (do not send a price-change task when a watch-condition task fires for the same offer)
- Modify: `watcher/src/scheduler.test.ts` (config mock keys)
- Test: `watcher/src/change-detector.test.ts` (new)

**Interfaces:**
- `priceChangeMinGbp(vertical: string | null): number` — cars 250, computers 10, default 10; env `PRICE_CHANGE_MIN_GBP_<VERTICAL>`.
- `getPriceAtLastEvaluation(db, offerId): number | undefined` — the latest `prices.price` observed at or before the offer's most recent `evaluations.evaluated_at`.

Rules:
- `price_drop`/`price_increase` fire only when the price moved since the last observation AND `|now − basis|` is ≥ pct or ≥ gbp threshold, where basis = price at last evaluation (fallback: last observation). `details.previousPrice` = basis.
- `watch_condition_met` fires only on a crossing: condition met now and NOT met at the previous observation.

- [x] Write tests: small drop suppressed; 3% drop fires; three £100 drops accumulate against last-eval basis and fire on the third; watch condition fires once on crossing and not on the next poll while still below.
- [x] Run, fail. Implement. Run, pass. Run full watcher suite.

### Task 3: Phase 2 — Jev client + config

**Files:**
- Modify: `watcher/package.json` (already has `@typesafe-ai/sdk`)
- Modify: `watcher/src/config.ts` (read `TYPESAFE_API_KEY`, `JEV_MODEL`, `JEV_ENABLED` from `.env`/env)
- Create: `watcher/src/jev/client.ts`

**Interfaces:**
- `jevEnabled(): boolean`
- `askJev<Q>(state, questions, opts?: {tag?: string}): Promise<SystemOneResult<Q> | null>` — null when disabled or on error (logged). Logs `model`, `input_tokens`, latency ms, question ids.

- [x] Implement client; typecheck.

### Task 4: Phase 2 — must-have checks module (#2) + replay

**Files:**
- Create: `watcher/src/jev/musthave.ts`
- Create: `watcher/src/jev/musthave.test.ts`
- Create: `watcher/scripts/jev-replay-musthave.ts`
- Modify: `watcher/src/db.ts` (table `offer_requirement_checks`)

**Interfaces:**
- `buildMustHaveRequest(input: {mustHaves: string[]; features: FeatureCategory[]; description?: string; cues?: Record<string,string>}) → {state, questions, candidates: Record<qid, string[]>}`
- `mapMustHaveAnswers(req, answers) → RequirementCheck[]` with `{requirement, verdict: 'verified'|'unverified'|'contradicted', evidence, confidence}`
- Table `offer_requirement_checks(offer_id, hunt_id, requirement, verdict, evidence, confidence, model, checked_at, PRIMARY KEY(offer_id, hunt_id, requirement))`.

Candidate construction (pre-parsed extraction): every feature line `"<Category> / <name> (<type>)"` plus description sentences containing any requirement token. One `choice` per must-have with `none` option; one `noul` `features_populated`.
Mapping: chosen candidate, confidence ≥ 0.8 → verified; `none` ≥ 0.8 and populated ≥ 0.7 → contradicted; else unverified.

- [x] Unit test the pure builder/mapper with the Polestar sample (cruise-only → `none` maps to contradicted when populated).
- [x] Replay script: for each hunt-11 evaluation with `requirement_checks` whose offer has `features`, build the request, ask Jev, print a 3×3 confusion matrix (agent verdict × Jev verdict), and list every agent-`contradicted` that Jev called `verified`.
- [x] Run the replay; record results in the handoff doc.

### Task 5: Phase 2 — shadow mode at enrichment

**Files:**
- Modify: `watcher/src/scheduler.ts` (after `mergeOfferAttributes`)
- Modify: `watcher/src/db.ts` (`upsertOfferRequirementChecks`)

- [x] After a successful detail fetch, if `jevEnabled()` and the hunt has `intent.must_have`, run the must-have request and upsert rows. Errors never block enrichment.
- [x] Rebuild watcher, restart service, confirm a log line.

### Task 6: Dashboard — surface Jev scores with probability bars

**Files:**
- Modify: `dashboard/server/routes/offers.ts` (return `jev_checks` rows for an offer)
- Modify: `dashboard/shared/types.ts` (`JevCheck` type)
- Create: `dashboard/src/components/JevChecks.tsx`
- Modify: `dashboard/src/pages/OfferDetail.tsx` (render next to the agent's `RequirementChecks`)

**Interfaces:**
- `GET /api/offers/:id` includes `jev_checks: JevCheck[]` where `JevCheck = { requirement, verdict, evidence, confidence, probabilities: Array<{label: string; p: number}>, model, checked_at }`. `probabilities` is the top five candidate lines by probability, `label` is the human-readable line (not `c12`).

Design: one card per requirement. Header row: requirement text, verdict pill (verified green / contradicted red / unverified amber) and a confidence meter. Body: horizontal bars for the top candidate lines, widest = chosen, animated on mount, `none` rendered as a muted bar labelled "Not in the equipment list". Footer: model id and checked-at. Read the `dataviz` skill before writing the bars; keep it theme-aware and phone-width safe.

- [x] Add the type and the route join (`offer_requirement_checks` by `offer_id`; group by hunt).
- [x] Build the component with a vitest snapshot of the bar widths for one fixture.
- [x] Wire into `OfferDetail.tsx`; agent checks and Jev checks side by side so provenance is obvious.

### Task 7: Deploy

- [x] `cd watcher && npx tsc && systemctl restart deal-hunter-watcher.service`
- [x] `./container/build.sh && rm -rf data/sessions/*/agent-runner-src/ && systemctl --user restart nanoclaw` (or the host's equivalent)
- [x] Update `docs/delhunter/jev-integration-handoff.md` status section with what shipped and the replay numbers.

Deferred to later sessions: #1B (reassess gate replay), #3 auto-dismiss, #4 skip orchestrator, #5 segment binding, #6, #7.
