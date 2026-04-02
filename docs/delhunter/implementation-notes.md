# Deal Hunter — Implementation Notes

## Decisions Made

### Deployment Model: Fork
- Forked `qwibitai/nanoclaw` to `chrisdromey/nanoclaw`
- NanoClaw is designed to be forked, not used as a dependency
- Upstream updates via `git fetch upstream main && git merge upstream/main` or `/update-nanoclaw` skill
- Skill updates via `/update-skills`
- `upstream` remote configured on both local clone and LXC

### Infrastructure: LXC 108 on pve4
- **Hostname:** nanobot
- **IP:** 192.168.50.50
- **OS:** Ubuntu 24.04 LTS
- **Resources:** 2 cores, 4GB RAM, 30GB disk, 1GB swap
- **Nesting:** Enabled (required for Docker agent sandboxing)
- **Managed by:** Terraform (`terraform/modules/lxc-containers/nanobot.tf`)
- **Note:** Originally provisioned as VMID 103, recreated as VMID 108 during Terraform apply (disk resize forced replacement)

### NanoClaw Clone
- **On LXC:** `/opt/nanoclaw` (working deployment)
- **Local:** `/home/chris/homelab/nanoclaw` (for reference)
- Both have `origin` → `chrisdromey/nanoclaw`, `upstream` → `qwibitai/nanoclaw`

### Development Workflow
- VS Code Remote SSH into `nanobot` (192.168.50.50), working directory `/opt/nanoclaw`
- Claude Code CLI on the LXC for `/setup` and interactive skills
- SSH config added to both WSL (`~/.ssh/config`) and Windows (`C:\Users\chris\.ssh\config`)

## Completed Steps

1. Researched NanoClaw — confirmed fork-based deployment model
2. Updated Terraform for LXC: 2GB→4GB RAM, 10GB→30GB disk, enabled nesting
3. Fixed `ostemplate` ignore_changes across all LXC Terraform resources (prevents forced replacement)
4. Restored openclaw from PBS backup after accidental destruction during Terraform apply
5. Forked `qwibitai/nanoclaw` to `chrisdromey/nanoclaw`
6. Cloned fork to LXC at `/opt/nanoclaw` with upstream remote
7. Cloned fork locally at `/home/chris/homelab/nanoclaw`
8. Installed git, curl, ca-certificates on LXC
9. Claude Code CLI install and `claude login` on LXC
10. SSH config and VS Code Remote SSH configured
11. Ran `/setup` — Node.js 22, Docker 29.3, container image built, systemd service configured
12. Telegram channel connected with bot pool (main bot + 3 swarm bots)
13. **eBay MCP server integrated (2026-03-22)**
    - eBay developer account created, production keyset enabled (opted out of account deletion notifications — app is read-only Browse API)
    - Using official `@ebay/npm-public-api-mcp` (npm, option 2 from implementation plan)
    - Wrapper script (`container/scripts/ebay-mcp-wrapper.sh`) fetches fresh OAuth token via client credentials grant on each container start, then execs the MCP server — avoids 2-hour token expiry issues
    - Credentials stored in `.env` (`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`), read by host via `config.ts`, passed to containers as env vars
    - MCP server registered in `container/agent-runner/src/index.ts` as `ebay-api` (conditional — only when creds present)
    - `mcp__ebay-api__*` added to allowed tools
    - Verified: token fetch works inside container, Browse API returns UK listings (237 M90Q results on EBAY_GB)
14. **Fixed stale session ID bug (2026-03-22)**
    - Known upstream issue: qwibitai/nanoclaw#1216
    - Root cause: Claude Code server-side sessions expire, but NanoClaw never clears the stale session ID from SQLite — every subsequent message fails with "No conversation found with session ID"
    - Fix: added `deleteSession()` to `db.ts`, updated `index.ts` error handler to detect the specific error and clear the stale session so the next message starts a fresh session automatically
