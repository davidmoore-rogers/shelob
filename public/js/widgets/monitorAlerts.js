/**
 * widgets/monitorAlerts.js — assets currently in warning / down. Click a row
 * to jump to /assets.html#search=<hostname>. Severity toggle (gear): show
 * both warning+down (default) or down only.
 *
 * Data source: dashboard summary's monitorAlerts[] — pre-fetched by the
 * orchestrator and handed in via the `summary` argument to fetchData.
 */

(function () {
  function statusDot(status) {
    if (status === "down") return '<span class="dash-alert-dot dash-alert-down" title="Down"></span>';
    if (status === "warning") return '<span class="dash-alert-dot dash-alert-warning" title="Warning"></span>';
    return '<span class="dash-alert-dot" title="' + escapeHtml(status) + '"></span>';
  }

  function filterBySeverity(rows, severity) {
    if (severity === "downOnly") return rows.filter(function (r) { return r.monitorStatus === "down"; });
    return rows;
  }

  function renderRows(el, alerts, overflow, config) {
    var rowLimit = (config && config.rowLimit) || 10;
    var visible = filterBySeverity(alerts, (config && config.severity) || "warningAndDown");
    var clipped = visible.slice(0, rowLimit);
    var lbls = PolarisWidgets.ASSET_TYPE_LABELS;
    if (!clipped.length) {
      el.innerHTML = '<p class="empty-state">All monitored assets healthy</p>';
      return;
    }
    var rows = clipped.map(function (a) {
      var typeLabel = lbls[a.assetType] || a.assetType;
      var hostname = a.hostname || a.ipAddress || "(unnamed)";
      var nav = "/assets.html#search=" + encodeURIComponent(hostname);
      return '<a class="dash-alert-row" href="' + nav + '">' +
        statusDot(a.monitorStatus) +
        '<div class="dash-alert-body">' +
          '<div class="dash-alert-title">' + escapeHtml(hostname) + '</div>' +
          '<div class="dash-alert-sub">' + escapeHtml(typeLabel) + ' · ' + escapeHtml(a.monitorStatus) + '</div>' +
        '</div>' +
        '<div class="dash-alert-time" data-changed-at="' + (a.monitorStatusChangedAt || "") + '">' + PolarisWidgets.durationSince(a.monitorStatusChangedAt) + '</div>' +
      '</a>';
    }).join("");
    var more = (visible.length > clipped.length) || overflow
      ? '<p class="empty-state" style="text-align:left;margin-top:8px">+ more — see <a href="/assets.html">Assets</a></p>'
      : "";
    el.innerHTML = rows + more;
  }

  PolarisWidgets.register({
    type: "monitorAlerts",
    label: "Monitor alerts",
    description: "Monitored assets currently in warning or down state, newest transitions first.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { rowLimit: 10, severity: "warningAndDown" },

    fetchData: function (_config, summary) {
      return Promise.resolve({
        alerts:   (summary && summary.monitorAlerts) || [],
        overflow: !!(summary && summary.monitorAlertsOverflow),
      });
    },

    renderInstance: function (el, config, data, ctx) {
      el.innerHTML = "";
      renderRows(el, data.alerts || [], data.overflow, config);
      // Re-tick durations every 30s without re-fetching.
      var timer = setInterval(function () { renderRows(el, data.alerts || [], data.overflow, config); }, 30000);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      var mock = [
        { hostname: "fgt-branch-12",  assetType: "firewall",    monitorStatus: "down",    monitorStatusChangedAt: new Date(Date.now() - 18 * 60 * 1000).toISOString() },
        { hostname: "fs-1024d-aisle-3", assetType: "switch",    monitorStatus: "warning", monitorStatusChangedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString() },
        { hostname: "fap-231f-conf-rm",  assetType: "access_point", monitorStatus: "down", monitorStatusChangedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() },
      ];
      renderRows(el, mock, false, { rowLimit: 3, severity: "warningAndDown" });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Show</label>' +
        '<select data-k="severity">' +
          '<option value="warningAndDown"' + (config.severity === "warningAndDown" ? " selected" : "") + '>Warning + Down</option>' +
          '<option value="downOnly"' + (config.severity === "downOnly" ? " selected" : "") + '>Down only</option>' +
        '</select>' +
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' +
          [5, 10, 20].map(function (n) { return '<option value="' + n + '"' + (config.rowLimit === n ? " selected" : "") + '>' + n + '</option>'; }).join("") +
        '</select>';
      el.querySelectorAll("[data-k]").forEach(function (s) {
        s.addEventListener("change", function () {
          var k = s.getAttribute("data-k");
          onChange(k, k === "rowLimit" ? parseInt(s.value, 10) : s.value);
        });
      });
    },
  });
})();
