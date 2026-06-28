---
name: research
description: >
  Deep research using orchestrator-worker pattern. Use when market findings
  surface an unfamiliar product, when product knowledge has gaps or errors,
  when the user asks to investigate alternatives, or during daily review when
  hunt strategy needs rethinking. Spawns sub-agents via TeamCreate for parallel
  research on different products or topics.
---

# /research — Deep Research

## When to use

Research is reactive to market findings, not a prerequisite to starting a hunt. The typical trigger is: "I'm seeing X on eBay and I don't know enough about it to evaluate whether it's a good deal."

- When market monitoring or early eBay searches surface a product or category you don't know enough about
- When you spot products in search results you hadn't considered — investigate whether they meet the hunt's requirements
- User explicitly asks for research ("what are the alternatives to X?", "research Y")
- During evaluation when you encounter an unknown product or suspect incorrect knowledge
- During daily review when hunt strategy needs rethinking or knowledge gaps surface

## Orientation

Before spawning anything, understand what's already known:

1. Read the hunt file (`references/hunts/{hunt-name}.md`) if it exists
2. Read `references/product-knowledge/` — what facts are on record? For cars, the trim/feature knowledge bases live in `references/product-knowledge/cars/{make}-{model}.md` — read any that exist before re-deriving trim facts, and use `/car-spec-research` to build or extend them rather than gathering trim/feature data ad hoc here.
3. Read `references/research/{hunt-name}/` — has previous research been done?
4. Identify knowledge gaps:
   - What's stated as fact but unverified?
   - What product categories or brands haven't been explored?
   - What compatibility or technical questions are open?

## Challenge the brief

Before scoping research tasks, step back and question the framing. The user (or your own earlier analysis) may have anchored on a specific product or spec without evaluating whether it's actually the best solution to the underlying problem. This is the most common research failure — going deep on the obvious option while missing a simpler, cheaper, or better-fit alternative.

Ask yourself:

1. **What problem is actually being solved?** Not what product was mentioned — what outcome does the user need? What are the real constraints vs. assumed ones?
2. **Are the stated specs justified?** If the brief names a specific tier, capacity, or feature, ask why. Is that grounded in measured need, or is it a guess that hardened into a requirement? If you can't justify a spec from the actual use case, flag it.
3. **What would a domain expert recommend?** Someone knowledgeable would often suggest something simpler, cheaper, or different than what the buyer walked in asking about. Think about what features have outsized value for *this specific use case* that haven't been considered.
4. **What's being left on the table?** Lower-tier products, different product categories, refurbished options, or entirely different approaches. The best deal isn't always the cheapest version of the expensive thing — sometimes it's a different thing altogether.

If this step confirms the brief is well-justified, move on. If it reveals gaps or assumptions, adjust your research scope to include alternatives. At minimum, ensure at least one research thread explores options the user hasn't already named.

## Scoping — swarm or solo?

Not every research task needs a swarm. Assess before deciding.

*Swarm when:*
- 3+ distinct products or product families need investigating
- A broad landscape scan is needed ("what mini PCs have PCIe slots and DDR4?")
- Multiple independent questions need answering (spec verification + alternative discovery + compatibility research)
- The research is for a new hunt where the user expects thoroughness

*Solo when:*
- Verifying a single fact about one product
- Answering a specific user question about one item
- Refreshing knowledge on a well-understood product
- Quick follow-up research during evaluation

## Orchestrator workflow

### Step 1: Scope the research

List what needs investigating. Group into independent research tasks — each task should be answerable by a single sub-agent working alone with web search. Think about:

- Which specific products or product families need deep dives?
- Are there cross-cutting questions (compatibility, market trends, technical constraints) that deserve their own investigation?
- What would a knowledgeable human research before making this purchase?

### Step 2: Write research briefs

For each sub-agent, define a clear brief:

- *Objective* — what specific question(s) to answer
- *Output file* — path under `references/research/{hunt-name}/` to write results to
- *Key sources to check* — manufacturer spec pages, community forums, review sites, teardown videos
- *What done looks like* — the specific deliverables (e.g., "confirmed PCIe slot presence with source URL", "list of all models meeting criteria with verified specs")
- *Boundaries* — what NOT to research (prevent scope creep)
- *Tools to use* — WebSearch, WebFetch, Read, Write, Edit. NOT eBay tools (market pricing is a separate concern handled by /price-baselining)

### Step 3: Spawn sub-agents

Create sub-agents via `TeamCreate`. Each sub-agent's prompt includes:

- The research brief from step 2
- Instruction to write all findings to their assigned output file
- Instruction to send short status updates to you via `SendMessage` (e.g., "Checked Minisforum lineup — 3 models with PCIe found")
- Instruction to NOT use `mcp__nanoclaw__send_message` — you manage all user communication
- Instruction to NOT use eBay MCP tools — research is about product facts, not market prices
- Instruction to follow the deep dive output template (see below)
- Formatting rules: single *asterisks* for bold, _underscores_ for italic, no markdown headings, no [links](url)

