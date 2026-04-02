# Deal Hunter Dashboard — UI/UX Design Specification

---

## 1. Design Philosophy & Visual Language

### Aesthetic Direction

**Terminal elegance.** The aesthetic of a high-end trading terminal rebuilt with modern web sensibilities. Dark-mode only. High contrast where it matters (prices, status, urgency), muted everywhere else. The interface should feel like an instrument — every element earns its pixels.

Reference touchstones: Linear's density and typography, Vercel's surface hierarchy, Bloomberg's information architecture, Grafana's operational feel.

### Dark Mode Only

**Decision:** No light mode toggle.

**Why:** This is an operational monitoring tool for a single technical user at a desk. Dark mode reduces eye strain during monitoring sessions, makes colored indicators (status badges, price changes, urgency) pop against the background, and gives charts better contrast. Building one mode well is better than two modes adequately. The engineering time saved goes into actual features.

---

### Color System

#### Surfaces (darkest → lightest)

| Token | Hex | Usage |
|-------|-----|-------|
| `bg-root` | `#09090B` | Page background (zinc-950) |
| `bg-surface` | `#18181B` | Cards, panels, sidebar (zinc-900) |
| `bg-raised` | `#27272A` | Hover states, nested cards, table row hover (zinc-800) |
| `bg-overlay` | `#3F3F46` | Dropdowns, tooltips, popovers (zinc-700) |
| `bg-input` | `#18181B` | Form inputs background with 1px zinc-700 border |

#### Borders

| Token | Hex | Usage |
|-------|-----|-------|
| `border-default` | `#27272A` | Card borders, dividers (zinc-800) |
| `border-subtle` | `#3F3F46` | Table row separators (zinc-700) |
| `border-focus` | `#3B82F6` | Focus rings (blue-500) |

#### Text

| Token | Hex | Usage |
|-------|-----|-------|
| `text-primary` | `#FAFAFA` | Headings, important values, prices (zinc-50) |
| `text-secondary` | `#A1A1AA` | Body text, descriptions (zinc-400) |
| `text-tertiary` | `#71717A` | Timestamps, metadata, labels (zinc-500) |
| `text-disabled` | `#52525B` | Disabled controls (zinc-600) |

#### Semantic Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `success` | `#22C55E` | Price drops, positive trends, active status (green-500) |
| `success-muted` | `#22C55E1A` | Success backgrounds (10% opacity) |
| `warning` | `#EAB308` | Auctions ending soon, stale data (yellow-500) |
| `warning-muted` | `#EAB3081A` | Warning backgrounds |
| `danger` | `#EF4444` | Price increases, errors, critical alerts (red-500) |
| `danger-muted` | `#EF44441A` | Danger backgrounds |
| `info` | `#3B82F6` | Links, active states, focused elements (blue-500) |
| `info-muted` | `#3B82F61A` | Info backgrounds |

#### Accent / Brand

| Token | Hex | Usage |
|-------|-----|-------|
| `accent` | `#8B5CF6` | Primary action buttons, active nav, chart primary line (violet-500) |
| `accent-hover` | `#7C3AED` | Hover on accent elements (violet-600) |
| `accent-muted` | `#8B5CF61A` | Active nav item background |

#### Chart Palette (ordered by priority)

```
#8B5CF6  violet-500 — primary line / first series
#3B82F6  blue-500   — second series
#06B6D4  cyan-500   — third series
#22C55E  green-500  — fourth series / positive reference
#EAB308  yellow-500 — fifth series / warning reference
#EF4444  red-500    — danger reference / budget line
#EC4899  pink-500   — sixth series
#F97316  orange-500 — seventh series
```

---

### Typography

**Primary font:** `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
**Monospace font:** `"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace`

Inter is the workhorse — designed for screens, excellent at small sizes, good number legibility. JetBrains Mono for anything the user needs to parse character-by-character.

#### Type Scale

| Token | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| `text-page-title` | 24px / 1.5rem | 600 (semibold) | 32px | Page titles only |
| `text-section-title` | 18px / 1.125rem | 600 | 28px | Card headers, section labels |
| `text-heading` | 14px / 0.875rem | 600 | 20px | Column headers, group labels |
| `text-body` | 14px / 0.875rem | 400 | 20px | Default body text |
| `text-small` | 12px / 0.75rem | 400 | 16px | Metadata, timestamps, captions |
| `text-tiny` | 11px / 0.6875rem | 500 (medium) | 14px | Badges, status indicators, chart axis labels |

#### Monospace Usage Rules

Always use monospace for:
- Prices and currency values: `£184.50`, `$220.00`
- eBay item IDs and source IDs
- Timestamps when precision matters (log views, activity feeds)
- Duration values: `3.2s`, `450ms`
- API budget numbers: `1,204 / 4,500`
- Count values in metric cards

Never use monospace for: titles, descriptions, reasoning text, navigation labels.

#### Number Formatting

- Prices: `£` prefix, 2 decimal places, comma thousands: `£1,284.50`
- Percentages: 1 decimal place, colored: `+4.2%` (green), `-2.1%` (red)
- Counts: no decimals, comma thousands: `1,204`
- Durations: smart formatting — `2h 14m` for large, `3.2s` for small, `450ms` for tiny
- Relative time: `2m ago`, `3h ago`, `2d ago` — switch to absolute date after 7 days

---

### Spacing System

**Base unit:** 4px

| Token | Value | Usage |
|-------|-------|-------|
| `space-1` | 4px | Tight internal padding (badge padding, inline gaps) |
| `space-2` | 8px | Default gap between related elements |
| `space-3` | 12px | Card internal padding (compact), table cell padding |
| `space-4` | 16px | Card internal padding (standard), form field spacing |
| `space-5` | 20px | Section spacing within a card |
| `space-6` | 24px | Gap between cards, page section spacing |
| `space-8` | 32px | Page-level padding, major section breaks |

**Page margins:** 24px (space-6) on all sides, 32px (space-8) on larger screens (≥1440px).

**Card padding:** 16px (space-4) for content cards, 12px (space-3) for compact metric cards.

**Grid gap:** 16px (space-4) between cards in a grid, 24px (space-6) between major page sections.

---

### Elevation & Depth

**No box shadows.** Depth is communicated through surface color stepping (bg-root → bg-surface → bg-raised) and 1px borders. This is consistent with the flat, terminal-inspired aesthetic and avoids the blurry-shadow look that doesn't suit dark UIs.

| Layer | Background | Border | Usage |
|-------|-----------|--------|-------|
| Root | `bg-root` | none | Page background |
| Surface | `bg-surface` | 1px `border-default` | Cards, sidebar, panels |
| Raised | `bg-raised` | 1px `border-subtle` | Hover states, nested elements, active rows |
| Overlay | `bg-overlay` | 1px `border-subtle` | Dropdowns, command palette, tooltips |
| Modal | `bg-surface` | 1px `border-default` | Confirmation dialogs, over a `bg-root` at 60% opacity scrim |

**Focus rings:** 2px `border-focus` with 2px offset. Visible on keyboard navigation only (`:focus-visible`).

---

### Motion & Animation

**Philosophy:** Restrained but responsive. Motion communicates state changes, never decorates. The interface should feel snappy, not bouncy.

| Pattern | Duration | Easing | Implementation |
|---------|----------|--------|----------------|
| Hover state (bg change) | 150ms | `ease-out` | CSS `transition: background-color` |
| Tooltip appear | 100ms | `ease-out` | CSS `transition: opacity` |
| Page transition | 0ms | none | Instant route change, no page transitions |
| SSE new row appear | 300ms | `ease-out` | `opacity: 0 → 1`, subtle `translateY(-4px) → 0` via CSS keyframe |
| Price change flash | 1500ms | custom | Background `success-muted`/`danger-muted` → transparent. Easing: fast-in, slow-out |
| Chart tooltip | 0ms | none | Instant follow on cursor — lag feels broken on charts |
| Sidebar collapse | 200ms | `ease-in-out` | Width transition, icons scale, labels fade |
| Expand/collapse row | 150ms | `ease-out` | `max-height` + `opacity` |
| Skeleton loading | infinite | `ease-in-out` | Pulse animation on `bg-raised` → `bg-surface` shapes |

**What never animates:** Table sorting (instant re-render), filter changes (instant), navigation (instant), data refresh (replace in place — only new items animate in).

---

### Information Density Philosophy

**Principle: Scannable density.** Show all the data, but use typography weight, color, and spatial grouping to create a visual hierarchy that lets the eye skip what it doesn't need.

