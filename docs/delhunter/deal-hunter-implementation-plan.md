# Deal Hunter Agent — Implementation Plan

## Reference Documents

- `deal-hunter-prd.md` — User-facing stories and acceptance criteria
- `deal-hunter-agent-requirements.md` — Agent efficiency and memory requirements
- `deal-hunter-system-architecture.md` — System components, DB schema, data flows
- `deal-hunter-skills-architecture.md` — Skills, reference docs, CLAUDE.md design

---

## Target Environment

- **LXC 103 on pve4** — already provisioned, nothing deployed yet.
- The deploying agent has full access to the Proxmox environment.
- Do not assume the network layout, storage configuration, or existing services. Inspect first.

---

## Prerequisites to Verify Before Starting

The deploying agent should check and confirm these before building anything:

1. **LXC 103 OS and state** — what's installed, what OS version, how much resource allocated
2. **Docker availability** — NanoClaw requires Docker for container isolation. Check if Docker is installed, or if the LXC is configured for nesting (required for Docker-in-LXC on Proxmox). If unprivileged LXC, nesting and keyctl features may need enabling at the Proxmox level.
3. **Node.js** — NanoClaw needs Node.js 20+. Check availability.
4. **Python** — the watcher service and sold data tool will likely be Python. Check availability.
5. **Network** — outbound HTTPS needed to: eBay API (api.ebay.com), eBay website (ebay.co.uk), Anthropic API (api.anthropic.com), and the chosen messaging platform (Slack API / Telegram API).
6. **Storage** — where to put the SQLite database file. Should be on reliable storage, not tmpfs.

---

## Phase 1: NanoClaw Foundation

**Goal:** NanoClaw running on LXC 103 with a messaging channel, responding to messages.

### Steps

1. **Fork NanoClaw** — clone from `https://github.com/qwibitai/nanoclaw`. This becomes our working fork.
2. **Install dependencies** — Docker running in the LXC, Node.js 20+, run NanoClaw's `/setup` skill via Claude Code.
3. **Authenticate with Claude Max** — run `claude login`. User must complete browser OAuth flow interactively.
4. **Connect a messaging channel** — ask user: Slack or Telegram? Run the appropriate `/add-slack` or `/add-telegram` skill. Verify two-way communication.
5. **Verify scheduled tasks** — set up a trivial recurring task. Confirm the scheduler fires and the agent responds.

### Done when
- Agent responds to messages on the chosen channel
- Scheduled tasks fire reliably

### Notes
- If Docker-in-LXC doesn't work, document what was needed to fix it
- If Claude Max auth fails, fall back to CLIProxyAPI

---

## Phase 2: Database & Tool Server

**Goal:** SQLite database with full schema, MCP tool server running and connected to the agent.

### Steps

1. **Create the SQLite database** — implement the schema from the system architecture doc (hunts, offers, hunt_offers, prices, evaluations, alerts, search_queries). Enable WAL mode.
2. **Build the DB tool server** — implement as an MCP server. Start with core operations needed for Phase 3: create_hunt, list_hunts, get_hunt_summary, record_offer, record_evaluation, get_previous_evaluation, record_price, get_aggregate_prices, record_alert, record_user_response. Add remaining operations iteratively.
3. **Connect to NanoClaw** — register the MCP server in NanoClaw's config. Verify the agent can call tools from conversation.

### Done when
- Agent can create, query, and update hunts via conversation
- Evaluations and price data persist in the DB across sessions

---

## Phase 3: Skills & Reference Docs

**Goal:** Agent has its deal-hunting personality, skills, and reference doc structure.

### Steps

1. **Deploy CLAUDE.md** — use the template from the skills architecture doc
2. **Deploy all five skills** — requirements-discovery, price-baselining, listing-evaluation, hunt-management, documentation. Use definitions from the skills architecture doc.
3. **Create reference doc structure** — empty homelab-inventory.md, empty preferences.md, populated ebay-uk-guide.md (VAT rules, marketplace ID, cost calculation), empty product-knowledge/ directory.
4. **Test the conversational flow** — have a real conversation about needing a Proxmox node. Verify requirements-discovery engages naturally, hunt-management creates a hunt in the DB, documentation records setup info.

### Done when
- Agent responds in character
- A test hunt has been created through natural conversation
- Reference docs are being populated through use

---

## Phase 4: eBay Integration

**Goal:** Agent can search eBay and fetch historical sold prices.

### Steps

