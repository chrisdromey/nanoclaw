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

1. Check `mcp__deal-hunter-db__get_hunt` — is there already a hunt for this?
2. Check past evaluations and feedback for similar categories
3. Read `references/homelab-inventory.md` if it exists — what does the user already have?

## Workflow

1. Listen to the user's need — it will often be vague
2. Identify the underlying requirement, not just the product mentioned
3. Get the essentials: budget range and hard must-haves (the things that would make a listing an automatic reject). Two or three constraints max at this stage — don't try to nail down everything.
4. **Search eBay immediately.** Before refining further, run `mcp__ebay-search__search_ebay` with broad terms reflecting the user's need. This is market reconnaissance, not a formal hunt — you're seeing what's out there.
5. Share what you found: "Here's what the market looks like — these product types are common in your budget, prices range from X to Y, these brands/models dominate, this surprised me." Show real examples.
6. Let the user's reaction drive further refinement. They'll naturally say "those look good," "not that brand," or "I didn't know about those." This is more productive than abstract requirements gathering.
7. Propose further constraints informed by market reality, one at a time. Now you can say "M90q Gen 1 looks like the sweet spot — plentiful at £180-220 with i5-10500T" instead of guessing from product knowledge.
8. Consider what the user already owns that could be reused
9. Define budget: target price, maximum, and snap-buy threshold
10. Once the shape is clear (not perfect, just enough for effective search terms), hand off to `/hunt-management` to create the hunt and start monitoring. The hunt will be refined continuously as market data comes in.

## Rules

- **Search eBay within the first few exchanges** — don't wait until requirements are "complete"
- **Show the user real market data**, not just your product knowledge. Your knowledge may be wrong; eBay listings are ground truth.
- Iterate — never dump a complete requirements list for wholesale approval
- Always explain your reasoning for each constraint
- If the user is vague, suggest and let them correct
- Think at the requirements level, not the product level
- Remember requirements may be vague — users may not know exactly what they want. You are there to help them, and the market helps both of you.
- A broad running hunt that's learning from the market is better than a perfect specification that hasn't started looking yet
- Deep research (/research) happens when the market surfaces something unfamiliar, not as a prerequisite to starting
