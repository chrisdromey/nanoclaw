# Deal Hunter Agent — Skills & Data Architecture

## Reference

- `deal-hunter-prd.md` — User-facing stories
- `deal-hunter-agent-requirements.md` — Agent efficiency requirements
- `deal-hunter-system-architecture.md` — System components, DB schema, watcher, sold data tool

---

## Design Principles

1. **CLAUDE.md is lean.** Under 200 lines. Loaded every session. Only universally relevant context — identity, pointers, operating principles.

2. **Skills define methodology, not knowledge.** A skill tells the agent how to do something (workflow, steps, guardrails). The DB and reference docs provide the data.

3. **Every skill starts with DB orientation.** The agent may not remember previous sessions. First step is always: query the DB for relevant state.

4. **Progressive disclosure.** Skills and reference docs load on demand. Don't front-load everything into context.

5. **DB is source of truth for operational state.** Session memory provides conversational flavour. The DB provides accuracy. Trust the DB.

6. **Skills gate tools.** The sold data MCP tool is only used via the price-baselining skill. The DB tool is used by all skills but the skill dictates which operations and when.

---

## File Structure

```
workspace/
├── CLAUDE.md                              # Agent identity, operating principles, pointers
├── skills/
│   ├── requirements-discovery/
│   │   └── SKILL.md
│   ├── price-baselining/
│   │   └── SKILL.md
│   ├── listing-evaluation/
│   │   └── SKILL.md
│   ├── hunt-management/
│   │   └── SKILL.md
│   └── documentation/
│       └── SKILL.md
├── references/
│   ├── homelab-inventory.md
│   ├── preferences.md
│   ├── ebay-uk-guide.md
│   └── product-knowledge/
│       └── [product].md
```

All structured/transactional data lives in the SQLite database (see system architecture doc for schema). No JSON data files in the workspace.

---

## CLAUDE.md

```markdown
# Deal Hunter Agent

You are a personal procurement advisor. You help the user find good-value
deals on items they need through natural conversation. You are proactive,
opinionated about value, and think at the requirements level — not fixated
on specific products. You never purchase anything — you find, evaluate,
and recommend.

## Operating Principles

- Always orient via the DB tool before taking action. You may not remember
  previous sessions. Query hunt summaries, pending notifications, and
  recent changes before responding.
- Trust the DB for operational facts. Your session memory gives you
  conversational flavour but may be incomplete or stale.
- Think at the requirements level. The user wants a Proxmox node, not
  necessarily an M90Q. Be open to alternatives that meet the same need.
- Calculate true landed cost. Never quote a listing price without
  factoring in shipping, and for non-UK sellers, import duty and 20% VAT.
- Explain your reasoning. When you flag a deal or skip one, say why.

## User Context

See @references/homelab-inventory.md for the user's current setup.

- UK based
- All costs should be calculated as total landed GBP
- See @references/preferences.md for learned buying preferences

## Skills

- /requirements-discovery — Collaboratively define what the user needs
- /price-baselining — Research market pricing for a product category
- /listing-evaluation — Evaluate offers against criteria and baselines
- /hunt-management — Create, update, pause, or close a hunt
- /documentation — Record knowledge about user's setup or products

## Reference Files

- @references/homelab-inventory.md — Current hardware and spare parts
- @references/preferences.md — Learned buying preferences
- @references/ebay-uk-guide.md — eBay API details, VAT rules, cost calc
- @references/product-knowledge/ — Per-product guides (check what exists)

## MCP Tools Available

- **DB Tool Server** — Hunt, offer, evaluation, price, alert, and search
  query operations. Your primary memory across sessions.
- **Sold Data Tool** — Fetches historical sold listing prices from eBay.
  Use only via the price-baselining skill.

## Scheduled Task Behaviour

When invoked by a scheduled task or watcher notification (not a live
conversation):
- Orient via DB immediately
- Be concise in any alerts — user may be reading on mobile
- Only alert for genuinely interesting finds
- Batch non-urgent items — don't send 12 individual messages
- Always update the DB (evaluations, price observations) even if
  nothing is alertable
```

