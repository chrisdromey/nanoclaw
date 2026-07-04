# Cars/AutoTrader — First Hunt Test Findings (2026-06-28)

Status: **RESOLVED (2026-06-28) — Issues 1–5 + agent guidance, and design questions 3–6.**
Issue 4 (baselining at creation) is fixed via a hunt lifecycle state machine + activation gate
(see "RESOLUTION — Issue 4"). Issue 5 (auto-pause semantics) + design Q3 (de-duplicate the two
AutoTrader search builders) are now fixed too — see "RESOLUTION — Issue 5 (semantics) + Q3" below.
The original diagnosis is preserved below for history. Hunt 8 has since been `closed` by the user
(it returned 60 offers across models before closing); it still has zero market segments, which is
now moot for a closed hunt — new hunts can only reach `active` via the baselining gate.

## TL;DR

The agent created the hunt correctly and the criteria are high quality. But **the watcher
can physically never search this hunt**: the cars→AutoTrader translator throws
`criteria.make is required` on every tick, hit 10 consecutive failures, and the watcher
**auto-paused the AutoTrader source for this hunt**. Result: zero offers, empty Activity.
Separately, the Market tab is empty because **no `market_segments` were recorded** at
creation. Three AutoTrader filter-name bugs (fuel / sort / year) are also real but are
currently *secondary* — the hunt dies before any request reaches AutoTrader.

The root tension: the user (and the agent) modelled "family EV" as **one hunt with 4
candidate models**; the cars pipeline only supports **one flat `{make, model}` per hunt**.

## RESOLUTION (2026-06-28) — what was fixed and how

The root decision: a cars hunt **is** one wide-net hunt spanning N candidate models that share
budget/location/mileage/fuel. The search is coarse (only the filters AutoTrader supports);
everything judgement-based (features/trims/reject rules) moves to an evaluator-only `intent`
zone the search never reads. This collapses Issues 1 and 2 into a single change.

### Criteria is now three zones (Issues 1 & 2)

`config/verticals.yml` → `cars.criteria_schema` was restructured to:

- **`shared`** — hunt-wide *searchable* fields applied to every model's search: `postcode`,
  `max_price`, `max_mileage`, `fuel`, `transmission`.
- **`targets`** — one entry per candidate model (`make`, `model?`, `year_min?`, `year_max?`),
  **keyed by the matching `search_terms` string**.
- **`intent`** — EVALUATOR-ONLY: `must_have`, `nice_to_have`, `reject`, `notes_by_model`,
  `purpose`. The translator never reads this.

The translator (`verticals/cars/translators/autotrader.ts`) is now **term-aware**:
`translateCarsCriteriaToAutotrader(criteria, terms)` resolves `targets[terms]`, merges `shared`,
and builds one AutoTrader search per model. The watcher wrapper
(`watcher/src/translators/index.ts`) passes the scheduler's per-term string through, so the
existing `search_terms` loop now fans one hunt across its models (Issue 2's unused `_terms` is
gone). A flat single-model criteria is still accepted (back-compat). Anti-drift: `search_terms`
keys must equal `targets` keys (enforced by guidance + a tolerant-but-loud translator — a
single target is used regardless of term; a multi-target miss throws a descriptive error).

### AutoTrader filter-name bugs (Issue 3 — confirmed by live probe, was worse than documented)

Reaching the live API revealed the year/mileage filter names were **never valid** (the spike #1
test only ever covered make/model/price/postcode). Confirmed correct values by probing the live
`FilterName` enum (introspection is disabled, so probed by elimination):

| Param | Was (rejected) | Correct (confirmed) |
|-------|----------------|---------------------|
| fuel  | `fuel-type`        | `fuel_type` |
| year (min) | `min_year`    | `min_year_manufactured` |
| year (max) | `max_year`    | `max_year_manufactured` |
| mileage | `maximum_mileage` | `max_mileage` |

Fixed in **both** code paths: the watcher translator and the agent MCP
(`container/agent-runner/src/autotrader-search-mcp.ts`, plus the live per-group cache copy
`data/sessions/telegram_main/agent-runner-src/autotrader-search-mcp.ts`). `max_price`,
`make`/`model`/`postcode` and the `total`/`include` constants were already valid. A full
corrected I-Pace search now returns 20 listings, 0 errors.

### Agents guided on the wide-net model (the framing, not just the schema)

