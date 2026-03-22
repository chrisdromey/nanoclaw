# Deal Hunter Agent — Addendum: Hunt Files & Conversational Context

## Context

This addendum captures design decisions made after the main architecture and skills documents were written. It should be read alongside those documents and takes precedence where there are conflicts.

---

## The Change

Each hunt gets its own markdown file in `references/hunts/`. This file serves as the agent's working log and narrative history for that hunt — containing price research, reasoning, strategy notes, and contextual observations that don't belong in the structured database.

**Structured operational data** (offers, prices, evaluations, alerts, search queries) lives in the **SQLite database** — queryable, efficient, cross-session.

**Narrative context** (price research findings, reasoning about value tiers, strategy adjustments, market observations) lives in the **hunt markdown file** — readable, contextual, progressive.

---

## File Structure

```
references/
├── homelab-inventory.md
├── preferences.md
├── ebay-uk-guide.md
├── product-knowledge/
│   └── [product].md
└── hunts/
    ├── proxmox-node.md
    └── [hunt-name].md
```

---

## Hunt Markdown Format

```markdown
# [Hunt Name]
Created: [date]
Status: active
Hunt ID: [DB hunt ID for cross-reference]

## Requirements Summary
[Brief prose summary of what we're looking for and why — derived from
the requirements-discovery conversation. The structured criteria live
in the DB; this is the readable version with context.]

## Price Research

### Initial Baseline — [date]
[Results from the price-baselining skill's first run. Includes:]
- Sold price data from the Sold Data Tool
- Sample size, date range searched
- Key findings: median, range, what good value looks like
- Current listing prices vs sold prices
- Web research findings (retailer prices, forum mentions)
- Value tiers defined and reasoning for the thresholds

### Refresh — [date]
[Subsequent baseline refreshes appended here]
- What changed since last research
- Updated tiers if needed

## Strategy Notes
[Agent's observations and adjustments over time]
- [date]: Started with 8 search terms, "mini PC DDR4 i7 10th"
  returning mostly irrelevant NUCs. Replaced with more specific terms.
- [date]: M90Qs consistently above £250. Started monitoring HP EliteDesk
  800 Mini as alternative — similar spec, no PCIe slot, but £80 cheaper.
- [date]: User rejected HP at £180, said too expensive. Adjusted HP
  ceiling to £120.

## Notable Findings
[Significant listings or events worth remembering]
- [date]: Saw a barebone M90Q Gen 2 at £95 — alerted user, they missed
  the auction. This confirms barebone units in the £90-110 range are
  the sweet spot.
- [date]: Batch of 5x M90Q Gen 1 appeared from a corporate reseller
  at £120 each. User wasn't interested in Gen 1 at that price.
```

---

## How Skills Interact With Hunt Files

### hunt-management
- **Creates** the hunt markdown file when a new hunt is created (alongside the DB record)
- **Updates** the status line when pausing/resuming/closing
- **Appends** a closing summary when the hunt is closed

### price-baselining
- **Writes** research findings to the Price Research section of the hunt file
- This is where sold data tool results go — not into a DB table
- Appends new sections for each refresh rather than overwriting

### listing-evaluation
- **Reads** the hunt file for context (value tiers, strategy notes, notable findings)
- **Appends** to Notable Findings when something significant happens

### requirements-discovery
- **Reads** existing hunt files to understand past context when the user revisits a topic

### documentation
- May **update** hunt files when recording strategy changes or observations

---

## What This Replaces

The earlier skills architecture doc referenced:
- `data/price-baselines/[category].json` — replaced by the Price Research section in the hunt markdown
- Structured JSON baseline with value tiers — the tiers still exist conceptually but are expressed in prose in the hunt file, with the agent interpreting them rather than parsing structured data

The system architecture doc's Sold Data Tool section is unchanged — the tool still fetches sold prices and returns structured data. The change is where that data ends up: the agent writes its findings and reasoning to the hunt markdown file, not to a DB table.

