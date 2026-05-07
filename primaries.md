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
- [Per-instance single-consumer serial worker](#per-instance-single-consumer-serial-worker)
- [Cross-asset graph derivation + persisted DAG](#cross-asset-graph-derivation--persisted-dag)

---

## Time-series chart (SVG)

**What it is:** A range-selectable SVG line chart driven by an API endpoint that returns `{ since, until, samples, stats }`. Used for response time, CPU+memory, interface throughput/errors, IPsec bytes, storage usage, sensor temperatures.

**Canonical implementation:** Asset Details → System → **Response Time** graph.
- Loader: `_loadMonitorHistoryFor()` in `public/js/assets.js:4311` — fetches history + polling-method transitions, calls renderer, schedules auto-refresh.
- Renderer: `_renderMonitorChart()` in `public/js/assets.js:4394` — builds the SVG; uses `_chartTimeBounds()` to align to `since`/`until` so empty regions stay visible.
- Range buttons: `_chartRangeButtons()` in `public/js/assets.js:78` — produces the `1h / 24h / 7d / 30d / Custom` toolbar.
- Persistence: `_getChartRangePref(key, fallback)` / `_setChartRangePref(key, range)` in `public/js/assets.js:56-65` — per-user `localStorage.polaris-prefs-charts-<username>` JSON map keyed by chart id (`assetMonitor`, `assetSystem`, `assetSensor`, `assetInterface`, `assetIpsec`, `assetStorage`).
- Tooltip: `_wireChartTooltip(container, formatHTML)` in `public/js/assets.js:3325` — single shared hover handler all charts use.
- Resize: `_observeChartResize(container, rerender)` — re-renders on container resize via ResizeObserver.
- Stats line: `_renderChartStats(container, count, parts)` — single helper every chart calls; produces the canonical `<count> samples · <Label>: <value> · …` shape and writes a plaintext fallback to `container.dataset.summary` for screenshots/tooltips.
- Polling-method badge: `_streamSourceBadgeHTML(asset, stream)` (sync first paint) + `_updateStreamSourceBadgesFromEffective(assetId, asset)` (async overwrite from `/effective-monitor-settings`). Renders `<method> (<details>) · every <interval> · <tier>`.

**Key conventions:**
- API returns `{ range, since, until, samples[], stats }`. Custom ranges return `range: "custom"`.
- Loader writes the active selection onto the SVG container's `dataset.range` (or `dataset.from` + `dataset.to`) so probe-now / silent ticks can refetch the same view.
- "Custom" ranges do **not** auto-refresh; preset ranges do, on the resolved monitor interval (`_refreshIntervalMs`).
- Silent refresh ticks capture/restore `panelBody.scrollTop` around the swap so the slide-over doesn't jump.
- Range selection is persisted; "Custom" from/to inputs intentionally are not.
- **Stats line:** call `_renderChartStats(container, count, [{label, value}, …])`. Leading `<strong>{count}</strong> samples` span, then one `<span><strong>{Label}:</strong> {value}</span>` per metric, joined by flex gap. **No** "current/as-of" prose inside the stats line — current readings go in the Status block above the charts, modeled on `Last Response Time` / `Last Poll`. **Each chart owns its own stats line** (don't share one stats container across two charts — see Interface throughput vs errors).
- **Polling-method badge:** every chart's section header carries one. Sync render uses the per-asset override only as a coarse first guess; the async path overwrites with the authoritative resolved value (covers class / integration / manual tiers). Cadence in the badge comes from the same resolved settings as the polling method, NOT a separate lookup.

**When adding a new instance:**
- Pick a unique chart id and add it to the prefs key list above.
- Reuse `_chartRangeButtons` for the toolbar — don't roll your own.
- Wire `_wireChartTooltip` and `_observeChartResize` — every existing chart does, and skipping breaks behavior parity.
- Attach the loader's persisted range to the container dataset so silent refresh and probe-now refetch the same window.
- Use `_renderChartStats` for the stats line. If your chart has additional "current" readings worth showing, put them in the Status block (or a sibling section that mirrors Status), not inline in the stats line.
- Stats values must come from `data.stats` server-side or be derived once from the same samples the chart renders — don't duplicate aggregation logic.
- Add a polling-method badge to the section header via `_streamSourceBadgeHTML` whenever the chart's data is delivered by a configurable polling stream (response-time / telemetry / interfaces / lldp).
- If the data is unsupported on some monitor transports (e.g. ICMP/SSH), render an empty-state message — don't show an empty chart.

---

## Modal

**What it is:** A centered, draggable modal dialog with header / body / footer, used for forms, confirmations, and inline detail editors.

**Canonical implementation:** `openModal(title, bodyHTML, footerHTML, options)` in `public/js/app.js:950`. Companion: `closeModal()` at `public/js/app.js:1004`, `showConfirm(message)` at `public/js/app.js:1011`.

**Key conventions:**
- Single shared `#modal-overlay` element appended to `document.body` on first call; reused across opens.
- DOM shape: `.modal-overlay > .modal > [.modal-header, .modal-body, .modal-footer]`.
- Width variants: `options.wide` adds `.modal-wide`; `options.xl` adds `.modal-xl`. Default is the standard width.
- Sticky inner tab strip: when a modal body uses `.page-tabs` as a direct child (e.g. integration edit), the strip is auto-pinned to the top of the scrolling `.modal-body` via the `.modal-body > .page-tabs` rule in `styles.css`. Don't roll your own sticky positioning. Nested sub-tab strips (deeper than direct child) are intentionally not sticky.
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

---

## Per-instance single-consumer serial worker

**What it is:** A FIFO queue + single consumer used to serialize all traffic to a flaky external system whose own concurrency limits would otherwise drop parallel connections. Distinct from a worker pool — the cap is hard-coded to 1, and the value is cross-feature serialization (every code path that talks to the system funnels through the same queue) rather than throttling.

**Canonical implementation:** `FmgWorker` in [src/services/fmgWorker.ts](src/services/fmgWorker.ts). One `FmgWorker` per integration id; module-level `Map<integrationId, FmgWorker>` keyed off the integration row's id.

**Key conventions:**
- Public API is just `submit<T>(label: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T>` plus read-only `queueDepth` / `inFlightLabel` for telemetry. Don't expose the queue itself.
- FIFO single-consumer drain loop owned by the class — caller `submit()`s and awaits the returned promise. Caller never touches the queue directly.
- AbortSignal handling: pre-dispatch abort drops the entry from the queue and rejects with `AbortError(...)` (a custom subclass of Error with `name = "AbortError"`). In-flight abort is the *task's* responsibility (via fetch signal threading) — the worker doesn't force-cancel.
- Lazy creation, never torn down. `getFmgWorker(id)` returns the existing worker or creates one. Workers leak on integration-delete; that's intentional (cheap; tearing down races with concurrent `getXxxWorker` callers).
- Telemetry: every queue depth change publishes a Prometheus gauge (`polaris_fmg_worker_queue_depth{integrationId}`); inflight is a 0/1 gauge so operators can correlate `queue_depth>0 AND inflight=1` as "FMG is the bottleneck right now."
- Test reset: provide a `__resetXxxWorkersForTests()` symbol so tests start with a clean registry without relying on module-cache reset.
- Label is a short string used for telemetry (`inFlightLabel`) and audit logs. Format like `"fmg.<rpcMethod>:<resourceUrl>"` — derived from the inner task, not freeform.
- The wrapping point should be the SHARED low-level helper that every code path goes through (in FmgWorker's case, `rpc()` in `fortimanagerService.ts`). Wrapping individual high-level functions instead means future contributors can add a NEW high-level function that bypasses the worker.

**When adding a new instance:**
- Identify the shared low-level helper that all callers funnel through. Wrap THAT in `getXxxWorker(id).submit(...)`. Don't scatter `pLimit(1)` wraps at every entry point — the next contributor will forget one.
- Thread the keying id (typically integrationId) through every public function that ends up calling the helper. The id flows from the route handler → service → low-level helper.
- Public functions take the id as the LAST optional parameter so unsaved-state callers (e.g. pre-create test connection on a draft integration) can omit it; in that case the worker is bypassed and the call runs direct (no contention possible since there's no other code talking to this instance yet).
- Wire two gauges to `src/metrics.ts`: queue depth (count) and inflight (0/1). Keep the metric names parallel to FmgWorker's so dashboards generalize.
- Document a "load-bearing test": one task A in-flight against the worker, submit task B from a different feature surface, confirm B waits until A completes. This is the cross-feature-serialization invariant the primitive exists to enforce.

---

## Cross-asset graph derivation + persisted DAG

**What it is:** A dependency / topology graph derived from heterogeneous discovery signals (controller-stamped fields + interface-name inference + LLDP), persisted as parent→child edges with a per-node BFS layer, refreshed at end of every discovery cycle, and read by both runtime logic (e.g. monitoring suppression) and the topology UI. Distinct from a per-request topology computation — persisting the DAG gives runtime callers a single source of truth without re-walking signals on every probe.

**Canonical implementation:** `recomputeDependencyTree()` + `reconcileDependencySuppression()` + `propagateAfterStatusChange()` in [src/services/dependencyTreeService.ts](src/services/dependencyTreeService.ts), backed by the `AssetDependencyParent` model + `Asset.dependencyLayer` / `Asset.dependencySuppressed` columns.

**Key conventions:**
- **Pure helpers exported for tests.** `buildDependencyEdgesFromInputs(assets, interfaceEdges, lldpEdges)`, `assignLayers(assets, edges)`, `evaluateSuppression(states, parents)` are pure functions — no DB, no side effects. The DB-bound `recomputeDependencyTree` / `reconcileDependencySuppression` are thin wrappers that load inputs, call the pure helper, and write the diff. New tests cover the pure helpers; the wrappers are exercised via integration tests.
- **Signal precedence at edge-build time.** When the same parent→child pair surfaces from multiple signals, keep the strongest. Convention: controller (3) > interface (2) > lldp (1). Implemented as a `(child|parent) → {edge, strength}` map that tracks the winner.
- **BFS layer assignment from a known root set, with edge pruning.** Layer-1 nodes are assigned by domain rule (here: every FortiGate). BFS outward; a candidate edge is kept only when `layer[parent] + 1 === layer[child]`. Same-layer edges (siblings, MCLAG pairs) and reverse edges are dropped. Cycles can't form once layers are settled — disconnected components or chains through unmonitored intermediates surface as `unresolved`.
- **Persistence is replace-and-recreate per scope, not diff.** `recomputeDependencyTree(integrationId)` deletes computed rows for in-scope assets, re-inserts from `keptEdges`, updates `dependencyLayer` — all in one `prisma.$transaction`. Operator override rows (`source="override"`) are never touched. In-scope is the integration's discovered assets; out-of-scope rows are owned by another integration's recompute and left alone.
- **Override resolution at read time.** When loading effective parents, "if any override row exists for an asset, use the override set; else use the computed set." Empty override set = explicit "no parents" pin. Read-time resolution avoids any write coupling between operator edits and discovery cycles.
- **Reconciler is the source of truth for runtime state; event hook is a latency optimization.** The 60s `reconcileDependencySuppression()` walks every monitored asset in BFS layer order, computes desired suppression under the domain rule (here: all-down multi-parent), writes only diffs. The event hook (`propagateAfterStatusChange`) calls the same reconciler on every probe-result transition for sub-second propagation, but correctness never depends on it firing — server restart mid-transition / race / dropped event are all caught by the next periodic tick.
- **Discovery hook runs at the END of the discovery function**, after all asset writes and projection-apply phases — not interleaved. Gated on `mode in {full, finalize}` so per-device skip-deprecation passes don't trigger partial recomputes.
- **One-shot startup backfill** (`backfillDependencyTree.ts`) runs `recomputeDependencyTree()` 30 s after boot so existing installs see populated rows without waiting for the next scheduled discovery cycle.

**When adding a new instance:**
- Identify your domain's "layer-1 root rule" (here: assetType === "firewall"). Hardcoded in the BFS layer assigner; write tests that cover the orphan case (no path from any root → null layer).
- Define your edge-strength order over the available signals. Document it in the service header comment so future contributors don't re-litigate which signal wins.
- Pick the "in-scope" axis for incremental recompute (here: `discoveredByIntegrationId`). The full graph load is cheap; the per-scope writeback is what matters for keeping cycles isolated to the active integration's writes.
- Pure helpers go in the service file with explicit `export`. DB-bound wrappers stay in the same file but mark them clearly with a comment header so test contributors know which functions to mock vs which to call directly.
- Add a touches.md cross-cutting section on day one — runtime callers and UI surfaces will discover the DAG quickly and reach for it; the index keeps the writers/readers visible.
