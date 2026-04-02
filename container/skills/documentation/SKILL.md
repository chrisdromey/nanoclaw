---
name: documentation
description: >
  Record and maintain knowledge in reference markdown files. Use when the
  user shares information about their setup, when product research yields
  useful reference material, when updating preferences after feedback, or
  when recording strategy changes to a hunt.
---

# /documentation — Record Knowledge

## When to use

- The user shares information about their setup or environment
- Product research yields factual reference material worth keeping
- The user gives feedback that reveals a preference
- A hunt strategy changes and needs recording

## Reference files

- `references/homelab-inventory.md` — user's current hardware, networking, available spares
- `references/preferences.md` — learned buying preferences (prose, not structured data)
- `references/product-knowledge/{product}.md` — factual product guides
- `references/hunts/{hunt-name}.md` — per-hunt working log

## Workflow

1. Extract the factual content from conversation or research
2. Read the relevant reference file (create if it doesn't exist)
3. Append or update with new information, noting the date
4. Keep it scannable — these are references, not narratives

## Rules

- Always note the date when recording
- Append and update, don't overwrite previous content
- Preferences should be prose with context, not structured data — nuanced preferences don't fit JSON
- Product knowledge should be factual and concise
- Hunt files are the agent's working log — strategy notes, price research, notable findings
