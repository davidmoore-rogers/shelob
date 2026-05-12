# Polaris — Touches Index

A lookup index for cross-cutting invariants and per-service relationships in the Polaris codebase. Answers the question **"if I change X, what else touches it?"** without reading every consumer.

This file complements [CLAUDE.md](CLAUDE.md) — CLAUDE.md is the narrative architecture doc; this is the relationship/dependency map.

## How to use

1. **Before changing a service or a shared invariant**, find its section here.
2. Walk the **Used by** / **Writers** / **Readers** lists to see what depends on the thing you're touching.
3. Run through the **When changing this** checklist before opening a PR.
4. **Keep this file current.** Per CLAUDE.md's commit-review rule, every commit re-reads `touches.md` for staleness — if your change moved writers/readers, broke an invariant, or invalidated a checklist item, fix it in the same commit.

## Format

**Per-service** sections:
- **What it owns** — one-sentence responsibility
- **Public API** — exported symbols
- **Cross-service deps** — other `src/services/*` files this one imports
- **Used by** — external callers (`file:line — purpose`)
- **Invariants** — rules every caller must respect
- **When changing this** — pre-merge checklist

**Cross-cutting** sections swap **Used by** for separate **Writers** / **Readers** lists since the concern spans many files.

## Sections

- [Cross-cutting concerns](#cross-cutting-concerns) (7)
- [Per-service touches](#per-service-touches) — alphabetical, 39 services in `src/services/`

---

# Cross-cutting concerns

## cross-cutting/five-state-monitor-machine

**What it is:** Asset.monitorStatus ∈ {up, warning, recovering, down, unknown} driven by consecutiveFailures/consecutiveSuccesses counters (see "Five-state monitor machine" in CLAUDE.md).

**Writers** (files that mutate or emit this state):
- `src/services/monitoringService.ts` — runProbeFor() updates Asset.monitorStatus/consecutiveFailures/consecutiveSuccesses after each probe result, emits monitor.status_changed Event on up↔down transitions, fires propagateAfterStatusChange() to push the edge into descendant dependencySuppressed state
- `src/jobs/monitorAssets.ts` — Light/heavy ticking loops invoke runMonitorPass() which dispatches probe collection
- `src/api/routes/assets.ts:651` — recordProbeResult() on manual /probe-now endpoint
- `src/api/routes/assets.ts` — PUT /assets/:id validateMonitorConfig handler resets consecutiveFailures on manual disable
- `src/db.ts:212-222` — Prisma extension clampMonitoredForStatus() forces monitored=false and resets consecutiveFailures when status flips to decommissioned/disabled

**Readers** (files that consume it):
- `public/js/assets.js:223-229` — Status pill renderer colors by monitorStatus (green/amber/blue/red/grey)
- `public/js/assets.js:1152` — intermittency-bar client-side replay engine reads monitorStatus to color per-sample cells
- `src/services/monitoringService.ts:runMonitorPass()` — Heavy-cadence suppression gate: telemetry/systemInfo only run when monitorStatus==="up" AND !dependencySuppressed; probe interval doubles when dependencySuppressed (parent down)
- `src/services/dependencyTreeService.ts` — reconcileDependencySuppression() reads monitorStatus to evaluate "all-down" suppression — only the confirmed-down edge propagates (warning/recovering do NOT)
- `src/api/routes/map.ts` — Device Map topology endpoint reads monitorStatus for FortiGate/switch/AP health coloring via monitorStatusToHealth()
- `src/jobs/monitorAssets.ts:110` — Queue eligibility check consults monitorStatus + dependencySuppressed

**Invariants:**
- State machine accepts only {up, warning, recovering, down, unknown}; no other string values permitted.
- Transition to "down" happens when consecutiveFailures ≥ failureThreshold; to "up" when consecutiveSuccesses ≥ failureThreshold (same threshold both directions).
- "recovering" is the transient mid-recovery state (was-down, now succeeding). Exits to "up" once the success threshold is crossed.
- "warning" is mid-degradation (was-up, now accumulating failures but below threshold). Exits to "down" when threshold crossed, back to "up" on success.
- monitor.status_changed Event fires ONLY on up↔down transitions, not on warning/recovering churn. propagateAfterStatusChange() fires from the same edge so dependency suppression follows the confirmed-down edge — never the flap.
- Heavy cadences (telemetry/systemInfo/fastFiltered) are suppressed when monitorStatus ≠ "up" OR dependencySuppressed. The probe runs at 2× cadence when dependencySuppressed AND responseTimePolling !== "disabled".
- Response-time probe runs in every state; it's the cheap path that detects recovery.

**When changing this:**
- Verify every state assignment matches the rules above (no bypass paths).
- Check assets.js intermittency-bar replay logic replays the five-state machine forward correctly (must use same failureThreshold).
- Confirm monitor.status_changed Event audit trail only has up/down transitions (search logs for other values = bug).
- Test manual /probe-now against a down asset — should advance consecutiveSuccesses and possibly transition to recovering within one call.
- Check Map topology endpoint colors match asset list Status pills (monitorStatusToHealth must be consistent).
- Verify clamp logic in db.ts doesn't interfere: disable should reset, but re-enable (flip to active) should not auto-resume monitoring.
- If touching the cadence dispatch (runMonitorPass / publishDueWork): mirror EVERY change in BOTH `src/services/monitoringService.ts` AND `src/jobs/monitorAssets.ts` — they're parallel implementations and must stay in lock-step.

---

## cross-cutting/asset-source-projection

**What it is:** Multi-source asset discovery unified via AssetSource rows and deriveAssetSources() / projectAssetFromSources() pure functions (see "Asset projection priority table" in CLAUDE.md).

**Writers** (files that mutate or emit this state):
- `src/db.ts:59-132` — Prisma extension shadowWriteAssetSources() upserts AssetSource rows on every asset.create/update/upsert when assetTag/tags/discoveredByIntegrationId change
- `src/api/routes/integrations.ts:1629-1760` — upsertFortigateFirewallAssetSource() / upsertFortinetInfraAssetSource() for FMG/FortiGate firewall/switch/AP discovery
- `src/api/routes/integrations.ts:3969-4020` — Entra/Intune upsert paths (buildEntraSource / buildIntuneFdmSource + upsertEntraIntuneSources)
- `src/api/routes/integrations.ts:3622-3650` — fortigate-endpoint AssetSource stamping on DHCP endpoint discovery
- `src/api/routes/integrations.ts` — Active Directory / Windows Server discovery paths upsert ad / windowsserver source rows
- `src/jobs/backfillAssetSources.ts` — One-shot startup: derives sources from legacy assetTag / sid: / ad-guid: tag conventions
- `src/utils/assetSourceDerivation.ts` — deriveAssetSources() implements source derivation rules for both shadow-write and backfill

**Readers** (files that consume it):
- `src/utils/assetProjection.ts:279-321` — projectAssetFromSources() reads AssetSource rows and applies priority rules to build ProjectedAsset shape
- `src/api/routes/assets.ts` — Asset read endpoints attach AssetSource rows in the assetSources relation
- `src/services/projectionDriftService.ts` — Compares projectAssetFromSources() output against Asset field values to detect drift
- Discovery paths use projectAssetFromSources() output as the source of truth for Asset field writes (Phase 3b.1 cutover pending)

**Invariants:**
- Every AssetSource row must have sourceKind + externalId (unique key); created/updated by discovery or the shadow-write extension.
- inferred=true rows are backfill skeletons; projection ignores them (they predate real discovery).
- observed JSON blob is owned by the discovery pathway that explicitly writes it (Phase 2+); shadow-write never touches observed on update, only on initial create.
- Priority rules in projectAssetFromSources() are immutable for production stability; tuned from shadow-drift logs and locked with operators.
- Fortinet infrastructure (firewall/switch/AP) sources are derived from serial + manufacturer + assetType during backfill; discovery writes explicit "fortigate-firewall" / "fortiswitch" / "fortiap" source rows.
- fortigate-endpoint source is stamped on endpoint-type assets discovered via DHCP; marked as infra if assetType is "firewall"/"switch"/"access_point".

**When changing this:**
- Modify priority rules only if tuned against real drift logs and agreed with operators (don't guess).
- If adding a new discovery source kind, pair it with an AssetSource upsert in the discovery path AND update deriveAssetSources() rules for backfill coverage.
- Test shadow-write: create an asset with assetTag, verify AssetSource row exists; update assetTag, verify the row is refreshed.
- Run projectionDriftService on next discovery cycle and check pino logs for "asset.projection.drift" — should be silent on stable sources.
- Verify backfill catches the new source kind: run startup job, spot-check a few assets have the right AssetSource rows.

---

## cross-cutting/polling-method-resolver

**What it is:** Four-tier cascade resolving which polling method (REST API / SNMP / WinRM / SSH / ICMP) is used for each asset's response-time / telemetry / system-info / fastFiltered probes (see "Monitor Settings Hierarchy" + "Polling-method compatibility matrix" in CLAUDE.md).

**Writers** (files that mutate or emit this state):
- `src/api/routes/assets.ts` — PUT /assets/:id sets per-asset override columns (responseTimePolling / telemetryPolling / interfacesPolling / lldpPolling)
- `src/api/routes/monitorSettings.ts` — POST MonitorClassOverride upserts class-tier overrides for (integrationId, assetType)
- `src/api/routes/integrations.ts` — Integration config JSON holds tier-3 Integration.config.monitorSettings
- `src/api/routes/serverSettings.ts` — PUT /server-settings updates tier-4 manualMonitorSettings Setting
- `src/services/monitoringService.ts:resolveMonitorSettings / resolveMonitorSettingsWithProvenance` — Only readers; these are pure resolvers, not writers

**Readers** (files that consume it):
- `src/services/monitoringService.ts:runMonitorPass` — per-stream (probe/telemetry/systemInfo/fastFiltered) dispatch branches consult resolved settings to pick method + timeout + retry logic
- `src/jobs/monitorAssets.ts` — publishDueWork() and light/heavy loops call resolveMonitorSettings() to determine which assets are due for each cadence
- `public/js/assets.js` — Asset Monitoring tab UI renders manual override tier (per-asset dropdowns)
- `public/js/integrations.js` — Integration Monitoring tab renders the integration tier (Cadence & Retention + per-stream polling dropdowns) and the Discovery Defaults section (FortiGates / FortiSwitches / FortiAPs subtabs with reactive SNMP / SSH credential pickers). Class overrides have moved to the Assets-page Monitoring Settings modal
- `src/api/routes/assets.ts` — GET /assets/:id/effective-monitor-settings endpoint returns full resolved stack + provenance (used by System tab intermittency-bar replay, by per-stream chart badges to label which tier supplied each polling method — see _streamBadgeText in public/js/assets.js — AND by the stale-data banner threshold; the three callers in assets.js cache `eff.resolved` in `_effectiveResolvedByAssetId` so banner slots can re-evaluate against the class/integration cadence after first paint)
- `src/api/routes/assets.ts` — GET /assets/:id exposes `discoveredByIntegration.useProxy` (FMG only) so the System tab chart badges can render "Proxy via <fmg>" vs "Direct" without a second round-trip; integration `config` otherwise stripped to keep API tokens out of the response

**Invariants:**
- Resolver applies the four-tier cascade strictly in order: per-asset → class-override → integration → manual, first non-null wins.
- Resolved method must be compatible with the asset's source kind (checked by isPollingMethodCompatible against COMPATIBILITY matrix in pollingCompatibility.ts).
- If a higher tier specifies an incompatible method, it silently falls through to the next tier (never error; don't break monitoring).
- Compatibility matrix is locked per CLAUDE.md "Polling-method compatibility matrix"; breaches must go through the design process.
- AD-discovered assets default to ICMP for response-time unless the operator picks winrm/ssh on the per-asset tier (bind-creds fallback at probe time).
- FMG/FortiGate-discovered firewalls default to REST API on response-time / telemetry / interfaces and `disabled` on LLDP (FortiOS REST `lldp-neighbors` is empty on most fleets — operators flip back to `rest_api` if their fleet has it enabled).

**When changing this:**
- Compatibility matrix changes require design review and manual tier updates across the codebase (four UI surfaces).
- If adding a new polling method, update: pollingCompatibility.ts, monitoringService.ts dispatch branches, all four UI tiers (assets.js / integrations.js / serverSettings.js), and test tier resolution.
- Verify fallthrough logic: resolve a method that's incompatible for an asset's source and confirm it doesn't get used (add a test to monitoringService).
- Check every stream independently: one asset might have responseTimePolling=snmp, telemetryPolling=rest_api, systemInfoPolling=icmp; all valid per source.
- Audit UI disable-logic matches the matrix (if a source doesn't support REST API, the dropdown should not offer it).

---

## cross-cutting/fmg-fortigate-parity-surfaces

**What it is:** FMG and standalone FortiGate integrations share feature surfaces that must move together: integration modal tabs (General / Filters / Monitoring / DHCP Push / Quarantine Push), transport dispatch via buildTransportForIntegration(), and filter helpers.

**Writers** (files that mutate or emit this state):
- `src/api/routes/integrations.ts` — POST / PUT integration handlers parse both fortimanager and fortigate integration types, store config.pushReservations / pushQuarantine / monitorSettings / deviceInclude/Exclude in the same JSON shape
- `src/services/reservationPushService.ts:65-90` — buildTransportForIntegration() dispatches to FMG proxy/direct or FortiGate direct transport based on integration.type
- `src/services/assetQuarantineService.ts` — quarantineAsset() / releaseQuarantine() use buildTransportForIntegration() for both FMG and FortiGate
- `public/js/integrations.js:335-875` — Integration modal tab bodies for General (useProxy, Filters), Monitoring, DHCP Push, Quarantine Push

**Readers** (files that consume it):
- `src/api/routes/integrations.ts` — Discovery sync paths read pushReservations toggle to decide whether to push DHCP changes
- `src/api/routes/integrations.ts` — Discovery sync paths read pushQuarantine to decide whether to push quarantine entries
- `src/services/reservationService.ts` — Reserve/release flows call buildTransportForIntegration() to dispatch push/unpush calls
- `src/services/assetQuarantineService.ts` — Quarantine push consults buildTransportForIntegration() and pushQuarantine toggle
- `public/js/assets.js` — Asset details modal wires up quarantine/release buttons that call the quarantine endpoints
- `src/utils/integrationFilter.ts` — assetMatchesIntegrationFilter() checks deviceInclude/Exclude for FMG/FortiGate and ouInclude/Exclude for AD (not shared)

**Invariants:**
- FMG and FortiGate must have identical modal tab layouts and toggle names (pushReservations, pushQuarantine, monitorSettings JSON, deviceInclude/Exclude).
- buildTransportForIntegration() is the single source of truth for routing push/quarantine calls; all callers must use it, never inline a new transport builder.
- Standalone FortiGate always routes through direct REST transport (no proxy option); FMG respects the useProxy toggle on the General tab.
- DHCP Push and Quarantine Push are independent toggles; enabling one doesn't force the other (operators mix-and-match per deployment model).
- FMG-only features intentionally excluded from standalone FortiGate: multi-device device filter (ADOM scoping), FMG-proxy concurrency settings.
- Filter matching (deviceInclude/Exclude wildcards) is the same for both FMG and FortiGate; tested in integrationFilter.ts.

**When changing this:**
- Any modal tab change on FMG must be duplicated on standalone FortiGate (and vice versa); test both integration types.
- If adding a new transport capability, update buildTransportForIntegration() signature and all callers (reservationPushService, assetQuarantineService, future features).
- Check that toggle propagation works: set pushReservations=true on FMG and verify next discovery sync writes reservations; disable it and verify unpush/lease-release are skipped.
- Verify filter behavior: add a deviceInclude pattern to FMG and confirm the next sync only touches matching devices.
- Test cross-device push: one asset discovered by FMG with multiple device filters; confirm each push lands on the intended device via the transport.

---

## cross-cutting/asset-write-time-clamps-and-shadow-writes

**What it is:** Prisma extension in src/db.ts that automatically normalizes manufacturer, clamps acquiredAt, checks monitoring status, derives asset sources, and records IP history on every Asset create/update/upsert (see "Asset write-time clamps" in CLAUDE.md).

**Writers** (files that mutate or emit this state):
- `src/db.ts:224-302` — Extended client wraps asset.create/update/updateMany/upsert with five hooks:
  - normalizeManufacturerInData() runs `Asset.manufacturer` through normalizeManufacturer()
  - clampMonitoredForStatus() forces monitored=false + resets consecutiveFailures when status ∈ {decommissioned, disabled}
  - recordIpHistory() upserts AssetIpHistory on ipAddress change
  - shadowWriteAssetSources() derives and upserts AssetSource rows when identity fields change
- `src/utils/manufacturerNormalize.ts` — normalizeManufacturer() pure function (cached alias map, no DB access)
- `src/utils/assetInvariants.ts` — clampAcquiredToLastSeen() logic (not hooked yet; job applies it at startup)
- `src/utils/assetSourceDerivation.ts` — deriveAssetSources() pure function producing AssetSource rows from legacy tags
- `src/jobs/normalizeManufacturers.ts` — One-shot startup: seeds default aliases, loads cache, backfills existing Assets
- `src/jobs/clampAssetAcquiredAt.ts` — One-shot startup: clamps acquiredAt ≤ lastSeen for pre-existing rows

**Readers** (files that consume it):
- Any code path that writes to Asset (discovery, UI routes, jobs) gets the extension hooks applied automatically.
- `src/services/manufacturerAliasService.ts` — Manages the alias cache that normalizeManufacturer consults.
- `src/app.ts` — Warms the OUI / manufacturer alias cache at boot before any Asset writes occur.

**Invariants:**
- Every Asset create/update that touches manufacturer will have the value normalized by the alias map at write time (no raw "Fortinet, Inc." rows survive).
- clampAcquiredToLastSeen is gated by a marker key (job doesn't re-run); startup check will warn if marker is missing.
- IP history is fire-and-forget best-effort; a transient DB error doesn't block the underlying Asset write.
- shadowWriteAssetSources uses the same derivation rules as the backfill job; updates only refresh metadata (syncedAt, lastSeen, integrationId), never overwrite observed JSON that came from discovery.
- updateMany doesn't trigger shadowWriteAssetSources (rare on identity fields; backfill catches drift on next startup).
- Extension runs AFTER the query executes; result reflects the DB commit state, not pre-normalization input.

**When changing this:**
- New clamps must be added to BOTH normalizeManufacturerInData() (for manufacturer) AND clampMonitoredForStatus() branches, preserving order (normalize first, clamp second, then shadow-write).
- If bypass paths exist (raw SQL, stored procedures, external scripts), they MUST be audited and manually corrected via startup jobs (extension can't intercept).
- Test the order: create an asset with status=decommissioned, monitored=true, consecutiveFailures=5; verify monitored flips to false and counter resets.
- Verify alias cache is warmed: set a new alias, restart the app, create an asset with the old name; spot-check it got normalized.
- Check IP history on duplicate IP: same asset, new source; verify firstSeen was reset (CASE expression in SQL working) and lastSeen bumped.

---

## cross-cutting/reservation-push-lifecycle

**What it is:** Two-way DHCP reservation ↔ FortiGate sync via pushReservations toggle on FMG/FortiGate integrations, sourceType flip (manual → dhcp_reservation on success), pushedScopeId/pushedEntryId tracking, and lease-release on free.

**Writers** (files that mutate or emit this state):
- `src/services/reservationPushService.ts:65-200` — buildTransportForIntegration() + pushReservationEntry() upsert / read-back verify on FortiOS
- `src/services/reservationService.ts:245` — On successful push, set sourceType = "dhcp_reservation", pushedToId, pushedScopeId, pushedEntryId, pushedAt
- `src/services/reservationService.ts:340-390` — releaseReservation() unpushes using pushedScopeId/pushedEntryId, then lease-releases (dhcp_lease rows) if integration has pushReservations=true
- `src/api/routes/integrations.ts:2559,2733,2783,2847,2919` — upsertConflict() bypass when existingRes.sourceType === "manual" (don't conflict-flag pre-existing manual reservations)
- `public/js/assets.js` — Quarantine/release UI buttons (quarantine push separate from reservation push)

**Readers** (files that consume it):
- `src/services/reservationService.ts` — Lease release reads dhcp_lease sourceType rows and filters to those pushed by this integration
- `src/api/routes/integrations.ts` — Discovery sync reads pushReservations toggle to gate DHCP reservation creation
- `src/api/routes/integrations.ts` — upsertDhcpReservation() checks if existingRes.sourceType==="manual"; if so, calls upsertConflict() instead of auto-updating
- `public/js/assets.js` — UI shows pushStatus ("synced" / "drift") + pushedAt timestamp on manual reservation rows that have pushedToId set

**Invariants:**
- DHCP reservations are MAC→IP pairs; only per-IP (not full-subnet) manual reservations are push-eligible.
- pushedScopeId + pushedEntryId are resolved AT PUSH TIME and pinned; used at unpush without re-querying the FortiGate.
- sourceType flip to "dhcp_reservation" is ONLY set on successful push; if push fails, no Polaris row is created (fail-on-failure semantics).
- Lease release happens ONLY for dhcp_lease sourceType rows where the originating integration's pushReservations=true.
- pushStatus ∈ {"synced", "drift"}; "synced" = verified on device, "drift" = was synced, missing on re-discovery.
- upsertConflict() bypass (sourceType==="manual" check) prevents false conflicts when discovery touches a manual reservation (operator created it before this integration, now discovery found it too).

**When changing this:**
- Verify pushedScopeId/pushedEntryId survive across restarts: create a reservation, restart the app, release it; confirm unpush hits the exact device-side entry.
- Test sourceType flip: create a manual reservation, push succeeds; verify sourceType is now "dhcp_reservation" and pushedToId is set to the integration.
- Check conflict bypass: create a manual reservation, add an integration that discovers the same IP; verify conflict is raised only for non-manual priors.
- Lease-release cadence: toggle pushReservations off mid-deployment, release a dhcp_lease row; confirm unpush is skipped but the Polaris row is freed.
- Verify read-back verify: FortiGate DHCP create succeeds but the verify read fails (transient device timeout); confirm the push is retried or fails cleanly.

---

## cross-cutting/asset-tag-mutators

**What it is:** Anything in the codebase that writes `Asset.tags`. The `tags: String[]` column is used by humans (assets-page filtering, search) AND by features that "stamp" managed tags (e.g. `region:<name>` from map regions). Two writer classes coexist: **operator-driven** (asset edit modal, bulk-edit) and **system-driven** (auto-tagging features). The latter must be careful not to step on operator-set values.

**Operator writers:**
- `src/api/routes/assets.ts:PUT /assets/:id` — primary edit path; accepts `tags: string[]` and writes it as-is.
- `src/api/routes/assets.ts:POST /assets/:id/sources/:sourceId/split` — clones tag set when splitting an asset.
- `public/js/assets.js` bulk-edit modal — calls `PUT /assets/:id` per row with "Add" / "Replace" semantics.

**System writers (managed namespaces):**
- `src/services/mapRegionService.ts` — owns the `region:` prefix. Adds `region:<name>` to in-polygon firewalls + cascaded FortiSwitches/FortiAPs; only strips on rename/delete (never on polygon edit). Sees its own tags via the prefix; never touches operator-set tags. Mirrored to the `Tag` registry under category "Map Regions".
- `src/services/firewallTagService.ts` — owns the `firewall:` prefix. Reconciles `firewall:<hostname>` on every FortiSwitch / FortiAP / non-infra endpoint at end of FMG / FortiGate discovery (Phase 13.5) using `Asset.fortinetTopology.controllerFortigate` + `AssetFortigateSighting` rows within `sightingMaxAgeDays`. Strips only tags whose hostname is one of THIS integration's currently-known firewalls (cross-integration safe). Inline lifecycle hooks at Phase 2a (decommission strip), Phase 3 firewall create (registry seed), Phase 3 firewall update (rename rotation). Mirrored to the `Tag` registry under category "FortiGate".
- Discovery breadcrumb tags — `src/api/routes/integrations.ts` legacy paths still write `entra-disabled`, `ad-disabled`, `prev-*` markers. Some of these (sid:, ad-guid:) are being retired by the multi-source asset model.

**Tag registry mirror (`prisma.tag` rows):**
- Manual tag pickers (assets edit modal) read from the registry to populate dropdowns. System-managed tags should also appear here so operators can search/filter for them — `mapRegionService` is the canonical example (upserts on create, rotates on rename, deletes on delete).

**Invariants:**
- A managed tag prefix must be **owned** by exactly one writer. Don't add a second feature that writes `region:*` — pick a different prefix.
- System writers must be additive in the steady state. Stripping a tag because "the asset doesn't fall in the polygon any more" is a footgun unless the operator explicitly requested that semantic (rename/delete, not polygon edit).
- Manual operator attachments to system-managed tags (e.g. an endpoint server hand-tagged `region:Atlanta`) must survive periodic reconcilers.

**When changing this:**
- New auto-tagging feature? Pick a prefix, document it here, mirror to the `Tag` registry, and follow the additive-reconciler pattern from `mapRegionService`.
- Removing a managed prefix? Audit existing rows for stale tags before retiring the writer.
- Changing the `Asset.tags` column type or moving tags to a side table? Every writer in this section needs to migrate — the `String[]` shape is load-bearing.

---

## cross-cutting/dependency-aware-monitoring-suppression

**What it is:** AssetDependencyParent edges + Asset.dependencyLayer + Asset.dependencySuppressed coupled to the response-time five-state machine. Parent (FortiGate / upstream switch) confirmed-down → all transitive descendants pause heavy cadences and slow probe to 2× interval; recovery resumes within one base-cadence tick. "All-down" multi-parent semantics — a switch with redundant uplinks suppresses only when every effective parent is down or itself suppressed.

**Writers** (files that mutate or emit this state):
- `src/services/dependencyTreeService.ts` — recomputeDependencyTree() rebuilds source="computed" rows in AssetDependencyParent + Asset.dependencyLayer at end of every FMG/FortiGate discovery cycle. Source="override" rows are operator-managed (admin override endpoints — to be added in API commit) and never touched by recompute.
- `src/services/dependencyTreeService.ts` — reconcileDependencySuppression() is the source of truth for Asset.dependencySuppressed; emits monitor.dependency_suppressed / monitor.dependency_resumed Events on transitions.
- `src/services/dependencyTreeService.ts` — propagateAfterStatusChange() is the latency-optimization hook called from recordProbeResult after every monitor.status_changed Event.
- `src/jobs/dependencyReconciler.ts` — 60s tick that calls reconcileDependencySuppression(); the source of truth catches anything the event hook missed.
- `src/jobs/backfillDependencyTree.ts` — one-shot startup runs recomputeDependencyTree() so existing installs see populated rows without waiting 4h.
- `src/api/routes/integrations.ts` — Phase 12 of syncDhcpSubnets calls recomputeDependencyTree(integrationId) on mode in {full, finalize}.

**Readers** (files that consume it):
- `src/services/monitoringService.ts:runMonitorPass()` — Cadence dispatch: heavy cadences gated on `monitorStatus==="up" && !dependencySuppressed`; probe interval doubles when dependencySuppressed AND responseTimePolling !== "disabled".
- `src/jobs/monitorAssets.ts:publishDueWork()` — Same gate, mirrored for the pg-boss publisher path.
- `public/js/assets.js:assetMonitorBadge()` — Status pill renders slate-blue "Dep. Down" when `dependencySuppressed && monitorStatus !== "down"` (probe-down wins over the suppressed flag — the probe is the proof).
- `public/js/map.js:monitorClass()` / `clusterIcon()` / `fortigateNodeColor()` — Pin/cluster/topology-node colors render slate-blue (`monitor-dep-down`) under the same priority rule. Cluster aggregation rolls up to dep-down only when no child has a worse probe-direct status.
- `public/js/mobile/asset-detail.js:renderMonitorPill()` / `monitorDotCls()` — Same priority + slate-blue treatment on the mobile asset-detail surface.
- `src/api/routes/assets.ts` — Three endpoints: `GET /assets/:id/dependencies`, `PUT /:id/dependencies/override` (admin, with cycle validation), `DELETE /:id/dependencies/override` (admin).
- `src/api/routes/assets.ts:GET /` and `GET /:id` — Stamps `dependencyLayer` + `dependencySuppressed` on every asset returned so the pill renderer doesn't need a second fetch.
- `src/api/routes/map.ts:GET /sites` and `GET /sites/:id/topology` — Stamps the same fields on each pin / topology node. (The topology endpoint still computes edges via per-request BFS through `interfaceTopologyService` — full DAG-as-source-of-truth refactor is a follow-up; current state is "DAG drives suppression, BFS still drives graph rendering.")

**Invariants:**
- Suppression follows the **confirmed-down** edge only. monitor.status_changed Event fires solely on up↔down transitions, and propagateAfterStatusChange() is called only from that same emission point. Warning / recovering flapping does NOT propagate.
- "All-down" multi-parent: an asset with N effective parents suppresses iff every parent is down or itself dependencySuppressed. Empty parent set = never suppressed.
- Override resolution: if any source="override" row exists for an asset, those are the effective parents (computed rows ignored). Empty override set = explicit "no parents" pin (asset opts out entirely).
- Unmonitored parents are transparent — the suppression walk skips them and continues to their grandparents. A monitored ancestor must say "down" before suppression can fire.
- recomputeDependencyTree only touches source="computed" rows for in-scope assets; out-of-scope rows and source="override" rows are never deleted.
- Layer assignment is BFS shortest-path from any FortiGate (layer 1). Cycles, disconnected subgraphs, or chains through unmonitored intermediates may leave dependencyLayer = null.
- Reconciler runs in BFS layer order so parent's effective state is settled before children evaluate (otherwise multi-tier suppression could oscillate).

**When changing this:**
- Mirror cadence-dispatch changes in BOTH src/services/monitoringService.ts AND src/jobs/monitorAssets.ts. The two are parallel implementations and must stay in lock-step.
- Verify the propagateAfterStatusChange() hook still fires only from the up↔down emission point — never from warning/recovering churn.
- Run the dependencyTreeService.test.ts suite — covers BFS layers, MCLAG siblings, dual-homed multi-parent, all-down semantics, transparent unmonitored parents, confirmed-down-only edge.
- Smoke-test on dev: pick a live FortiGate, set monitorStatus="down" via direct DB write, wait one reconciler tick (≤60s); confirm child switches/APs flip to dependencySuppressed and emit monitor.dependency_suppressed Events.
- If the topology endpoint refactor lands: hit /api/v1/map/sites/:id/topology before/after; edge sets must match (same FG→switch / switch→AP edges) modulo the new dependencySuppressed flag on each node.
- Watch for cycles introduced by override edits: the override endpoint must reject inputs that would form a cycle (BFS-back-walk validation).

---

## cross-cutting/verbose-debug-mode

**What it is:** A per-integration `config.verboseLogging` boolean that, when true, surfaces step-by-step discovery + sync + monitor-worker logs to pino at info level (tagged `verbose: true`) so an operator can `journalctl -u polaris -f` and watch one integration's behavior in real time. Off by default; toggled per integration from the edit modal.

**The four touchpoints** (changing any one requires keeping the others consistent):

1. **Integration config schemas** ([src/api/routes/integrations.ts](src/api/routes/integrations.ts)) — every integration type's Zod schema (`FortiManagerConfigSchema`, `FortiGateConfigSchema`, `WindowsServerConfigSchema`, `EntraIdConfigSchema`, `ActiveDirectoryConfigSchema`) carries `verboseLogging: z.boolean().optional().default(false)`. New integration types added in the future must follow the same pattern.

2. **Discovery `onProgress` consumer** ([src/api/routes/integrations.ts](src/api/routes/integrations.ts) `onProgress` closure inside the discover route) — reads `integration.config.verboseLogging` once at discovery start. When true, every callback emits `logger.info({ verbose: true, integrationId, integrationName, step, level, device }, message)` in addition to the existing `logEvent()`.

3. **Sync phase markers** ([src/api/routes/integrations.ts](src/api/routes/integrations.ts) `syncDhcpSubnets` — `phaseMark(name)` helper) — when verbose is on, each `phaseMark()` call logs the elapsed time of the previous phase + starts the new phase's timer. A final `phaseMark("__end__")` closes the last phase right before the function returns.

4. **Worker handlers** ([src/services/queueService.ts](src/services/queueService.ts) `runDedicatedWorker` and `dispatchFloatingJob`) — read `job.data.verboseDebug` (stamped by the publisher in `monitorAssets.publishDueWork` when `discoveredByIntegration.config.verboseLogging === true`). When true, emit `monitor.worker.pickup` on entry + `monitor.worker.finish` on exit, with slot id, jobId, cadence, assetId, outcome, elapsedMs.

**Worker slot id scheme:** [src/utils/workerSlotPool.ts](src/utils/workerSlotPool.ts) hands out `<prefix>-W01..NN` for dedicated cadence pools (probe / fast / telemetry / sysinfo) and `floating-F01..NN` for the floating pool. Slot acquired on handler entry, released on exit so the same slot is reused across jobs — operators can trace one slot's lifecycle through journalctl. Slot bookkeeping runs every tick regardless of verbose mode; only the *logging* of slot ids is gated on the flag.

**Structured log payload contract:** every verbose line emits these fields — `verbose: true`, `integrationId` + `integrationName` (when scoped to an integration), `step` or `phase` (for discovery/sync), `workerSlot` + `jobId` + `cadence` (for workers), `assetId`, `elapsedMs` (when measured), `outcome` (for worker.finish: `"success" | "failure"`). The contract is what makes `journalctl -o json | jq 'select(.verbose==true)'` filtering work reliably; do not strip these fields when adding a new verbose log call.

**When changing this:**
- Adding a new integration type → add `verboseLogging` to its config schema, its frontend form helper, its `getXxxFormConfig` reader, and a Debug section to its General tab. See the 5 existing pairs for the template.
- Adding a new discovery step → it inherits verbose logging for free via the existing `onProgress` route. No code change required if the step uses the standard callback.
- Adding a new pg-boss queue → add a slot pool entry in `startPgbossWorkers` and use `runDedicatedWorker` (or pattern-match `dispatchFloatingJob`) so pickup/finish lines land for free.
- Adding a new sync phase → insert one `phaseMark("X")` call right under the `// Phase X — ...` comment. The previous phase's elapsed time is logged at the next phaseMark call; the final phase is closed by the `phaseMark("__end__")` at the bottom of `syncDhcpSubnets`.

---

## cross-cutting/pgbouncer-compatibility

**What it is:** Polaris is **PgBouncer-aware**. Operators who put PgBouncer (or any connection multiplexer) in front of PostgreSQL set `POLARIS_DB_DIRECT_URL` to the direct Postgres URL while `DATABASE_URL` points at PgBouncer. Polaris routes different code paths to one URL or the other based on what each path needs.

**Connection-string helpers** (`src/utils/dbConnections.ts`):
- `getApplicationDatabaseUrl()` — returns DATABASE_URL.
- `getDirectDatabaseUrl()` — returns POLARIS_DB_DIRECT_URL when set, else falls back to DATABASE_URL.
- `getDbConnectionMode()` — returns `"pgbouncer"` when the two URLs differ OR DATABASE_URL has `?pgbouncer=true`; `"direct"` otherwise.

**Routing rules:**
- **Application queries (Prisma client)** → DATABASE_URL via `src/db.ts`. Under PgBouncer this hits the multiplexer; under direct mode it hits Postgres straight.
- **pg-boss queue ops** → `getDirectDatabaseUrl()` in `src/services/queueService.ts:startPgbossWorkers`. Required: pg-boss uses LISTEN/NOTIFY and the pg client's prepared-statement cache, both of which break under PgBouncer transaction pooling.
- **`pg_dump` backup + restore** → `getDirectDatabaseUrl()` in `src/api/routes/serverSettings.ts` (`/database/backup` and `/database/restore` routes). PgBouncer doesn't proxy the COPY-heavy dump protocol reliably.
- **`pg_stat_activity` reads** → dedicated `pg.Pool` (max 2) in `src/services/capacityService.ts:getDirectStatsPool()`, opened lazily only when PgBouncer mode is detected. Going through PgBouncer would show the multiplexed view of backend connections, which under-counts what Polaris actually holds.
- **express-session** → DATABASE_URL (PgBouncer-safe; low-volume INSERT/SELECT/DELETE with no LISTEN/NOTIFY, no held prepared statements).
- **Prisma CLI migrations** → operator concern. The in-app updater inherits whatever DATABASE_URL is set; CLI invocations under PgBouncer should explicitly set `DATABASE_URL=<direct URL>` before `npx prisma migrate deploy`. Documented in `docs/INSTALL.md`.

**Detection signal:** `polaris_db_connection_mode{mode}` gauge (set once at boot from `recordDbConnectionMode()` in `src/app.ts`) plus an info-level log line at boot. Operators verify Polaris recognized their topology without grepping for connection errors.

**Capacity Advisor caveat:** The advisor's `PG_MAX_CONNECTIONS` recommendation is sized to keep Polaris's pool at ≤65% of `max_connections`. Under PgBouncer mode this is a conservative upper bound — PgBouncer's `default_pool_size` × pool count is what actually hits Postgres, so a smaller `max_connections` is fine. UI shows a hint ("PgBouncer detected") above the recommendation table when applicable; the underlying math stays the same.

**When changing this:**
- Adding a new code path that issues `LISTEN`, `NOTIFY`, `pg_dump`, `pg_restore`, or any session-scoped state-machine SQL: route it through `getDirectDatabaseUrl()` so it doesn't break PgBouncer installs.
- Adding a new code path that reads `pg_stat_activity` for cluster-wide stats: route it through `getDirectStatsPool()` so the numbers are accurate.
- Routine read/write through Prisma: leave it alone. The application URL is the right path.

---

## cross-cutting/observability-metrics

**What it is:** The Prometheus `/metrics` surface. One `Registry` singleton in `src/metrics.ts`, one helper per metric (callers never import the metric object directly), CPU/process defaults from `prom-client.collectDefaultMetrics`. Three label-discipline rules: `route` is the matched Express template not the URL; `integrationId` is the only UUID-shaped label allowed; everything else is bounded (cadence, transport, table, queue, state, status_class, severity, mode, status, outcome, job).

**Writers** (files that emit metric values):
- `src/services/monitoringService.ts` — pass timer, work-item timer + outcome, probe duration + outcome, monitored-asset gauge, cursor-mode queue depth gauge, sample-write timer per table (asset_monitor_samples / asset_telemetry_samples / asset_temperature_samples / asset_interface_samples / asset_storage_samples / asset_ipsec_tunnel_samples / asset_associated_ips / asset_lldp_neighbors).
- `src/services/queueService.ts:refreshPgbossMetrics()` — every 15s in pg-boss mode; emits `polaris_pgboss_queue_jobs{queue,state}` (counts) AND `polaris_pgboss_oldest_job_age_seconds{queue,state}` (oldest waiting job's age, MIN(created_on) per queue×state). Also emits `polaris_monitor_queue_mode` once at boot in `initializeQueue()` and `polaris_monitor_workers` from `startPgbossWorkers()`.
- `src/services/fmgWorker.ts` — per-integration queue depth + inflight gauges (one set per integrationId).
- `src/jobs/monitorAssets.ts` — `polaris_monitor_workers` cursor-mode seed at module load; mirrors `setMonitoredAssets` from the pg-boss publisher path so both modes drive the same gauges.
- `src/jobs/capacityWatch.ts` — every 10 min from `getCapacitySnapshot()`: emits `polaris_db_pool_*` (in_use / peak_observed / polaris_capacity / max), `polaris_capacity_severity`, `polaris_disk_free_ratio{volume,roles}`, `polaris_db_dead_tuple_ratio{table}`, `polaris_db_size_bytes`, `polaris_db_steady_state_size_bytes`. Volume + table gauges are `.reset()` before re-stamping each tick so dropped volumes / removed tables don't leave orphan series.
- `src/api/routes/integrations.ts` — discovery duration histogram + outcome counter at all three integration outcomes (success / abort / failure) alongside the existing `recordSample()` call.
- `src/app.ts` — HTTP request timer + in-flight gauge middleware (mounted right after CSRF; skips `/metrics` and `/health`; `/api/v1/auth/login` rate-limited 429s still observed).
- `src/jobs/_metrics.ts:runInstrumentedJob(name, fn)` — every job in `src/jobs/` wraps its tick body with this helper; emits `polaris_job_duration_seconds{job}` + `polaris_job_total{job, outcome}` without changing the job's existing error semantics. `monitorAssets.probe` and `monitorAssets.heavy` are the two label values from the only multi-tick job.

**Readers** (operators / scrapers / out-of-band consumers): `/metrics` HTTP endpoint in `src/app.ts`, gated by `METRICS_TOKEN` Bearer-token auth (auto-generated by the first-run setup wizard). No internal callers — everything Polaris uses comes from in-process state directly.

**Invariants:**
- Single `Registry` singleton — never create a second one. `collectDefaultMetrics` is registered at module load.
- Helpers, not raw metric objects. Callers import `recordProbe(...)` not `probeDuration` so renames or label changes are localized.
- Cardinality is bounded by design. The only non-bounded labels are `integrationId` (counted in dozens) and `route` (counted in route templates, not URLs).
- Cursor-mode-only metrics zero out in pg-boss mode and vice versa — never assume both families are populated. Use `polaris_monitor_queue_mode` to pick which family is authoritative on a given instance.
- `polaris_disk_free_ratio` and `polaris_db_dead_tuple_ratio` are `.reset()` before each capacityWatch re-stamp; volume label set is "current filesystems," not "every filesystem ever seen."
- Sample-write timing is observed only on successful writes. A throw skips the `stop()` call, which is the desired behavior — failures don't pollute the latency distribution.
- Discovery duration histogram observes only on `outcome="success"`; failure/aborted outcomes increment the counter without distorting P95.
- HTTP middleware skips `/metrics` itself so scrape requests aren't counted as application traffic. `/health` skipped for the same reason.

**When changing this:**
- Adding a metric? Define the metric object + its helpers in `src/metrics.ts`, then call from one place. Update the Observability section of CLAUDE.md.
- Adding a job? Wrap the tick body in `runInstrumentedJob("name", async () => ...)` from `src/jobs/_metrics.ts`. Use a stable, machine-readable name (no spaces, no version suffixes); split-loop jobs use `<module>.<loop>` (e.g. `monitorAssets.probe`).
- Adding a label? Audit cardinality first — a per-asset label would explode at fleet scale. If the value is a UUID or per-row, push it into a histogram bucket or aggregate it instead.
- Pg-boss → cursor or vice versa? Both modes' metrics keep emitting; the gauge that doesn't apply stays at 0. Don't conditionally remove either family.
- Changing `getCapacitySnapshot()` shape? Update the `setCapacityGauges` adapter in `capacityWatch.ts` so the gauge stamping doesn't drift from the snapshot fields.
- Changing the HTTP middleware? It must run after session+CSRF (so `req.session` / status are valid) but before the route layer (so `req.route?.path` is captured at finish-time). The current mount point is right after `csrfMiddleware`.

---

# Per-service touches

Listed alphabetically.

## services/activeDirectoryService.ts

**What it owns:** On-prem Active Directory device discovery via LDAP/LDAPS client (computer objects, OU filtering, SID/GUID identity, disabled-account handling).

**Public API:** testConnection, proxyQuery, discoverDevices, ActiveDirectoryConfig, DiscoveredAdDevice, AdDiscoveryResult, AdDiscoveryProgressCallback.

**Cross-service deps:** None (pure LDAP client; no service-to-service calls).

**Used by:** src/api/routes/integrations.ts:14,701,874,1111,1250 — discovery trigger, test connection, manual LDAP proxy query, sync path syncActiveDirectoryDevices.

**Invariants:**
- LDAP simple bind (no Kerberos); default port 636 (LDAPS) or 389 (plain LDAP).
- Device identity: AD `objectGUID` (lowercased hex) → `Asset.assetTag = "ad:{guid}"` (legacy) and `AssetSource.externalId` with `sourceKind="ad"`.
- Cross-link via `objectSid` (string SID) == Entra's `onPremisesSecurityIdentifier` → `tags` stamped with `sid:{SID}` (uppercase) for hybrid-join matching.
- Disabled accounts (userAccountControl & 0x2) → `decommissioned` status when includeDisabled=true (default); skipped entirely when false.
- `ouInclude`/`ouExclude` filters match against full distinguishedName with wildcard support (e.g., `*OU=Workstations*`).
- `lastLogonTimestamp` replicates ~14 days; use as coarse "last seen" signal only.
- Paged subtree search under baseDn with filter `(&(objectCategory=computer)(objectClass=computer))`; hard cap 10,000 results.
- proxyQuery is LDAP search pass-through (filter/baseDn/scope/attributes/sizeLimit configurable).

**When changing this:**
- Verify LDAP bind connection + TLS options (verifyTls flag) still work for LDAPS.
- Test OU filtering (ouInclude/ouExclude wildcard match) against distinguishedName.
- Confirm disabled-account tagging (`ad-disabled` tag) and status logic (decommissioned).
- Check SID cross-link stamping `sid:{SID}` (uppercase) for hybrid-join asset deduplication.
- Validate syncActiveDirectoryDevices creates correct AssetSource rows with sourceKind="ad".
- Test paged search (page size 1000) doesn't miss assets with large OU hierarchies.

---

## services/allocationTemplateService.ts

**What it owns:** Named saved multi-subnet allocation templates backed by Setting table.

**Public API:** listTemplates, saveTemplate, deleteTemplate.

**Used by:** src/api/routes/allocationTemplates.ts:10 (all CRUD operations).

**Invariants:**
- Templates stored as JSON blob in Setting.networkAllocationTemplates
- Prefix length must be [8, 32] per entry
- Non-skip entries require a name; skip entries reserve space only
- VLAN, when present, must be [1, 4094]
- Template name uniqueness (case-insensitive) enforced
- anchorPrefix optional, defaults to 24 if omitted when used

**When changing this:**
- Verify saveTemplate's name-collision detection (idempotent update vs new insert)
- Check prefix length validation matches subnetService expectations
- Test that VLAN validation in allocationTemplateService is consistent with route schema

---

## services/mapRegionService.ts

**What it owns:** Operator-drawn map regions (polygons on the Device Map). CRUD on Setting JSON blob keyed `mapRegions`. Tag-mutation primitives that add `region:<name>` to in-polygon firewalls + cascaded FortiSwitches/FortiAPs and strip it on rename/delete. Tag-registry mirroring (upserts a `Tag` row at `region:<name>` under category "Map Regions" so the asset edit modal's tag picker shows it).

**Public API:** MapRegion, SaveRegionInput, ReconcileSummary, listRegions, getRegion, createRegion, updateRegion, deleteRegion, applyRename, applyDelete, applyOneRegion, reconcileMapRegions.

**Cross-service deps:** `src/utils/geo.ts:pointInPolygon`, `prisma.tag` (registry mirror), `prisma.asset` (membership compute + tag mutations).

**Used by:**
- `src/api/routes/mapRegions.ts` — all CRUD endpoints (`GET / POST / PUT / DELETE /map/regions`); each call awaits the appropriate apply* helper before responding.
- `src/api/routes/integrations.ts` Phase 13 — end-of-syncDhcpSubnets (`mode in {"full", "finalize"}`) calls `reconcileMapRegions()` so newly-discovered firewalls' coords land in the right regions.
- `src/jobs/reconcileMapRegions.ts` — 6h periodic safety net.

**Invariants:**
- Region name unique case-insensitively, 1..64 chars, no control characters.
- Polygon ≥3 vertices and ≤1000; lat in [-90,90]; lng in [-180,180]; finite numbers only.
- Reconciler is **add-only**: only the rename + delete CRUD paths strip a region tag. Manual operator attachments to out-of-polygon assets persist across runs.
- Manually removing a region tag from an in-polygon asset will be re-added on the next reconcile (polygon membership is authoritative in the additive direction).
- Tag-registry rows under category "Map Regions" stay in 1:1 correspondence with region names (create upserts; rename rotates; delete removes).

**When changing this:**
- If the tag prefix or category constants change, also update CLAUDE.md "Map Regions" section + the assets edit modal's tag picker label conventions.
- Membership logic depends on `Asset.fortinetTopology.controllerFortigate` matching firewall hostnames; if discovery ever stops setting that field, the cascade silently breaks. Add a coverage test if discovery topology shape evolves.
- Polygon antimeridian crossings are documented out-of-scope; if Polaris ever supports global polygons, audit `pointInPolygon` for that case.

---

## services/firewallTagService.ts

**What it owns:** `firewall:<hostname>` breadcrumb tags on FortiGate-discovered assets. Reconciler that rebuilds each in-scope asset's `firewall:*` tag set from `Asset.fortinetTopology.controllerFortigate` (managed switches / APs) plus `AssetFortigateSighting` rows within `quarantine.sightingMaxAgeDays` (DHCP-discovered endpoints). Inline lifecycle helpers for firewall create / rename / decommission. Tag-registry mirroring under category "FortiGate".

**Public API:** ReconcileSummary, reconcileFirewallTagsForIntegration, applyFirewallRename, applyFirewallDecommission, seedFirewallTagRegistry.

**Cross-service deps:** `src/services/assetSightingService.ts:getSightingSettings` (reads `sightingMaxAgeDays` for the endpoint freshness window), `prisma.tag` (registry mirror), `prisma.asset` (tag mutations), `prisma.assetFortigateSighting` (endpoint membership).

**Used by:**
- `src/api/routes/integrations.ts` Phase 2a — calls `applyFirewallDecommission(hostname)` per stale firewall after the status flip.
- `src/api/routes/integrations.ts` Phase 3 firewall create — calls `seedFirewallTagRegistry(fgHostname)` after the `prisma.asset.create` so the picker carries the tag from day one.
- `src/api/routes/integrations.ts` Phase 3 firewall update — calls `applyFirewallRename(old, new)` when projection writes a different hostname.
- `src/api/routes/integrations.ts` Phase 13.5 — calls `reconcileFirewallTagsForIntegration(integrationId)` after the Phase 13 map-region pass (`mode in {"full", "finalize"}`).

**Invariants:**
- The `firewall:` prefix is owned by THIS service. No other writer touches `firewall:*` tags.
- FortiGate firewall assets themselves are never tagged — don't tag a device with itself.
- Strip allowlist is always scoped to the current integration's known firewall hostnames. Tags pointing at FortiGates owned by another integration (or operator-typed `firewall:fake`) survive every reconcile pass.
- Endpoint membership comes from `AssetFortigateSighting` rows whose `integrationId` matches AND whose `lastSeen` is within `sightingMaxAgeDays` (0 = forever).
- Infra membership comes from `Asset.fortinetTopology.controllerFortigate` matching one of this integration's firewall hostnames; switches/APs whose controller field is empty get no firewall tag.
- Reconciler is idempotent: writes only when the tag array actually differs.
- Registry rows under category "FortiGate" stay in 1:1 correspondence with active firewall hostnames (create upserts; rename rotates; decommission removes; the reconciler also re-upserts as a safety net so rows don't go missing).

**When changing this:**
- If the tag prefix or category constants change, also update CLAUDE.md "Firewall tag reconcile (Phase 13.5)" section + the touches.md "Asset.tags" cross-cutting entry.
- Endpoint membership depends on the sightings table's `integrationId` index — if `AssetFortigateSighting`'s indexing changes, audit the `findMany` filter for performance regressions.
- Adding a fourth lifecycle path (e.g. operator-driven hostname rename via PUT /assets/:id on a firewall row) means hooking `applyFirewallRename` in that path too — the projection-driven Phase 3 hook only catches discovery-driven renames.
- The reconciler currently runs only at Phase 13.5 of FMG/FortiGate discovery. If discovery is ever skipped or disabled long-term, stale tags persist — operators should run a manual reconcile or delete the tag manually. (No periodic safety-net job exists by design — every input is discovery-written.)

---

## services/apiTokenService.ts

**What it owns:** Long-lived bearer-token CRUD for external API access; argon2id hash + tokenPrefix-based lookup; scope validation (assets:quarantine, assets:read); integrationIds enforcement for quarantine scope.

**Public API:** KNOWN_SCOPES, ApiTokenScope, ApiTokenSummary, AuthenticatedToken, CreateTokenInput, CreateTokenResult, createToken, listTokens, revokeToken, deleteToken, verifyToken.

**Cross-service deps:** none.

**Used by:**
- src/api/routes/apiTokens.ts:55 — GET /api-tokens, list all tokens
- src/api/routes/apiTokens.ts:71 — POST /api-tokens, create new token (show raw once)
- src/api/routes/apiTokens.ts:96 — POST /api-tokens/:id/revoke, revoke by ID
- src/api/routes/apiTokens.ts:114 — DELETE /api-tokens/:id, delete by ID
- src/api/middleware/auth.ts:89 — attachApiToken middleware, verify bearer token on every request
- ...and N other call sites (quarantine/release endpoints use verifyToken indirectly via middleware)

**Invariants:**
- Wire format: `Authorization: Bearer polaris_<32-char-base64url-tail>` (prefix stored separately for fast candidate lookup via index).
- tokenHash is argon2id; never returned; rawToken shown ONCE at creation (POST response).
- assets:quarantine scope requires integrationIds (≥1 FortiManager/FortiGate id); assets:read scopes may have empty integrationIds.
- verifyToken() is best-effort on lastUsedAt/lastUsedIp updates; missed bumps don't fail auth.
- Expired tokens (expiresAt in past) and revoked tokens (revokedAt set) are silently excluded from lookup; no 401 distinction.

**When changing this:**
- Audit scope validation (validateIntegrationIds) if adding new integration types to quarantine support.
- Test wire format edge cases (malformed prefix, truncated token, null bearer header).
- Verify tokenPrefix index is used in verifyToken candidate fetch to keep lookup O(indexed).
- Check that expiresAt comparison handles null and timezone offsets correctly.
- Review quarantine endpoints (assets routes) to confirm they call attachApiToken middleware before verifyToken.

---

## services/assetIpHistoryService.ts

**What it owns:** Asset IP history reads, Settings-backed retention policy, pruning sweep (auto-populated by Prisma query extension in `src/db.ts`).

**Public API:** `getIpHistory(), pruneOldHistory(), getHistorySettings(), updateHistorySettings()`

**Cross-service deps:** None.

**Used by:** `src/api/routes/assets.ts:522 — fetch IP history for asset detail modal`, `src/api/routes/assets.ts:343 — prune endpoint (manual trigger)`

**Invariants:**
- History is auto-populated on every Asset write that touches `ipAddress`; this service reads + prunes only.
- Retention is Setting-backed (`retentionDays`, default 0 = keep forever); `getIpHistory()` filters on read, stored rows never auto-delete unless `pruneOldHistory()` is called.
- `pruneOldHistory()` is a manual operation (not yet hooked to a background job); operator triggers via Server Settings → Maintenance → Prune old IP history.
- Setting persists across app restarts; read-time filtering is applied client-side by `getIpHistory()` calls.

**When changing this:**
- If adding background prune job (jobs/pruneIpHistory.ts), ensure it respects the Setting key "assetIpHistorySettings".
- Verify Prisma extension in `src/db.ts` still writes `AssetIpHistory` on Asset.ipAddress changes.
- Check assets.html History tab UI for retentionDays Setting control + prune button.
- Ensure Prisma schema AssetIpHistory._unique_ constraint on (assetId, ip) handles re-sight updates (lastSeen bump).

---

## services/assetQuarantineService.ts

**What it owns:** Push/pull FortiGate MAC quarantine via persistent `user.quarantine.targets` CMDB tree; orchestrates multi-FortiGate best-effort with per-device all-or-nothing atomicity.

**Public API:** `quarantineAsset(), releaseQuarantine(), verifyAssetQuarantine(), buildTransportForIntegration(), pushQuarantineToFortigate(), unpushQuarantineFromFortigate(), normalizeMac(), quarantineTargetName()`

**Cross-service deps:** `assetSightingService.ts` (for candidate targeting).

**Used by:** `src/api/routes/assets.ts:2098,2115,2130,2168,2189 — quarantine/release/verify endpoints (4 routes)`, `src/api/routes/integrations.ts:3182,3185 — auto-quarantine post-discovery on new FortiGate sighting`

**Invariants:**
- Infrastructure assets (firewall/switch/access_point) rejected at `quarantineAsset()` entry; release does NOT enforce type guard (operator can orphan old entries).
- Per-FortiGate is all-or-nothing (partial failures roll back); across-FortiGate is best-effort (failed targets recorded as `status: "failed"` in `quarantineTargets[]`).
- `statusBeforeQuarantine` preserved on quarantine → release restores it (null → "active" fallback).
- Standalone FortiGate + FMG (proxy/direct) both supported via `buildTransportForIntegration()` parity.
- `quarantineTargets` JSON tracks per-target status: `"synced"` (verified), `"drift"` (missing on later verify), `"failed"` (push error); only `"synced"` eligible for drift-flip on verify.
- Token-scoped quarantine (bearer token) filters sightings by integration before push; release refuses outright if quarantine touches out-of-scope integrations (no partial release).

**When changing this:**
- Audit `fortigateService.ts` + `fortimanagerService.ts` transport compatibility if FortiOS version bumps or endpoint changes.
- Check infrastructure-asset type list (firewall/switch/access_point) against Asset.assetType enum + discovery source-kind tagging.
- Verify `getSightingSettings()` Settings key and max-age filter alignment with caller expectations.
- Review rollback/error-logging in event payload (event action names: asset.quarantine.succeeded/partial/failed/released/unpush.failed).

---

## services/assetSightingService.ts

**What it owns:** Records DHCP-only (asset, FortiGate) sightings to drive quarantine fan-out targeting.

**Public API:** `recordSightings(), getSightingsForAsset(), getQuarantineCandidates(), getSightingSettings(), updateSightingSettings()`

**Cross-service deps:** None.

**Used by:** `src/api/routes/integrations.ts:3148 — batch-record sightings after DHCP discovery sync`, `src/api/routes/assets.ts:1837 — fetch sighting list for Quarantine tab`, `src/services/assetQuarantineService.ts:455 — fan-out targeting within quarantineAsset()`

**Invariants:**
- Sightings are deduped by `(assetId, fortigateDevice)` pair; `seenAt` determines entry precedence, `dhcp_reservation` trumps `dhcp_lease` on tie.
- `getQuarantineCandidates()` filters by `sightingMaxAgeDays` Setting (default 180; 0 = no filter); stored rows never auto-prune.
- Only DHCP evidence qualifies (transit via System tab interface scrape intentionally excluded per design).
- Every caller of `recordSightings()` must dedupe + normalize before passing; batch upsert handles dedup again for safety.

**When changing this:**
- Check `assetQuarantineService.ts` `quarantineAsset()` for sighting-filter logic (max-age, integration scoping).
- Verify `integrations.ts` `syncDhcpSubnets()` call site still matches expected SightingInput shape.
- Review Settings UI (assets.html) sighting age control and max-age tooltip.
- Ensure `pruneOldHistory` job (if added) respects Setting-backed retention separately from max-age filter.

---

## services/autoMonitorInterfacesService.ts

**What it owns:** Auto-monitor interface selection UI for FMG/FortiGate integration (three resolver modes: names / wildcard / type). Selection is additive only—never strips existing operator-owned pins.

**Public API:** `compileWildcard`, `resolvePinnedInterfaces`, `getInterfaceAggregate`, `previewAutoMonitorForClass`, `applyAutoMonitorForClass`, `AutoMonitorSelection`, `AutoMonitorClass`, `ResolverInterface`, `AggregateRow`, `PreviewResult`, `ApplyResult`.

**Cross-service deps:** none.

**Used by:** `src/api/routes/integrations.ts:25` — apply auto-monitor on discovery and per-class config change (lines 961, 2197).

**Invariants:**
- **Additive-only contract:** `applyAutoMonitorForClass()` union-merges resolved pins with existing `Asset.monitoredInterfaces`; never deletes pins. Operator hand-pins persist across discovery cycles even if auto-config would exclude them.
- **Three resolver modes:** names (exact match set); wildcard (shell `*`/`?` patterns compiled to regex with escaping); type (ifType set matching + optional `onlyUp` filter on operStatus).
- **Latest interface resolution:** `loadLatestInterfaces()` uses `DISTINCT ON (assetId, ifName)` ORDER BY timestamp DESC to get most-recent sample per interface; no separate inventory table.

**When changing this:**
- If adding resolver modes, ensure `resolvePinnedInterfaces()` remains pure (no DB, no I/O) and `applyAutoMonitorForClass()` still verifies additive contract before writing.
- Test wildcard escaping: special chars like `[`, `]`, `^`, `$`, `.` must not become regex syntax.
- Verify aggregation queries stay efficient: `DISTINCT ON` over many assets/interfaces can be slow if interface sample table is huge; consider pagination/filtering if discovering thousands of assets.

---

## services/azureAuthService.ts

**What it owns:** Azure AD (Entra) SAML 2.0 SSO configuration, relay-state generation, SAML response validation, user provisioning on first login.

**Public API:** getSsoSettings, updateSsoSettings, isAzureSsoConfigured, isAzureSsoConfiguredAsync, generateRelayState, getSamlLoginUrl, validateSamlResponse, getSamlLogoutUrl, findOrProvisionSamlUser, SsoSettings.

**Cross-service deps:** None (SAML + database; no service-to-service calls).

**Used by:** src/app.ts:25 — check SSO configured on startup to conditionally skip login page, src/api/routes/auth.ts:29 — SAML login/logout flow (generateRelayState, getSamlLoginUrl, validateSamlResponse, getSamlLogoutUrl, findOrProvisionSamlUser).

**Invariants:**
- SSO settings stored in Setting table (key="sso"); 30-second in-memory cache with expiry.
- SAML IdP config (Entity ID, Login/Logout URLs, certificate) configured via Users page Settings modal.
- Relay state generated as random 32-byte base64url for CSRF protection on redirect.
- SAML response validation uses @node-saml/node-saml library; wantResponseSigned flag controls signature check.
- User provisioning on first login: extract nameID/email from validated Profile, upsert User row with default role, auto-enable if disabled.
- skipLoginPage flag allows direct IdP redirect when SSO enabled (bypass Polaris login page).
- autoLogoutMinutes triggers silent logout after inactivity (0 = disabled).

**When changing this:**
- Test SSO cache expiry (30s) on getSsoSettings; verify updateSsoSettings invalidates _samlClient.
- Check SAML validation still rejects unsigned responses when wantResponseSigned=true.
- Confirm user provisioning correctly maps SAML Profile fields (nameID, email, groups) to User rows.
- Validate skipLoginPage redirect flow doesn't expose relay state leaks.
- Test logout URL generation with correct nameID/sessionIndex from validated response.

---

## services/blockService.ts

**What it owns:** IP block CRUD and metadata (name, tags, description).

**Public API:** listBlocks, getBlock, createBlock, updateBlock, deleteBlock.

**Used by:** src/api/routes/blocks.ts:7 (all CRUD operations), src/services/subnetService.ts (block parent lookups, overlap validation).

**Invariants:**
- Block deletion forbidden if any active reservations exist across child subnets
- CIDR must be normalized and unique
- IP version immutable after creation (v4 vs v6)
- Tags are optional arrays, filtered client-side in listBlocks

**When changing this:**
- Verify deleteBlock's active-reservation cascade check (affects data integrity)
- Test CIDR normalization in createBlock (e.g., 10.1.1.5/24 → 10.1.1.0/24)
- Check block-listing performance if tag filtering is optimized

---

## services/capacityService.ts

**What it owns:** Capacity snapshot (host/DB/workload), severity grading (ok/watch/amber/red), reason codes, Event emission on severity transition, and steady-state DB size projection. Also orchestrates the two-pass `getCapacitySnapshotWithAdvisor` helper that interleaves Capacity Advisor recompute with reason-building.

**Public API:** `getCapacitySnapshot`, `getCapacitySnapshotWithAdvisor`, `recordCapacityTransition`.

**Cross-service deps:** `monitoringService` (cadences, retention), `timescaleService` (hypertable check), `queueService` (pg-boss installed, boot/persisted mode), `deploymentContext` (DB co-location), `capacityAdvisorService` (dynamic import in `getCapacitySnapshotWithAdvisor`; type-only the other direction to avoid runtime cycle).

**Used by:** `src/jobs/capacityWatch.ts — 10-min capacity check + Event emission`; `src/api/routes/serverSettings.ts — /pg-tuning, /capacity-advisor, /capacity-advisor/stage endpoints`. ~6 call sites.

**Invariants:**
- Severity tiers: **red** = disk <10%, DB >50% of free disk, stale autovacuum >7d on sample table (Timescale hypertables exempt — append-only chunks legitimately don't autovacuum), projected >8× RAM; **amber** = disk 10–20%, projected >4× RAM, dead-tup >20%, ramInsufficient, pgTuningNeeded, max_connections_undersized (advisor-driven); **watch** = disk 20–30%, db_pool_undersized (>=80% of pool capacity), monitor_workers_undersized (advisor-driven rollup), timescale_recommended (sample tables >1 GB, extension not installed), metrics_token_unset, health_token_unset; **ok** = none.
- Legacy `pgboss_recommended` / `pgboss_overdue` / `pgboss_pending` reasons were absorbed into the Capacity Advisor's QUEUE_MODE lever and no longer fire. The advisor's per-lever recommendations are the source of truth for queue-mode advice.
- Advisor-driven reasons (`monitor_workers_undersized`, `max_connections_undersized`) only fire when callers pass `advisor` gap data into `computeReasons`. `getCapacitySnapshot` with `advisor: undefined` skips them; `getCapacitySnapshotWithAdvisor` builds the gaps and re-runs the snapshot in pass 2.
- Reason codes are unique per condition — `projected_exceeds_disk` (red) and `projected_approaches_disk` (amber, >75%) compare *additional growth needed* (`max(0, steadyState - currentDbSize)`) against free disk on the DB volume, not the steady-state total — the bytes already on disk are part of the steady-state total but aren't future growth, so double-counting them was firing red prematurely. Codes are deliberately distinct so transition Events stay distinguishable.
- Volumes deduped by `stat.dev` so single-LV box = one entry, STIG RHEL with separate /var = two.
- Steady-state projection = base DB size – current sample table bytes + projected sample bytes (per monitored asset × rows/day/asset × retention × bytes/row).
- Sample table rows-per-asset-per-day: conservative defaults (e.g., asset_monitor_samples = 86400/intervalSeconds) when no samples yet.
- Connection-pool peak tracking: rolling high-water across all snapshots (resets on process restart); captured before snapshot read so it reflects current state.
- Transition logic: compare new severity to stored severity; emit Event only on change; Severity → Event level: red→error, amber/watch→warning, ok→info.
- recordCapacityTransition() is best-effort (errors logged at debug, never thrown).

**When changing this:**
- Test volume dedup on multi-LV layouts (separate /var/lib/pgsql and /app).
- Verify steady-state projection doesn't underestimate (conservative DEFAULT_ROWS_PER_ASSET_PER_DAY is key).
- Check connection-pool peak doesn't reset unexpectedly (module-local state should survive across route calls).
- Confirm Event emission only fires once per severity change (no duplicate "red" events on each tick).
- Test fallback PG data directory candidates on RHEL/Windows when `SHOW data_directory` fails (non-superuser app role).

---

## services/connectionPathService.ts

**What it owns:** `resolveConnectionPath(assetId)` — endpoint → switch → … → FortiGate connection-path resolver. Walks the upward dependency chain so the Device Map topology overlay can dim everything off-path.

**Public API:** `resolveConnectionPath`, plus the `ConnectionPath` / `ConnectionPathHop` / `ConnectionHopKind` types.

**Cross-service deps:** Reads `Asset` rows directly + `AssetDependencyParent` (the same source-of-truth `dependencyTreeService` writes). Falls back to `Asset.fortinetTopology` when the dependency tree is empty.

**Used by:** `src/api/routes/assets.ts — GET /api/v1/assets/:id/connection-path`. Total 1 call site today.

**Invariants:**
- Firewall start short-circuits: `hops = [self]`, `siteId = self.id`, `alternateUplinks = 0`.
- Switch / AP start: walk begins at self.
- Endpoint start (workstation / server / printer / other): parse `Asset.lastSeenSwitch = "<switchId>/<port>"`; resolve the switch by hostname OR serialNumber under `assetType="switch"`.
- Upward walk reads `AssetDependencyParent` rows; `source="override"` set takes precedence over `source="computed"` per the existing dependency convention. Empty override set is NOT modeled here — the resolver just sees zero parents and falls through to fortinetTopology.
- MCLAG / dual-homed parents pick the one with `monitorStatus="up"` AND most-recent `lastMonitorAt`; remaining parent count is summed across hops into `alternateUplinks`.
- Fallback to `fortinetTopology.controllerFortigate` (switch → firewall) and `.parentSwitch` (AP → switch) only when `AssetDependencyParent` returns zero rows for the cursor — covers fresh installs before `backfillDependencyTree` runs and freshly-discovered switches awaiting recompute.
- Cycle / pathological-data guard: walk cap of 16 hops + a `seen` set so a self-referential override row can't infinite-loop the resolver.
- `endpointPort` lives only on the first switch hop after an endpoint (parsed from `lastSeenSwitch`); `uplinkInterface` lives on every switch / AP hop (from `fortinetTopology.uplinkInterface`).

**When changing this:**
- If MCLAG parent-preference rules change, update both the sort and the `alternateUplinks` accumulation in lock-step.
- If `lastSeenSwitch` format ever shifts beyond `"<switchId>/<port>"`, update `parseLastSeenSwitch`. Discovery writes both `hostname` and `serialNumber` forms today; both are matched by `findSwitchByName`.
- Keep the fortinetTopology fallback rules aligned with how FMG / FortiGate discovery stamps these fields — see fortimanagerService.ts FortiSwitch / FortiAP write paths.
- Don't include `dependencyLayer` in hops — the resolver runs even when the layer is null (e.g. fresh switches between recomputes), and the consumer doesn't need it.
- AssetDependencyParent does NOT contain endpoint rows by design (the dependency tree is infra-scoped); changing that would require coordinating with `dependencyTreeService.recomputeDependencyTree`.

---

## services/credentialService.ts

**What it owns:** Named-credential store for monitoring probes (SNMP v2c/v3, WinRM, SSH, REST API); type-specific config validation; secret masking on GET; merge-and-preserve logic for PUT to retain secrets when client resubmits mask.

**Public API:** CredentialType, SnmpV2cConfig, SnmpV3Config, SnmpConfig, WinRmConfig, SshConfig, RestApiConfig, CredentialConfig, CredentialRecord, SaveCredentialInput, UpdateCredentialInput, stripSecrets, validateConfig, mergeConfigPreservingSecrets, listCredentials, getCredential, createCredential, updateCredential, deleteCredential.

**Cross-service deps:** none.

**Used by:**
- src/api/routes/credentials.ts:50 — GET /credentials, list (secrets masked)
- src/api/routes/credentials.ts:57 — GET /credentials/:id, fetch one
- src/api/routes/credentials.ts:65 — POST /credentials, create
- src/api/routes/credentials.ts:87 — PUT /credentials/:id, update (merge w/ secret preservation)
- src/api/routes/credentials.ts:174 — DELETE /credentials/:id, revoke (fails 409 if asset references it)
- src/api/routes/assets.ts:30 — GET /assets/:id/resolve-monitor-setting, fetch credential for asset monitoring setup

**Invariants:**
- Secret fields (community, authKey, privKey, password, privateKey, apiToken) are masked to "••••••••" on every GET; empty string and mask are treated as "preserve from stored value" on PUT.
- SNMP v2c requires community; v3 requires username + security level + auth/priv keys per level.
- SSH requires username + (password OR privateKey); WinRM requires both username + password.
- REST API requires baseUrl (http/https only, no trailing slash stored) + apiToken; verifyTls defaults false.
- Delete fails with 409 if any asset.monitorCredentialId points to it; check all five credential type columns (monitorCredentialId, responseTimeCredentialId, telemetryCredentialId, interfacesCredentialId, lldpCredentialId).
- validateConfig is called on CREATE and on PUT (after merge), catching type/field mismatches early.

**When changing this:**
- Test secret masking round-trip (GET → masked, PUT w/ mask → original preserved).
- Add new credential types: extend CredentialType union, add SECRET_FIELDS_BY_TYPE entry, add validateXxxConfig branch.
- Test all SNMP v3 security-level combos (noAuthNoPriv, authNoPriv, authPriv); validate protocol enums.
- Ensure delete check covers all five asset credential columns; update the test suite when columns change.
- Verify REST API baseUrl normalization (trim, remove trailing slash, require http/https scheme).

---

## services/deviceIconService.ts

**What it owns:** Operator-uploaded device icons (PNG/JPEG/WebP only, 256KB cap, magic-byte check); bytes-in-DB storage; resolution by manufacturer/model/type priority.

**Public API:** `uploadIcon(), listIcons(), getIconImage(), deleteIcon(), resolveIconForAsset(), loadIconResolutionCache(), resolveIconUrl(), validateUpload()`

**Cross-service deps:** None.

**Used by:** `src/api/routes/deviceIcons.ts:32,56,83,105 — upload/list/delete CRUD + image serve`, `src/api/routes/map.ts:210,267,369,588,710,787 — icon resolution for topology switches/APs/firewalls (icon cache preloaded once per request)`

**Invariants:**
- Scope: "type" (asset type key, enum: server/switch/router/firewall/workstation/printer/access_point/other) or "model" (manufacturer/model or model-only form).
- Type keys normalized to lowercase; model keys trim each side of `/` separator (e.g., "  Fortinet  /  FortiGate-91G  " → "Fortinet/FortiGate-91G").
- Upload validation: mimeType must be PNG/JPEG/WebP (SVG rejected); size ≤256KB; magic-byte prefix must match declared mimeType.
- Resolution is most-specific-wins: manufacturer/model → model → type → null (frontend uses default circle).
- `resolveIconUrl()` is synchronous (used in hot topology path); operates against pre-loaded cache from `loadIconResolutionCache()`.
- Bytes stored as Uint8Array in DeviceIcon.data column; `/api/v1/device-icons/:id/image` serves raw bytes with Content-Type + Cache-Control.

**When changing this:**
- Check magic-byte prefixes (PNG/JPEG/WebP) if adding new formats; ensure length matches actual file signatures.
- Sync VALID_TYPE_KEYS set against Asset.assetType enum if new types added.
- Verify Prisma DeviceIcon schema: unique constraint on (scope, key), Bytes column type for data.
- Review map.ts topology rendering (resolveIconUrl call sites) if icon resolution priority changes.
- Ensure upload route multer fileSize limit (256KB) matches service MAX_ICON_BYTES constant.

---

## services/discoveryDurationService.ts

**What it owns:** Rolling discovery-duration tracking per integration (and per-FortiGate within FMG runs), baseline computation for slow-run detection, and threshold formula.

**Public API:** `recordSample`, `getBaseline`, `getBaselines`, `computeBaseline`.

**Cross-service deps:** none (reads/writes Settings key "discoveryDurationStats").

**Used by:** `src/api/routes/integrations.ts:1035 — slow-check baseline lookup`; `src/api/routes/integrations.ts:1212,1310 — record per-FG and overall run durations`. ~3 call sites.

**Invariants:**
- Only successful (non-aborted, non-errored) runs recorded; failed runs skip `recordSample()` to avoid poisoning the average.
- Rolling window = 10 samples; new sample appends, list trims to last 10.
- Baseline requires ≥3 samples; returns null otherwise.
- Slow-run threshold = `max(avg + 2σ, avg × 1.5, avg + 60s)` — ensures headroom even on uniform fast runs.
- Unit key is either integrationId (overall) or `${integrationId}:${fortigateDevice}` (per-FG).
- Stats are stored in Settings as `{ units: { [unitKey]: { samples: [ms], updatedAt } } }`.

**When changing this:**
- Test threshold formula on small sample sets (3–5 entries) to ensure floor (60s) prevents false positives.
- Verify window=10 balances responsiveness vs stability; too small (5) may be jittery, too large (20) may lag env changes.
- Check getBaselines() batch reads are correct (no off-by-one in map population).
- Confirm recordSample() ignores invalid input (negative ms, non-finite values).
- Test edge case: if all 10 samples are identical, stddev=0 and threshold should still be avg + 60s (floor wins).

---

## services/dnsService.ts

**What it owns:** Reverse (IP → PTR) and forward (hostname → A/AAAA) DNS lookup via three modes (standard/UDP, DoT/TLS, DoH/HTTPS); per-asset TTL caching; resolver configuration storage.

**Public API:** DnsSettings, PtrRecord, ARecord, ResolverLike, getDnsSettings, updateDnsSettings, createResolver, getConfiguredResolver.

**Used by:**
- src/api/routes/assets.ts:14 — GET /assets/:id, resolve PTR names for associated IPs
- src/api/routes/integrations.ts:20 — POST /integrations/discover, resolve PTR during discovery
- src/api/routes/serverSettings.ts:34 — GET/PUT /server-settings/dns, CRUD DNS config + test endpoint

**Invariants:**
- Three modes (standard, dot, doh): standard falls back to system DNS, returns null TTL; DoT connects to port 853 (configurable), parses TCP wire format; DoH uses JSON API (Cloudflare/Google/Quad9).
- Standard mode cannot retrieve TTL from Node's DNS API; callers apply a sensible default (3600s).
- Per-asset PTR caching lives on AssetAssociatedIp.ptrName/ptrTtl/ptrFetchedAt (separate call path for bulk DNS job).
- IPv6 PTR queries use fully-expanded form with nibble reversal (e.g., 2001:db8::1 → 1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa).
- DoH and DoT timeouts are 5 seconds; DoH rejectUnauthorized=false for self-signed certs.

**When changing this:**
- Test all three modes end-to-end; verify TTL handling (null for standard, numeric for DoT/DoH).
- Test IPv6 expansion and nibble reversal separately.
- Verify DoT socket cleanup on timeout (don't leak TLS connections).
- Check DoH JSON parse for missing/malformed responses; filter by type number (1=A, 28=AAAA, 12=PTR).

---

## services/entraIdService.ts

**What it owns:** Microsoft Entra ID (Azure AD) + Intune device discovery via OAuth2 Graph API client (device registration, Intune enrollment, compliance, user assignment).

**Public API:** testConnection, proxyQuery, discoverDevices, EntraIdConfig, DiscoveredEntraDevice, EntraDiscoveryResult, EntraDiscoveryProgressCallback.

**Cross-service deps:** None (pure Graph API client; no service-to-service calls).

**Used by:** src/api/routes/integrations.ts:13,699,861,1110,1241 — discovery trigger, test connection, manual Graph proxy query, sync path syncEntraDevices.

**Invariants:**
- OAuth2 client-credentials flow; tokens cached in-memory by tenantId:clientId until expiry ≥60s buffer.
- Device identity: Entra `deviceId` (GUID) is stable key → `AssetSource.externalId` with `sourceKind="entra"` or `"intune"`.
- When enableIntune=true, both `/v1.0/devices` and `/v1.0/deviceManagement/managedDevices` are fetched & merged on azureADDeviceId ↔ deviceId; Intune data wins on shared fields.
- Hybrid-joined devices carry `onPremisesSecurityIdentifier` (SID) → cross-link to activeDirectoryService via `sid:{SID}` tags.
- Disabled devices (accountEnabled=false) → `decommissioned` status when `includeDisabled=true` (default).
- Asset type inferred from Intune `chassisType` (desktop/laptop → workstation; other → other); Entra-only defaults to workstation.
- `deviceInclude`/`deviceExclude` filters match against displayName with wildcard support.
- proxyQuery is read-only Graph API pass-through (GET only, /v1.0/ or /beta/ prefix required).

**When changing this:**
- Test OAuth2 token caching + refresh 60s before expiry; verify no mid-request expirations.
- Verify Intune merge logic on shared fields (Intune data must win over Entra).
- Check hybrid-join SID cross-link still tags assets correctly for AD ↔ Entra matching.
- Validate deviceInclude/deviceExclude wildcard matching against displayName.
- Confirm syncEntraDevices in integrations.ts creates AssetSource rows with correct sourceKind ("entra"/"intune") based on sources array.

---

## services/eventArchiveService.ts

**What it owns:** All outbound Event flows (syslog/SFTP archival), event retention/prune configuration, and asset auto-decommission settings. Events created anywhere flow through here via job (pruneEvents) + optional real-time forwarders.

**Public API:** `getArchiveSettings`, `updateArchiveSettings`, `testConnection`, `archiveAndExport`, `getSyslogSettings`, `updateSyslogSettings`, `testSyslogConnection`, `getRetentionSettings`, `getCachedRetentionSettings`, `updateRetentionSettings`, `getAssetDecommissionSettings`, `updateAssetDecommissionSettings`.

**Cross-service deps:** none (reads Settings, spawns sftp/scp/nc, uses prisma Event table).

**Used by:** `src/jobs/pruneEvents.ts:20,25 — scheduled archive/export`; `src/jobs/decommissionStaleAssets.ts:13 — inactivity threshold`; `src/api/routes/events.ts — admin CRUD endpoints`; `capacityService.ts:997 — capacity transition Event creation`. ~8 call sites.

**Invariants:**
- All successful Events are written to `prisma.event.create()` by callers (routes, services, jobs); eventArchiveService does not write Events, only manages their export/retention.
- Archive export (SFTP/SCP) reads Events older than cutoff, writes JSON file, transfers via ssh/sftp spawn, then deletes from DB (via pruneEvents job).
- Retention cache (1 min TTL) avoids DB read on every Event write; callers using `getCachedRetentionSettings()` must accept stale data.
- Asset decommission threshold (0 = disabled) is in months; lastSeen older than that triggers `decommissioned` status in a separate 24h job.
- Syslog (UDP/TCP/TLS) sends test messages synchronously; real event forwarding NOT in this service (would be added as a background job).
- SFTP batch-file injection prevention: paths with quotes/newlines rejected before spawn.

**When changing this:**
- Test archiveAndExport with large Event payloads (>10k rows); verify SFTP/SCP progress.
- Verify retention cache doesn't mask rapid setting changes; 60s may be too long for some ops.
- Check asset decommission query doesn't accidentally mark live assets as stale (lastSeen >= cutoff).
- Confirm syslog test messages arrive with the right facility/severity/format.
- Validate SFTP injection prevention doesn't reject legitimate Windows paths with backslashes.

---

## services/fortigateService.ts

**What it owns:** Standalone FortiGate REST API client & discovery (mirrors FMG scope—DHCP subnets, reservations, device inventory, interface IPs, managed FortiSwitches/FortiAPs, VIPs).

**Public API:** testConnection, fgRequest, proxyQuery, discoverDhcpSubnets, FortiGateConfig, plus re-exported DiscoveryResult & 6 DiscoveredXxx types from FMG.

**Cross-service deps:** fortimanagerService (imports DiscoveryResult shape + types; fortimanagerService imports fgRequest, testConnection, proxyQuery for proxy-mode device iteration).

**Used by:** src/api/routes/integrations.ts:529,695,851,1107,1269 — discovery + test + manual proxy query, src/services/monitoringService.ts:35 — REST calls for uptime monitoring, src/services/reservationPushService.ts:21 — direct REST push of DHCP reservations, src/services/assetQuarantineService.ts:44 — direct REST push of quarantine targets.

**Invariants:**
- fgRequest is the low-level bearer-token auth layer; all per-device queries use it.
- discoverDhcpSubnets returns DiscoveryResult identical to FMG's shape so integrations.ts syncDhcpSubnets pipeline handles both identically.
- FortiAP LLDP/mesh extraction reuses extractApLldpAndMesh (same logic as FMG).
- Standalone FortiGate has no proxy/direct toggle (useProxy doesn't apply); all queries go directly to the device's management IP.
- proxyQuery is a read-only REST pass-through for manual API testing; does not modify CMDB.

**When changing this:**
- Verify DiscoveryResult shape matches fortimanagerService exactly—sync pipeline expects field parity.
- Check monitoringService and both push services still call fgRequest with correct vdom/token/method signatures.
- Confirm proxyQuery handles GET/POST/PUT/DELETE correctly for manual testing route.
- Test discovery parallelism (no clamping unlike FMG proxy mode) with high per-device concurrency.
- Ensure VDOM parameter threading is correct (default "root"; custom vdoms from config).

---

## services/fmgWorker.ts

**What it owns:** Per-integration FortiManager worker with two lanes — a proxy lane (strict concurrency=1 FIFO) for `/sys/proxy/json` calls and a native lane (unbounded) for every other FMG call. Module-level `Map<integrationId, FmgWorker>` lazy-created on first submit; never torn down.

**Public API:** `getFmgWorker(integrationId): FmgWorker`, `FmgWorker.submitProxy<T>(label, task, signal)`, `FmgWorker.submitNative<T>(label, task, signal)`, `FmgWorker.proxyQueueDepth`, `FmgWorker.proxyInFlightLabel`, `FmgWorker.nativeInFlightCount`, `__resetFmgWorkersForTests`.

**Cross-service deps:** metrics (publishes `polaris_fmg_worker_queue_depth{integrationId}` + `polaris_fmg_worker_inflight{integrationId}` for the proxy lane, `polaris_fmg_worker_native_inflight{integrationId}` for the native lane).

**Used by:** src/services/fortimanagerService.ts only — specifically `rpc()`, which inspects each JSON-RPC payload's first param URL and routes to `submitProxy` when it's `/sys/proxy/json` or `submitNative` otherwise. No other module should call `submitProxy` / `submitNative` directly; everything that touches FMG flows through `rpc()` and gets the right lane automatically. By transitivity covers reservationPushService.ts, assetQuarantineService.ts, monitoringService.ts, and the integrations.ts routes that test / probe / manual-query FMG.

**Invariants:**
- Proxy lane is strict FIFO with concurrency=1 — honors FMG's "drops parallel /sys/proxy/json past 1-2" constraint. Cross-feature serialization holds here: an operator clicking "Reserve IP" mid-discovery has the reservation-push proxy call wait behind in-flight discovery proxy calls.
- Native lane is unbounded; the worker just tracks inflight count for observability. Native FMG endpoints (`/pm/config/...`, `/dvmdb/...`, auth) hit FMG's own DB and have no parallel-call constraint.
- Aborts (proxy lane): pre-dispatch abort drops the queued entry and rejects with AbortError. In-flight abort is the task's fetch-signal responsibility.
- Aborts (native lane): no queue, so abort just bubbles through the task's own fetch signal.
- One worker per integration id. Different integrations get independent workers and run fully concurrently across both lanes.

**When changing this:**
- Adding a NEW FMG-bound code path: just call `rpc()` with the integrationId; the lane dispatch is automatic from the JSON-RPC payload URL. Never call `submitProxy` / `submitNative` directly from outside fortimanagerService.
- If a new FMG endpoint pattern shows up that needs lane treatment different from "is it /sys/proxy/json", update `rpcPayloadIsProxy()` in fortimanagerService — keep the predicate the only place that decides which lane.
- Test both lanes when adding behavior — the proxy lane is exercised by FIFO + abort tests; the native lane by concurrent-fire + inflight-decrement-on-throw tests.

---

## services/fortimanagerService.ts

**What it owns:** FortiManager JSON-RPC API client & full discovery orchestration (DHCP subnets, device inventory, interface IPs, VLAN membership, DHCP reservations, FortiSwitches/FortiAPs, VIPs, ARP).

**Public API:** testConnection, resolveDeviceMgmtIpViaFmg, testRandomFortiGate, proxyQuery, fmgProxyRest, proxyQueryViaFortigate, discoverDhcpSubnets, FortiManagerConfig, DiscoveryResult, DiscoveryProgressCallback (and 6 DiscoveredXxx types). Every entry point accepts an optional `integrationId?: string` (and `discoverDhcpSubnets` additionally accepts `warmCacheIps?: Map<string,string>`); when supplied, internal `rpc()` calls funnel through `getFmgWorker(integrationId)` so FMG traffic stays serial against the "one-request-at-a-time" constraint.

**Cross-service deps:** fortigateService (imports discoverDhcpSubnets for direct-mode fallback; imports fgTestConnection and proxyQuery for proxy testing); fmgWorker (every rpc call routes through `getFmgWorker` when an integrationId is in scope).

**Used by:** src/api/routes/integrations.ts:531,693,824,840,1107,1283 — discovery orchestration + test + manual proxy query + realtime push via FMG, src/services/monitoringService.ts:39 — FMG proxy REST for uptime monitoring, src/services/reservationPushService.ts:26 — push DHCP reservations to FortiGate via FMG proxy/direct, src/services/assetQuarantineService.ts:49 — push quarantine targets via FMG proxy/direct.

**Invariants:**
- Proxy mode (`useProxy: true`, default) clamps per-FortiGate parallelism to 1 because FortiManager drops parallel `/sys/proxy/json` connections. The FMG worker's proxy lane enforces that serialization; the per-device CMDB scrapes (interface config, DHCP CMDB, VIPs, geo coords, etc.) run concurrently on the worker's native lane, so per-device throughput is higher than the proxy-lane bottleneck alone would suggest.
- Direct mode (`useProxy: false`) requires valid fortigateApiUser/fortigateApiToken on the FMG integration; mgmt IPs come from either the warm cache (monitor-up firewall Asset rows) or `resolveDeviceMgmtIpViaFmg` for cache-cold/new devices. Cache-cold mgmt-IP resolves now run concurrently across the worker pool (native lane is unbounded) — fresh installs no longer pay the serial-resolve penalty before per-device discovery can start.
- All FMG-bound calls go through `rpc()`, which inspects the JSON-RPC payload's first param URL and routes to `getFmgWorker(integrationId).submitProxy` (when it's `/sys/proxy/json`) or `submitNative` (every other URL). Per-device direct-FortiGate calls do NOT touch FMG and fan out up to `discoveryParallelism` wide independently of the worker.
- Parity invariant: both FMG and standalone FortiGate return identical DiscoveryResult shape for sync pipeline compatibility.
- FortiAP LLDP/mesh fields extracted via extractApLldpAndMesh, skipping wireless-mesh peers (system_description != "FortiSwitch-*").
- Cache-miss fallback in processDevice's direct-mode branch: if a warm-cache dispatch fails, re-resolve via FMG worker and retry once at the freshly-resolved IP. Cleared via `cachedNames.delete(deviceName)` so the loop never iterates more than twice.

**When changing this:**
- Verify parity with fortigateService.discoverDhcpSubnets (DiscoveryResult shape + field semantics).
- Check reservationPushService & assetQuarantineService both call fmgProxyRest correctly for proxy mode + resolveDeviceMgmtIpViaFmg for direct mode, AND that both pass `integrationId` so the call routes through the FMG worker.
- Confirm monitoringService still resolves management IPs and calls fmgProxyRest with `integrationId` for proxy-mode health checks.
- Update docs/fmg-discovery.md if transport modes, roster filters, or per-class stamping change.
- Test proxy-mode parallelism clamp + direct-mode device resolution end-to-end. Confirm warm-cache producer fills the worker pool from t=0 on a fleet with monitor-up firewalls.
- New FMG-bound code paths MUST submit through `getFmgWorker(integrationId)` — bare `rpc()` without an integrationId loses cross-feature serialization and reintroduces the parallel-connection failure mode.

---

## services/interfaceTopologyService.ts

**What it owns:** Infer inter-Fortinet device topology edges (FortiGate ↔ FortiSwitch ↔ FortiAP stacks) from interface naming conventions & serial patterns without new live queries.

**Public API:** inferInterfaceTopology, InterfaceInferredEdge, InterfaceInferredRemote, InterfaceInferenceResult.

**Cross-service deps:** None (reads AssetInterfaceSample rows and in-memory asset inventory; calls utility functions).

**Used by:** src/api/routes/map.ts:19 — topology graph for Device Map (sites/:id/topology endpoint).

**Invariants:**
- Reads latest AssetInterfaceSample per (assetId, ifName) from seed asset set; no live discovery queries.
- Serial-match candidates filtered to exact 1 inventory hit (ambiguous matches skipped); hostname-match same rule.
- Self-loops (asset's own serial/hostname) are rejected.
- Infers both directions when both sides' interface names encode peer identity; targetIfName null when only source side is parseable.
- Matches via parseFortinetPeerInterface utility; peer IP/MAC/model returned from remoteAssets even if outside seed set (cross-site edges).

**When changing this:**
- Verify parseFortinetPeerInterface still extracts serial + hostname patterns correctly.
- Check AssetInterfaceSample query window (latest per ifName) doesn't miss topology artifacts from older samples.
- Confirm ambiguity detection (multiple inventory matches) still blocks inference on both directions.
- Test cross-site edge rendering (remoteAssets for peers outside seed set) in map.ts.
- Validate serialMatchesPeerInterface and hostnameMatchesPeerInterface utility functions.

---

## services/ipService.ts

**What it owns:** IP validation, availability checking, and subnet capacity reporting.

**Public API:** assertValidIp, assertValidCidr, assertIpInSubnet, isIpAvailable, getActiveReservationsForSubnet, subnetCapacity.

**Used by:** src/api/routes/reservations.ts (multiple callers), src/services/reservationService.ts (ipInCidr, detectIpVersion), src/services/reservationPushService.ts (isValidIpAddress).

**Invariants:**
- IPv4-only for capacity calculations (IPv6 raises 400)
- All CIDR inputs are normalized (host bits zeroed)
- IP addresses must be validated before subnet containment checks
- Active reservations indexed on subnetId + status = "active"

**When changing this:**
- Review all calls to assertValidIp/assertValidCidr in routes (ipAddress validation gates many Reservation operations)
- Check utilization calculations depend on subnetCapacity (affects Dashboard utilization card)
- Test with both IPv4 and IPv6 where applicable

---

## services/manufacturerAliasService.ts

**What it owns:** Manufacturer alias CRUD (IEEE legal name → marketing name), in-memory alias map cache synced to Prisma extension, background backfill of normalized strings in Asset and MibFile rows, and idempotent default seed.

**Public API:** `listAliases`, `createAlias`, `updateAlias`, `deleteAlias`, `refreshAliasCache`, `seedDefaultAliases`, `applyAliasesToExistingRows`, `ManufacturerAliasRow`.

**Cross-service deps:** None (consumed by routes and jobs).

**Used by:** `src/api/routes/manufacturerAliases.ts:11 — admin CRUD endpoints`, `src/jobs/normalizeManufacturers.ts:18 — startup seeding and backfill`, `src/db.ts:32 — Prisma extension normalizer hook`.

**Invariants:**
- In-memory map (`setAliasMap()` in `manufacturerNormalize.ts`) must be refreshed after every mutation.
- `seedDefaultAliases()` is idempotent; only inserts missing rows (no overwrites).
- `applyAliasesToExistingRows()` respects (manufacturer, model, moduleName) uniqueness; logs warnings when normalization would create duplicates.
- Prisma extension hooks `normalizeManufacturer()` on all Asset/MibFile create/update/upsert calls.

**When changing this:**
- Update `DEFAULT_ALIASES` constants when IEEE-registered names change or new vendor aliases are discovered.
- Verify `createAlias()` uniqueness check is case-insensitive (alias is lowercased).
- Test `applyAliasesToExistingRows()` backfill with duplicate-collapse edge cases (two rows collapsing to same canonical).
- Confirm `refreshAliasCache()` is called after every CRUD mutation (create/update do this; delete does not since no rows change).
- Inspect `src/db.ts` Prisma extension to ensure normalizer is wired to all manufacturer-write paths.

---

## services/mibService.ts

**What it owns:** Parsing, validation, and CRUD for uploaded SNMP MIB modules. The light validator (`parseMib`) gates uploads (1MB cap, rejects binaries, extracts moduleName + IMPORTS). The heavier peer (`parseMibStructured`) drives the Browse + MIB-aware Walk surface — extracts SYNTAX, INTEGER enum value labels, ACCESS, STATUS, DESCRIPTION, INDEX clauses, and SEQUENCE OF table structure. Per-(manufacturer, model, moduleName) uniqueness is enforced at create.

**Public API:** `parseMib`, `parseMibStructured`, `listMibs`, `getMib`, `createMib`, `deleteMib`, `getMibFacets`, `getProfileStatus`, `ParsedMib`, `ParsedMibStructured`, `MibSymbol`, `MibTable`, `MibBaseType`, `MibAccess`, `MibStatus`, `MibSymbolKind`, `MibEnumValue`, `MibSummary`, `MibFilter`, `CreateMibInput`, `ProfileStatus`, `ProfileSymbolStatus`.

**Cross-service deps:** `oidRegistry` (refreshRegistry, resolveSymbolAtVendorScope, listModelOverrides), `vendorTelemetryProfiles` (VENDOR_TELEMETRY_PROFILES), `mibParserUtils` (stripComments).

**Used by:** `src/api/routes/mibs.ts — list/get/upload/delete + Browse `/structure` + MIB-aware `/walk``, `src/services/oidRegistry.ts:17 — refreshes the symbol table on create/delete`, `src/services/monitoringService.ts — via oidRegistry for vendor profile matching`.

**Invariants:**
- SMI parser validates UTF-8 text only (rejects NUL and control chars <0x20 except tab/CR/LF).
- Module header required: `<NAME> DEFINITIONS ::= BEGIN`; footer required: `END`.
- Duplicate check on (manufacturer, model, moduleName) tuple catches generics via explicit query (NULL handling).
- Successful create/delete always refreshes oidRegistry immediately.
- `parseMibStructured` is a peer of `parseMib`, NOT a superset call. A regression in the structured parser must not be reachable from the upload hot path. Per-symbol parse failures degrade fields to null rather than dropping symbols.

**When changing this:**
- Verify `createMib` duplicate-check logic handles NULL fields in your test data.
- Confirm `parseMib` rejects binary/non-text files (test with fixture files).
- Run `getProfileStatus()` against your vendor MIBs to ensure symbol resolution still works.
- Update `DEFAULT_ALIASES` in `manufacturerAliasService.ts` if adding new vendor facets.
- Check `src/api/routes/mibs.ts` (NOT `serverSettings.ts`) for upload/list/delete endpoint compliance — the MIB routes were extracted there to take precedence over `/server-settings`'s blanket `requireAdmin`.
- Re-run `tests/unit/mibParseStructured.test.ts` — covers IF-MIB-style table detection, INTEGER enum extraction, multi-line DESCRIPTION, embedded `""` quote escapes, and comment-tolerant enum bodies.

---

## services/monitoringService.ts

**What it owns:** Asset health monitoring via probes, telemetry collection, and state machine transitions across five monitor states (unknown → recovering → up → warning → down).

**Public API:** `probeAsset`, `resolveMonitorSettings`, `resolveMonitorSettingsWithProvenance`, `recordProbeResult`, `recordTelemetryResult`, `recordSystemInfoResult`, `recordFastFilteredResult`, `collectTelemetry`, `collectFastFiltered`, `collectSystemInfo`, `collectLldpOnlyFortinet`, `collectLldpOnlySnmp`, `snmpWalkRaw`, `probeCredentialAgainstHost`, `getMonitorSettings`, `updateMonitorSettings`, `invalidateMonitorSettingsCache`, `getAdMonitorProtocol`, `runProbeFor`, `runTelemetryFor`, `runSystemInfoFor`, `runFastFilteredFor`, `runMonitorPass`, `pruneMonitorSamples`, `pruneTelemetrySamples`, `pruneSystemInfoSamples`, `ProbeResult`, `MonitorTierSettings`, `MonitorOverrideSettings`, `ResolvedMonitorSettings`, `AssetMonitorContext`, `ProvenanceTier`, `ResolvedSettingsWithProvenance`, `TelemetrySample`, `InterfaceSample`, `StorageSample`, `TemperatureSample`, `IpsecTunnelSample`, `LldpNeighborSample`, `SystemInfoSample`, `CollectionResult`, `SnmpWalkRow`, `SnmpWalkResult`, `MonitorCadence`, `CadenceOutcome`.

**Cross-service deps:** `fortigateService.ts`, `fortimanagerService.ts`, `timescaleService.ts`, `oidRegistry.ts`, `vendorTelemetryProfiles.ts`.

**Used by:** `src/app.ts:47` — boot timescale detection; `src/api/routes/credentials.ts:17` — probe credential testing; `src/api/routes/integrations.ts:24` — AD monitor protocol selection; `src/api/routes/assets.ts:24` — effective monitor settings + probe request; `src/api/routes/monitorSettings.ts:23` — cache invalidation; `src/jobs/monitorAssets.ts:40` — core monitor loop dispatch; `src/jobs/migrateMonitorSettingsHierarchy.ts:36` — cache invalidation; `src/services/capacityService.ts:41` — monitor settings for capacity calculation.

**Invariants:**
- **Four-tier resolver:** per-asset overrides (top) → class override → integration/manual tier → hardcoded floor. Call `invalidateMonitorSettingsCache(scope)` after any tier-3 or tier-2 write to refresh `resolveMonitorSettings()` on next call.
- **Five-state machine:** unknown → (cs≥threshold) recovering, (cf≥threshold) warning; recovering → (cs≥threshold) up, (cf≥threshold) down; up → (cf=1) warning, (cf≥threshold) down; warning → (cs≥threshold) up, (cf≥threshold) down; down → (cs=1) recovering, stay down.
- **Heavy-cadence suppression:** telemetry/systemInfo/fastFiltered run only when `monitorStatus === "up"`; all other states suppress to avoid unreliable samples.
- **Per-transport dispatch:** probes dispatch on polling method (rest_api → probeFortinet/probeFortinetController; snmp → probeSnmp; winrm → probeWinRm; ssh → probeSsh; icmp → probeIcmp). REST API probes to `/api/v2/monitor/system/status`; SNMP probes `sysUpTime` OID.
- **vendorTelemetryProfiles + oidRegistry consumers:** collectTelemetry/collectSystemInfo/collectLldpOnlySnmp call `pickVendorProfile()` and `resolveOidSync()` for SNMP walks; boot calls `ensureRegistryLoaded()` for warm cache.
- **Credential fallback chain:** asset-level credential → integration-stored token/SNMP → inherited from FMG on FMG-discovered firewalls.
- **Sample writes are async-buffered, status writes are synchronous.** The six append-only sample tables (asset_monitor / asset_telemetry / asset_temperature / asset_interface / asset_storage / asset_ipsec_tunnel) go through `sampleWriteBuffer.enqueue*` and flush every 2 s. `Asset.update` for `monitorStatus` / counters / `last*At` and the per-asset `$transaction` for `assetAssociatedIp` and `persistLldpNeighbors` stay synchronous because they need read-modify-write or per-asset replace semantics that an append-only buffer can't provide. Future contributors adding a new cadence must NOT batch the asset.update — the state machine reads counters then writes new ones, and batching would break that.
- **One Asset findUnique per probe.** `probeAsset(assetId, out?)` populates `out.snapshot` with the asset row it already loaded (with credential + integration includes). `recordProbeResult(assetId, result, preloadedAsset?)` accepts that snapshot to skip its own findUnique. Hot-path callers (runProbeFor) pass the out-object; the operator /probe-now route doesn't bother and pays the extra read.
- **LLDP asset match index is module-cached.** `persistLldpNeighbors` reads through `getLldpAssetMatchIndex()` which caches the index for 60 s and dedupes concurrent rebuilders via an inflight Promise. Stale-cache risk is one cycle of "LLDP neighbor matched to wrong asset" — self-corrects on next scrape. Discovery code that bulk-renames assets / rotates IPs / mass-MAC-edits can call `invalidateLldpMatchCache()` before its next sync if it wants the immediate refresh; the 60 s TTL is the safety net otherwise.

**When changing this:**
- Audit state-machine transitions and verify no edge cases leave assets in phantom states (esp. recovery threshold tuning).
- Update the resolver's tier caches if any integration/manual/override schema changes.
- If adding/removing transport probes, update `pollingCompatibility.ts` matrix and route validation in `monitorSettings.ts`.
- Verify `dropChunks()` calls before sample deletion align with active retention tiers.
- Test supervisor isolation: probe tick (5s) must not block heavy tick (30s) via `runningProbe`/`runningHeavy` guards.

---

## services/oidRegistry.ts

**What it owns:** Per-asset scoped OID symbol resolution from MIBs (device → vendor → generic → seed), layered SCOPED symbol caching with per-symbol provenance, and lazy cache warmup at app startup.

**Public API:** `resolveOid`, `resolveOidSync`, `ensureRegistryLoaded`, `refreshRegistry`, `resolveSymbolAtVendorScope`, `listModelOverrides`, `getMibSymbolCount`, `resolveSymbolsForMib`, `resolveSymbolForMib`, `parseObjectAssignments`, `ResolveScope`, `SymbolStatus`.

**Cross-service deps:** `mibService` (via import in mibService for refreshRegistry calls), `mibParserUtils` (stripComments).

**Used by:** `src/app.ts:46 — startup warmup`, `src/services/monitoringService.ts:43 — telemetry probe resolution`, `src/services/mibService.ts:17 — profile status introspection`, `src/api/routes/mibs.ts — Browse modal OID resolution + MIB-aware walk symbol → numeric OID lookup`.

**Invariants:**
- Resolution is scoped per (manufacturer, model) tuple; both cached and layer-resolved case-insensitively.
- Cache rebuilt entirely on any `refreshRegistry()` call (no partial updates).
- Built-in seed (BUILT_IN_OIDS) always acts as final fallback; vendor OIDs override generic MIBs.
- `resolveOidSync()` returns null until `ensureRegistryLoaded()` has completed and the scope has been accessed.

**When changing this:**
- Add coverage to BUILT_IN_OIDS if new standard SMI roots or vendor enterprise prefixes are needed.
- Test scope layering with overlapping (manufacturer, model) MIBs to verify override order.
- Verify cache key normalization (case-insensitive) handles mixed-case manufacturer input correctly.
- Run `resolveSymbolAtVendorScope()` after updates to confirm vendor-floor symbol availability.
- Profile performance: cache rebuild is O(mibs × entries × resolution-passes); log timings on large uploads.

---

## services/ouiService.ts

**What it owns:** IEEE OUI database download and CSV parsing; lazy in-memory lookup map; admin-editable overrides (prefix → manufacturer+device); cache persistence via Setting table.

**Public API:** lookupOui, lookupOuiBatch, lookupOuiOverride, refreshOuiDatabase, getOuiStatus, OuiOverride, getOuiOverrides, setOuiOverride, deleteOuiOverride.

**Used by:**
- src/api/routes/assets.ts:15 — GET /assets/:id, look up MAC OUI (vendor name)
- src/api/routes/integrations.ts:21 — POST /integrations/discover, tag assets with vendor during discovery
- src/api/routes/serverSettings.ts:36 — GET/PUT /server-settings/oui, CRUD overrides + trigger refresh
- src/jobs/ouiRefresh.ts:30 — Weekly cron job, refresh database and log entries/size

**Invariants:**
- IEEE database is downloaded from standards-oui.ieee.org/oui/oui.csv; stored as JSON in Setting table; loaded on-demand into module-level in-memory map (singleton pattern, reset only on refresh).
- Prefix format: "AABBCC" (6 hex chars); input normalization handles colon/dash/mixed-case (AA:BB:CC, aa-bb-cc, etc.).
- Overrides take priority over IEEE DB; back-compat layer supports legacy bare-string overrides (migrate to {manufacturer, device?} shape on load).
- lookupOuiBatch() avoids repeated DB reads; used by discovery to tag multiple assets in one pass.
- refreshOuiDatabase() runs at startup (skip if <6 days old) and weekly; on 30s HTTP timeout, entire refresh fails (not incremental).

**When changing this:**
- Test MAC normalization (colon/dash/mixed-case input) and prefix extraction.
- Verify override priority (override lookup before IEEE DB).
- Test batch lookup (multiple MACs in one call).
- Check CSV parser for quoted fields (commas inside quotes should not split).
- Ensure refresh doesn't block startup; use timeout so network failures don't hang boot.

---

## services/projectionDriftService.ts

**What it owns:** Best-effort fire-and-forget shadow drift detection after successful AssetSource upserts; logs disagreements only (observability, no behavior change).

**Public API:** `detectAndLogDrift(assetId, integrationKind)`

**Cross-service deps:** None (uses `projectAssetFromSources()` utility + pino logger).

**Used by:** (Not yet called; Phase 3b shadow phase pending Phase 3b.1 actual write implementation)

**Invariants:**
- Fire-and-forget: any internal error is swallowed via `logger.warn()`; drift detection failures must never break the Asset write.
- Drift is asymmetric: projection has X ≠ Y on asset → logged; projection has X, asset null → logged; projection null → silent (no comment = no disagreement).
- Logs to pino with `event: "asset.projection.drift"` (NOT audit Event table); high volume during full sweeps, operators grep app logs.
- Compared fields: hostname, serialNumber, manufacturer, model, os, osVersion, learnedLocation, ipAddress, latitude, longitude (match `ProjectedAsset` keys).
- Logs include `assetId, integrationKind, drifts[]` with per-field projected/current/winningSource provenance.

**When changing this:**
- Sync `PROJECTED_FIELDS` list against `ProjectedAsset` interface additions (assetProjection.ts).
- If projection rules change in `projectAssetFromSources()`, review which drifts are expected (e.g. hostname tiebreak logic).
- Check pino logger setup in `src/utils/logger.ts` for structured field compatibility.
- Once Phase 3b.1 write is implemented, wire `detectAndLogDrift()` into the post-upsert callback in discovery sync paths.

---

## services/queueService.ts

**What it owns:** Monitor work queue mode dispatch (cursor vs. pg-boss) and pg-boss runtime lifecycle. Boot-time mode capture ensures the running process's queue strategy is frozen at startup despite subsequent Setting writes.

**Public API:** `detectPgboss`, `isPgbossInstalled`, `getQueueMode`, `setQueueMode`, `getBootTimeMode`, `initializeQueue`, `startPgbossWorkers`, `stopPgbossWorkers`, `isPgbossRunning`, `publishMonitorJob`, `QUEUE_NAMES`, `QueueMode`.

**Cross-service deps:** `monitoringService.ts`.

**Used by:** `src/app.ts:48` — queue initialization and pg-boss worker lifecycle; `src/jobs/monitorAssets.ts:47` — queue mode dispatch and job publishing; `src/api/routes/serverSettings.ts` — queue mode write; `src/services/capacityService.ts:43` — capacity snapshot input (queue mode + pg-boss status).

**Invariants:**
- **Boot-time mode capture:** mode read once at startup into `bootTimeMode`; `setQueueMode()` updates Setting + cache but never affects running process. New mode takes effect on next restart only.
- **Four queue names:** `polaris-monitor-probe`, `polaris-monitor-fastfiltered`, `polaris-monitor-telemetry`, `polaris-monitor-systeminfo` (jobs prefixed `polaris-monitor-*`).
- **Stalled-worker watchdog:** monitors pgboss.job for >50 created jobs with 0 active; auto-recovers up to 3 times per hour; logs every minute after cap hit.
- **Singleton job policy:** queues are created with `policy: "singleton"` + `singletonKey: ${assetId}:${cadence}` on publish so duplicate `(assetId, cadence)` sends are absorbed while a job is queued or active. `publishDueWork()` can fire every tick without piling stale work, and distinct assetIds run in parallel up to `localConcurrency`. (An earlier iteration passed `policy: "exclusive"` here, which is not a documented pg-boss policy and silently capped each queue to ~1 active job globally regardless of `localConcurrency` — turning a 16-worker pool into a serial consumer and diluting effective probe/telemetry cadence by 10×+ on large fleets. If you see queue depth sustained in the hundreds with active count stuck at 1-2, check this value first.)
- **Two pools per queue:** dedicated `boss.work()` subscriptions own a flat 24 slots per queue (env `POLARIS_MONITOR_PROBE_WORKERS` / `_FAST_WORKERS` / `_HEAVY_WORKERS`); a single floating loop (`startFloatingWorkers`, default 32 via `POLARIS_MONITOR_FLOATING_WORKERS`) polls all four queues in `FLOAT_PRIORITY` order via `boss.fetch()` and dispatches manually with `boss.complete(name, id)` / `boss.fail(name, id, ...)`. Floating capacity flows to whichever queue has backlog. Singleton-key dedup at the publish layer prevents floating ↔ dedicated collisions on the same `(assetId, cadence)`. The loop is shut down via `floatingLoopRunning = false` in both `stopPgbossWorkers` and the auto-recovery path BEFORE calling `boss.stop()` so it doesn't try to fetch against a dead boss instance.

**When changing this:**
- Verify boot initialization runs before monitor ticks fire (happens in `app.ts` startup order).
- If tuning worker counts, check `POLARIS_MONITOR_*_WORKERS` env vars align with concurrency in `monitorAssets.ts`.
- Test pg-boss fallback to cursor when extension/role permissions fail silently.
- Ensure graceful pg-boss shutdown on SIGTERM drains in-flight jobs before process exit.

---

## services/reservationPushService.ts

**What it owns:** DHCP reserved-address push/unpush to FortiGate via FMG proxy or direct REST.

**Public API:** normalizeMac, pushReservation, unpushReservation, releaseDhcpLease.

**Cross-service deps:** fortigateService (fgRequest), fortimanagerService (fmgProxyRest, resolveDeviceMgmtIpViaFmg).

**Used by:** src/services/reservationService.ts:15 (pushReservation on create, unpushReservation on release, releaseDhcpLease on dhcp_lease release).

**Invariants:**
- MAC address must be 48-bit (normalized to xx:xx:xx:xx:xx:xx)
- Transport selection: useProxy=true → FMG proxy, useProxy=false → direct FortiGate REST
- Direct mode requires fortigateApiToken + mgmtInterface on integration config
- Scope resolution by matching gateway+netmask or ip-range start-ip
- Verify-by-readback mandatory; failure throws AppError (triggers reservation rollback)
- Description format: "Polaris/<user>: <hostname>" or "Polaris: <hostname>"
- Lease release (releaseDhcpLease) uses /api/v2/monitor/system/dhcp/release-lease (best-effort, no rollback)

**When changing this:**
- Test both FMG proxy and direct modes with actual FortiOS DHCP server configs
- Verify MAC normalization handles all separators (colons, dashes, dots, none)
- Check scope resolution fallbacks (gateway+netmask, then ip-range)
- Test verify-by-readback on slow devices (echoed id missing, need IP+MAC lookup)

---

## services/reservationService.ts

**What it owns:** Reservation creation, updates, release, expiry, and DHCP push orchestration.

**Public API:** listReservations, getReservation, createReservation, updateReservation, releaseReservation, nextAvailableReservation, expireStaleReservations.

**Cross-service deps:** reservationPushService (pushReservation, unpushReservation, releaseDhcpLease, normalizeMac).

**Used by:** src/api/routes/reservations.ts:12 (all CRUD + next-available), src/jobs/expireReservations.ts:11 (expireStaleReservations every 15 min).

**Invariants:**
- MAC address required when push eligible (subnet discovered by FMG/FortiGate with pushReservations=true)
- Full-subnet reservation (ipAddress=null) → subnet.status = "reserved"; per-IP → remains available
- No duplicate active reservations (unique constraint on subnetId, ipAddress, status="active")
- Subnet must not be deprecated (409 if status="deprecated")
- Push failure rolls back the Polaris reservation (fail-on-failure semantics)
- Released reservations clear pushedTo* fields and drop historical released rows (unique constraint relief)
- Discovered dhcp_lease release attempts bestEffort via releaseDhcpLease (failure does not block Polaris release)

**When changing this:**
- Test createReservation's push eligibility detection and MAC validation order
- Verify releaseReservation's transaction scope (unpush, lease release, subnet status reset)
- Check expireStaleReservations is called every 15 min via jobs/expireReservations.ts
- Audit the atomic create-and-push path for rollback edge cases (orphaned device entries)

---

## services/reservationStaleService.ts

**What it owns:** Stale DHCP-reservation detection, alerting, and alert management (snooze, ignore).

**Public API:** getStaleSettings, updateStaleSettings, listStaleReservations, snoozeReservation, setStaleIgnored, flagStaleReservations.

**Used by:** src/api/routes/reservations.ts:13 (list/snooze/ignore endpoints), src/jobs/flagStaleReservations.ts:19 (flagStaleReservations every 6 hours).

**Invariants:**
- Stale threshold (staleAfterDays) defaults to 60 days, 0 = disabled
- Cold-start grace: effective baseline = max(createdAt, detectionStartedAt) to avoid flooding on first run
- A row is stale if (lastSeenLeased < threshold OR never seen leased before) AND (threshold > 0)
- Snooze extends alert by staleAfterDays from now (not from threshold); clears staleNotifiedAt
- Ignored rows stay suppressed regardless of threshold; detectionStartedAt persists across runs
- flagStaleReservations emits one reservation.stale Event per fresh transition (staleNotifiedAt null → timestamp)
- Discovery clears staleNotifiedAt on re-sighting (re-arms alert for future silence)

**When changing this:**
- Verify staleAfterDays threshold propagates to all callers (threshold=0 should disable all alerts)
- Test cold-start grace window (rows pre-dating detectionStartedAt get full threshold window)
- Check flagStaleReservations only fires on active dhcp_reservation rows (not discovered dhcp_lease)
- Audit snooze idempotency: repeated snooze clicks should extend from "now" not from prior snooze

---

## services/sampleWriteBuffer.ts

**What it owns:** Periodic batch-flush buffer for the six append-only monitor sample tables (asset_monitor_samples / asset_telemetry_samples / asset_temperature_samples / asset_interface_samples / asset_storage_samples / asset_ipsec_tunnel_samples). Collapses per-work-item `prisma.<table>.create*` calls into one `createMany` per 2 s flush window so the monitor hot loop stops eating DB pool capacity per probe.

**Public API:** `enqueueMonitorSample`, `enqueueTelemetrySample`, `enqueueTemperatureSamples`, `enqueueInterfaceSamples`, `enqueueStorageSamples`, `enqueueIpsecTunnelSamples`, `flushAllSampleBuffers`, `startSampleWriteBuffer`, `shutdownFlushSampleBuffers`, `FLUSH_INTERVAL_MS`, all six row-type interfaces.

**Cross-service deps:** `prisma` (db.js), `retryOnDeadlock` (utils/dbRetry.js), `startSampleWriteTimer` + `setSampleBufferDepth` (metrics.js), `logger` (utils/logger.js).

**Writers (the only callers of `enqueue*`):**
- `src/services/monitoringService.ts:recordProbeResult` — `enqueueMonitorSample` for the probe outcome row.
- `src/services/monitoringService.ts:recordTelemetryResult` — `enqueueTelemetrySample` (CPU/memory) and `enqueueTemperatureSamples` (per-sensor).
- `src/services/monitoringService.ts:recordSystemInfoResult` — `enqueueInterfaceSamples`, `enqueueStorageSamples`, `enqueueIpsecTunnelSamples`.
- `src/services/monitoringService.ts:recordFastFilteredResult` — same three as systemInfo, smaller subset (pinned interfaces only).

**Readers:** none directly. The sample tables are read by `assets.ts` route handlers (chart endpoints), `capacityService.ts` (sample-table breakdown), and Cytoscape topology builders — none of those see the buffer, only the persisted rows after a flush.

**Boot + shutdown:**
- `src/app.ts:startSampleWriteBuffer()` called once after queue init.
- `src/app.ts` SIGTERM/SIGINT hook awaits `shutdownFlushSampleBuffers()` before `process.exit(0)` so a graceful restart drains the buffer.

**Invariants:**
- **Append-only.** No conflicts on createMany — every row is a fresh time-series sample with a synthetic UUID `id`. Don't try to add upsert/dedupe logic; if you need replace semantics, do it synchronously in the record function before enqueueing (cf. `persistLldpNeighbors`, which is NOT buffered for this reason).
- **Snapshot-on-flush.** `flushTable` splices the current array up front so concurrent enqueues during the awaited `createMany` land in a fresh array. On retry-exhausted failure the snapshot is re-prepended for the next tick.
- **Per-table flush guard.** `flushing[key]` prevents re-entry on the same table — a 2 s tick that fires while a slow flush is still mid-write becomes a no-op for that table, no concurrent writer per table.
- **Trade-off documented:** up to 2 s of sample rows lost on hard crash. Acceptable because samples are an append-only time series and the next cadence tick re-supplies; UI state (Asset row, status pill) is still synchronous.

**When changing this:**
- New sample table → add a `BufferKey`, an `enqueueXxx` helper, a `TABLE_LABEL` entry, and a `switch` arm in `writeBatch`. Touch the test file too — same shape.
- Flush interval change → consider both UI latency (samples take this long to appear on charts) and crash-window data loss. The current 2 s was the explicit operator choice.
- Don't add a `prisma.$transaction` here. `createMany` is one network round-trip already; wrapping it in a transaction just adds round-trips without giving us anything (each table is independent, no cross-table invariant).

---

## services/searchService.ts

**What it owns:** Global typeahead search across all domain entities, with input classification (IP/CIDR/MAC/text) and parallel entity-specific queries capped at 8 results per group.

**Public API:** `searchAll`, `normalizeMac`.

**Cross-service deps:** none (uses cidr.js utils and prisma directly).

**Used by:** `src/api/routes/search.ts:14 — GET /api/v1/search endpoint`. Total 1 call site.

**Invariants:**
- MAC normalization handles any whitespace/colon/dash separator; result is uppercase colon form.
- CIDR vs plain IP vs MAC classification is hierarchical: CIDR requires `/` with `/\d{1,2}$` pattern; IP uses `isValidIpAddress()` fallback; MAC is compact 12-hex-digit match with any separator.
- PER_GROUP_LIMIT (8) caps all six hit groups (blocks/subnets/reservations/assets/ips/sites); order is stable (name/hostname/cidr asc).
- Pinned firewalls (assetType=firewall + lat/lng set) are queried as their own group via `searchPinnedFirewalls`; `searchAssets` excludes them at the SQL layer via a `NOT { AND: [...] }` filter so each group gets an independent 8-row budget. Both pathways funnel through `runAssetSearch(like, mac, baseFilter)` which owns the OR clauses + four cross-search pathways + dedup merge — keep them in lock-step when adding new asset-search fields.
- `runAssetSearch` runs five parallel pathways merged into one 8-row dedup pipeline: `byAsset` (direct Asset OR including `assignedTo` and `department`), `sourceHits` (`AssetSource.externalId` with `entra:` / `ad:` / `fgt:` / `intune:` / `fortiswitch:` / `fortiap:` prefix-strip), `macSideHits` (`AssetMacAddress.mac`), `ipSideHits` (`AssetAssociatedIp.ip`), and `jsonHitIds` (raw-SQL UNION over `assets.associatedUsers::text` + `asset_sources.observed::text` ILIKE — backed by the GIN trigram indexes from migration `20260507200000_search_json_trgm_indexes`). `byAsset` wins ties; the side / source / JSON pathways fill remaining budget in that order. Apply `baseFilter` to every pathway (including the JSON-id reload) so the firewall vs. non-firewall partition holds.
- Asset origin resolution (for topology modal focus) prioritizes most-recent DHCP sighting, falls back to `learnedLocation` for Entra/AD-discovered hosts.
- AssetSource externalId search strips `entra:`, `ad:`, `fgt:`, `intune:`, `fortiswitch:`, `fortiap:` prefixes so operators can paste either form.

**When changing this:**
- Test IP classification edge cases (IPv6, /32 subnets, partial CIDR).
- Verify site/firewall filtering doesn't drop valid results.
- Confirm AssetSource dedup logic preserves the right hit when both asset and source rows match.
- Check PER_GROUP_LIMIT doesn't regress; pagination in dropdown expects exactly 8 per group.
- Validate MAC normalization handles all common formats (colon, dash, no separator).

---

## services/serverSettingsService.ts

**What it owns:** Server-wide configuration: NTP (servers, timezone), HTTPS (certs, ports, redirect), and certificate management (upload, list, delete, self-signed generation).

**Public API:** `getNtpSettings`, `updateNtpSettings`, `getHttpsSettings`, `updateHttpsSettings`, `listCertificates`, `addCertificate`, `deleteCertificate`, `generateSelfSignedCert`, `resolveHttpsCertificates`.

**Cross-service deps:** none.

**Used by:** `src/app.ts:385 — boot-time HTTPS port selection`; `src/httpsManager.ts:41,12 — TLS setup and request redirection`; `src/api/routes/serverSettings.ts — full CRUD endpoints`. ~6 call sites across routes and init.

**Invariants:**
- NTP, HTTPS, certificate lists persist in Settings table under `key: "ntp"`, `"https"`, `"certificates"` respectively.
- HTTPS enabled requires both certId and keyId; if either is missing, `resolveHttpsCertificates()` returns null (no TLS active).
- Self-signed cert CN must match `/^[A-Za-z0-9.*_-]+$/` to prevent openssl injection via `/` field separator.
- Certificate store is a single JSON array in the "certificates" Setting; each cert carries id, category (ca/server), type (cert/key), PEM, and metadata.
- Backup/restore flows NOT in this service (they live in updateService).

**When changing this:**
- Test cert upload validation (PEM parsing, magic-byte checks if added).
- Verify HTTPS port changes take effect on next boot, not runtime.
- Check self-signed cert generation doesn't fail on Windows (openssl path).
- Confirm cert list dedup handles UUID collisions.
- Test cascading delete: if a server cert is deleted, routes using it should gracefully skip TLS.

---

## services/subnetService.ts

**What it owns:** Subnet creation, allocation, bulk templates, and lifecycle (manual vs discovered).

**Public API:** listSubnets, getSubnet, createSubnet, allocateNextSubnet, bulkAllocate, previewBulkAllocate, updateSubnet, getSubnetIps, deleteSubnet.

**Cross-service deps:** ipService (indirectly via cidrContains/cidrOverlaps from utils/cidr.ts).

**Used by:** src/api/routes/subnets.ts:7 (all operations), src/services/reservationService.ts (subnet lookups, status checks), src/services/utilizationService.ts (subnet status grouping).

**Invariants:**
- Subnet must be contained within parent block CIDR
- No overlapping sibling subnets in the same block (checked before create)
- IPv4-only for auto-allocation (allocateNextSubnet, bulkAllocate)
- Subnet status = "deprecated" rejects new reservations
- Full-subnet reservation (ipAddress=null) sets subnet status → "reserved"
- Prefix length must be [8, 32] for IPv4

**When changing this:**
- Test allocateNextSubnet's findNextAvailableSubnet logic (concurrent allocations must not race)
- Verify bulkAllocate's anchor-aligned packing (all-or-nothing transaction)
- Check updateSubnet does not allow status changes that violate reservation constraints
- Review overlapping-sibling check performance for large blocks

---

## services/timescaleService.ts

**What it owns:** TimescaleDB extension detection and hypertable migration for six sample tables; `dropChunks` pre-filter for retention pruning. Boot-time detection caches hypertable status; subsequent `isHypertable()` checks return cached value without round-tripping.

**Public API:** `detectTimescale`, `isTimescaleAvailable`, `isHypertable`, `getDetectionState`, `dropChunks`, `migrateToHypertables`, `SAMPLE_TABLES`, `SampleTableName`, `DetectionState`.

**Cross-service deps:** none.

**Used by:** `src/app.ts:47` — boot detection and hypertable migration; `src/services/monitoringService.ts:56` — `dropChunks` calls in pruning; `src/services/capacityService.ts:42` — hypertable status for capacity snapshot.

**Invariants:**
- **Boot-time detection cache:** `detectTimescale()` caches result; cache updates only on successful probe. Re-detection runs after `migrateToHypertables()` completes so `isHypertable()` reflects post-conversion state.
- **`dropChunks` no-op on plain Postgres:** checks `isHypertable(tableName)` early and returns immediately if false; safe to call unconditionally as a pre-filter before per-class `deleteMany`.
- **`migrateToHypertables()` idempotent:** creates hypertables only if not already present; compression policy removed and re-added every boot so `TIMESCALE_COMPRESS_AFTER_DAYS` changes take effect on next startup.
- **Chunk-granular drops:** `drop_chunks` can only drop a chunk when ALL rows are older than cutoff; fast O(1) filter for old chunks before residue cleanup via `deleteMany`.

**When changing this:**
- Verify `detectTimescale()` is called before any sample write so hypertable status is fresh.
- If modifying `SAMPLE_TABLES`, keep in sync across detection, pruning, and migration logic.
- Test plain-Postgres fallback path: verify `dropChunks` no-op and `deleteMany` handles all pruning when extension unavailable.
- Check compression policy drift if operators change `TIMESCALE_COMPRESS_AFTER_DAYS` mid-boot cycle (only takes effect next restart).

---

## services/totpService.ts

**What it owns:** RFC 6238 TOTP secret generation, enrollment QR codes, time-windowed code verification (±30s), and argon2id-hashed backup code generation and consumption.

**Public API:** generateSecret, buildEnrollment, verifyCode, generateBackupCodes, consumeBackupCode.

**Cross-service deps:** none.

**Used by:**
- src/api/routes/auth.ts:602 — POST /totp/enroll, QR code + secret generation
- src/api/routes/auth.ts:603 — POST /totp/enroll, render QR SVG
- src/api/routes/auth.ts:209 — POST /login/totp, verify TOTP code during login
- src/api/routes/auth.ts:625 — POST /totp/confirm, validate code at enrollment finish
- src/api/routes/auth.ts:203 — POST /login/totp, consume backup code on fallback
- src/api/routes/auth.ts:629 — POST /totp/confirm, generate backup codes on enable
- src/api/routes/auth.ts:668 — DELETE /totp, consume backup code on disable
- src/api/routes/auth.ts:671 — DELETE /totp, verify code before disabling

**Invariants:**
- TOTP secret must be base32-encoded; verify operations accept ±1 step (30s drift tolerance) to absorb client/server clock skew.
- Backup codes are 10 hex pairs (XXXX-XXXX format), argon2id-hashed on generation, never returned in plaintext after enrollment.
- Backup code consumption is stateless (caller must persist the returned array); no rate limiting on individual code attempts — the login lockout gate (5 failures, 15 min) protects the flow.
- Two-phase login flow: password success → pendingToken issued; TOTP/backup-code step consumes pendingToken and upgrades to full session.

**When changing this:**
- Test both TOTP verification (standard code + ±1 step boundary) and backup code round-trips (generation, hashing, consumption, array mutation).
- Audit all call sites in auth.ts for pendingToken lifecycle (issue at line 118, consume at 195/226/233).
- If adjusting RFC 6238 params (SHA1, 6 digits, 30s step): users must re-enroll; plan migration messaging.
- Verify no secrets leak into logs (codes are transient; hashes are stored on User rows — check password.ts utility).

---

## services/updateService.ts

**What it owns:** In-app software update check, availability detection (Docker vs git checkout), update application pipeline (backup→pull→npm ci→tsc→migrate→restart), and progress tracking.

**Public API:** `initUpdateStatus`, `getUpdateStatus`, `isUpdateMechanismAvailable`, `clearUpdateStatus`, `checkForUpdates`, `applyUpdate`, `getRecentCommits`.

**Cross-service deps:** none (spawns git/npm/prisma, reads/writes .update-status.json, creates DB backup).

**Used by:** `src/api/routes/serverSettings.ts:1135,1143,1151,1159 — Application Updates card endpoints`; `src/jobs/updateCheck.ts:19,31 — hourly check job`. ~6 call sites.

**Invariants:**
- Update mechanism disabled in Docker (`/.dockerenv` present, `.git/` absent) or when no `.git/` checkout exists; `getUpdateStatus()` returns `state: "disabled"` with a human-readable reason.
- Status persists in `.update-status.json` at APP_DIR root; survives restarts.
- applyUpdate() runs background; only one apply in flight at a time (`_applying` flag).
- Backup is optional (skippable via Setting "update.skip_backup"); pre-update backups registered in "backup_history" Setting.
- Encryption: backup password → AES-256-GCM ciphertext wrapped in `[POLARIS\0][salt][iv][authTag][ct]` envelope.
- Six-step pipeline: backup, git pull, npm ci, tsc, prisma migrate, restart (via NSSM on Windows, systemd exit(1) on Linux).

**When changing this:**
- Test update path on both git-backed and Docker installs; verify "disabled" message is clear.
- Check backup encryption round-trip: verify restored backup is valid SQL.
- Confirm npm ci timeout (5 min) doesn't kill slow installs; adjust if needed.
- Test git pull fallback chain (origin/HEAD → origin/main → origin/master).
- Verify restart doesn't kill in-flight requests; 1.5s delay before exit(1) should be enough.

---

## services/utilizationService.ts

**What it owns:** Aggregates subnet usage statistics (blocks, subnets, reservations) for dashboards.

**Public API:** getGlobalUtilization, getBlockUtilization.

**Used by:** src/api/routes/utilization.ts:6 (GET / for dashboard, GET /blocks/:id for per-block drill-down).

**Invariants:**
- Global utilization counts all blocks, subnets, and active reservations in one query set
- IPv6 block addresses capped at Number.MAX_SAFE_INTEGER to avoid precision loss
- Deprecated subnets excluded from allocatedAddresses calculation
- Subnet status grouping: available, reserved, deprecated

**When changing this:**
- Test large fleet performance (blocks query with full subnet tree may be slow with 100k+ subnets)
- Verify usagePercent calculation (allocatedAddresses / blockAddresses) matches business intent
- Check that deprecated subnets are correctly filtered from block capacity

---

## services/vendorTelemetryProfiles.ts

**What it owns:** Built-in vendor telemetry profiles (Cisco, Juniper, Mikrotik, Fortinet, HP-Aruba, Dell) matching assets by manufacturer + OS regex and exposing symbolic OID queries for CPU/memory via oidRegistry resolution.

**Public API:** `VENDOR_TELEMETRY_PROFILES`, `pickVendorProfile`, `VendorTelemetryProfile`, `CpuQuery`, `MemoryQuery`.

**Cross-service deps:** None (vendorTelemetryProfiles is leaf; consumed by monitoringService + mibService).

**Used by:** `src/services/monitoringService.ts:45 — probe strategy selection for telemetry`, `src/services/mibService.ts:18 — profile status reporting in MIB database UI`.

**Invariants:**
- `match` regex is tested against `"${manufacturer ?? ''} ${os ?? ''}".trim()` (both fields optional).
- Entries ordered in priority; first match wins (no fallback after).
- CPU/memory symbols must exist in uploaded MIBs for the profile to resolve; probes fall back to HOST-RESOURCES-MIB if missing.
- Profile selection is read-only; no runtime mutations.

**When changing this:**
- Verify new `match` regex pattern against real asset manufacturer/OS values (case-insensitive).
- Confirm CPU/memory symbol names match the MIB files referenced in CLAUDE.md SNMP stack section.
- Test `pickVendorProfile()` with mixed-case inputs and edge cases (null manufacturer with os set).
- Add profile entry at the end of the array so higher-priority vendors (Cisco) match before fallbacks.
- Update CLAUDE.md narrative if renaming or reordering built-in profiles.

---

## services/windowsServerService.ts

**What it owns:** Windows Server DHCP discovery via WinRM PowerShell remoting (DHCP scopes, subnets, include/exclude filtering).

**Public API:** testConnection, discoverDhcpScopes, WindowsServerConfig, DiscoveredDhcpScope.

**Cross-service deps:** None (WinRM client; no service-to-service calls).

**Used by:** src/api/routes/integrations.ts:12,523,697,1109,1372 — discovery trigger, subnet sync, test connection.

**Invariants:**
- WinRM simple auth (HTTP/HTTPS, default port 5985/5986); no Kerberos.
- PowerShell Get-DhcpServerv4Scope query returns ScopeId (MAC + subnet); mapped to DiscoveredDhcpScope shape (cidr/name/fortigateDevice/dhcpServerId).
- `fortigateDevice` field repurposed to hold DHCP server hostname for compatibility with FMG/FortiGate discovery result shape.
- `dhcpInclude`/`dhcpExclude` scope filtering applied server-side before returning.
- Results fed to same syncDhcpSubnets pipeline as FMG/FortiGate (produces Subnet rows, no device inventory).
- No per-device iteration; single WinRM call returns all scopes on that server.

**When changing this:**
- Verify WinRM URL construction (scheme + port based on useSsl flag).
- Check PowerShell query still works on target Windows versions (Server 2016+).
- Confirm dhcpInclude/dhcpExclude filtering still matches scope IDs/names correctly.
- Test DiscoveredDhcpScope mapping (cidr/name/fortigateDevice/dhcpServerId) feeds syncDhcpSubnets correctly.
- Validate error messages for auth failures, service not running, connection timeouts.