15. **Deal Hunter DB Tool Server (MCP) built (2026-03-22)**
    - SQLite database with 7 tables: hunts, offers, search_queries, hunt_offers, prices, evaluations, alerts
    - MCP server at `container/agent-runner/src/deal-hunter-mcp.ts` using `better-sqlite3` (native bindings)
    - 13 coarse-grained tools: manage_hunt, get_hunt, get_hunt_summary, get_market_overview, record_offer, update_offer, get_offer, record_evaluation, record_alert, record_alert_response, get_prices, record_search, search_evaluations
    - DB file persists in group folder at `/workspace/group/deal-hunter.db` (accessible by both container MCP and future host-side watcher)
    - WAL mode enabled for concurrent read/write access
    - Registered unconditionally as `deal-hunter-db` MCP server in agent-runner (tools available as `mcp__deal-hunter-db__*`)
    - Added `better-sqlite3` to container deps, `python3 make g++` to Dockerfile for native compilation
    - Container rebuilt, agent-runner source cache cleared, service restarted

16. **Sold Data Tool MCP server built (2026-03-22)**
    - Scrapes eBay UK sold/completed listings for historical price data (no API exists for this)
    - MCP server at `container/agent-runner/src/sold-data-mcp.ts` using puppeteer-core + cheerio
    - Uses headless Chromium inside the container to bypass eBay's Akamai bot detection (plain fetch from datacenter IPs gets blocked)
    - 1 tool: `get_sold_prices` — returns raw items with title, price, shipping, condition, date, URL, item_id
    - Supports both `.s-card` (current eBay layout) and `.s-item` (legacy) HTML structures
    - `item_id` field extracted from URL so agent can call `mcp__ebay-api__getItem` for full specs
    - Rate-limited (3s between page fetches), max 3 pages, browser idle timeout after 60s
    - Graceful error handling: CAPTCHA detection, partial results on pagination failure
    - Registered as `sold-data` MCP server in agent-runner (tools available as `mcp__sold-data__*`)
    - Added `cheerio` + `puppeteer-core` to container deps
    - Originally had `get_sold_summary` (aggregate stats) — **removed** after testing showed 98% search result contamination makes automated stats useless. The agent reasons about pricing, not the tool.
17. **Price-baselining skill created (2026-03-22)**
    - Container skill at `container/skills/price-baselining/SKILL.md`
    - Gates the sold data tool — agent can't call `mcp__sold-data__*` without this skill
    - Defines a 5-step workflow: broad search → scan & categorise → inspect representative listings → synthesise → write findings
    - Agent writes pricing findings as prose to the hunt file's Price Research section (not DB)
    - Key design insight: eBay search results are heavily contaminated (accessories, other models, variants) — the agent must filter and reason about results, not compute stats over them
    - Agent uses `mcp__ebay-api__getItem` (Browse API) to inspect individual sold listings for full specs (processor, RAM, storage) — confirmed working on sold/ended items
    - Verified: Browse API `getItem` returns structured `localizedAspects` (item specifics) for ended listings
18. **Fixed `__dirname` not defined error in agent-runner (2026-03-22)**
    - `__dirname` was defined as a local variable inside `main()` but referenced in `runQuery()` which couldn't see it (ESM module, no global `__dirname`)
    - Moved `__dirname` definition to module scope
    - This was broken since the deal-hunter-db MCP server was added (step 15) but only surfaced when testing
    - Also fixed stale IPC input file (`EACCES: permission denied`) from previous failed container runs
    - Also fixed stale session ID issue — session `ccedcbd5-...` had expired server-side, NanoClaw's existing stale session handler cleared it on retry
    - Source cache at `data/sessions/telegram_main/agent-runner-src/` must be updated when `container/agent-runner/src/` changes — the mount overwrites the container image's built-in source
19. **Added progress update guidance to CLAUDE.md (2026-03-22)**
    - Agent was running 4+ minute operations with zero feedback to the user — silence feels broken
    - Added "Keep the user in the loop" section to `groups/telegram_main/CLAUDE.md`
    - Rules: acknowledge immediately, send progress updates after each major step, keep updates short, report failures
    - No code change — CLAUDE.md is mounted directly into the container
20. **First successful price-baselining test (2026-03-22)**
    - Agent searched eBay sold listings for "lenovo m90q", correctly identified ~12 genuine M90Q sales out of 245 noisy results
    - Inspected individual listings via Browse API `getItem` for full specs
    - Produced a detailed prose baseline covering Gen 1-5, with price ranges per variant, gotchas (bundled peripherals, overseas shipping, outliers), and value comparisons vs M80q
    - Confirmed the full flow works: sold data tool → agent reasoning → Browse API inspection → prose output

