# Deal Hunter Agent — Implementation Plan & Architecture

## Reference

- **PRD:** See `deal-hunter-prd.md` for full user stories and acceptance criteria.
- **Target LXC:** Container 103 on pve4 (already provisioned, nothing deployed yet).

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    User Interaction Layer                     │
│              Slack / Telegram / WhatsApp / etc.               │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                     NanoClaw (LXC 103)                       │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Orchestrator │  │  Task        │  │  Group Queue &     │  │
│  │  (index.ts)   │  │  Scheduler   │  │  Concurrency Ctrl  │  │
│  └──────┬────────┘  └──────┬───────┘  └────────────────────┘  │
│         │                  │                                  │
│  ┌──────▼──────────────────▼───────────────────────────────┐ │
│  │              Agent Containers (Docker)                    │ │
│  │                                                          │ │
│  │  ┌─────────────────┐  ┌──────────────────────────────┐  │ │
│  │  │  CLAUDE.md       │  │  Skills (Markdown)            │  │ │
│  │  │  (Memory/Context)│  │  - deal-hunter.md             │  │ │
│  │  │                  │  │  - market-evaluator.md         │  │ │
│  │  └─────────────────┘  └──────────────────────────────┘  │ │
│  │                                                          │ │
│  │  ┌──────────────────────────────────────────────────┐   │ │
│  │  │  Mounted Data (persistent across sessions)        │   │ │
│  │  │  - hunts.json (active hunt criteria)              │   │ │
│  │  │  - seen-listings.json (dedup)                     │   │ │
│  │  │  - price-history.json (market tracking)           │   │ │
│  │  │  - preferences.json (learned user prefs)          │   │ │
│  │  └──────────────────────────────────────────────────┘   │ │
│  └──────────────────────────────────────────────────────────┘ │
│                          │                                    │
│              MCP Servers │                                    │
│         ┌────────────────┼──────────────────┐                │
│         ▼                ▼                  ▼                │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────────┐      │
│  │ eBay Browse │  │ Web Search  │  │ Future: other    │      │
│  │ API MCP     │  │ MCP         │  │ marketplaces     │      │
│  └────────────┘  └─────────────┘  └──────────────────┘      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  CLIProxyAPI (or direct Claude Code auth)             │    │
│  │  Exposes Max subscription as OpenAI-compatible API    │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. NanoClaw

The agent runtime. Handles messaging channel connections, message routing, task scheduling, container isolation, and the agent loop.

**Deployment:** Fork the NanoClaw repo, deploy to LXC 103. Docker must be available inside the LXC for agent container isolation (Docker-in-LXC or configure as appropriate for the existing Proxmox setup).

**Key decisions for the deploying agent:**
- Assess whether LXC 103 has Docker available or needs it installed. NanoClaw requires Docker for agent container sandboxing.
- Determine the Node.js version available (needs 20+).
- Check network connectivity from LXC 103 — needs outbound HTTPS to eBay API, Anthropic API, and the chosen messaging platform.

### 2. CLIProxyAPI

Proxies the Claude Max subscription as an OpenAI-compatible API endpoint.

**Note:** NanoClaw uses the Claude Agent SDK / Claude Code directly, which supports Max subscription auth natively via `claude login`. CLIProxyAPI may not be strictly necessary if NanoClaw's built-in auth works with Max. The deploying agent should:

- First attempt: authenticate NanoClaw directly with `claude login` using the Max subscription. This is the simplest path.
- Fallback: if direct auth doesn't work cleanly or if we want model routing control (e.g. Sonnet for polling, Opus for evaluation), deploy CLIProxyAPI as a separate process/container and point NanoClaw at it.

**CLIProxyAPI details if needed:**
- Single Go binary, no dependencies.
- Docker image available.
- Authenticates via browser OAuth flow (one-time).
- Exposes `/v1/chat/completions` on a configurable port.
- Can run as a systemd service.
- Repo: `https://github.com/router-for-me/CLIProxyAPI`

### 3. eBay Browse API MCP Server

Gives the agent the ability to search eBay listings programmatically.

**Options (in preference order):**

