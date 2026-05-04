// public/js/mobile/map-tab.js — Device Map tab.
//
// Lazy-loads Leaflet + markercluster on first render (~150KB total) so the
// payload stays light for users who never open the Map. Plots every
// firewall asset returned by /map/sites with health-coded markers and pops
// a bottom sheet on tap. The same module backs the `site/<id>` detail
// route — that path renders the map and pre-opens the sheet for the named
// site so deep-links from search work.
//
// Mobile-specific decisions vs desktop map.js:
//   - No topology graph (Cytoscape is too heavy and the modal is unwieldy
//     on a phone). Sheet shows a "View topology on desktop" link instead.
//   - Pin tap opens the sheet locally without changing the URL — keeps
//     re-renders cheap. The sheet's close button just closes; deep-links
//     from search are still URL-driven via the `site` route.
//   - No theme toggle (mobile inherits the app's overall dark theme).

(function () {
  // Module-level state. Reused across renders so back-and-forth between
  // Map and other tabs doesn't re-fetch sites every time.
  var _map = null;
  var _markerCluster = null;
  var _markersById = Object.create(null);
  var _sites = [];
  var _leafletPromise = null;

  // ─── Lazy loaders ──────────────────────────────────────────────────────
  function _addLink(href) {
    if (document.querySelector('link[href="' + href + '"]')) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
  function _loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Failed to load " + src)); };
      document.head.appendChild(s);
    });
  }
  function loadLeaflet() {
    if (window.L && window.L.markerClusterGroup) return Promise.resolve(window.L);
    if (_leafletPromise) return _leafletPromise;
    _leafletPromise = (async function () {
      _addLink("/css/vendor/leaflet/leaflet.css");
      _addLink("/css/vendor/leaflet/MarkerCluster.css");
      _addLink("/css/vendor/leaflet/MarkerCluster.Default.css");
      await _loadScript("/js/vendor/leaflet/leaflet.js");
      await _loadScript("/js/vendor/leaflet/leaflet.markercluster.js");
      return window.L;
    })();
    return _leafletPromise;
  }

  // ─── Tab spec ──────────────────────────────────────────────────────────
  var Map = {
    title: "Device Map",
    icon: "#i-map",
    renderTopbar: function () {
      // No top app bar — the floating searchbar over the map plays that
      // role. Empty topbar slot lets the map take the full body height.
      return "";
    },
    render: function (body, ctx) {
      // Bare-minimum DOM the first time we render this tab. Subsequent
      // renders reuse it.
      body.innerHTML = ''
        + '<div class="map-screen">'
        + '  <div id="map-container"></div>'
        + '  <div class="map-search-float" id="map-search-float">'
        + '    <svg viewBox="0 0 24 24"><use href="#i-search"/></svg>'
        + '    <span class="placeholder">Search sites…</span>'
        + '  </div>'
        + '  <div class="map-fab-pos">'
        + '    <button class="fab" id="map-recenter" aria-label="Recenter on me"><svg viewBox="0 0 24 24"><use href="#i-target"/></svg></button>'
        + '  </div>'
        + '  <div id="map-status" style="position:absolute;bottom:88px;left:16px;right:16px;text-align:center;color:var(--md-on-surface-variant);font-size:13px;letter-spacing:.25px;pointer-events:none;"></div>'
        + '</div>';

      document.getElementById("map-search-float").addEventListener("click", function () {
        PolarisRouter.go("search");
      });

      document.getElementById("map-recenter").addEventListener("click", recenterOnUser);

      var preselectId = (ctx && ctx.preselectSiteId) || null;

      setStatus("Loading…");
      loadLeaflet().then(function () {
        // Always re-init when render runs — DOM is fresh per route change,
        // so prior Leaflet instances no longer have valid container refs.
        initMap();
        return loadSites();
      }).then(function () {
        setStatus("");
        if (preselectId) {
          var site = _sites.find(function (s) { return s.id === preselectId; });
          if (site) {
            focusSite(site);
            // Defer so flyTo animation kicks in before the sheet covers
            // the lower half of the screen.
            setTimeout(function () { openSiteSheet(site); }, 400);
          } else {
            PolarisTabs.showSnackbar("Site not found on map — it may have no coordinates yet.", { error: true });
          }
        }
      }).catch(function (err) {
        setStatus("Failed to load map: " + (err && err.message ? err.message : err));
      });
    },
  };

  function setStatus(msg) {
    var el = document.getElementById("map-status");
    if (el) el.textContent = msg || "";
  }

  function initMap() {
    var L = window.L;
    L.Icon.Default.imagePath = "/css/vendor/leaflet/images/";

    _map = L.map("map-container", {
      worldCopyJump: true,
      center: [39.5, -95],
      zoom: 4,
      zoomControl: false, // pinch + the recenter FAB are enough on phones
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(_map);

    _markerCluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      iconCreateFunction: clusterIcon,
    });
    _map.addLayer(_markerCluster);
  }

  function clusterIcon(cluster) {
    var L = window.L;
    var children = cluster.getAllChildMarkers();
    var sawMonitored = false;
    var worst = "up";
    for (var i = 0; i < children.length; i++) {
      var s = children[i]._site;
      if (!s || !s.monitored) continue;
      sawMonitored = true;
      if (s.monitorHealth === "down") { worst = "down"; break; }
      if (s.monitorHealth === "degraded" && worst !== "down") worst = "degraded";
    }
    var cls = sawMonitored ? "monitor-" + worst : "monitor-unmonitored";
    var count = cluster.getChildCount();
    return L.divIcon({
      html: '<div class="fg-cluster ' + cls + '"><span>' + count + "</span></div>",
      className: "",
      iconSize: [40, 40],
    });
  }

  function loadSites() {
    return api.map.sites().then(function (sites) {
      _sites = Array.isArray(sites) ? sites : [];
      _markerCluster.clearLayers();
      _markersById = Object.create(null);

      if (_sites.length === 0) {
        setStatus("No FortiGates with coordinates yet.");
        return _sites;
      }

      var L = window.L;
      var latlngs = [];
      _sites.forEach(function (s) {
        if (s.latitude == null || s.longitude == null) return;
        var m = makeMarker(s);
        _markerCluster.addLayer(m);
        _markersById[s.id] = m;
        latlngs.push([s.latitude, s.longitude]);
      });
      if (latlngs.length > 0) {
        _map.fitBounds(L.latLngBounds(latlngs).pad(0.05), { maxZoom: 12 });
      }
      return _sites;
    });
  }

  function monitorClass(site) {
    if (!site.monitored) return "monitor-unmonitored";
    switch (site.monitorHealth) {
      case "up":       return "monitor-up";
      case "degraded": return "monitor-degraded";
      case "down":     return "monitor-down";
      default:         return "monitor-unknown";
    }
  }

  function makeMarker(site) {
    var L = window.L;
    var label = (site.hostname || "FG").slice(0, 3).toUpperCase();
    var icon = L.divIcon({
      className: "",
      html: '<div class="fg-marker ' + monitorClass(site) + '" aria-hidden="true">' + escapeHtml(label) + "</div>",
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    var marker = L.marker([site.latitude, site.longitude], { icon: icon });
    marker._site = site;
    marker.on("click", function () { openSiteSheet(site); });
    return marker;
  }

  function focusSite(site) {
    if (!site || site.latitude == null || site.longitude == null) return;
    _map.flyTo([site.latitude, site.longitude], 13, { duration: 0.6 });
  }

  function recenterOnUser() {
    if (!navigator.geolocation) {
      PolarisTabs.showSnackbar("Location not available on this device.");
      return;
    }
    navigator.geolocation.getCurrentPosition(function (pos) {
      _map.flyTo([pos.coords.latitude, pos.coords.longitude], 11, { duration: 0.6 });
    }, function (err) {
      var msg = "Couldn't get your location";
      if (err && err.code === err.PERMISSION_DENIED) msg = "Location permission denied";
      PolarisTabs.showSnackbar(msg, { error: true });
    }, { timeout: 6000 });
  }

  // ─── Site bottom sheet ─────────────────────────────────────────────────
  // Single instance — opening a new one supersedes any open sheet.
  function openSiteSheet(site) {
    closeSiteSheet();
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "map-sheet-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "map-sheet";

    var subnetLine = site.subnetCount
      ? site.subnetCount + " subnet" + (site.subnetCount === 1 ? "" : "s")
      : "no subnets discovered yet";
    var monitorPill = renderMonitorPill(site);
    var siteParts = [];
    if (site.model) siteParts.push(escapeHtml(site.model));
    if (site.ipAddress) siteParts.push('<span class="mono">' + escapeHtml(site.ipAddress) + '</span>');
    if (site.serialNumber) siteParts.push('<span class="mono">' + escapeHtml(site.serialNumber) + '</span>');

    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px;">'
      + '  <div style="min-width:0;">'
      + '    <h3 class="sheet-title" style="margin:0 0 4px;">' + escapeHtml(site.hostname || "FortiGate") + '</h3>'
      + '    <div class="muted" style="font-size:13px;letter-spacing:.25px;">' + siteParts.join(" · ") + '</div>'
      + '  </div>'
      + '  <button class="icon-btn" id="map-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div style="display:flex;gap:8px;margin:12px 0 16px;flex-wrap:wrap;align-items:center;">'
      + '  ' + monitorPill
      + '  <span class="muted" style="font-size:12px;">' + escapeHtml(subnetLine) + '</span>'
      + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      + '  <button class="btn btn-tonal" id="map-sheet-asset"><svg viewBox="0 0 24 24"><use href="#i-server"/></svg>View asset</button>'
      + '  <a class="btn btn-outlined" href="/map.html#site=' + encodeURIComponent(site.id) + '&topology=1" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><use href="#i-desktop"/></svg>Topology (desktop)</a>'
      + '</div>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeSiteSheet);
    document.getElementById("map-sheet-close").addEventListener("click", closeSiteSheet);
    document.getElementById("map-sheet-asset").addEventListener("click", function () {
      closeSiteSheet();
      PolarisRouter.go("asset/" + site.id);
    });
  }

  function closeSiteSheet() {
    var s = document.getElementById("map-sheet");
    var sc = document.getElementById("map-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();

    // If the URL still names a site (we got here via #site/<id>), normalize
    // it to plain #map so refresh lands without the sheet — but bypass the
    // router so we don't trigger a full Leaflet re-init. Manually update
    // the navbar active state since we sidestepped routeChanged.
    var cur = PolarisRouter.current();
    if (cur && cur.name === "site") {
      var url = window.location.pathname + window.location.search + "#map";
      window.history.replaceState(null, "", url);
      var appEl = document.getElementById("app");
      if (appEl) appEl.dataset.tab = "map";
      var nav = document.getElementById("navbar");
      if (nav) nav.querySelectorAll(".nav-item").forEach(function (b) {
        b.classList.toggle("active", b.dataset.tab === "map");
      });
    }
  }

  function renderMonitorPill(site) {
    if (!site.monitored) return '<span class="status-pill unk">Unmonitored</span>';
    var samples = site.monitorRecentSamples || 0;
    var failures = site.monitorRecentFailures || 0;
    switch (site.monitorHealth) {
      case "up":       return '<span class="status-pill up"><span class="dot up"></span>Up — ' + samples + '/' + samples + ' ok</span>';
      case "degraded": return '<span class="status-pill warn"><span class="dot warn"></span>Packet loss — ' + failures + '/' + samples + ' failed</span>';
      case "down":     return '<span class="status-pill down"><span class="dot down"></span>Down — ' + failures + '/' + samples + ' failed</span>';
      default:         return '<span class="status-pill unk"><span class="dot unk"></span>Monitored — no samples yet</span>';
    }
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ─── Public surface ────────────────────────────────────────────────────
  // The tab registry in tabs.js reads from PolarisMapTab.spec; details.js's
  // Site renderer delegates to PolarisMapTab.renderForSite which reuses
  // the same render() but pre-opens the sheet.
  window.PolarisMapTab = {
    spec: Map,
    renderForSite: function (body, ctx) {
      var siteId = (ctx.route && ctx.route.parts && ctx.route.parts[0]) || null;
      Map.render(body, { user: ctx.user, route: ctx.route, preselectSiteId: siteId });
    },
    closeSheet: closeSiteSheet,
  };
})();