- **`car-listing-evaluation`** — added an explicit "the search is a coarse net; you do the real
  filtering" section, made the orientation step read `criteria.intent` first, and wired
  `intent.reject` / `intent.notes_by_model[<term>]` into Step 1 triage.
- **`cars-sourcing`** — added a "what the search can filter vs what the evaluator judges"
  section so recon doesn't try to narrow the net with things the search can't express.
- **`hunt-management`** — Create workflow now states the searchable-vs-`intent` split and the
  `search_terms` ↔ `targets` key rule, with a cars example.

### Hunt 8 migrated + verified

`hunts.id=8` criteria was rewritten from the old `models{}` blob to the new `shared`/`targets`/
`intent` shape (old value backed up; verbatim copy also remains in the Evidence section below).
`search_terms` already matched the target keys, so it was left unchanged. After rebuilding
`verticals/` + `watcher/` dist and restarting the watcher (which also cleared the auto-pause),
hunt 8 now stores offers across models — verified e.g. Jaguar I-Pace and Hyundai Ioniq 5 rows
in `hunt_offers`, no `FilterName` errors.

### Build / deploy state

- `verticals/` and `watcher/` recompiled; `deal-hunter-watcher.service` restarted. ✅
- Translator unit tests updated and passing (21/21); watcher suites green.
- The user set `cars.default_poll_minutes = 1440` (24h) — effective hunt-8 cadence is now daily.
- **Follow-up not yet done:** the agent MCP container *image* was not rebuilt
  (`./container/build.sh` → `rm -rf data/sessions/*/agent-runner-src/` → restart NanoClaw). The
  live `telegram_main` group already has the patched cached copy, so the recon path is fixed for
  it; the image rebuild is only needed for brand-new groups.

### Still open (not addressed here)

- ~~**Issue 5** — auto-pause remains sticky until watcher restart; config-error vs transient-
  failure budget semantics unchanged.~~ **RESOLVED 2026-06-28** — see "RESOLUTION — Issue 5 + Q3".

---

## RESOLUTION — Issue 5 (auto-pause semantics) + design Q3 (de-dup AutoTrader builders), 2026-06-28

Both hardening follow-ups landed together (separate, non-overlapping files), built, tested, and
deployed.

### Issue 5 — config-error vs transient-failure, and sticky auto-pause (`watcher/src/scheduler.ts`)

The single `tick()` `try/catch` around "translate criteria → search" was split into two scopes:

- **Translate step (deterministic / config).** Any throw from `translator(hunt, terms)` (e.g.
  `criteria.make is required`) is now caught separately, logged distinctly as a config error,
  and **does not count toward the auto-pause budget** — retrying a deterministic error can never
  make it self-heal. It backs off to the hunt's poll cadence (`lastSearchTime` set) so it's
  logged once per poll, not every tick, and self-heals the moment the criteria is fixed.
- **Search step (transient / network).** Only genuine I/O failures accrue
  `consecutiveFailures` and can trip the 10-strike pause.
- **Auto-pause is now a throttle, not a permanent block.** A new `sourcePausedAt` map + a
  `PAUSE_COOLDOWN_MS` window (default 60 min, env `AUTO_PAUSE_COOLDOWN_MINUTES`) lets one probe
  search through after the cool-down; success clears the pause, a failed probe re-arms it. A
  transient outage now recovers **without a watcher restart**. In-memory only — no schema change.
- Tests: 2 new scheduler tests (config error never reaches the adapter / never accrues failures;
  paused source probes again after cool-down and clears on success). Watcher suite 105/105.

### Design Q3 — single source of truth for AutoTrader filters (no more drift)

The two builders (`verticals/cars/translators/autotrader.ts` and the agent recon MCP
`container/agent-runner/src/autotrader-search-mcp.ts`) live in **separate compilation roots that
cannot import each other at container runtime** (`container/agent-runner/src` is copied standalone
into the agent container/per-group cache; `verticals/` is never mounted there). So a normal shared
import is infeasible. Resolution: a **vendored** shared module, kept byte-identical in both trees:

- `verticals/cars/translators/autotrader-filters.ts` (canonical) + `container/agent-runner/src/autotrader-filters.ts`
  (byte-identical copy) — exports `AT_FILTER` (the authoritative filter-name constants that drifted
  in Issue 3) and `buildAutotraderFilters(flatValues)`. Both consumers now call it; neither hand-rolls
  the filter array. Input contracts (zoned criteria vs flat `opts`) are unchanged; outputs are
  identical (21 pre-existing behavioural tests still green).