1. **CooKey-Monster/EbayMcpServer** — lightweight Python MCP server specifically for fetching auctions. Simple, focused on the buyer/search use case. Requires eBay developer API credentials (free to obtain).
   - Repo: `https://github.com/CooKey-Monster/EbayMcpServer`
   - Install: `uv pip install git+https://github.com/CooKey-Monster/EbayMcpServer.git`

2. **eBay official MCP** (`@ebay/npm-public-api-mcp`) — broader API coverage, npm-based.
   - Repo: `https://github.com/eBay/npm-public-api-mcp`
   - Install: `npx @ebay/npm-public-api-mcp@latest`

3. **Custom lightweight MCP server** — if neither of the above fits well, write a minimal MCP server that wraps the eBay Browse API `/buy/browse/v1/item_summary/search` endpoint directly.

**eBay API setup required:**
- Create an eBay developer account at `developer.ebay.com`.
- Create an application to get Client ID and Client Secret.
- Use client credentials grant for buyer-side Browse API access (no user auth needed, 1000 requests/day free).
- Set marketplace header to `EBAY_GB` for UK listings.

**Important Browse API notes:**
- Only BIN (Buy It Now) listings are returned by default. Must add `buyingOptions` filter to include `AUCTION` listings.
- Max 10,000 items per search.
- The old Finding API was decommissioned Feb 2025 — Browse API is the only current option.

### 4. Messaging Channel

NanoClaw supports Slack, Telegram, Discord, WhatsApp, Gmail out of the box via skills.

**Decision for the deploying agent:** Ask me which channel I want to start with. Slack is probably simplest for desk use, Telegram for mobile. Both can run simultaneously.

### 5. Persistent Data Store

NanoClaw's native memory is CLAUDE.md per group — good for context and instructions but not ideal for structured data like listing histories.

**Recommended approach:**
- Use CLAUDE.md for: homelab inventory, agent personality/instructions, current hunt summaries, user preferences.
- Use JSON files in the agent's mounted workspace for: active hunt criteria, seen listing IDs (dedup), price history, alert history.
- If data volume grows, add an SQLite MCP server for structured queries across price history.

---

## Skill & Memory Design

### CLAUDE.md (Global / Deal Hunter Group)

This is the persistent context the agent loads every session. It should contain:

```markdown
# Deal Hunter Agent

## Role
You are a personal procurement advisor. You help the user find good-value
deals on items they need. You are conversational, proactive, and opinionated
about value. You never purchase anything — you find, evaluate, and recommend.

## User Context
<!-- This section builds up organically through conversation -->
<!-- The agent updates this as it learns about the user's setup -->

### Homelab
- [To be populated through conversation]

### Location
- UK based
- All prices should factor in shipping to UK, import duty where applicable,
  and 20% VAT on imports from outside the UK

### Preferences
- [To be populated through conversation and feedback]

## Active Hunts
<!-- Structured reference to hunts.json — agent reads the file for full detail -->
See hunts.json for current active hunts and criteria.

## How I Work

### Searching
- I use the eBay Browse API via MCP to search for listings
- I set marketplace to EBAY_GB for UK listings
- I include both AUCTION and FIXED_PRICE buying options
- I also monitor US/EU listings but always calculate true landed cost (item + shipping + import duty + VAT)
- I search broadly, not just for specific product names — I think at the requirements level

### Evaluating Listings
- I check against hunt criteria but I also use judgement
- A listing below spec but at exceptional value is worth flagging (e.g. 9th gen at £80 when 10th gen is £280+)
- I look for combinations across listings (barebone + component deals)
- I track market pricing in price-history.json to know what "good value" means
- I calculate total cost including shipping, tax, and import duty

### Alerting
- Auction ending within 2 hours + good value = immediate alert
- BIN at exceptional price = immediate alert
- Interesting stable listings = batch into daily digest
- No results over sustained period = proactively suggest strategy changes

### Feedback
- When the user responds to an alert, I update my understanding of their preferences
- "Not quite" / "too expensive" / "more like that" all adjust my internal model
- I record feedback in preferences.json

### Scheduled Tasks
- I run periodic searches against all active hunts
- Default cadence: every 30 minutes for active hunts, every 2 hours for passive/watching hunts
- I deduplicate against seen-listings.json so I never alert on the same listing twice
```

