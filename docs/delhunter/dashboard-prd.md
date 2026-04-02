# Deal Hunter Dashboard — Product Requirements Document

## Overview

A React-based web management interface for the Deal Hunter system. Provides real-time visibility into hunts, tracked searches, watched items, price baselines and trends, and agent performance. Allows the user to manage hunts, edit search parameters, and monitor the full system from a browser.

The dashboard reads from the same SQLite databases (`deal-hunter.db`, `nanoclaw.db`) used by the watcher service and agent, and writes back through the same schema for management operations. It runs as a standalone process alongside NanoClaw.

## Principles

- **Operational first** — the dashboard is a control panel, not a replacement for the conversational agent. It shows what the agent is doing, lets you tune it, and helps you debug when things go wrong.
- **Read-heavy, write-light** — most interactions are viewing state. Writes are limited to hunt management and search parameter editing.
- **Real-time where it matters** — watched items and agent activity stream live. Historical data refreshes on navigation.
- **Single user** — no auth system needed. Accessible on the local network or via tunnel.
- **Minimal footprint** — Vite + React + shadcn/ui. No ORM, no GraphQL, no state management library. Direct SQLite queries via a thin API layer.

---

## Architecture

```
┌──────────────────────┐     ┌──────────────────────┐
│   React SPA (Vite)   │────▶│  API Server (Hono)   │
│   shadcn/ui + charts │◀────│  Port 3456           │
└──────────────────────┘     └──────────┬───────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
              ┌─────▼─────┐     ┌──────▼──────┐    ┌──────▼──────┐
              │deal-hunter │     │ nanoclaw.db │    │  Filesystem │
              │   .db      │     │             │    │  (logs, IPC)│
              └────────────┘     └─────────────┘    └─────────────┘
```

- **Frontend:** Vite + React + TypeScript + shadcn/ui + Recharts
- **Backend:** Hono (lightweight HTTP framework) + better-sqlite3
- **Real-time:** Server-Sent Events (SSE) for live updates
- **Location:** `dashboard/` directory in the NanoClaw repo

---

## Data Sources

### deal-hunter.db (primary)
| Table | Dashboard use |
|-------|--------------|
| `hunts` | Hunt list, detail views, status management |
| `offers` | Offer tables, watched items, status tracking |
| `hunt_offers` | Hunt-offer associations, pipeline status |
| `prices` | Price history charts, trend analysis, baselines |
| `evaluations` | Agent decision log, evaluation stats |
| `alerts` | Alert history, user response tracking |
| `search_queries` | Search effectiveness, activity timeline |

### nanoclaw.db (secondary)
| Table | Dashboard use |
|-------|--------------|
| `task_run_logs` | Agent invocation history, durations, triggers |
| `scheduled_tasks` | Active scheduled task list |
| `sessions` | Session tracking |

### Filesystem
| Path | Dashboard use |
|------|--------------|
| `groups/*/logs/` | Container execution logs |
| `watcher/` process logs | Watcher health, errors |
| `data/ipc/*/tasks/` | Pending IPC tasks |

---

## User Stories

### Section 1: Hunt Management

#### US-D1: Hunt Overview

**As a user**, I want to see all my hunts at a glance — active, paused, and optionally closed — with key stats for each (offer counts by status, last search time, price range, trend direction) — so I can quickly understand the state of everything I'm hunting for.

**What the user sees:**
- A card or row per hunt showing: name, status badge (active/paused/closed), time since creation
- Offer pipeline counts: new | evaluated | watching | dismissed
- Price summary: min-max range of current watched items, trend arrow (rising/stable/falling)
- Last search: how long ago, how many results, how many new
- Monitoring indicator: whether the watcher is polling this hunt
- Quick actions: pause/resume, open detail view

**Data sources:** `hunts`, `hunt_offers` (grouped counts), `prices` (latest per watched offer), `search_queries` (most recent per hunt)

---

#### US-D2: Hunt Detail View

**As a user**, I want to drill into a single hunt and see everything about it — the full criteria, all associated offers grouped by pipeline stage, price trends, search history, and evaluation stats — so I have complete context without switching to the chat interface.

