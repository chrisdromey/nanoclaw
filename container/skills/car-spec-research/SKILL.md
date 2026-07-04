---
name: car-spec-research
description: >
  Build and maintain a reusable trim/feature knowledge base for a car model —
  which trims, option packs and model years carry which features. Use when a
  cars hunt is feature-led and you need to know which variants deliver the
  buyer's must-haves, when a model surfaces in discovery with no knowledge base
  yet, or when an existing one is stale. Produces a durable product-knowledge
  file that every later hunt agent reads instead of re-deriving.
---

# /car-spec-research — Trim & Feature Knowledge Base (Cars Vertical)

T3 (bespoke) research skill for the `cars` vertical. Cars are bought by *feature*, not by trim name — "electric, room for two child seats, adaptive cruise + lane-keep, ~£20k" — but features live at wildly different trims, packs and model years across models (base MG4 has adaptive cruise; base Nissan Leaf does not). Working that out is the heavy lift the buyer can't do on AutoTrader's filters. This skill does it **once per model** and writes the result to a knowledge base that `car-listing-evaluation`, `price-baselining`, `/research` and future hunts all read.

## Build once, refer back — the core principle

The knowledge base is durable, cross-hunt reference material. **Never re-derive what already exists.**

1. Before researching anything, read `references/product-knowledge/cars/{make}-{model}.md`.
2. If it exists and covers the years the brief needs, **use it** — go straight to the cross-model shortlist (below). Do not re-research.
3. Only build a new file (or extend an existing one) when there is no coverage, or it's stale.

A model's trims and standard-equipment don't change once a generation ships, so these files age well. Refresh only when: a new model year/facelift appears, the file predates a generation the brief now needs, or evaluation surfaces a contradiction with what's on record.

## Two layers — don't conflate them

| Layer | Lives in | Scope | Reusable? |
|-------|----------|-------|-----------|
| **Per-model trim KB** | `references/product-knowledge/cars/{make}-{model}.md` | One model, all relevant generations | Yes — every hunt for this model reads it |
| **Cross-model shortlist** | the hunt's `## Research Summary` | "Which models/trims fit *this* brief" | No — specific to one brief |

This skill builds the **KB**. The shortlist is assembled *from* KBs (plus any new ones you build) and written to the hunt file per the `/research` skill's synthesis step.

## When to use

- A new cars hunt where the brief is feature-led and you need to know which trims/years deliver the must-haves
- A candidate model surfaces in discovery with no KB on file
- `car-listing-evaluation` hits a trim or feature it can't resolve from the KB
- An existing KB is stale (new model year, or the brief needs a generation not yet covered)

## Workflow

### 1. Decompose the brief into decision features

Turn the buyer's words into the features that will decide the purchase, separating **must-haves** (a listing fails the brief without them) from **nice-to-haves**. Add the durable high-value features that matter for *any* buyer of this class (safety rating, ISOFIX, boot/seats, real-world range for EVs) — the KB is reusable, so capture more than one brief needs.

### 2. Identify the candidate models (cross-model discovery)

Which models even offer these features in budget? Use WebSearch broadly ("used electric family car under £20k UK adaptive cruise lane assist"). Follow the `/research` skill's *Challenge the brief* discipline — include at least one option the user didn't name. This produces the candidate set; each candidate needs a KB.

### 3. Build the KB per model

For each candidate without a current KB, research it to the trim/pack/year level. This is a good fit for the `/research` skill's sub-agent swarm (one sub-agent per model, or per generation for long-lived models) — **this skill defines *what* to gather and the output shape; `/research` provides the parallelism**.

**Sources (UK), best first:**
- **Parkers** (`parkers.co.uk/{make}/{model}/{body-year}/trim-{trim}/specs/`) — per-trim, per-generation, UK-spec. The structured backbone.
- **carwow / DrivingElectric / What Car? / Auto Express** — trim ladders, "what you get" reviews, used-buyer guides
- **Wikipedia** — generation boundaries and facelift dates (essential — trim names recur across generations meaning different things)
- **Manufacturer brochures / press releases** — option-pack contents and names
- **Owner forums** (SpeakEV, PistonHeads, model-specific) — what's *actually* fitted vs. theoretically available, common mislabels

**Capture the ambiguity, don't paper over it.** Driver-assist and comfort features are often optional packs, vary by model year, and sources contradict each other. When availability is uncertain, say so, mark confidence, and record **how to verify it on an actual listing** — that note is what makes the KB useful at evaluation time.

### 4. Write the KB file

