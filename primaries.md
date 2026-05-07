# Polaris — Primaries Index

A lookup index of **canonical implementations** to model new work after. Answers the question **"there are five places that already do this — which one is the reference?"**

This file complements [CLAUDE.md](CLAUDE.md) (narrative architecture) and [touches.md](touches.md) (cross-cutting writers/readers/invariants). Use `primaries.md` whenever you're about to build a new instance of a pattern that already exists somewhere — pick the canonical one and copy its shape.

## How to use

1. Find the pattern that matches what you're building (chart, modal, slide-over, sortable table, etc.).
2. Open the **Canonical implementation** file/line and read it.
3. Match its conventions — DOM structure, helper calls, persistence keys, refresh model.
4. Only diverge when the new surface genuinely needs something the canonical doesn't (note the divergence in your PR).
5. **Keep this file current.** Per CLAUDE.md's commit-review rule, every commit re-reads `primaries.md` for staleness — if your change replaced the canonical, moved its file, or invalidated a convention, fix it in the same commit.

## Format

Per-pattern sections:
- **What it is** — one-sentence scope
- **Canonical implementation** — entry-point function + file:line
- **Key conventions** — DOM/data shape, helpers, persistence keys, refresh model
- **When adding a new instance** — checklist before merging

## Sections

- [Time-series chart (SVG)](#time-series-chart-svg)
- [Modal](#modal)
- [Slide-over panel](#slide-over-panel)
- [Sortable + filterable data table](#sortable--filterable-data-table)

---

## Time-series chart (SVG)

**What it is:** A range-selectable SVG line chart driven by an API endpoint that returns `{ since, until, samples, stats }`. Used for response time, CPU+memory, interface throughput/errors, IPsec bytes, storage usage, sensor temperatures.

**Canonical implementation:** Asset Details → System → **Response Time** graph.
- Loader: `_loadMonitorHistoryFor()` in `public/js/assets.js:4311` — fetches history + polling-method transitions, calls renderer, schedules auto-refresh.
- Renderer: `_renderMonitorChart()` in `public/js/assets.js:4394` — builds the SVG; uses `_chartTimeBounds()` to align to `since`/`until` so empty regions stay visible.
- Range buttons: `_chartRangeButtons()` in `public/js/assets.js:78` — produces the `1h / 24h / 7d / 30d / Custom` toolbar.
- Persistence: `_getChartRangePref(key, fallback)` / `_setChartRangePref(key, range)` in `public/js/assets.js:56-65` — per-user `localStorage.polaris-prefs-charts-<username>` JSON map keyed by chart id (`assetMonitor`, `assetSystem`, `assetSensor`, `assetInterface`, `assetIpsec`, `assetStorage`).
- Tooltip: `_wireChartTooltip(container, formatHTML)` in `public/js/assets.js:3325` — single shared hover handler all charts use.
- Resize: `_observeChartResize(container, rerender)` in `public/js/assets.js:3358` — re-renders on container resize via ResizeObserver.

**Key conventions:**
- API returns `{ range, since, until, samples[], stats }`. Custom ranges return `range: "custom"`.
- Loader writes the active selection onto the SVG container's `dataset.range` (or `dataset.from` + `dataset.to`) so probe-now / silent ticks can refetch the same view.
- Stats strip lives in a sibling `<div>` and is rebuilt from `data.stats` on each load.
- "Custom" ranges do **not** auto-refresh; preset ranges do, on the resolved monitor interval (`_refreshIntervalMs`).
- Silent refresh ticks capture/restore `panelBody.scrollTop` around the swap so the slide-over doesn't jump.
- Range selection is persisted; "Custom" from/to inputs intentionally are not.

**When adding a new instance:**
- Pick a unique chart id and add it to the prefs key list above.
- Reuse `_chartRangeButtons` for the toolbar — don't roll your own.
- Wire `_wireChartTooltip` and `_observeChartResize` — every existing chart does, and skipping breaks behavior parity.
- Attach the loader's persisted range to the container dataset so silent refresh and probe-now refetch the same window.
- Stats summary (if shown) must be rebuilt from `data.stats` server-side, not derived in JS.
- If the data is unsupported on some monitor transports (e.g. ICMP/SSH), render an empty-state message — don't show an empty chart.

---

## Modal

**What it is:** A centered, draggable modal dialog with header / body / footer, used for forms, confirmations, and inline detail editors.

**Canonical implementation:** `openModal(title, bodyHTML, footerHTML, options)` in `public/js/app.js:950`. Companion: `closeModal()` at `public/js/app.js:1004`, `showConfirm(message)` at `public/js/app.js:1011`.

**Key conventions:**
- Single shared `#modal-overlay` element appended to `document.body` on first call; reused across opens.
- DOM shape: `.modal-overlay > .modal > [.modal-header, .modal-body, .modal-footer]`.
- Width variants: `options.wide` adds `.modal-wide`; `options.xl` adds `.modal-xl`. Default is the standard width.
- Header is the drag handle (mousedown anywhere outside `.modal-close`).
- Backdrop click flashes the close button instead of dismissing — explicit close only, to protect in-progress edits.
- Confirms use `showConfirm()`, which returns a Promise — never use `window.confirm()` (won't render in some browser/embed contexts).

**When adding a new instance:**
- Call `openModal(title, bodyHTML, footerHTML, options)` — do not hand-roll a new overlay element.
- Footer buttons close via explicit `closeModal()` calls bound after open.
- For destructive actions, wrap with `await showConfirm(...)` first.
- For wide forms (multi-column / tabbed), pass `{ wide: true }`; reserve `{ xl: true }` for genuinely dense UIs (allocation preview, etc.).
- Re-bind any DOM listeners after each open — the body HTML is replaced wholesale.

---

## Slide-over panel

**What it is:** A right-edge resizable detail panel for entity views (asset details, network/IP details, block details, lease lookups). Distinct from a modal: persistent header + scrollable body, can stay open while the user interacts with the underlying page.

**Canonical implementation:** Asset Details panel built by `_ensureAssetPanelDOM()` in `public/js/assets.js:1890`; opened by `openViewModal(id)` at `public/js/assets.js:1925`.

**Key conventions:**
- Single overlay per page, lazily created on first open and reused.
- DOM shape:
  ```
  .slideover-overlay > .slideover >
    .slideover-resize-handle
    .slideover-header > [.slideover-header-top (h3 + close), .slideover-meta]
    .slideover-body
    .slideover-footer
  ```
- Width persistence: call `initSlideoverResize(panelEl, "polaris.panel.width.<name>")` from `public/js/app.js`. Each surface uses its own localStorage key.
- Backdrop click closes (target equality check on `.slideover-overlay`).
- Open animation: append/build, then `requestAnimationFrame(() => overlay.classList.add("open"))` on the next frame to trigger the CSS transition.
- Auto-refresh timers (e.g. monitor chart, system tab) gate on `_isOverlayOpen("<panel-overlay>")` and `_isCurrentAsset(id)` — close cancels pending ticks via `_clearAssetRefreshTimers()` so a closed panel never fires API requests.
- Nested slide-overs (interface / storage / sensor / IPsec drilldowns) layer on top of the asset panel and only the topmost closes on the close button — see the interface slide-over pattern in assets.js for the layering rules.

**When adding a new instance:**
- Reuse the `slideover-*` CSS classes; do not invent new container styles.
- Wire `initSlideoverResize` with a unique localStorage key.
- All async data loaders gate on the overlay being open (and on the entity being current) before writing into the body — defends against late responses landing after the user navigated away.
- Cancel any timers in the panel's `close*()` function.
- Silent refresh ticks must capture/restore `panelBody.scrollTop` around the swap (see `_loadMonitorHistoryFor` and `_loadSystemTabFor`).

---

## Sortable + filterable data table

**What it is:** A `<table>` with per-column sort, inline filter, and (optionally) multi-select dropdown filters. Used for the assets, subnets, blocks, reservations, integrations, events, users, MIBs, and credentials lists.

**Canonical implementation:** `TableSF` in `public/js/table-sf.js:20`. Used by every list page; the assets table at `public/assets.html` + `public/js/assets.js` is the most feature-complete example.

**Key conventions:**
- Mark sortable/filterable columns on `<th>` with:
  - `data-sf-key="<dotted.path>"` — supports nested keys (`block.name`, `_count.subnets`).
  - `data-sf-type="string|number|date|ip|array"` — defaults to `string`.
  - `data-sf-options="value1|value2=Label2|value3"` — when present, renders a multi-select checkbox popover instead of a free-text input.
- Construct once after rendering the static `<thead>`: `var sf = new TableSF("<tbody-id>", onChange);`.
- Pipe raw rows through `sf.apply(rawData)` before rendering — sort + filters are applied there.
- The `onChange` callback re-runs the row renderer; never mutate `rawData` in place.
- Multi-select filters store an **array** of values matched case-insensitively against the row value via exact equality.
- Status / type / monitored-state pills used as cells should remain plain DOM (not React/components) so `data-sf-key` reads them via the underlying value, not display HTML.

**When adding a new instance:**
- Use `TableSF` — do not hand-roll sort/filter logic per page.
- For enum-style columns (status, role, type), prefer `data-sf-options` over a free-text input — operators almost always want exact-match.
- For columns whose displayed text differs from the underlying value (badges, formatted dates), pull the raw value from the row and stash it as the display source — never let the `data-sf-key` resolution diverge from what the user sees.
- Pagination, if needed, lives **outside** `TableSF` (apply pagination after `sf.apply()`).
- Always wire `onChange` to the render function so filter/sort updates live-refresh.
