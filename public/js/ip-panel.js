/**
 * public/js/ip-panel.js — Slide-over IP panel for networks page
 */

var _ipPanelSubnetId = null;
var _ipPanelPage = 1;
var _ipPanelPageSize = 256;
var _ipPanelData = null;
var _ipPanelDirty = false;
var _panelSelected = new Set();
var _ipPanelLayout = null;

function _saveIpPanelPrefs() {
  if (!currentUsername || !_ipPanelLayout) return;
  try {
    var prefs = _ipPanelLayout.getPrefs();
    localStorage.setItem("polaris-prefs-ip-panel-" + currentUsername, JSON.stringify({ layout: prefs }));
  } catch (_) {}
}

function _restoreIpPanelPrefs() {
  if (!currentUsername || !_ipPanelLayout) return;
  try {
    var raw = localStorage.getItem("polaris-prefs-ip-panel-" + currentUsername);
    if (!raw) return;
    var p = JSON.parse(raw);
    if (p && p.layout) _ipPanelLayout.setPrefs(p.layout);
  } catch (_) {}
}
// When set, _renderIpList scrolls to and highlights the row whose IP matches.
// Cleared after a single render so subsequent page navigations don't keep
// re-scrolling.
var _ipPanelFocusIp = null;

// ─── Panel lifecycle ────────────────────────────────────────────────────────

function _ensurePanelDOM() {
  if (document.getElementById("ip-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "ip-panel-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="ip-panel">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="ip-panel-title"></h3>' +
          '<button class="btn-icon" id="ip-panel-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="ip-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="ip-panel-body">' +
        '<p class="empty-state">Loading...</p>' +
      '</div>' +
      '<div class="slideover-footer" id="ip-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeIpPanel();
  });
  document.getElementById("ip-panel-close").addEventListener("click", closeIpPanel);

  initSlideoverResize(document.getElementById("ip-panel"), "polaris.panel.width.ip");
}

function openIpPanel(subnetId, opts) {
  _ensurePanelDOM();
  _ipPanelSubnetId = subnetId;
  _ipPanelDirty = false;
  _panelSelected.clear();
  // Optional focus: when an IP is supplied, jump to the page that contains
  // it so the subsequent render can scroll the row into view. Falls back to
  // page 1 for IPv6 (panel only lists existing reservations) or unparseable
  // CIDRs.
  var focusIp = opts && opts.focusIp ? String(opts.focusIp) : null;
  var subnetCidr = opts && opts.subnetCidr ? String(opts.subnetCidr) : null;
  _ipPanelFocusIp = focusIp;
  _ipPanelPage = focusIp && subnetCidr
    ? _ipv4PageForIp(subnetCidr, focusIp, _ipPanelPageSize)
    : 1;
  document.getElementById("ip-panel-title").textContent = "Loading...";
  document.getElementById("ip-panel-meta").innerHTML = "";
  document.getElementById("ip-panel-body").innerHTML = '<p class="empty-state">Loading...</p>';
  document.getElementById("ip-panel-footer").innerHTML = "";
  requestAnimationFrame(function () {
    document.getElementById("ip-panel-overlay").classList.add("open");
  });
  _fetchIpPage();
}

// Compute which page of the IP list contains `ip` for an IPv4 subnet.
// Returns 1 for unparseable input or non-IPv4 (IPv6 panel doesn't paginate
// by host offset — it only lists reservations).
function _ipv4PageForIp(subnetCidr, ip, pageSize) {
  var slash = subnetCidr.indexOf('/');
  if (slash < 0) return 1;
  var network = subnetCidr.slice(0, slash);
  var netInt = _ipv4ToInt(network);
  var ipInt = _ipv4ToInt(ip);
  if (netInt == null || ipInt == null) return 1;
  var offset = ipInt - netInt;
  if (offset < 0) return 1;
  return Math.floor(offset / pageSize) + 1;
}

function _ipv4ToInt(ip) {
  var parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  var n = 0;
  for (var i = 0; i < 4; i++) {
    var p = parseInt(parts[i], 10);
    if (isNaN(p) || p < 0 || p > 255 || String(p) !== parts[i]) return null;
    n = n * 256 + p;
  }
  return n;
}

function closeIpPanel() {
  var overlay = document.getElementById("ip-panel-overlay");
  if (overlay) overlay.classList.remove("open");
  document.querySelectorAll("tr.row-panel-active").forEach(function (r) {
    r.classList.remove("row-panel-active");
  });
  if (_ipPanelDirty && typeof loadSubnets === "function") loadSubnets();
  _ipPanelSubnetId = null;
  _ipPanelData = null;
  _ipPanelDirty = false;
}

async function _fetchIpPage() {
  try {
    var data = await api.subnets.ips(_ipPanelSubnetId, { page: _ipPanelPage, pageSize: _ipPanelPageSize });
    _ipPanelData = data;
    _renderPanelHeader(data);
    _renderIpList(data);
    _renderPanelFooter(data);
  } catch (err) {
    document.getElementById("ip-panel-body").innerHTML =
      '<p class="empty-state">Error: ' + escapeHtml(err.message) + '</p>';
  }
}

// ─── Render helpers ─────────────────────────────────────────────────────────