### Step 4: Update the user

Send a brief progress message via `mcp__nanoclaw__send_message` — what's being researched, how many threads, roughly what to expect.

### Step 5: Wait for completion

Track sub-agent progress via their `SendMessage` status updates. If a sub-agent reports being stuck or finding something unexpected, you can redirect via `SendMessage`.

### Step 6: Review deep dive files

Read all output files. Critically evaluate — do not blindly trust sub-agent output:

- Are claims sourced with a URL or specific reference?
- Do findings from different sub-agents contradict each other?
- Are there gaps that no sub-agent covered?
- Did any sub-agent go off-scope or produce shallow output?
- If something looks wrong, verify it yourself with a quick WebSearch before including it in the synthesis

### Step 7: Synthesise into the hunt doc

Write or update a `## Research Summary` section in `references/hunts/{hunt-name}.md`:

- Date and scope of research
- Key findings — organised by whatever grouping is natural for the topic
- Corrections to previous knowledge (explicit: "Previously stated X — actually Y because [source]")
- Expanded product/option list with verified specs
- Open questions that couldn't be resolved
- Recommendations for hunt criteria adjustments
- Pointers to deep dive files for detail

This summary is what the evaluation agent reads during daily runs — keep it concise and actionable.

### Step 8: Update product knowledge

If research yielded factual product information worth persisting beyond this hunt, update or create files in `references/product-knowledge/` per the /documentation skill.

### Step 9: Report to user

Summarise what was found, what changed from previous understanding, and what you recommend. Keep it actionable. Link to the deep dives if the user wants to review the evidence.

## Deep dive output template

Sub-agents write their findings to `references/research/{hunt-name}/{topic}.md` using this structure:

```
# {Topic or Product Name}

*Researched: {date}*
*Research brief: {hunt-name}*

## Objective

{What was asked — copied from the research brief}

## Findings

{Prose findings, organised naturally for the topic. Include specific model
numbers, specs, version differences, gotchas, and anything else relevant.
Be thorough — this is the evidence archive.}

## Sources

- {URL} — {what it confirmed or showed}
- {URL} — {what it confirmed or showed}

## Confidence

{High / Medium / Low} — {brief explanation of why}

## Open Questions

- {Anything that couldn't be resolved or needs further investigation}
```

## Example sub-agent brief

This is an example of what a research brief looks like in a TeamCreate prompt. Adapt the content to whatever you're actually researching.

```
You are a research sub-agent investigating alternative mini PC brands for a
homelab Proxmox node hunt.

*Objective:* Find which mini PCs from Minisforum, Geekom, Beelink, GMKtec, and
Trigkey have PCIe expansion slots, DDR4 SO-DIMM, and Intel 10th/11th gen or AMD
Ryzen 4000/5000 CPUs.

*Output file:* Write your findings to
references/research/proxmox-node-mini-pc/alternative-mini-pc-brands.md

*How to research:*
1. Use WebSearch to find each brand's product lineup and specs
2. Use WebFetch to read manufacturer spec pages and teardown articles
3. Cross-reference with community sources (ServeTheHome forums, Reddit
   r/homelab, r/minipc)
4. Focus on: PCIe slot presence, RAM type (DDR4 vs DDR5), CPU options,
   form factor, any known Proxmox compatibility issues

*What done looks like:*
- A list of models that meet or partially meet the criteria
- PCIe slot confirmed or denied with source URL for each model
- CPU and RAM specs verified per model
- Any gotchas or compatibility issues noted

*Boundaries:*
- Only DDR4 platforms — skip anything DDR5
- Only models realistically available used or refurbished in the UK
- Don't research pricing — that's handled separately

*Tools to use:* WebSearch, WebFetch, Read, Write, Edit
*Do NOT use:* mcp__nanoclaw__send_message, mcp__ebay-search__*, mcp__ebay-api__*,
mcp__sold-data__*, mcp__deal-hunter-db__*

*Communication:* Send brief status updates to me via SendMessage as you go
(e.g., "Checked Minisforum — UM690 has PCIe, UM590 does not"). Write all
detailed findings to the output file.

*Output format:* Follow the deep dive template — include Objective, Findings,
Sources, Confidence, and Open Questions sections.

*Formatting:* Use single *asterisks* for bold, _underscores_ for italic.
No ## headings, no [links](url), no **double asterisks**.
```

## Rules

- Never spawn more than 5 sub-agents at once — balance thoroughness against context and cost
- Always critically verify sub-agent output before synthesising — you are the quality gate
- Explicitly correct previous errors in hunt doc and product knowledge files — don't silently overwrite, note what changed and why
- Every factual claim in the research summary should trace back to a deep dive file, which traces back to a source URL
- Keep the hunt doc research summary concise and actionable — deep dives are the evidence archive
- Scale effort to the task — don't swarm for a single fact check
- Check dates on existing research before re-running — hardware specs don't change, but market availability does
- If research reveals the hunt criteria should change, recommend changes but don't modify the hunt without the user's agreement
