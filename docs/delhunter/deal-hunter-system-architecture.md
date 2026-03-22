# Deal Hunter Agent — System Architecture

## Reference Documents

- `deal-hunter-prd.md` — User-facing stories and acceptance criteria
- `deal-hunter-agent-requirements.md` — Agent efficiency and memory requirements
- `deal-hunter-skills-architecture.md` — Skills, reference docs, and CLAUDE.md design
- `deal-hunter-implementation-plan.md` — Deployment plan (to be revised to align with this architecture)

---

## System Overview

The Deal Hunter Agent is composed of four main components that collaborate through a shared database:

1. **The Agent** — a NanoClaw-hosted Claude agent that converses with the user, reasons about requirements and value, makes evaluation decisions, and manages hunts. This is the intelligence layer.

2. **The Watcher Service** — a lightweight, independently running service that polls sources for search results and monitors watched offers. This is the observation layer. It does not reason or evaluate — it fetches, records, and detects changes.

3. **The Database & Tool Layer** — a SQLite database with an MCP tool server that provides the agent with structured operations. Both the agent and the watcher read from and write to the same database. The MCP tool server is the agent's interface; the watcher accesses the DB directly.

4. **The Sold Data Tool** — an MCP server that fetches historical sold/completed listing data on demand. Used by the agent during price baselining. This is a research tool, not a monitoring tool.

Additionally, the agent has access to **markdown reference files** for unstructured knowledge (user inventory, product guides, preferences) that don't belong in a relational database.

```
┌──────────────────────────┐
│         User              │
│   (Slack / Telegram)      │
└────────────┬─────────────┘
             │
┌────────────▼─────────────┐
│        Agent              │
│      (NanoClaw)           │
│                           │
│  Skills    Reference Docs │
│  CLAUDE.md                │
└──────┬─────────┬─────────┘
       │ MCP     │ MCP
       ▼         ▼
┌────────────┐ ┌──────────────┐     ┌──────────────────────┐
│ DB Tool    │ │ Sold Data    │     │   Watcher Service     │
│ Server     │ │ Tool         │     │                       │
│            │ │              │     │  Search Polling        │
│ Hunt ops   │ │ Sold price   │     │  Watch Polling         │
│ Offer ops  │ │ research     │     │  Change Detection      │
│ Eval ops   │ │ (eBay UK     │     │  Agent Notification    │
│ Price ops  │ │  scraper)    │     │                       │
│ Alert ops  │ │              │     │  ┌─────────────────┐  │
│ Search ops │ └──────────────┘     │  │ Source Adapters  │  │
│ Summary ops│                      │  │  ├─ eBay         │  │
│            │                      │  │  ├─ (Amazon)     │  │
└─────┬──────┘                      │  │  ├─ (Web)        │  │
      │                             │  │  └─ ...          │  │
┌─────▼────────────────┐           │  └─────────────────┘  │
│                      │◄──────────┤                       │
│   SQLite Database    │           └───────────┬───────────┘
│                      │                       │
└──────────────────────┘                       │ Urgent: trigger
                                               │ agent invocation
                                               ▼
                                        ┌──────────────┐
                                        │  NanoClaw IPC │
                                        └──────────────┘
```

---

## Component 1: Database

### Purpose

Persistent, queryable storage for all transactional data. Provides the agent with cross-session memory, market intelligence, and efficient session startup (AS-6). Provides the watcher with watch lists and a place to record observations.

### Schema

**hunts**
| Column | Description |
|--------|-------------|
| id | Primary key |
| name | Human-readable hunt name |
| status | active / paused / closed |
| criteria | JSON — must-haves, nice-to-haves, budget, flex rules |
| search_terms | JSON — array of search query strings |
| cadence_minutes | How often the watcher should run searches |
| created_at | Timestamp |
| closed_at | Nullable timestamp |
| close_reason | Nullable — bought / changed mind / etc. |

**offers**
| Column | Description |
|--------|-------------|
| id | Primary key |
| source | ebay / amazon / cex / web / etc. |
| source_id | Listing ID, ASIN, URL — unique within source |
| title | Offer title |
| url | Direct link to the offer |
| seller | Seller name or retailer |
| seller_rating | Nullable — percentage or score |
| condition | new / used / refurbished / etc. |
| specs_extracted | JSON — CPU, RAM type, form factor, etc. |
| buying_format | Nullable — auction / BIN / retail |
| auction_end_time | Nullable — eBay auctions only |
| bid_count | Nullable — eBay auctions only |
| watching | Boolean — agent has flagged for monitoring |
| watch_conditions | Nullable JSON — e.g. {"alert_if_price_below_gbp": 150} |
| status | active / ended / removed / sold |
| first_seen_at | Timestamp |
| last_seen_at | Timestamp |