21. **Fixed container write permission issue (2026-03-23)**
    - Agent reported deal-hunter-db tools unavailable and workspace read-only
    - Root cause: NanoClaw runs as root (uid 0), container-runner.ts skips `--user` override for uid 0, container runs as default `node` user (uid 1000). All writable mount source directories were owned by `root:root` with `755` — uid 1000 could read but not write.
    - Affected mounts: `/workspace/group` (group folder), `/home/node/.claude` (sessions), `/app/src` (agent-runner source), `/workspace/ipc` (IPC)
    - Fix: `chown -R 1000:1000` on `groups/telegram_main/` and `data/sessions/telegram_main/`, created missing IPC directories
    - Also created missing reference files: `references/preferences.md` (empty template), `references/ebay-uk-guide.md` (UK VAT rules, import duty calculation, eBay buying formats, seller ratings, cost calculation checklist)
22. **Remaining deal-hunter skills deployed (confirmed 2026-03-23)**
    - All five container skills exist in `container/skills/`: requirements-discovery, price-baselining, listing-evaluation, hunt-management, documentation
    - Skills synced to `data/sessions/telegram_main/.claude/skills/` at container startup
    - Group CLAUDE.md configured with deal-hunting operating principles, MCP tool references, and skill pointers

23. **Custom eBay search MCP — parallel buying format queries (2026-03-23)**
    - Discovered the official eBay Browse API silently excludes auction listings — only returns FIXED_PRICE by default. The `buyingOptions` filter doesn't support OR, so each format requires a separate API call.
    - Built custom MCP server at `container/agent-runner/src/ebay-search-mcp.ts` with a single `search_ebay` tool
    - Fires 3 parallel Browse API requests (AUCTION, FIXED_PRICE, BEST_OFFER) via `Promise.allSettled`, deduplicates by `itemId`
    - Returns triage-weight items: title, categories, price, currentBidPrice, condition, buyingOptions, bidCount, itemEndDate, shippingCost, seller, itemWebUrl, location — enough to decide what's worth a `getItem` call
    - Response is ~21 KB for 18 items (vs ~49 KB with full Browse API fields) — 57% reduction
    - OAuth token fetched in `index.ts` via new `fetchEbayToken()` helper, passed as `EBAY_ACCESS_TOKEN` env var
    - Registered as `ebay-search` MCP server (conditional on credentials + successful token), tools available as `mcp__ebay-search__*`
    - Sits alongside the official `ebay-api` MCP — agent uses `ebay-search` for discovery, `ebay-api` for `getItem` detail
    - Tested: FIXED_PRICE returned 236 results, AUCTION 2, BEST_OFFER 25 — auctions now visible
24. **Updated skills to use new search MCP (2026-03-23)**
    - `price-baselining/SKILL.md` — added step 2 "Active listings search" using `mcp__ebay-search__search_ebay`, explicit warning not to use `mcp__ebay-api__search` for discovery
    - `listing-evaluation/SKILL.md` — added "Finding offers" section before workflow, same warning about official MCP limitations
    - Both skills now guide the agent to use `ebay-search` for discovery and `ebay-api` only for `getItem` detail

25. **Watcher service built (2026-03-23)**
    - Standalone TypeScript service at `watcher/` with own `package.json` and `tsconfig.json`
    - Runs as independent process alongside NanoClaw, calls eBay Browse API directly (no Claude API cost per poll)
    - Four components: scheduler (30s tick), eBay adapter (parallel 3-format search + getItem), change detector, IPC notifier
    - Search polls: reads active monitored hunts from DB, searches each term at configured cadence, writes offers/prices/hunt_offers to shared SQLite
    - Watch polls: every 2 hours, fetches current state of watched offers via getItem, detects price changes, auction ending, offer removal
    - Urgent notifications: writes IPC task files to trigger immediate agent invocation for time-sensitive events (auction ending <3h, watch condition met, watched offer removed)
    - Routine changes: just writes to DB, agent picks up via hourly scheduled task calling `get_hunt_summary`
    - Startup recovery: seeds lastSearchTime from `search_queries` table to respect cadence after restart
    - Daily API budget tracking: stops at 4500 calls (eBay limit 5000/day)
    - Tested: picked up test hunt, searched eBay, wrote 62 offers to DB with correct associations
    - systemd service file at `watcher/deal-hunter-watcher.service` (not yet installed)
