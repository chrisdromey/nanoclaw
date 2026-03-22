# Deal Hunter Agent — System Architecture

## Reference Documents

- `deal-hunter-prd.md` — User-facing stories and acceptance criteria
- `deal-hunter-agent-requirements.md` — Agent efficiency and memory requirements
- `deal-hunter-implementation-plan.md` — Deployment plan (to be revised to align with this architecture)
- `deal-hunter-skills-architecture.md` — Earlier skills draft (superseded by this document)

---

## System Overview

The Deal Hunter Agent is composed of three main components that collaborate through a shared database:

1. **The Agent** — a NanoClaw-hosted Claude agent that converses with the user, reasons about requirements and value, makes evaluation decisions, and manages hunts. This is the intelligence layer.

2. **The Watcher Service** — a lightweight, independently running service that polls sources for search results and monitors watched offers. This is the observation layer. It does not reason or evaluate — it fetches, records, and detects changes.

3. **The Database & Tool Layer** — a SQLite database with an MCP tool server that provides the agent with structured operations. Both the agent and the watcher read from and write to the same database. The MCP tool server is the agent's interface; the watcher accesses the DB directly.

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
└────────────┬─────────────┘
             │ MCP
┌────────────▼─────────────┐         ┌──────────────────────┐
│    DB Tool Server         │         │   Watcher Service     │
│    (MCP interface)        │         │                       │
│                           │         │  Search Polling        │
│  Hunt ops                 │         │  Watch Polling         │
│  Offer ops                │         │  Change Detection      │
│  Evaluation ops           │         │  Agent Notification    │
│  Price ops                │         │                       │
│  Alert ops                │         │  ┌─────────────────┐  │
│  Search query ops         │         │  │ Source Adapters  │  │
│  Summary/query ops        │         │  │  ├─ eBay         │  │
│                           │         │  │  ├─ (Amazon)     │  │
└────────────┬─────────────┘         │  │  ├─ (Web)        │  │
             │                        │  │  └─ ...          │  │
┌────────────▼─────────────┐         │  └─────────────────┘  │
│                           │◄────────┤                       │
│     SQLite Database       │         └───────────┬───────────┘
│                           │                     │
└───────────────────────────┘                     │
                                                  │ Urgent: trigger
                                                  │ agent invocation
                                                  ▼
                                          ┌──────────────┐
                                          │  NanoClaw IPC │
                                          └──────────────┘
```

---

## Component 1: Database

### Purpose

Persistent, queryable storage for all transactional data. Provides the agent with cross-session memory, market intelligence, and efficient session startup. Provides the watcher with watch lists and a place to record observations.

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

---

## Component 4: Agent (Skills & Reference Docs)

### Purpose

The intelligence layer. Converses with the user, reasons about requirements, evaluates offers, manages hunts, and learns from feedback. Runs within NanoClaw as a Claude agent with access to the DB tool server (MCP), reference documents, and skills.

### CLAUDE.md

Lean context document (under 200 lines) loaded every session. Contains:
- Agent identity and role
- Summary of user context (with pointer to detailed inventory doc)
- User's location and cost calculation rules
- Pointers to reference files and skills
- Instructions for scheduled task behaviour
- Rules for using the DB tool server

### Skills

Focused, composable skills loaded on demand:

**requirements-discovery** — Guides conversational requirement gathering. Reads user inventory from reference docs. Proposes constraints iteratively with reasoning. Hands off to hunt-management when criteria are agreed.

**price-baselining** — Researches market pricing for a product category. Uses both the DB tool (historical observations) and web research (sold listings, retailer prices, forums). Writes structured baseline data via the DB tool. Defines value tiers (exceptional / good / fair / overpriced).

**listing-evaluation** — Evaluates offers against hunt criteria and price baselines. Reads hunt criteria, price data, and user feedback history from DB. Calculates true landed cost. Makes alert/skip/watch decisions. Records evaluations and triggers alerts via DB tool.

**hunt-management** — Creates, updates, pauses, and closes hunts via DB tool. Defines search terms broadly (requirements-level, not product-specific). Manages hunt dependencies. Handles lifecycle transitions.

**documentation** — Records and maintains knowledge in reference markdown files. Updates user inventory after purchases or changes. Creates and maintains product knowledge guides. Keeps reference material structured and dated.

### Reference Documents (Markdown)

Stored in the agent's workspace, loaded into context on demand via @imports:

- **homelab-inventory.md** — User's current hardware, networking, available spares. Built organically through conversation. Updated by the documentation skill.

- **product-knowledge/[product].md** — Per-product-family guides. Generations, compatibility, known issues, Proxmox-specific notes. Created during research, updated over time.

- **preferences.md** — Learned user preferences that are better expressed as prose than structured data. General buying preferences, communication preferences, value judgements that don't fit neatly into JSON fields.

- **ebay-uk-guide.md** — eBay Browse API specifics, UK VAT rules, import duty calculation, marketplace configuration. Operational reference for the agent.

### Relationship Between Skills and DB Tool

Skills define **how** the agent thinks and works. The DB tool provides **what** the agent knows and remembers. A skill might say "check if you've evaluated this offer before" — the DB tool is how it actually does that check. Skills should reference DB tool operations by name so the agent knows which tool call to make.

---

## Data Flow: Key Scenarios

### New Hunt Setup

```
User: "I'm thinking about upgrading my Proxmox nodes"
  → Agent loads CLAUDE.md, reads @homelab-inventory.md
  → Agent uses requirements-discovery skill
  → Conversation iterates on criteria
  → Agent uses hunt-management skill
  → DB Tool: create_hunt (writes to hunts table)
  → Agent uses price-baselining skill
  → DB Tool: get_aggregate_prices (checks existing data)
  → Agent does web research for sold prices, writes via DB Tool
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
    → Agent loads hunt summary via DB Tool
    → Agent sees pending new offers
    → Agent uses listing-evaluation skill
    → Agent evaluates each new offer against criteria and baselines
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
  → Agent loads offer history and previous evaluation from DB
  → Agent reassesses with new price
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
  → Agent might suggest strategy adjustment if prices are trending
```

### User Responds to Alert

```
User: "That's a bit pricey for an HP, I'd want it under £120"
  → Agent records user response via DB Tool
  → Agent extracts feedback: "HP EliteDesk price ceiling is £120"
  → Agent updates preferences.md
  → Agent adjusts evaluation criteria for future HP listings
  → Next time an HP appears, listing-evaluation skill factors in this feedback
```

---

## Deployment Topology

All components run on **LXC 103 (pve4)**:

- **NanoClaw** — Node.js process, manages the agent lifecycle and messaging channels
- **DB Tool Server** — MCP server process, connected to NanoClaw as an MCP server
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
