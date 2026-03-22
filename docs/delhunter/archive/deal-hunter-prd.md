# Deal Hunter Agent — Product Requirements Document

## Overview

An intelligent, conversational agent that acts as a persistent personal procurement advisor. It understands the user's environment, engages in natural dialogue to identify needs, autonomously hunts for good-value deals across multiple sources, and surfaces curated recommendations with full context — without ever making purchases on the user's behalf.

The initial MVP use case is homelab hardware procurement, but the architecture must support arbitrary domains (e.g. household items, sporting goods, gifts).

## Principles

- **Conversational first** — the agent is interacted with through natural language, not forms or dashboards.
- **Context-aware** — the agent maintains a rich understanding of the user's existing setup, preferences, and history.
- **Proactively intelligent** — the agent doesn't just match keywords; it reasons about value, compatibility, trade-offs, and alternatives.
- **Observe only** — the agent never purchases or commits to transactions. The user always makes the buying decision. The architecture should not preclude future autonomous bidding capability.
- **Multi-domain** — while the MVP focuses on homelab hardware, the system is designed to support any category of deal-hunting.

---

## User Stories

### US-1: Natural Conversation Entry Point

**As a user**, I want to have a casual conversation with the agent about a vague need (e.g. "I'm thinking of upgrading my nodes, the Dell one is getting a bit long in the tooth") and have the agent use its knowledge of my current setup to understand which item I'm referring to, what its current specs and limitations are, and guide a discussion about what an upgrade path might look like — before any search criteria are even defined.

**Acceptance Criteria:**

- Agent can interpret informal references to items in the user's known environment.
- Agent responds with relevant context about the referenced item (specs, age, known limitations).
- Agent naturally steers the conversation toward understanding the underlying need without jumping to product searches.

---

### US-2: Agent-Led Iterative Requirements Discovery

**As a user**, once the agent and I have discussed the upgrade need, I want the agent to propose requirements iteratively through conversation — suggesting constraints one or a few at a time, explaining its reasoning (e.g. "since your current node has 64GB DDR4 you could reuse, we should look for DDR4 systems"), and giving me the opportunity to agree, push back, or adjust each one before moving on — so that we collaboratively build up the search criteria rather than the agent presenting a finished spec for me to approve or reject wholesale.

**Acceptance Criteria:**

- Agent proposes constraints individually or in small groups with clear reasoning.
- User can agree, modify, or reject each constraint.
- Agent incorporates feedback before proposing the next constraint.
- The process feels like a collaborative conversation, not a form-filling exercise.

---

### US-3a: Visible and Editable Search Criteria (User)

**As a user**, I want the agreed search criteria to be maintained as a structured, visible list that I can review at any time — and I want to be able to directly edit, add, or remove constraints myself (not just through conversation) — so that I have a clear view of exactly what the agent is looking for and can make quick adjustments without having to explain my reasoning back to the agent.

**Acceptance Criteria:**

- Search criteria are persisted as a structured, human-readable list.
- User can view the full criteria set at any time.
- User can directly add, edit, or remove individual constraints without conversational interaction.

---

### US-3b: Reactive Criteria Synchronisation (Agent)

**As the agent**, when search criteria are modified by the user (either through conversation or direct editing), I want to be notified of what changed so that I can assess the impact on any active monitoring tasks — updating, adding, or removing saved searches, watchlists, and scheduled queries as needed — and confirm back to the user what I've adjusted so they know their change has been acted on.

**Acceptance Criteria:**

- Agent detects criteria changes regardless of how they were made (conversation or direct edit).
- Agent evaluates impact on all active monitoring tasks for the affected hunt.
- Agent updates, creates, or removes monitoring tasks as appropriate.
- Agent confirms the changes and any resulting actions back to the user.

---

### US-4: Intelligent Proactive Deal Hunting

**As a user**, once search criteria are agreed, I want the agent to proactively and continuously hunt for good deals across multiple sources — not just matching listings against my spec, but actively looking for adjacent opportunities I might not have considered, understanding market pricing to identify genuine value, and spotting deals where a combination of items across listings could meet my needs (e.g. a barebone unit here, a cheap NIC there) — so that what I get back isn't just "here are listings that match your keywords" but curated, reasoned recommendations that a knowledgeable friend would point out to me.

**Acceptance Criteria:**

