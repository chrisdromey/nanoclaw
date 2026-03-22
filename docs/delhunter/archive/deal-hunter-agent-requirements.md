# Deal Hunter Agent — Agent Efficiency & Memory Requirements

## Reference

- **PRD:** `deal-hunter-prd.md` (user-facing stories)
- **Implementation Plan:** `deal-hunter-implementation-plan.md`
- **Skills & Data Architecture:** `deal-hunter-skills-architecture.md` (to be revised based on these requirements)

## Overview

These requirements describe how the agent should manage its own knowledge, memory, and efficiency across sessions. They exist because the agent operates in discrete sessions (each costing API tokens), hunts can run for months, and the volume of listings encountered will grow continuously. The agent must be able to work effectively without re-evaluating everything from scratch each time it runs.

These requirements are complementary to the user-facing stories in the PRD. The PRD describes what the user experiences; this document describes what the agent needs in order to deliver that experience efficiently.

---

## Agent Stories

### AS-1: Know What I've Already Evaluated

*As the agent, when I receive search results, I want to know which listings I have already evaluated and what my assessment was — so that I only spend time (and API tokens) reasoning about listings that are genuinely new to me or that have materially changed since I last looked.*

**Acceptance Criteria:**

- Agent can query whether a listing ID has been previously evaluated.
- If previously evaluated, the agent can retrieve its prior assessment (decision, reasoning, date).
- Only new or materially changed listings require full evaluation.

---

### AS-2: Persist Evaluation Decisions

*As the agent, when I evaluate a listing and decide it's not worth alerting the user, I want my decision and reasoning persisted — so that if I encounter the same listing in a future session I can immediately see that I've already assessed it, what I thought, and skip re-evaluating it unless something has changed.*

**Acceptance Criteria:**

- Every evaluation decision is recorded with: listing ID, hunt ID, decision (alert / skip / watch), reasoning summary, and timestamp.
- Persisted decisions survive across sessions indefinitely (at least for the lifetime of the associated hunt).
- The agent can retrieve a prior decision without loading the full evaluation history.

---

### AS-3: Understand What Changed

*As the agent, when I encounter a listing I've seen before but something has changed about it (price dropped, auction bid count increased, relisted at a different price), I want to know what changed and what my previous assessment was — so that I can make a quick updated judgement rather than evaluating from scratch.*

**Acceptance Criteria:**

- When a previously seen listing is encountered with different attributes (price, bid count, availability), the changes are identifiable.
- The agent receives the delta (what changed, from what, to what) alongside its previous assessment.
- The agent can make an incremental decision based on the change rather than a full re-evaluation.

---

### AS-4: Hand Off Passive Monitoring

*As the agent, when I find a listing that's interesting but not quite right yet (e.g. price is a bit high, or auction has days remaining), I want to be able to mark it for ongoing monitoring — so that I'm informed if conditions change to the point where it becomes worth alerting the user, without me having to actively check on it myself.*

**Acceptance Criteria:**

- Agent can mark a listing for ongoing monitoring with conditions (e.g. "alert me if price drops below £150", "alert me when auction enters final 2 hours").
- Monitoring happens independently of agent sessions — the agent does not need to be invoked to check on watched listings.
- The agent is notified only when a monitored condition is met or the listing state changes materially (removed, price change, auction ending).

---

### AS-5: Queryable Market Intelligence From Day One

*As the agent, I want access to a queryable history of everything I've seen and evaluated for a hunt — listings, prices, my assessments, user feedback — from the very first search onwards, so that I can answer questions like "is this a good price?", "what's the typical going rate?", and "are prices trending down?" at any point in the hunt's lifecycle, not just after months of accumulated data.*

**Acceptance Criteria:**

- All listing data (price, condition, spec, date seen) is stored in a queryable format.
- Agent can query aggregate statistics: median price, price range, trend over time, volume of listings.
- Queries can be scoped by hunt, time period, condition, or product variant.
- Data is available and queryable from the first search, growing richer over time.

---

### AS-6: Efficient Session Startup

