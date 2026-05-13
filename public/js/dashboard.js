/**
 * public/js/dashboard.js — new home dashboard with four cards:
 *
 *   ┌─ Monitor alerts ────┬─ Recently reserved ─┐
 *   ├─ Assets by type ────┼─ Block utilization ─┤
 *
 * Click behaviour:
 *   - Monitor alert row    → /assets.html#search=<hostname>
 *   - Recently reserved    → /ipam.html#tab=networks&subnet=<id>&focusReservation=<id>
 *   - Asset-type pie slice → /assets.html#type=<assetType>
 *   - Block util row       → /ipam.html#tab=networks&block=<id>
 *
 * Single fetch (/dashboard/summary) backs all four cards.
 */

// Keep these in sync with assets.js — duplicated here because dashboard.js
// loads on the index page where assets.js isn't included.
var DASH_ASSET_TYPE_LABELS = {
  server: "Server", switch: "Switch", router: "Router", firewall: "Firewall",
  workstation: "Workstation", printer: "Printer", access_point: "AP", other: "Other",
};
// Match the legend feel of the rest of the app — these come from the existing
// asset type icon set; cycling through them for slices keeps the pie readable
// against dark and light themes.
var DASH_ASSET_TYPE_COLORS = {
  server: "#4fc3f7", switch: "#26c6da", router: "#7e57c2", firewall: "#ef5350",
  workstation: "#66bb6a", printer: "#ffa726", access_point: "#ab47bc", other: "#90a4ae",
};

var _dashTimerHandle = null;

document.addEventListener("DOMContentLoaded", function () { loadDashboard(); });

async function loadDashboard() {
  try {
    var data = await api.dashboard.summary();
    renderMonitorAlerts(data.monitorAlerts || [], !!data.monitorAlertsOverflow);
    renderRecentReservations(data.recentReservations || []);
    renderAssetTypes(data.assetTypeCounts || []);
    renderBlockUtil(data.blockUtilization || []);
    // Re-tick the "how long since the transition" labels every 30s without
    // re-fetching — the timestamps don't change, only the human-readable diff.
    if (_dashTimerHandle) clearInterval(_dashTimerHandle);
    _dashTimerHandle = setInterval(function () {
      renderMonitorAlerts(data.monitorAlerts || [], !!data.monitorAlertsOverflow);
    }, 30000);
  } catch (err) {
    showToast("Failed to load dashboard: " + (err.message || err), "error");
  }
}

// ─── Monitor alerts ──────────────────────────────────────────────────────────

function _statusDot(status) {
  if (status === "down") return '<span class="dash-alert-dot dash-alert-down" title="Down"></span>';
  if (status === "warning") return '<span class="dash-alert-dot dash-alert-warning" title="Warning"></span>';
  return '<span class="dash-alert-dot" title="' + escapeHtml(status) + '"></span>';
}

function _durationSince(iso) {
  if (!iso) return "—";
  var diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return diff + "s";
  if (diff < 3600) {
    var m = Math.floor(diff / 60);
    var s = diff % 60;
    return m + "m " + (s < 10 ? "0" + s : s) + "s";
  }
  if (diff < 86400) {
    var h = Math.floor(diff / 3600);
    var rm = Math.floor((diff % 3600) / 60);
    return h + "h " + (rm < 10 ? "0" + rm : rm) + "m";
  }
  var d = Math.floor(diff / 86400);
  var rh = Math.floor((diff % 86400) / 3600);
  return d + "d " + rh + "h";
}

function renderMonitorAlerts(alerts, overflow) {
  var el = document.getElementById("monitor-alerts");
  if (!el) return;
  if (!alerts.length) {
    el.innerHTML = '<p class="empty-state">All monitored assets healthy</p>';
    return;
  }
  var rows = alerts.map(function (a) {
    var typeLabel = DASH_ASSET_TYPE_LABELS[a.assetType] || a.assetType;
    var hostname = a.hostname || a.ipAddress || "(unnamed)";
    var nav = "/assets.html#search=" + encodeURIComponent(hostname);
    return '<a class="dash-alert-row" href="' + nav + '">' +
      _statusDot(a.monitorStatus) +
      '<div class="dash-alert-body">' +
        '<div class="dash-alert-title">' + escapeHtml(hostname) + '</div>' +
        '<div class="dash-alert-sub">' + escapeHtml(typeLabel) + ' · ' + escapeHtml(a.monitorStatus) + '</div>' +
      '</div>' +
      '<div class="dash-alert-time" data-changed-at="' + (a.monitorStatusChangedAt || "") + '">' + _durationSince(a.monitorStatusChangedAt) + '</div>' +
    '</a>';
  }).join("");
  var footer = overflow ? '<p class="empty-state" style="text-align:left;margin-top:8px">+ more — see <a href="/assets.html">Assets</a></p>' : "";
  el.innerHTML = rows + footer;
}

// ─── Recently reserved ───────────────────────────────────────────────────────

