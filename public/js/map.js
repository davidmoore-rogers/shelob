/**
 * public/js/map.js — Device Map page
 *
 * Reads firewall assets populated by FortiManager / FortiGate discovery (with
 * lat/lng pulled from `config system global`) and plots them on a Leaflet map.
 * A FortiGate click fetches /map/sites/:id/topology and renders a Cytoscape
 * graph of FortiGate → FortiSwitches → FortiAPs, using edge data captured from
 * switch-controller detected-device MAC learnings (real uplinks, not guesses).
 */

(function () {
  var map = null;
  var markerCluster = null;
  var markersById = Object.create(null); // id → L.Marker
  var cyInstance = null;
  var siteCache = [];                    // last /map/sites payload
  // Currently-open topology modal state. siteId drives Refresh + position
  // persistence; data is the latest /topology payload (used for endpoint
  // pivots from search results without a re-fetch).
  var topoState = { siteId: null, hostname: null, data: null, pathOverlay: null };
  var topoSearchDebounce = null;
  var topoSuggestState  = { open: false, items: [], index: -1 };
  var POSITION_STORAGE_PREFIX = "polaris.topology.positions:";

  // Register cytoscape-dagre once. Both globals are populated by the UMD builds
  // loaded in map.html. Guarded so hot-reload doesn't throw.
  if (window.cytoscape && window.cytoscapeDagre && !window._cytoscapeDagreRegistered) {
    window.cytoscape.use(window.cytoscapeDagre);
    window._cytoscapeDagreRegistered = true;
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", async function () {
    await fetchCurrentUser();
    renderNav();

    initMap();
    wireModal();
    wireRegionEditing();

    try {
      await loadSites();
    } catch (err) {
      setStatus("Failed to load sites: " + (err && err.message ? err.message : err));
    }
  });

  // ─── Leaflet setup ────────────────────────────────────────────────────────
  function initMap() {
    map = L.map("map", {
      worldCopyJump: true,
      // Continental-US starting view — bounds will tighten once data loads
      center: [39.5, -95],
      zoom: 4,
    });

    // Leaflet's default marker icons rely on images being sibling to leaflet.css.
    // We bundle them under /css/vendor/leaflet/images — point Leaflet at that
    // path so PNG URLs resolve correctly.
    L.Icon.Default.imagePath = "/css/vendor/leaflet/images/";

    // Theme-aware basemap. OpenStreetMap for light theme, CartoDB Dark
    // Matter for dark. Both are free and don't require API keys; CartoDB
    // is documented as fair-use friendly. Tile layer is swapped in place
    // when the operator clicks the map-theme toggle, OR when the global
    // app theme changes AND the user hasn't set a per-user map override
    // (getMapTheme falls back to the global theme in that case).
    applyBasemapTheme();
    var themeObserver = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].attributeName === "data-theme") { applyBasemapTheme(); break; }
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // Per-user map theme toggle in the toolbar — separate from the
    // global app theme. Click flips the saved preference, swaps the
    // basemap, and re-renders the topology modal if it's open.
    var mapThemeBtn = document.getElementById("map-theme-toggle");
    if (mapThemeBtn) mapThemeBtn.addEventListener("click", toggleMapTheme);

    markerCluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      // Default markercluster coloring buckets by child count (small/medium/large
      // → green/yellow/orange). That's misleading here: a cluster of 100 healthy
      // FortiGates would show orange. Roll up the worst monitor health among
      // children instead so the cluster matches the dot colors it represents.
      iconCreateFunction: clusterIcon,
    });
    map.addLayer(markerCluster);
  }

  // Active basemap tile layer; swapped in place when the map theme
  // changes. Holding the reference here so the MutationObserver in initMap
  // can remove the previous layer cleanly.
  var basemapLayer = null;

  // Map page has its own theme toggle, separate from the overall app
  // theme. Persisted per user in localStorage so each operator's
  // preference survives reload. Falls back to the global app theme
  // when no preference is set, so users who don't toggle see no change.
  function _mapThemePrefKey() {
    var u = (typeof currentUsername === "string" && currentUsername) ? currentUsername : "anon";
    return "polaris-prefs-map-" + u;
  }
  function getMapTheme() {
    try {
      var raw = localStorage.getItem(_mapThemePrefKey());
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && (parsed.theme === "dark" || parsed.theme === "light")) {
          return parsed.theme;
        }
      }
    } catch (e) { /* fall through */ }
    return (document.documentElement.getAttribute("data-theme") || "dark");
  }
  function setMapTheme(theme) {
    try {
      localStorage.setItem(_mapThemePrefKey(), JSON.stringify({ theme: theme }));
    } catch (e) { /* quota / private mode — silently skip */ }
  }

  function applyBasemapTheme() {
    if (!map) return;
    var isDark = getMapTheme() === "dark";
    var url = isDark
      ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
    var attribution = isDark
      ? "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors © <a href=\"https://carto.com/attributions\">CARTO</a>"
      : "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors";
    if (basemapLayer) map.removeLayer(basemapLayer);
    basemapLayer = L.tileLayer(url, { maxZoom: 19, attribution: attribution }).addTo(map);
    paintMapThemeToggle();
  }

  // Update the toolbar toggle's icon to reflect the current state.
  // Sun = "switch to light" (i.e. we're currently dark); moon = "switch
  // to dark" (i.e. we're currently light). Matches the global theme
  // toggle's idiom.
  function paintMapThemeToggle() {
    var btn = document.getElementById("map-theme-toggle");
    if (!btn) return;
    var isDark = getMapTheme() === "dark";
    btn.innerHTML = isDark
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
    btn.title = "Map theme: " + (isDark ? "dark" : "light") + " (click to toggle, saved per user)";
  }
  function toggleMapTheme() {
    var next = getMapTheme() === "dark" ? "light" : "dark";
    setMapTheme(next);
    applyBasemapTheme();
    // If the topology modal is open, re-render so its colors follow
    // the new map theme too — Cytoscape stylesheet reads the theme at
    // render time, not reactively.
    var overlay = document.getElementById("topology-overlay");
    if (overlay && overlay.classList.contains("open") && topoState.data) {
      renderTopologyGraph(topoState.data);
    }
  }

  function clusterIcon(cluster) {
    var children = cluster.getAllChildMarkers();
    var sawMonitored = false;
    var sawDepDown = false;
    var worst = "up"; // up < degraded < down
    for (var i = 0; i < children.length; i++) {
      var s = children[i]._site;
      if (!s || !s.monitored) continue;
      sawMonitored = true;
      if (s.monitorHealth === "down") { worst = "down"; break; }
      if (s.monitorHealth === "degraded" && worst !== "down") worst = "degraded";
      if (s.dependencySuppressed && s.monitorHealth !== "down") sawDepDown = true;
    }
    // Probe-down/degraded wins over dep-down — those are real failures we
    // observed directly. A cluster where every monitored child is healthy
    // but some are dep-down rolls up to dep-down.
    var cls;
    if (!sawMonitored)               cls = "monitor-unmonitored";
    else if (worst !== "up")         cls = "monitor-" + worst;
    else if (sawDepDown)             cls = "monitor-dep-down";
    else                             cls = "monitor-up";
    var count = cluster.getChildCount();
    return L.divIcon({
      html: '<div class="fg-cluster ' + cls + '"><span>' + count + "</span></div>",
      className: "",
      iconSize: [40, 40],
    });
  }

  // ─── Sites load ───────────────────────────────────────────────────────────
  async function loadSites() {
    setStatus("Loading FortiGates…");
    var sites = await api.map.sites();
    siteCache = Array.isArray(sites) ? sites : [];
    markerCluster.clearLayers();
    markersById = Object.create(null);

    if (siteCache.length === 0) {
      setStatus("No FortiGates with coordinates yet. Run a discovery; the map populates from `config system global`.");
      return;
    }

    var latlngs = [];
    siteCache.forEach(function (s) {
      if (s.latitude == null || s.longitude == null) return;
      var m = makeMarker(s);
      markerCluster.addLayer(m);
      markersById[s.id] = m;
      latlngs.push([s.latitude, s.longitude]);
    });

    if (latlngs.length > 0) {
      var bounds = L.latLngBounds(latlngs);
      // Tighter fit — 5% padding around the actual asset bounds (was 20%)
      // so the operator's eye lands on the cluster, not the empty
      // ocean/border. maxZoom bumped to 12 for clustered fleets where
      // the natural fit zoom would otherwise be capped too far out.
      map.fitBounds(bounds.pad(0.05), { maxZoom: 12 });
    }
    setStatus(siteCache.length + " FortiGate" + (siteCache.length === 1 ? "" : "s") + " on the map");

    // If the operator landed here from a global-search hit, the URL hash
    // tells us what to do:
    //   #site=<assetId>                                — pan to marker
    //   #site=<assetId>&topology=1                     — pan + open topology
    //   #site=<assetId>&topology=1&q=<focusQuery>      — pan + open topology
    //                                                    + auto-search the
    //                                                    modal to highlight
    //                                                    a specific endpoint
    // Defer one frame so fitBounds completes before the override.
    var hash = window.location.hash || "";
    if (hash.startsWith("#site=")) {
      var params = {};
      hash.slice(1).split("&").forEach(function (kv) {
        var idx = kv.indexOf("=");
        if (idx <= 0) return;
        params[kv.slice(0, idx)] = decodeURIComponent(kv.slice(idx + 1));
      });
      var hashSiteId = params.site;
      requestAnimationFrame(function () {
        if (params.topology === "1" && hashSiteId) {
          window.polarisMapOpenSiteTopology(hashSiteId, params.q || null);
        } else if (hashSiteId) {
          window.polarisMapPanToAsset(hashSiteId);
        }
      });
    }
  }

  function monitorClass(site) {
    if (!site.monitored) return "monitor-unmonitored";
    // Dependency suppression takes precedence over the probe-derived health
    // when the asset's own probe is succeeding through a redundant path
    // (suppressed but health still "up"). When the probe itself shows
    // "down", that's the real state and we render red — see assetMonitorBadge
    // for the matching priority on the assets list.
    if (site.dependencySuppressed && site.monitorHealth !== "down") return "monitor-dep-down";
    switch (site.monitorHealth) {
      case "up":       return "monitor-up";
      case "degraded": return "monitor-degraded";
      case "down":     return "monitor-down";
      default:         return "monitor-unknown";
    }
  }

  function monitorTooltipLine(site) {
    if (!site.monitored) return "Unmonitored";
    var samples = site.monitorRecentSamples || 0;
    var failures = site.monitorRecentFailures || 0;
    if (site.dependencySuppressed && site.monitorHealth !== "down") {
      var layerHint = (site.dependencyLayer != null) ? " (Layer " + site.dependencyLayer + ")" : "";
      return "Dependency down — upstream parent is offline" + layerHint;
    }
    switch (site.monitorHealth) {
      case "up":       return "Up — last " + samples + " samples ok";
      case "degraded": return "Packet loss — " + failures + "/" + samples + " recent samples failed";
      case "down":     return "Down — " + failures + "/" + samples + " samples failed";
      default:         return "Monitored — no samples yet";
    }
  }

  function makeMarker(site) {
    var label = (site.hostname || "FG").slice(0, 3).toUpperCase();
    var icon = L.divIcon({
      className: "",
      html: '<div class="fg-marker ' + monitorClass(site) + '" aria-hidden="true">' + escapeHtml(label) + "</div>",
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    var marker = L.marker([site.latitude, site.longitude], {
      icon: icon,
      title: site.hostname || "",
    });
    // Stashed for clusterIcon() to roll up health across children.
    marker._site = site;
    marker.bindTooltip(
      '<strong>' + escapeHtml(site.hostname || "(unnamed)") + '</strong>' +
      (site.model ? '<br><span style="opacity:.8">' + escapeHtml(site.model) + '</span>' : "") +
      '<br><span style="opacity:.8">' + escapeHtml(monitorTooltipLine(site)) + '</span>' +
      (site.subnetCount ? '<br>' + site.subnetCount + ' subnet' + (site.subnetCount === 1 ? '' : 's') : ''),
      { direction: "top", offset: [0, -12] }
    );
    marker.on("click", function () { openTopology(site.id, site.hostname || ""); });
    return marker;
  }

  function focusSite(site) {
    if (site.latitude == null || site.longitude == null) return;
    map.flyTo([site.latitude, site.longitude], 13, { duration: 0.8 });
    var marker = markersById[site.id];
    if (marker) {
      // If the marker is still inside a cluster, zoom to it; once revealed,
      // fire a click so the tooltip/modal path is consistent with direct use.
      setTimeout(function () {
        if (markerCluster.hasLayer(marker)) {
          markerCluster.zoomToShowLayer(marker, function () {
            marker.openTooltip();
          });
        } else {
          marker.openTooltip();
        }
      }, 700);
    }
  }

  // ─── Hooks for the global app-wide search ─────────────────────────────────
  // The global search bar in the page header (see app.js _searchTargetFor)
  // covers FortiGate hostname/serial lookup AND endpoint discovery hits as
  // part of its asset results. These hooks let the dropdown drive the map
  // page in place — pan-to-marker, optionally open the topology modal,
  // optionally highlight a specific endpoint via the modal's site-scoped
  // search. All return true on success so the caller can fall back to a
  // page navigation when the asset isn't on this map.
  window.polarisMapPanToAsset = function (assetId) {
    if (!assetId) return false;
    var site = siteCache.find(function (s) { return s.id === assetId; });
    if (!site) return false;
    focusSite(site);
    setStatus('Showing "' + (site.hostname || site.id) + '"');
    return true;
  };

  // Pan to a site, then open its topology modal — like clicking the
  // marker. When focusQuery is set (asset hostname / IP / MAC), the
  // topology modal's site-scoped search runs after load to pulse the
  // matching switch and let the operator see where that endpoint
  // plugs in.
  window.polarisMapOpenSiteTopology = function (siteId, focusQuery) {
    if (!siteId) return false;
    var site = siteCache.find(function (s) { return s.id === siteId; });
    if (!site) return false;
    focusSite(site);
    setStatus('Showing "' + (site.hostname || site.id) + '"');
    // Slight delay so the marker pan-and-zoom animation has started
    // before the modal opens — feels like one continuous gesture.
    setTimeout(function () {
      openTopology(site.id, site.hostname || "");
      if (focusQuery) {
        // The topology modal builds its search async. Wait for the
        // input to exist + the topology data to load before populating
        // it. Bounded retry loop keeps this from hanging.
        var tries = 0;
        var iv = setInterval(function () {
          tries++;
          var input = document.getElementById("topology-search-input");
          if (input && topoState.data) {
            input.value = focusQuery;
            runTopologySearch(focusQuery);
            clearInterval(iv);
          } else if (tries > 40) { // ~4s max
            clearInterval(iv);
          }
        }, 100);
      }
    }, 400);
    return true;
  };

  // ─── Topology modal ───────────────────────────────────────────────────────
  function wireModal() {
    var overlay = document.getElementById("topology-overlay");
    var closeBtn = document.getElementById("topology-close");
    var screenshotBtn = document.getElementById("topology-screenshot");
    var fullscreenBtn = document.getElementById("topology-fullscreen");
    var refreshBtn = document.getElementById("topology-refresh");
    var resetBtn = document.getElementById("topology-reset-layout");
    var showFullBtn = document.getElementById("topology-show-full");
    var searchInput = document.getElementById("topology-search-input");
    closeBtn.addEventListener("click", closeTopology);
    if (screenshotBtn) screenshotBtn.addEventListener("click", screenshotTopology);
    if (fullscreenBtn) fullscreenBtn.addEventListener("click", toggleFullscreenTopology);
    if (refreshBtn) refreshBtn.addEventListener("click", refreshTopology);
    if (resetBtn) resetBtn.addEventListener("click", resetTopologyLayout);
    if (showFullBtn) showFullBtn.addEventListener("click", clearConnectionPathOverlay);
    if (searchInput) wireTopologySearch(searchInput);
    // Intercept clicks on asset links in the topology right-bar so they open
    // the asset details slide-over instead of navigating away to assets.html.
    var infoPanel = document.getElementById("topology-info");
    if (infoPanel) {
      infoPanel.addEventListener("click", function (e) {
        var link = e.target.closest("a[href]");
        if (!link) return;
        var id = _assetIdFromTopoHref(link.getAttribute("href"));
        if (!id) return;
        e.preventDefault();
        openMapAssetPanel(id);
      });
    }
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        closeBtn.classList.add("flash");
        setTimeout(function () { closeBtn.classList.remove("flash"); }, 600);
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("open")) closeTopology();
    });
    // When the browser exits fullscreen via Esc / OS gesture, drop the
    // fullscreen class so the modal styling reverts cleanly.
    document.addEventListener("fullscreenchange", function () {
      var modal = overlay && overlay.querySelector(".modal");
      if (!document.fullscreenElement && modal) modal.classList.remove("topology-fullscreen");
      // Cytoscape needs a resize hint when the container size changes.
      if (cyInstance) { try { cyInstance.resize(); cyInstance.fit(undefined, 30); } catch (e) {} }
    });
  }

  // Toggle native browser fullscreen on the topology modal element. Falls
  // back to a CSS-driven "occupy the whole viewport" mode when the
  // Fullscreen API isn't available (older Safari / iframe contexts).
  function toggleFullscreenTopology() {
    var overlay = document.getElementById("topology-overlay");
    var modal = overlay && overlay.querySelector(".modal");
    if (!modal) return;
    var nativeAvailable = !!(modal.requestFullscreen || modal.webkitRequestFullscreen);
    if (nativeAvailable) {
      if (document.fullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        (modal.requestFullscreen || modal.webkitRequestFullscreen).call(modal);
      }
    } else {
      modal.classList.toggle("topology-fullscreen");
      if (cyInstance) { try { cyInstance.resize(); cyInstance.fit(undefined, 30); } catch (e) {} }
    }
  }

  // Cytoscape ships a built-in cy.png() that respects the current layout/colors
  // and renders independently of the live <canvas>. We pull it as a Blob and
  // copy to the clipboard, mirroring the chart-screenshot UX in assets.js.
  function screenshotTopology() {
    if (!cyInstance) {
      if (typeof showToast === "function") showToast("Topology not loaded", "error");
      return;
    }
    var rootCs = getComputedStyle(document.documentElement);
    var bg = rootCs.getPropertyValue("--color-bg-primary").trim() ||
             rootCs.getPropertyValue("--color-surface").trim() || "#ffffff";
    var blob = cyInstance.png({ output: "blob", scale: 2, full: true, bg: bg });
    if (!blob) {
      if (typeof showToast === "function") showToast("Screenshot failed", "error");
      return;
    }
    if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
      if (typeof showToast === "function") showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
      return;
    }
    navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(function () {
      if (typeof showToast === "function") showToast("Topology copied to clipboard");
    }).catch(function () {
      if (typeof showToast === "function") showToast("Screenshot failed — requires HTTPS or clipboard permission", "error");
    });
  }

  async function openTopology(id, hostname) {
    var overlay = document.getElementById("topology-overlay");
    document.getElementById("topology-title").textContent = hostname || "Site topology";
    document.getElementById("topology-graph").innerHTML = "";
    document.getElementById("topology-info").innerHTML = '<p class="muted">Loading…</p>';
    var searchInput = document.getElementById("topology-search-input");
    if (searchInput) searchInput.value = "";
    closeTopologySearchResults();
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    topoState.siteId = id;
    topoState.hostname = hostname || null;
    topoState.data = null;

    try {
      var data = await api.map.topology(id);
      topoState.data = data;
      renderTopologyGraph(data);
      renderTopologyInfo(data);
    } catch (err) {
      document.getElementById("topology-info").innerHTML =
        '<p class="error">Failed to load topology: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>';
    }
  }

  // Re-fetch + re-render WITHOUT destroying the cytoscape instance up
  // front. We capture current node positions before tear-down so the new
  // graph keeps the operator's manual layout where possible.
  async function refreshTopology() {
    if (!topoState.siteId) return;
    var btn = document.getElementById("topology-refresh");
    if (btn) btn.disabled = true;
    try {
      // Snapshot positions for any nodes that survive the refresh.
      if (cyInstance) saveNodePositions(topoState.siteId);
      var data = await api.map.topology(topoState.siteId);
      topoState.data = data;
      renderTopologyGraph(data);
      renderTopologyInfo(data);
      if (typeof showToast === "function") showToast("Topology refreshed");
    } catch (err) {
      if (typeof showToast === "function") {
        showToast("Refresh failed — " + (err && err.message ? err.message : String(err)), "error");
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Drop the operator's saved node positions for this site and re-run the
  // dagre layout against the cached topology data. Used when manual drags
  // have produced a layout the operator wants to abandon (e.g. inherited
  // positions from before a tuning change to dagre's nodeSep / rankSep).
  function resetTopologyLayout() {
    if (!topoState.siteId || !topoState.data) return;
    try { localStorage.removeItem(POSITION_STORAGE_PREFIX + topoState.siteId); }
    catch (e) { /* quota / private mode — proceed with re-render anyway */ }
    renderTopologyGraph(topoState.data);
    if (typeof showToast === "function") showToast("Layout reset");
  }

  // ── Position persistence ───────────────────────────────────────────────────
  // localStorage-backed per-site node positions. Keyed by site id; value is
  // a map of nodeId → {x, y}. Persisted browser-side only — operator-owned
  // mental layout, not shared across users. Stale entries (nodes that no
  // longer appear in the topology) are silently dropped on next save.
  function saveNodePositions(siteId) {
    if (!cyInstance || !siteId) return;
    var out = {};
    cyInstance.nodes().forEach(function (n) {
      var p = n.position();
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        out[n.id()] = { x: p.x, y: p.y };
      }
    });
    try { localStorage.setItem(POSITION_STORAGE_PREFIX + siteId, JSON.stringify(out)); }
    catch (e) { /* quota / private mode — silently skip */ }
  }
  function loadNodePositions(siteId) {
    if (!siteId) return null;
    try {
      var raw = localStorage.getItem(POSITION_STORAGE_PREFIX + siteId);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) { return null; }
  }

  // ── Topology search (slice 2) ──────────────────────────────────────────────
  function wireTopologySearch(input) {
    input.addEventListener("input", function () {
      if (topoSearchDebounce) { clearTimeout(topoSearchDebounce); topoSearchDebounce = null; }
      var q = input.value.trim();
      if (!q) { closeTopologySearchResults(); return; }
      topoSearchDebounce = setTimeout(function () { runTopologySearch(q); }, 200);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeTopologySearchResults(); input.blur(); return; }
      if (!topoSuggestState.open) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        topoSuggestState.index = Math.min(topoSuggestState.items.length - 1, topoSuggestState.index + 1);
        paintTopologySearchResults();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        topoSuggestState.index = Math.max(0, topoSuggestState.index - 1);
        paintTopologySearchResults();
      } else if (e.key === "Enter") {
        e.preventDefault();
        var pick = topoSuggestState.items[topoSuggestState.index];
        if (pick) handleTopologySearchPick(pick);
      }
    });
    document.addEventListener("click", function (e) {
      var box = document.getElementById("topology-search-results");
      if (!box) return;
      if (e.target === input || (box.contains && box.contains(e.target))) return;
      closeTopologySearchResults();
    });
  }

  async function runTopologySearch(q) {
    if (!topoState.siteId) return;
    try {
      var resp = await api.map.topologySearch(topoState.siteId, q);
      topoSuggestState.items = (resp && resp.results) || [];
      topoSuggestState.index = topoSuggestState.items.length > 0 ? 0 : -1;
      topoSuggestState.open = true;
      paintTopologySearchResults();
    } catch (err) {
      topoSuggestState.items = [];
      topoSuggestState.index = -1;
      topoSuggestState.open = true;
      paintTopologySearchResults();
    }
  }

  function paintTopologySearchResults() {
    var box = document.getElementById("topology-search-results");
    if (!box) return;
    box.innerHTML = "";
    box.hidden = !topoSuggestState.open;
    if (!topoSuggestState.open) return;
    if (topoSuggestState.items.length === 0) {
      var li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No endpoints matched in this site.";
      box.appendChild(li);
      return;
    }
    topoSuggestState.items.forEach(function (item, i) {
      var li = document.createElement("li");
      li.setAttribute("role", "option");
      if (i === topoSuggestState.index) li.classList.add("active");
      var primary = item.hostname || item.ipAddress || item.macAddress || "(unnamed)";
      var bits = [];
      if (item.ipAddress)   bits.push(item.ipAddress);
      if (item.macAddress)  bits.push(item.macAddress);
      if (item.assignedTo)  bits.push(item.assignedTo);
      bits.push(item.switchHostname + (item.port ? "/" + item.port : ""));
      li.innerHTML =
        '<div>' + escapeHtml(primary) + '</div>' +
        '<span class="meta">' + escapeHtml(bits.join(" · ")) + '</span>';
      li.addEventListener("mousedown", function (e) {
        e.preventDefault();
        handleTopologySearchPick(item);
      });
      box.appendChild(li);
    });
  }

  // When the operator picks an endpoint from the topology search:
  //   1. Pulse the matched endpoint's switch on the graph.
  //   2. Fetch the asset's connection path (GET /assets/:id/connection-path)
  //      and overlay the endpoint as a synthetic Cytoscape node connected to
  //      its switch, dimming everything off the path so the chain stands out
  //      visually. The "Show full site" button appears in the modal header
  //      to clear the dim and reveal the rest of the graph.
  // (Asset details aren't auto-opened in the slide-over for this path —
  // operators usually want to see the topology answer first; the asset
  // is reachable from the right-side info panel rows.)
  async function handleTopologySearchPick(item) {
    closeTopologySearchResults();
    if (cyInstance && item.switchId) {
      var node = cyInstance.getElementById(item.switchId);
      if (node && node.length > 0) {
        cyInstance.animate({ center: { eles: node }, zoom: 1.4, duration: 350 });
        node.addClass("topology-pulse");
        setTimeout(function () { try { node.removeClass("topology-pulse"); } catch (e) {} }, 1500);
      }
    }
    if (!item.id || !cyInstance) return;
    try {
      var path = await api.assets.connectionPath(item.id);
      if (path) applyConnectionPathOverlay(path);
    } catch (e) {
      // Best-effort overlay — fall through to the plain pulse on failure.
    }
  }

  // Overlay a focused endpoint→firewall connection path on top of the live
  // Cytoscape graph. Adds a synthetic endpoint node + edge to the first
  // switch hop (when the endpoint isn't already a graph node), then dims
  // every element NOT on the path. Clearing is via the "Show full site"
  // button in the header or by tapping any non-path node.
  function applyConnectionPathOverlay(path) {
    if (!cyInstance || !path || !path.asset || !Array.isArray(path.hops) || path.hops.length === 0) return;
    // Sweep any leftover overlay from a previous search before drawing the new one.
    clearConnectionPathOverlay();
    var ep = path.asset;
    var leaf = path.hops[0];
    var nextHop = path.hops[1];
    var syntheticEdgeId = null;

    // Add the endpoint as a synthetic node when the live topology graph
    // doesn't already include it (which is almost always — endpoints don't
    // appear as Cytoscape nodes in the standard topology response, only in
    // the right-side panel). Switches / APs / firewalls already have nodes,
    // so we skip the synthesis in those cases.
    var alreadyOnGraph = cyInstance.getElementById(ep.id).length > 0;
    if (!alreadyOnGraph && leaf.kind === "endpoint") {
      cyInstance.add({
        group: "nodes",
        data: {
          id: ep.id,
          label: ep.hostname || ep.ipAddress || "endpoint",
          role: "endpoint",
          nodeColor: endpointNodeColor(leaf),
          synthetic: 1,
        },
      });
      // Edge from the endpoint to its first switch hop, labeled with the
      // switch port the endpoint plugs into (parsed from lastSeenSwitch).
      if (nextHop && cyInstance.getElementById(nextHop.id).length > 0) {
        syntheticEdgeId = "ep-edge-" + ep.id;
        cyInstance.add({
          group: "edges",
          data: {
            id: syntheticEdgeId,
            source: ep.id,
            target: nextHop.id,
            label: nextHop.endpointPort ? "port " + nextHop.endpointPort : "",
            synthetic: 1,
          },
        });
      }
    }

    // Build the set of path node ids and resolve each into Cytoscape elements.
    var pathNodeIds = path.hops.map(function (h) { return h.id; });
    var pathElements = cyInstance.collection();
    pathNodeIds.forEach(function (id) {
      var n = cyInstance.getElementById(id);
      if (n.length > 0) pathElements = pathElements.union(n);
    });
    if (syntheticEdgeId) {
      var syn = cyInstance.getElementById(syntheticEdgeId);
      if (syn.length > 0) pathElements = pathElements.union(syn);
    }
    // Edges between two path nodes (controller / interfaceEdges / lldpEdges
    // wiring the switches and FortiGate together) are part of the path too.
    cyInstance.edges().forEach(function (e) {
      var s = e.data("source");
      var t = e.data("target");
      if (pathNodeIds.indexOf(s) !== -1 && pathNodeIds.indexOf(t) !== -1) {
        pathElements = pathElements.union(e);
      }
    });

    cyInstance.elements().not(pathElements).addClass("dimmed");
    topoState.pathOverlay = { endpointId: ep.id, edgeId: syntheticEdgeId };

    var btn = document.getElementById("topology-show-full");
    if (btn) btn.hidden = false;

    try {
      cyInstance.animate({ fit: { eles: pathElements, padding: 60 }, duration: 350 });
    } catch (e) { /* fit may fail if pathElements is empty / single node */ }
  }

  // Remove the dim class and tear down any synthetic endpoint node + edge
  // we added in applyConnectionPathOverlay. Idempotent.
  function clearConnectionPathOverlay() {
    if (!cyInstance) return;
    cyInstance.elements().removeClass("dimmed");
    var overlay = topoState.pathOverlay;
    if (overlay) {
      if (overlay.edgeId) {
        var edge = cyInstance.getElementById(overlay.edgeId);
        try { if (edge.length > 0) cyInstance.remove(edge); } catch (e) {}
      }
      // Only remove the endpoint node when it was synthetic (added by us).
      // Tagged via data.synthetic = 1 so we don't accidentally rip out a
      // pre-existing node (e.g. when the operator searched a switch hostname
      // — that case never adds a synthetic node, but be defensive).
      var ep = cyInstance.getElementById(overlay.endpointId);
      if (ep.length > 0 && ep.data("synthetic")) {
        try { cyInstance.remove(ep); } catch (e) {}
      }
      topoState.pathOverlay = null;
    }
    var btn = document.getElementById("topology-show-full");
    if (btn) btn.hidden = true;
  }

  // Color the synthetic endpoint node by its monitor state — same five-state
  // palette the firewall / switch / AP nodes use, so the path reads as a
  // single visual scheme.
  function endpointNodeColor(hop) {
    if (!hop || !hop.monitored) return "#757575"; // gray — unmonitored
    switch (hop.monitorStatus) {
      case "up":         return "#2e7d32";
      case "warning":    return "#f9a825";
      case "down":       return "#c62828";
      case "recovering": return "#0288d1";
      default:           return "#9e9e9e";
    }
  }

  function closeTopologySearchResults() {
    topoSuggestState.open = false;
    topoSuggestState.items = [];
    topoSuggestState.index = -1;
    var box = document.getElementById("topology-search-results");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  function closeTopology() {
    // Persist current node positions before tear-down so reopening the
    // same site restores the operator's manual layout.
    if (topoState.siteId && cyInstance) saveNodePositions(topoState.siteId);
    closeTopologySearchResults();
    topoState.siteId = null;
    topoState.hostname = null;
    topoState.data = null;
    topoState.pathOverlay = null;
    var showFullBtn = document.getElementById("topology-show-full");
    if (showFullBtn) showFullBtn.hidden = true;
    // Exit native fullscreen first — otherwise the browser stays in
    // fullscreen mode showing nothing after the modal hides, and the user
    // has to hit Esc / their OS gesture to recover.
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        try { exit.call(document); } catch (e) {}
      }
    }
    var overlay = document.getElementById("topology-overlay");
    var modal = overlay && overlay.querySelector(".modal");
    if (modal) modal.classList.remove("topology-fullscreen");
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    if (cyInstance) {
      cyInstance.destroy();
      cyInstance = null;
    }
  }

  // Delegates to PolarisTopologyRender so desktop and mobile share one
  // color scheme. Kept as a local alias for the existing call sites.
  function fortigateNodeColor(fg) {
    return window.PolarisTopologyRender.fortinetNodeColor(fg);
  }

  function renderTopologyGraph(data) {
    // Refresh / reset rebuilds the cyInstance from scratch — any synthetic
    // overlay nodes / edges are gone, so reset the state and hide the
    // "Show full site" button before drawing the new graph. Don't call
    // clearConnectionPathOverlay() here because cyInstance is about to be
    // torn down regardless.
    topoState.pathOverlay = null;
    var showFullBtn = document.getElementById("topology-show-full");
    if (showFullBtn) showFullBtn.hidden = true;

    // Element + stylesheet construction is shared with the mobile topology
    // surface — see public/js/topology-render.js. Desktop opts into the
    // endpoint-overlay styles because the connection-path search dims
    // off-path elements and adds a synthetic round-rectangle endpoint node.
    var elements = window.PolarisTopologyRender.buildTopologyElements(data);

    // Topology graph follows the per-user MAP theme (not the global app
    // theme) so the toolbar toggle drives both the basemap and the
    // modal coherently.
    var theme = getMapTheme();

    // Refresh path: tear down the previous cytoscape before mounting the
    // new one. Without this, a Refresh click stacks two graphs and the
    // canvas leaks.
    if (cyInstance) {
      try { cyInstance.destroy(); } catch (e) {}
      cyInstance = null;
    }

    // Restore manually-dragged node positions from localStorage if any
    // are saved for this site. We use the dagre layout as the base
    // (handles new nodes that didn't exist last time), then snap saved
    // nodes to their stored positions in a layoutstop hook below.
    var savedPositions = topoState.siteId ? loadNodePositions(topoState.siteId) : null;

    cyInstance = cytoscape({
      container: document.getElementById("topology-graph"),
      elements: elements,
      // Box-select: shift+drag on background draws a selection rectangle;
      // selected nodes can be dragged together to rearrange. Multi-node
      // selection is also addable via shift-click on individual nodes.
      // Pan stays as plain drag on background (Cytoscape default).
      boxSelectionEnabled: true,
      selectionType: "additive",
      // Halve scroll-wheel zoom sensitivity — the default felt jumpy on
      // typical mouse wheels (one notch was 25–30% zoom step).
      wheelSensitivity: 0.5,
      layout: {
        name: "dagre",
        rankDir: "LR",
        nodeSep: 30,
        rankSep: 160,
        fit: true,
        padding: 30,
      },
      style: window.PolarisTopologyRender.topologyStylesheet(theme, { includeEndpointOverlay: true }),
    });

    // Restore saved positions AFTER the dagre layout finishes so any
    // brand-new nodes get a sensible default placement and only the ones
    // the operator dragged previously snap to their stored coordinates.
    cyInstance.one("layoutstop", function () {
      if (!savedPositions) return;
      cyInstance.batch(function () {
        cyInstance.nodes().forEach(function (n) {
          var p = savedPositions[n.id()];
          if (p && typeof p.x === "number" && typeof p.y === "number") {
            n.position({ x: p.x, y: p.y });
          }
        });
      });
      try { cyInstance.fit(undefined, 30); } catch (e) {}
    });

    // Persist node position on every drag-stop so a refresh / reopen
    // restores the operator's manual layout. Debounced via the timer
    // below so a long drag doesn't write per-tick.
    var saveTimer = null;
    cyInstance.on("dragfree", "node", function () {
      if (!topoState.siteId) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveNodePositions(topoState.siteId);
      }, 250);
    });

    // Click-through on cross-site Polaris asset nodes — open the asset details
    // slide-over. Other node kinds (firewall, switch, AP, ghost-LLDP) don't
    // have a navigation target so we skip.
    cyInstance.on("tap", 'node[role="remote-asset"]', function (evt) {
      var assetId = evt.target.data("assetId");
      if (assetId) openMapAssetPanel(assetId);
    });

    // Auto-clear the connection-path dim if the operator taps any node
    // currently dimmed off-path — they're trying to navigate the rest of
    // the graph, so get out of their way without forcing them to hunt for
    // the "Show full site" button.
    cyInstance.on("tap", "node.dimmed", function () {
      if (topoState.pathOverlay) clearConnectionPathOverlay();
    });

    // Hover tooltip on edges — explains the rule + evidence behind each
    // connection. Backend stamps a `reason` data field on every edge
    // (controller, interface-inferred, LLDP). The tooltip lets the
    // operator audit the topology layer without reading code.
    cyInstance.on("mouseover", "edge", function (evt) {
      var reason = evt.target.data("reason");
      if (!reason) return;
      var orig = evt.originalEvent;
      var x = orig && typeof orig.clientX === "number" ? orig.clientX : 0;
      var y = orig && typeof orig.clientY === "number" ? orig.clientY : 0;
      showEdgeTooltip(reason, x, y);
    });
    cyInstance.on("mousemove", "edge", function (evt) {
      // Track the cursor so the tooltip follows the edge as the operator
      // sweeps along it.
      var orig = evt.originalEvent;
      if (!orig) return;
      moveEdgeTooltip(orig.clientX, orig.clientY);
    });
    cyInstance.on("mouseout", "edge", function () { hideEdgeTooltip(); });
  }

  // ── Edge hover tooltip ─────────────────────────────────────────────────────
  // Rendered as a fixed-position div appended to <body> (not the modal) so
  // it doesn't get clipped by the modal's overflow rules and stays visible
  // when the modal is fullscreen. Single instance reused for every edge.
  var _edgeTooltipEl = null;
  function ensureEdgeTooltip() {
    if (_edgeTooltipEl) return _edgeTooltipEl;
    var el = document.createElement("div");
    el.id = "topology-edge-tooltip";
    el.setAttribute("role", "tooltip");
    document.body.appendChild(el);
    _edgeTooltipEl = el;
    return el;
  }
  function showEdgeTooltip(text, clientX, clientY) {
    var el = ensureEdgeTooltip();
    // Preserve newlines from the backend reason — pre-wrap renders them
    // and CSS clamps the width.
    el.textContent = text;
    el.classList.add("visible");
    moveEdgeTooltip(clientX, clientY);
  }
  function moveEdgeTooltip(clientX, clientY) {
    var el = _edgeTooltipEl;
    if (!el || !el.classList.contains("visible")) return;
    // Anchor below-right of the cursor, but flip to above-left near the
    // viewport edge so the tooltip never escapes the screen.
    var pad = 14;
    var rect = el.getBoundingClientRect();
    var maxX = window.innerWidth - rect.width - 6;
    var maxY = window.innerHeight - rect.height - 6;
    var x = clientX + pad; if (x > maxX) x = clientX - rect.width - pad;
    var y = clientY + pad; if (y > maxY) y = clientY - rect.height - pad;
    if (x < 6) x = 6;
    if (y < 6) y = 6;
    el.style.left = x + "px";
    el.style.top  = y + "px";
  }
  function hideEdgeTooltip() {
    if (_edgeTooltipEl) _edgeTooltipEl.classList.remove("visible");
  }

  function renderTopologyInfo(data) {
    var fg = data.fortigate || {};
    var parts = [];
    parts.push('<h4>' + escapeHtml(fg.hostname || "FortiGate") + '</h4>');

    parts.push('<div class="detail-row"><span class="label">Serial</span><span class="value">' + escapeHtml(fg.serial || "—") + '</span></div>');
    parts.push('<div class="detail-row"><span class="label">Model</span><span class="value">' + escapeHtml(fg.model || "—") + '</span></div>');
    parts.push('<div class="detail-row"><span class="label">Mgmt IP</span><span class="value">' + escapeHtml(fg.ip || "—") + '</span></div>');
    parts.push('<div class="detail-row"><span class="label">Status</span><span class="value">' + escapeHtml(fg.status || "—") + '</span></div>');
    if (fg.lastSeen) {
      parts.push('<div class="detail-row"><span class="label">Last seen</span><span class="value">' + escapeHtml(new Date(fg.lastSeen).toLocaleString()) + '</span></div>');
    }
    if (fg.latitude != null && fg.longitude != null) {
      parts.push('<div class="detail-row"><span class="label">Coords</span><span class="value">' + fg.latitude.toFixed(4) + ', ' + fg.longitude.toFixed(4) + '</span></div>');
    }

    if ((data.switches || []).length > 0) {
      parts.push('<div class="topology-section"><h5>FortiSwitches (' + data.switches.length + ')</h5><ul>');
      data.switches.forEach(function (s) {
        var endpointCount = s.endpointCount || 0;
        var endpoints = s.endpoints || [];
        parts.push(
          '<li><a href="/assets.html#asset=' + encodeURIComponent(s.id) + '">' + escapeHtml(s.hostname || "(unnamed)") + '</a>' +
          '<span class="meta">' + escapeHtml(displayableUplink(s.uplinkInterface) || "—") + '</span></li>'
        );
        if (endpointCount > 0) {
          var samplesShown = Math.min(endpoints.length, 25);
          var heading = "Endpoints (" + endpointCount + ")";
          if (samplesShown < endpointCount) heading += " — showing " + samplesShown;
          parts.push(
            '<li class="switch-endpoints"><details>' +
            '<summary>' + escapeHtml(heading) + '</summary><ul>'
          );
          endpoints.forEach(function (ep) {
            var primary = ep.hostname || ep.ipAddress || ep.macAddress || "(unnamed)";
            var bits = [];
            if (ep.port) bits.push(ep.port);
            if (ep.ipAddress)  bits.push(ep.ipAddress);
            if (ep.assignedTo) bits.push(ep.assignedTo);
            parts.push(
              '<li><a href="/assets.html#view=asset:' + encodeURIComponent(ep.id) + '">' +
              escapeHtml(primary) + '</a>' +
              '<span class="meta">' + escapeHtml(bits.join(" · ")) + '</span></li>'
            );
          });
          parts.push('</ul></details></li>');
        }
      });
      parts.push('</ul></div>');
    }
    if ((data.aps || []).length > 0) {
      parts.push('<div class="topology-section"><h5>FortiAPs (' + data.aps.length + ')</h5><ul>');
      data.aps.forEach(function (a) {
        var meta = a.peerSwitch ? (a.peerSwitch + "/" + (a.peerPort || "?")) : "direct";
        parts.push(
          '<li><a href="/assets.html#asset=' + encodeURIComponent(a.id) + '">' + escapeHtml(a.hostname || "(unnamed)") + '</a>' +
          '<span class="meta">' + escapeHtml(meta) + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }
    if ((data.subnets || []).length > 0) {
      parts.push('<div class="topology-section"><h5>Subnets (' + data.subnets.length + ')</h5><ul>');
      data.subnets.forEach(function (n) {
        parts.push(
          '<li><a href="/subnets.html#subnet=' + encodeURIComponent(n.id) + '">' + escapeHtml(n.cidr) + '</a>' +
          '<span class="meta">' + (n.vlan ? 'VLAN ' + n.vlan : (n.name ? escapeHtml(n.name) : '—')) + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }

    // CMDB-inferred peers from interface naming conventions (FortiOS-auto
    // serial aggregates + operator-named hostname aggregates). These map
    // back to the solid teal edges in the graph. Built from the inventory
    // we already loaded; sourceIfName tells the operator which local
    // aggregate carries the link.
    var interfaceEdges = data.interfaceEdges || [];
    var remoteLookup = {};
    (data.remoteAssetNodes || []).forEach(function (n) { remoteLookup[n.id] = n; });
    var siblingLookup = {};
    (data.switches || []).forEach(function (s) { siblingLookup[s.id] = s; });
    (data.aps || []).forEach(function (a) { siblingLookup[a.id] = a; });
    if (interfaceEdges.length > 0) {
      parts.push('<div class="topology-section"><h5>Interface-inferred peers (' + interfaceEdges.length + ')</h5><ul>');
      interfaceEdges.forEach(function (e) {
        var target = remoteLookup[e.target] || siblingLookup[e.target] || null;
        var label = target ? (target.hostname || target.ipAddress || target.id) : e.target;
        var hrefId = e.target;
        parts.push(
          '<li><a href="/assets.html#asset=' + encodeURIComponent(hrefId) + '">' + escapeHtml(label) + '</a>' +
          '<span class="meta">' + escapeHtml((e.sourceIfName || "") + (e.matchVia === "hostname" ? " · hostname" : "")) + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }

    // LLDP-discovered neighbors (matched + ghost). Listed alongside Switches /
    // APs so the operator can see what the FortiGate / managed switches
    // actually advertise on the wire — the dashed orange edges in the graph
    // map back to entries here.
    var lldpNodes = data.lldpNodes || [];
    var lldpEdges = data.lldpEdges || [];
    if (lldpNodes.length > 0 || lldpEdges.length > 0) {
      parts.push('<div class="topology-section"><h5>LLDP Neighbors (' + lldpEdges.length + ')</h5><ul>');
      lldpEdges.forEach(function (e) {
        var label = e.targetLabel || "Unknown neighbor";
        var titleHtml = e.targetIsAsset
          ? '<a href="/assets.html#asset=' + encodeURIComponent(e.target) + '">' + escapeHtml(label) + '</a>'
          : escapeHtml(label);
        parts.push(
          '<li><span>' + titleHtml + '</span>' +
          '<span class="meta">' + escapeHtml(e.label || "") + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }

    document.getElementById("topology-info").innerHTML = parts.join("");
  }

  // ─── Map asset panel ─────────────────────────────────────────────────────
  // Slide-over that shows an asset's key details without navigating away from
  // the Device Map. Opened by clicking any asset link in the topology
  // right-bar, a topology search result, or a cross-site graph node.

  function _ensureMapAssetPanelDOM() {
    if (document.getElementById("map-asset-panel-overlay")) return;
    var overlay = document.createElement("div");
    overlay.id = "map-asset-panel-overlay";
    overlay.className = "slideover-overlay";
    overlay.innerHTML =
      '<div class="slideover" id="map-asset-panel">' +
        '<div class="slideover-resize-handle"></div>' +
        '<div class="slideover-header">' +
          '<div class="slideover-header-top">' +
            '<h3 id="map-asset-panel-title">Asset Details</h3>' +
            '<button class="btn-icon" id="map-asset-panel-close" title="Close">&times;</button>' +
          '</div>' +
          '<div class="slideover-meta" id="map-asset-panel-meta"></div>' +
        '</div>' +
        '<div class="slideover-body" id="map-asset-panel-body"><p class="empty-state">Loading…</p></div>' +
        '<div class="slideover-footer" id="map-asset-panel-footer"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeMapAssetPanel();
    });
    document.getElementById("map-asset-panel-close").addEventListener("click", closeMapAssetPanel);
    if (typeof initSlideoverResize === "function") {
      initSlideoverResize(document.getElementById("map-asset-panel"), "polaris.panel.width.asset");
    }
  }

  function closeMapAssetPanel() {
    var overlay = document.getElementById("map-asset-panel-overlay");
    if (overlay) overlay.classList.remove("open");
  }

  async function openMapAssetPanel(id) {
    _ensureMapAssetPanelDOM();
    var titleEl  = document.getElementById("map-asset-panel-title");
    var metaEl   = document.getElementById("map-asset-panel-meta");
    var bodyEl   = document.getElementById("map-asset-panel-body");
    var footerEl = document.getElementById("map-asset-panel-footer");
    titleEl.textContent = "Asset Details";
    metaEl.innerHTML = "";
    bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
    footerEl.innerHTML = "";
    requestAnimationFrame(function () {
      document.getElementById("map-asset-panel-overlay").classList.add("open");
    });

    try {
      var a = await api.assets.get(id);

      var TYPE_LABELS = {
        server: "Server", switch: "Switch", router: "Router", firewall: "Firewall",
        workstation: "Workstation", printer: "Printer", access_point: "Access Point", other: "Other",
      };

      function _row(label, value) {
        if (value == null || value === "") return "";
        return "<div class=\"detail-row\"><span class=\"detail-label\">" + escapeHtml(label) + "</span>" +
               "<span class=\"detail-value\">" + escapeHtml(String(value)) + "</span></div>";
      }
      function _monoRow(label, value) {
        if (value == null || value === "") return "";
        return "<div class=\"detail-row\"><span class=\"detail-label\">" + escapeHtml(label) + "</span>" +
               "<span class=\"detail-value\"><code>" + escapeHtml(String(value)) + "</code></span></div>";
      }

      var parts = ["<div class=\"asset-view-grid\">"];
      parts.push(_row("Hostname", a.hostname));
      parts.push(_row("DNS Name", a.dnsName));
      parts.push(_monoRow("IP Address", a.ipAddress));
      parts.push(_monoRow("MAC Address", a.macAddress));
      parts.push(_monoRow("Serial Number", a.serialNumber));
      parts.push(_row("Manufacturer", a.manufacturer));
      parts.push(_row("Model", a.model));
      parts.push(_row("Type", TYPE_LABELS[a.assetType] || a.assetType));
      parts.push(_row("Status", a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : null));
      parts.push(_row("OS / Firmware", a.osVersion || a.os));
      parts.push(_row("Location", a.location));
      parts.push(_row("Learned Location", a.learnedLocation));
      parts.push(_row("Department", a.department));
      parts.push(_row("Assigned To", a.assignedTo));
      if (a.lastSeen) parts.push(_row("Last Seen", new Date(a.lastSeen).toLocaleString()));
      if (a.acquiredAt || a.createdAt) parts.push(_row("Acquired", new Date(a.acquiredAt || a.createdAt).toLocaleString()));
      if (a.warrantyExpiry) parts.push(_row("Warranty Expires", new Date(a.warrantyExpiry).toLocaleString()));
      parts.push(_row("Purchase Order", a.purchaseOrder));
      if (a.tags && a.tags.length) parts.push(_row("Tags", a.tags.join(", ")));
      parts.push(_row("Notes", a.notes));
      parts.push("</div>");

      titleEl.innerHTML = "Asset Details" + (a.hostname
        ? " <span style=\"color:var(--color-text-secondary);font-weight:400;margin-left:6px\">— " + escapeHtml(a.hostname) + "</span>"
        : "");
      metaEl.innerHTML = "<span class=\"badge\">" + escapeHtml(TYPE_LABELS[a.assetType] || a.assetType || "other") + "</span>";

      bodyEl.innerHTML = parts.join("");
      footerEl.innerHTML =
        "<a class=\"btn btn-sm btn-secondary\" href=\"/assets.html#view=asset:" + encodeURIComponent(id) +
        "\" target=\"_blank\" rel=\"noopener\">Full details</a>" +
        "<span style=\"flex:1\"></span>" +
        "<button class=\"btn btn-sm btn-secondary\" id=\"map-asset-panel-close-btn\">Close</button>";
      document.getElementById("map-asset-panel-close-btn").addEventListener("click", closeMapAssetPanel);
    } catch (err) {
      bodyEl.innerHTML = "<p class=\"empty-state\" style=\"padding:1rem 1.25rem\">Failed to load asset: " +
        escapeHtml(err && err.message ? err.message : String(err)) + "</p>";
    }
  }

  function _assetIdFromTopoHref(href) {
    if (!href) return null;
    var m = href.match(/\/assets\.html#(?:asset=|view=asset:)([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function setStatus(text) {
    var el = document.getElementById("map-status");
    if (el) el.textContent = text;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Filter out FortiOS meta-interface names that don't add useful
  // information to the topology view. "fortilink" is the software-managed
  // FortiLink interface on the FortiGate side; the relationship it
  // represents is already encoded in the FG→switch edge itself, so
  // displaying it as a label is redundant. Real port names like "port49"
  // or aggregate serial-fragments like "8FFTV23025884-0" still pass through.
  function displayableUplink(name) {
    if (!name) return "";
    return String(name).toLowerCase() === "fortilink" ? "" : name;
  }

  // ─── Region editing (admin / networkadmin only) ──────────────────────────
  // Regions are NOT rendered on the default map view. The "Edit regions"
  // toolbar button toggles an edit mode that overlays existing regions and
  // mounts the leaflet-draw control. Saving / renaming / deleting reconciles
  // tags on the backend; exiting edit mode hides the overlay again.
  var regionState = {
    editing: false,
    layer: null,           // L.featureGroup of L.polygon
    drawControl: null,
    polygonsByRegionId: {} // id → L.polygon
  };

  function wireRegionEditing() {
    var btn = document.getElementById("map-edit-regions");
    if (!btn) return;
    if (typeof canManageNetworks === "function" && !canManageNetworks()) return;
    btn.hidden = false;
    btn.addEventListener("click", function () {
      if (regionState.editing) exitRegionEditMode();
      else enterRegionEditMode().catch(function (err) {
        setStatus("Failed to load regions: " + (err && err.message ? err.message : err));
      });
    });
  }

  async function enterRegionEditMode() {
    if (regionState.editing) return;
    regionState.editing = true;
    regionState.polygonsByRegionId = {};
    regionState.layer = L.featureGroup().addTo(map);

    var regions = [];
    try {
      regions = await api.mapRegions.list();
    } catch (e) {
      regionState.editing = false;
      if (regionState.layer) { map.removeLayer(regionState.layer); regionState.layer = null; }
      throw e;
    }
    if (Array.isArray(regions)) {
      for (var i = 0; i < regions.length; i++) addRegionPolygon(regions[i]);
    }

    regionState.drawControl = new L.Control.Draw({
      position: "topright",
      draw: {
        polygon: { allowIntersection: false, showArea: false, shapeOptions: { className: "map-region-polygon" } },
        polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false
      },
      edit: { featureGroup: regionState.layer, remove: false } // delete is a polygon-popup action so we can confirm
    });
    map.addControl(regionState.drawControl);

    map.on(L.Draw.Event.CREATED, onRegionCreated);
    map.on(L.Draw.Event.EDITED, onRegionEdited);

    var btn = document.getElementById("map-edit-regions");
    if (btn) btn.textContent = "Done editing";
    setStatus("Editing regions: draw a polygon, click an existing region to rename/delete, or click \"Done editing\" to hide.");
  }

  function exitRegionEditMode() {
    regionState.editing = false;
    map.off(L.Draw.Event.CREATED, onRegionCreated);
    map.off(L.Draw.Event.EDITED, onRegionEdited);
    if (regionState.drawControl) { map.removeControl(regionState.drawControl); regionState.drawControl = null; }
    if (regionState.layer) { map.removeLayer(regionState.layer); regionState.layer = null; }
    regionState.polygonsByRegionId = {};
    var btn = document.getElementById("map-edit-regions");
    if (btn) btn.textContent = "Edit regions";
    setStatus("");
  }

  function addRegionPolygon(region) {
    if (!region || !Array.isArray(region.polygon) || region.polygon.length < 3) return;
    var poly = L.polygon(region.polygon, { className: "map-region-polygon" });
    poly._polarisRegionId = region.id;
    poly._polarisRegionName = region.name;
    poly.bindTooltip(escapeHtml(region.name), { permanent: true, direction: "center", className: "map-region-label" });
    poly.on("click", function () { openRegionActionsPopup(poly); });
    regionState.layer.addLayer(poly);
    regionState.polygonsByRegionId[region.id] = poly;
  }

  function polygonLatLngsToPairs(poly) {
    // L.Polygon.getLatLngs() returns nested rings for multi-rings; we only
    // create simple polygons here, so pull the first ring out.
    var rings = poly.getLatLngs();
    var ring = Array.isArray(rings) && rings.length > 0 && Array.isArray(rings[0]) ? rings[0] : rings;
    var pairs = [];
    for (var i = 0; i < ring.length; i++) {
      var ll = ring[i];
      pairs.push([ll.lat, ll.lng]);
    }
    return pairs;
  }

  async function onRegionCreated(e) {
    var layer = e.layer;
    var pairs = polygonLatLngsToPairs(layer);
    var name = await promptRegionName("Name this region", "");
    if (!name) return; // cancelled
    try {
      var saved = await api.mapRegions.create(name, pairs);
      // Replace the temporary draw layer with our managed L.polygon so
      // it picks up the styled className + click handler.
      addRegionPolygon(saved);
      setStatus("Region \"" + saved.name + "\" saved.");
    } catch (err) {
      window.alert("Failed to save region: " + (err && err.message ? err.message : err));
    }
  }

  async function onRegionEdited(e) {
    var layers = e.layers;
    if (!layers) return;
    var edits = [];
    layers.eachLayer(function (layer) {
      if (!layer._polarisRegionId) return;
      edits.push({ id: layer._polarisRegionId, polygon: polygonLatLngsToPairs(layer) });
    });
    for (var i = 0; i < edits.length; i++) {
      try {
        await api.mapRegions.update(edits[i].id, { polygon: edits[i].polygon });
      } catch (err) {
        window.alert("Failed to update region: " + (err && err.message ? err.message : err));
      }
    }
    if (edits.length > 0) setStatus(edits.length + " region" + (edits.length === 1 ? "" : "s") + " updated.");
  }

  function openRegionActionsPopup(poly) {
    if (!regionState.editing) return;
    var id = poly._polarisRegionId;
    var name = poly._polarisRegionName || "";
    var html =
      '<div style="display:flex;flex-direction:column;gap:6px;min-width:180px">' +
        '<div style="font-weight:600">' + escapeHtml(name) + '</div>' +
        '<button type="button" class="btn btn-secondary" data-region-rename="' + escapeHtml(id) + '">Rename</button>' +
        '<button type="button" class="btn btn-danger" data-region-delete="' + escapeHtml(id) + '">Delete</button>' +
      '</div>';
    var popup = L.popup({ closeButton: true, autoClose: true }).setLatLng(poly.getBounds().getCenter()).setContent(html).openOn(map);
    setTimeout(function () {
      var renameBtn = document.querySelector('[data-region-rename="' + id + '"]');
      var deleteBtn = document.querySelector('[data-region-delete="' + id + '"]');
      if (renameBtn) renameBtn.addEventListener("click", function () { map.closePopup(popup); renameRegion(id, name); });
      if (deleteBtn) deleteBtn.addEventListener("click", function () { map.closePopup(popup); deleteRegion(id, name); });
    }, 0);
  }

  async function renameRegion(id, currentName) {
    var next = await promptRegionName("Rename region", currentName);
    if (!next || next === currentName) return;
    try {
      var updated = await api.mapRegions.update(id, { name: next });
      var poly = regionState.polygonsByRegionId[id];
      if (poly) {
        poly._polarisRegionName = updated.name;
        if (poly.getTooltip()) poly.setTooltipContent(escapeHtml(updated.name));
      }
      setStatus("Region renamed to \"" + updated.name + "\".");
    } catch (err) {
      window.alert("Failed to rename region: " + (err && err.message ? err.message : err));
    }
  }

  async function deleteRegion(id, name) {
    var ok = window.confirm('Delete region "' + name + '"? The "region:' + name + '" tag will be removed from every asset that carries it.');
    if (!ok) return;
    try {
      await api.mapRegions.delete(id);
      var poly = regionState.polygonsByRegionId[id];
      if (poly && regionState.layer) regionState.layer.removeLayer(poly);
      delete regionState.polygonsByRegionId[id];
      setStatus("Region \"" + name + "\" deleted.");
    } catch (err) {
      window.alert("Failed to delete region: " + (err && err.message ? err.message : err));
    }
  }

  // Reuses the project's openModal helper from app.js. Resolves to the trimmed
  // name or null if the operator cancels.
  function promptRegionName(title, initial) {
    return new Promise(function (resolve) {
      var bodyHtml =
        '<label style="display:block;margin-bottom:6px;font-size:0.9rem">Region name</label>' +
        '<input type="text" id="region-name-input" maxlength="64" value="' + escapeHtml(initial || "") + '" ' +
          'style="width:100%;padding:6px 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary);color:var(--color-text-primary)">' +
        '<p style="margin-top:8px;font-size:0.8rem;color:var(--color-text-tertiary)">Saved as the tag <code>region:&lt;name&gt;</code>.</p>';
      var footer =
        '<button type="button" class="btn btn-secondary" id="region-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="region-save">Save</button>';
      var resolved = false;
      function finish(value) {
        if (resolved) return;
        resolved = true;
        if (typeof closeModal === "function") closeModal();
        resolve(value);
      }
      if (typeof openModal !== "function") {
        var v = window.prompt(title + ":", initial || "");
        return resolve(v && v.trim() ? v.trim() : null);
      }
      openModal(title, bodyHtml, footer);
      setTimeout(function () {
        var input = document.getElementById("region-name-input");
        if (input) { input.focus(); input.select(); }
        var cancel = document.getElementById("region-cancel");
        var save = document.getElementById("region-save");
        if (cancel) cancel.addEventListener("click", function () { finish(null); });
        if (save) save.addEventListener("click", function () {
          var v = input ? input.value.trim() : "";
          finish(v || null);
        });
        if (input) input.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); var v = input.value.trim(); finish(v || null); }
          if (ev.key === "Escape") { ev.preventDefault(); finish(null); }
        });
      }, 0);
    });
  }
})();