**What the user sees:**
- **Header:** Hunt name, status, created date, cadence, monitoring toggle, category IDs
- **Criteria panel:** Structured display of the hunt criteria JSON (must-haves, nice-to-haves, budget, flex rules). Read-only initially, editable later (US-D10).
- **Search terms:** List of current search terms with per-term stats (last searched, results, new offers)
- **Offer pipeline:** Tabbed or filtered table of offers:
  - **New** — unevaluated offers awaiting agent review
  - **Watching** — actively monitored with watch conditions and latest price
  - **Evaluated** — offers the agent looked at and decided to alert on
  - **Dismissed** — offers the agent skipped, with reasoning accessible
- **Price chart:** Time-series of all price observations for this hunt's offers, with filters by condition and offer status
- **Activity feed:** Recent evaluations, alerts, search runs, and price changes in reverse chronological order

**Data sources:** `hunts`, `hunt_offers`, `offers`, `prices`, `evaluations`, `alerts`, `search_queries`

---

#### US-D3: Manage Hunt Status

**As a user**, I want to pause, resume, or close a hunt directly from the dashboard — with confirmation for destructive actions (close) — so I can control the watcher without messaging the agent.

**What the user sees:**
- Pause/Resume toggle on the hunt card and detail view
- Close button with confirmation dialog showing what will happen (offers dismissed, watches cleared)
- Close reason input (optional: bought, changed_mind, etc.)
- Status change reflected immediately in the UI

**Write operations:** `UPDATE hunts SET status = ...`, cascade logic for close (same as `manage_hunt` MCP tool)

---

### Section 2: Watched Items

#### US-D4: Watched Items Dashboard

**As a user**, I want a dedicated view of all items I'm actively watching across all hunts — sorted by urgency (auctions ending soonest first) — with live price, bid count, time remaining, watch conditions, and price change indicators — so I can see at a glance what needs my attention.

**What the user sees:**
- Table/card list of all offers where `watching = 1`
- Per item: title (linked to eBay), hunt name, condition, buying format
- **Price column:** Current price (landed GBP), price change since first seen (green/red arrow + percentage)
- **Auction info:** Time remaining (countdown for auctions), bid count, bid change indicator
- **Watch conditions:** Displayed as badges (e.g. "Alert below 180", "Max 220")
- **Status indicators:** Active, ended, removed, sold — with last-seen timestamp
- Sort by: urgency (auction end soonest), price (low-high), newest, price change
- Filter by: hunt, condition, buying format, status

**Data sources:** `offers` (watching=1), `prices` (latest + first for change calc), `hunt_offers`, `hunts`

---

#### US-D5: Offer Detail View

**As a user**, I want to click into any offer and see its complete history — all price observations as a chart, every evaluation the agent made, any alerts sent, watch conditions, extracted specs, and seller info — so I can understand the full picture of a specific listing.

**What the user sees:**
- **Header:** Title, eBay link, seller (with rating), condition, buying format
- **Price chart:** All `prices` observations over time as a line chart, with landed GBP on Y axis
- **Specs:** Parsed `specs_extracted` JSON displayed as key-value pairs
- **Evaluation history:** Each evaluation with decision, reasoning, timestamp
- **Alert history:** Each alert with urgency, message sent, user response (if any)
- **Hunt associations:** Which hunts this offer is linked to, and its status in each
- **Watch conditions:** Current conditions, editable (future)
- **Quick actions:** Dismiss from hunt, start/stop watching, open on eBay

**Data sources:** `offers`, `prices`, `evaluations`, `alerts`, `hunt_offers`, `hunts`

---

### Section 3: Price Intelligence

#### US-D6: Price Baseline View

**As a user**, I want to see the price baseline for each hunt — the agent's understanding of what items typically sell for — showing the distribution of observed prices, sold prices, and how current listings compare — so I can judge whether a specific offer is actually a good deal.

