// public/js/mobile/alerts-tab.js — Alerts tab.
//
// Two sections:
//   1. "Down right now"  — monitored assets currently flagged `monitorStatus="down"`.
//      Fetched by sampling the Assets endpoint (limit=200, status=active) and
//      filtering client-side. For very large fleets this can miss some assets;
//      that's acceptable here — Alerts is a quick-triage screen, not an
//      exhaustive report. Operators after a complete view use desktop.
//   2. "Recent events"  — /events at level=warning OR error, last 7 days
//      (server retention). Tap an event → navigate to the relevant resource.

(function () {
  var DOWN_SAMPLE_LIMIT = 200;
  var EVENTS_LIMIT      = 50;

  var Alerts = {
    title: "Alerts",
    icon: "#i-bell",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Alerts</div>'
        + '  <div class="trailing">'
        + '    <button class="icon-btn" id="alerts-refresh-btn" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body) {
      body.innerHTML = ''
        + '<div id="alerts-down-section"></div>'
        + '<div id="alerts-events-section"></div>';

      loadAll();

      var btn = document.getElementById("alerts-refresh-btn");
      if (btn) btn.addEventListener("click", function () {
        btn.disabled = true;
        loadAll().finally(function () { btn.disabled = false; });
      });
    },
  };

  function loadAll() {
    return Promise.allSettled([loadDown(), loadEvents()]);
  }

  // ─── Down assets ───────────────────────────────────────────────────────
  function loadDown() {
    var host = document.getElementById("alerts-down-section");
    if (!host) return Promise.resolve();

    host.innerHTML = ''
      + '<div class="section-head">Down right now<span class="count" id="alerts-down-count">…</span></div>'
      + '<div id="alerts-down-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>';

    return api.assets.list({ limit: DOWN_SAMPLE_LIMIT, status: "active" }).then(function (resp) {
      var rows = (resp && resp.assets) || [];
      var down = rows.filter(function (a) { return a.monitored && a.monitorStatus === "down"; });
      // Most recently flagged at the top — that's where the live attention is.
      down.sort(function (a, b) {
        var at = a.lastMonitorAt ? +new Date(a.lastMonitorAt) : 0;
        var bt = b.lastMonitorAt ? +new Date(b.lastMonitorAt) : 0;
        return bt - at;
      });
      var countEl = document.getElementById("alerts-down-count");
      if (countEl) countEl.textContent = down.length;

      var bodyEl = document.getElementById("alerts-down-host");
      if (!bodyEl) return;
      if (down.length === 0) {
        bodyEl.innerHTML = ''
          + '<div class="empty-state" style="padding:24px 16px;">'
          + '  <div class="icon" style="background:rgba(94,216,123,.18);color:var(--md-success);"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></div>'
          + '  <div class="ttl" style="font-size:14px;">All monitored assets are up</div>'
          + '  <div class="desc" style="font-size:12px;">Sampled the most recent ' + (resp && resp.assets ? resp.assets.length : 0) + ' active assets.</div>'
          + '</div>';
        return;
      }

      var html = "";
      down.forEach(function (a, i) {
        var fails = a.consecutiveFailures || 0;
        html += ''
          + '<button class="list-item three-line" data-id="' + escapeHtml(a.id) + '">'
          + '  <span class="leading error"><svg viewBox="0 0 24 24"><use href="#i-down-arrow"/></svg></span>'
          + '  <div class="content">'
          + '    <div class="headline">' + escapeHtml(a.hostname || a.assetTag || "(unnamed)") + '</div>'
          + '    <div class="supporting" style="white-space:normal;">' + (a.ipAddress ? '<span class="mono">' + escapeHtml(a.ipAddress) + '</span> · ' : '')
                + escapeHtml((a.manufacturer && a.model) ? a.manufacturer + " " + a.model : (a.assetType || "")) + '</div>'
          + '    <div class="supporting mono" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:4px;">' + escapeHtml((fails ? fails + " consecutive failures · " : "") + (formatTimeAgo(a.lastMonitorAt) || "")) + '</div>'
          + '  </div>'
          + '</button>'
          + (i < down.length - 1 ? '<div class="list-divider"></div>' : '');
      });
      bodyEl.innerHTML = html;
      bodyEl.querySelectorAll(".list-item").forEach(function (row) {
        row.addEventListener("click", function () {
          PolarisRouter.go("asset/" + row.dataset.id);
        });
      });
    }).catch(function (err) {
      var bodyEl = document.getElementById("alerts-down-host");
      if (bodyEl) bodyEl.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t check down assets: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
    });
  }

  // ─── Recent events ─────────────────────────────────────────────────────
  function loadEvents() {
    var host = document.getElementById("alerts-events-section");
    if (!host) return Promise.resolve();

    host.innerHTML = ''
      + '<div class="section-head">Recent events<span class="count">last 7 days</span></div>'
      + '<div id="alerts-events-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>';

    // Two parallel fetches: warnings + errors. Merge, sort, take top N.
    return Promise.all([
      api.events.list({ limit: EVENTS_LIMIT, level: "warning" }).catch(function () { return { events: [] }; }),
      api.events.list({ limit: EVENTS_LIMIT, level: "error"   }).catch(function () { return { events: [] }; }),
    ]).then(function (parts) {
      var merged = (parts[0].events || []).concat(parts[1].events || []);
      merged.sort(function (a, b) { return +new Date(b.timestamp) - +new Date(a.timestamp); });
      merged = merged.slice(0, EVENTS_LIMIT);

      var bodyEl = document.getElementById("alerts-events-host");
      if (!bodyEl) return;
      if (merged.length === 0) {
        bodyEl.innerHTML = ''
          + '<div class="empty-state" style="padding:24px 16px;">'
          + '  <div class="icon" style="background:rgba(94,216,123,.18);color:var(--md-success);"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></div>'
          + '  <div class="ttl" style="font-size:14px;">All quiet</div>'
          + '  <div class="desc" style="font-size:12px;">No warning or error events in the last 7 days.</div>'
          + '</div>';
        return;
      }

      var html = "";
      merged.forEach(function (e, i) {
        var leadCls = e.level === "error" ? "error" : "warning";
        var iconHref = e.level === "error" ? "#i-down-arrow" : "#i-warn";
        html += ''
          + '<button class="list-item three-line" data-event-id="' + escapeHtml(e.id) + '" data-rt="' + escapeHtml(e.resourceType || "") + '" data-rid="' + escapeHtml(e.resourceId || "") + '">'
          + '  <span class="leading ' + leadCls + '"><svg viewBox="0 0 24 24"><use href="' + iconHref + '"/></svg></span>'
          + '  <div class="content">'
          + '    <div class="headline">' + escapeHtml(prettyAction(e.action)) + (e.resourceName ? " · " + escapeHtml(e.resourceName) : "") + '</div>'
          + '    <div class="supporting" style="white-space:normal;">' + escapeHtml(e.message || "") + '</div>'
          + '    <div class="supporting mono" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:4px;">' + escapeHtml(formatTimeAgo(e.timestamp)) + (e.actor ? " · " + escapeHtml(e.actor) : "") + '</div>'
          + '  </div>'
          + '</button>'
          + (i < merged.length - 1 ? '<div class="list-divider"></div>' : '');
      });
      bodyEl.innerHTML = html;

      bodyEl.querySelectorAll(".list-item").forEach(function (row) {
        row.addEventListener("click", function () {
          var rt = row.dataset.rt, rid = row.dataset.rid;
          if (!rid) return;
          if (rt === "asset")  PolarisRouter.go("asset/" + rid);
          else if (rt === "subnet") PolarisRouter.go("subnet/" + rid);
          else if (rt === "block")  PolarisRouter.go("block/" + rid);
          else PolarisTabs.showSnackbar("No mobile view for this event — open it on desktop.");
        });
      });
    }).catch(function (err) {
      var bodyEl = document.getElementById("alerts-events-host");
      if (bodyEl) bodyEl.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load events: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
    });
  }

  // Turn an action key like "monitor.status_changed" into "Monitor status changed".
  function prettyAction(action) {
    if (!action) return "Event";
    var s = action.replace(/\./g, " ").replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function formatTimeAgo(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (sec < 60)    return sec + "s ago";
    if (sec < 3600)  return Math.floor(sec / 60) + "m ago";
    if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
    return Math.floor(sec / 86400) + "d ago";
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  window.PolarisAlertsTab = { spec: Alerts };
})();
