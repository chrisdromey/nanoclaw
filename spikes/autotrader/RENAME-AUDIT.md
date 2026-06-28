# RENAME-AUDIT — eBay-flavoured references in the codebase

Generated as part of Phase 4 QA. Each entry classified as:
- **needs-fix**: orphaned eBay-specific reference in source-agnostic code
- **legit-ebay**: inside the eBay adapter, eBay route, or clearly-scoped eBay flow
- **doc/comment**: low-priority comment, log message, or documentation prose
- **deferred**: existed before Phase 1–3; not a regression

Files marked `dashboard/spikes/docs/temp` are excluded unless they reference live code paths.

---

## Watcher (`watcher/src/`)

| file:line | hit | classification | notes |
|---|---|---|---|
| `watcher/src/index.ts:4` | "polls eBay for new listings" | doc/comment | top-of-file docstring; should say "polls configured sources" |
| `watcher/src/scheduler.ts:4` | "no hard-coded eBay calls" | doc/comment | accurate; keep |
| `watcher/src/scheduler.ts:7` | "registers the eBay adapter" | doc/comment | accurate |
| `watcher/src/scheduler.ts:115` | "Translate hunt criteria into eBay-native search params" | **needs-fix** | the function is hard-coded for eBay only; per-vertical translators are a TODO. Either remove the misleading comment or wire the translator path. |
| `watcher/src/scheduler.ts:238-246` | inline translator switch by `sourceId === 'ebay'` | **needs-fix** | architectural shortcut. Per plan, translator should be `verticals/<v>/translators/<source>.ts`. Currently AT translator only fires via the agent-runner MCP, not via watcher tick. |
| `watcher/src/notifier.ts:59` | "current bid £…" | legit-ebay | only fires for `auction_ending` change-type, which only eBay emits. |
| `watcher/src/db.ts:396,527` | "Used by all source adapters (eBay, AutoTrader…)" | doc/comment | accurate |
| `watcher/src/change-detector.ts` | n/a | clean | source-agnostic; only operates on synthetic ItemDetail from getState |
| `watcher/src/sources/types.ts:29,39,51` | "eBay-flavoured fields preserved" / "eBay's totalByFormat" / "mirrors current eBay watch" | doc/comment | accurate but reveals that eBay-shaped fields leak into the universal interface (cf. Issue F-2) |
| `watcher/src/sources/ebay/**` | many | legit-ebay | adapter internals |
| `watcher/src/sources/ebay/auth.ts:21,28,31` | log messages "eBay OAuth …" | legit-ebay | inside adapter |
| `watcher/src/sources/autotrader/**` | n/a | clean | no eBay refs |

## Dashboard (`dashboard/`)

| file:line | hit | classification | notes |
|---|---|---|---|
| `dashboard/server/routes/offers.ts:192` | "eBay and other fast sources" | doc/comment | accurate; phrase is OK |
| `dashboard/server/sources/ebay.ts:*` | adapter internals | legit-ebay | scoped to ebay.ts |
| `dashboard/server/sources/autotrader.ts` | uses raw `fetch()` without rate-limit | **needs-fix** (BIG — see Issue F-1) | not a tech-debt rename but bypasses safety guarantees |
| `dashboard/shared/types.ts:30` | "eBay-flavoured fields — nullable" | doc/comment | accurate |
| `dashboard/src/components/source-specific/EbayAuctionBlock.tsx` | all eBay refs | legit-ebay | properly scoped |
| `dashboard/src/components/source-specific/EbayConditionBadge.tsx` | all eBay refs | legit-ebay | properly scoped |
| `dashboard/src/components/source-specific/ViewOnSourceLink.tsx:5` | `'eBay'` label | legit-ebay | source-id → display label map |
| `dashboard/src/components/hunts/SettingsTab.tsx:181` | `<h3>eBay Categories</h3>` | **needs-fix** | shown for ALL verticals including `cars`, where the eBay-categories input is meaningless. Should be conditioned on `hunt.vertical === 'computers'` (or rendered only when sources include 'ebay'). |
| `dashboard/src/components/hunts/MarketTab.tsx` | "Auction" badge / condition-only column | partly addressed | the file extracts ConditionBreakdown conditionally on `isComputers`; auction tag is per-offer, accurate |
| `dashboard/src/components/hunts/OffersTab.tsx` | per-table-column conditioning | clean | properly conditioned on `isCars`/`isComputers` |
| `dashboard/src/pages/OfferDetail.tsx:280` | comment "Auction info bar — eBay only" | doc/comment | accurate |
| `dashboard/src/__tests__/source-specific-components.test.tsx` | many | legit-ebay | test fixtures |

## Container skills (`container/skills/`)