function _renderPanelHeader(data) {
  var s = data.subnet;
  document.getElementById("ip-panel-title").innerHTML =
    escapeHtml(s.name) + ' <code style="font-size:0.85rem;margin-left:4px">' + escapeHtml(s.cidr) + '</code>';

  var meta = '';
  if (s.status) {
    var badge = statusBadge(s.hasConflict ? "conflict" : s.status);
    meta += s.conflictMessage ? '<span title="' + escapeHtml(s.conflictMessage) + '" style="cursor:help">' + badge + '</span>' : badge;
  }
  if (s.vlan) meta += '<span class="badge badge-vlan">VLAN ' + s.vlan + '</span>';
  if (s.integration) meta += '<span style="font-size:0.78rem;color:var(--color-text-secondary)">Integration: <strong>' + escapeHtml(s.integration.name) + '</strong></span>';
  if (s.fortigateDevice && (!s.integration || s.integration.type !== 'windowsserver')) meta += '<span style="font-size:0.78rem;color:var(--color-text-secondary)">Server: <strong>' + escapeHtml(s.fortigateDevice) + '</strong></span>';
  if (s.purpose) meta += '<span style="color:var(--color-text-tertiary)">' + escapeHtml(s.purpose) + '</span>';
  if (data.ipv6) meta += '<span style="color:var(--color-warning);font-size:0.75rem">IPv6 — showing reservations only</span>';

  var headerBtns = '<span style="margin-left:auto;display:flex;gap:6px">' +
    (canManageNetworks() && !data.ipv6 ? '<button class="btn btn-sm btn-danger" id="ip-panel-free-selected-btn" disabled>Free Selected</button>' : '') +
    '<div class="btn-dropdown-wrap">' +
      '<button class="btn btn-sm btn-secondary" id="ip-panel-export-btn">Export &#9662;</button>' +
      '<div class="btn-dropdown-menu" id="ip-panel-export-menu">' +
        '<button data-fmt="pdf">Export as PDF</button>' +
        '<button data-fmt="csv">Export as CSV</button>' +
      '</div>' +
    '</div>' +
    (canReserveIps() && !data.ipv6 ? '<button class="btn btn-sm btn-secondary" id="ip-panel-auto-alloc-btn">Auto-Allocate Next</button>' : '') +
    (canReserveIps() ? '<button class="btn btn-sm btn-primary" id="ip-panel-reserve-btn">+ Reserve IP</button>' : '') +
    '</span>';
  meta += headerBtns;

  document.getElementById("ip-panel-meta").innerHTML = meta;

  var allocBtn = document.getElementById("ip-panel-auto-alloc-btn");
  if (allocBtn) {
    allocBtn.addEventListener("click", function () {
      _openAutoAllocateModal(_ipPanelSubnetId);
    });
  }
  var btn = document.getElementById("ip-panel-reserve-btn");
  if (btn) {
    btn.addEventListener("click", function () {
      _openReserveModal(_ipPanelSubnetId, null);
    });
  }
  var freeBtn = document.getElementById("ip-panel-free-selected-btn");
  if (freeBtn) freeBtn.addEventListener("click", _bulkReleaseFromPanel);

  var exportBtn = document.getElementById("ip-panel-export-btn");
  var exportMenu = document.getElementById("ip-panel-export-menu");
  if (exportBtn && exportMenu) {
    exportBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      exportMenu.classList.toggle("open");
    });
    exportMenu.addEventListener("click", function (e) { e.stopPropagation(); });
    exportMenu.querySelectorAll("button[data-fmt]").forEach(function (item) {
      item.addEventListener("click", function () {
        exportMenu.classList.remove("open");
        _exportIpPanel(item.getAttribute("data-fmt"));
      });
    });
  }
}