1. **eBay developer account** — user registers at developer.ebay.com, creates an application, provides Client ID and Client Secret. Walk them through it.
2. **Deploy eBay Browse API access** — configure credentials, set marketplace to EBAY_GB, verify search works including auction listings (buyingOptions filter).
3. **Build the Sold Data Tool** — separate MCP server. Scrapes eBay UK sold listings page. Parses title, sold price, shipping, condition, date. Proper headers, rate limiting, graceful failure. Connect to NanoClaw.
4. **Test price-baselining** — run the skill for the Proxmox node hunt. Verify sold data returns, agent synthesises a baseline, data written to DB.
5. **Test listing evaluation** — trigger an eBay search, verify agent evaluates results against criteria and baseline, evaluations recorded in DB, interesting finds generate alerts.

### Done when
- Agent can search eBay UK and evaluate listings
- Historical sold prices are available via the sold data tool
- Price baselines exist in the DB
- Alerts are well-formatted and useful

---

## Phase 5: Watcher Service

**Goal:** Autonomous background monitoring running independently of the agent.

### Steps

1. **Build the watcher core** — scheduler reads hunt cadences from DB, manages search polls and watch polls, runs as independent process (systemd service).
2. **Implement eBay source adapter** — SearchAdapter (Browse API search) and WatchAdapter (individual item state fetch) behind common interface.
3. **Implement change detector** — compares new observations vs DB state. Detects price changes, offer removed, auction ending soon, watch conditions met, new offers.
4. **Implement agent notifier** — routine (write to DB) and urgent (trigger agent invocation via NanoClaw IPC). Determine the right IPC mechanism by inspecting NanoClaw's architecture.
5. **Deploy and test** — start as service, verify search polls fire on cadence, new offers appear in DB, agent picks them up, watch polling detects changes, urgent notifications invoke agent promptly.

### Done when
- Watcher runs independently on a schedule
- New listings recorded and associated with hunts automatically
- Price changes on watched offers detected
- Agent notified via both priority paths

---

## Phase 6: End-to-End Testing & Refinement

**Goal:** Full system working together reliably with a real hunt.

### Steps

1. **Run a real hunt** — start the Proxmox node hunt, let watcher run for 24-48 hours, review what comes back.
2. **Tune evaluation logic** — adjust skill language based on alert quality. Too many irrelevant results? Too few? Adjust search terms, criteria, preferences.
3. **Tune notification cadence** — is the agent invoked too often? Are urgent notifications fast enough? Is the digest useful?
4. **Test feedback loop** — respond to alerts with various feedback, verify agent adjusts subsequent evaluations, preferences.md updated.
5. **Test cross-session continuity** — leave system running for days, come back and ask "what's the market looking like?", verify useful summary from DB.
6. **Test hunt lifecycle** — pause, resume, close a hunt. Verify watcher responds correctly.

### Done when
- Real hunt running for multiple days with useful alerts
- Feedback loop working
- Cross-session memory reliable
- User is happy with the experience

---

## Phase 7: Polish & Second Channel

**Goal:** Multi-channel access and hardening.

### Steps

1. **Add second messaging channel** — Telegram if started with Slack, or vice versa. Verify consistent context across channels.
2. **Refine alert formatting** — tune for mobile readability based on real usage.
3. **Harden the watcher** — restart/recovery logic, graceful error handling for eBay API issues, basic monitoring.
4. **Document the setup** — record what was done, what config was needed, for reproducibility.

---

## Future Work (Post-MVP)

- Additional watcher source adapters (Amazon, generic web, CEX)
- Sold data tool for non-eBay marketplaces
- Cross-hunt offer awareness in listing-evaluation skill
- Autonomous bidding with user-defined limits
- Full-text search across evaluations for AS-7

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Docker-in-LXC issues on Proxmox | Check nesting config early. Fall back to privileged LXC if needed. |
| Claude Max auth doesn't work with NanoClaw | Deploy CLIProxyAPI as fallback. |
| eBay sold listings scraper breaks | Fail gracefully. Organic observation data still builds. SerpAPI free tier as backup. |
| eBay Browse API rate limits | Monitor usage. Adjust polling cadence. 1000 req/day is generous for a few hunts. |
| CLAUDE.md grows too large | Keep under 200 lines. Move detail to reference docs. |
| SQLite contention between watcher and tool server | WAL mode. Short write transactions. |

---

## Handover Notes for Deploying Agent

- **Inspect before acting.** Check LXC 103 state, network, storage before deploying anything.
- **Ask the user** which messaging channel to start with.
- **Ask the user** to complete Claude Max OAuth flow interactively.
- **Ask the user** to create eBay developer account and provide credentials.
- **Build incrementally.** Complete each phase and verify before starting the next.
- **The PRD is the source of truth** for what this system should do. The architecture docs describe how.
- **Skills will need iteration.** The initial SKILL.md files are starting points — expect to refine during Phase 6.