Unique constraint on (source, source_id).

**hunt_offers**
| Column | Description |
|--------|-------------|
| hunt_id | FK to hunts |
| offer_id | FK to offers |
| search_query_id | FK to search_queries — which search found it |
| status | new / evaluated / watching / dismissed |
| first_associated_at | Timestamp |

Composite primary key on (hunt_id, offer_id).

**prices**
| Column | Description |
|--------|-------------|
| id | Primary key |
| offer_id | FK to offers |
| price | Observed price in source currency |
| shipping | Shipping cost in source currency |
| currency | Source currency code |
| total_landed_gbp | Calculated total including shipping, duty, VAT |
| observed_at | Timestamp |

**evaluations**
| Column | Description |
|--------|-------------|
| id | Primary key |
| offer_id | FK to offers |
| hunt_id | FK to hunts |
| decision | alert / skip / watch |
| reasoning | Text — agent's assessment summary |
| evaluated_at | Timestamp |

**alerts**
| Column | Description |
|--------|-------------|
| id | Primary key |
| offer_id | FK to offers |
| hunt_id | FK to hunts |
| urgency | high / medium / low |
| message_sent | Text — what was sent to the user |
| alerted_at | Timestamp |
| user_response | Nullable text |
| feedback_extracted | Nullable text |
| responded_at | Nullable timestamp |

**search_queries**
| Column | Description |
|--------|-------------|
| id | Primary key |
| hunt_id | FK to hunts |
| source | ebay / amazon / etc. |
| terms | Search terms used |
| result_count | Total results returned |
| new_offer_count | Results not previously seen |
| relevant_count | Results that passed initial filter |
| searched_at | Timestamp |

---

## Component 2: DB Tool Server (MCP)

### Purpose

The agent's interface to the database. Exposes meaningful operations that handle relational integrity, so the agent never writes raw SQL. Exposed as an MCP server that NanoClaw connects to the agent.

### Operation Groups

**Hunt operations**
- Create hunt (with criteria, search terms, cadence)
- Update hunt criteria or search terms
- Pause / resume hunt
- Close hunt (cascades: cancels watches, updates statuses, retains history)
- List active hunts (lightweight summary)
- Get hunt detail (full criteria and current state)

**Offer operations**
- Record new offer (upsert on source + source_id)
- Update offer state (status, watching flag, watch conditions)
- Get offer by ID or by source + source_id
- Get offer with full history (all prices, evaluations, alerts)
- Search offers by attributes (source, condition, spec fields, price range)

**Hunt-offer operations**
- Associate offer with hunt (via search query)
- Get new/unevaluated offers for a hunt
- Get watched offers for a hunt
- Update hunt-offer status

**Evaluation operations**
- Record evaluation (writes evaluation + updates hunt_offer status)
- Get previous evaluation for offer + hunt
- Get evaluations matching criteria (for AS-8 — similar item feedback lookup)

**Price operations**
- Record price observation
- Get price history for an offer
- Get aggregate price stats for a hunt or product category (median, range, trend)
- Get price changes since last check (for change detection summary)

**Alert operations**
- Record alert sent
- Record user response and extracted feedback
- Get recent alerts for a hunt
- Get user feedback history filtered by product type / price range

**Search query operations**
- Record search execution and results
- Get query effectiveness stats for a hunt (AS-10)

**Summary operations**
- Get hunt state summary (AS-6 — active watches, recent changes, pending items, counts)
- Get market overview for a product category (AS-5)
- Search past evaluations by text description (AS-7 — cross-session recall)

### Design Notes

- Operations should be coarse-grained where possible — one tool call should accomplish one meaningful agent action, even if it touches multiple tables.
- The tool server handles all calculated fields (e.g. total_landed_gbp from price + shipping + duty + VAT).
- Error handling and validation live in the tool server, not in the agent's reasoning.

---

## Component 3: Watcher Service

### Purpose

Independently running service that performs the repetitive, non-intelligent work of polling sources and monitoring offers. Operates without agent invocation. Writes observations to the database and notifies the agent when something needs its attention.

### Architecture

The watcher has four internal components:

**Scheduler** — manages timing for two types of jobs: search polls (driven by hunt cadence settings) and watch polls (checking on individually watched offers). Reads job definitions from the database.

**Source Adapters** — pluggable modules behind a common interface. Each adapter knows how to interact with a specific source. Not every adapter needs to support both search and watch operations.

Common interface (conceptual):
```
SearchAdapter:
  search(terms, filters) → [StandardisedOffer]

WatchAdapter:
  get_offer_state(source_id) → StandardisedOfferState
```

StandardisedOffer and StandardisedOfferState are source-agnostic data shapes that map to the offers and prices tables. Source-specific fields (auction_end_time, bid_count, etc.) are included where available.