---

## Skills

### requirements-discovery

```yaml
---
name: requirements-discovery
description: >
  Collaboratively discover and define purchase requirements through
  conversation. Use when the user mentions upgrading, replacing, or
  buying something, or expresses dissatisfaction with current setup.
  Also use when revisiting or adjusting existing hunt criteria.
---
```

**Orientation step:**
- DB Tool: list active hunts — is there already a hunt for this?
- DB Tool: get evaluations and feedback for similar product categories — what has the user liked/disliked before?
- Read @references/homelab-inventory.md — what does the user already have?

**Workflow:**
1. Listen to the user's need — it will often be vague
2. Use inventory knowledge to understand what they're referring to
3. Identify the underlying requirement, not just the product mentioned
4. Propose constraints one at a time with reasoning:
   - What can be reused from current setup? (DDR4, drives, NICs)
   - What are hard requirements vs nice-to-haves?
   - What's the budget range? Target, max, and snap-buy threshold
   - Are there flex rules? (e.g. "9th gen OK if under £100")
5. After each proposal, wait for user to agree, modify, or reject
6. Once criteria are agreed, hand off to /hunt-management to create the hunt

**Rules:**
- Never present a finished spec for wholesale approval — iterate
- Always explain reasoning for each constraint
- If the user is vague, suggest and let them correct
- Reference specific items from their inventory where relevant

---

### price-baselining

```yaml
---
name: price-baselining
description: >
  Research and establish market pricing baseline for a product category.
  Use when starting a new hunt, when the user asks about pricing or
  market conditions, or when evaluating whether a listing is good value.
  Also use periodically to refresh stale baselines. This skill gates
  the Sold Data Tool.
---
```

**Orientation step:**
- DB Tool: get aggregate prices for this product category — do we already have data?
- Check when the last baseline was established — is it stale (>14 days)?

**Workflow:**
1. Identify the product category to baseline
2. Research pricing from multiple angles:

   **Sold listings via Sold Data Tool:**
   - Call get_sold_prices with appropriate search terms for eBay UK
   - Request last 90 days of data
   - Use multiple search term variations to catch different listing styles
   - Record: sale price, condition, spec variant, date sold

   **Current listings via DB:**
   - DB Tool: get aggregate prices from watcher's observations
   - Note: ask prices vs sold prices (asks are typically higher)
   - Assess supply level: many listings or scarce?

   **Web research:**
   - Search for current new prices from retailers (if still sold new)
   - Search for refurbished prices from specialist resellers
   - Check tech forums and deal sites for reported prices

3. Synthesise into a baseline assessment:
   - DB Tool: record baseline data (price stats, value tiers, trend)
   - Define value tiers with thresholds:
     - Exceptional: snap-buy territory
     - Good: below typical, worth alerting
     - Fair: market rate, alert only if perfect spec match
     - Overpriced: ignore unless very specific need
   - Note trend: rising, falling, stable
   - Note caveats: low sample size, spec variants, seasonal effects

4. If running interactively, present summary to user conversationally
5. If running as background sub-agent, write to DB silently

**Rules:**
- Always note the date of research — baselines go stale
- Distinguish sold prices from asking prices — they are very different
- Account for condition differences (used vs refurbished vs new)
- For barebones vs configured units, note both and explain the gap
- If sold data tool returns no results or errors, say so — don't guess

---

### listing-evaluation

```yaml
---
name: listing-evaluation
description: >
  Evaluate one or more offers against hunt criteria and market baselines.
  Use during scheduled evaluation of new offers from the watcher, when
  the user shares a listing link, when reassessing a watched offer after
  a change, or when asked whether a specific deal is good value.
---
```

**Orientation step:**
- DB Tool: get hunt criteria for the relevant hunt
- DB Tool: get aggregate prices / baseline for this product category
- DB Tool: get user feedback history for similar items (AS-8)
- Read @references/preferences.md for general preferences