Write to `references/product-knowledge/cars/{make}-{model}.md` using the template below. Follow the `/documentation` conventions: factual, scannable, dated, append/extend rather than overwrite. Every non-obvious claim should trace to a source URL in the Sources section.

### 4b. Register KB coverage in the DB (so the hunt can activate)

A feature-led hunt is gated on cited KB coverage — the activation gate (which only sees the database,
not the KB files) blocks until each target model has a coverage record proving its must-haves are
cited. After writing the KB file, call `mcp__deal-hunter-db__record_kb_coverage` once per target:
- `hunt_id`, `target_key` (the exact `criteria.targets` key, e.g. `"Polestar 2"`), `kb_path` (the file
  you just wrote).
- `must_have_citations` — a map from each of the hunt's `intent.must_have` features to the number of
  **distinct source URLs** in the KB that substantiate it for this model, e.g.
  `{"Adaptive cruise control (ACC)": 2, "Lane keep / lane centering": 1}`. Every must-have needs ≥1
  cited source or the gate blocks — so if you couldn't cite one, that's a research gap to close, not a
  number to inflate. The strings must match the hunt's `must_have` entries verbatim.

Recording coverage is **not** the same as verification — an independent verifier re-checks the
must-haves separately (`/musthave-verification`). Coverage says "the KB cites this"; verification says
"an independent source confirms it". Both are required before activation.

### 5. Assemble the cross-model shortlist

With KBs in hand, write the hunt's `## Research Summary` (per `/research` step 7): the ranked candidate models/trims for *this* brief, the feature × candidate comparison, the trade-offs, and the target/reject guidance — each pointing back to the relevant KB file for detail. Recommend hunt criteria and search terms but don't change the hunt without the user's agreement.

## KB file template

```
# {Make} {Model} — Trim & Feature Reference

*Last updated: {date}*
*Coverage: {generations / year ranges covered}*
*Source: car-spec-research*

## Generations & Facelifts
| Generation | Years | Body styles | Key mid-cycle changes |

## Trim Ladder — {generation}
Low → high, with positioning and the rough used-price step between trims.

## Feature-by-Trim Matrix — {generation}
Rows = trims. Columns = the decision features (brief must-haves + durable
high-value features). Cells: Std / Opt:{pack} / – .
| Trim | Adaptive cruise | Lane-keep | ISOFIX (rear) | Heated seats | ... |

## Option Packs
| Pack | Contents | Trims/years available | How it shows on a listing |

## Model-Year Notes
Year ranges where standard-equipment or feature availability changed
(e.g. "2019 facelift: ProPilot became standard on N-Connecta and above").

## Identifying Trim & Verifying Features on a Listing
- Where the trim appears (AutoTrader derivative string in title/subTitle)
- How to confirm an *optional* feature is actually fitted: spec-list keywords,
  photo cues (button/stalk/screen), description phrases
- Common mislabels and ambiguities to watch for

## Desirability & Trade-offs
Sweet-spot trim(s) for typical buyers and what each trade-off costs.

## Sources
- {URL} — {what it confirmed}

## Confidence
{High / Medium / Low per section where it varies} — note where availability
could not be pinned down and must be verified per listing.
```

## How other agents use this KB

- **car-listing-evaluation** — reads the KB to map a listing's derivative string to a trim, confirm the brief's must-have features are present (using the "verify on a listing" notes), and flag uncertainty rather than guessing.
- **price-baselining** — defines market segments per *model+trim* (e.g. "Leaf N-Connecta" vs "Leaf Acenta" are different price tiers, like CPU variants are for mini PCs), tagged so offers match.
- **/research & /requirements-discovery** — read existing KBs first to build the cross-model shortlist without re-deriving trim facts.

## Rules

- **Check for an existing KB before researching** — re-deriving wastes effort and the file is the whole point.
- Key everything by **generation/facelift** — trim names mean different things across generations.
- A trim is the floor, not the ceiling — individual cars carry factory options above their trim. The matrix gives the baseline; the "verify on a listing" notes catch the deltas.
- Mark confidence and record verification cues wherever feature availability is uncertain — honesty about ambiguity is more useful than false precision.
- Every non-obvious claim traces to a source URL. Hardware-style facts (standard equipment) are durable; pricing is not — leave pricing to `price-baselining`.
- One file per model covering all generations is the default. If a long-lived model (many generations) pushes the file past ~500 lines, split per generation into a `references/product-knowledge/cars/{make}-{model}/` folder with an index, per the `/documentation` conventions.
- Don't change hunt criteria off the back of research without the user's agreement — recommend, don't impose.