- **3-layer drift guard** (in `autotrader.test.ts`): (a) byte-identity assertion between the two
  vendored copies — a one-sided edit fails the suite; (b) `AT_FILTER` pinned to the live-confirmed
  enum names — catches a coordinated rename; (c) the watcher translator output `.toEqual` the shared
  builder. Verticals suite 24/24.

### Build / deploy state (Issue 5 + Q3)

- `watcher/` recompiled + `deal-hunter-watcher.service` restarted (came up clean, no auto-pause).
- `verticals/` dist recompiled; agent-runner container **image rebuilt** (`./container/build.sh`),
  per-group `data/sessions/*/agent-runner-src/` cache cleared, **NanoClaw restarted** — so the two
  vendored `autotrader-filters.ts` files ship together (they must — the MCP now imports the shared
  module). All three services (`nanoclaw`, watcher, dashboard) verified `active`.
- Independent verification: `tsc` clean on verticals + agent-runner + watcher; verticals 24/24,
  watcher 105/105.

---

## RESOLUTION — adversarial-review hardening pass (2026-06-28)

After Issues 1–5 + Q3 landed, a 4-way adversarial review of the whole body of work surfaced one
real bug and several hardening items; all were fixed, QA'd by a second adversarial pass, and
deployed.

**The real bug — gate bypass via the dashboard (HIGH, found by 2 reviewers independently).** Issue
4's activation gate was enforced in the MCP but the **dashboard HTTP endpoints are a second writer
to the same DB** and bypassed it. Fixed in `dashboard/server/routes/hunts.ts`:
- `resume` now runs the shared activation gate (valid criteria + ≥1 segment) and only then sets
  `status='active', monitoring=1`; on failure it returns 400 with the missing items.
- `pause` now also clears `monitoring=0` (matches the MCP).
- `PUT /hunts/:id` rejects enabling `monitoring` (only the gated resume/activate can).
- The gate is shared via a **vendored** `dashboard/server/deal-hunter-gate.ts` (byte-identical to
  the canonical `container/agent-runner/src/deal-hunter-gate.ts`, drift-guard test), since the two
  packages are separate compilation roots — same pattern as Q3.

**Gate hardening (`deal-hunter-gate.ts`, both copies):**
- Now **fails closed** when a vertical's config row is missing/unparseable (previously a `null`
  config waved any criteria through); a genuinely empty schema (computers) still passes.