Rules:
1. **Primary metric in `text-primary` (zinc-50), supporting context in `text-tertiary` (zinc-500).** The eye scans the bright values and ignores the dim labels until needed.
2. **Tables over cards for >5 items.** Cards waste horizontal space when you need to compare across rows. Use cards only for the overview page's hunt summary (≤8 hunts) and KPI strips.
3. **Progressive disclosure via expandable rows, not separate pages.** Evaluation reasoning, offer specs, and log content expand inline. This keeps context visible while allowing depth.
4. **No accordions for primary content.** Tabs are better than accordions — they show what's available without hiding count/presence information.
5. **Fixed column widths for numeric data.** Prices, counts, and dates should align vertically across rows. Monospace + right-alignment + fixed width = instant scannability.

---

## 2. Component Library Decisions

### Charting: Recharts (Primary)

**Choice:** Recharts over Nivo or Tremor.

**Why:** Recharts is the most React-native charting library — components compose like React components. Nivo has better aesthetics out of the box but is heavier and harder to customize at the component level. Tremor is too opinionated (it's a dashboard framework, not a chart library) and would fight with our shadcn/ui foundation. Recharts gives full control over every visual element while staying lightweight.

**Customization approach:** Wrap each Recharts component in a themed wrapper that injects our color palette, font sizes, grid styles, and tooltip format. Define a `chartTheme` object consumed by all chart instances.

```
Chart defaults:
- Grid: horizontal lines only, stroke #27272A (border-default), strokeDasharray="3 3"
- Axis labels: 11px Inter, fill #71717A (text-tertiary)
- Axis lines: hidden (tick lines only)
- Tooltip: bg-overlay background, 1px border-subtle, 12px text, custom formatter
- Legend: hidden by default (use labeled series or external legend)
- Responsive: all charts in ResponsiveContainer, 100% width
```

### Data Tables: TanStack Table + shadcn/ui Table

**Why TanStack Table:** Headless — gives us full control over rendering while providing sorting, filtering, pagination, column resizing, and row expansion. shadcn/ui's `<Table>` provides the styled primitives.

**Configuration pattern:**
- Column definitions as typed objects with `accessorKey`, `header`, `cell` renderer
- Sorting: click header to cycle (none → asc → desc → none), sort indicator as chevron icon
- Filtering: external filter bar above table (not inline column filters — too cluttered)
- Pagination: bottom bar with page size selector (25/50/100), page navigation, total count
- Row expansion: chevron icon in first column, expands to full-width detail panel below row
- Column alignment: text left, numbers right, status center
- Row hover: `bg-raised` background transition

### Status Badges: shadcn/ui Badge (custom variants)

Custom variant mapping for domain-specific statuses:

```
Hunt status:
  active   → green badge (success-muted bg, success text)
  paused   → yellow badge (warning-muted bg, warning text)
  closed   → zinc badge (zinc-800 bg, text-tertiary)

Offer pipeline status:
  new        → blue badge (info-muted bg, info text)
  evaluated  → violet badge (accent-muted bg, accent text)
  watching   → green badge (success-muted bg, success text)
  dismissed  → zinc badge (zinc-800 bg, text-tertiary)

Offer listing status:
  active  → green dot indicator
  ended   → zinc dot indicator
  removed → red dot indicator
  sold    → yellow dot indicator

Urgency:
  high   → red badge, filled
  medium → yellow badge, outlined
  low    → zinc badge, outlined

Evaluation decision:
  alert → red badge
  watch → green badge
  skip  → zinc badge
```

Badge rendering: `text-tiny` (11px), medium weight, 4px vertical padding, 8px horizontal, `rounded-md` (6px radius). Dot indicators are 6px circles.

### Real-Time Activity Feed: Custom Component

No library — this is a styled list with SSE-driven prepending.

Structure: Vertical list of feed items. Each item has: icon (by type), timestamp (monospace, tertiary), description text (secondary), and optional expandable detail. New items fade+slide in from the top (300ms animation). Max display: 50 items, virtualized if performance requires it (use `@tanstack/react-virtual`).

### Metric Cards / KPI Displays: Custom Component

Pattern: Compact card with label (text-small, tertiary), value (text-section-title, monospace, primary), and optional trend indicator (small text, colored arrow + percentage).

```
┌─────────────────────┐
│ Watched Items        │  ← label: 12px, zinc-500
│ 14                   │  ← value: 18px semibold, monospace, zinc-50
│ ↑ 3 since yesterday  │  ← trend: 12px, green-500
└─────────────────────┘
```

### Forms & Inline Editing: shadcn/ui Form Primitives

- `<Input>` for text fields (search terms, category IDs)
- `<Select>` for dropdowns (cadence selector)
- `<Switch>` for toggles (monitoring on/off)
- `<Button>` for actions

Inline editing pattern: Click an edit icon (pencil) → fields become editable with a subtle border change → Save/Cancel buttons appear. No modal for editing — everything happens in place. Optimistic update on save with rollback on error.

### Navigation: Custom Sidebar + shadcn/ui

Sidebar with icon + label for each section. Collapsible to icon-only mode (persisted in localStorage). Active item highlighted with `accent-muted` background and `accent` left border (2px).

Breadcrumbs: Used only on detail pages (/hunts/:id, /offers/:id). Format: `Hunts > Hunt Name`. Clickable segments. No breadcrumbs on top-level pages.

### Toast Notifications: shadcn/ui Sonner

Sonner (the toast library shadcn/ui uses) for:
- Write operation confirmations ("Hunt paused", "Search terms updated")
- Error notifications ("Failed to update hunt")
- SSE connection status changes ("Live connection restored")

Position: bottom-right. Duration: 4 seconds for success, persistent for errors (with dismiss).

### Loading States: Skeleton Components

Skeleton screens that mirror the layout of the content they replace. Use shadcn/ui `<Skeleton>` with our pulse animation. Never show a spinner — skeletons are always better because they reduce perceived loading time and prevent layout shift.

### Empty States: Custom Illustrations

Minimal: centered text with icon, no illustration. Example for empty hunt list: magnifying glass icon (from Lucide), "No hunts yet" in text-secondary, "Hunts created through the agent will appear here" in text-tertiary. No call-to-action button (hunts are created conversationally).

### Countdown Timers: Custom Component

For auction end times. Displays as `2h 14m` or `14m 32s` (when under 1 hour) in monospace. Color coding:
- `> 24h`: text-tertiary (not urgent)
- `4h – 24h`: text-secondary (normal)
- `1h – 4h`: warning (yellow)
- `< 1h`: danger (red), font-weight bumped to semibold

Updates every 60 seconds (> 1h remaining) or every second (< 1h remaining).

### Command Palette: cmdk

**Justification:** Single-user power tool. The user is technical and expects keyboard-driven navigation. `cmdk` integrates naturally with shadcn/ui (shadcn even has a `<Command>` component built on cmdk).

**Trigger:** `Cmd+K` / `Ctrl+K`

**Commands:**
- Navigate to any page
- Jump to specific hunt by name
- Jump to specific offer by title
- Filter shortcuts: "Show watching offers", "Show active hunts"
- Actions: "Pause hunt [name]", "Resume hunt [name]"

---

## 3. Page-by-Page Layout Specifications

### Global Layout

```
┌──────────────────────────────────────────────────┐
│ Sidebar (240px / 56px collapsed)  │  Main Content │
│                                   │  (flex: 1)    │
│  Logo/Title                       │               │
│  ─────────                        │  Page Title   │
│  🏠 Overview                      │  ───────────  │
│  🎯 Hunts (3)                     │               │
│  👁 Watched (14)                   │  [content]    │
│  🔍 Searches                      │               │
│  🤖 Agent                         │               │
│     ├─ Activity                   │               │
│     ├─ Evaluations                │               │
│     └─ Logs                       │               │
│  ⚡ System                        │               │
│                                   │               │
│  ─────────                        │               │
│  [collapse toggle]                │               │
│  SSE: ● Connected                 │               │
└──────────────────────────────────────────────────┘
```

(Note: emoji above represent Lucide icons — `Home`, `Target`, `Eye`, `Search`, `Bot`, `Activity`, `BarChart3`, `ScrollText`, `Zap`. Actual implementation uses Lucide React icons.)

**Sidebar details:**
- Width: 240px expanded, 56px collapsed (icon-only)
- Background: `bg-surface` with right border `border-default`
- Top: "Deal Hunter" text (collapsed: "DH" monogram) — no logo graphic
- Nav items: 40px height, 12px horizontal padding, `text-body`, `text-secondary` color
- Active item: `accent-muted` background, `accent` 2px left border, `text-primary` color
- Badge counts: `text-tiny`, monospace, `bg-raised` background pill
- Bottom section: collapse/expand chevron, SSE connection indicator (green dot = connected, yellow dot = reconnecting, red dot = disconnected)
- Collapsed state: icons centered, tooltips on hover showing label + badge count
- Collapse persisted in `localStorage`

**Main content area:**
- Max-width: 1400px, centered
- Padding: 24px (32px on screens ≥1440px wide)
- Page title: `text-page-title`, with optional subtitle in `text-secondary`

**Responsive breakpoints:**
- `≥1440px`: Full sidebar + full content, 32px page padding
- `1024–1439px`: Full sidebar + content, 24px page padding
- `768–1023px`: Collapsed sidebar (icon-only), content fills remaining
- `<768px`: No sidebar — top nav bar with hamburger menu. Content reflows to single column

---

### Page: `/` — System Overview (US-D15)

**Visual hierarchy:** Eye goes to (1) health strip, (2) attention items, (3) hunt cards, (4) activity feed.

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Overview                                             │
├─────────────────────────────────────────────────────┤
│ [Health Strip — full width]                          │
│ Watcher: ● Running   API: ████░ 1204/4500   Agent: 3m ago │
├──────────────────────────┬──────────────────────────┤
│ Attention Needed         │ Quick Stats              │
│                          │                          │
│ ⚠ 2 auctions < 24h      │ Active Offers    142     │
│ ↓ 3 price drops          │ Watching          14     │
│ 🆕 8 unevaluated         │ Searches Today    23     │
│                          │ Evaluations Today 12     │
├──────────────────────────┴──────────────────────────┤
│ Active Hunts                                         │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐             │
│ │ Hunt 1   │ │ Hunt 2   │ │ Hunt 3   │             │
│ │ pipeline │ │ pipeline │ │ pipeline │             │
│ │ price rng│ │ price rng│ │ price rng│             │
│ │ last srch│ │ last srch│ │ last srch│             │
│ └──────────┘ └──────────┘ └──────────┘             │
├─────────────────────────────────────────────────────┤
│ Recent Activity                                      │
│ 🔍 Searched "mini pc proxmox" — 4 new offers   3m   │
│ 🤖 Evaluated 4 offers for "Mini PC Node"        3m   │
│ 📊 Price drop: Dell Optiplex 7080 → £165        1h   │
│ 🔔 Alert sent: HP EliteDesk under budget         2h   │
│ 🔍 Searched "optiplex micro" — 0 new            4h   │
└─────────────────────────────────────────────────────┘
```

**Component specifications:**

**Health Strip:**
- Full-width bar, `bg-surface`, 1px bottom border
- Three sections, equally spaced: Watcher status, API budget, Last agent run
- Watcher: dot indicator (green=running inferred from search <10min ago, yellow=slow >30min, red=stale >2h) + "Running" / "Slow" / "Stale" label
- API budget: horizontal progress bar (200px wide, 8px tall, rounded), filled with `accent` up to 80%, `warning` 80-95%, `danger` >95%. Label: `{used} / {budget}` monospace
- Agent: relative timestamp of last `task_run_logs` entry
- Data: `GET /api/system/health`, `GET /api/dashboard/overview`

**Attention Needed:**
- Card, `bg-surface`
- List of attention items, each with icon + description + count
- Auctions ending <24h: from `offers WHERE watching=1 AND auction_end_time < now+24h`
- Price drops: offers with price decrease in last observation vs previous
- Unevaluated: `hunt_offers WHERE status='new'` count
- If no items need attention: show "All clear" with a subtle checkmark — no empty state

**Quick Stats:**
- 2×2 grid of metric cards (or single row on wide screens)
- Each: label + monospace value + optional trend
- Data: aggregated counts from `GET /api/dashboard/overview`

**Hunt Cards:**
- CSS Grid: `repeat(auto-fill, minmax(320px, 1fr))`, gap 16px
- Each card: `bg-surface`, 1px border, 16px padding
  - Hunt name (`text-heading`, semibold) + status badge
  - Pipeline bar: horizontal stacked bar (4 segments: new/evaluated/watching/dismissed) with counts below
  - Price range: `£{min} – £{max}` monospace, with trend arrow
  - Last search: relative time + result summary
  - Click anywhere → navigates to `/hunts/:id`
  - Hover: `bg-raised` transition

**Recent Activity:**
- Activity feed component, last 10 items
- Each item: type icon (colored per type), description text, relative timestamp right-aligned
- Types: search (🔍 magnifying glass icon), evaluation (bot icon), price_change (trending-down/up icon), alert (bell icon)
- Data: composite from `GET /api/dashboard/overview` recent activity array

**Loading state:** Full skeleton matching the layout — health strip skeleton, 3 card skeletons, 5 feed item skeletons.

**Error state:** If API is unreachable, health strip shows red "API Unreachable" banner replacing normal content. Rest of page shows last cached data (via TanStack Query stale data) with a "Data may be stale" indicator.

---

### Page: `/hunts` — Hunt List (US-D1)

**Decision: Cards, not table.**

**Why:** Hunts are the top-level domain object, there are typically ≤10 of them, and each has rich multi-dimensional data (pipeline counts, price range, trend, last search) that doesn't fit neatly into table columns. Cards allow spatial grouping of these dimensions. If the user had 50+ hunts, a table would be better — but that's not this domain.

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Hunts                                    [filters]   │
├─────────────────────────────────────────────────────┤
│ Showing: Active (3)  Paused (1)  Closed (0)         │
├─────────────────────────────────────────────────────┤
│ ┌─────────────────────────┐ ┌──────────────────────┐│
│ │ Mini PC Proxmox Node    │ │ ThinkPad X1 Carbon   ││
│ │ ● Active      2d ago    │ │ ● Paused      5d ago ││
│ │                         │ │                      ││
│ │ ┌──┬──┬──┬──┐          │ │ ┌──┬──┬──┬──┐       ││
│ │ │ 8│ 4│ 3│12│ pipeline  │ │ │ 2│ 0│ 1│ 8│       ││
│ │ └──┴──┴──┴──┘          │ │ └──┴──┴──┴──┘       ││
│ │                         │ │                      ││
│ │ £140 – £220     ↗ +3%  │ │ £280 – £450   → 0%  ││
│ │                         │ │                      ││
│ │ 🔍 23m ago • 12 results │ │ 🔍 Paused            ││
│ │ ● Monitoring            │ │ ○ Not monitoring     ││
│ │                         │ │                      ││
│ │ [Pause]     [View →]   │ │ [Resume]   [View →]  ││
│ └─────────────────────────┘ └──────────────────────┘│
└─────────────────────────────────────────────────────┘
```

**Filter bar:**
- Segmented toggle: Active / Paused / Closed / All
- Default: Active (show only active hunts)
- Active segment uses `accent` color, others `text-tertiary`

**Hunt card (expanded specification):**

```
Card: bg-surface, border-default, rounded-lg (8px), padding 16px
Width: CSS Grid repeat(auto-fill, minmax(340px, 1fr))

Row 1: Name (text-heading, text-primary, truncate at 1 line) + Status Badge (right-aligned)
Row 2: "Created {relative_time}" in text-small, text-tertiary

Row 3: Pipeline bar
  Horizontal segmented bar, 6px height, rounded-full, full width
  Segments (left-to-right): new (info), evaluated (accent), watching (success), dismissed (zinc-600)
  Below bar: four labels with counts, same colors, text-tiny, monospace
  Segment widths proportional to counts (min-width 4px if non-zero)

Row 4: Price range and trend
  Left: "£{min} – £{max}" in text-body, monospace, text-primary
  Right: trend arrow (↗↘→) + percentage, colored (green/red/secondary)
  Price range from: MIN/MAX of total_landed_gbp for watching offers in this hunt
  Trend: percentage change of median price over last 7 days

Row 5: Last search summary
  "🔍 {relative_time} • {result_count} results, {new_count} new" text-small, text-secondary
  If paused: "🔍 Paused" in text-tertiary

Row 6: Monitoring indicator
  Filled circle (green) + "Monitoring" or hollow circle + "Not monitoring"
  text-small, text-tertiary

Row 7: Actions (bottom, right-aligned)
  Ghost buttons: "Pause"/"Resume" (text-secondary), "View →" (accent)
  Pause/Resume triggers POST /api/hunts/:id/pause or /resume with optimistic UI update
```

**Data:** `GET /api/hunts`

**Empty state:** "No hunts found" + "Create hunts by chatting with your agent on Telegram"

---

### Page: `/hunts/:id` — Hunt Detail (US-D2, US-D3, US-D10)

**Decision: Full-page detail view, not slide-over panel.**

**Why:** Hunt detail has too much content (criteria, search terms, pipeline table, price chart, activity feed) for a side panel. The user will spend extended time on this page — it deserves the full viewport. Back navigation is a single click on the breadcrumb.

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Hunts > Mini PC Proxmox Node                         │
├─────────────────────────────────────────────────────┤
│ Mini PC Proxmox Node                                 │
│ ● Active • Created 2 days ago • Every 60 min         │
│ [Pause] [Close] [Edit]                    [Prices →] │
├───────────────────────────┬─────────────────────────┤
│ Criteria                  │ Search Terms             │
│                           │                          │
│ Budget: ≤ £200            │ "mini pc proxmox" (23m)  │
│ Must: DDR4, PCIe slot     │ "optiplex micro" (4h)    │
│ Nice: ≤10W idle           │ "lenovo tiny sff" (4h)   │
│ Flex: +10% for DDR5       │                          │
│                           │ [Edit terms]             │
├───────────────────────────┴─────────────────────────┤
│ Offers  [New 8] [Watching 3] [Evaluated 4] [Dismissed 12] │
├─────────────────────────────────────────────────────┤
│ (Tab: Watching)                                      │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Title          │Price  │Change│Format │Ends     │ │
│ │ Dell Optiplex… │£165   │-8.3% │BIN    │ —       │ │
│ │ HP EliteDesk…  │£142   │-2.1% │Auction│ 2h 14m  │ │
│ │ Lenovo Tiny…   │£189   │+1.2% │BIN    │ —       │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ Activity                                             │
│ (reverse-chronological feed of evaluations, alerts,  │
│  searches, price changes for this hunt)              │
└─────────────────────────────────────────────────────┘
```

**Header section:**
- Breadcrumb: `Hunts > {hunt.name}` — "Hunts" links to `/hunts`
- Title: `text-page-title`
- Metadata line: status badge + created date (relative) + cadence + category IDs (if any)
- Actions: Ghost buttons — Pause/Resume, Close (opens confirmation dialog), Edit (toggles edit mode)
- "View Prices →" link navigates to `/hunts/:id/prices`

**Criteria panel:**
- Card, `bg-surface`, left column (40% width on desktop)
- Renders `hunts.criteria` JSON in a structured format:
  - Budget: `≤ £{amount}` in monospace, text-primary
  - Must-haves: bullet list, text-body
  - Nice-to-haves: bullet list, text-secondary
  - Flex rules: italic, text-secondary
- Read-only display. JSON keys mapped to human labels.

**Search terms panel:**
- Card, `bg-surface`, right column (60% width on desktop)
- Each term as a row: term in monospace (`"quoted"`), last searched time in text-tertiary
- Below: "Edit terms" ghost button → enters inline edit mode
  - Edit mode: list becomes editable — each term gets a delete (×) button, text input at bottom to add new term, save/cancel buttons
  - Write: `PUT /api/hunts/:id` with updated `search_terms`

**Offer pipeline tabs:**
- Tab bar using shadcn/ui `<Tabs>`: New (8), Watching (3), Evaluated (4), Dismissed (12)
- Tab labels include count badges (monospace)
- Active tab: `accent` underline, `text-primary`
- Inactive: `text-tertiary`, hover `text-secondary`

**Offer table (per tab):**
- TanStack Table
- Columns vary by tab:

| Column | Watching | New | Evaluated | Dismissed |
|--------|----------|-----|-----------|-----------|
| Title | ✓ (link to /offers/:id) | ✓ | ✓ | ✓ |
| Price (landed GBP) | ✓ | ✓ | ✓ | ✓ |
| Price change | ✓ | — | — | — |
| Condition | ✓ | ✓ | ✓ | ✓ |
| Buying format | ✓ | ✓ | ✓ | — |
| Auction end | ✓ (countdown) | ✓ | — | — |
| Bid count | ✓ | ✓ | — | — |
| Decision | — | — | ✓ (badge) | ✓ (badge) |
| Reasoning | — | — | ✓ (expandable) | ✓ (expandable) |
| Seller | — | ✓ | — | — |
| First seen | — | ✓ | ✓ | ✓ |

- Title column: truncated, hover shows full title in tooltip. Click navigates to `/offers/:id`
- Price: monospace, right-aligned
- Price change: `+X.X%` or `-X.X%`, colored green/red, monospace
- Auction end: countdown component (see countdown timer spec)
- Reasoning: row expansion — click chevron to expand row showing full reasoning text below in `text-small`, `text-secondary`, with a subtle `bg-raised` background

**Activity feed:**
- Section at bottom of page
- Last 20 activities for this hunt
- Same pattern as overview activity feed, filtered to this hunt
- Data: composite from evaluations, alerts, search_queries for this hunt_id

**Edit mode (US-D10):**
- Triggered by "Edit" button in header
- Fields become editable: search_terms (inline list editor), cadence_minutes (select dropdown: 15/30/60/120/240), category_ids (text input), monitoring (switch toggle)
- Save/Cancel buttons replace Edit button
- On save: `PUT /api/hunts/:id`, optimistic update, toast confirmation
- On cancel: revert to server state

**Close confirmation dialog (US-D3):**
- shadcn/ui `<AlertDialog>`
- Title: "Close hunt: {name}?"
- Body: "This will dismiss all offers and stop monitoring. This cannot be undone."
- Optional input: Close reason (dropdown: "Bought item", "Changed mind", "Too expensive", "Other")
- Actions: "Cancel" (ghost), "Close Hunt" (danger button, red)
- On confirm: `POST /api/hunts/:id/close`

**Data:** `GET /api/hunts/:id`, `GET /api/hunts/:id/offers?status={tab}`, `GET /api/hunts/:id/searches`, `GET /api/hunts/:id/evaluations`, `GET /api/hunts/:id/alerts`

---

### Page: `/hunts/:id/prices` — Price Intelligence (US-D6, US-D7)

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Hunts > Mini PC Proxmox Node > Prices                │
├─────────────────────────────────────────────────────┤
│ ┌──────────┬──────────┬──────────┬──────────┐       │
│ │ Median   │ Min      │ Max      │ Obs.     │       │
│ │ £172     │ £98      │ £340     │ 847      │       │
│ │ → 0%     │          │          │ 14d      │       │
│ └──────────┴──────────┴──────────┴──────────┘       │
│                                                      │
│ [7d] [14d] [30d] [90d] [All]                        │
├─────────────────────────────────────────────────────┤
│ Price Trend                                          │
│ ┌───────────────────────────────────────────────┐   │
│ │         ╱╲                                     │   │
│ │    ╱╲  ╱  ╲     ╱╲                  ── median  │   │
│ │╲  ╱  ╲╱    ╲╱╲ ╱  ╲                ── budget  │   │
│ │ ╲╱                ╲╱  ╲                        │   │
│ │──────────────────────────── £200 ── budget     │   │
│ └───────────────────────────────────────────────┘   │
├──────────────────────────┬──────────────────────────┤
│ Price Distribution       │ By Condition              │
│ ┌──────────────────────┐ │ ┌──────────────────────┐ │
│ │  ▐                   │ │ │ Used:    £140-£195   │ │
│ │  ▐▐                  │ │ │ Refurb:  £165-£220   │ │
│ │  ▐▐▐                 │ │ │ New:     £280-£340   │ │
│ │ ▐▐▐▐▐                │ │ │                      │ │
│ │▐▐▐▐▐▐▐               │ │ │ (box plot per cond.) │ │
│ └──────────────────────┘ │ └──────────────────────┘ │
└──────────────────────────┴──────────────────────────┘
```

**Market overview stats:**
- Row of 4 metric cards: Median, Min, Max, Observations
- Median has trend indicator
- Observations shows count + time period label
- Data: aggregated from `GET /api/hunts/:id/prices?period={selected}`

**Time period selector:**
- Segmented toggle: 7d / 14d / 30d / 90d / All
- Default: 30d
- Controls all charts and stats on the page
- URL state: `?period=30d`

**Price trend chart:**
- Recharts `<ComposedChart>` with:
  - `<Area>` for price range envelope (min-max of observations per day): fill `accent` at 8% opacity, no stroke
  - `<Line>` for moving average (7-day rolling median): stroke `accent`, strokeWidth 2, dot={false}
  - `<ReferenceLine>` for budget ceiling: stroke `danger`, strokeDasharray="8 4", label "Budget £{amount}" right-aligned
  - Individual watched item lines: `<Line>` per watched offer, stroke from chart palette, strokeWidth 1.5, dot={false}, toggleable via legend
- X axis: date labels, text-tiny, tertiary
- Y axis: GBP values, text-tiny, monospace, tertiary. Format: "£{value}"
- Tooltip: date + all visible series values, formatted as GBP
- Grid: horizontal only, dashed, border-default color
- Interactive: brush (range selector) at bottom for zooming into time periods

**Price distribution:**
- Recharts `<BarChart>` as histogram
- X axis: price buckets (auto-calculated, ~10-15 bars)
- Y axis: count of observations
- Fill: `accent` at 60% opacity
- Hover: full opacity + tooltip showing bucket range and count

**Condition breakdown:**
- Horizontal box plots (custom component using Recharts `<BarChart>` with error bars)
- One row per condition (Used, Refurbished, New, etc.)
- Shows: min, Q1, median, Q3, max as box-and-whisker
- Colors: different chart palette color per condition
- Right-aligned: median price in monospace

**Data:** `GET /api/hunts/:id/prices?period={period}`

---

### Page: `/watched` — Watched Items (US-D4)

**Decision: Table, not cards.**

**Why:** Watched items need comparison across multiple dimensions (price, change, time remaining, format). A table with sortable columns is the fastest way to find "what needs attention." The user will scan this page frequently — density and scannability win over visual richness.

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Watched Items (14)                                   │
├─────────────────────────────────────────────────────┤
│ Filters: [Hunt ▾] [Condition ▾] [Format ▾] [Status ▾]│
│ Sort: Urgency (auction end soonest)                  │
├─────────────────────────────────────────────────────┤
│ Title            │Hunt  │Price  │Δ     │Format│Ends  │
│──────────────────┼──────┼───────┼──────┼──────┼──────│
│ 🔴 HP EliteDesk… │Mini  │£142   │-2.1% │Auc.  │47m   │
│ 🟡 Dell Micro…   │Mini  │£165   │-8.3% │Auc.  │3h 20m│
│    Lenovo Tiny…  │Mini  │£189   │+1.2% │BIN   │ —    │
│    ThinkCentre…  │Mini  │£195   │ 0%   │BIN   │ —    │
│    X1 Carbon G9  │X1    │£340   │-3.0% │BIN   │ —    │
│    ...           │      │       │      │      │      │
└─────────────────────────────────────────────────────┘
```

**Filter bar:**
- Row of dropdown filters using shadcn/ui `<Select>`
- Filters: Hunt (multi-select from active hunts), Condition, Buying Format (Auction/BIN/Both), Status (Active/Ended/Sold)
- Active filters shown as pills below the filter bar with × to remove
- All filter state persisted in URL query params

**Table specification:**
- TanStack Table, full width

| Column | Width | Align | Content |
|--------|-------|-------|---------|
| Urgency indicator | 32px | center | Colored dot: red (<1h), yellow (1-4h), none (>4h or BIN) |
| Title | flex | left | Truncated, link to `/offers/:id`. External link icon on hover opens eBay URL |
| Hunt | 120px | left | Hunt name, link to `/hunts/:id` |
| Price | 90px | right | `£{total_landed_gbp}` monospace |
| Change | 70px | right | `±X.X%` colored, monospace. Change = (latest price - first price) / first price |
| Condition | 80px | left | Abbreviated: "Used", "Refurb", "New" |
| Format | 70px | center | "Auc." or "BIN" badge |
| Bids | 50px | right | Bid count (auction only), monospace |
| Ends | 90px | right | Countdown timer (auction) or "—" (BIN) |
| Watch conditions | 140px | left | Badges: "Alert < £180", "Max £220" |
| Status | 80px | center | Dot indicator + label |

- Default sort: Urgency (auctions ending soonest, then BIN items by price ascending)
- Sortable columns: Price, Change, Ends, Bids, Hunt
- Row hover: `bg-raised`
- Row click: navigate to `/offers/:id`
- Expandable rows: chevron in first column expands to show watch conditions detail and last evaluation reasoning

**Urgency row highlighting:**
- Auction ending <1h: left border 2px `danger`, urgency dot red
- Auction ending 1-4h: left border 2px `warning`, urgency dot yellow
- No special treatment for >4h or BIN

**Data:** `GET /api/watched`

**Empty state:** "No items being watched" + "The agent will start watching items as it evaluates offers from your hunts"

---

### Page: `/offers/:id` — Offer Detail (US-D5)

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Offers > Dell Optiplex 7080 Micro i5 16GB DDR4       │
├─────────────────────────────────────────────────────┤
│ Dell Optiplex 7080 Micro i5-10500T 16GB DDR4 256GB   │
│ eBay #12345678 • Used • Buy It Now                   │
│ Seller: tech_deals_uk (99.2%)   [View on eBay ↗]    │
│                                                      │
│ ● Watching  •  First seen 3d ago  •  Last seen 2m ago│
│ [Stop Watching] [Dismiss from Hunt]                  │
├─────────────────────────────────────────────────────┤
│ Price History                                        │
│ ┌───────────────────────────────────────────────┐   │
│ │ £189 ────────                                  │   │
│ │              ╲                                  │   │
│ │               ────── £165                       │   │
│ └───────────────────────────────────────────────┘   │
│ Current: £165.00 (landed)  •  -12.7% from first      │
├──────────────────────────┬──────────────────────────┤
│ Specifications           │ Watch Conditions           │
│                          │                            │
│ CPU: i5-10500T           │ Alert below: £180          │
│ RAM: 16GB DDR4           │ Max price: £220            │
│ Storage: 256GB NVMe      │ End time alert: 1h         │
│ Form: Micro              │                            │
│ TDP: ~35W                │                            │
├──────────────────────────┴──────────────────────────┤
│ Hunt Associations                                    │
│ Mini PC Proxmox Node — Status: watching              │
├─────────────────────────────────────────────────────┤
│ Evaluation History                                   │
│ ┌─────────────────────────────────────────────────┐ │
│ │ 2d ago — watch                                   │ │
│ │ "Good match. DDR4, PCIe slot confirmed. Price    │ │
│ │ at £189 is within budget. Setting watch for      │ │
│ │ price drops."                                    │ │
│ ├─────────────────────────────────────────────────┤ │
│ │ 1d ago — alert                                   │ │
│ │ "Price dropped to £165, well below budget.       │ │
│ │ Seller reputable. Recommend buying."             │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ Alert History                                        │
│ 1d ago — HIGH — "Dell Optiplex 7080 dropped to £165" │
│   Response: "I'll think about it" (1d ago)           │
└─────────────────────────────────────────────────────┘
```

**Header:**
- Breadcrumb: `Offers > {title}` (truncated)
- Title: `text-page-title`, full title (may wrap to 2 lines)
- Metadata: source ID (monospace), condition badge, format badge
- Seller: name + rating percentage (green if ≥99%, yellow if 97-99%, red if <97%)
- External link: "View on eBay ↗" opens `offers.url` in new tab
- Status line: watching badge + timestamps
- Actions: "Stop Watching" / "Start Watching" toggle button, "Dismiss from Hunt" danger ghost button (confirmation dialog)

**Price history chart:**
- Recharts `<AreaChart>`
- Area fill: `accent` gradient from 20% opacity at top to 0% at bottom
- Line: `accent`, strokeWidth 2, dot at each observation point (small, 4px)
- X axis: dates
- Y axis: GBP, monospace
- Tooltip: exact price, shipping, total landed GBP, observation timestamp
- Below chart: "Current: £{latest} (landed) • {change}% from first" in text-body

**Specifications:**
- Card rendering `specs_extracted` JSON as key-value pairs
- Key: text-tertiary, right-aligned
- Value: text-primary
- Layout: definition list, 2 columns if >6 specs

**Watch conditions:**
- Card showing current conditions parsed from `watch_conditions` JSON
- Rendered as labeled values: "Alert below: £{price}", "Max price: £{price}"

**Hunt associations:**
- Simple list: hunt name (link) + status badge per hunt
- Data from `hunt_offers` joined with `hunts`

**Evaluation history:**
- Chronological list (newest first)
- Each entry: relative timestamp + decision badge + reasoning text
- Reasoning in text-small, text-secondary, `bg-raised` background block, 12px padding

**Alert history:**
- Chronological list
- Each: timestamp, urgency badge, message sent
- If responded: user response text + response timestamp indented below

**Data:** `GET /api/offers/:id`, `GET /api/offers/:id/prices`

---

### Page: `/searches` — Search Activity (US-D8, US-D9)

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Searches                                             │
├─────────────────────────────────────────────────────┤
│ [Search History]  [Term Effectiveness]                │
├─────────────────────────────────────────────────────┤
│ (Tab: Search History)                                │
│                                                      │
│ Filters: [Hunt ▾] [Date range]                       │
│                                                      │
│ Terms           │Hunt │Results│New│Rel│Time           │
│─────────────────┼─────┼───────┼───┼───┼──────────────│
│ "mini pc proxmx"│Mini │  12   │ 4 │ 3 │ 23m ago      │
│ "optiplex micro"│Mini │  45   │ 0 │ 0 │ 4h ago       │
│ "lenovo tiny"   │Mini │  31   │ 2 │ 1 │ 4h ago       │
│ "x1 carbon g9"  │X1   │   8   │ 0 │ 0 │ 2h ago  ⚠   │
│ ...             │     │       │   │   │              │
│                                                      │
│ Showing 1-25 of 1,204                [< 1 2 3 ... >]│
└─────────────────────────────────────────────────────┘
```

**Tab: Search History**

Table with columns:
| Column | Width | Content |
|--------|-------|---------|
| Terms | flex | Search terms in monospace, quoted |
| Hunt | 120px | Hunt name, linked |
| Results | 70px | `result_count`, right-aligned, monospace |
| New | 50px | `new_offer_count`, right-aligned, monospace. Highlighted green if >0 |
| Relevant | 50px | `relevant_count`, right-aligned, monospace |
| Time | 100px | Relative timestamp |
| Stale indicator | 24px | ⚠ warning icon if last 5 searches for this term had 0 new results |

- Paginated: 50 rows per page
- Default sort: most recent first
- Filter: hunt dropdown, date range picker (shadcn/ui date range picker with calendar)

**Tab: Term Effectiveness (US-D9)**

Grouped by hunt, then by term:

| Column | Content |
|--------|---------|
| Term | Search term |
| Searches | Total count of executions |
| Total results | Sum of result_count |
| New offers | Sum of new_offer_count |
| Avg new/search | Calculated ratio, 1 decimal |
| Trend | Sparkline (last 10 searches' new_offer_count) |
| Status | "Active" / "Stale" badge (stale if last 5 searches = 0 new) |

Sparkline: Recharts `<Sparkline>` — tiny inline area chart (60px wide, 20px tall), stroke `accent`, no axes, no tooltip. Just a visual trend indicator.

**Data:** `GET /api/searches?page={page}&hunt_id={hunt}&from={date}&to={date}`

---

### Page: `/agent` — Agent Activity Feed (US-D11)

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Agent Activity                          ● Live       │
├─────────────────────────────────────────────────────┤
│ ┌─ 3m ago ─────────────────────────────────────────┐│
│ │ 🤖 Watcher: New Offers                           ││
│ │ Duration: 12.4s  •  Session: abc123              ││
│ │ Evaluated 4 offers for "Mini PC Proxmox Node"    ││
│ │ → 1 alert, 2 watch, 1 skip                      ││
│ │                                    [View Log →]  ││
│ └──────────────────────────────────────────────────┘│
│ ┌─ 1h ago ─────────────────────────────────────────┐│
│ │ 📊 Scheduled: Price Update                        ││
│ │ Duration: 8.1s  •  Session: def456               ││
│ │ Updated prices for 14 watched items              ││
│ │ → 3 price changes detected                       ││
│ └──────────────────────────────────────────────────┘│
│ ┌─ 2h ago ─────────────────────────────────────────┐│
│ │ 💬 User Message                                   ││
│ │ Duration: 5.2s  •  Session: ghi789               ││
│ │ ✓ Success                                        ││
│ └──────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

**Feed items:**
- Card per invocation, `bg-surface`, 12px padding
- Header: trigger type icon + label + relative timestamp
- Trigger types with icons:
  - User message: 💬 (message-circle icon)
  - Watcher urgent: 🚨 (alert-triangle icon), `danger` tint
  - Watcher new offers: 🤖 (bot icon)
  - Scheduled: 📊 (calendar icon)
- Details: duration (monospace), session ID (monospace, truncated)
- Result summary: text-secondary, expandable for full detail
- Status: ✓ Success (green) / ✗ Error (red) / ⏱ Timeout (yellow)
- "View Log →" link navigates to `/agent/logs/:id`
- Error entries: `danger-muted` background, error message visible without expanding

**Live indicator:**
- Top right: green dot + "Live" when SSE connected
- New invocations prepend with fade+slide animation
- SSE event: `agent_invocation`

**Data:** `GET /api/agent/activity` + SSE stream

---

### Page: `/agent/evaluations` — Evaluation Performance (US-D12)

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Agent > Evaluations                                  │
├─────────────────────────┬───────────────────────────┤
│ Decision Distribution   │ Decision Trend             │
│    ┌─────┐              │  ████████████████████████  │
│   ╱  12%  ╲             │  ▓▓▓▓▓▓▓▓▓▓▓▓████████──  │
│  │  alert  │            │  ░░░░░░░▓▓▓▓▓▓▓▓████████  │
│  │         │            │  7d      14d       today   │
│   ╲  42%  ╱             │                            │
│    │watch │             │                            │
│     ╲46% ╱              │                            │
│      skip               │                            │
├─────────────────────────┴───────────────────────────┤
│ Recent Evaluations                                   │
│ Filters: [Hunt ▾] [Decision ▾] [Date range]         │
│                                                      │
│ Offer           │Hunt │Decision│Reasoning     │Time  │
│ Dell Optiplex…  │Mini │ alert  │"Price dropped…"│3m  │
│ HP ProDesk…     │Mini │ skip   │"No PCIe slot…" │3m  │
│ Lenovo M720…    │Mini │ watch  │"Good specs bu…" │3m  │
│ ...             │     │        │                │     │
└─────────────────────────────────────────────────────┘
```

**Decision distribution:**
- Recharts `<PieChart>` with `<Pie>` — donut style (innerRadius=60%, outerRadius=80%)
- Segments: alert (`danger`), watch (`success`), skip (`zinc-600`)
- Center text: total evaluation count, text-section-title, monospace
- Labels: outside the donut, percentage + decision name
- No animation on load (feels sluggish), instant render

**Decision trend:**
- Recharts `<AreaChart>` stacked
- Three `<Area>` components stacked (alert, watch, skip)
- Normalized to 100% (percentage stacked)
- X axis: daily buckets
- Colors: same as distribution

**Recent evaluations table:**
- TanStack Table with filters
- Columns: Offer title (linked), Hunt (linked), Decision (badge), Reasoning (truncated, expandable), Timestamp
- Reasoning column: first 60 characters, click to expand row showing full reasoning
- Search box: text search across reasoning field — `GET /api/evaluations?search={query}`
- Paginated: 50 per page

**Data:** `GET /api/evaluations?hunt_id={}&decision={}&from={}&to={}&search={}&page={}`

---

### Page: `/agent/logs` — Container Logs (US-D14)

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ Agent > Logs                                         │
├─────────────────────────────────────────────────────┤
│ Filters: [Date range] [Errors only ☐] [Search: ___] │
├─────────────────────────────────────────────────────┤
│ Timestamp       │Trigger │Duration│Exit│Session       │
│ Mar 26, 14:23   │watcher │ 12.4s  │ 0  │ abc123      │
│ Mar 26, 13:15   │sched.  │  8.1s  │ 0  │ def456      │
│ Mar 26, 11:02   │user    │  5.2s  │ 0  │ ghi789      │
│ Mar 26, 09:30   │watcher │ 45.2s  │ 1  │ jkl012  ✗   │
│                                                      │
│ ▼ Expanded: Mar 26, 09:30 — abc123                   │
│ ┌─────────────────────────────────────────────────┐ │
│ │ [stderr]                                         │ │
│ │ 09:30:01 Starting evaluation...                  │ │
│ │ 09:30:15 Fetching prices for 14 items...        │ │
│ │ 09:30:42 ERROR: eBay API rate limit exceeded    │ │  ← highlighted
│ │ 09:30:42 Retrying in 5s...                      │ │
│ │ 09:30:47 ERROR: eBay API still rate limited     │ │  ← highlighted
│ │ 09:31:15 Process exited with code 1             │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**Log table:**
- Columns: Timestamp (absolute, monospace), Trigger (badge), Duration (monospace), Exit code (monospace, red if non-zero), Session ID (monospace, truncated)
- Row click expands to show full log content
- Error rows: left border 2px `danger`
- Paginated: 25 per page

**Expanded log view:**
- Monospace text, `text-small`, `bg-root` background (darker than card for contrast)
- Line numbers in `text-tertiary`
- Lines containing "ERROR" or "WARN": `danger-muted` / `warning-muted` background highlight
- Search within log: Ctrl+F browser native (no custom search)
- Log content loaded on expand: `GET /api/agent/logs/:id`

**Filters:**
- Date range picker
- "Errors only" checkbox — filters to exit code ≠ 0
- Search: text search across log content (server-side grep)

**Data:** `GET /api/agent/activity` for list, `GET /api/agent/logs/:id` for content

---

### Page: `/system` — Watcher Health (US-D13)

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│ System                                               │
├─────────────────────────────────────────────────────┤
│ ┌──────────────────┬──────────────────┬────────────┐│
│ │ Watcher Status   │ API Budget       │ Last Agent ││
│ │ ● Running        │ ████████░░ 78%   │ 3m ago     ││
│ │ Last: 23m ago    │ 3,510 / 4,500    │ Success    ││
│ └──────────────────┴──────────────────┴────────────┘│
├─────────────────────────────────────────────────────┤
│ Search Schedule                                      │
│                                                      │
│ Hunt              │Cadence│Last Search│Next Expected │
│ Mini PC Node      │ 60m   │ 23m ago   │ in 37m  ✓   │
│ ThinkPad X1       │ 60m   │ Paused    │ —            │
│ Dell Monitor      │120m   │ 1h ago    │ in 1h   ✓   │
├─────────────────────────────────────────────────────┤
│ Recent Errors                                        │
│                                                      │
│ (empty state: "No recent errors — all clear")        │
│ or:                                                  │
│ 2h ago — eBay API rate limit exceeded (search: "...")│
│ 1d ago — Auth token refresh failed                   │
├─────────────────────────────────────────────────────┤
│ API Usage (last 7 days)                              │
│ ┌───────────────────────────────────────────────┐   │
│ │  ▐▐▐▐ ▐▐▐ ▐▐▐▐▐ ▐▐▐ ▐▐▐▐ ▐▐▐ ▐▐▐           │   │
│ │ Mon   Tue  Wed   Thu  Fri  Sat  Sun           │   │
│ └───────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Status cards:**
- Three metric cards in a row

Watcher status logic:
- ● Green "Running": most recent `search_queries.searched_at` is within 2× cadence of the most frequent hunt
- ● Yellow "Slow": most recent search is between 2× and 5× cadence
- ● Red "Stale": most recent search is >5× cadence or >2 hours ago

**Search schedule table:**
- Per active hunt: name, cadence_minutes, last search time (relative), next expected time (calculated: last_search + cadence), on-time indicator
- On-time: ✓ green if next expected is in the future, ✗ red if overdue

**Recent errors:**
- List of errors parsed from watcher logs and agent logs (exit code ≠ 0)
- Each: timestamp, error message, truncated context
- Max 20 recent errors

**API usage chart:**
- Recharts `<BarChart>`, daily bars for last 7 days
- Y axis: API call count
- `<ReferenceLine>` at 4500 (daily budget), dashed red
- Bar color: `accent` normally, `warning` if >80% of budget, `danger` if >95%

**Data:** `GET /api/system/health`

---

## 4. Interaction Design Details

### Navigation Model

**Sidebar behavior:**
- Default: expanded (240px) on desktop ≥1024px, collapsed (56px) on smaller
- Manual toggle via chevron button at sidebar bottom
- Collapsed: icons only, tooltip on hover shows label + badge
- State persisted in `localStorage` key `sidebar-collapsed`

**Keyboard shortcuts:**
| Shortcut | Action |
|----------|--------|
| `Ctrl+K` / `Cmd+K` | Open command palette |
| `g then h` | Go to home (overview) |
| `g then u` | Go to hunts |
| `g then w` | Go to watched |
| `g then s` | Go to searches |
| `g then a` | Go to agent activity |
| `g then y` | Go to system |
| `Escape` | Close modal/palette, exit edit mode |

Vim-style two-key navigation: press `g`, a ghost indicator appears bottom-center showing available second keys for 1.5 seconds.

**Breadcrumbs:** Only on detail/nested pages. Format: `Section > Item Name`. Each segment is a link. No breadcrumbs on top-level pages (the sidebar handles that).

### Drill-Down Pattern

Overview → List → Detail, all as full pages.

- Hunt card click → `/hunts/:id`
- Offer row click → `/offers/:id`
- "View Prices →" link → `/hunts/:id/prices`
- Activity feed item → expand inline (not a new page)
- Log row → expand inline

Transition: Instant. No page transition animation. Data fetching shows skeleton of the target page immediately. TanStack Query provides cached data for instant back-navigation.

### Inline Editing

1. User clicks "Edit" button → edit mode activates
2. Editable fields get subtle `border-focus` border, background shifts to `bg-input`
3. Save/Cancel buttons appear where the Edit button was
4. User modifies fields
5. User clicks Save → optimistic update (UI updates immediately), `PUT` request fires
6. Success → toast "Changes saved", edit mode exits
7. Failure → toast with error, fields revert to server state, edit mode stays active
8. Cancel → revert all changes, exit edit mode

### Filtering and Sorting

**Filter bar design:** Row of shadcn/ui `<Select>` dropdowns above the table. Each dropdown shows its label when no filter is active. When filter is active: dropdown shows selected value, and a pill appears below the filter bar showing `{label}: {value} ×`.

**Active filter display:** Pills row below the filter bar. Each pill: `bg-raised`, text-small, × button to clear. "Clear all" link at the end if >1 filter active.

**Sort indicator:** Column header shows small chevron (▲/▼). Clicking cycles: ascending → descending → no sort. Only one column sorts at a time.

**URL state:** All filter and sort state reflected in URL query params. Example: `/watched?hunt=1&sort=price&dir=asc`. Enables bookmarking and sharing of filtered views. Implemented via `useSearchParams`.

### Real-Time Updates

**SSE new data pattern:**
1. New item received via SSE
2. Item prepends to list/feed with CSS animation: `opacity: 0 → 1` over 300ms, `translateY(-4px) → 0`
3. Brief highlight: `accent-muted` background that fades to transparent over 1500ms

**Price change flash:**
1. SSE `price_change` event received
2. Price cell in any visible table updates
3. Cell background flashes `success-muted` (price drop) or `danger-muted` (price increase) for 1500ms
4. Price value updates with new value

**SSE connection status:**
- Indicator in sidebar bottom: green dot + "Connected" (text-tiny, tertiary)
- On disconnect: yellow dot + "Reconnecting..." — auto-reconnect with exponential backoff
- On prolonged disconnect (>30s): red dot + "Disconnected" — toast notification "Live updates unavailable"
- Stale data indicator: if SSE disconnected >5 minutes, subtle banner at top of main content: "Data may be stale — last update {time ago}" in `warning-muted` background

### Responsive Considerations

| Breakpoint | Sidebar | Layout | Tables |
|-----------|---------|--------|--------|
| ≥1440px | Expanded (240px) | Full grid layouts, 2-column panels | All columns |
| 1024–1439px | Expanded (240px) | Same layouts, slightly compressed | Hide low-priority columns |
| 768–1023px | Collapsed (56px) | Single column where needed | Horizontal scroll on tables |
| <768px | Hidden, hamburger menu | Single column, stacked cards | Card view replacing tables |

Mobile table → card conversion: Each row becomes a card with the key fields. Not a priority — the user is on desktop, but the layout shouldn't break.

---

## 5. Key Design Decisions

### Sidebar vs Top Nav

**Decision:** Sidebar.

**Why:** The navigation has 8+ items with a nested group (Agent sub-pages). A top nav would either truncate or require dropdowns. A sidebar provides always-visible navigation with room for badge counts, sub-items, and the SSE status indicator. It also provides a stable spatial anchor — the user always knows where they are. The collapsible mode handles smaller screens without sacrificing the benefits.

### Cards vs Tables for Hunt Overview

**Decision:** Cards for hunts, tables for everything else.

**Why:** Hunts are the top-level organising concept and there are few of them (typically 3-8). Each hunt has multi-dimensional data that benefits from spatial grouping: the pipeline bar, price range, and search status form a visual "snapshot" that's faster to parse in a card than across table columns. Once you drill into offers, searches, evaluations — these are lists of many items where comparison across rows matters, and tables win.

### Full-Page Detail vs Slide-Over Panel

**Decision:** Full-page for hunt and offer details. Inline expansion for activity items and log entries.

**Why:** Hunt detail has 5+ sections (criteria, search terms, offer pipeline, charts, activity). Offer detail has 4+ sections. These don't fit in a panel without scrolling — and a scrolling panel inside a scrolling page is a UX anti-pattern. Activity items and log entries are simpler (one block of text) and benefit from staying in context of the list.

### Density Management

**The problem:** 7+ data types, charts, tables, feeds — how to avoid overwhelm.

**Solution:** Three-tier information architecture.

1. **Overview page** — aggregated stats only. No tables, no individual items. Just numbers, health indicators, and the last 5 activities. Answers: "Is anything broken? Does anything need my attention?"
2. **List pages** — one data type at a time, with filtering and sorting. Full tables. Answers: "Show me all the {things}."
3. **Detail pages** — everything about one entity. All related data in one place. Answers: "Tell me everything about this specific {thing}."

Within each tier: use typography weight and color to create scannable hierarchy. Primary values in white, supporting context in grey, labels in darker grey. The eye naturally follows brightness.

### Urgency Visual Language

**The problem:** "Auction ending in 2 hours" needs to feel urgent without being annoying (no red flashing, no sound, no popup).

**Solution:** Progressive visual escalation:

| Time remaining | Treatment |
|---------------|-----------|
| >24h | Normal text, text-tertiary color. No special treatment. |
| 4–24h | text-secondary color. Visible but not demanding. |
| 1–4h | `warning` (yellow) text, countdown updates every 60s. Row gets left border 2px yellow. |
| <1h | `danger` (red) text, semibold weight, countdown updates every second. Row gets left border 2px red. On the overview page "Attention Needed" section, this item rises to the top. |
| <15m | Same as <1h but the entire row background gets `danger-muted` (subtle red wash). |

This escalation is visible without being interruptive. The user scanning the watched items table will naturally notice yellow and red entries. No notifications, no modals, no sound — just visual weight increasing as urgency increases.

---

## 6. Signature Design Moments

### 1. The Pipeline Bar

Every hunt card and hunt detail page features a horizontal segmented bar showing the offer pipeline: new → evaluated → watching → dismissed. Each segment is proportionally sized and color-coded. Below it, tiny monospace counts sit under each segment.

**What makes it special:** This single element tells the story of a hunt's health at a glance. A hunt with a fat "new" segment and thin "evaluated" segment means the agent is falling behind. A hunt with all "dismissed" means the search terms might need tuning. A hunt with a healthy "watching" segment means things are working. The user internalizes this visual language quickly and can assess all hunts in under 3 seconds from the overview.

**Implementation:** Custom component. Four `<div>` segments in a flex container with `flex-grow` proportional to count (minimum 4px if non-zero, 0px if zero). Height 6px, segments have 1px gap between them. Colors: info (new), accent (evaluated), success (watching), zinc-600 (dismissed). Below: four `<span>` labels, same flex distribution, text-tiny, monospace, matching colors.

### 2. The Price Flash

When a watched item's price changes (detected via SSE), the price cell in any visible table does a color flash: the cell background goes to `success-muted` (price drop) or `danger-muted` (price increase), then fades back to transparent over 1500ms. The number itself updates to the new value with the color lingering just long enough for the eye to catch it.

**What makes it special:** It gives the dashboard a sense of aliveness. The user isn't staring at static data — they're watching a live market. The flash is subtle enough not to be distracting but visible enough to catch in peripheral vision. It bridges the gap between "checking a dashboard" and "monitoring a feed."

**Implementation:** CSS keyframe animation triggered by a `data-flash` attribute set when SSE delivers a `price_change` event. The attribute is removed after the animation completes (1500ms). Animation: `background-color` from semantic color at 100% to transparent, with easing `cubic-bezier(0.4, 0, 0.2, 1)`.

### 3. The Ghost Key Navigator

Pressing `g` anywhere (outside a text input) shows a minimal floating indicator at the bottom-center of the screen: a small pill with ghosted letter hints — `h` overview, `u` hunts, `w` watched, `s` searches, `a` agent, `y` system. Press the second key to navigate. The pill fades after 1.5 seconds if no second key is pressed.

**What makes it special:** It's the kind of shortcut that power users discover and love. It borrows from Vim's two-key sequences and GitHub's `g` shortcuts. For a single technical user, this turns navigation into a reflex rather than a mouse operation. The floating hint makes it discoverable without a manual.

**Implementation:** Global keydown listener. On `g` press (if not in input/textarea), show a `<div>` fixed bottom-center with `bg-overlay`, `text-tiny`, `text-secondary`, rounded-full, padding 8px 16px. Fade in 100ms. Wait for second keypress (with 1.5s timeout) or Escape to dismiss. On valid second key, navigate via router and dismiss. CSS: `opacity 0→1`, then `opacity 1→0` on timeout.

### 4. The Budget Horizon Line

On the price trend chart (`/hunts/:id/prices`), the hunt's budget ceiling appears as a dashed horizontal reference line in `danger` color, labeled "Budget £200" right-aligned. As price observation lines approach or cross below this line, the area between the price line and the budget line fills with a subtle green gradient — visually showing "you're in the money."

**What makes it special:** It transforms a generic price chart into a deal-hunting instrument. The user doesn't have to mentally compare prices to their budget — the chart does it for them. The green fill below budget creates an immediate emotional signal: "this is the zone I want prices to be in." It makes the abstract concept of "good deal" concrete and visual.

**Implementation:** Recharts `<ReferenceArea>` with y1={budget} and y2={chart minimum}, fill `success` at 6% opacity. `<ReferenceLine>` y={budget}, stroke `danger`, strokeWidth 1, strokeDasharray="8 4". Custom `<Label>` position="right" with "Budget £{amount}" in text-tiny monospace.

### 5. The Stale Pulse

When the SSE connection has been lost for more than 60 seconds, or when any data on the page is older than its expected refresh cadence, a very subtle pulse animation appears on the page's health/status indicators. The SSE dot in the sidebar gently pulses between its warning color and a slightly darker shade. It's not a flash or a blink — it's a slow, breathing pulse (2 second cycle) that creates an almost subconscious unease.

**What makes it special:** Most dashboards show a static "disconnected" label that's easy to ignore. The pulse catches peripheral vision without being aggressive. It creates a visceral sense that "something isn't right" — the same way a pulsing LED on hardware signals attention needed. When the connection restores, the pulse stops and the dot goes solid green, creating a moment of relief. The user's trust in the dashboard's liveness is maintained through this subtle ambient indicator.

**Implementation:** CSS `@keyframes stalePulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }` applied to the SSE indicator dot. Animation: `stalePulse 2s ease-in-out infinite`. Activated by a `data-stale` attribute on the sidebar status element, set/unset by the SSE connection state manager.

---

## Appendix: Tailwind Configuration Excerpt

```js
// tailwind.config.ts — key extensions
{
  theme: {
    extend: {
      colors: {
        surface: '#18181B',
        raised: '#27272A',
        overlay: '#3F3F46',
        accent: {
          DEFAULT: '#8B5CF6',
          hover: '#7C3AED',
          muted: '#8B5CF61A',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'page-title': ['1.5rem', { lineHeight: '2rem', fontWeight: '600' }],
        'section-title': ['1.125rem', { lineHeight: '1.75rem', fontWeight: '600' }],
        'heading': ['0.875rem', { lineHeight: '1.25rem', fontWeight: '600' }],
        'tiny': ['0.6875rem', { lineHeight: '0.875rem', fontWeight: '500' }],
      },
      keyframes: {
        'flash-success': {
          '0%': { backgroundColor: '#22C55E1A' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-danger': {
          '0%': { backgroundColor: '#EF44441A' },
          '100%': { backgroundColor: 'transparent' },
        },
        'stale-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        'feed-in': {
          '0%': { opacity: '0', transform: 'translateY(-4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'flash-success': 'flash-success 1.5s cubic-bezier(0.4, 0, 0.2, 1)',
        'flash-danger': 'flash-danger 1.5s cubic-bezier(0.4, 0, 0.2, 1)',
        'stale-pulse': 'stale-pulse 2s ease-in-out infinite',
        'feed-in': 'feed-in 300ms ease-out',
      },
    },
  },
}
```

---

## Appendix: Component File Structure

```
dashboard/
├── src/
│   ├── app.tsx                    # Router setup, global layout
│   ├── components/
│   │   ├── ui/                    # shadcn/ui components (generated)
│   │   ├── layout/
│   │   │   ├── sidebar.tsx        # Collapsible sidebar navigation
│   │   │   ├── page-header.tsx    # Page title + breadcrumbs
│   │   │   └── health-strip.tsx   # Global health indicator bar
│   │   ├── charts/
│   │   │   ├── price-trend.tsx    # Time-series price chart
│   │   │   ├── price-distribution.tsx  # Histogram
│   │   │   ├── decision-donut.tsx # Evaluation decision breakdown
│   │   │   ├── decision-trend.tsx # Stacked area over time
│   │   │   ├── api-usage-bar.tsx  # Daily API call bar chart
│   │   │   └── sparkline.tsx      # Inline mini chart
│   │   ├── domain/
│   │   │   ├── hunt-card.tsx      # Hunt overview card
│   │   │   ├── pipeline-bar.tsx   # Offer pipeline visualization
│   │   │   ├── offer-row.tsx      # Table row for offers
│   │   │   ├── activity-feed.tsx  # Real-time activity list
│   │   │   ├── countdown.tsx      # Auction end countdown
│   │   │   ├── price-cell.tsx     # Price with flash animation
│   │   │   ├── status-badge.tsx   # Domain-specific status badges
│   │   │   └── metric-card.tsx    # KPI display card
│   │   └── shared/
│   │       ├── filter-bar.tsx     # Reusable filter dropdown row
│   │       ├── ghost-nav.tsx      # g-key navigation overlay
│   │       └── sse-provider.tsx   # SSE connection context
│   ├── pages/
│   │   ├── overview.tsx           # /
│   │   ├── hunts.tsx              # /hunts
│   │   ├── hunt-detail.tsx        # /hunts/:id
│   │   ├── hunt-prices.tsx        # /hunts/:id/prices
│   │   ├── watched.tsx            # /watched
│   │   ├── offer-detail.tsx       # /offers/:id
│   │   ├── searches.tsx           # /searches
│   │   ├── agent-activity.tsx     # /agent
│   │   ├── agent-evaluations.tsx  # /agent/evaluations
│   │   ├── agent-logs.tsx         # /agent/logs
│   │   └── system.tsx             # /system
│   ├── hooks/
│   │   ├── use-sse.ts             # SSE connection and event handling
│   │   ├── use-flash.ts           # Price flash animation trigger
│   │   └── use-ghost-nav.ts       # g-key navigation handler
│   ├── lib/
│   │   ├── api.ts                 # Typed fetch wrappers for all endpoints
│   │   ├── format.ts              # Price, date, duration formatters
│   │   ├── chart-theme.ts         # Recharts color/style defaults
│   │   └── constants.ts           # Colors, breakpoints, timing values
│   └── types/
│       └── api.ts                 # TypeScript types matching API responses
```