- Agent monitors multiple sources autonomously on an appropriate cadence.
- Agent identifies listings that match criteria directly, as well as adjacent or partial matches that represent good value.
- Agent can compose multi-listing recommendations (e.g. "this barebone + this NIC + your spare RAM = a complete node for £130").
- Agent distinguishes between an exact match and a value opportunity with trade-offs.
- Saved searches, watchlists, and scheduled queries are tools the agent uses, not the extent of its capability.

---

### US-5: Contextual, Actionable Alerts

**As a user**, when the agent finds something worth my attention, I want it to alert me with enough context that I can make a quick decision — explaining why it thinks this is a good deal, how it maps to my requirements, what trade-offs are involved (e.g. "this is 9th gen not 10th but it's £80 which is well below typical pricing"), and how time-sensitive it is (e.g. auction ending in 2 hours vs a BIN listing) — so that I can act on it without having to go research the listing myself.

**Acceptance Criteria:**

- Each alert includes: a direct link to the listing, a summary of why the agent flagged it, how it maps to the hunt criteria, any trade-offs or deviations from spec, total estimated cost (including shipping/taxes), and urgency/time-sensitivity.
- Alert format is concise enough to read and act on from a mobile notification.

---

### US-6: Conversational Feedback Loop

**As a user**, I want to be able to respond to an alert conversationally — saying things like "not quite, but if you see one with more RAM let me know", "hold off on that kind of thing for now", or "yeah that's the kind of thing, keep looking for more like that" — and have the agent use that feedback to refine its understanding of what I actually want, adjusting its search behaviour and evaluation criteria accordingly — so that it gets smarter about what to surface over time.

**Acceptance Criteria:**

- Agent accepts natural language feedback on any alert.
- Agent updates its internal model of user preferences based on feedback.
- Agent adjusts search behaviour, scoring, and filtering accordingly.
- Changes are reflected in future alerts without the user needing to explicitly edit criteria.

---

### US-7: Multiple Concurrent Hunts with Cross-Domain Support

**As a user**, I want to be able to have multiple active hunts running concurrently across different domains of my life (e.g. homelab hardware, a specific kitchen knife, a bike for my kid) — each with their own criteria and context — and where hunts are related, I want the agent to understand the dependencies between them (e.g. if I find a Proxmox node without a PCIe slot, the separate 10GbE switch hunt becomes more relevant) — so that the agent is managing my overall deal-hunting picture, not just isolated keyword searches.

**Acceptance Criteria:**

- Multiple hunts can be active simultaneously, each with independent criteria.
- Hunts can span different product domains.
- Agent identifies and tracks dependencies between related hunts.
- When an event in one hunt affects another (e.g. a purchase, a criteria change), the agent proactively reassesses the dependent hunt.

---

### US-8: Market Pricing Awareness and True Cost Calculation

**As a user**, I want the agent to build and maintain an understanding of market pricing for the things I'm hunting — tracking what items typically sell for across different sources and regions, what a good price looks like versus an exceptional one — and I want it to be aware of my location and factor in the real total cost of acquisition, including shipping, import duties, taxes, and currency conversion where applicable (e.g. a cheap AliExpress listing isn't cheap if I'm paying 20% VAT plus handling on top) — so that when it presents a deal the price it quotes reflects what I'd actually pay.

**Acceptance Criteria:**

- Agent tracks and learns typical market pricing for items relevant to active hunts.
- Agent is aware of the user's location (country, region).
- All prices presented include estimated total cost: item price + shipping + import duty + tax + currency conversion where applicable.
- Agent can articulate what "good value" means for a given item relative to market norms.

---

### US-9: Urgency and Timing-Aware Notifications

**As a user**, I want the agent to understand urgency and timing — knowing the difference between an auction ending in 30 minutes, a BIN listing that's been sitting for weeks, and a flash deal that might go quickly — and adjusting how and when it alerts me accordingly (e.g. an urgent push notification for a time-sensitive bargain versus a daily digest of interesting stable listings) — so that I'm not overwhelmed with alerts but I also don't miss time-critical opportunities.

**Acceptance Criteria:**

- Agent classifies listings by urgency (time-critical, moderate, stable).
- Notification method and timing are adapted to urgency level.
- Time-critical deals trigger immediate push notifications.
- Stable or lower-priority findings are batched into periodic digests.
- User can configure notification preferences and quiet hours.

---

### US-10: Closing Out a Hunt

**As a user**, when I decide I'm done hunting for something — either because I've bought it, found it elsewhere, or changed my mind — I want to be able to tell the agent casually (e.g. "I picked one up yesterday" or "I've gone off that idea") and have it wind down all associated monitoring, searches, and alerts for that hunt — while retaining what it learned about pricing and my preferences for future reference.