### Deal Hunter Skill (SKILL.md)

A skill file that teaches the agent the deal-hunting workflow. Placed in the NanoClaw fork's skills directory.

```markdown
# Deal Hunter Skill

## When to use
When the user discusses purchasing needs, upgrade plans, or asks about deals,
pricing, or market conditions for any category of item.

## Workflow: New Hunt

1. Listen to the user's need — it may be vague ("thinking about upgrading my nodes")
2. Use knowledge from CLAUDE.md User Context to understand what they're referring to
3. Propose requirements one at a time with reasoning — let the user validate each
4. Once criteria are agreed, write them to hunts.json as a structured hunt
5. Set up scheduled tasks for periodic searching
6. Confirm to the user what you're now watching for

## Workflow: Scheduled Search

1. Read active hunts from hunts.json
2. For each hunt, construct appropriate eBay Browse API queries
3. Search with broad terms — don't just search for one product name
4. Filter results against seen-listings.json for dedup
5. For new listings, evaluate:
   - Does it match hunt criteria directly?
   - Does it partially match but at exceptional value?
   - Could it combine with other listings to meet the need?
   - What is the true landed cost (item + shipping + duty + VAT)?
   - How does the price compare to market norms in price-history.json?
   - How time-sensitive is it (auction ending soon vs stable BIN)?
6. Record all new listings in seen-listings.json
7. Update price-history.json with pricing data points
8. Alert the user for anything worth their attention, with full context
9. If nothing found and hunt has been underperforming, consider strategy adjustment

## Workflow: Strategy Adjustment

1. If a hunt hasn't produced good results over 3+ days, proactively message the user
2. Analyse why — prices too high? Supply too low? Criteria too narrow?
3. Present alternatives you've already been researching in the background
4. Let the user decide whether to adjust criteria or wait

## Data Structures

### hunts.json
{
  "hunts": [
    {
      "id": "hunt-001",
      "name": "Proxmox Node Upgrade",
      "status": "active",
      "created": "2026-03-22",
      "criteria": {
        "must_have": ["DDR4 support", "10th gen Intel or AMD equivalent minimum"],
        "nice_to_have": ["PCIe slot for 10GbE NIC", "1L form factor"],
        "budget": { "target": 150, "max": 300, "currency": "GBP" },
        "flex_rules": [
          "9th gen acceptable if price is under £100",
          "No PCIe slot acceptable if price is under £80"
        ]
      },
      "search_terms": [
        "Lenovo M90Q", "Lenovo ThinkCentre Tiny DDR4",
        "HP EliteDesk Mini DDR4", "HP ProDesk Mini DDR4",
        "Dell OptiPlex Micro DDR4", "mini PC DDR4 i7 10th",
        "mini PC DDR4 i5 10th"
      ],
      "cadence": "30m",
      "dependencies": ["hunt-002"]
    },
    {
      "id": "hunt-002",
      "name": "10GbE SFP+ NIC",
      "status": "passive",
      "criteria": { ... },
      "notes": "Only relevant if hunt-001 result has PCIe slot"
    }
  ]
}

### seen-listings.json
Array of listing IDs with timestamp and hunt association. Prune entries older than 30 days.

### price-history.json
Keyed by product category/search term. Array of {date, price, condition, source, listing_id}.
Used to calculate market norms and identify outliers.

### preferences.json
Learned user preferences from feedback. e.g. "prefers Lenovo over HP", "won't pay over £20 shipping", "doesn't want refurbished with no returns".
```

---

## Implementation Phases

### Phase 1: Foundation

1. **Deploy NanoClaw to LXC 103**
   - Fork NanoClaw repo
   - Ensure Docker is available in the LXC
   - Run `/setup` via Claude Code
   - Authenticate with Claude Max subscription (`claude login`)
   - Verify the agent starts and responds

2. **Connect a messaging channel**
   - Start with one channel (likely Slack or Telegram)
   - Run the appropriate `/add-slack` or `/add-telegram` skill
   - Verify two-way communication works