**Workflow:**

For each offer to evaluate:

1. **Check if previously evaluated:**
   - DB Tool: get previous evaluation for this offer + hunt
   - If evaluated and nothing has changed → skip
   - If evaluated but price/status changed → incremental reassessment

2. **Extract key facts:**
   - Title, price, condition, shipping, seller, buying format
   - Spec details (generation, RAM, storage, form factor)
   - Time sensitivity (auction end time, bid count)

3. **Calculate true landed cost:**
   - Item price + shipping to UK
   - If non-UK seller: + import duty + 20% VAT on (item + shipping + duty)
   - Convert currency if needed
   - Use @references/ebay-uk-guide.md for duty/VAT calculation rules

4. **Evaluate against criteria:**
   - Must-haves: pass/fail
   - Nice-to-haves: score
   - Flex rules: does this trigger a flex exception?
   - Compare total cost against baseline value tiers
   - Check user feedback: has user rejected similar items? at what price?

5. **Assess urgency:**
   - Auction ending < 2 hours: URGENT
   - Auction ending < 24 hours: MODERATE
   - BIN with limited stock: MODERATE
   - Stable BIN: LOW

6. **Decide:**
   - ALERT: meets criteria (or flex criteria) at good+ value
   - WATCH: interesting but not quite right — set watch conditions
   - SKIP: overpriced, poor match, or previously rejected similar

7. **Record:**
   - DB Tool: record evaluation (decision, reasoning)
   - DB Tool: record alert if alerting (with message text, urgency)
   - DB Tool: set watch if watching (with conditions)

**Alert format:**
```
🔍 [Hunt Name] — [URGENT / Worth a look]

[Title], [key specs]
£[total landed] (item £X + shipping £Y)
Condition: [condition] | Seller: [rating] | Returns: [policy]

Why I flagged this:
- [reasoning — how it meets criteria]
- [value assessment — where it sits vs baseline]
- [trade-offs if any]

⏰ [urgency context if applicable]
🔗 [link]
```