**Acceptance Criteria:**

- Agent recognises conversational cues that a hunt is complete.
- All active monitoring tasks, saved searches, and alerts for that hunt are deactivated.
- Market pricing data, preference learnings, and hunt history are retained for future use.
- Agent confirms the hunt has been closed and summarises what was learned.

---

### US-11: Multi-Channel Interaction

**As a user**, I want to be able to interact with the agent through whichever channel is convenient at the time — whether that's a chat interface at my desk, a mobile notification I can respond to on the go, or a quick message on something like Slack — so that I'm not tied to a specific app or device to manage my hunts or respond to alerts.

**Acceptance Criteria:**

- Agent is accessible via multiple communication channels.
- Conversation context is shared across channels (a conversation started in Slack can be continued on mobile).
- Alerts are delivered through the user's preferred channel with appropriate formatting for each.
- Agent identity and memory are consistent regardless of channel.

---

### US-12: Organic Onboarding Through Conversation

**As a new user**, I want to be able to gradually teach the agent about my existing setup and preferences through natural conversation over time — rather than having to populate a detailed inventory upfront — so that the onboarding is low friction and the agent's knowledge of my world builds up organically as we interact.

**Acceptance Criteria:**

- No mandatory onboarding process or inventory form.
- Agent extracts and persists relevant context from natural conversation (e.g. "my Proxmox cluster runs on three nodes" → agent now knows about the cluster).
- Agent asks clarifying questions naturally when it needs more detail.
- Knowledge accumulates over time and is used to inform future interactions.
- User can review and correct what the agent knows about them.

---

### US-13: Observe Only — No Purchasing Authority

**As a user**, I want the agent to never purchase anything on my behalf or commit me to any transaction — its role is strictly to find, evaluate, and recommend — and when it surfaces something, I want a direct link to the listing so I can review it myself and make the buying decision — so that I always remain in full control of my money.

**Acceptance Criteria:**

- Agent has no capability to complete purchases, place bids, or make offers.
- Every recommendation includes a direct link to the source listing.
- Architecture does not preclude adding future purchasing capability behind explicit user authorisation.

---

### US-14: On-Demand Status Summaries

**As a user**, I want to be able to ask the agent about the current state of things at any time — "what are you watching for me right now?", "what's the market looking like for M90Qs?", "anything good come up this week?" — and get a useful conversational summary rather than having to go check a dashboard or trawl through old alerts — so that I can stay in the loop with minimal effort.

**Acceptance Criteria:**

- Agent can summarise all active hunts, their criteria, and current status on request.
- Agent can provide market pricing summaries for items relevant to active hunts.
- Agent can summarise recent activity (what it found, what it alerted on, what the user responded to).
- Responses are conversational and concise, not data dumps.

---

### US-15: Proactive Strategy Adjustment

**As a user**, if the agent isn't finding good deals against my requirements, I want it to proactively come back to me with an assessment of why — thinking at the requirements level, not the product level — and suggest alternative approaches it's already been exploring (e.g. "M90Qs are holding at £280+ right now, but I've also been watching HP EliteDesk Minis which tick most of the boxes except the PCIe slot — would you consider a USB 10GbE adapter instead, or should we wait it out?") — so that the agent is actively problem-solving, not just passively waiting for a specific product to appear at the right price.

**Acceptance Criteria:**

- Agent monitors the success rate of active hunts over time.
- When a hunt is underperforming, the agent proactively initiates a conversation with the user.
- Agent presents its analysis at the requirements level, not fixated on specific products.
- Agent proposes concrete alternatives it has already been researching.
- User can accept, reject, or modify the suggested strategy change.

---

## MVP Scope

The initial build will focus on:

- **Domain:** Homelab hardware procurement (as the primary use case to validate the architecture).
- **Sources:** eBay (UK) as the primary marketplace, with architecture supporting additional sources.
- **Channel:** Single chat interface, with architecture supporting multi-channel.
- **Purchasing:** Observe and recommend only. No transactional capability.

## Future Considerations

- Autonomous bidding with user-defined limits and explicit authorisation.
- Additional marketplace integrations (AliExpress, Amazon, Gumtree, Facebook Marketplace, HotUKDeals).
- Additional notification channels (Slack, mobile push, Home Assistant).
- Multi-user support (e.g. shared household hunts).