3. **Set up CLIProxyAPI (if needed)**
   - Only if direct Max auth doesn't work with NanoClaw
   - Deploy as a container or systemd service on LXC 103
   - Authenticate and verify the health endpoint

### Phase 2: eBay Integration

4. **Create eBay developer account and credentials**
   - Register at developer.ebay.com
   - Create an application
   - Obtain Client ID and Client Secret

5. **Deploy eBay MCP server**
   - Start with CooKey-Monster/EbayMcpServer or the official eBay MCP
   - Configure with eBay credentials
   - Wire into NanoClaw's MCP server configuration
   - Test: verify the agent can search eBay from a chat message

6. **Write the CLAUDE.md and skill files**
   - Create the deal hunter group in NanoClaw
   - Populate the CLAUDE.md with the template above
   - Add the deal-hunter skill
   - Test: have a conversation about needing a Proxmox node and verify the agent proposes requirements

### Phase 3: Scheduled Hunting

7. **Set up the data persistence layer**
   - Create the JSON file structure in the agent's mounted workspace
   - Seed hunts.json with the Proxmox node hunt as the first test case

8. **Configure scheduled tasks**
   - Set up a recurring task for eBay polling (start with every 30 mins)
   - Verify the agent searches, deduplicates, and evaluates listings
   - Verify alerts come through on the messaging channel

9. **Test the feedback loop**
   - Respond to alerts with various feedback
   - Verify the agent adjusts its behaviour

### Phase 4: Refinement

10. **Tune the evaluation logic**
    - Adjust the skill/CLAUDE.md based on quality of alerts
    - Add market pricing tracking
    - Tune alert urgency and digest batching

11. **Add additional search sources**
    - Web search MCP for HotUKDeals, other forums
    - Additional marketplace APIs as needed

12. **Add second messaging channel**
    - So you can respond from mobile as well as desk

---

## Cost Considerations

- **Claude Max subscription:** £/$ fixed monthly — covers all agent invocations.
- **eBay API:** Free tier gives 1,000 requests/day on client credentials. At 30-min cadence with ~5 search queries per hunt, that's ~240 requests/day for one hunt. Comfortably within free tier for a few concurrent hunts.
- **Infrastructure:** LXC 103 already provisioned. Minimal resource footprint — NanoClaw is a single Node.js process + lightweight Docker containers per session.

## Risks & Considerations

- **Claude Max ToS:** Using the subscription via proxy/CLI for automated tasks is in a grey area. Keep volume reasonable for personal use.
- **eBay rate limits:** Monitor usage. If adding many hunts or very frequent polling, may need to upgrade to eBay user token auth (10k-50k requests/day).
- **CLAUDE.md bloat:** Keep the persistent context lean. Move structured data to JSON files, not into the memory document. Aim for under 200 lines in CLAUDE.md.
- **Scheduled task cost:** Every scheduled task invocation runs Claude. At 30-min cadence, that's 48 invocations/day per hunt. Most will be short (search + evaluate + no alert), but be aware of the token consumption against Max limits.
- **Docker-in-LXC:** This can be fiddly on Proxmox depending on LXC configuration (privileged vs unprivileged, nesting enabled, etc.). The deploying agent should check and configure as needed.

---

## Handover Notes for Deploying Agent

This plan is being handed to an agent with full access to the Proxmox environment and LXC 103. Key things to be aware of:

- **Do not assume the network layout, storage configuration, or existing services.** Inspect the LXC and the broader Proxmox environment before making changes.
- **LXC 103 on pve4** is the target. Check what OS is running, what's already installed, and whether Docker/nesting is enabled.
- **Ask the user** which messaging channel they want to start with before configuring one.
- **Ask the user** for their Claude Max login credentials flow — they'll need to complete the browser OAuth interactively.
- **Ask the user** to create the eBay developer account and provide credentials, or walk them through it.
- **Start with Phase 1** and validate each step before moving on. Don't try to do everything at once.
- **The PRD is the source of truth** for what this agent should do. The skill files and CLAUDE.md templates above are starting points — they will evolve through use.