- Now rejects **wrong-typed required leaves** (e.g. `postcode` as a number, which would crash the
  translator's `.trim()`).
- New **search_terms ↔ targets-key parity check**: a hunt whose `search_terms` don't line up 1:1
  with its criteria `targets` keys is rejected at activation, instead of activating and then making
  the translator throw on every poll. Driven off the schema's `<…>` wildcard-map convention, so it
  is vertical-agnostic (computers unaffected). Wired into all gate callers (MCP activate/resume,
  hooks, dashboard resume).

**Translator (`verticals/cars/translators/autotrader.ts`):**
- Removed the "tolerant single-target fallback" that silently re-searched the lone target for every
  term — a 1-target/multi-term hunt now throws a descriptive config error (loud, self-healing) for
  the unmatched term instead of dropping models silently.
- Dropped the stale `'price-asc'` value (API-rejected) from the `sortBy` type unions in favour of
  `'price_asc' | 'price_desc'` (latent type fix; no runtime change — the translator never emits a
  sort).

**Scheduler (`watcher/src/scheduler.ts`) + migration (`db.ts`):**
- A search that **throws** now sets `lastSearchTime`, so a transiently-failing source backs off to
  its poll cadence instead of being retried every 30 s tick (it previously hammered for ~5 min
  before pausing). The no-translator branch backs off the same way.
- Added a **load-bearing test** that drives 10 real failures through `tick()` and asserts the
  cooldown is armed (the arming line was previously untested — deleting it broke no test).
- `PAUSE_COOLDOWN_MS` clamps `AUTO_PAUSE_COOLDOWN_MINUTES` to ≥1 min (0/negative previously
  disabled the throttle); the status-CHECK migration restores `foreign_keys=ON` via try/finally.

**Build / test / deploy:** all `tsc` clean (verticals, watcher, agent-runner, dashboard); tests
green — verticals 25, watcher 106, dashboard 46. Both vendored pairs (gate + filters) confirmed
byte-identical. Deployed: verticals+watcher rebuilt + watcher restarted; dashboard rebuilt +
restarted; agent-runner image rebuilt, per-group `agent-runner-src` cache cleared, NanoClaw
restarted. All four services verified `active`.

**Known follow-ups (non-blocking, logged not fixed):** the gate/translator required-field contract
is consistent today but still not linked by a test (drift risk, same class as Issue 3); the parity
check assumes any `<…>` wildcard map is search-term-keyed (true for the only such vertical, cars);
a stale test *name* in `watcher/src/sources/autotrader/search.test.ts` ("hyphenated") is cosmetic.

---

## RESOLUTION — Issue 4 (2026-06-28): hunt lifecycle state machine + activation gate

**Decision:** a hunt can only be monitored once it is well-formed and baselined. This is enforced
by an explicit lifecycle and a gate on the transition into monitoring, rather than left to skill
guidance (which was advisory and self-contradictory — the create flow told the agent to enable
monitoring immediately *and* that baselining was mandatory, with nothing sequencing the two).

**State machine** (single gated edge `draft → active`):

```
draft ──(valid criteria + ≥1 market segment)──▶ active ──pause──▶ paused ──resume(re-gate)──▶ active
  │                                              (monitoring=1)
  └────────────────── close ──────────────────▶ closed
```

- **`draft`** — every new hunt starts here, `monitoring=0`; the watcher ignores it
  (`getActiveHunts` polls `status='active' AND monitoring=1`). Criteria refinement + baselining
  happen here, and a draft is **visible** on the dashboard as "needs baselining" (the original
  failure was an invisible broken hunt).
- **`active`** — reachable only via `manage_hunt action:activate`, the gate: it refuses unless the
  criteria validate against the vertical's `criteria_schema` AND ≥1 `market_segments` row exists,
  then sets `status='active', monitoring=1`.

**Implementation (A = hard server gate, B = behavioural hooks):**

| Layer | File(s) | Change |
|-------|---------|--------|
| Schema | `watcher/src/db.ts` | Idempotent table-rebuild migration widening `hunts.status` CHECK to add `'draft'` (FK-safe via `foreign_keys=OFF` around the rebuild; preserves ids); canonical `CREATE TABLE` updated to match. |
| Gate (shared) | `container/agent-runner/src/deal-hunter-gate.ts` *(new)* | `validateCriteriaForVertical` (schema-driven from `criteria_schema`: a leaf is required unless its type string ends with `?`; a `<…>` key is a wildcard map like cars `targets`), `getSegmentCount`, `evaluateActivationGate`. Vertical-agnostic — reproduces the translator's contract (cars: `shared.postcode` + per-target `make`) without hardcoding a vertical; an empty schema (computers) imposes no criteria checks. Parameterised by a `Database` so the MCP and the hooks share one implementation. |
| MCP | `container/agent-runner/src/deal-hunter-mcp.ts` | `create` always writes `status='draft', monitoring=0` and returns non-blocking `criteria_warnings`; new `activate` action runs the gate; `resume` re-runs the gate; `update` rejects `monitoring:true`; `pause` also clears monitoring. |
| Hooks | `container/agent-runner/src/deal-hunter-hooks.ts` *(new)* + `index.ts` (`hooks` block) | `PreToolUse` on `manage_hunt` denies a premature `activate`/`resume` early, naming the missing items; `Stop` hook blocks finishing a session that left a freshly-created hunt as an un-activated draft (scans the transcript for `create` results, `stop_hook_active` loop-guard). Both reuse the shared gate against a read-only DB connection. |
| Dashboard | `dashboard/server/routes/{hunts,overview}.ts`, `shared/types.ts`, `src/pages/Hunts.tsx`, `src/components/shared/StatusBadge.tsx` | Lists include `draft`; new `segment_count` + `needs_baselining` fields; a "Draft" filter tab, a `draft` badge, a "Needs baselining before it can be activated" indicator; drafts ordered first; pause/resume hidden for drafts. |
| Skills | `container/skills/hunt-management/SKILL.md`, `price-baselining/SKILL.md` | Create flow rewritten to draft → baseline → activate (the monitoring-immediately vs mandatory-baseline contradiction removed); Lifecycle/Activate/Monitoring/Pause-Resume sections describe activation as the only path to monitoring; baselining-before-activation reinforced. |

**Verified (2026-06-28):**
- Migration: on a copy and on the live DB — `CHECK(status IN ('draft','active','paused','closed'))`,
  all rows/ids preserved, `foreign_key_check` clean, idempotent on re-run, bogus status rejected.
- Gate logic (unit, against the real DB): valid cars criteria pass; a hunt-8-style `models{}` blob
  flags `shared.postcode` + "targets must have at least one entry"; a target without `make` →
  `targets.<name>.make is required`; computers (empty schema) always pass.
- MCP handlers end-to-end (driving the real stdio server against a DB copy): create → `draft`,
  monitoring 0; activate with 0 segments → rejected; `update monitoring:true` → rejected; activate
  after recording a segment → `active`, monitoring 1; bad criteria → non-blocking warnings on
  create and a precise rejection on activate.
- Dashboard live API: hunt 8 returns `needs_baselining: true` (previously invisible).

**Deployed:** watcher rebuilt + restarted (migration ran on the live DB); dashboard rebuilt +
restarted; agent MCP container image rebuilt; per-group `agent-runner-src` cache cleared; NanoClaw
restarted. (This also completes the image-rebuild follow-up noted in the Issues 1–3 build/deploy
state above.)

**Hunt 8 specifics:** its stored criteria is already in the valid `shared`/`targets` shape, so the
gate's only complaint is the missing segments. The migration does not retro-fix existing rows, so
hunt 8 stays `active` with 0 segments and shows "needs baselining"; record a segment (or re-run the
draft → activate flow) to populate the Market tab.

---

## What the user did

At 14:10 the user asked (Telegram) to start a hunt for a family electric car (~£15k target,
£20k+ ceiling, must fit two child seats, home charging, wants adaptive cruise / lane-keep;
mentioned I-Pace). The container agent (session `87cba6e6-d704-41e7-99a4-c98b1e285b46`):

1. Ran `requirements-discovery`, checked `list_verticals` / `get_vertical` for `cars`.
2. Ran live AutoTrader market recon across I-Pace, Niro, Polestar 2, Tesla M3, Ioniq 5.
3. Sent a market overview, flagged tool bugs, gathered requirements.
4. Created hunt id 8 `family-ev` (active) at 14:20:50 with rich multi-model criteria.

This is good behaviour. The hunt-creation step is not where the user-visible failure is.

## Evidence

### Hunt row (DB: `groups/telegram_main/deal-hunter.db`, table `hunts`, id 8)

- `vertical = cars`, `sources = ["autotrader"]`, `status = active`, `monitoring = 1`.
- `cadence_minutes = 60`, `poll_interval_minutes = NULL` (so effective poll falls back to the
  cars vertical default of 360 min — see cadence resolution below).
- `criteria` is a **rich nested object** — this is the *exact, verbatim* JSON the agent wrote
  to the DB (`SELECT criteria FROM hunts WHERE id=8`):

  ```json
  {
    "purpose": "Family EV with two forward-facing isofix rear child seats. UK home charging overnight. Premium feel, good tech, adaptive cruise and lane keep assist essential.",
    "budget_target_gbp": 15000,
    "budget_max_gbp": 22000,
    "max_mileage": 80000,
    "postcode": "M346EP",
    "fuel": "Electric",
    "models": {
      "jaguar_ipace": {
        "year_min": 2021,
        "notes": "Must have Pivi Pro (2021+ only). Avoid pre-2021 (old InControl Touch Pro Duo infotainment + worse battery firmware). Check battery health on high-mileage examples."
      },
      "polestar_2": {
        "notes": "Must have Pilot Pack or Plus Pilot Pack for adaptive cruise + lane centering. Standard without Pilot Pack is not sufficient."
      },
      "hyundai_ioniq5": {
        "trim_min": "Premium",
        "notes": "SE Connect acceptable if ADAS confirmed. Premium or Ultimate strongly preferred for Smart Cruise + Lane Follow. Flat floor is best-in-class for two rear child seats."
      },
      "kia_ev6": {
        "trim_min": "GT-Line",
        "notes": "GT-Line or above for full ADAS. Same E-GMP platform as Ioniq 5."
      }
    },
    "must_have": [
      "Adaptive cruise control",
      "Lane keep/lane follow assist",
      "ISOFIX rear outer seats both sides",
      "BEV only — no PHEV or hybrid"
    ],
    "nice_to_have": [
      "Panoramic/glass roof",
      "Head-up display",
      "Heated rear seats",
      "Premium sound system"
    ],
    "reject": [
      "Pre-2021 I-Pace (old infotainment)",
      "Polestar 2 without Pilot Pack",
      "PHEV or mild hybrid",
      "Over 80,000 miles"
    ],
    "snap_buy_threshold": 14000,
    "notes": "User near Marple, Stockport (M346EP). Happy to travel nationwide for a great deal. Key priority: comfortable rear for two forward-facing child seats — Ioniq 5/EV6 flat E-GMP floor is a strong advantage. Polestar 2 fastback rear is tighter for bulky isofix seats."
  }
  ```

  **There is no top-level `make` or `model`.** Those live under `models{}`. This is the exact
  object `JSON.parse`d by `carsAutotraderTranslator` and passed to
  `translateCarsCriteriaToAutotrader`, which reads `criteria.make` → `undefined` → throws.

- `search_terms` is the *exact, verbatim* value written (`SELECT search_terms FROM hunts WHERE id=8`):

  ```json
  [
    { "terms": "Jaguar I-Pace" },
    { "terms": "Polestar 2" },
    { "terms": "Hyundai Ioniq 5" },
    { "terms": "Kia EV6" }
  ]
  ```

  The four models *are* expressed here, but the cars translator ignores `search_terms` (see Issue 2).

### DB state proving the empty dashboard

- `market_segments` where `hunt_id=8`: **0 rows** (eBay hunts 1/4/5/6 have 5–8 each).
- `hunt_offers` where `hunt_id=8`: **0 rows** (eBay hunts have hundreds).
- `hunt_log` for hunt 8: **1 row**, `trigger=user`, `offers_evaluated=4`, `offers_alerted=0`,
  summary "Hunt created for family EV…". (The 4 recon listings the agent eyeballed were
  never persisted as `hunt_offers`.)

### Watcher log proving the throw + auto-pause (`logs/watcher.log`, ~14:25:41)

```
ERROR (116872): Search failed
    huntId: 8  sourceId: "autotrader"  terms: "Kia EV6"
    err.message: "translateCarsCriteriaToAutotrader: criteria.make is required.
                  AutoTrader searches require a make filter to avoid returning all cars."
    at translateCarsCriteriaToAutotrader (verticals/dist/cars/translators/autotrader.js:26:15)
    at carsAutotraderTranslator           (watcher/dist/translators/index.js:58:12)
    at tick                               (watcher/dist/scheduler.js:174:42)
WARN: Source auto-paused after 10 consecutive failures — fix the adapter or re-enable
      manually by restarting the watcher   huntId: 8  sourceId: "autotrader"
```

After that, every tick logs `WARN: Source paused for this hunt/term — skipping`.

## The end-to-end flow (where it breaks)

```
Telegram msg
  → container agent (requirements-discovery → cars-sourcing recon)
      uses MCP: mcp__autotrader-search__autotrader_search   [agent search path]
      creates hunt via deal-hunter MCP                       [writes rich criteria + search_terms]
  → WATCHER (separate process, deal-hunter-watcher.service)  [the poll/offers path]
      scheduler.tick()  watcher/src/scheduler.ts
        getActiveHunts(db)                                   ~scheduler.ts:194
        for hunt.sources (["autotrader"])                    ~scheduler.ts:227
          cadence = poll_interval_minutes ?? vertical.default_poll_minutes
                    ?? cadence_minutes ?? 60                 ~scheduler.ts:224
          getTranslator(hunt.vertical, sourceId)             ~scheduler.ts:256
            → carsAutotraderTranslator                        watcher/src/translators/index.ts:68
              JSON.parse(hunt.criteria)
              translateCarsCriteriaToAutotrader(criteria)     verticals/cars/translators/autotrader.ts
                ── THROWS: criteria.make is required ──        autotrader.ts (CarsCriteria requires make)
          → search never runs → 10 fails → source auto-paused
      (would-be) getAdapter('autotrader').search(params)     watcher/src/sources/autotrader/index.ts
                  → searchAutotrader(params)                  watcher/src/sources/autotrader/search.ts:148
                  → enrich via fetchDetail() (needsDetailFetch)  index.ts capabilities
                  → write hunt_offers / offers → dashboard
```

The agent search path and the watcher poll path are **two separate implementations of the
same AutoTrader search**, and they have drifted (see Issue 3).

## Issues

### Issue 1 (PRIMARY / blocker) — criteria shape mismatch: rich nested vs flat

- The translator contract is **flat**: `interface CarsCriteria { make; model; postcode; year_min?; year_max?; max_price?; max_mileage?; fuel?; transmission? }`
  in `verticals/cars/translators/autotrader.ts`. It hard-requires `make` and `postcode`
  (throws otherwise). This matches `config/verticals.yml` → `cars.criteria_schema` (flat,
  single `make`/`model`).
- The agent wrote a **rich nested** object with no top-level `make`. So the translator
  throws on every term, every tick.
- Net effect: hunt 8 can never be polled; offers/activity stay empty; source auto-paused.
- Open question (for discussion): should the **criteria schema accommodate rich/multi-model
  shapes**, or should the **agent be constrained to write the flat schema**? This is the crux.

Refs: `verticals/cars/translators/autotrader.ts` (CarsCriteria interface + the two `throw`s +
filter build); `config/verticals.yml` `cars.criteria_schema`; hunt 8 `criteria` above.

### Issue 2 — cars translator ignores `search_terms` (no multi-model support)

- `carsAutotraderTranslator: TranslatorFn = (hunt, _terms) => { ... }` in
  `watcher/src/translators/index.ts:68` — the `_terms` argument is **unused**. It reads only
  `hunt.criteria` and produces a **single** search.
- Contrast the eBay path, which is **term-driven**: the scheduler iterates `search_terms` and
  each term becomes a query. For cars, the scheduler still loops terms (the log shows it
  trying "Kia EV6", "Hyundai Ioniq 5", …) but the translator collapses them all to the same
  criteria-derived search and throws identically each time.
- So even though hunt 8's four models sit in `search_terms`, the cars pipeline has **no way to
  fan a single hunt across multiple models**. This is the structural gap behind the user's
  "one family-ev hunt" mental model.

Refs: `watcher/src/translators/index.ts:46-90` (registration + both translators);
`watcher/src/scheduler.ts` term loop around `:227`+.

### Issue 3 — AutoTrader filter-name bugs (duplicated in two code paths)

The agent hit three API enum rejections during recon. The wrong values exist in **both** the
agent MCP and the watcher translator (they were written from the same assumptions):

| Param | Code currently sends | API says | Confirmed correct value |
|-------|----------------------|----------|--------------------------|
| fuel  | `filter: 'fuel-type'` | `does not exist in FilterName enum. Did you mean fuel_type` | `fuel_type` |
| sort  | `sortBy: 'price-asc'` | `does not exist in SearchResultsSort. Did you mean price_asc or price_desc` | `price_asc` / `price_desc` |
| year  | `filter: 'min_year'` / `'max_year'` | enum-rejected (exact "did you mean" not captured) | **UNKNOWN — needs the actual enum error to confirm** |

Locations:
- Agent MCP: `container/agent-runner/src/autotrader-search-mcp.ts`
  - fuel filter ~line 211; year filters ~lines 202–203; `sort_by` zod enum ~lines 513–516;
    passed through to `searchAT({... sortBy: sort_by})` ~line 552.
- Watcher translator: `verticals/cars/translators/autotrader.ts`
  - fuel filter (`fuel-type`); year filters (`min_year`/`max_year`); doc comment lines ~10–16
    still assert the old assumptions. `sortBy` default `'relevance'` in
    `watcher/src/sources/autotrader/search.ts:164` (sort only bites if a non-relevance sort is
    passed).

Note: these only matter **after** Issue 1 is resolved — today the search never reaches AutoTrader.
The `fuel` filter being broken also means recon could not constrain to Electric, so e.g. a
"Kia Niro" search returned petrol/hybrid/EV mixed.

**ACTION ALREADY TAKEN (uncommitted):** the agent MCP copy was patched for the two *confirmed*
bugs only — `fuel-type → fuel_type` and the `sort_by` enum → `['relevance','price_asc','price_desc','distance']`.
This was applied to **both** the canonical source `container/agent-runner/src/autotrader-search-mcp.ts`
**and** the live per-group cached copy `data/sessions/telegram_main/agent-runner-src/autotrader-search-mcp.ts`
(so the running group picks it up on next container spawn). The image was **not** rebuilt. The
watcher translator was **NOT** touched. The `year` filter name was **NOT** changed (unknown correct value).

### Issue 4 — no market segments recorded at hunt creation (empty Market tab)

- `market_segments` for hunt 8 = 0 rows, so the dashboard Market tab shows
  "No market segments defined for this hunt".
- Per `container/skills/cars-sourcing/SKILL.md` (≈ lines 13–14, 45–47): cars-sourcing does
  market recon and segments by model+trim, then **hands segments to `/price-baselining`**,
  which is what actually records them to the DB. That recording step did not run for this hunt.
- Open question (for discussion): should hunt creation for cars *require* a baselining pass
  (so segments always exist), or is an empty Market tab acceptable until the first successful
  poll enriches comps?

Refs: `container/skills/cars-sourcing/SKILL.md`; `container/skills/price-baselining/SKILL.md`;
`market_segments` schema in `watcher/src/db.ts` (`ensureSchema`).

### Issue 5 — auto-pause is sticky until watcher restart (operational)

- The "Source auto-paused after 10 consecutive failures" state for `(hunt 8, autotrader)`
  persists in the scheduler's in-memory failure tracking. The warning itself says re-enable is
  "manually by restarting the watcher". So even after the underlying bug is fixed, **the
  watcher must be restarted** (`systemctl restart deal-hunter-watcher.service`) before hunt 8
  is polled again.
- Worth discussing whether a config error (translator throw) *should* count toward the same
  auto-pause budget as a transient API failure — a malformed hunt will burn the budget and
  silently disable the source for that hunt.

Refs: scheduler failure/auto-pause logic in `watcher/src/scheduler.ts` (search "consecutive
failures" / "auto-paused").

## Cadence note (not a bug, for context)

Effective poll interval resolves as `poll_interval_minutes ?? vertical.default_poll_minutes
?? cadence_minutes ?? 60` (`watcher/src/scheduler.ts:224`). Hunt 8 has `poll_interval_minutes
= NULL` and the cars vertical default is **360 min**, so once working it polls every 6h. The
hunt row's `cadence_minutes = 60` is overridden by the vertical default and is a red herring.

## Open design questions to resolve before any fix

1. **Multi-model in one hunt vs one hunt per model.** Does a cars hunt carry N candidate
   models (fan search across `search_terms`, shared criteria for postcode/budget/mileage/fuel),
   or is each model its own flat hunt? This determines the criteria schema, the translator, the
   agent's hunt-creation behaviour, and how the dashboard groups offers.
2. **Criteria schema contract.** If multi-model: extend `cars.criteria_schema` and `CarsCriteria`
   to a documented rich shape, and make the translator + agent agree on it. If single-model:
   constrain the agent (requirements-discovery / hunt-management) to emit the flat schema and
   reject rich objects at write time.
3. ~~**De-duplicate the two AutoTrader search implementations**~~ **RESOLVED** — vendored shared
   `autotrader-filters.ts` (`buildAutotraderFilters` + `AT_FILTER`) with a 3-layer drift guard.
4. ~~**Confirm the correct `year` filter name**~~ **RESOLVED** — `min_year_manufactured` /
   `max_year_manufactured` (probed against the live FilterName enum).
5. ~~**Baselining at creation**~~ **RESOLVED** — enforced by the draft→activate gate (Issue 4).
6. ~~**Auto-pause semantics** for config-error vs transient-failure.~~ **RESOLVED** — config errors
   no longer burn the auto-pause budget; auto-pause is now a self-recovering throttle (Issue 5).

## Reproduction / verification pointers

- Hunt + state: `sqlite3 groups/telegram_main/deal-hunter.db` →
  `SELECT criteria, search_terms FROM hunts WHERE id=8;`
  `SELECT COUNT(*) FROM market_segments WHERE hunt_id=8;`
  `SELECT COUNT(*) FROM hunt_offers WHERE hunt_id=8;`
- Live failure: `grep -n "criteria.make is required\|auto-paused" logs/watcher.log`
- Dashboard: `192.168.50.50/hunts/8?tab=market` (Market/Offers/Activity all empty).
- After any fix: rebuild affected layer, then **restart the watcher** to clear auto-pause:
  - watcher/translator: `cd watcher && npx tsc` (+ rebuild `verticals/` dist if translator
    changed) `&& systemctl restart deal-hunter-watcher.service`
  - agent MCP: `./container/build.sh` → `rm -rf data/sessions/*/agent-runner-src/` → restart NanoClaw.