function renderRecentReservations(rows) {
  var el = document.getElementById("recent-reservations");
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<p class="empty-state">No manual reservations yet</p>';
    return;
  }
  el.innerHTML = rows.map(function (r) {
    var ip = r.ipAddress || "(full subnet)";
    var badges = '<code>' + escapeHtml(r.subnetCidr) + '</code>';
    if (r.vlan != null) badges += ' <span class="badge badge-vlan">VLAN ' + r.vlan + '</span>';
    var meta = [];
    if (r.hostname) meta.push(escapeHtml(r.hostname));
    if (r.owner) meta.push(escapeHtml(r.owner));
    if (r.createdBy) meta.push("by " + escapeHtml(r.createdBy));
    if (r.macAddress) meta.push('<code>' + escapeHtml(r.macAddress) + '</code>');
    var nav = "/ipam.html#tab=networks&subnet=" + encodeURIComponent(r.subnetId) + "&focusReservation=" + encodeURIComponent(r.id);
    return '<a class="recent-item recent-item-link" href="' + nav + '"><div>' +
      '<div class="recent-item-title"><span>' + escapeHtml(ip) + '</span>' + badges + '</div>' +
      '<div class="recent-item-meta"><span>' + escapeHtml(r.subnetName || "") + '</span>' +
      (meta.length ? '<span style="color:var(--color-text-tertiary)">·</span><span>' + meta.join(' · ') + '</span>' : '') +
      '</div>' +
      '</div><span class="recent-item-time">' + timeAgo(r.createdAt) + '</span></a>';
  }).join("");
}

// ─── Assets by type (SVG pie) ────────────────────────────────────────────────
//
// In-house SVG — keeps the bundle small and matches the rest of the app's
// chart aesthetic (response-time, telemetry, etc. are all hand-rolled SVG).
// Hover highlights the slice; click navigates to the assets list filtered by
// that type.

function renderAssetTypes(rows) {
  var el = document.getElementById("asset-types");
  if (!el) return;
  var total = rows.reduce(function (s, r) { return s + r.count; }, 0);
  if (!total) {
    el.innerHTML = '<p class="empty-state">No assets yet</p>';
    return;
  }
  // Stable display order keyed off DASH_ASSET_TYPE_LABELS so legend ordering
  // is predictable regardless of how the DB grouped the result.
  var ordered = Object.keys(DASH_ASSET_TYPE_LABELS).map(function (k) {
    var hit = rows.find(function (r) { return r.assetType === k; });
    return { assetType: k, count: hit ? hit.count : 0 };
  }).filter(function (r) { return r.count > 0; });

  var size = 200, r = 80, cx = size / 2, cy = size / 2;
  var startAngle = -Math.PI / 2;
  var slices = ordered.map(function (row) {
    var frac = row.count / total;
    var endAngle = startAngle + frac * Math.PI * 2;
    var x1 = cx + r * Math.cos(startAngle);
    var y1 = cy + r * Math.sin(startAngle);
    var x2 = cx + r * Math.cos(endAngle);
    var y2 = cy + r * Math.sin(endAngle);
    var largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
    var d = 'M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' + x2 + ' ' + y2 + ' Z';
    var color = DASH_ASSET_TYPE_COLORS[row.assetType] || "#9e9e9e";
    var label = DASH_ASSET_TYPE_LABELS[row.assetType] || row.assetType;
    startAngle = endAngle;
    return { d: d, color: color, label: label, assetType: row.assetType, count: row.count, pct: Math.round(frac * 100) };
  });

  var svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="100%" style="max-width:200px;display:block;margin:0 auto">' +
    slices.map(function (s) {
      return '<path d="' + s.d + '" fill="' + s.color + '" stroke="var(--color-bg)" stroke-width="2" class="dash-pie-slice" data-type="' + escapeHtml(s.assetType) + '"><title>' + escapeHtml(s.label) + ' — ' + s.count + ' (' + s.pct + '%)</title></path>';
    }).join("") +
    '</svg>';

  var legend = '<div class="dash-pie-legend">' + slices.map(function (s) {
    var nav = "/assets.html#type=" + encodeURIComponent(s.assetType);
    return '<a class="dash-pie-legend-item" href="' + nav + '" data-type="' + escapeHtml(s.assetType) + '">' +
      '<span class="legend-dot" style="background:' + s.color + '"></span>' +
      '<span class="dash-pie-legend-label">' + escapeHtml(s.label) + '</span>' +
      '<span class="dash-pie-legend-count">' + s.count + '</span>' +
    '</a>';
  }).join("") + '</div>';

  el.innerHTML = '<div class="dash-pie-wrap">' + svg + legend + '</div>';

  // Click on the SVG slice navigates the same way the legend link does.
  Array.prototype.forEach.call(el.querySelectorAll(".dash-pie-slice"), function (path) {
    path.addEventListener("click", function () {
      window.location.href = "/assets.html#type=" + encodeURIComponent(path.getAttribute("data-type"));
    });
  });
}

// ─── Block utilization ───────────────────────────────────────────────────────

function _fmtAddrs(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1024)    return Math.round(n / 1024) + "K";
  return String(n);
}

function renderBlockUtil(rows) {
  var el = document.getElementById("block-util");
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<p class="empty-state">No blocks yet</p>';
    return;
  }
  el.innerHTML = rows.map(function (b) {
    var pct = b.usedPercent != null ? b.usedPercent : 0;
    var color = pct > 75 ? "#ff1744" : pct > 50 ? "#ffd600" : "#4fc3f7";
    var addrLabel = (b.blockAddresses != null)
      ? _fmtAddrs(b.allocatedAddresses) + ' / ' + _fmtAddrs(b.blockAddresses) + ' IPs'
      : b.totalSubnets + ' subnets';
    var nav = "/ipam.html#tab=networks&block=" + encodeURIComponent(b.id);
    return '<a class="block-util-item block-util-link" href="' + nav + '">' +
      '<div class="block-util-header"><div class="block-util-name"><span>' + escapeHtml(b.name) + '</span><code>' + escapeHtml(b.cidr) + '</code></div><span class="block-util-count">' + addrLabel + '</span></div>' +
      '<div class="util-row"><div class="util-bar-track"><div class="util-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div><span style="font-size:0.82rem;color:var(--color-text-secondary);min-width:32px;text-align:right">' + pct + '%</span></div>' +
    '</a>';
  }).join("");
}