MVP adapter: **eBay** (implements both search and watch via Browse API).

Future adapters: Amazon, generic web (watch only), CEX, etc. Adding a new source means implementing the adapter interface — no changes to the watcher core, change detector, or notification logic.

**Change Detector** — compares new observations against previous state in the database. Detects:
- Price decrease
- Price increase
- Offer removed / ended
- Auction entering final hours (configurable threshold)
- New offers matching a hunt's search queries
- Watch condition met (e.g. price dropped below threshold)

Change detection is source-agnostic — it operates on the standardised data in the database.

**Agent Notifier** — when the change detector identifies something that needs the agent's attention, it notifies the agent. Two priority levels:

- **Routine** — writes a pending notification record to the database. The agent picks these up on its next session (scheduled or user-initiated). Used for: new search results to evaluate, non-urgent price changes, periodic summaries.

- **Urgent** — triggers an immediate agent invocation via NanoClaw's IPC or messaging mechanism. Used for: watch conditions met on time-sensitive offers (e.g. auction ending soon at a good price), offer removed that was being actively watched.

The agent always makes the final decision about what to tell the user. The watcher never communicates with the user directly.

### What the Watcher Does NOT Do

- Evaluate whether an offer is a good deal (that's the agent's job)
- Communicate with the user
- Modify hunt criteria or search terms
- Make decisions about what's worth alerting on (beyond the mechanical watch conditions set by the agent)
- Research sold/completed listing prices (that's the sold data tool's job)

---

## Component 4: Sold Data Tool (MCP)

### Purpose

On-demand research tool that fetches historical sold/completed listing data from eBay. Used by the agent during price baselining to understand what items have actually sold for, as opposed to what they're currently listed at.

This is a research tool, not a monitoring tool. It is gated behind the price-baselining skill which provides the methodology for when to use it, what to search for, and how to interpret the results.

### How It Works

Scrapes eBay's publicly accessible sold listings pages (the same data a human sees when filtering by "Sold items" on eBay). Constructs the appropriate eBay UK URL with sold/completed filters, fetches the HTML with proper headers and rate limiting, parses out structured data.

### Interface

```
get_sold_prices(
  search_terms: string,
  marketplace: string,       // e.g. "ebay_gb"
  days_back: number,         // how far back (max ~90 days — eBay's limit)
  max_results: number
) → [SoldItem]

SoldItem:
  title: string
  sold_price: number
  shipping: number
  currency: string
  condition: string
  sold_date: timestamp
  url: string
```

### Design Notes

- Low volume by design — a few calls when a hunt starts, periodic refreshes. Not high-frequency.
- Proper headers and rate limiting — respectful scraper.
- Brittle by nature (HTML parsing) — fails gracefully when eBay changes their page structure.
- MVP: eBay UK only. Interface supports other marketplaces for future extension.

---

## Component 5: Agent (Skills & Reference Docs)

### Purpose

The intelligence layer. Converses with the user, reasons about requirements, evaluates offers, manages hunts, and learns from feedback. Runs within NanoClaw as a Claude agent with access to MCP tools, reference documents, and skills.

### Session & Memory Model

The agent operates in discrete sessions. Each session starts fresh. Cross-session continuity comes from three layers:

1. **CLAUDE.md** — loaded at the start of every session. Agent identity, role, user context summary, pointers to skills and reference docs. Lean — under 200 lines. Stable — doesn't change frequently.

2. **Session Memory** — Claude Code's automatic background system. Extracts summaries from conversations and recalls them in future sessions. Provides conversational continuity ("last time we discussed the HP being too expensive"). The agent doesn't manage this — it happens automatically.

3. **Database via MCP Tool** — the agent's structured long-term memory. On every session startup, the agent's first action should be to orient itself via the DB: query hunt summaries, check for pending notifications, review recent changes. This is the source of truth for all operational state.

The practical implication: the agent should always trust the DB over its session memory for operational decisions. Session memory gives the conversation a natural feel; the DB gives it accuracy.

### Skills & Reference Docs

See `deal-hunter-skills-architecture.md` for full detail on CLAUDE.md template, each skill's workflow and methodology, and reference document formats.

Skills: requirements-discovery, price-baselining, listing-evaluation, hunt-management, documentation.

Reference docs: homelab-inventory.md, product-knowledge/[product].md, preferences.md, ebay-uk-guide.md.

### Relationship Between Skills, MCP Tools, and Reference Docs

Skills define **how** the agent thinks and works (methodology, workflow, guardrails). MCP tools provide **what** the agent knows and can do (DB queries, sold price research). Reference docs provide **context** the agent needs (user setup, product knowledge, preferences). A skill might say "check if you've evaluated this offer before" — the DB tool is how it does that check. A skill might say "consider the user's DDR4 availability" — the inventory reference doc is where it finds that information.