| file:line | hit | classification | notes |
|---|---|---|---|
| `container/skills/listing-evaluation/SKILL.md:4` | "eBay sold-comp methodology, condition grading" | legit-ebay | this skill IS the `computers` vertical evaluator, eBay-sourced. OK per plan. |
| `container/skills/price-baselining/SKILL.md` | many ("eBay sold listings", "Browse API") | legit-ebay-but-could-soften | baselining is eBay-only by current design; future verticals should not call this skill. Add a note. |
| `container/skills/research/SKILL.md:15,17,83,93` | "I'm seeing X on eBay" prose | doc/comment | research-skill prose, OK |
| `container/skills/requirements-discovery/SKILL.md:29,39,40` | "Search eBay immediately." | **needs-fix-soft** | this skill is invoked for ALL verticals during hunt creation; eBay-only instructions don't apply to cars. Should say "search the appropriate source" or be conditioned by vertical. |
| `container/skills/hunt-management/SKILL.md:63,73,75,78` | many | **needs-fix-soft** | mentions `eBay API calls per poll`, `eBay categories`, etc. Computers-vertical-specific in a vertical-agnostic skill. |
| `container/skills/hunt-management/HUNT-PHILOSOPHY.md` | extensive "Start with eBay" prose | **needs-fix-soft** | philosophy doc; needs vertical-aware framing |

## Agent runner (`container/agent-runner/src/`)

| file:line | hit | classification | notes |
|---|---|---|---|
| `container/agent-runner/src/ebay-search-mcp.ts` | adapter internals | legit-ebay | dedicated MCP |
| `container/agent-runner/src/sold-data-mcp.ts` | adapter internals | legit-ebay | dedicated MCP |
| `container/agent-runner/src/deal-hunter-mcp.ts:69,273` | "eBay category IDs" | **needs-fix-soft** | MCP tool description and warning use eBay vocabulary even though hunts can target other sources |
| `container/agent-runner/src/index.ts:330,344,350,423,428` | eBay OAuth fetcher messages | legit-ebay | direct OAuth path |
| `container/agent-runner/src/index.ts:511` | description "(eBay-sourced)" | legit-ebay-tagged | de-eBay-fied per plan; accurate |
| `container/agent-runner/src/index.ts:536` | description "uses eBay sold-comp methodology" | doc/comment | accurate, but baselining is now vertical-bound |
| `container/agent-runner/src/index.ts:594` | "no eBay-specific language" | doc/comment | self-policing prompt, fine |

## Root (`src/`)

| file:line | hit | classification | notes |
|---|---|---|---|
| `src/container-runner.ts:244` | EBAY_CLIENT_ID injection | legit-ebay | env-var pass-through |
| `src/container-runner.test.ts` | mock missing EBAY_CLIENT_ID | **deferred** | pre-existing, dates from commit 13ce4aaf (March 2026); not a Phase 1–3 regression. Tagged accordingly. |
| `src/index.ts` | misc | clean | no leftover refs |
| `src/verticals/loader.ts` | n/a | clean | source-agnostic |
| `src/ebay-search-mcp.ts` | adapter | legit-ebay | |
| `src/sold-data-mcp.ts` | adapter | legit-ebay | |

## Docs (`docs/`, `temp/`)

| file | classification | notes |
|---|---|---|
| `docs/delhunter/multi-vertical-rollout.md` | doc | the new operations doc; references eBay correctly as one source among many |
| `docs/delhunter/deal-hunter-{prd,system-architecture,implementation-plan}.md` | doc/legacy | predates multi-vertical work; should be marked archived or updated |
| `docs/deal-hunter-briefing.md` | doc | unmodified by Phase 1–3; references eBay-only world |
| `temp/ebay-m90q-analysis.md` | doc/throwaway | scratch file, ignore |
| `CLAUDE.md:79,83` | needs-fix | "Automated eBay UK deal-finding system" / "Watcher polls eBay" — both inaccurate post-multi-vertical (see Issue J) |

## Other

| file | classification | notes |
|---|---|---|
| `config/verticals.yml` | clean | source-agnostic |
| All `*.test.ts/.tsx` test files referencing eBay | legit-test | regression-test fixtures |
| `spikes/` | doc | dev-only, ignore for tech-debt |

---

## Summary

- **needs-fix** in production code: 4 sites (scheduler inline translator, SettingsTab "eBay Categories" header, dashboard autotrader.ts bypass, CLAUDE.md)
- **needs-fix-soft** (skills/MCP descriptions): 4 sites — visible to the user/agent, computers-flavoured prose in vertical-agnostic surfaces
- **legit-ebay**: ~20 sites — adapter internals, properly scoped
- **doc/comment**: ~15 sites — log lines, file headers; low priority
- **deferred**: 1 (container-runner.test.ts mock — pre-existing)
