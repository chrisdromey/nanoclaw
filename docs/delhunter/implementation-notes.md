# Deal Hunter — Implementation Notes

## Decisions Made

### Deployment Model: Fork
- Forked `qwibitai/nanoclaw` to `chrisdromey/nanoclaw`
- NanoClaw is designed to be forked, not used as a dependency
- Upstream updates via `git fetch upstream main && git merge upstream/main` or `/update-nanoclaw` skill
- Skill updates via `/update-skills`
- `upstream` remote configured on both local clone and LXC

### Infrastructure: LXC 108 on pve4
- **Hostname:** nanobot
- **IP:** 192.168.50.50
- **OS:** Ubuntu 24.04 LTS
- **Resources:** 2 cores, 4GB RAM, 30GB disk, 1GB swap
- **Nesting:** Enabled (required for Docker agent sandboxing)
- **Managed by:** Terraform (`terraform/modules/lxc-containers/nanobot.tf`)
- **Note:** Originally provisioned as VMID 103, recreated as VMID 108 during Terraform apply (disk resize forced replacement)

### NanoClaw Clone
- **On LXC:** `/opt/nanoclaw` (working deployment)
- **Local:** `/home/chris/homelab/nanoclaw` (for reference)
- Both have `origin` → `chrisdromey/nanoclaw`, `upstream` → `qwibitai/nanoclaw`

### Development Workflow
- VS Code Remote SSH into `nanobot` (192.168.50.50), working directory `/opt/nanoclaw`
- Claude Code CLI on the LXC for `/setup` and interactive skills
- SSH config added to both WSL (`~/.ssh/config`) and Windows (`C:\Users\chris\.ssh\config`)

## Completed Steps

1. Researched NanoClaw — confirmed fork-based deployment model
2. Updated Terraform for LXC: 2GB→4GB RAM, 10GB→30GB disk, enabled nesting
3. Fixed `ostemplate` ignore_changes across all LXC Terraform resources (prevents forced replacement)
4. Restored openclaw from PBS backup after accidental destruction during Terraform apply
5. Forked `qwibitai/nanoclaw` to `chrisdromey/nanoclaw`
6. Cloned fork to LXC at `/opt/nanoclaw` with upstream remote
7. Cloned fork locally at `/home/chris/homelab/nanoclaw`
8. Installed git, curl, ca-certificates on LXC
9. Claude Code CLI install and `claude login` on LXC
10. SSH config and VS Code Remote SSH configured
11. Ran `/setup` — Node.js 22, Docker 29.3, container image built, systemd service configured
12. Telegram channel connected with bot pool (main bot + 3 swarm bots)
13. **eBay MCP server integrated (2026-03-22)**
    - eBay developer account created, production keyset enabled (opted out of account deletion notifications — app is read-only Browse API)
    - Using official `@ebay/npm-public-api-mcp` (npm, option 2 from implementation plan)
    - Wrapper script (`container/scripts/ebay-mcp-wrapper.sh`) fetches fresh OAuth token via client credentials grant on each container start, then execs the MCP server — avoids 2-hour token expiry issues
    - Credentials stored in `.env` (`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`), read by host via `config.ts`, passed to containers as env vars
    - MCP server registered in `container/agent-runner/src/index.ts` as `ebay-api` (conditional — only when creds present)
    - `mcp__ebay-api__*` added to allowed tools
    - Verified: token fetch works inside container, Browse API returns UK listings (237 M90Q results on EBAY_GB)
14. **Fixed stale session ID bug (2026-03-22)**
    - Known upstream issue: qwibitai/nanoclaw#1216
    - Root cause: Claude Code server-side sessions expire, but NanoClaw never clears the stale session ID from SQLite — every subsequent message fails with "No conversation found with session ID"
    - Fix: added `deleteSession()` to `db.ts`, updated `index.ts` error handler to detect the specific error and clear the stale session so the next message starts a fresh session automatically
15. **Deal Hunter DB Tool Server (MCP) built (2026-03-22)**
    - SQLite database with 7 tables: hunts, offers, search_queries, hunt_offers, prices, evaluations, alerts
    - MCP server at `container/agent-runner/src/deal-hunter-mcp.ts` using `better-sqlite3` (native bindings)
    - 13 coarse-grained tools: manage_hunt, get_hunt, get_hunt_summary, get_market_overview, record_offer, update_offer, get_offer, record_evaluation, record_alert, record_alert_response, get_prices, record_search, search_evaluations
    - DB file persists in group folder at `/workspace/group/deal-hunter.db` (accessible by both container MCP and future host-side watcher)
    - WAL mode enabled for concurrent read/write access
    - Registered unconditionally as `deal-hunter-db` MCP server in agent-runner (tools available as `mcp__deal-hunter-db__*`)
    - Added `better-sqlite3` to container deps, `python3 make g++` to Dockerfile for native compilation
    - Container rebuilt, agent-runner source cache cleared, service restarted

## Next Steps

1. **Write deal-hunter skills and group CLAUDE.md** — requirements-discovery, price-baselining, listing-evaluation, hunt-management, documentation skills per system architecture
2. **Build the Watcher Service** — independent polling service with scheduler, eBay adapter, change detector, agent notifier
3. **Configure scheduled tasks** — periodic eBay polling (30min cadence)
4. **Test end-to-end** — conversation → hunt creation → watcher polls → agent evaluates → alert via Telegram

## Incidents

### Openclaw Destruction (2026-03-22)
- **Cause:** Terraform `ostemplate` storage path mismatch (`local:` vs `nas-fast:`) forced container replacement
- **Impact:** Openclaw (VMID 108) destroyed and recreated empty at VMID 103, losing all config and data
- **Resolution:** Restored from PBS backup (`pbs-nas:backup/ct/108/2026-03-22T03:05:39Z`) to VMID 103
- **Prevention:** Added `ostemplate` to `ignore_changes` on all 6 LXC Terraform resources
