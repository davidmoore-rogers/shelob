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
- [Setting-backed admin CRUD with periodic + on-demand reconciler](#setting-backed-admin-crud-with-periodic--on-demand-reconciler)

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
- **Stale-data banner:** sections rendering `lastTelemetryAt` / `lastSystemInfoAt` / `lastTemperatureAt`-driven data prepend `_staleBannerHTML(assetId, asset, streamKey, lastAt)` (in `public/js/assets.js`). `streamKey` is `"telemetry"` (CPU / memory / temps) or `"systemInfo"` (interfaces / storage / IPsec / LLDP). Banner appears only when `lastAt` is older than 3× the resolved polling interval. Resolution priority: `_effectiveResolvedByAssetId` (full `/effective-monitor-settings` walk — covers per-asset / class override / integration / manual tiers) → per-asset override → manual tier from `_monitorSettingsCache` → hardcoded floor (60s telemetry / 600s systemInfo). Output is a `.asset-stale-banner-slot` wrapper so `_updateStaleBannersFromEffective(assetId, asset)` can re-evaluate after the eff fetch lands — the sync first paint can't see a class override, the async pass picks it up. The two `effectiveMonitorSettings()` callers (`_populateAssetMonitorTierBadges`, `_updateStreamSourceBadgesFromEffective`) plus the response-time chart loader all populate the cache + fire the re-evaluator on success.

**When adding a new instance:**
- Pick a unique chart id and add it to the prefs key list above.
- Reuse `_chartRangeButtons` for the toolbar — don't roll your own.
- Wire `_wireChartTooltip` and `_observeChartResize` — every existing chart does, and skipping breaks behavior parity.
- Attach the loader's persisted range to the container dataset so silent refresh and probe-now refetch the same window.
- Use `_renderChartStats` for the stats line. If your chart has additional "current" readings worth showing, put them in the Status block (or a sibling section that mirrors Status), not inline in the stats line.
- Stats values must come from `data.stats` server-side or be derived once from the same samples the chart renders — don't duplicate aggregation logic.
- Add a polling-method badge to the section header via `_streamSourceBadgeHTML` whenever the chart's data is delivered by a configurable polling stream (response-time / telemetry / interfaces / lldp).
- If the data is unsupported on some monitor transports (e.g. ICMP/SSH), render an empty-state message — don't show an empty chart.
- Prepend `_staleBannerHTML(assetId, asset, streamKey, lastAt)` whenever the section renders sample data driven by a `last*At` timestamp. Use `streamKey: "telemetry"` for CPU / memory / temperature surfaces and `streamKey: "systemInfo"` for interface / storage / IPsec / LLDP surfaces. The slot wrapper auto-rehydrates when `/effective-monitor-settings` resolves — no manual await needed.

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

## Per-instance multi-lane worker (constrained + unconstrained endpoints)

**What it is:** A per-instance worker that segregates traffic to a flaky external system by endpoint family — endpoints subject to the system's parallel-connection limit ride a strict single-consumer FIFO lane (concurrency=1); endpoints without that constraint ride an unbounded lane that just tracks inflight count for observability. Distinct from a single-cap worker pool: the value is *cross-feature serialization for the constrained endpoints only*, while letting unconstrained endpoints parallelize freely.

**Canonical implementation:** `FmgWorker` in [src/services/fmgWorker.ts](src/services/fmgWorker.ts). One `FmgWorker` per integration id; module-level `Map<integrationId, FmgWorker>` keyed off the integration row's id. Proxy lane (strict 1) carries `/sys/proxy/json` calls — FMG drops parallel calls past 1-2 there. Native lane (unbounded) carries every other call (`/pm/config/...`, `/dvmdb/...`, auth) — those hit FMG's own DB and have no parallel-call constraint.

**Key conventions:**
- Public API is two submit methods: `submitProxy<T>(label, task, signal): Promise<T>` (strict lane) and `submitNative<T>(label, task, signal): Promise<T>` (unbounded lane). Plus read-only `proxyQueueDepth` / `proxyInFlightLabel` / `nativeInFlightCount` for telemetry. Don't expose the queue itself.
- Lane dispatch lives at ONE call site — the shared low-level helper that every code path funnels through (in FmgWorker's case, `rpc()` in `fortimanagerService.ts`). The helper inspects the payload (e.g. URL pattern) and routes to the right lane. Callers above the helper don't pick the lane.
- Proxy lane: FIFO single-consumer drain loop owned by the class. AbortSignal pre-dispatch drops the entry and rejects with `AbortError(...)`. In-flight abort is the *task's* responsibility (via fetch signal threading) — the worker doesn't force-cancel.
- Native lane: no queue, no semaphore. `submitNative` just bumps an inflight counter, awaits the task, and decrements (in a finally so throws don't leak the counter). Pre-submit abort throws `AbortError` immediately; in-flight abort is the task's responsibility via the fetch signal.
- Lazy creation, never torn down. `getXxxWorker(id)` returns the existing worker or creates one. Workers leak on instance-delete; that's intentional (cheap; tearing down races with concurrent `getXxxWorker` callers).
- Telemetry: proxy lane publishes queue-depth gauge + 0/1 inflight gauge so operators can spot `queue_depth>0 AND inflight=1` as "constrained lane is the bottleneck." Native lane publishes a single inflight-count gauge — sustained high values indicate genuine parallelism (good), not a bottleneck.
- Test reset: provide a `__resetXxxWorkersForTests()` symbol so tests start with a clean registry.
- Label is a short string used for telemetry and audit logs. Format like `"fmg.<rpcMethod>:<resourceUrl>"` — derived from the inner task, not freeform.

**When adding a new instance:**
- Identify the shared low-level helper that all callers funnel through. The lane-dispatch predicate lives ONLY in that helper. Don't scatter `submitProxy` / `submitNative` calls across high-level entry points — the next contributor will forget one.
- Decide which endpoints belong in the constrained lane. Document the rule in the worker file's header so future code paths route correctly. For FmgWorker: `/sys/proxy/json` ⇒ proxy lane, everything else ⇒ native lane.
- Thread the keying id (typically integrationId) through every public function that ends up calling the helper. The id flows from the route handler → service → low-level helper.
- Public functions take the id as the LAST optional parameter so unsaved-state callers (e.g. pre-create test connection on a draft integration) can omit it; in that case the worker is bypassed and the call runs direct (no contention possible since there's no other code talking to this instance yet).
- Wire three gauges to `src/metrics.ts`: proxy-lane queue depth (count), proxy-lane inflight (0/1), native-lane inflight (count). Keep names parallel to FmgWorker's so dashboards generalize.
- Document the "load-bearing tests" for both lanes:
  - Proxy lane: one proxy task A in-flight, submit proxy task B from a different feature surface, confirm B waits until A completes. This is the cross-feature-serialization invariant the constrained lane exists to enforce.
  - Native lane: submit three native tasks simultaneously, confirm all three are started concurrently (not queued).
  - Cross-lane independence: a blocked proxy task does NOT block native tasks, and vice versa.

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

---

## Setting-backed admin CRUD with periodic + on-demand reconciler

**What it is:** A small, admin-managed collection of configuration objects (allocation templates, map regions, …) persisted as a JSON blob in the `Setting` table, with a CRUD API and an optional reconciler that propagates each object's effects through the rest of the system. The reconciler runs inline on every CRUD edit (so operators see immediate effect) AND on a periodic safety-net job (so anything the inline path missed gets caught — restart mid-edit, external state drift, etc.).

**Canonical implementations (parallel):**
- **No reconciler** (storage-only): `allocationTemplateService` in [src/services/allocationTemplateService.ts](src/services/allocationTemplateService.ts) + [src/api/routes/allocationTemplates.ts](src/api/routes/allocationTemplates.ts).
- **With reconciler** (storage + side effects on other entities): `mapRegionService` in [src/services/mapRegionService.ts](src/services/mapRegionService.ts) + [src/api/routes/mapRegions.ts](src/api/routes/mapRegions.ts) + [src/jobs/reconcileMapRegions.ts](src/jobs/reconcileMapRegions.ts).

**Key conventions:**
- **Storage shape.** Single `Setting` row keyed on a stable string (`"networkAllocationTemplates"`, `"mapRegions"`); the `value` JSON is an array of records each carrying its own UUID id (don't store as an object map keyed by id — operators reorder, services iterate, an array preserves intent). Helpers `loadAll()` / `persistAll()` go through `prisma.setting.upsert`.
- **Validation lives in the service, not the route.** Route uses a Zod schema for shape + obvious bounds; service re-validates and throws `AppError(400 | 404 | 409)` for semantic rules (uniqueness, cross-record consistency). The service is the source of truth so non-route callers (jobs, other services) get the same protection.
- **Uniqueness on user-visible names is case-insensitive.** Block renames onto another record's name with a 409. Don't rely on Postgres uniqueness — the Setting JSON has none.
- **Reconciler is additive when possible.** Inline reconciler runs after every create/update/delete (await before responding so the operator sees consistent state on the next page load). Periodic job calls the same reconciler add-only; explicit cleanup (rename, delete) is owned by the route handler so the periodic tick has nothing stale to clean up. See `mapRegionService` for the full pattern: rename = strip-old + add-new, delete = strip, periodic = add-only.
- **Audit trail.** Each CRUD route writes a `<resource>.<verb>` Event via `logEvent()` (`region.created` / `region.updated` / `region.deleted`); the reconciler writes a separate `<resource>.tags_reconciled`-style event when something actually changed (don't spam events on no-op cycles). Inline reconcile events are children of the CRUD event; periodic ones stand alone.
- **Auth gate.** `requireNetworkAdmin` (or `requireAdmin` for a more sensitive surface) at the route mount — pick the gate that matches the audience that should be able to see + edit. If the surface only renders while editing (e.g. map regions), gate read access too so non-editors never need the data.
- **Tag registry mirror (when applicable).** If the reconciled effect is "stamp a tag onto assets," upsert a corresponding `Tag` registry row on create, rotate it on rename, delete it on delete. Operators expect managed tags to appear in the same picker as manual tags.

**When adding a new instance:**
- Pick a unique `Setting` key. Document it in CLAUDE.md's Setting "Notable keys" list.
- Mirror the public service API to `allocationTemplateService` (storage-only) or `mapRegionService` (with reconciler) — pick the closer one and copy its shape verbatim.
- Service-level uniqueness validation must run before persistence. Tests cover the create-create / update-rename collision.
- If you have a reconciler: provide three entry points — `applyOne(record)` (used inline by create / polygon-only update), `applyRename(record, previousName)` (rename branch), `applyDelete(record)` (delete branch), and `reconcileAll()` (periodic + discovery hook). Periodic job uses the additive `reconcileAll()`; never call the rename/delete helpers from there (those are CRUD-only).
- Add a touches.md `services/<feature>.ts` section for the service AND a cross-cutting section if your reconciler writes to a shared namespace (e.g. asset tags). The index keeps the additive vs authoritative writer split visible.

---

## Discovery-driven managed tag namespace

**What it is:** A breadcrumb tag prefix (`firewall:`, future analogues) stamped on assets purely from data already written by FMG / FortiGate discovery. No operator CRUD, no Setting blob — every input that drives the tag set comes from discovery itself, so end-of-discovery is the natural and only reconciliation point. Distinct from the **Setting-backed admin CRUD with reconciler** pattern above, which has operator-edited inputs (polygons, names) and therefore needs a periodic safety net to catch out-of-band edits.

**Canonical implementation:** `firewallTagService` in [src/services/firewallTagService.ts](src/services/firewallTagService.ts), wired into [src/api/routes/integrations.ts](src/api/routes/integrations.ts) at Phase 2a (decommission strip), Phase 3 firewall create (registry seed), Phase 3 firewall update (rename rotation), and Phase 13.5 (end-of-sync reconciler). No periodic job.

**Key conventions:**
- **Single owner per prefix.** Document the prefix in [touches.md](touches.md) under the cross-cutting "Asset.tags writers" section. Don't add a second writer to `firewall:*` (or whatever your prefix is) — pick a different prefix.
- **Strip allowlist scoped to the integration's owned set.** The reconciler computes "tags I'm allowed to remove" as `firewall:<hostname>` for every active firewall this integration discovered. Tags pointing at FortiGates owned by other integrations or operator-typed `firewall:fake` survive every pass. Without this scoping, two integrations would fight over the same asset's tags.
- **Self-attribution skip.** A FortiGate firewall asset never gets its own `firewall:<own-hostname>` tag. Bake the skip into the membership compute.
- **Per-asset diff write.** Read current `Asset.tags`, compute expected, walk both sets to build the next array (carry non-`firewall:*` tags through; keep allowlist-external `firewall:*` tags; add expected; drop allowlist-internal expected-misses). Update only when the array actually differs — most reconciler ticks should be no-ops on healthy fleets.
- **Inline lifecycle hooks.** The four Phase wiring points cover the cases the periodic reconciler can't reach in time:
  - Phase 2a — `applyDecommission(hostname)` strips the tag everywhere + drops the registry row, so a removed FortiGate stops being a filterable option immediately.
  - Phase 3 create — `seedRegistry(hostname)` upserts the registry row so the tag picker carries the entry from day one.
  - Phase 3 update — `applyRename(old, new)` rotates the tag on every dependent asset + the registry row when the projected hostname differs from the existing value.
  - Phase 13.5 — full reconcile after Phase 13 (map-region pass), gated `mode in {"full", "finalize"}`.
- **No periodic safety-net job.** If every input is discovery-written, there's nothing for a periodic tick to catch that the next discovery won't. Don't copy the `reconcileMapRegions.ts` job pattern — it exists because polygon edits and firewall lat/lng updates are operator-driven outside discovery, which doesn't apply here.
- **Tag registry mirror.** Upsert a `Tag` row at `<prefix><value>` under a category that names the namespace (e.g. `"FortiGate"`) so operators see the managed tags in the same picker as manual tags. Idempotent re-upserts in the reconciler keep the registry intact even after manual deletions.
- **Best-effort everywhere.** Wrap every Phase hook + the reconciler call in try/catch and `syncLog("error", ...)` so a tag failure never blocks the sync return. Tags are derived state — losing a write means at most one cycle of stale tags.

**When adding a new instance:**
- Pick a unique tag prefix and a registry category. Document both in [touches.md](touches.md) under the "Asset.tags writers" cross-cutting entry.
- Define the membership rule explicitly: which assets get the tag, sourced from which fields / tables. Pure functions over inputs already written by discovery.
- Define the strip allowlist: which tags THIS reconciler is allowed to remove (always scoped to "things owned by the current integration").
- Wire the four lifecycle points. The reconciler is the source of truth; the inline hooks are latency optimizations + invariants on registry-row presence.
- Skip the periodic job unless you have an input that genuinely changes outside discovery — and if you do, you're probably in the **Setting-backed admin CRUD with reconciler** pattern instead.

---

## Prometheus metric instrumentation

**What it is:** Adding a new metric (counter / gauge / histogram) or instrumenting a new code path with an existing one. Single Registry singleton + helper functions per metric — callers never import metric objects directly. Default Node.js metrics from `prom-client.collectDefaultMetrics` are registered alongside Polaris-specific ones, all under one `/metrics` endpoint.

**Canonical implementation:** [src/metrics.ts](src/metrics.ts) — every metric is defined here with its labels, buckets (for histograms), and a typed helper export (e.g. `recordProbe`, `setDbPoolGauges`, `startSampleWriteTimer`). Mounted at `/metrics` in [src/app.ts](src/app.ts) with optional `METRICS_TOKEN` Bearer-token auth. For periodic-job timing, [src/jobs/_metrics.ts](src/jobs/_metrics.ts) exports `runInstrumentedJob(name, fn)` — every job in `src/jobs/` wraps its tick body in this helper.

**Key conventions:**
- **One Registry singleton.** `registry = new Registry()` at module top; `collectDefaultMetrics({ register: registry })` runs at module load. Never create a second registry — `prom-client`'s global registry is intentionally not used.
- **Helpers, not raw metric objects.** Every metric gets a typed helper: `startXTimer()` / `recordX(...)` / `setX(...)`. Callers never `import { someHistogram }` — they import the helper. This localizes label changes / renames / bucket tweaks to one file. The metric object itself is module-private.
- **Cardinality discipline.** Only bounded label sets cross the boundary: `cadence` (4 values), `transport` (5), `outcome` (2-3), `status` (3), `queue` (4), `state` (3), `severity` (4), `mode` (2), `table` (~8), `route` (matched Express template, not URL), `status_class` (4), `job` (~25), `volume` + `roles` (per-host, ~4), `integration_type` (~6). The only intentionally-unbounded label is `integrationId` (counted in dozens, justified by per-integration FMG worker isolation).
- **Histogram buckets are explicit, not default.** Pick buckets that span the actual operation's latency range — defaults from `prom-client` (0.005 .. 10) waste resolution on most Polaris operations. Pass-duration buckets go up to 900 s; probe buckets go down to 0.01 s; HTTP buckets fit between.
- **Cursor/pg-boss mode mutual-exclusion is explicit.** Mode-specific metrics (`polaris_monitor_queue_depth` cursor-only, `polaris_pgboss_*` pg-boss-only) keep emitting in the inactive mode but stay at 0. Use `polaris_monitor_queue_mode{mode}` to pick which family is authoritative.
- **`.reset()` before re-stamping volatile label sets.** When the set of label values is computed each tick (volumes from statfs, sample tables from pg_class), call `metric.reset()` first so dropped values don't leave orphan series. Don't `.reset()` for stable label sets (cadences, transports, queues).
- **Histograms observe successful work only.** Failures / aborts / errors increment a counter (`polaris_*_total{outcome}`) without polluting the latency distribution. Achieved by structuring the helper as `startTimer() ... await op() ... stop()` — a throw before `stop()` drops the observation.
- **HTTP middleware uses `req.route?.path` at finish time.** Captured in `res.once("finish", ...)` so the Express router has had a chance to match. Unmatched paths roll up to `"unmatched"`. Combine with `req.baseUrl` for routers mounted on a sub-path. `/metrics` and `/health` are explicitly skipped so scrape requests don't show up as application traffic.
- **`runInstrumentedJob(name, fn)` for periodic jobs.** Wraps the tick body without changing existing error semantics — thrown errors propagate to the caller's existing try/catch. Job names are stable, machine-readable identifiers; multi-tick modules use `<module>.<loop>` (e.g. `monitorAssets.probe` / `monitorAssets.heavy`).
- **Documentation in two places.** Every new metric family gets a one-paragraph entry in CLAUDE.md's Observability section AND a writers/readers/invariants entry in `touches.md`'s `cross-cutting/observability-metrics`.

**When adding a new metric:**
- Define the metric object + helpers in `src/metrics.ts`. Helpers go right after the definitions, in the existing `// ─── Helpers ───` block.
- Decide on histogram buckets by walking through the actual range the operation can take. Powers-of-10 spaced for >1s metrics, 0.005/0.025/0.1/0.5/1/5 for HTTP-class metrics, 0.01..15 for probe-class.
- Consider cardinality before adding a label. If the value is per-asset / per-row / per-UUID, push it into the histogram buckets or aggregate it by class instead.
- Wire the helper into the call site. ONE call site per metric family if possible — the FMG worker's queue-depth gauge is updated only inside `FmgWorker`, not elsewhere; the discovery duration histogram fires only at the `recordSample()` callsite.
- Add the documentation entries (CLAUDE.md Observability + touches.md cross-cutting/observability-metrics) in the same commit.

**When instrumenting a new job:**
- Wrap the tick body in `runInstrumentedJob("name", async () => { ... })`. Keep the existing outer try/catch for error logging — the helper's catch re-throws so log paths are preserved.
- Pick a stable, machine-readable name (no spaces, no version suffixes, no UUIDs). One-shot startup migrations use the module basename; multi-tick modules use `<module>.<loop>`.
- If the new job ships with the same commit that adds an unrelated capability, the metric label is one observation that confirms the job is actually firing on a real install — useful smoke check during the first deploy.

---

## High-volume append-only time-series writes (batch-flush buffer)

**What it is:** Persistent time-series tables that receive many small writes from a hot loop. Per-row `prisma.<table>.create()` calls each consume one Prisma pool connection, and at high concurrency the pool fills before the operation matters. The canonical fix is an in-memory per-table buffer with a periodic flush — accumulate rows, then issue one `createMany` per N-second window.

**Canonical implementation:** [src/services/sampleWriteBuffer.ts](src/services/sampleWriteBuffer.ts) — handles the six monitor sample tables (`asset_monitor_samples`, `asset_telemetry_samples`, `asset_temperature_samples`, `asset_interface_samples`, `asset_storage_samples`, `asset_ipsec_tunnel_samples`). Boot wiring in [src/app.ts](src/app.ts) — `startSampleWriteBuffer()` after queue init, `shutdownFlushSampleBuffers()` awaited in the SIGTERM/SIGINT hook.

**Key conventions:**
- **Append-only tables only.** Conflict-handling, dedupe, and per-asset replace semantics break the model. If you need to overwrite or delete prior rows, do that synchronously in the caller before the enqueue (cf. `recordSystemInfoResult`, which keeps the `$transaction` for `assetAssociatedIp` and the per-asset replace in `persistLldpNeighbors` synchronous).
- **Buffer is sync to enqueue, async to flush.** The hot loop calls `enqueue*(row)` and returns immediately — no await on the buffer. The flush is fire-and-forget, driven by `setInterval` and a per-table size threshold (5,000 rows in this implementation).
- **Snapshot the array up front.** `flushTable` splices the buffer into a local snapshot before the `await prisma.<table>.createMany` so concurrent enqueues during the awaited write land in a fresh array. On retry-exhausted failure, re-prepend the snapshot for the next tick.
- **Per-table flush guard.** A `flushing[key]` boolean prevents re-entry on the same table — a 2 s tick that fires while a slow flush is still mid-write becomes a no-op for that table.
- **Use `retryOnDeadlock` from `src/utils/dbRetry.ts`.** Postgres deadlocks (SQLSTATE 40P01) on bulk insert are rare but real; the retry helper covers them with jittered backoff.
- **Trade-off documented in code:** up to one flush-interval of data is lost on hard crash. State that the operator's UI view stays consistent through a crash by keeping any synchronous state writes (status pills, cadence stamps, counters) outside the buffer.
- **Instrument both flush duration and depth.** `polaris_sample_write_duration_seconds{table}` (histogram) wrapping each flush + `polaris_sample_buffer_depth{table}` (gauge) updated on every enqueue and flush — the pair distinguishes "flush is slow" from "enqueue rate exceeds flush throughput".
- **SIGTERM-safe.** Exported `shutdown*` function clears the timer and runs one final `flushAllSampleBuffers()`. Awaited from the graceful-shutdown hook in `app.ts` so a restart doesn't drop the in-flight buffer.
- **Test hooks under `__test__`.** Expose `getBufferDepth(key)` and `reset()` so unit tests can verify buffer state without exposing the buffers themselves to production callers.

**When adding a new table:**
- Append a `BufferKey`, a `TABLE_LABEL` entry, an `enqueueXxx` helper, and a `writeBatch` switch arm — five touch points in one file. Tests mirror the same shape.
- Confirm the new table is append-only with no FK on `(assetId, ...)` that requires per-row uniqueness mid-flush; if it does, you probably want synchronous semantics (LLDP-style) instead.
- Update `touches.md`'s `services/sampleWriteBuffer.ts` entry's Writers list to name the new caller.
