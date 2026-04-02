# How Hunts Work — The Market-First Approach

A hunt is not a project plan. It is a feedback loop where the market teaches you what to look for.

## The core idea

When a user says "I need a Proxmox node," your instinct might be to interview them for requirements, research products, build a specification, and then go look at eBay. This is backwards. You end up spending 20 minutes thinking before seeing a single listing — and your thinking is based on your own knowledge, which may be incomplete or wrong.

Instead: **look at the market first.** Search eBay with broad terms within the first few minutes of the conversation. See what's actually available, at what prices, in what condition. Then use what you find to have an informed conversation with the user about what they want.

## The loop

1. **User expresses a need** — often vague ("I need a small server," "looking for a decent chef's knife")
2. **Get the basics** — budget range and absolute must-haves (2-3 hard constraints max)
3. **Search eBay broadly** — use the need and basics to run a few broad searches right away
4. **Share what you find** — "here's what the market looks like: these three product types are common in your budget, prices range from X to Y, these brands dominate"
5. **User reacts** — "those look interesting," "not that brand," "I didn't know about those" — this is far more productive than abstract requirements gathering
6. **Refine and repeat** — narrow searches, adjust criteria, explore new leads the market surfaced
7. **Create the hunt** — once the shape is clear enough for effective search terms, formalise it. Start monitoring immediately.
8. **Keep iterating** — the hunt is live and learning. Update search terms when you discover new products. Adjust criteria when the market tells you your expectations were wrong. Research specific products when something unfamiliar shows up.

This loop never really stops until the hunt is closed. Every evaluation, every user reaction, every market shift feeds back into the hunt's strategy.

## Mindset shifts

**"Start with eBay, not with specs."**
Your first action after hearing the user's need should be a broad eBay search, not a list of clarifying questions. You can ask questions and search at the same time — the search results will make the questions better.

**"Requirements emerge from the market."**
Don't try to build a complete specification upfront. Get the basics (budget, dealbreakers), then let the market fill in the rest. Showing the user real listings and asking "does this kind of thing interest you?" is faster and more accurate than asking "what processor generation do you need?"

**"Create the hunt early, refine continuously."**
A hunt is not a finished specification — it's a living search. Create it as soon as you have enough for meaningful search terms. You'll update it many times. A broad running hunt that's learning from the market is infinitely more useful than a perfect specification that hasn't started looking yet.

**"Research is triggered by findings, not by planning."**
Deep product research (the /research skill) should happen when the market surfaces something you don't know enough about — "I keep seeing Minisforum UM690 in searches, let me research whether it meets the requirements." It should not happen as a prerequisite to starting: "Let me research every possible mini PC brand before I look at eBay."

**"Every evaluation teaches."**
Each listing you look at is market intelligence. If you keep seeing a product you hadn't considered, add it to search terms. If a category is all overpriced, note that and adjust expectations. If the user rejects something, understand why and update criteria. Don't just evaluate in isolation — feed learnings back into the hunt.

**"Broad searches are cheap, wrong assumptions are expensive."**
A few extra API calls to explore broadly cost almost nothing. Locking in the wrong product targets for weeks because you didn't look at the market first costs the user real opportunities.

## Anti-patterns

These are signs you've fallen into waterfall thinking:

- **Gathering a complete requirements spec before searching eBay.** You don't need 10 constraints to start looking. Budget + one or two must-haves is enough for a first search.

- **Creating a ranked product list from your own knowledge.** Your knowledge might be wrong (M75q Gen 2 PCIe, anyone?). The market is the source of truth. Research specific products after the market shows them to you.

- **Waiting for baselining to complete before enabling monitoring.** Price baselining and monitoring can run in parallel. You'll refine your sense of value as listings come in — you don't need a perfect baseline to start watching.

- **Treating hunt criteria as fixed after creation.** Criteria should evolve. If the first week of monitoring shows that your target product barely exists on eBay but a similar alternative is plentiful and cheaper, update the hunt.

- **Front-loading all research into one big burst.** Research should be continuous and proportional. A quick web search to verify a spec when you see an unfamiliar listing is research. A deep swarm investigation is also research. Scale to the question, don't pre-research everything.

- **Asking the user lots of questions before showing them anything.** Show them the market early. Their reactions to real listings will answer most of your questions more reliably than abstract preferences.

- **Skipping baselining because you "already know" the prices.** Your training knowledge is stale. eBay sold data is ground truth. Every hunt — even a simple single-product search — needs market segments and baseline prices recorded to the database. Without them, the dashboard is empty and your value judgements are based on guesses, not data.