**What the user sees:**
- **Market overview stats:** Median price, min, max, average, number of observations, trend (rising/stable/falling)
- **Price distribution chart:** Histogram or box plot of `total_landed_gbp` across all offers for a hunt
- **Current vs sold comparison:** If sold data has been collected, overlay current asking prices against recent sold prices
- **Condition breakdown:** Stats split by condition (Used, Refurbished, New, etc.)
- **Time period selector:** 7 days, 14 days, 30 days, 90 days, all time

**Data sources:** `prices`, `offers` (condition, status), `hunt_offers`

---

#### US-D7: Price Trend Charts

**As a user**, I want to see how prices for items in a hunt have moved over time — as a multi-line chart showing individual watched items and/or an aggregate trend line — so I can spot market movements and time my purchase.

**What the user sees:**
- **Aggregate trend line:** Moving average of all price observations for the hunt over time
- **Individual item lines:** Toggle-able lines for specific watched items
- **Event markers:** Vertical lines or annotations for key events (offer ended, alert sent, new offer appeared)
- **Budget line:** Horizontal line showing the hunt's budget ceiling
- **Interactive:** Hover for details, zoom into time ranges, toggle items on/off

**Data sources:** `prices`, `offers`, `hunt_offers`, `alerts`, `hunts` (criteria.budget)

---

### Section 4: Search Management

#### US-D8: Search Activity View

**As a user**, I want to see the history of all searches the watcher has executed — which terms, when, how many results, how many were new — so I can evaluate whether my search terms are effective and the watcher is running correctly.

**What the user sees:**
- Table of search query executions in reverse chronological order
- Per row: hunt name, search terms, timestamp, result count, new offer count, relevant count
- **Effectiveness indicators:** Terms that consistently return 0 new results flagged as stale
- **Search cadence visualization:** Timeline showing when searches actually ran vs expected cadence
- Filter by: hunt, search term, date range

**Data sources:** `search_queries`, `hunts`

---

#### US-D9: Search Term Effectiveness

**As a user**, I want to understand which search terms are working and which are not — seeing metrics like total offers found, new offers per search, hit rate over time — so I can prune bad terms and add better ones.

**What the user sees:**
- Per search term: total searches, total results, total new offers, average new offers per search
- Trend: is this term finding fewer/more results over time?
- **Stale term warning:** Terms that haven't produced new results in N searches
- Grouped by hunt

**Data sources:** `search_queries` (aggregated by terms)

---

#### US-D10: Edit Search Parameters

**As a user**, I want to edit a hunt's search terms, cadence, category IDs, and monitoring flag directly from the dashboard — and have those changes take effect on the next watcher tick — so I can tune the system without messaging the agent.

**What the user sees:**
- **Search terms editor:** Add/remove/reorder search terms (list with add/delete buttons)
- **Cadence selector:** Dropdown or input for polling interval in minutes
- **Category IDs:** Input field for comma-separated eBay category IDs
- **Monitoring toggle:** On/off switch
- **Save button** with confirmation of what changed
- Changes take effect immediately (watcher reads from DB each tick)

**Write operations:** `UPDATE hunts SET search_terms = ?, cadence_minutes = ?, category_ids = ?, monitoring = ?`

---

### Section 5: Agent Performance and Debugging

#### US-D11: Agent Activity Feed

**As a user**, I want a real-time feed of what the agent is doing — when it was invoked, what triggered it (user message, watcher alert, scheduled task), what it did (evaluated offers, sent alerts, updated watches), and how long it took — so I can see the agent working and spot problems.

**What the user sees:**
- Reverse-chronological feed of agent invocations
- Per invocation: trigger type (user/watcher-urgent/watcher-new-offers/scheduled), timestamp, duration
- Expandable detail: prompt that triggered it, result summary, session ID
- **Status indicators:** Success, error, timeout
- **Live updates via SSE:** New invocations appear as they happen

**Data sources:** `task_run_logs` (nanoclaw.db), container logs (`groups/*/logs/`), IPC task files

---

#### US-D12: Evaluation Performance

