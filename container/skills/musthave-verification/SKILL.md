---
name: musthave-verification
description: >
  Adversarially verify a feature-led hunt's must-have features against independent
  primary sources before the hunt activates. Use when a feature-led hunt (one with
  criteria.intent.must_have) is ready to go live, or to re-check a must-have the
  activation gate flagged as unverified or contradicted. Confirms or refutes — from
  re-fetched sources, NOT the hunt's own knowledge base — that each must-have is
  actually available on each target model, then records a verdict per pair.
---

# /musthave-verification — Independent Must-Have Verification (provenance gate D)

The activation gate blocks a feature-led hunt until **every must-have feature, for every target model, is verified**. This skill produces those verdicts. It exists because a spec knowledge base can be wrong (a model can confidently state a feature is "standard" when it's an optional pack), so the must-haves a buyer is paying for get an **independent, adversarial** check before any money or attention is spent.

## The core principle: re-derive, don't trust

This is a *second opinion*, so it must be independent. **Do not read the hunt's KB file as ground truth** — re-fetch primary sources yourself. If you simply echo the KB, you verify nothing. The value is catching the case where the KB (or the criteria notes) and reality disagree.

## What you verify

For the hunt: `criteria.intent.must_have` (the features) × `criteria.targets` (the models, keyed by search term). Every (target, must-have) pair needs a verdict.

## Workflow

1. **Load the hunt** — `mcp__deal-hunter-db__get_hunt`. Extract `must_have` and the `targets` keys.
2. **For each (target, must-have) pair, research it independently.** WebSearch/WebFetch authoritative UK sources, best first:
   - **Parkers** per-trim specs, **manufacturer brochures / press releases** (option-pack contents and names), **What Car? / carwow / Auto Express** used-buyer guides, **owner forums** (SpeakEV, PistonHeads) for what's *actually* fitted.
   - This is a good fit for the `/research` sub-agent swarm when there are many pairs — one sub-agent per target.
3. **Judge adversarially.** Distinguish *standard on all trims* from *available as an optional pack* from *not available*. The must-have is about what the buyer will actually get:
   - **verified** — a source confirms the feature is available on the model in a way that satisfies the brief (standard, or an option that listings expose so the evaluator can confirm per-car).
   - **contradicted** — a source shows the claim as stated is wrong (e.g. "standard" but it's actually the optional Pilot Pack; or not offered at all on the relevant years).
   - **unverified** — sources are silent or conflict and you genuinely can't tell. Prefer this over a guess.
4. **Record each verdict** — `mcp__deal-hunter-db__record_claim_verification` with `hunt_id`, the exact `target_key`, the exact `feature` string, `verdict`, `evidence_url`, and a short `notes` of what the source said. Upserts, so re-running only the failures is safe.

## Rules

- **Verify every pair.** Partial coverage leaves the gate blocked — and a skipped pair is exactly where a bad claim hides.
- **Match the exact strings.** `target_key` must equal the `criteria.targets` key and `feature` must equal the `must_have` entry verbatim, or the gate won't match the verdict to the requirement.
- **Cite everything.** A `verified` or `contradicted` verdict needs an `evidence_url`. No URL ≈ no verification.
- **Never invent a verdict.** Honest `unverified` is more useful than false confidence — it tells the user (and the gate) exactly what couldn't be pinned down. If a must-have genuinely can't be confirmed online, that's for the user to waive (`waive_must_have`), not for you to wave through.
- **Don't activate the hunt.** Your output is verdicts; activation is the orchestrator's call once the gate is satisfied.
