# Jev (TypeSafe System One) integration — handoff

**Status:** Phases 0–2 shipped 2026-09-20 (shadow mode, nothing auto-dismissed yet). See "Implementation status" below. Plan: [docs/superpowers/plans/2026-09-20-jev-integration.md](../superpowers/plans/2026-09-20-jev-integration.md).
**Goal:** cut Deal Hunter model spend by moving judgment-only steps from Sonnet sub-agents to TypeSafe's Jev, and by adding the code gates Jev needs in front of it.
**Read first:** [deal-hunter-architecture.md](deal-hunter-architecture.md) for the pipeline and seams. This doc assumes that model.

---

## 1. What Jev is

Jev is TypeSafe's first "System One" model (blog: https://typesafe.ai/blog/introducing-system-one-models-and-jev, docs: https://docs.typesafe.ai, index at https://docs.typesafe.ai/llms.txt). It is trained with "Reinforcement Learning for Calibrated Decisions" to return **typed, calibrated decisions instead of text**. It cannot write prose. It samples a probability distribution over options you define, so schema errors are structurally impossible.

### API shape

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
{ "model": "jev-latest", "state": <string | object | array>, "questions": { "<id>": Question, ... } }
```

Three question types. All take `instructions` (string or JSON object). Questions in one call are evaluated **independently and in parallel** against the shared state, so adding a question never changes another's answer.

| Type | `criteria` | Returns |
|---|---|---|
| `noul` | optional `{true: "...", false: "..."}` | `noul` — probability the answer is yes (0–1). No confidence field. |
| `choice` | map of option → description (≤255 options; `null` allowed) | `choice`, `probabilities` per option, `confidence` (0–1, from distribution shape) |
| `score` | ordered array of 2–10 level descriptions | `score` (probability-weighted mean), `probabilities` per level, `confidence` |

Response: `{ model: "jev-1.13.0", answers: {...}, usage: { input_tokens, output_tokens } }`.

`instructions` and `criteria` may be JSON objects; point at state fields by name in backticks (`` `features` ``). This is the recommended way to pass reference data (e.g. the KB's "verify on a listing" cues) alongside the question.

### SDKs

- JS/TS: `npm install @typesafe-ai/sdk` (v0.6.0, Node ≥ 20, ESM+CJS, typed answers inferred from questions). `new TypeSafeClient()` reads `TYPESAFE_API_KEY`; `client.systemOne({state, questions})`. Helpers `choice()`, `noul()`, `score()`. Built-in retry with backoff honoring `retry-after`.
- Python: `pip install typesafe-sdk`.
- Also on Vercel AI SDK (`experimental_evaluate`, model `typesafe-ai/jev`) and Cloudflare Workers AI (`typesafe/jev`). Not needed here; the watcher is plain Node.
- A Claude Code plugin exists (`claude plugin marketplace add typesafe-ai/skills` → `claude plugin install typesafe@typesafe-ai`) that teaches an agent the API and patterns. Useful for the implementer, not for runtime.

### Limits and pricing (jev-1.13.0, checked 2026-09-20)

| | |
|---|---|
| Price | $0.042 per 1M input tokens; **output free** |
| Context | 64K tokens per request (state + all questions); 32K for state + longest single question |
| Rate limits | 250,000 tokens/s, 1,200 req/min (early access, "adjusting dynamically") |
| Latency | 70–500 ms end to end |
| Input | text only (string / JSON object / array). No images. English best. |
| Aliases | `jev-latest` and `jev-preview` both → `jev-1.13.0`. **Pin the versioned ID** once thresholds are tuned; the response `model` field says which version answered, log it. |
| Data | not trained on customer requests; ZDR available on enterprise |

At ~2–4K tokens per listing (filtered feature list + description), a Jev call is **~$0.0001–0.0002**. Jev's own cost is negligible for everything below; the saving is the Sonnet work it displaces.

### Documented failure modes (from https://docs.typesafe.ai/model-jaggedness/jev-1.13)

These drive the design. Every item in section 4 obeys them.

1. **Literal reading.** Answers the question as written, not as meant. Put boundary cases in `criteria`. Split interpretive questions into two literal ones.
2. **No arithmetic, no counting.** Never ask "is the price below the band"; compute in code and pass a named bucket.
3. **No date comparison.** Auction end times, "X days on market": code.
4. **Indirection.** Avoid double negatives and multi-hop reasoning; name the state field the question is about.
5. **Context rot.** Accuracy falls as irrelevant state grows. Filter to the fields the question needs. Do not send the whole `attributes` blob.
6. **Adversarial content.** Seller copy ("LOADED WITH SPEC!!!!!") can move answers. Be explicit in criteria; test on real listings.
7. **Contradictory instructions vs criteria.** Keep them aligned; a noul whose `true` means "no" performs badly.
8. **No structural invariants.** A noul and an equivalent yes/no choice give different numbers; `P(x)` and `1-P(not x)` do not sum to 1. Don't carry a threshold from one form to the other.
9. **No generation.** For extraction, have code find candidates (regex / alias table) and let Jev **pick** one (the "pre-parsed value extraction" cookbook). The chosen value is copied verbatim by code, so it cannot be invented.

Recommended confidence policy from the docs: `< 0.5` escalate, `0.5–0.9` act with caution / flag, `> 0.9` act automatically. Vary the bar by action cost.

Relevant cookbooks: pre-parsed value extraction, SDE cascade (cheap extract → Jev verify → escalate), classifying RAG passages, citation check, re-ranking, parallel questions (13 questions in one call was 12.2× cheaper and 10× faster than 13 calls).

---

## 2. The current system, as it matters here

The full inventory is in section 7. The short version:

- **One LLM entry point** in the whole repo: `query()` from `@anthropic-ai/claude-agent-sdk` in `container/agent-runner/src/index.ts:472`. No raw Anthropic calls, no other provider. Host (`src/`), watcher, dashboard, gate, and MCP servers are all code.
- **Five model-bearing roles:** orchestrator session (`sonnet`, `index.ts:478`); per-vertical evaluators `cars-evaluator` / `deal-evaluator` (`sonnet`, `vertical-agents.ts:120`); `market-researcher` (`sonnet`, `index.ts:623`); `musthave-verifier` (`sonnet`, `index.ts:654`); `generic-deal-evaluator` (`haiku`, `index.ts:677`, fallback, serves no configured vertical). `verticals.yml` `agent:` blocks have no `model:` key.
- **Container traffic goes through the credential proxy** (`src/credential-proxy.ts`, `src/container-runner.ts:229`). The container has placeholder keys only. A Jev call from inside the container would need the proxy extended; a Jev call from the watcher (host Node process) needs nothing.
- **No cost accounting exists.** Only `COMPACT_THRESHOLD_TOKENS` (100K) and a cumulative input-token counter that triggers `/compact` (`index.ts:729-740`). `hunt_log` has no cost column; dashboard `daily_usage` is source-API calls.
- **Every listing that survives `(source, source_id)` dedupe goes to a Sonnet evaluator.** There is no content-based pre-filter anywhere in the watcher. The only guards are volume caps: `MAX_TRIAGE_BATCH_PER_RUN=40`, `STALE_QUEUE_DAYS=7` auto-dismiss, drain cadence / re-announce backoff (`watcher/src/config.ts:56-78`, `scheduler.ts:532-588`).
- **The watcher already fetches the AutoTrader detail page** for cars (`scheduler.ts:466-490`, `MAX_DETAIL_FETCHES_PER_TICK`) and stores it in `offers.attributes`: `subTitle`, `attentionGrabber`, `year`, `distance_miles`, `seller_type`, `price_tier`, `owners`, `features` (categorised, each item `Standard`/`Optional`), `specs`, `description`. Average 4.1 KB, max 13 KB. This is exactly the evidence the evaluator's Step 2b must-have check reads.
- **Change detection is deterministic and ungated** (`watcher/src/change-detector.ts`): any price move `> £0.01` fires `price_drop`/`price_increase` → `sendPriceChangeNotification` → IPC task → container → orchestrator → `cars-evaluator` sub-agent. `watch_condition_met` fires when price crosses `alert_if_price_below_gbp` or `max_price`.
- **Verdict enforcement is already code.** `record_evaluation` (`deal-hunter-mcp.ts:1128-1205`) validates `requirement_checks` by exact string against `criteria.intent.must_have`, refuses ALERT on a feature-led hunt without full coverage or with any `contradicted`, and auto-populates `watch_conditions.verify_required`.

### Pipeline stages and what kind of work each is

| # | Stage | Kind | Model |
|---|---|---|---|
| 1–4 | Cadence, criteria→source filters, search, dedupe, `hunt_offers status='new'` | code | — |
| 5 | Detail enrichment (cars): regex over pills/marketing copy | heuristic | — |
| 6–8 | Stale flush, batch caps, IPC prompt templating | code | — |
| 9–10 | Container spawn; orchestrator reads prompt, spawns one Task per hunt | LLM | sonnet |
| 11 | Evaluator orientation: `get_hunt_summary`, hunt md, KB, preferences | LLM+SQL | sonnet |
| **12** | **Pass-1 triage** from slim `list_offers` rows → `batch_dismiss` (reject rules, wrong trim/body/age/budget/distance) | **LLM classification** | sonnet |
| 13 | `autotrader_detail` on survivors; tier → lean via fixed table | tool call + table | sonnet |
| **14** | **Must-have check per offer**: semantic match of each `must_have` against `features` → verified/contradicted/unverified + evidence | **LLM 3-way classification + extraction** | sonnet |
| 15 | Comp search + median delta | tool + arithmetic | sonnet |
| **16** | **ALERT / WATCH / SKIP** | **LLM 3-way classification** | sonnet |
| 17 | `record_evaluation` gate | code | — |
| 18 | Alert headline + 1–2 sentences | **genuine text generation** | sonnet |
| 19 | WATCH → numeric `watch_conditions` | LLM picks number | sonnet |
| 20 | Return ≤500-word summary; orchestrator relays, `log_hunt_run` | LLM | sonnet |
| 21–22 | Watched-offer re-poll, change detection → back to 9 | code | — |

Stages 12, 14, 16 and the re-entry at 21–22 are where Jev fits. Stage 18 must stay generative.

---

## 3. Spend data (measured, not estimated)

Source: every `data/sessions/telegram_main/.claude/projects/-workspace-group/**/*.jsonl`, summing `message.usage` on assistant turns, priced at **Sonnet list** (input $3, 1h cache write $6, cache read $0.30, output $15 per Mtok). If billing is via subscription the cash number differs; proportions hold. Script in appendix A.

**Period:** June → 20 Sep 2026. **Total ≈ $1,136** ($9 Jun, $413 Jul, $465 Aug, $248 Sep-to-date). **88% inside sub-agents.**

| Run type | Runs | $ total | $/run | calls/run | evals | $/eval | median peak ctx |
|---|---|---|---|---|---|---|---|
| sub: new-offer triage | 101 | 550 | 5.45 | 57 | 968 | 0.57 | 152K |
| sub: price-change reassess | 432 | 216 | 0.50 | 9 | 420 | 0.51 | 39K |
| sub: watch-condition eval | 309 | 189 | 0.61 | 11 | 289 | 0.65 | 45K |
| main: price-change wrapper (spawn + relay only) | 219 | 78 | 0.35 | 4 | 0 | — | 47K |
| main: new-offer wrapper | 36 | 33 | 0.90 | 5 | 0 | — | 49K |
| sub: musthave verify | 35 | 32 | 0.92 | 26 | | | 46K |
| main: watch-condition wrapper | 76 | 30 | 0.39 | 6 | 0 | — | 48K |
| sub: market research | 8 | 6 | | | | | |

Tools per triage run: `autotrader_detail` 10.7, `record_evaluation` 9.6, `Read` 6.7, `Bash` 5.0 (Bash has since been removed from evaluators), `update_offer` 5.0.

### Verdict data from `groups/telegram_main/deal-hunter.db`

- Decisions overall: **skip 62%** (2,836), watch 27% (1,255), alert 11% (485).
- `hunt_log` triggers: watch-condition 624 runs, price-change 597, new-offers 380, daily-review 107.
- Hunt 11 (family-ev, the only active hunt): 1,791 first evaluations, **744 re-evaluations, of which 588 (79%) returned the same verdict as the previous one.** Transitions: watch→watch 490, skip→skip 79, watch→alert 74, alert→watch 42. Some offers re-evaluated 20–55 times.
- `requirement_checks` on hunt 11: 3,316 verdicts — verified 3,131, unverified 118, contradicted 67. **This is a labelled dataset to validate Jev against before switching anything.**
- Typical skip reasons: above segment band (arithmetic), too far (arithmetic), wrong trim / trim lacks feature (Jev), fails reject rule e.g. Polestar without Pilot Pack (Jev), high mileage for year (arithmetic + judgment).

**Two conclusions.** (a) 45% of all spend is re-evaluating already-evaluated offers, mostly to reach the same verdict. (b) First-pass triage is dominated by decisions that are either arithmetic or a semantic check against structured data the watcher already holds.

---

## 4. Ranked substitution points

Ranked by (saving × confidence it will work) ÷ effort. Each item states where the code lives, the state and questions, the code gate around Jev, the escalation rule, and the validation method.

### #1 — Price-change / watch-condition reassessment gate

**Saving:** most of ~$513 over the period (price-change $294 + watch-condition $219), i.e. ~45% of total. **Confidence: high.** Half of this is a code fix that needs no model.

**Where:** `watcher/src/change-detector.ts` (`detectWatchChanges`) and `watcher/src/scheduler.ts:590-710` (the watched-offer loop), before `sendPriceChangeNotification` / `sendUrgentNotification`.

**Part A — code materiality gate (do this first, no Jev needed).**
Suppress `price_drop`/`price_increase` unless at least one holds:
- `|Δ| / previous ≥ PRICE_CHANGE_MIN_PCT` (suggest 3%) or `|Δ| ≥ PRICE_CHANGE_MIN_GBP` (suggest £250 cars, £10 computers — make both env-tunable in `watcher/src/config.ts`).
- The new price crosses a segment band edge (p25 / median / p75 from `market_segments` for the offer's segment; see #5 for segment binding).
- The new price crosses a `watch_conditions` threshold (already detected separately as `watch_condition_met`).
Record suppressed changes in `prices` as today (price history must stay complete) but do not notify. Expected effect on its own: a large majority of the 597 price-change runs disappear.

**Part B — Jev "does the verdict change?"** for changes that pass Part A, and for every `watch_condition_met`.

State (all computed in code; no raw numbers Jev has to compare):
```json
{
  "listing": { "title": "Hyundai IONIQ 5", "sub_title": "73kWh Premium Auto 5dr", "year": 2022, "mileage_text": "35,478 miles", "seller_type": "trade", "distance_text": "54 miles away" },
  "previous_verdict": "watch",
  "previous_reasoning": "<evaluations.reasoning of the last evaluation>",
  "previous_requirement_checks": [ { "requirement": "Adaptive Cruise Control (ACC)", "verdict": "verified" } ],
  "price_change": "dropped by 6% (from £18,413 to £17,300)",
  "position_before": "above segment median, below segment high",
  "position_now": "below segment median, above segment low",
  "watch_threshold": "the offer's own alert threshold of £17,500 has now been crossed",
  "days_since_last_evaluation": "9"
}
```
Questions (one call):
- `verdict_now` — **choice** `{ keep_watch, upgrade_to_alert, downgrade_to_skip, needs_full_review }` with criteria written literally, e.g. `upgrade_to_alert: "The previous reasoning's stated conditions for alerting are now met by the price change described in price_change and watch_threshold, and no must-have was contradicted."`
- `reasoning_still_applies` — **noul**: "Do the non-price concerns in `previous_reasoning` (distance, history, mileage, spec) still apply unchanged?"
- `notify_user` — **noul**: "Would a buyer who set `watch_threshold` want to be told about this change now?"

Code policy:
- `keep_watch` with confidence ≥ 0.85 → update nothing, log a `hunt_log` row with trigger `price-change-jev`, no container.
- `upgrade_to_alert` with confidence ≥ 0.85 **and** all previous must-have checks `verified` → spawn the evaluator (an alert still needs the Sonnet-composed message and the `record_alert` path), but pass it the Jev answer so it does one offer, not a re-orientation.
- anything else, or confidence < 0.85 → current behaviour (container run).
Tune 0.85 against the shadow data; pin `jev-1.13.0` once tuned.

**Validation:** replay the 744 re-evaluation pairs on hunt 11: for each, build the state from the two consecutive evaluations and the price history, ask Jev, compare to the actual transition. Target: ≥ 95% agreement on `keep_*` decisions with no missed `watch→alert` at the chosen confidence bar (a missed alert is the costly error; a false "needs review" only costs a container run).

### #2 — Per-offer must-have verification from the AutoTrader feature list

**Saving:** indirect but large: it is the prerequisite for #3's auto-dismiss and it removes the most token-heavy step inside triage runs (the features list is what inflates the 152K contexts). **Confidence: very high** — the cleanest Jev fit in the system, with 3,316 labelled verdicts to test against.

**Where:** watcher, at detail-enrichment time (`scheduler.ts:466-490`, after `mergeOfferAttributes`). New module `watcher/src/jev/musthave.ts`. Result stored on the offer (new column `offers.jev_checks TEXT` JSON, or a new table `offer_requirement_checks(offer_id, hunt_id, requirement, verdict, evidence, confidence, model, checked_at)` keyed to the same verbatim `must_have` strings `record_evaluation` uses). Vertical-agnostic: keyed off `criteria.intent.must_have` + whatever structured spec fields the source adapter exposes (for eBay, `specs_extracted` + item specifics).

**Pattern: pre-parsed value extraction.** Code finds candidates, Jev picks, code copies verbatim.

1. Code: flatten `attributes.features` to `"<Category> / <name> (<Standard|Optional>)"` lines. Filter to relevant categories per requirement using the alias table already in `dashboard/src/lib/must-have-matcher.ts` (`FEATURE_ALIASES`, `STOPWORDS`, `excludes`) — move it to a shared package so watcher and dashboard use one copy. Over-find on purpose (also include the `description` sentences containing any alias token). Cap at ~30 candidate lines per requirement.
2. Jev, one call per offer, one question **per must-have** (and per nice-to-have, since they're free):

```json
"acc": {
  "type": "choice",
  "instructions": {
    "requirement": "Adaptive Cruise Control (ACC)",
    "model_cues": "<KB 'verify on a listing' note for this make/model, e.g. Hyundai calls it Smart Cruise Control with Stop and Go>",
    "question": "Which candidate line in `candidates.acc` shows this car is fitted with the `requirement`?"
  },
  "criteria": {
    "c0": "Drivers Assistance / Smart Cruise Control with Stop and Go (Standard)",
    "c1": "Drivers Assistance / Cruise Control (Standard)",
    "c2": "Description: '...smart cruise control with stop and go...'",
    "none": "No candidate line shows the requirement is fitted to this car"
  }
}
```
   Plus one **noul** per offer: `features_list_is_populated` — "Does `features` contain a meaningful equipment list (more than a handful of generic items)?" — to distinguish *absent* from *no data*.
3. Code maps to the existing enum: chosen candidate with confidence ≥ 0.8 → `verified`, evidence = the candidate line verbatim; `none` with confidence ≥ 0.8 and `features_list_is_populated` ≥ 0.7 → `contradicted` (AutoTrader lists fitted optional extras, so absence is meaningful — same rule the skill states); everything else → `unverified`.

Why choice-over-candidates rather than a noul "is ACC fitted?": the evidence string comes back as an index into lines code supplied, so it can never be a hallucinated feature (the Polestar Pilot Pack failure class). The dashboard's alias table stops being a second, divergent implementation of the same judgment.

**How the evaluator uses it:** `get_offer` / `list_offers` expose `jev_checks`. `car-listing-evaluation` Step 2b becomes "read the pre-computed checks; re-derive only where verdict is `unverified` or confidence < 0.8". `record_evaluation` accepts `requirement_checks` from the agent as today; add an optional `source: 'jev' | 'agent'` field so provenance is visible on the dashboard's `RequirementChecks` component.

**Validation:** replay all 3,316 existing `requirement_checks` on hunt 11 (offer `attributes` are stored, so the state is reproducible). Report a 3×3 confusion matrix. The verdicts that matter most: Jev must not say `verified` where the agent said `contradicted` (67 cases). Expect disagreements on the 118 `unverified`; inspect them by hand, some are agent laziness.

### #3 — Pass-1 triage in the watcher (before any container spawns)

**Saving:** a large share of the $550 triage bucket. 62% of verdicts are skip; if Jev+code dismiss most of those, the evaluator batches shrink to survivors, so fewer detail-page fetches enter context and peak context drops well below 152K. **Confidence: medium-high** (depends on #2 and on #5 for the price arithmetic).

**Where:** same enrichment hook as #2; same Jev call (speculative fan-out: add the questions below to the per-offer request, one call per listing). Result: `hunt_offers.status` set to `dismissed` directly with a `batch_dismiss`-style reason recorded in `evaluations` (decision `skip`, reasoning templated from the answers, `source='jev'`), or left `new` for the evaluator.

Code-only dismissals first (no model):
- price above `criteria.shared.max_price`; distance above a per-hunt cap if set; year outside `targets[*].year_min/max` (the search should enforce these, but AutoTrader over-returns).
- price above the segment's p75 and `price_tier` ∈ {FAIR, HIGH} (needs #5 for the segment).
- any must-have `contradicted` by #2 on a feature-led hunt (this is what `record_evaluation` would refuse to alert on anyway).

Jev questions (state = slim row: `title`, `sub_title`, `attention_grabber`, `year`, `mileage_text`, `seller_type`, `price_tier_label`, plus the flattened, filtered feature lines already built for #2):
- One **noul per `intent.reject` entry**: `reject_0`: "Does this listing match the reject rule: `reject_rules[0]`?" with criteria `{true: "<rule restated with the boundary case>", false: "..."}`. Reject rules are written by the hunt author in natural language; run each through the literal-reading lens when the hunt is created (a lint step in `hunt-management`).
- `trim` — **choice** over the KB trim ladder for this `targets` key (options = trim names, descriptions = the KB's derivative-string cues; add `unknown`). Lets code apply `notes_by_model` rules like "Trim 2 lacks HDA".
- `plausible_fit` — **score** 0–3: `["Clearly fails the brief on spec or condition", "Probably not what the buyer described", "Plausible candidate", "Strong match on the stated purpose and nice-to-haves"]` with `intent.purpose` and `nice_to_have` passed in the instructions object.
- `red_flag_history` — **noul**: "Does `description` or `attention_grabber` state a category-S/N write-off, salvage, non-runner, or missing service history?"

Policy: dismiss when any `reject_*` ≥ 0.85, or `plausible_fit` ≤ 0.8 with confidence ≥ 0.8, or a code rule fires. Everything else stays `new` and goes to the evaluator as today, **with the Jev answers attached** to the `list_offers` row so the evaluator starts from them rather than re-reading the free text.

**Validation:** replay on hunt 11's 1,791 first evaluations. Measure: of offers the agent alerted or watched, how many would Jev+code have dismissed (must be ~0 at the chosen thresholds); of offers the agent skipped, how many are caught (this is the saving).

### #4 — Skip the orchestrator hop when the watcher already has a verdict

**Saving:** the wrapper rows above, ~$140, plus the container start-up cost that is invisible in token accounting. **Confidence: high**, mechanical.

Once #1 and #3 run in the watcher, several event types end without needing a model at all. Extend `watcher/src/notifier.ts` with a non-agent path: for `watch_condition_met` where #1 returned `keep_watch`/`notify_user` ≥ 0.85, format the message with the existing per-vertical formatter (`watcher/src/formatters/`) and deliver it straight through the host router (a new IPC task type `send_message`, or reuse `ipc-mcp-stdio`'s `send_message` shape) rather than a `schedule_task` that spins up an orchestrator to spawn a sub-agent to say the same thing. Only `needs_full_review` / `upgrade_to_alert` write a `schedule_task`, and that task names the single offer.

### #5 — Offer → market-segment binding

**Saving:** small on its own; it is the enabler for the price arithmetic in #1 and #3 and it replaces a heuristic that exists in two places. **Confidence: high.**

Today: `dashboard/src/lib/segment-matcher.ts` binds an offer to a segment by whole-token tag matching over `title + subTitle/derivative/trim`; the evaluator does the same in prose. Replace with one **choice** at enrichment time: options = the hunt's `market_segments.name`, descriptions = `description` + `tags`, plus `none_of_these`. Store `offers.segment_id` (nullable) with confidence. Code then computes `position_now` against `price_low/mid/high` (p25/median/p75 from `recompute_segment_prices`). Dashboard reads the stored binding instead of re-matching. Confidence < 0.7 → leave unbound and fall back to the current matcher.

### #6 — A cheap verifier on `record_evaluation` (quality, not savings)

**Confidence: medium.** The SDE-cascade pattern: Sonnet produces, Jev checks, code decides whether to escalate.

In the `record_evaluation` MCP tool (container side, so this one needs the credential proxy extended to `api.typesafe.ai`, or an IPC round-trip to the host), before insert, ask Jev over `{decision, reasoning, requirement_checks, jev_checks}`:
- `reasoning_supports_decision` — noul.
- `claims_contradicted_feature` — noul: "Does `reasoning` treat as present any feature that `jev_checks` marks contradicted?"
- `alert_conditions_stated` — noul (for watch): "Does `reasoning` state a concrete price at which the buyer should be alerted?" (so `watch_conditions` is never left empty).
Refuse or flag on a strong signal, same as the existing exact-string gate does. This would have caught the Polestar-2-without-Pilot-Pack alert.

### #7 — Judging sources in `musthave-verifier` (hunt activation)

**Saving:** ~$32 over the period, one-off per hunt. **Confidence: medium.** Keep Sonnet for WebSearch/WebFetch and page reading. After each fetch, ask Jev over the page text (trimmed to the relevant section by code): `availability` — **choice** `{standard_all_trims, optional_pack, trim_dependent, not_available, page_does_not_say}` for `(target, must_have)`; `page_is_authoritative` — score. The citation-check cookbook is the template. Low priority; do it when #2 has proven the feature-matching questions.

### #8 — NanoClaw core: inbound message intent routing

**Saving:** small today (main-group chat is a minor share). **Confidence: low value.** Jev could classify inbound messages (deal-hunter command / question answerable from DB / chat / ignore) and choose `context_mode` or skip a spawn for acknowledgements. Not worth doing until the Deal Hunter items land. Noted for completeness; the evening-chat burn in the June incident was a session-lifetime issue, not a routing one.

### Explicitly not Jev

- **Alert headline and 1–2 sentence context** (stage 18): generative. Stays Sonnet. Could be templated from structured answers later, but the user reads these.
- **Evaluation `reasoning` text**: generative today. For Jev-made dismissals, template it from the answers (`"Dismissed: matches reject rule 'Polestar 2 without Pilot Pack' (p=0.93); trim=Standard Range"`) so the dashboard still shows why.
- **Market research, KB building, requirements discovery, comp search**: research and conversation.
- **All arithmetic**: landed cost, VAT, price vs band, £/mile, mileage per year, auction time left, days on market. Code, always, then hand Jev the bucket.
- **The `generic-deal-evaluator` (haiku)**: its whole job is threshold-based; it could become Jev+code entirely, but no vertical uses it. Leave it.
- **AutoTrader detail regex** (`detail.ts` pills): a fit for pre-parsed extraction, but it works and costs nothing. Only revisit if it starts mis-parsing.

---

## 5. Implementation plan

**Phase 0 — instrumentation (½ day).** Add a `cost_usd`, `input_tokens`, `cache_read_tokens`, `model` set of columns to `hunt_log` (or a new `agent_runs` table) written by the agent-runner from `modelUsage` on the `result` message (`container/agent-runner/src/index.ts:729`). Without this you cannot show the saving. Rebuild watcher (`ensureSchema`) and container per CLAUDE.md.

**Phase 1 — code materiality gate (#1A) (½ day).** Pure watcher change + tests in `change-detector.test.ts`. Ship alone; measure the drop in price-change runs for a week.

**Phase 2 — Jev plumbing + shadow mode (1–2 days).**
- `npm install @typesafe-ai/sdk` in `watcher/`. `TYPESAFE_API_KEY` in the watcher's env (systemd unit `deal-hunter-watcher.service`; it is a system-level unit, not `--user`). Client wrapper `watcher/src/jev/client.ts` with: model pinned via env (`JEV_MODEL`, default `jev-1.13.0`), timeout, retry (SDK default), a hard **disable switch** (`JEV_ENABLED=0`), and a log line per call with `model`, `usage.input_tokens`, latency, question ids.
- Replay scripts under `watcher/scripts/jev-replay-*.ts` that build state from the DB and print confusion matrices for #1, #2, #3, #5 against hunt 11's history. These are the acceptance tests; keep them, they become regression checks when the model alias moves.
- Shadow mode: run #2/#3/#5 at enrichment time, **store results, change nothing**. Compare against what the Sonnet evaluator then decides for a week. Dashboard can show the Jev column next to the agent's.

**Phase 3 — turn on, one gate at a time.** Order: #5 (binding, harmless) → #2 (checks, informs the agent) → #1B (reassess gate) → #3 (auto-dismiss, most consequential) → #4 (skip orchestrator). Each behind its own env flag. Keep the evaluator skill text in sync: `car-listing-evaluation` Step 1 and 2b, `listing-evaluation` step 4, and `hunt-management` (reject-rule lint) all need edits; remember the deploy checklist (rebuild container, clear `data/sessions/*/agent-runner-src/`, restart).

**Phase 4 — #6, #7, dashboard provenance.** Extend the credential proxy for `api.typesafe.ai` only if #6 is done container-side; the IPC route avoids that.

Expected outcome at the end of Phase 3, from the measured numbers: price-change and watch-condition spend down by ~80%, triage spend down by roughly half, orchestrator wrappers mostly gone. Order-of-magnitude: **from ~$400/month to ~$100–150/month at list price** for the current single active hunt, while alert quality gets a second check it does not have today. Jev's own bill at current volume: cents.

---

## 5b. Implementation status (2026-09-20)

**Shipped**

- **Phase 0 — spend accounting.** `agent_runs` table (watcher `ensureSchema`), written by the agent-runner on every SDK `result` message: per-result deltas of input / cache-read / cache-write / output tokens and `total_cost_usd`, plus `prompt_head` (first 200 chars of the prompt that produced the turn) for classification. Container rebuilt and session source caches cleared.
- **Phase 1 — #1A materiality gate** (`watcher/src/change-detector.ts`, tests in `change-detector.test.ts`). Price changes notify only when the price moved since the last observation AND is ≥ `PRICE_CHANGE_MIN_PCT` (3%) or ≥ `PRICE_CHANGE_MIN_GBP_<VERTICAL>` (cars 250, computers 10) away from the price at the offer's last evaluation (`getPriceAtLastEvaluation`), so slow drift accumulates. `watch_condition_met` fires on the crossing only (met now, not met at the previous observation) instead of every poll. A watch-condition hit suppresses the separate price-change task for the same offer. `prices` history is unchanged.
- **Phase 2 — Jev plumbing + #2 in shadow mode.** `@typesafe-ai/sdk` in the watcher; `TYPESAFE_API_KEY`, `JEV_MODEL` (default `jev-1.13.0`), `JEV_ENABLED` read from `.env`. `watcher/src/jev/client.ts` (single entry point, logs model/tokens/latency, never throws), `jev/musthave.ts` (pure request builder + verdict mapper + KB cue extractor), `jev/shadow.ts` (DB glue), hook in `scheduler.ts` after `mergeOfferAttributes`. Results land in `offer_requirement_checks(offer_id, hunt_id, requirement, verdict, evidence, confidence, probabilities, model, checked_at)`.
- **Dashboard.** `GET /api/offers/:id` returns `jev_checks`; `JevChecks.tsx` renders a verdict pill, confidence, and probability bars per candidate line inside the Must-haves card on the offer page.

**Design as built (differs from section 4 #2 in three ways, all forced by the replay)**

1. Candidates are every feature line (`Category / name (type)`), the derivative string, and description sentences that mention the requirement *or any pack/trim named in a KB cue heading* (dealers write "Pilot Pack", not "adaptive cruise"). No alias table is needed; the dashboard's `must-have-matcher.ts` stays as the no-Jev fallback only.
2. KB cues are extracted per requirement from the whole KB file (sections whose heading mentions the requirement, plus any other line that mentions it twice over or by acronym, with its heading kept). The "verify on a listing" section heading is not consistent across KB files, so section-name matching found nothing for Tesla and Ioniq 5.
3. The verdict hinges on P(none), not on the chosen line's confidence: `verified` when 1 − P(none) ≥ 0.8 (two equally valid lines splitting the mass, e.g. "Lane Keep Assist" and "Lane Follow Assist", must not read as doubt); `contradicted` when P(none) ≥ 0.8 and `features_populated` ≥ 0.7 **and** the extra per-requirement noul `mh<i>_kb_standard` ("does the KB say this is standard-fit on every version matching the derivative/year?") is < 0.8, otherwise `unverified` with a "standard-fit per KB, verify with seller" note.

**Replay results** (`npx tsx watcher/scripts/jev-replay-musthave.ts --hunt 11 [--store]`, 830 (offer, must-have) pairs = latest agent evaluation per offer with a stored feature list; ~830 calls, ~9K input tokens each, ≈ $0.30 per full run, ~90 s at concurrency 6):

| agent \ jev | verified | unverified | contradicted |
|---|---|---|---|
| verified | 735 | 14 | 2 |
| unverified | 33 | 10 | 2 |
| contradicted | 2 | 8 | 24 |

Agreement 92.7% (ACC 93.0%, lane-keep 92.3%). Iteration history: 55% with no KB cues and strict wording → 80% with per-requirement cues → 91.9% with the P(none) rule and heading-aware cues → 92.7% with the explicit `kb_fit` choice applied whenever listing evidence is weak.

**Adjudication of the 61 disagreements — the agent labels are not ground truth.** Every disagreement was read against the stored feature lines, derivative, description and KB. Grouped by cause:

| Cause | ≈ cases | Who is right |
|---|---|---|
| Agent never read the feature list ("detail not fetched", "features not fetched") although the line is there verbatim (Niro "Adaptive Smart Cruise Control with Stop and Go", I-Pace "Lane Keep Assist", Polestar "Pilot Pack (Standard)" next to "Adaptive Cruise Control") | 17 | Jev |
| I-Pace SE/HSE: agent wrote "SE/HSE should have ACC per KB but it is not listed" and left it unverified or contradicted; Jev verifies from derivative + KB (ACC standard from SE up) | 14 | Jev, if the KB is right. One listing to spot-check: 3179 explicitly lists "Cruise Control with Speed Limiter" |
| Polestar 2 "Lane Keeping Aid with Steering Support": the agent verified this exact line on 7 listings and contradicted it on 6 others (wanting Pilot Assist). Jev reads it consistently as moderate evidence (0.7–0.85) | 17 | Neither, the must-have was ambiguous. **Resolved 2026-09-20:** the brief said "lane keep assist/self driving" — the steering tier was the intent. Must-have reworded to "Lane Centering that actively steers to hold the lane (…), not warning-only Lane Keep Assist"; gate-D verdicts re-recorded for the new string; Polestar KB line claiming LKA = Pilot Assist corrected; discovery / verifier / hunt-management skills gained a tier-naming rule and an `AMBIGUOUS:` loop-back. Consequence: MY2021+ I-Pace should not satisfy per the KB (Steering Assist removed), yet ~30 MY2022 listings carry the structured line "Adaptive Cruise Control with Steering Assist (Standard)"; Jev leaves these `unverified` (P(none) 0.67–0.78). Open question: KB (forum dealer bulletin) vs AutoTrader derivative data. Re-stored replay under the new string: lane-centering 292 verified / 68 unverified / 55 contradicted, Polestar verified rows cite only Pilot Assist / Pilot Pack / Plus Pilot |
| Dealer free text claims ACC / Pilot Pack while the structured list shows non-adaptive cruise (3747, 3131, 2784 "optional extras include Pilot Pack") | 3 | Ambiguous; Jev trusts the structured list + KB, the agent trusted the copy |
| Jev missed listing evidence: "Pilot Pack (Optional)" in features + description (3243), "Plus Pilot" in the derivative (3786); Tesla Autosteer standard-fit not reaching 0.8 (3 rows) | 5 | Agent |
| Agent said contradicted with an empty feature list (3745) or despite "Plus Pilot" in the derivative (2582) | 3 | Jev (unverified) |
| Niro EV trim "2" verified from derivative + KB (2749); KB note says "verify on trim 2" | 2 | Unclear, depends on KB accuracy |

Net: on this labelled set Jev is right or more consistent in roughly 35 of 61 disagreements, the agent in about 5, and ~20 are hunt-wording or KB questions that no evaluator can settle. The two "agent contradicted → Jev verified" rows that survive (3179, 2995) are in the I-Pace and Polestar-wording rows above, not misreads. The Sonnet evaluator's own inconsistency (same line, opposite verdicts, same model) is the clearest finding: a calibrated model that reads every listing the same way is worth having even before it saves money.

**Policy decisions baked in (flip in `musthave.ts`):** `KB_STANDARD_COUNTS_AS_VERIFIED = true` — when the cited KB says a feature is standard on every version of that model/year (`kb_fit.standard_all_versions ≥ 0.8`), the check is `verified` with evidence "Standard-fit per knowledge base…", matching the convention the agent's accepted verdicts already use. Set false to keep such checks `unverified`.

**Deferred (next sessions):** #1B replay + reassess gate, #3 auto-dismiss (needs #5), #4 skip orchestrator, #5 segment binding, #6, #7. Evaluator skill text (`car-listing-evaluation` Step 2b) does not yet read `offer_requirement_checks`; `get_offer`/`list_offers` do not expose it yet.

## 6. Risks and open questions

- **Early access.** Need a TypeSafe account and key (console.typesafe.ai). Rate limits are stated as dynamic; our volume (hundreds of calls/day) is far below them.
- **Threshold drift.** `jev-latest` moves on new releases. Pin `jev-1.13.0`; the replay scripts are the re-tuning tool when upgrading.
- **Adversarial seller copy.** Dealer `attentionGrabber` strings are marketing. #3's `plausible_fit` and `red_flag_history` are the exposed questions; keep `attention_grabber` out of the must-have candidates (#2 uses the structured `features` list plus description only) and test on the 67 contradicted cases.
- **Literal reject rules.** Hunt authors write reject rules for a human reader. Add a lint in `hunt-management` that restates each rule as a literal noul with a boundary case at hunt creation, and store that alongside the rule.
- **False dismissals are silent.** A Jev auto-dismiss (#3) that is wrong loses a deal the user never sees. Mitigations: high confidence bar, code-only rules for the objective part, a dashboard filter "dismissed by jev" for spot checks, and the replay test's "zero alerts/watches dismissed" acceptance criterion.
- **eBay/computers vertical** has far thinner structured data (`specs_extracted` averages 72 chars). #2/#3 will lean on item specifics from `getItem`; the watcher does not fetch those today (`needsDetailFetch` is false for eBay). Decide whether to add the fetch or leave computers on the current path; all computers hunts are paused, so this can wait.
- **Where the verdict store lives.** Option A: new columns on `offers` (simple, but per-offer not per-hunt). Option B: a `offer_requirement_checks` table keyed `(hunt_id, offer_id, requirement)` (correct, since must-haves are per hunt). Recommend B.
- **Unanswered from the docs:** no published accuracy on public benchmarks; TypeSafe's own "workflow evals" are internal. Hence shadow mode first.

---

## 7. Reference: LLM invocation inventory (from the code sweep)

- `container/agent-runner/src/index.ts:472` — the single `query()`; orchestrator `model: 'sonnet'` at `:478`; `allowedTools` at `:483-537` deliberately omits batch-triage tools; sub-agent definitions `:590-684`; auto-compact `:729-740`.
- `container/agent-runner/src/vertical-agents.ts:105-120` — evaluators built from `verticals.yml` `agent:` blocks, `model: 'sonnet'`, `BASE_TOOLS` excludes Bash; `mcp-tool-names.ts` holds exact tool names (globs are dropped).
- `container/agent-runner/src/deal-hunter-hooks.ts:190-225` — `createTriageDelegationGateHook`, the real mechanism forcing evaluation into a sub-agent; `:41-68` activation gate hook; `:126-167` draft-guard stop hook.
- `container/agent-runner/src/deal-hunter-mcp.ts` — 30 tools; `validateRequirementChecks :109-188`; `record_evaluation :1128-1205`; `batch_dismiss :1206-1236`; `list_offers :949`; `get_offer :1045`.
- `container/agent-runner/src/deal-hunter-gate.ts` — activation + provenance gate (A/B/C/D), vendored byte-identical to `dashboard/server/deal-hunter-gate.ts`.
- `container/agent-runner/src/autotrader-search-mcp.ts:607` — `autotrader_detail` (cached; `priceTier`, categorised `features`).
- `watcher/src/scheduler.ts` — tick 30s; poll loop `:304-528`; detail enrichment `:466-490`; triage batching `:532-588`; watched-offer loop `:590-710`; zero-result guard `:439-459`.
- `watcher/src/change-detector.ts` — price delta `> 0.01`, bid count, auction thresholds `[24,12,6]`, `alert_if_price_below_gbp` / `max_price`.
- `watcher/src/notifier.ts` — `sendNewOffersNotification :107-194`, `sendUrgentNotification :100`, `sendPriceChangeNotification :196`; all write IPC `schedule_task` with `context_mode: 'isolated'`.
- `watcher/src/config.ts:56-78` — `STALE_QUEUE_DAYS`, `MAX_TRIAGE_BATCH_PER_RUN`, `TRIAGE_DRAIN_CADENCE_MS`, `TRIAGE_REANNOUNCE_BACKOFF_MS`, `DAILY_API_BUDGET`.
- `watcher/src/sources/autotrader/detail.ts` — regex extraction of price delta `:45-48`, reg year `:54-56`, mileage/year pills `:179,200`, sold/unavailable `:257,299`.
- `dashboard/src/lib/must-have-matcher.ts` — `FEATURE_ALIASES`, `STOPWORDS`, `excludes`; `segment-matcher.ts:22-35`; `price-opinion.ts:16-28`; `regression.ts`.
- `src/container-runner.ts:229`, `src/credential-proxy.ts:42` — all container model traffic via local proxy; `src/index.ts:156-185` trigger gating (regex, no model); `src/router.ts` formatting only.
- `config/verticals.yml` — `computers` (eBay, 5 min) and `cars` (AutoTrader, 1440 min, `attributes_required`, three-zone `criteria_schema`: `shared` / `targets` / `intent`). No `model:` key exists.
- Skills that are mostly fixed-schema judgment: `car-listing-evaluation`, `listing-evaluation`, `generic-deal-evaluator`, `musthave-verification`. Genuinely generative: `requirements-discovery`, `research`, `documentation`, alert composition.

---

## Appendix A — spend reconstruction script

Run from `/opt/nanoclaw`. Prices are Sonnet list; adjust `P`.

```python
import json, glob, os, collections, statistics
P = (3, 6, 0.3, 15)  # $/Mtok: input, cache write (1h), cache read, output
files = glob.glob('data/sessions/telegram_main/.claude/projects/-workspace-group/**/*.jsonl', recursive=True)
runs = []
for f in files:
    first = None; cost = 0; calls = 0; maxctx = 0; evals = 0
    for line in open(f, errors='ignore'):
        try: o = json.loads(line)
        except: continue
        msg = o.get('message') or {}
        if o.get('type') == 'user' and first is None:
            c = msg.get('content')
            first = c if isinstance(c, str) else next((b['text'] for b in c if isinstance(b, dict) and b.get('type') == 'text'), None) if isinstance(c, list) else None
        if o.get('type') != 'assistant': continue
        u = msg.get('usage')
        if u:
            i, cw, cr, ou = (u.get(k, 0) for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'))
            cost += (i*P[0] + cw*P[1] + cr*P[2] + ou*P[3]) / 1e6; calls += 1; maxctx = max(maxctx, i+cw+cr)
        for b in msg.get('content', []) if isinstance(msg.get('content'), list) else []:
            if isinstance(b, dict) and b.get('type') == 'tool_use' and b['name'] == 'mcp__deal-hunter-db__record_evaluation': evals += 1
    if not calls: continue
    fl = (first or '').lower()
    kind = ('price-change' if any(k in fl for k in ('price change', 'price drop', 'price increase', 'price-changed'))
            else 'watch-condition' if 'watch condition' in fl or 'watch-condition' in fl
            else 'new-offer triage' if 'new offers' in fl
            else 'daily review' if 'daily' in fl or 'review' in fl
            else 'musthave verify' if 'must-have' in fl or 'verif' in fl
            else 'market research' if any(k in fl for k in ('market', 'baseline', 'segment'))
            else 'other')
    runs.append((('sub ' if '/subagents/' in f else 'main ') + kind, cost, calls, evals, maxctx))
agg = collections.defaultdict(lambda: [0, 0.0, 0, 0, []])
for k, c, n, e, m in runs:
    a = agg[k]; a[0] += 1; a[1] += c; a[2] += n; a[3] += e; a[4].append(m)
for k, a in sorted(agg.items(), key=lambda x: -x[1][1]):
    print(f"{k:28s} runs={a[0]:4d} ${a[1]:7.2f} $/run={a[1]/a[0]:5.2f} calls/run={a[2]/a[0]:5.1f} evals={a[3]:4d} medCtx={int(statistics.median(a[4]))}")
```

## Appendix B — Jev request/response example (JS SDK)

```ts
import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';
const client = new TypeSafeClient(); // TYPESAFE_API_KEY from env

const res = await client.systemOne({
  model: process.env.JEV_MODEL ?? 'jev-1.13.0',
  state: { listing: slimRow, candidates: { acc: accLines }, features_count: featureLines.length },
  questions: {
    acc: choice(
      { requirement: 'Adaptive Cruise Control (ACC)', model_cues: kbCues, question: 'Which candidate line in `candidates.acc` shows this car is fitted with the `requirement`?' },
      { ...Object.fromEntries(accLines.map((l, i) => [`c${i}`, l])), none: 'No candidate line shows the requirement is fitted to this car' },
    ),
    features_populated: noul('Does `listing.features` contain a meaningful equipment list rather than a handful of generic items?'),
  },
});
// res.answers.acc.choice, res.answers.acc.confidence, res.answers.features_populated.noul, res.model, res.usage.input_tokens
```
