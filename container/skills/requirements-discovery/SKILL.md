---
name: requirements-discovery
description: >
  Collaboratively discover and define purchase requirements through conversation.
  Use when the user mentions upgrading, replacing, or buying something, or
  expresses dissatisfaction with current setup. Also use when revisiting
  or adjusting existing hunt criteria.
---

# /requirements-discovery — Define What You're Looking For

## When to use

- The user mentions wanting to buy, upgrade, or replace something
- The user is revisiting or adjusting existing hunt criteria
- A hunt is underperforming and requirements need rethinking

## Orientation

1. Determine which vertical this need belongs to. Call `mcp__deal-hunter-db__list_verticals`
   to see what's configured, then `mcp__deal-hunter-db__get_vertical` for that vertical — it
   gives you the `recon_tool` to search the market, the `sourcing_skill` for how to research
   it, the `criteria_schema` for what a hunt in this vertical needs, and the
   `knowledge_base_path` for reference material.
2. `mcp__deal-hunter-db__get_hunt` — is there already a hunt for this?
3. Check past evaluations and feedback for similar categories
4. If the vertical declares a `knowledge_base_path`, check for an existing knowledge base on
   the candidate item(s) and use it to ground the conversation.

## Workflow

1. Listen to the user's need — it will often be vague
2. Identify the underlying requirement, not just the product mentioned
3. Get the essentials: budget range and hard must-haves (the things that would make a listing
   an automatic reject). Two or three constraints max at this stage — don't try to nail down
   everything. Hard must-haves ultimately land in the hunt's `criteria.intent.must_have` (the
   cross-vertical canonical home — every verification layer keys on those exact strings), so
   phrase each as one testable requirement.
   **Name the level, not just the feature.** Many features are sold at more than one tier under
   similar names (warning-only lane keep vs lane centering that steers; cruise vs adaptive cruise;
   "self driving" vs a lane-keep nudge). If the user's words could cover more than one tier, ask
   which they mean *before* writing the must-have, then write the answer into the string itself:
   `"<what the buyer gets> (<manufacturer names for it>), not <the weaker tier>"`. A slash or "or"
   joining two feature names inside one must-have is a smell — it is almost always a synonym (name
   the stronger one) rather than a genuine either. Every verifier and evaluator quotes the string
   verbatim, so the disambiguation travels with it for free.
4. **Search the market immediately.** Before refining further, run reconnaissance using the
   vertical's `recon_tool` with broad terms reflecting the need, following the vertical's
   `sourcing_skill` for how to search it well. This is market reconnaissance, not a formal
   hunt — you're seeing what's out there.
5. Share what you found: "Here's what the market looks like — these are common in your budget,
   prices range from X to Y, these dominate, this surprised me." Show real examples.
6. Let the user's reaction drive further refinement. They'll naturally say "those look good,"
   "not that brand," or "I didn't know about those." This is more productive than abstract
   requirements gathering.
7. Propose further constraints informed by market reality, one at a time.
8. Consider what the user already owns that could be reused
9. Define budget: target price, maximum, and snap-buy threshold
10. Once the shape is clear (not perfect, just enough for effective search terms), hand off to
    `/hunt-management` to create the hunt and start monitoring. The hunt will be refined
    continuously as market data comes in.
11. **Feature-led briefs:** if the user described what they want by *features* rather than a
    specific product, and the vertical declares a `knowledge_base_path`, the discovery isn't
    complete until you know which products/variants deliver those features. The vertical's
    `sourcing_skill` covers how to build that knowledge base; do it before (or as part of)
    handing off to `/hunt-management`. Don't hand off a feature-led hunt with no knowledge
    base where the vertical expects one — the evaluator depends on it.

## Rules

- **Run reconnaissance within the first few exchanges** — don't wait until requirements are
  "complete"
- **Show the user real market data**, not just your stored knowledge. Your knowledge may be
  wrong; live listings are ground truth.
- Iterate — never dump a complete requirements list for wholesale approval
- Always explain your reasoning for each constraint
- If the user is vague, suggest and let them correct
- Think at the requirements level, not the product level
- Remember requirements may be vague — users may not know exactly what they want. You are
  there to help them, and the market helps both of you.
- A broad running hunt that's learning from the market is better than a perfect specification
  that hasn't started looking yet
- Deep research (/research) happens when the market surfaces something unfamiliar, not as a
  prerequisite to starting