*As the agent, when I start a new session (e.g. a scheduled task fires, or the user messages me), I want to be able to quickly orient myself on the current state of a hunt — what I've been watching, what's changed recently, what's pending my attention — without having to reload and re-read every listing I've ever seen, so that my context stays focused on what actually needs my attention right now.*

**Acceptance Criteria:**

- Agent can retrieve a concise summary of current hunt state: active watches, recent changes, pending items.
- Summary is lightweight — not a full dump of all historical data.
- Agent can drill into detail on demand (e.g. "show me the full history of this listing") without loading it upfront.
- Session startup context consumption remains roughly constant regardless of how long a hunt has been running.

---

### AS-7: Cross-Session Conversational Recall

*As the agent, when the user asks me a question about a listing or product I've seen before in a previous session — like "what happened to that cheap M90Q you found last week?" or "didn't you flag something similar a while back?" — I want to be able to look that up and recall the full context of what it was, what I thought, and what happened, so that the conversation feels continuous even though my sessions are not.*

**Acceptance Criteria:**

- Agent can search past evaluations and alerts by natural language description, not just listing ID.
- Results include: listing details, the agent's assessment, whether the user was alerted, and the user's response.
- Search works across the full lifetime of a hunt.
- The agent can reference specific past findings naturally in conversation.

---

### AS-8: Learn From User Reactions to Similar Items

*As the agent, when I'm evaluating a new listing, I want to know if the user has seen similar items before and what their reaction was — not just for this exact listing, but for comparable items (e.g. "user previously rejected an HP EliteDesk at £180 saying it was too much, so this one at £175 probably isn't worth alerting on") — so that I get smarter about what the user actually values, not just what the written criteria say.*

**Acceptance Criteria:**

- Agent can query past user responses filtered by product type, price range, or other attributes.
- User feedback is stored with enough context to be useful for comparison (what was rejected, why, at what price).
- The agent uses this history to inform evaluation decisions — not just written criteria but observed preferences.
- This learning is cumulative and improves over the lifetime of a hunt.

---

### AS-9: Cross-Hunt Listing Awareness

*As the agent, when I'm evaluating listings for one hunt, I want to be aware if a listing could also be relevant to a different active hunt — so that I don't miss cross-hunt opportunities and I don't waste effort evaluating the same listing separately for each hunt.*

**Acceptance Criteria:**

- When evaluating a listing, the agent can check if it has been seen or evaluated under a different hunt.
- If a listing is relevant to multiple hunts, this is identified during evaluation rather than duplicating work.
- Cross-hunt relevance is surfaced to the user where appropriate (e.g. "this listing could work for both your Proxmox node hunt and your NAS hunt").

---

### AS-10: Search Strategy Refinement

*As the agent, when I decide to search for listings, I want to know which search terms and queries have been productive in the past and which have consistently returned irrelevant results — so that I can refine my search strategy over time rather than repeating the same unproductive queries every cycle.*

**Acceptance Criteria:**

- Search queries are logged with: terms used, number of results, number of results that passed initial relevance filter, number that led to alerts.
- Agent can review query effectiveness over time.
- Unproductive queries can be identified and deprioritised or replaced.
- Productive queries can be identified and used more frequently or as the basis for variations.

---

## Implications for Data Layer

These stories collectively point to a need for:

- **Persistent, queryable storage** — not flat files. The agent needs to query by listing ID, by hunt, by date range, by product attributes, by user response. This is relational data.
- **An independent monitoring/polling layer** — AS-4 explicitly requires monitoring that happens without agent invocation. This is a separate service.
- **Efficient summarisation** — AS-6 requires that the agent can get a lightweight overview without loading everything. The data layer needs to support summary queries, not just raw data dumps.
- **Cross-session continuity** — AS-7 requires searching past evaluations by natural language description, which may need either good text indexing or the agent querying structured fields intelligently.
- **Cross-hunt queries** — AS-9 requires the data layer to be queryable across hunts, not siloed per-hunt.

These implications should inform the revised skills and data architecture. The per-hunt directory approach from earlier needs to be reconsidered in light of these requirements — a database with hunt-scoped queries may serve better than isolated directories while still keeping per-hunt context efficient.