**As a user**, I want to understand how the agent is evaluating offers — what percentage it alerts on vs skips vs watches, whether its reasoning aligns with my feedback, and whether it's getting better over time — so I can assess whether the agent is calibrated correctly.

**What the user sees:**
- **Decision distribution:** Pie/donut chart of alert vs skip vs watch decisions
- **Decision trend:** Stacked area chart showing decision distribution over time
- **Recent evaluations table:** Offer title, decision, reasoning snippet, timestamp
- **Feedback alignment:** Where alerts led to positive vs negative user feedback
- **Reasoning search:** Text search across evaluation reasoning to find patterns
- Filter by: hunt, decision type, date range

**Data sources:** `evaluations`, `alerts` (user_response, feedback_extracted), `offers`

---

#### US-D13: Watcher Health

**As a user**, I want to know if the watcher service is running correctly — when it last ran, whether it's hitting API limits, if there are errors — so I can catch problems before they mean I miss a deal.

**What the user sees:**
- **Status indicator:** Watcher running/stopped (derived from last search timestamp recency)
- **Last activity:** Timestamp of most recent search query execution
- **API budget:** Daily calls used vs budget (4500), with visual bar
- **Search schedule:** For each hunt, expected next search time vs actual
- **Error log:** Recent errors from watcher logs (API failures, auth issues, rate limits)
- **Uptime indicator:** Whether searches are happening on cadence or falling behind

**Data sources:** `search_queries` (timestamps), watcher process logs, system process check

---

#### US-D14: Container Execution Logs

**As a user**, I want to browse agent container execution logs — seeing what happened inside each container run, what MCP tools were called, errors encountered — so I can debug when the agent does something unexpected.

**What the user sees:**
- List of recent container runs with: timestamp, trigger, duration, exit code, session ID
- Click to expand: full stderr/stdout log content
- **Search:** Text search across log content
- **Error highlighting:** Lines containing errors or warnings highlighted
- **Filtering:** By date range, by error-only, by trigger type

**Data sources:** `groups/*/logs/` (log files), `task_run_logs`

---

### Section 6: System Overview

#### US-D15: Dashboard Home / System Overview

**As a user**, when I open the dashboard I want a single-screen overview of the whole system — active hunts with status, items needing attention, recent activity, system health — so I can assess the state of everything in 10 seconds.

**What the user sees:**
- **Hunt summary cards:** One per active hunt with name, offer counts, trend indicator
- **Attention needed:** Items where auction is ending within 24h, price drops on watched items, new unevaluated offers count
- **Recent activity:** Last 5 agent actions (evaluations, alerts, searches)
- **System health strip:** Watcher status (green/yellow/red), API budget gauge, last agent run timestamp
- **Quick stats:** Total active offers, total watched, total searches today, total evaluations today

**Data sources:** All tables, aggregated

---

### Section 7: Future Features (Out of Scope for V1)

#### US-D16: Chat Interface (Future)

**As a user**, I want to send messages to the agent directly from the dashboard — asking questions about a specific offer or hunt, requesting a manual search, or giving feedback — without switching to Telegram.

**Deferred because:** Requires IPC message injection and response streaming. Design the API layer to support it but don't build the UI.

---

#### US-D17: Notification Preferences (Future)

**As a user**, I want to configure alert routing from the dashboard — which urgency levels go to push notification vs digest, quiet hours, channel preferences.

---

#### US-D18: Multi-Group Support (Future)

**As a user**, I want to switch between groups in the dashboard to manage hunts across different agent instances.

---

## Pages and Navigation

```
/                       → System Overview (US-D15)
/hunts                  → Hunt List (US-D1)
/hunts/:id              → Hunt Detail (US-D2, US-D3, US-D10)
/hunts/:id/prices       → Price Baseline + Trends (US-D6, US-D7)
/watched                → Watched Items (US-D4)
/offers/:id             → Offer Detail (US-D5)
/searches               → Search Activity + Effectiveness (US-D8, US-D9)
/agent                  → Agent Activity Feed (US-D11)
/agent/evaluations      → Evaluation Performance (US-D12)
/agent/logs             → Container Logs (US-D14)
/system                 → Watcher Health + System Status (US-D13)
```