26. **Added explicit monitoring control (2026-03-23)**
    - Added `monitoring` column to hunts table (default 1) — controls whether watcher polls a hunt's search terms
    - Agent can create hunts with `monitoring: false` for research/baselining, then enable when ready
    - `manage_hunt` tool updated to accept `monitoring` parameter on create and update
    - Migration added for existing DBs (checks PRAGMA table_info, adds column if missing)
    - Watcher's `getActiveHunts()` filters by `status = 'active' AND monitoring = 1`
    - Skills updated: hunt-management explains monitoring lifecycle, listing-evaluation explains WATCH → update_offer flow with watch_conditions
27. **Added watcher system overview to agent CLAUDE.md (2026-03-23)**
    - Added "How the System Works" section to `groups/telegram_main/CLAUDE.md` explaining the watcher, search monitoring, offer monitoring, scheduled evaluation runs, and urgent invocations
    - Added `ebay-search` to MCP Tools section
    - Agent now understands the full system it's operating in

28. **Deployed watcher service and hourly evaluation task (2026-03-23)**
    - Watcher systemd service installed at `/etc/systemd/system/deal-hunter-watcher.service`, enabled and running
    - DB permissions fixed: `deal-hunter.db` set to 666 for concurrent access by watcher (root) and container (uid 1000)
    - Hourly agent evaluation task created via IPC: cron `0 * * * *`, task ID `deal-hunter-eval-hourly`
    - Fixed target JID: registered group is `tg:6767009477` not `tg:telegram_main` — updated both the scheduled task and watcher config
    - Added run log guidance to CLAUDE.md — agent logs every invocation to the hunt file's `## Run Log` section
29. **First live agent session and review (2026-03-23)**
    - Agent ran requirements-discovery → hunt-management → price-baselining in a multi-turn conversation
    - Created hunt with 7 search terms, watcher picked up within 30s, populated 358 offers
    - See "First Live Agent Session Review" section below for full analysis
30. **Fixed stale agent-runner source cache (2026-03-23)**
    - Agent didn't have access to `mcp__ebay-search__search_ebay` because `ebay-search-mcp.ts` was missing from the per-group source cache at `data/sessions/telegram_main/agent-runner-src/`
    - Root cause: `container-runner.ts` only copies source on first run (`!fs.existsSync` check). Updates to `container/agent-runner/src/` don't propagate to existing groups.
    - Fix: cleared stale cache (`rm -rf data/sessions/*/agent-runner-src/`), restarted NanoClaw. Next container recreates from current source.
    - Added deploy procedure to project `CLAUDE.md`: after editing agent-runner source, always clear caches and restart.
31. **Updated hunt-management skill with search term guidance (2026-03-23)**
    - Added "Search Term Design" section explaining API cost per term, why overlap is wasteful, and to test terms with ad-hoc search before committing
    - Added "watcher system overview" to `groups/telegram_main/CLAUDE.md` so agent understands the full monitoring architecture
32. **Research swarm skill created (2026-03-25)**
    - New container skill at `container/skills/research/SKILL.md` — teaches the agent to use orchestrator-worker pattern for deep parallel research
    - Uses existing TeamCreate/SendMessage tools (no code changes needed)
    - Progressive disclosure output model: deep dive files in `references/research/{hunt-name}/`, condensed summary in hunt doc
    - Sub-agents write findings to files, send short status via SendMessage to orchestrator; orchestrator critically synthesises and manages user communication
    - Includes scoping heuristic (swarm vs solo), sub-agent brief template, deep dive output template
    - Updated `groups/telegram_main/CLAUDE.md` with research skill reference, workflow ordering, research sub-agent rules
    - Updated `requirements-discovery/SKILL.md` with research handoff step
    - Updated `listing-evaluation/SKILL.md` with research file orientation and knowledge-gap rule
    - Aligns with Anthropic's documented "Orchestrator-Workers" pattern and their production multi-agent research system architecture