function _renderIpList(data) {
  var body = document.getElementById("ip-panel-body");

  if (data.ips.length === 0) {
    body.innerHTML = '<p class="empty-state">No IPs to display</p>';
    return;
  }

  var hasReleasable = data.ips.some(function (ip) {
    return !ip.type && ip.reservation && ip.reservation.status === "active" && canManageNetworks();
  });

  var html = '<div class="ip-panel-content"><table class="ip-table" data-sf-table-id="ip-panel"><thead><tr>' +
    '<th class="cb-col">' + (hasReleasable ? '<input type="checkbox" id="panel-select-all" title="Select all active">' : '') + '</th>' +
    '<th data-col-id="__dot" style="width:36px"></th>' +
    '<th data-col-id="ip">IP Address</th>' +
    '<th data-col-id="hostname">Hostname</th>' +
    '<th data-col-id="mac">MAC Address</th>' +
    '<th data-col-id="owner">Owner</th>' +
    '<th data-col-id="expiry">Lease Expiry</th>' +
    '<th data-col-id="status">Status</th>' +
    '<th data-col-id="actions" style="width:140px">Actions</th>' +
    '</tr></thead><tbody>';

  data.ips.forEach(function (ip) {
    var isSpecial = ip.type === "network" || ip.type === "broadcast";
    var r = ip.reservation;
    // A released reservation means the IP has been freed — treat it as available.
    if (r && r.status === "released") r = null;
    var rowClass = isSpecial ? ' class="ip-row-special"' : '';

    var dotClass, statusLabel, statusTooltip = "";
    if (isSpecial) {
      dotClass = "ip-dot-reserved";
      statusLabel = ip.type === "network" ? "Network" : "Broadcast";
    } else if (r && r.conflictMessage) {
      dotClass = "ip-dot-conflict";
      statusLabel = "Conflict";
      statusTooltip = r.conflictMessage;
    } else if (r && r.status === "active" && (r.sourceType === "dhcp_reservation" || r.owner === "dhcp-reservation")) {
      dotClass = "ip-dot-dhcp-reservation";
      statusLabel = "DHCP Reservation";
    } else if (r && r.status === "active" && (r.sourceType === "dhcp_lease" || r.owner === "dhcp-lease")) {
      dotClass = "ip-dot-dhcp-lease";
      statusLabel = "DHCP Lease";
    } else if (r && r.status === "active" && r.sourceType === "vip") {
      dotClass = "ip-dot-active";
      statusLabel = "VIP";
    } else if (r && r.status === "active") {
      dotClass = "ip-dot-active";
      statusLabel = "Active";
    } else if (r && r.status === "expired") {
      dotClass = "ip-dot-expired";
      statusLabel = "Expired";
    } else if (r && r.status === "released") {
      dotClass = "ip-dot-released";
      statusLabel = "Released";
    } else {
      dotClass = "ip-dot-available";
      statusLabel = "Available";
    }

    var hostnameText = r ? escapeHtml(r.hostname || "-") : '<span style="color:var(--color-text-tertiary)">-</span>';
    var vipBadge = "";
    if (r && r.vipInfo) {
      var vi = r.vipInfo;
      var vipTip = "VIP: " + escapeHtml(vi.name || "") + " (" + escapeHtml(vi.role || "") + ") on " + escapeHtml(vi.device || "") + " — ext: " + escapeHtml(vi.extip || "");
      vipBadge = ' <span class="vip-badge" title="' + vipTip + '">VIP</span>';
    }
    var hostname = hostnameText + vipBadge;
    var macRaw = (r && r.macAddress) || (r && r.notes ? (r.notes.match(/MAC:\s*([\w:]+)/) || [])[1] : null) || null;
    var macDisplay = macRaw
      ? '<span class="mono" style="font-size:0.75rem">' + escapeHtml(macRaw) + '</span>'
      : '<span style="color:var(--color-text-tertiary)">-</span>';
    var ownerDisplay = !r
      ? '<span style="color:var(--color-text-tertiary)">-</span>'
      : escapeHtml(r.owner || "-");
    var owner = ownerDisplay;

    var actions = "";
    var isOwner = r && r.createdBy === currentUsername;
    var canEditThis = canManageNetworks() || isOwner;
    var assetBtn = ip.assetId
      ? '<button class="btn btn-sm btn-secondary ip-asset-btn" data-aid="' + escapeHtml(ip.assetId) + '" title="Open asset details">View Asset</button>'
      : '';
    if (isSpecial) {
      actions = "";
    } else if (r && r.status === "active" && (r.sourceType === "dhcp_lease" || r.owner === "dhcp-lease")) {
      actions =
        assetBtn +
        (canReserveIps() ? '<button class="btn btn-sm btn-primary ip-lease-reserve-btn" data-ip="' + escapeHtml(ip.address) + '" data-rid="' + escapeHtml(r.id) + '" data-mac="' + escapeHtml(macRaw || "") + '" data-hostname="' + escapeHtml(r.hostname || "") + '">Reserve</button>' : '') +
        (canEditThis ? '<button class="btn btn-sm btn-secondary ip-edit-btn" data-rid="' + r.id + '" title="Edit">Edit</button>' : '') +
        (canEditThis ? '<button class="btn btn-sm btn-danger ip-release-btn" data-rid="' + r.id + '" title="Release">Free</button>' : '');
    } else if (r && r.status === "active" && r.sourceType === "vip") {
      // VIPs are FortiGate NAT config — they cannot be Freed from Polaris.
      // Reserve lets the operator attach editable metadata (hostname / owner /
      // notes) that survives across discovery cycles.
      actions =
        assetBtn +
        (canEditThis ? '<button class="btn btn-sm btn-secondary ip-edit-btn" data-rid="' + r.id + '" title="Edit">Edit</button>' : '') +
        (canReserveIps() ? '<button class="btn btn-sm btn-primary ip-vip-reserve-btn" data-rid="' + escapeHtml(r.id) + '">Reserve</button>' : '');
    } else if (r && r.status === "active") {
      actions =
        assetBtn +
        (canEditThis ? '<button class="btn btn-sm btn-secondary ip-edit-btn" data-rid="' + r.id + '" title="Edit">Edit</button>' : '') +
        (canEditThis ? '<button class="btn btn-sm btn-danger ip-release-btn" data-rid="' + r.id + '" title="Release">Free</button>' : '');
    } else if (r && r.status === "expired") {
      actions = assetBtn + (canEditThis ? '<button class="btn btn-sm btn-secondary ip-edit-btn" data-rid="' + r.id + '" title="Edit">Edit</button>' : '');
    } else if (!r && canReserveIps()) {
      actions = assetBtn + '<button class="btn btn-sm btn-primary ip-reserve-btn" data-ip="' + escapeHtml(ip.address) + '">Reserve</button>';
    } else {
      actions = assetBtn;
    }

    var statusHtml = statusTooltip
      ? '<span class="conflict-label" title="' + escapeHtml(statusTooltip) + '">' + statusLabel + ' <span class="conflict-icon">&#9888;</span></span>'
      : statusLabel;

    var leaseExpiry = r && r.expiresAt
      ? '<span style="font-size:0.75rem">' + escapeHtml(formatDate(r.expiresAt)) + '</span>'
      : '<span style="color:var(--color-text-tertiary)">-</span>';

    var canRelease = !isSpecial && r && r.status === "active" && canManageNetworks();
    var cbChecked = canRelease && _panelSelected.has(r.id) ? ' checked' : '';
    var cbCell = canRelease
      ? '<td class="cb-col"><input type="checkbox" class="panel-row-cb"' + cbChecked + ' data-rid="' + r.id + '"></td>'
      : '<td class="cb-col"></td>';

    html += '<tr' + rowClass + ' data-ip="' + escapeHtml(ip.address) + '">' +
      cbCell +
      '<td style="text-align:center"><span class="ip-status-dot ' + dotClass + '"></span></td>' +
      '<td class="mono" style="font-size:0.8rem">' + escapeHtml(ip.address) + '</td>' +
      '<td>' + hostname + '</td>' +
      '<td>' + macDisplay + '</td>' +
      '<td>' + owner + '</td>' +
      '<td>' + leaseExpiry + '</td>' +
      '<td style="font-size:0.78rem">' + statusHtml + '</td>' +
      '<td class="actions">' + actions + '</td>' +
      '</tr>';
  });

  html += '</tbody></table>';

  // Pagination
  var totalPages = Math.max(1, Math.ceil(data.totalIps / data.pageSize));
  if (totalPages > 1) {
    html += '<div class="slideover-pagination">' +
      '<button class="btn btn-sm btn-secondary" id="ip-pg-prev"' + (_ipPanelPage <= 1 ? ' disabled' : '') + '>&laquo;</button>' +
      '<span style="font-size:0.8rem;color:var(--color-text-secondary)">Page ' + _ipPanelPage + ' of ' + totalPages + '</span>' +
      '<button class="btn btn-sm btn-secondary" id="ip-pg-next"' + (_ipPanelPage >= totalPages ? ' disabled' : '') + '>&raquo;</button>' +
      '</div>';
  }

  html += '</div>'; // close .ip-panel-content

  body.innerHTML = html;

  // Wire column resize (per-user persisted widths)
  var table = body.querySelector(".ip-table");
  if (table && typeof setupColumnLayout === "function") {
    _ipPanelLayout = setupColumnLayout(table, { onChange: _saveIpPanelPrefs });
    _restoreIpPanelPrefs();
  }

  // Wire up bulk selection
  var panelSelectAll = document.getElementById("panel-select-all");
  if (panelSelectAll) {
    panelSelectAll.addEventListener("change", function () {
      var cbs = body.querySelectorAll(".panel-row-cb");
      var chk = this.checked;
      cbs.forEach(function (cb) {
        cb.checked = chk;
        if (chk) _panelSelected.add(cb.getAttribute("data-rid"));
        else _panelSelected.delete(cb.getAttribute("data-rid"));
      });
      _panelUpdateBulkBar();
    });
  }
  body.addEventListener("change", function (e) {
    var cb = e.target;
    if (!cb.classList.contains("panel-row-cb")) return;
    var rid = cb.getAttribute("data-rid");
    if (cb.checked) _panelSelected.add(rid);
    else _panelSelected.delete(rid);
    _panelUpdateSelectAll();
    _panelUpdateBulkBar();
  });
  _panelUpdateBulkBar();
  _panelUpdateSelectAll();

  // Wire up pagination
  var prevBtn = document.getElementById("ip-pg-prev");
  var nextBtn = document.getElementById("ip-pg-next");
  if (prevBtn) prevBtn.addEventListener("click", function () { _ipPanelPage--; _panelSelected.clear(); _fetchIpPage(); });
  if (nextBtn) nextBtn.addEventListener("click", function () { _ipPanelPage++; _panelSelected.clear(); _fetchIpPage(); });

  // Wire up action buttons
  body.querySelectorAll(".ip-edit-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _openEditReservationModal(btn.getAttribute("data-rid"));
    });
  });
  body.querySelectorAll(".ip-release-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _confirmReleaseFromPanel(btn.getAttribute("data-rid"));
    });
  });
  body.querySelectorAll(".ip-reserve-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _openReserveModal(_ipPanelSubnetId, btn.getAttribute("data-ip"));
    });
  });
  body.querySelectorAll(".ip-lease-reserve-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _openLeaseReserveModal(
        _ipPanelSubnetId,
        btn.getAttribute("data-ip"),
        btn.getAttribute("data-rid"),
        btn.getAttribute("data-mac"),
        btn.getAttribute("data-hostname")
      );
    });
  });
  body.querySelectorAll(".ip-vip-reserve-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _openVipReserveModal(btn.getAttribute("data-rid"));
    });
  });
  body.querySelectorAll(".ip-asset-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var aid = btn.getAttribute("data-aid");
      window.location.href = '/assets.html#view=asset:' + encodeURIComponent(aid);
    });
  });

  // Scroll-to-row on focus IP. Cleared after one render so paginating away
  // doesn't snap back to the original IP.
  if (_ipPanelFocusIp) {
    var target = body.querySelector('tr[data-ip="' + _ipPanelFocusIp.replace(/"/g, '\\"') + '"]');
    if (target) {
      target.classList.add("row-panel-active");
      target.scrollIntoView({ block: "center", behavior: "auto" });
    }
    _ipPanelFocusIp = null;
  }
}

function _panelUpdateSelectAll() {
  var body = document.getElementById("ip-panel-body");
  if (!body) return;
  var allCbs = body.querySelectorAll(".panel-row-cb");
  var checked = Array.from(allCbs).filter(function (cb) { return cb.checked; }).length;
  var sa = document.getElementById("panel-select-all");
  if (!sa) return;
  sa.checked = allCbs.length > 0 && checked === allCbs.length;
  sa.indeterminate = checked > 0 && checked < allCbs.length;
}

function _panelUpdateBulkBar() {
  var btn = document.getElementById("ip-panel-free-selected-btn");
  if (!btn) return;
  var count = _panelSelected.size;
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? "Free Selected (" + count + ")" : "Free Selected";
}

async function _bulkReleaseFromPanel() {
  var ids = Array.from(_panelSelected);
  if (!ids.length) return;
  var ok = await showConfirm("Free " + ids.length + " reservation" + (ids.length !== 1 ? "s" : "") + "? This will release those IPs.");
  if (!ok) return;
  var btn = document.getElementById("ip-panel-free-selected-btn");
  if (btn) btn.disabled = true;
  var failed = 0;
  for (var i = 0; i < ids.length; i++) {
    try { await api.reservations.release(ids[i]); }
    catch (e) { failed++; }
  }
  _panelSelected.clear();
  if (btn) btn.disabled = false;
  _ipPanelDirty = true;
  if (failed > 0) showToast(failed + " release(s) failed", "error");
  else showToast("Freed " + ids.length + " reservation" + (ids.length !== 1 ? "s" : ""));
  _fetchIpPage();
}

function _renderPanelFooter(data) {
  var footer = document.getElementById("ip-panel-footer");
  if (data.ipv6) {
    footer.innerHTML = '<span>' + data.ips.length + ' reservation' + (data.ips.length !== 1 ? 's' : '') + '</span>';
    return;
  }
  var reserved = 0;
  // Count from current page data + total for the summary
  data.ips.forEach(function (ip) {
    if (ip.reservation && ip.reservation.status === "active") reserved++;
  });
  // For multi-page, we show page-level counts
  var totalHosts = Math.max(0, data.totalIps - 2); // exclude network + broadcast
  var pct = totalHosts > 0 ? Math.round((reserved / totalHosts) * 100) : 0;
  var totalPages = Math.ceil(data.totalIps / data.pageSize);
  var pageNote = totalPages > 1 ? ' (this page)' : '';

  footer.innerHTML =
    '<span>' + reserved + ' of ' + totalHosts + ' IPs reserved' + pageNote + '</span>' +
    '<div class="util-bar-track"><div class="util-bar-fill" style="width:' + pct + '%;background:var(--color-accent)"></div></div>' +
    '<span>' + pct + '%</span>';
}

// ─── Reservation modals (reuse existing modal system) ───────────────────────

// Generate a locally-administered unicast MAC for placeholder use when the
// real client MAC isn't known yet (e.g. reserving an IP before the device is
// racked). First octet is fixed at "02" so the locally-administered bit is
// set and the multicast bit is clear — matches the convention used by KVM,
// Docker, FortiOS HA, etc. RFC 1918 is the IPv4 analogue.
function _generateLocalMac() {
  var bytes = ["02"];
  for (var i = 0; i < 5; i++) {
    var b = Math.floor(Math.random() * 256);
    bytes.push((b < 16 ? "0" : "") + b.toString(16));
  }
  return bytes.join(":").toUpperCase();
}

function _macFieldMarkup(label, hint, valueAttr) {
  return '<div class="form-group"><label>' + label + '</label>' +
    '<div style="display:flex;gap:6px;align-items:stretch">' +
      '<input type="text" id="f-macAddress"' + (valueAttr || "") + ' placeholder="aa:bb:cc:dd:ee:ff" style="flex:1">' +
      '<button type="button" class="btn btn-secondary btn-sm" id="btn-gen-mac" title="Generate a locally-administered MAC (02:xx:xx:xx:xx:xx) — placeholder use when the device\'s real MAC isn\'t known yet">Generate</button>' +
    '</div>' +
    '<p class="hint">' + hint + '</p>' +
  '</div>';
}

function _wireGenerateMacButton() {
  var btn = document.getElementById("btn-gen-mac");
  var input = document.getElementById("f-macAddress");
  if (!btn || !input) return;
  btn.addEventListener("click", function () {
    input.value = _generateLocalMac();
    input.focus();
    input.select();
  });
}

function _openAutoAllocateModal(subnetId) {
  var s = _ipPanelData ? _ipPanelData.subnet : null;
  var subnetLabel = s ? escapeHtml(s.name) + ' (' + escapeHtml(s.cidr) + ')' : subnetId;
  var pushEligible = !!(s && s.pushEligible);

  var macLabel = pushEligible ? 'MAC Address *' : 'MAC Address';
  var macHint = pushEligible
    ? 'Required &mdash; this network is configured to push reservations to FortiGate "' + escapeHtml((s && s.fortigateDevice) || '') + '". DHCP reservations are MAC&rarr;IP.'
    : 'Optional unless this network\'s integration pushes reservations to a FortiGate.';
  var body =
    '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
    '<p class="hint" style="margin-bottom:12px">The next available host IP will be reserved automatically.</p>' +
    '<div class="form-group"><label>Hostname *</label><input type="text" id="f-hostname" placeholder="e.g. web-server-01"></div>' +
    _macFieldMarkup(macLabel, macHint) +
    '<div class="form-group"><label>Owner</label><input type="text" id="f-owner" placeholder="e.g. platform-team"></div>' +
    '<div class="form-group"><label>Project Ref</label><input type="text" id="f-projectRef" placeholder="e.g. INFRA-001"></div>' +
    '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt"><p class="hint">Optional TTL</p></div>' +
    '<div class="form-group"><label>Reservation notes</label><textarea id="f-notes" placeholder="e.g. web-server-01"></textarea></div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Auto-Allocate</button>';
  openModal("Auto-Allocate Next IP", body, footer);
  _wireGenerateMacButton();

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var expiresVal = document.getElementById("f-expiresAt").value;
      var macVal = document.getElementById("f-macAddress").value.trim();
      if (pushEligible && !macVal) {
        showToast("MAC address is required for reservations on this network", "error");
        btn.disabled = false;
        return;
      }
      var input = {
        subnetId: subnetId,
        hostname: document.getElementById("f-hostname").value.trim(),
        owner: document.getElementById("f-owner").value.trim() || undefined,
        projectRef: document.getElementById("f-projectRef").value.trim() || undefined,
        expiresAt: expiresVal ? new Date(expiresVal).toISOString() : undefined,
        notes: document.getElementById("f-notes").value.trim() || undefined,
        macAddress: macVal || undefined,
      };
      var reservation = await api.reservations.nextAvailable(input);
      closeModal();
      var pushed = reservation && reservation.pushStatus === "synced";
      showToast(pushed
        ? ("Reserved " + reservation.ipAddress + " and pushed to FortiGate")
        : ("Reserved " + reservation.ipAddress));
      _ipPanelDirty = true;
      _fetchIpPage();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function _openReserveModal(subnetId, ipAddress) {
  var s = _ipPanelData ? _ipPanelData.subnet : null;
  var subnetLabel = s ? escapeHtml(s.name) + ' (' + escapeHtml(s.cidr) + ')' : subnetId;
  var pushEligible = !!(s && s.pushEligible);

  var macLabel = pushEligible ? 'MAC Address *' : 'MAC Address';
  var macHint = pushEligible
    ? 'Required &mdash; this network is configured to push reservations to FortiGate "' + escapeHtml((s && s.fortigateDevice) || '') + '". DHCP reservations are MAC&rarr;IP.'
    : 'Optional unless this network\'s integration pushes reservations to a FortiGate.';
  var body =
    '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
    '<div class="form-group"><label>IP Address' + (ipAddress ? '' : ' *') + '</label>' +
      (ipAddress
        ? '<input type="text" value="' + escapeHtml(ipAddress) + '" disabled>'
        : '<input type="text" id="f-ipAddress" placeholder="e.g. ' + (s ? escapeHtml(s.cidr.replace(/\/.*/, '').replace(/\.0$/, '.10')) : '10.0.1.10') + '">') +
    '</div>' +
    '<div class="form-group"><label>Hostname *</label><input type="text" id="f-hostname" placeholder="e.g. web-server-01"></div>' +
    _macFieldMarkup(macLabel, macHint) +
    '<div class="form-group"><label>Owner</label><input type="text" id="f-owner" placeholder="e.g. platform-team"></div>' +
    '<div class="form-group"><label>Project Ref</label><input type="text" id="f-projectRef" placeholder="e.g. INFRA-001"></div>' +
    '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt"><p class="hint">Optional TTL</p></div>' +
    '<div class="form-group"><label>Reservation notes</label><textarea id="f-notes" placeholder="e.g. web-server-01"></textarea></div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create Reservation</button>';
  openModal("Reserve IP", body, footer);
  _wireGenerateMacButton();

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var ipEl = document.getElementById("f-ipAddress");
      var expiresVal = document.getElementById("f-expiresAt").value;
      var macVal = document.getElementById("f-macAddress").value.trim();
      if (pushEligible && !macVal) {
        showToast("MAC address is required for reservations on this network", "error");
        btn.disabled = false;
        return;
      }
      var input = {
        subnetId: subnetId,
        ipAddress: ipAddress || (ipEl ? ipEl.value.trim() : undefined) || undefined,
        hostname: document.getElementById("f-hostname").value.trim(),
        owner: document.getElementById("f-owner").value.trim() || undefined,
        projectRef: document.getElementById("f-projectRef").value.trim() || undefined,
        expiresAt: expiresVal ? new Date(expiresVal).toISOString() : undefined,
        notes: document.getElementById("f-notes").value.trim() || undefined,
        macAddress: macVal || undefined,
      };
      var reservation = await api.reservations.create(input);
      closeModal();
      var pushed = reservation && reservation.pushStatus === "synced";
      showToast(pushed ? "Reservation created and pushed to FortiGate" : "Reservation created");
      _ipPanelDirty = true;
      _fetchIpPage();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function _openLeaseReserveModal(subnetId, ipAddress, leaseId, prefillMac, prefillHostname) {
  var s = _ipPanelData ? _ipPanelData.subnet : null;
  var subnetLabel = s ? escapeHtml(s.name) + ' (' + escapeHtml(s.cidr) + ')' : subnetId;
  var pushEligible = !!(s && s.pushEligible);
  var fortigateDevice = (s && s.fortigateDevice) || '';

  var macLabel = pushEligible ? 'MAC Address *' : 'MAC Address';
  var macHint = pushEligible
    ? 'Required &mdash; this network is configured to push reservations to FortiGate "' + escapeHtml(fortigateDevice) + '". DHCP reservations are MAC&rarr;IP.'
    : 'Optional unless this network\'s integration pushes reservations to a FortiGate.';

  var body =
    '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
    '<div class="form-group"><label>IP Address</label><input type="text" value="' + escapeHtml(ipAddress) + '" disabled></div>' +
    '<p class="hint" style="margin-bottom:12px">The existing DHCP lease will be released and replaced with a manual reservation.</p>' +
    '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" value="' + escapeHtml(prefillHostname || "") + '" placeholder="e.g. web-server-01"></div>' +
    _macFieldMarkup(macLabel, macHint, ' value="' + escapeHtml(prefillMac || "") + '"') +
    '<div class="form-group"><label>Owner</label><input type="text" id="f-owner" placeholder="e.g. platform-team"></div>' +
    '<div class="form-group"><label>Project Ref</label><input type="text" id="f-projectRef" placeholder="e.g. INFRA-001"></div>' +
    '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt"><p class="hint">Optional TTL</p></div>' +
    '<div class="form-group"><label>Reservation notes</label><textarea id="f-notes" placeholder="e.g. web-server-01"></textarea></div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create Reservation</button>';
  openModal("Reserve IP", body, footer);
  _wireGenerateMacButton();

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;

    // Capture all values before any modal manipulation
    var macVal = document.getElementById("f-macAddress").value.trim();
    var hostname = document.getElementById("f-hostname").value.trim();
    var expiresVal = document.getElementById("f-expiresAt").value;
    var owner = document.getElementById("f-owner").value.trim();
    var projectRef = document.getElementById("f-projectRef").value.trim();
    var notes = document.getElementById("f-notes").value.trim();

    if (pushEligible && !macVal) {
      showToast("MAC address is required for reservations on this network", "error");
      btn.disabled = false;
      return;
    }

    var input = {
      subnetId: subnetId,
      ipAddress: ipAddress,
      hostname: hostname || undefined,
      owner: owner || undefined,
      projectRef: projectRef || undefined,
      expiresAt: expiresVal ? new Date(expiresVal).toISOString() : undefined,
      notes: notes || undefined,
      macAddress: macVal || undefined,
    };

    closeModal();

    if (pushEligible) {
      var confirmed = await _confirmPushReservation(ipAddress, macVal, fortigateDevice);
      if (!confirmed) return;
    }

    try {
      await api.reservations.release(leaseId);
      var reservation = await api.reservations.create(input);
      var pushed = reservation && reservation.pushStatus === "synced";
      showToast(pushed ? "Reservation created and pushed to FortiGate" : "Reservation created");
      _ipPanelDirty = true;
      _fetchIpPage();
    } catch (err) {
      showToast(err.message, "error");
    }
  });
}

function _confirmPushReservation(ipAddress, macAddress, fortigateDevice) {
  return new Promise(function (resolve) {
    var body =
      '<p>This network pushes DHCP reservations to FortiGate <strong>' + escapeHtml(fortigateDevice) + '</strong>.</p>' +
      '<p style="margin-top:8px">The reservation for <code>' + escapeHtml(ipAddress) + '</code>' +
      (macAddress ? ' (MAC <code>' + escapeHtml(macAddress) + '</code>)' : '') +
      ' will be written to the FortiGate\'s DHCP server. If the push fails, the reservation will not be created.</p>';
    var footer =
      '<button class="btn btn-secondary" id="btn-push-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-push-confirm">Push &amp; Create</button>';
    openModal("Push to FortiGate?", body, footer);
    document.getElementById("btn-push-confirm").addEventListener("click", function () {
      closeModal();
      resolve(true);
    });
    document.getElementById("btn-push-cancel").addEventListener("click", function () {
      closeModal();
      resolve(false);
    });
  });
}

function _openVipReserveModal(reservationId) {
  api.reservations.get(reservationId).then(function (r) {
    var subnetLabel = r.subnet ? escapeHtml(r.subnet.name) + " (" + escapeHtml(r.subnet.cidr) + ")" : r.subnetId;
    var expiresVal = r.expiresAt ? _toDatetimeLocal(r.expiresAt) : "";
    var vip = r.vipInfo || {};
    var vipBlurb = '<p class="hint" style="margin-bottom:12px">Attach a reservation to this FortiGate VIP. Hostname, owner, and notes are operator-editable and survive discovery cycles.' +
      (vip.name ? ' <strong>VIP:</strong> ' + escapeHtml(vip.name) + (vip.device ? ' on ' + escapeHtml(vip.device) : '') : '') +
      '</p>';
    var body = vipBlurb +
      '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
      '<div class="form-group"><label>IP Address</label><input type="text" value="' + escapeHtml(r.ipAddress || "") + '" disabled></div>' +
      '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" value="' + escapeHtml(r.hostname || "") + '" placeholder="e.g. web-server-01"></div>' +
      '<div class="form-group"><label>Owner</label><input type="text" id="f-owner" value="' + escapeHtml(r.owner || "") + '" placeholder="e.g. platform-team"></div>' +
      '<div class="form-group"><label>Project Ref</label><input type="text" id="f-projectRef" value="' + escapeHtml(r.projectRef || "") + '" placeholder="e.g. INFRA-001"></div>' +
      '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt" value="' + expiresVal + '"><p class="hint">Optional TTL</p></div>' +
      '<div class="form-group"><label>Reservation notes</label><textarea id="f-notes" placeholder="Reservation notes — e.g. web-server-01">' + escapeHtml(r.notes || "") + '</textarea></div>';
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Reservation</button>';
    openModal("Reserve VIP IP", body, footer);

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        var expires = document.getElementById("f-expiresAt").value;
        var input = {
          hostname: document.getElementById("f-hostname").value.trim() || undefined,
          owner: document.getElementById("f-owner").value.trim() || undefined,
          projectRef: document.getElementById("f-projectRef").value.trim() || undefined,
          expiresAt: expires ? new Date(expires).toISOString() : undefined,
          notes: document.getElementById("f-notes").value.trim() || undefined,
        };
        await api.reservations.update(reservationId, input);
        closeModal();
        showToast("VIP reservation updated");
        _ipPanelDirty = true;
        _fetchIpPage();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }).catch(function (err) {
    showToast(err.message, "error");
  });
}

function _openEditReservationModal(reservationId) {
  // Owners of dhcp-reservation / dhcp-lease records can edit their own entries
  // even without canManageNetworks. For simple read-only detection, we treat
  // anything the user can't write as view-only.
  api.reservations.get(reservationId).then(function (r) {
    var isOwner = currentUsername && r.owner === currentUsername;
    var readOnly = !canManageNetworks() && !isOwner;
    var lock = readOnly ? ' disabled class="field-locked"' : '';
    var subnetLabel = r.subnet ? escapeHtml(r.subnet.name) + " (" + escapeHtml(r.subnet.cidr) + ")" : r.subnetId;
    var expiresVal = r.expiresAt ? _toDatetimeLocal(r.expiresAt) : "";
    var banner = readOnly
      ? '<p class="hint" style="margin-bottom:12px">View-only — you don\'t have permission to edit this reservation.</p>'
      : '';
    var body = banner +
      '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
      '<div class="form-group"><label>IP Address</label><input type="text" value="' + escapeHtml(r.ipAddress || "Full network") + '" disabled></div>' +
      '<div class="form-group"><label>Status</label>' + statusBadge(r.status) + '</div>' +
      '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" value="' + escapeHtml(r.hostname || "") + '"' + lock + '></div>' +
      '<div class="form-group"><label>Owner</label><input type="text" id="f-owner" value="' + escapeHtml(r.owner) + '"' + lock + '></div>' +
      '<div class="form-group"><label>Project Ref</label><input type="text" id="f-projectRef" value="' + escapeHtml(r.projectRef) + '"' + lock + '></div>' +
      '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt" value="' + expiresVal + '"' + lock + '></div>' +
      '<div class="form-group"><label>Reservation notes</label><textarea id="f-notes" placeholder="e.g. web-server-01"' + lock + '>' + escapeHtml(r.notes || "") + '</textarea></div>';
    var footer = readOnly
      ? '<button class="btn btn-secondary" onclick="closeModal()">Close</button>'
      : '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
        '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal(readOnly ? "View Reservation" : "Edit Reservation", body, footer);

    if (!readOnly) {
      document.getElementById("btn-save").addEventListener("click", async function () {
        var btn = this;
        btn.disabled = true;
        try {
          var expiresVal = document.getElementById("f-expiresAt").value;
          var input = {
            hostname: document.getElementById("f-hostname").value.trim() || undefined,
            owner: document.getElementById("f-owner").value.trim() || undefined,
            projectRef: document.getElementById("f-projectRef").value.trim() || undefined,
            expiresAt: expiresVal ? new Date(expiresVal).toISOString() : undefined,
            notes: document.getElementById("f-notes").value.trim() || undefined,
          };
          await api.reservations.update(reservationId, input);
          closeModal();
          showToast("Reservation updated");
          _ipPanelDirty = true;
          _fetchIpPage();
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          btn.disabled = false;
        }
      });
    }
  }).catch(function (err) {
    showToast(err.message, "error");
  });
}

// Global alias so other scripts (e.g. search click-through) can open a
// reservation without needing to know about the ip-panel internals.
function openReservationModal(reservationId) {
  _openEditReservationModal(reservationId);
}

async function _confirmReleaseFromPanel(reservationId) {
  var ok = await showConfirm("Release this reservation? This will free the IP.");
  if (!ok) return;
  try {
    await api.reservations.release(reservationId);
    showToast("Reservation released");
    _ipPanelDirty = true;
    _fetchIpPage();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function _toDatetimeLocal(isoStr) {
  var d = new Date(isoStr);
  var pad = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/* ─── Export (PDF / CSV) ──────────────────────────────────────────────────── */

async function _exportIpPanel(fmt) {
  if (!_ipPanelData) {
    showToast("No data to export", "error");
    return;
  }

  var data = _ipPanelData;
  var s = data.subnet;
  var totalPages = Math.max(1, Math.ceil(data.totalIps / data.pageSize));

  // If multi-page, confirm first
  var allIps = data.ips;
  if (totalPages > 1) {
    var ok = await showConfirm(
      "This network has " + data.totalIps + " IPs across " + totalPages + " pages. Export all?"
    );
    if (!ok) return;
  }

  await trackedPdfExport("Exporting " + s.name + " " + fmt.toUpperCase(), async function (signal) {
    if (totalPages > 1) {
      var qs = toQuery({ page: 1, pageSize: data.totalIps });
      var full = await request("GET", "/subnets/" + _ipPanelSubnetId + "/ips" + qs, undefined, signal);
      allIps = full.ips;
    }
    if (signal.aborted) return;
    if (fmt === "csv") _generateIpPanelCsv(s, allIps);
    else _generateIpPanelPdf(s, allIps);
  });
}

function _generateIpPanelPdf(s, allIps) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();

  // Header
  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Polaris") + " \u2014 Network Detail", 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Generated: " + timestamp, 40, 52);

  // Subnet info
  var yPos = 70;
  doc.setFontSize(12);
  doc.setTextColor(40, 40, 40);
  doc.text(s.name + "  (" + s.cidr + ")", 40, yPos);
  yPos += 16;
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  var details = [];
  if (s.status) details.push("Status: " + s.status.charAt(0).toUpperCase() + s.status.slice(1));
  if (s.vlan) details.push("VLAN: " + s.vlan);
  if (s.purpose) details.push("Purpose: " + s.purpose);
  details.push("Total IPs: " + allIps.length);
  doc.text(details.join("  |  "), 40, yPos);
  yPos += 18;

  // Table
  var head = [["IP Address", "Hostname", "MAC Address", "Owner", "Lease Expiry", "Status"]];
  var body = allIps.map(function (ip) {
    var isSpecial = ip.type === "network" || ip.type === "broadcast";
    var r = ip.reservation;
    if (r && r.status === "released") r = null;
    var statusLabel;
    if (isSpecial) {
      statusLabel = ip.type === "network" ? "Network" : "Broadcast";
    } else if (r && r.conflictMessage) {
      statusLabel = "Conflict: " + r.conflictMessage;
    } else if (r && r.status === "active" && (r.sourceType === "dhcp_reservation" || r.owner === "dhcp-reservation")) {
      statusLabel = "DHCP Reservation";
    } else if (r && r.status === "active" && (r.sourceType === "dhcp_lease" || r.owner === "dhcp-lease")) {
      statusLabel = "DHCP Lease";
    } else if (r && r.status === "active") {
      statusLabel = "Active";
    } else if (r && r.status === "expired") {
      statusLabel = "Expired";
    } else {
      statusLabel = "Available";
    }

    var macMatch = r && r.notes ? r.notes.match(/MAC:\s*([\w:]+)/) : null;
    var mac = macMatch ? macMatch[1] : "-";
    var owner = r ? (r.owner || "-") : "-";
    var expiry = r && r.expiresAt ? formatDate(r.expiresAt) : "-";

    return [
      ip.address,
      r ? (r.hostname || "-") : "-",
      mac,
      owner,
      expiry,
      statusLabel,
    ];
  });

  doc.autoTable({
    startY: yPos,
    head: head,
    body: body,
    theme: "grid",
    styles: { fontSize: 7.5, cellPadding: 3, overflow: "linebreak" },
    headStyles: { fillColor: [30, 30, 54], textColor: [230, 230, 230], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 250] },
    margin: { left: 40, right: 40 },
    columnStyles: {
      0: { cellWidth: 100, font: "courier" },
    },
    didDrawPage: function (pgData) {
      var pageNum = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        "Page " + pgData.pageNumber + " of " + pageNum + "  |  " + s.name + " (" + s.cidr + ")",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "polaris-network-" + s.cidr.replace(/[\/]/g, "_") + "-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + allIps.length + " IPs to " + filename);
}

function _generateIpPanelCsv(s, allIps) {
  var headers = ["IP Address", "Hostname", "MAC Address", "Owner", "Lease Expiry", "Status"];
  var rows = allIps.map(function (ip) {
    var isSpecial = ip.type === "network" || ip.type === "broadcast";
    var r = ip.reservation;
    if (r && r.status === "released") r = null;
    var statusLabel;
    if (isSpecial) {
      statusLabel = ip.type === "network" ? "Network" : "Broadcast";
    } else if (r && r.conflictMessage) {
      statusLabel = "Conflict: " + r.conflictMessage;
    } else if (r && r.status === "active" && (r.sourceType === "dhcp_reservation" || r.owner === "dhcp-reservation")) {
      statusLabel = "DHCP Reservation";
    } else if (r && r.status === "active" && (r.sourceType === "dhcp_lease" || r.owner === "dhcp-lease")) {
      statusLabel = "DHCP Lease";
    } else if (r && r.status === "active") {
      statusLabel = "Active";
    } else if (r && r.status === "expired") {
      statusLabel = "Expired";
    } else {
      statusLabel = "Available";
    }
    var macMatch = r && r.notes ? r.notes.match(/MAC:\s*([\w:]+)/) : null;
    var mac = macMatch ? macMatch[1] : "";
    var owner = r ? (r.owner || "") : "";
    var expiry = r && r.expiresAt ? formatDate(r.expiresAt) : "";
    return [ip.address, r ? (r.hostname || "") : "", mac, owner, expiry, statusLabel];
  });
  var filename = "polaris-network-" + s.cidr.replace(/[\/]/g, "_") + "-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + allIps.length + " IPs to " + filename);
}