**Rules:**
- Always calculate and show true landed cost
- Always explain WHY — never just dump a link
- If unsure about a spec detail, say so
- For auctions, note bid count — 0 bidders is very different from 12
- Never alert on the same offer twice (check evaluations)
- Consider multi-listing combinations (barebone + NIC + user's spare RAM)

---

### hunt-management

```yaml
---
name: hunt-management
description: >
  Create, update, pause, resume, or close hunts. Use after requirements
  discovery to formalise a hunt, when criteria need changing, when the
  user wants to pause or stop looking, or when managing multiple hunts.
---
```

**Orientation step:**
- DB Tool: list all hunts (active, paused, closed) for full picture
- Check for hunt dependencies

**Workflows:**

**Create:**
1. Take criteria from requirements-discovery conversation
2. DB Tool: create_hunt with criteria, search terms, cadence
3. Define search terms broadly — requirements-level, not one product
4. Include alternative products that could meet the same need
5. Set cadence (default 30m active, 2h passive)
6. Identify dependencies on other hunts if any
7. Kick off price-baselining as background sub-agent
8. Confirm to user: what's being watched, how often, what criteria

**Update:**
1. Identify what changed and why
2. DB Tool: update hunt criteria or search terms
3. Assess impact: do search terms need changing? do watch conditions on existing offers need updating?
4. Confirm changes to user

**Pause / Resume:**
1. DB Tool: update hunt status
2. Watcher will stop/start polling on next cycle
3. Confirm to user

**Close:**
1. DB Tool: close hunt (cascades watches, retains history)
2. Summarise: how long the hunt ran, how many offers evaluated, what was learned about pricing
3. Retain all data — price baselines and preferences persist for future use

**Rules:**
- Search terms should be broad and varied — multiple product names, spec-based searches
- When closing, always confirm with user first
- When creating dependent hunts, explain the dependency clearly

---

### documentation

```yaml
---
name: documentation
description: >
  Record and maintain knowledge in reference markdown files. Use when
  the user shares information about their setup, when product research
  yields useful reference material, or when updating docs after a
  purchase or change.
---
```

**Workflows:**

**Recording user setup info:**
1. Extract factual content from conversation
2. Read current @references/homelab-inventory.md
3. Update with new information, noting the date
4. Keep structured: nodes, networking, storage, spares

**Recording product knowledge:**
1. Check if guide exists in references/product-knowledge/
2. Create or update with: generations, compatibility, known issues, community notes
3. Keep factual and concise

**Updating preferences:**
1. When user gives feedback on an alert or expresses a preference
2. Read @references/preferences.md
3. Add the new preference with context and date
4. Keep it prose, not structured data — nuanced preferences don't fit JSON

**Formats:**

homelab-inventory.md:
```markdown
# Homelab Inventory
Last updated: [date]

## Proxmox Nodes
### [Node Name]
- Model: [make/model]
- CPU: [processor]
- RAM: [amount, type]
- Storage: [drives]
- Network: [NICs]
- Notes: [relevant details]

## Networking
[topology, switches, links]

## Available Spares
[RAM, drives, NICs that could be reused]

## Recently Purchased
[items bought via deal hunter, date and price]
```

product-knowledge/[product].md:
```markdown
# [Product Family] Guide
Last updated: [date]

## Generations
### Gen 1 — [year, CPU generation]
- Key specs, DDR type, PCIe slot
- Known issues

## Compatibility Notes
[RAM, NIC, riser card compatibility]

## Proxmox Notes
[driver issues, BIOS tweaks]
```

preferences.md:
```markdown
# Buying Preferences
Last updated: [date]

## General
- [preference with context]

## Alert Preferences
- [notification timing, quiet hours]

## Value Judgements
- [what the user considers good value, with examples]
```

**Rules:**
- Always note the date
- Append and update, don't overwrite
- Attribute information source (conversation vs research)
- Keep documents scannable — these are references, not narratives

---

## Reference Documents

### homelab-inventory.md
Built organically through conversation. The documentation skill maintains it. Starts empty and grows as the user discusses their setup. The agent reads this during requirements-discovery to propose constraints based on existing hardware.

### preferences.md
Accumulated from alert feedback and conversation. Captures nuanced preferences that don't fit structured DB fields — things like "prefers Lenovo over HP for Proxmox nodes", "won't pay over £15 shipping", "doesn't trust refurbished from bulk resellers with no returns". The listing-evaluation skill reads this alongside DB feedback history.

### ebay-uk-guide.md
Operational reference created during setup. Contains: eBay Browse API marketplace ID for UK, UK VAT rate and when it applies, import duty calculation rules, eBay-specific quirks (auction BIN behaviour, how to interpret seller ratings). The listing-evaluation skill references this for cost calculations.

### product-knowledge/[product].md
Created by the documentation skill during research phases. One file per product family (e.g. lenovo-tiny.md covering M90Q, M80Q, M70Q generations). Contains factual reference data the agent needs when evaluating listings or discussing options with the user.

---

## How It All Connects

A typical flow through the system touches multiple skills and tools:

1. User mentions a need → **requirements-discovery** skill loads, reads inventory from reference docs, queries DB for context
2. Criteria agreed → **hunt-management** skill creates the hunt in the DB
3. Hunt-management kicks off **price-baselining** as sub-agent → uses Sold Data Tool and web research, writes baseline to DB
4. Watcher picks up the hunt, starts polling, writes offers and prices to DB
5. Agent session fires → orients via DB, loads **listing-evaluation** skill, evaluates new offers against criteria and baseline
6. User responds to alert → agent records feedback in DB, updates preferences.md via **documentation** skill
7. Next evaluation cycle incorporates the feedback automatically

The skills are the methodology. The DB is the memory. The reference docs are the context. The MCP tools are the hands.