33. **Market-first hunt philosophy (2026-03-29)**
    - Agent was treating hunts as waterfall: gather all requirements → research products → create hunt → monitor. Spent 15-30 minutes thinking before ever looking at eBay.
    - Created `container/skills/hunt-management/HUNT-PHILOSOPHY.md` — conceptual foundation explaining hunts as iterative market-driven feedback loops, not project plans
    - Restructured `requirements-discovery/SKILL.md` — market-first workflow: get basics → search eBay immediately → share findings → let user reactions drive refinement
    - Updated `groups/telegram_main/CLAUDE.md` — replaced linear "typical workflow" with interleaving skills description, added "Start with the market" operating principle
    - Updated `hunt-management/SKILL.md` — flipped monitoring default to true (start learning immediately), reframed hunts as iterative
    - Updated `research/SKILL.md` — repositioned as reactive to market findings, not a prerequisite to starting
    - Updated `price-baselining/SKILL.md` — can run alongside monitoring, not as a gate
    - Updated `listing-evaluation/SKILL.md` — added "Learning from evaluations" section (every listing is market intelligence, feed findings back into the hunt)

## Next Steps

1. ~~**Test end-to-end with ebay-search tool**~~ — ✓ Done
2. ~~**Wait for hourly evaluation task**~~ — ✓ Verified 2026-03-25. 53 evaluations across 417 offers since March 23. Task fires roughly every hour (:01-:06 past). Agent reasoning is solid — correctly dismisses wrong generations, CPUs, and models with clear explanations.
3. ~~**Review evaluation quality**~~ — ✓ Reviewed 2026-03-25. Two issues identified:
   - **Research depth insufficient** — product knowledge file incorrectly says M75q Gen 2 has PCIe (it doesn't). Agent only researched Lenovo/Dell/HP — missed viable alternatives (Minisforum, Geekom, Beelink, etc.). The whole point is the agent does deep research so the user doesn't have to. See "Performance Review" section below.
   - **Hourly schedule is wasteful** — run log is ~790 lines, most entries are "nothing to do" or obvious noise dismissals. With the watcher handling offer ingestion, hourly agent invocation burns API credits for no value.
4. **Switch to event-driven + daily review** — replace hourly scheduled task with: (a) event-driven invocation when watcher finds new offers or a watch condition triggers, (b) once-daily review where the agent considers bigger picture: are hunt criteria right, do search terms need refining, is additional research needed, should scope expand?
5. ~~**Improve initial research depth**~~ — ✓ Done (2026-03-25). Created `/research` swarm skill (step 32). Orchestrator-worker pattern with progressive disclosure output. See "Performance Review" section for the problem analysis.
6. **Test research swarm end-to-end** — trigger the agent to research a topic and verify it spawns sub-agents, writes deep dive files, and synthesises into the hunt doc

## First Live Agent Session Review (2026-03-23)

**Conversation:** User asked for a Proxmox node hunt. Agent ran requirements-discovery → hunt-management → price-baselining in a natural multi-turn conversation (~7 user messages, 3 agent responses + 3 progress updates).

**What worked well:**
- Natural requirements discovery with iterative refinement
- Created comprehensive hunt file with tiered target models, nuanced price research, and run log
- Created product-knowledge reference (mini-pc-proxmox-nodes.md) with PCIe/DDR4 compatibility matrix
- Used sold-data tool for baselining, correctly identified M90q scarcity
- Watcher picked up the hunt within 30s of creation and populated 358 offers

**Issues found:**
1. **No evaluations** — 358 offers in DB, 0 evaluations. Agent did baselining but didn't evaluate any active listings. The hourly scheduled task should catch this, but ideally the agent should do a first-pass evaluation during setup.
2. **Monitoring enabled too early** — The hunt-management skill says "start with monitoring off, enable after baselining" but the agent enabled monitoring immediately on creation. The watcher ran all search terms while the agent was still doing price research.
3. **Too many search terms** — 7 terms created, several near-duplicates ("M90q Gen 1", "M90q Gen 2", "ThinkCentre M90q tiny" all return overlapping results). At 3 API calls per term per poll, this is 21 calls/cycle. At 60-min cadence = 1008 calls/day just for search polling. Could be consolidated to 4 terms (~576 calls/day).
4. **No active listing search** — Agent used sold-data for baselining but never used `mcp__ebay-search__search_ebay` to research active listings. Relied entirely on the watcher to find active offers.
5. **Run log is minimal** — One entry, doesn't list tools called or decisions made. Useful but needs more detail for debugging.

**Action items:**
- Add API budget guidance to hunt-management skill (max search terms, cost implications)
- Reinforce "monitoring off during baselining" in the skill
- Consider whether the agent should do a first-pass evaluation on setup
- Consolidate search terms or increase cadence

## Performance Review (2026-03-25)

### Issue 1: Initial research lacks depth

The requirements-discovery and price-baselining phase is supposed to be the agent's core value — doing the research legwork so the user doesn't have to. In the Proxmox node hunt, it fell short:

**Factual errors:**
- Product knowledge file (`mini-pc-proxmox-nodes.md`) states M75q Gen 2 has a PCIe slot — it does not. This incorrect data propagated into the hunt criteria where M75q Gen 2 was listed as a primary target with "PCIe slot confirmed". The agent should have verified hardware specs via multiple sources before committing them as facts.

**Narrow scope:**
- Agent only researched the obvious enterprise brands (Lenovo ThinkCentre, Dell OptiPlex, HP EliteDesk). Viable mini PC alternatives exist — Minisforum, Geekom, Beelink, GMKtec, Trigkey, etc. — many of which offer PCIe expansion, 10th/11th gen Intel or Ryzen, and competitive pricing on the used/refurbished market. The agent should have cast a wider net during requirements discovery rather than anchoring on the models the user initially mentioned.

**Shallow verification:**
- No cross-referencing of specs against manufacturer datasheets or community sources (e.g. ServeTheHome forums, /r/homelab, PSREF for Lenovo). A single web search per model would have caught the M75q PCIe error.

### Issue 2: Hourly evaluation schedule is wasteful

With the watcher handling offer ingestion and the agent evaluating on each hourly tick, the run log accumulated ~790 lines in 2 days — the vast majority saying "nothing to do" or dismissing obvious noise (wrong generation, accessories, wrong form factor).

**Problems:**
- Burns Claude API credits on empty runs (each invocation has a minimum cost even when there's nothing to evaluate)
- Run log becomes unreadable — signal buried in noise
- Agent has no time to think about strategy — every run is purely reactive (evaluate new offers, skip, done)

**Proposed replacement — event-driven + daily review:**
- **Event-driven:** only invoke the agent when the watcher writes new offers to the DB or a watch condition triggers. No new offers = no invocation.
- **Daily review:** once per day, agent reviews the day's activity and considers bigger picture questions: should hunt criteria change? Are search terms too noisy or too narrow? Is additional product research needed? Should the scope expand to new brands/models? Are there market trends worth noting?

## Known Issues

### CLAUDE.md placement for deal-hunting context
The watcher system description and deal-hunting context currently lives in `groups/telegram_main/CLAUDE.md`. This means only the telegram_main group knows about deal hunting. If a new group is created (e.g. Slack channel, second Telegram group), it won't have this context. Consider moving deal-hunting system context to `groups/global/CLAUDE.md` so all groups get it — but that requires deciding whether all groups should know about deal hunting or only specific ones. The global CLAUDE.md is currently generic Andy personality shared across all groups.

## Incidents

### Openclaw Destruction (2026-03-22)
- **Cause:** Terraform `ostemplate` storage path mismatch (`local:` vs `nas-fast:`) forced container replacement
- **Impact:** Openclaw (VMID 108) destroyed and recreated empty at VMID 103, losing all config and data
- **Resolution:** Restored from PBS backup (`pbs-nas:backup/ct/108/2026-03-22T03:05:39Z`) to VMID 103
- **Prevention:** Added `ostemplate` to `ignore_changes` on all 6 LXC Terraform resources

### Container Write Permissions (2026-03-23)
- **Cause:** Host process runs as root (uid 0), container-runner skips `--user` override, container runs as `node` (uid 1000). All writable mount directories owned by root with 755 permissions.
- **Impact:** deal-hunter-db MCP server couldn't create SQLite database, agent couldn't write any files to workspace. Agent's price research session produced results but couldn't persist them.
- **Resolution:** `chown -R 1000:1000` on `groups/telegram_main/` and `data/sessions/telegram_main/`
- **Note:** This will recur for any new group created while NanoClaw runs as root. Consider fixing `container-runner.ts` to chown directories after creation, or running NanoClaw as uid 1000.
