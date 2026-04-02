---
name: hunt-management
description: >
  Create, update, pause, resume, or close hunts. Use after requirements
  discovery to formalise a hunt, when criteria need changing, when the
  user wants to pause or stop looking, or when managing multiple hunts.
---

# /hunt-management — Manage Hunts

Read `HUNT-PHILOSOPHY.md` (in this skill directory) for the foundational approach — hunts are market-driven feedback loops, not waterfall projects.

## When to use

- Requirements have enough shape to define meaningful search terms (they don't need to be complete)
- The user wants to change criteria, pause, resume, or close a hunt
- Managing multiple concurrent hunts
- Market findings suggest the hunt should be updated (new products, changed criteria, refined search terms)

## Orientation

1. `mcp__deal-hunter-db__get_hunt` (no ID) — list all hunts for the full picture
2. Check for dependencies between hunts

## Workflows

### Create

1. Take criteria from the requirements-discovery conversation
2. `mcp__deal-hunter-db__manage_hunt` with action `create`, criteria, search terms, cadence
3. Define search terms broadly — multiple product names, not just one
4. Set `monitoring: true` to start learning from the market immediately. Only set `monitoring: false` if you have a specific reason (e.g., search terms are completely untested and might waste API budget on noise — but you should have tested them with ad-hoc search during requirements discovery).
5. Create the hunt markdown file at `references/hunts/{hunt-name}.md` with requirements summary
6. Set `category_ids` based on categories you saw during requirements-discovery market searches (e.g. "PC Desktops & All-in-Ones" = `179`). If you didn't note categories, check a few search results now.
7. Run `/price-baselining` alongside monitoring — it doesn't need to complete first, but it **must happen**. Every hunt needs market segments and baseline prices recorded to the database. Without them, the dashboard prices page is empty and your evaluation judgements aren't grounded in real market data. Never skip this because you think you already know the prices.
8. Confirm to user: what's being watched, how often, what criteria
9. This is a living document. Come back and update search terms, criteria, and strategy as you learn from monitoring and evaluation.

### Update

1. Identify what changed and why
2. `mcp__deal-hunter-db__manage_hunt` with action `update`
3. Assess impact on active watches and search terms
4. Confirm changes to user

### Pause / Resume

1. `mcp__deal-hunter-db__manage_hunt` with action `pause` or `resume`
2. Update the hunt file status
3. Confirm to user

### Close

1. Confirm with user first
2. `mcp__deal-hunter-db__manage_hunt` with action `close` (cascades watches, retains history)
3. Summarise: how long the hunt ran, what was learned
4. Append closing summary to the hunt file

## Monitoring

A hunt has a `monitoring` flag that controls whether the background watcher polls its search terms for new listings.

- **`monitoring: true`** — the watcher automatically searches eBay using the hunt's search terms at the configured cadence, records new offers, and triggers an event-driven invocation so you can evaluate them
- **`monitoring: false`** — the hunt exists for tracking and organization but the watcher ignores it. Use this during research, baselining, or when refining search terms.
- **Pausing** a hunt (`status: 'paused'`) also stops monitoring — the watcher only queries active hunts.

Toggle monitoring with: `manage_hunt(action: 'update', hunt_id: X, monitoring: true/false)`

Ad-hoc searches via `mcp__ebay-search__search_ebay` are never monitored — they're just research tools. Only hunt search terms get polled by the watcher.

## Search Term Design

Each search term costs 3 eBay API calls per poll (one per buying format: auction, buy-it-now, best-offer). These run repeatedly at the hunt's cadence, and the daily API budget across all hunts is 5000 calls. Keep search terms to the minimum needed:

- eBay search is fuzzy — "lenovo m90q" already returns Gen 1, Gen 2, and Gen 3 results. You don't need separate terms for each variant of the same product.
- Overlapping terms waste API budget and return mostly the same listings (duplicates are handled in the DB, but the API calls are still spent).
- Test terms with ad-hoc search first (`mcp__ebay-search__search_ebay`) during baselining to see what each returns before committing them to the hunt.
- Always set `category_ids` on the hunt to filter watcher searches to relevant eBay categories. Without it, a search for "lenovo m90q" returns rack mounts, VESA brackets, heatsinks, and accessories alongside actual PCs. Discover the right category during baselining — look at the `categories` field on relevant search results (e.g. "PC Desktops & All-in-Ones" is category `179`).

## Rules

- Always confirm with the user before closing a hunt
- When creating, explain clearly what will be monitored and how often
- Start monitoring early — a broad hunt learning from the market beats a perfect hunt that hasn't started
- Keep search terms to the minimum needed — each one costs API credits on every poll cycle
- Hunts are iterative — creating one is not a commitment to fixed criteria. Update search terms, criteria, and strategy freely as market data comes in
