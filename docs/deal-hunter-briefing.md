# Deal Hunter — Briefing for Prompt Writers

You are being asked to write a prompt that will kick off a "hunt" — an automated deal-finding process run by an AI agent called Andy. Andy monitors eBay UK for secondhand/refurbished items and alerts the user (Chris) when something good comes up.

Your job is to write a prompt that Chris will send to Andy to start a new hunt. This document explains how the system works so you can write an effective prompt.

---

## What is a hunt?

A hunt is a persistent, automated search for a specific type of item on eBay UK. Once created, a background watcher service polls eBay every N minutes using configured search terms. When new listings appear, Andy is invoked to evaluate them against the hunt's criteria and decide whether to alert Chris, watch the listing for price drops, or skip it.

A hunt runs until Chris closes it — typically when he buys the item or decides not to.

## How Andy works

Andy is a Claude-based agent running in a container. He has access to:

- **eBay search** — searches across all buying formats (auction, BIN, best offer) in parallel
- **eBay Browse API** — detailed item specs, seller info, pricing
- **Sold data scraping** — completed eBay UK listings for price baselining
- **A SQLite database** — tracks all offers, evaluations, price history, alerts, and market segments
- **Web search and browsing** — for product research when something unfamiliar appears

Andy's workflow for a hunt:

1. **Requirements discovery** — conversational back-and-forth with Chris to understand what's needed
2. **Market reconnaissance** — search eBay immediately with broad terms, before deep research
3. **Hunt creation** — formalise search terms, criteria, budget tiers, and start monitoring
4. **Price baselining** — research sold prices to establish what "good value" means
5. **Ongoing evaluation** — every time the watcher finds new listings, Andy evaluates them
6. **Daily review** — once per day, Andy steps back and reviews the big picture (search quality, strategy, market shifts)

## The philosophy: market-first

This is the most important thing to understand. Andy does NOT follow a waterfall approach of "gather all requirements → research products → then search." Instead:

**Look at the market first.** Andy searches eBay within the first few minutes of receiving a hunt prompt, using broad terms. He shares what the market looks like — what products exist, what prices are, what's available — and uses Chris's reactions to refine the hunt iteratively.

Requirements emerge from the market, not from upfront specification. A broad running hunt that's learning is better than a perfect spec that hasn't started looking.

## What Chris cares about

Chris is a technical homelab user in the UK. He:

- Buys used/refurbished hardware on eBay UK
- Runs a 4-node Proxmox cluster (virtualisation)
- Cares about: ECC RAM, PCIe expansion, low power draw, Intel NICs, IOMMU compatibility
- Has spare RAM, NVMe drives, and networking gear he can reuse
- Prices in total landed GBP (item + shipping + import duty/VAT if non-UK seller)
- Has a homelab inventory at `references/homelab-inventory.md` that Andy can read

## What makes a good hunt prompt

Your prompt will be sent as a message to Andy. Andy will then run requirements discovery, search eBay, and create the hunt. The better the prompt, the faster Andy can get to an effective hunt.

### Include

1. **What you're trying to achieve** — the underlying need, not just a product name. "I need more compute for my Proxmox cluster" is better than "find me an i5-10500T." Andy thinks at the requirements level and may find alternatives you haven't considered.

2. **Hard constraints** — the 2-4 things that are absolute dealbreakers. These become reject criteria. Examples: "must be DDR4", "must fit in a 2U rack", "must support ECC", "UK sellers only."

3. **Budget** — ideally three tiers:
   - **Snap buy** — below this price, buy immediately without thinking
   - **Target** — the realistic sweet spot you expect to pay
   - **Maximum** — absolute ceiling, only for something exceptional

4. **What you already have** — spare parts you can reuse (RAM, drives, PSU, case). This changes what "good value" means — a barebones unit is great if you have RAM; paying extra for included RAM is waste.

5. **Context on use case** — what will this thing do? Andy uses this to evaluate whether listings actually fit your needs, not just match keywords. "This will run 24/7 as a NAS" means power efficiency matters. "This is for weekend experiments" means it doesn't.

6. **Condition preferences** — used OK? Refurbished preferred? Any seller requirements (minimum feedback score, UK only)?

7. **Known preferences or aversions** — things you've learned from experience. "I've had problems with Realtek NICs on Proxmox" or "I prefer Dell over Lenovo for BIOS updates." These help Andy make better judgement calls.

### Don't include

- **Exhaustive product research** — Andy will research products himself, and he has access to current eBay data. Your training knowledge may be stale.
- **Rigid product specifications** — "find me exactly a Lenovo M90q Gen 2 with i5-11500T" is too narrow. Give Andy the requirements and let the market show what's available.
- **Instructions on how to search** — Andy has his own workflow and tools. Tell him what you want, not how to find it.

## Example prompts

### Good prompt (the proxmox node hunt)

> I want to add another node to my Proxmox cluster. Looking for a low-power mini PC or SFF machine — something with a T-series Intel CPU or equivalent AMD that won't chug power running 24/7.
>
> Must-haves: DDR4 (I have spare SO-DIMMs and desktop DIMMs), 6+ cores preferred, 10th gen Intel or newer (or AMD Ryzen 4000/5000). PCIe slot would be great for a 2.5GbE or 10GbE NIC but not a dealbreaker.
>
> I have a spare 1TB NVMe so don't need storage. Don't need RAM either — I can supply my own.
>
> Budget: snap buy under £200, target around £300, max £500 for something exceptional. Used/refurbished is fine.
>
> I've had bad experiences with Realtek NICs on Proxmox — prefer Intel NICs where possible.

### Good prompt (the motherboard hunt)

> I want to upgrade pve2's motherboard and CPU. It's currently a Supermicro with a Xeon E3-1240L v5 (4 cores) in a 4U ATX rack case. I need more cores — this node runs TrueNAS, Frigate with 2x Coral TPUs, and PBS.
>
> Must reuse my existing 2x32GB DDR4 ECC UDIMMs. Need at least 3 PCIe slots (SATA controller passthrough + 2x Coral TPU). ECC support required — "unofficial but community-confirmed" is fine. ATX form factor to fit the existing case.
>
> Budget: £500 for board + CPU combined. Targeting a Ryzen 9 5900X or better.
>
> Boards I know support ECC: ASRock B550 Pro4, B550 Steel Legend, X570 Pro4. But let me know if you find others.

### What Andy does with these

1. Immediately searches eBay UK with broad terms ("mini PC i5 10th gen", "Lenovo ThinkCentre M90q", "Dell OptiPlex Micro" etc.)
2. Shows Chris what the market looks like — prices, availability, dominant products
3. Creates the hunt with search terms and criteria based on the conversation
4. Runs price baselining using sold data to define "good value" vs "overpriced"
5. Starts monitoring — the watcher polls eBay automatically
6. Evaluates every new listing: alert (good deal), watch (interesting, track for price drops), or skip (wrong product, overpriced, bad seller)
7. Sends alerts to Chris via Telegram when something worth acting on appears

## Output format

Write a natural-language prompt as if Chris is messaging Andy. Keep it conversational — not a formal spec document. Include the elements listed above but don't force a rigid structure. Andy is good at extracting requirements from natural conversation.