**Navigation:** Sidebar with icons and labels. Active page highlighted. Hunt count badges on relevant nav items.

---

## API Endpoints

### Read endpoints
```
GET /api/hunts                          → List hunts with summary stats
GET /api/hunts/:id                      → Hunt detail with offer counts
GET /api/hunts/:id/offers               → Offers for hunt (filterable by status)
GET /api/hunts/:id/prices               → Price observations for hunt (with aggregates)
GET /api/hunts/:id/searches             → Search history for hunt
GET /api/hunts/:id/evaluations          → Evaluations for hunt
GET /api/hunts/:id/alerts               → Alerts for hunt
GET /api/offers/:id                     → Offer detail with full history
GET /api/offers/:id/prices              → Price history for single offer
GET /api/watched                        → All watched offers across hunts
GET /api/searches                       → All search queries (paginated)
GET /api/evaluations                    → All evaluations (paginated, filterable)
GET /api/agent/activity                 → Agent invocation log
GET /api/agent/logs/:id                 → Single container log content
GET /api/system/health                  → Watcher status, API budget, last activity
GET /api/dashboard/overview             → Aggregated overview stats
```

### Write endpoints
```
PUT  /api/hunts/:id                     → Update hunt (search_terms, cadence, category_ids, monitoring)
POST /api/hunts/:id/pause               → Pause hunt
POST /api/hunts/:id/resume              → Resume hunt
POST /api/hunts/:id/close               → Close hunt (with cascade)
PUT  /api/offers/:id/watch              → Start/stop watching, edit watch conditions
POST /api/offers/:id/dismiss            → Dismiss offer from hunt
```

### SSE endpoint
```
GET /api/events                         → Server-Sent Events stream
  Events:
    - search_completed    (new search ran)
    - price_change        (watched item price changed)
    - offer_status_change (offer ended/removed/sold)
    - agent_invocation    (agent started/finished)
    - new_offers          (new offers discovered)
```

---

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Frontend framework | React 19 + TypeScript | Mature ecosystem, good charting libraries |
| Build tool | Vite | Fast, minimal config |
| UI components | shadcn/ui | Copy-paste components, no vendor lock-in, Tailwind-based |
| Charts | Recharts | React-native, good for time-series, lightweight |
| HTTP client | Native fetch + SWR or TanStack Query | Caching, revalidation, SSE support |
| Backend framework | Hono | 14KB, TypeScript-native, perfect for API-only server |
| Database access | better-sqlite3 | Already in use, synchronous reads are fine for single-user |
| Real-time | Server-Sent Events | Simple, native browser support, one-directional is sufficient |
| CSS | Tailwind CSS | Comes with shadcn/ui |
| Process management | Standalone Node process | Separate from NanoClaw main process for isolation |

---

## Non-Functional Requirements

- **Startup time:** Dashboard should be ready within 3 seconds
- **Query performance:** All page loads under 500ms (SQLite is local, single-user)
- **Browser support:** Modern browsers (Chrome, Firefox, Safari). No IE.
- **Responsive:** Usable on tablet and desktop. Mobile is nice-to-have but not primary.
- **Security:** No authentication required (local network only). If exposed externally, put behind a reverse proxy with auth.
- **Deployment:** `npm run dev` for development, `npm run build && npm start` for production. Single command.

---

## Open Questions

1. **Sold data integration:** The `sold-data` MCP scrapes eBay sold listings at the agent's request. Should the dashboard trigger sold data refreshes, or only display what the agent has already collected? (Recommendation: display-only in V1, trigger in V2.)

2. **Write-back scope:** Should the dashboard be able to create new hunts, or only manage existing ones? (Recommendation: manage-only in V1. Hunt creation involves requirements discovery which is better done conversationally.)

3. **Watcher control:** Should the dashboard be able to start/stop the watcher service? (Recommendation: show status only in V1. Start/stop via systemd.)

4. **Data retention:** Should the dashboard handle archiving or cleanup of old data? (Recommendation: no. Leave data management to the existing system.)