---

## Data Flow: Key Scenarios

### New Hunt Setup

```
User: "I'm thinking about upgrading my Proxmox nodes"
  → Agent loads CLAUDE.md
  → Agent orients via DB Tool: any existing hunts? past evaluations?
  → Agent reads @homelab-inventory.md
  → Agent uses requirements-discovery skill
  → Conversation iterates on criteria
  → Agent uses hunt-management skill
  → DB Tool: create_hunt
  → Agent kicks off price-baselining as background sub-agent
    → Sub-agent uses price-baselining skill
    → Sub-agent calls Sold Data Tool for historical sold prices
    → Sub-agent calls DB Tool to record baseline data
    → Sub-agent does web research for current retailer prices
  → Watcher picks up new hunt on next scheduler cycle
  → Watcher begins search polling at configured cadence
```

### Watcher Finds New Listings

```
Watcher scheduler fires for hunt
  → Watcher reads hunt search terms from DB
  → eBay adapter runs Browse API searches
  → Watcher records new offers in DB (offers table)
  → Watcher records price observations (prices table)
  → Watcher associates offers with hunt (hunt_offers, status: new)
  → Watcher records search query stats (search_queries table)
  → Watcher writes routine notification: "12 new offers for hunt-001"
  → On agent's next session:
    → Agent orients via DB Tool: get_hunt_summary
    → Agent sees pending new offers
    → Agent uses listing-evaluation skill
    → DB Tool: get previous evaluations (AS-1 — skip already-seen)
    → Agent evaluates genuinely new offers against criteria and baselines
    → Agent records evaluations via DB Tool
    → Agent alerts user on interesting finds
    → Agent sets watch on borderline offers via DB Tool
```

### Watcher Detects Change on Watched Offer

```
Watcher watch-poll cycle fires
  → Watcher reads watched offers from DB
  → eBay adapter fetches current state for each
  → Watcher records new price observations
  → Change detector compares: price dropped £280 → £195
  → Watch condition check: agent set "alert if below £200"
  → Condition met + offer has auction ending in 3 hours
  → Watcher sends urgent notification to agent via NanoClaw IPC
  → Agent is invoked immediately
  → Agent orients via DB Tool: offer history, previous evaluation
  → Agent reassesses with new price using listing-evaluation skill
  → Agent alerts user with full context and reasoning
```

### User Asks About Market Conditions

```
User: "What's the market looking like for M90Qs right now?"
  → Agent loads CLAUDE.md
  → DB Tool: get_aggregate_prices (category: M90Q, last 30 days)
  → DB Tool: get_hunt_summary (for the relevant hunt)
  → Agent has: price trend, volume, recent evaluations, alert history
  → Agent responds conversationally with market overview
  → If baseline is stale, agent may trigger price-baselining refresh
```

### User Responds to Alert

```
User: "That's a bit pricey for an HP, I'd want it under £120"
  → Agent records user response via DB Tool (alert_history)
  → Agent extracts feedback: "HP EliteDesk price ceiling is £120"
  → Agent updates preferences.md via documentation skill
  → Next evaluation of an HP, listing-evaluation skill reads feedback from DB
```

---

## Deployment Topology

All components run on **LXC 103 (pve4)**:

- **NanoClaw** — Node.js process, manages the agent lifecycle and messaging channels
- **DB Tool Server** — MCP server process, connected to NanoClaw as an MCP server
- **Sold Data Tool** — MCP server process, connected to NanoClaw as an MCP server
- **SQLite Database** — single file on disk, accessed by both the DB tool server and the watcher
- **Watcher Service** — independent process with its own scheduler
- **CLIProxyAPI** — if needed for Claude Max subscription auth (may not be required if NanoClaw's native auth works)

The watcher and DB tool server both access the same SQLite file. SQLite handles concurrent reads well. For writes, WAL mode should be enabled to allow concurrent read/write access without blocking.

---

## MVP Scope

**In scope:**
- eBay UK as the sole source (one source adapter)
- Single messaging channel (Slack or Telegram)
- Full DB schema and tool server
- Watcher service with search polling and watch polling (eBay adapter only)
- Sold data tool (eBay UK scraper)
- All five agent skills
- Homelab hardware as the primary use case

**Out of scope for MVP:**
- Additional source adapters (Amazon, web, CEX)
- Multiple messaging channels simultaneously
- Autonomous bidding
- Multi-user support

**Designed for but not built in MVP:**
- Source adapter interface (ready for new adapters)
- Cross-hunt offer awareness (schema supports it, agent skills can be extended)
- Price baselining from non-eBay sources (skill describes it, tooling not built)