---

## Why Markdown Over DB for This Data

- Price research is contextual and narrative — "M90Qs have been stable at £200 median but there's a glut of Gen 1s dragging the average down" is more useful to the agent than a row in a table
- The agent needs to understand *why* the value tiers are set where they are, not just what the numbers are
- Strategy notes and observations accumulate over the life of a hunt — this is a log, not a dataset
- A hunt might run for months — the markdown file grows but stays readable and the agent can scan it for relevant context
- When the agent needs a specific number (median price, P25), it reads its own notes — it wrote them, it can interpret them
- Keeps the DB focused on operational data that needs to be queried efficiently (offers, evaluations, prices from the watcher)

---

## Capturing Conversational Context

### The Problem

Users share important context in passing during normal conversation — not as formal requirements, but as remarks, anecdotes, and opinions that should inform future decisions. Things like:

- "I had a nightmare with Realtek NICs on Proxmox, took me days to get the driver working"
- "Last time I bought from that seller the packaging was terrible"
- "I'd prefer something with Intel NICs, they just work on Linux"
- "I don't want to deal with importing from the US again, the customs process was a pain"
- "If it's got an i5-10500T that's the sweet spot, the i7 runs too hot in these tiny cases"

None of these are formal search criteria. But they're exactly the kind of knowledge that should influence which listings the agent flags and how it reasons about trade-offs.

### Where It Goes

This context lives in two places depending on scope:

**Hunt-specific context** → the hunt's markdown file. If the user says something relevant to a specific hunt during a conversation about that hunt, it goes in the hunt file's Strategy Notes or a User Context section. Examples: "user mentioned BIOS issues with HP Gen 3 on Proxmox", "user prefers barebone units so they can reuse their own RAM".

**General preferences** → references/preferences.md. If the remark applies broadly across hunts or across time, it goes in preferences. Examples: "avoids Realtek NICs", "prefers sellers with 30-day returns", "won't import from outside the EU".

### Agent Behaviour

The agent should be **actively listening** for these kinds of remarks during any conversation — not just when the user formally states a preference. The instruction should be in CLAUDE.md as an operating principle:

> When the user mentions experiences, opinions, or preferences in passing — even if not directly asked — record them. Hunt-specific context goes in the hunt's markdown file. General preferences go in preferences.md. Use the documentation skill. You don't need to ask permission or announce that you're recording it — just do it naturally, the way a good advisor remembers what you've told them.

The agent should also use this context proactively during evaluations. The listing-evaluation skill should read both preferences.md and the hunt markdown before assessing an offer, so it can factor in things like "user had driver issues with Realtek" when evaluating a listing that includes a Realtek NIC.

### Examples of How This Plays Out

**User says in passing:** "I had problems with the i225-V NIC on my Dell, kept dropping the link"

**Agent records in preferences.md:** "Had reliability issues with Intel i225-V NIC (link drops). Prefer i226-V or Mellanox for 2.5GbE. [date]"

**Later, agent evaluates a listing:** HP EliteDesk Mini with i225-V on the motherboard. Agent notes in its reasoning: "This has the i225-V which the user has had reliability issues with — flagging as a caveat in the alert rather than skipping entirely, since the user might accept it at a good enough price."

---

**User says during hunt discussion:** "I don't really want to spend time flashing BIOS on these things"

**Agent records in hunt markdown:** "User prefers units that work out of the box on Proxmox without BIOS modifications. [date]"

**Later, agent evaluates a listing:** M90Q that's known to need a BIOS update for certain NVMe drives. Agent factors this into its assessment rather than discovering the issue after the user buys it.

### What NOT to Record

- Transient conversational filler ("hmm", "let me think", "not sure yet")
- Information the user is clearly speculating about rather than stating as a preference
- Sensitive personal information that isn't relevant to purchasing decisions
- Anything the user explicitly says is temporary ("just for now, ignore that later")
