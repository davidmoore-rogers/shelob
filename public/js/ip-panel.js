/**
 * public/js/ip-panel.js — Slide-over IP panel for networks page
 */

var _ipPanelSubnetId = null;
var _ipPanelPage = 1;
var _ipPanelPageSize = 256;
var _ipPanelData = null;

// ─── Panel lifecycle ────────────────────────────────────────────────────────

function _ensurePanelDOM() {
  if (document.getElementById("ip-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "ip-panel-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="ip-panel">' +
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
}

function openIpPanel(subnetId) {
  _ensurePanelDOM();
  _ipPanelSubnetId = subnetId;
  _ipPanelPage = 1;
  document.getElementById("ip-panel-title").textContent = "Loading...";
  document.getElementById("ip-panel-meta").innerHTML = "";
  document.getElementById("ip-panel-body").innerHTML = '<p class="empty-state">Loading...</p>';
  document.getElementById("ip-panel-footer").innerHTML = "";
  requestAnimationFrame(function () {
    document.getElementById("ip-panel-overlay").classList.add("open");
  });
  _fetchIpPage();
}

function closeIpPanel() {
  var overlay = document.getElementById("ip-panel-overlay");
  if (overlay) overlay.classList.remove("open");
  _ipPanelSubnetId = null;
  _ipPanelData = null;
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
  if (s.status) meta += statusBadge(s.status);
  if (s.vlan) meta += '<span class="badge badge-vlan">VLAN ' + s.vlan + '</span>';
  if (s.purpose) meta += '<span style="color:var(--color-text-tertiary)">' + escapeHtml(s.purpose) + '</span>';
  if (data.ipv6) meta += '<span style="color:var(--color-warning);font-size:0.75rem">IPv6 — showing reservations only</span>';

  var reserveBtn = isAdmin()
    ? '<button class="btn btn-sm btn-primary" id="ip-panel-reserve-btn" style="margin-left:auto">+ Reserve IP</button>'
    : '';
  meta += reserveBtn;

  document.getElementById("ip-panel-meta").innerHTML = meta;

  var btn = document.getElementById("ip-panel-reserve-btn");
  if (btn) {
    btn.addEventListener("click", function () {
      _openReserveModal(_ipPanelSubnetId, null);
    });
  }
}

function _renderIpList(data) {
  var body = document.getElementById("ip-panel-body");

  if (data.ips.length === 0) {
    body.innerHTML = '<p class="empty-state">No IPs to display</p>';
    return;
  }

  var html = '<table class="ip-table"><thead><tr>' +
    '<th style="width:36px"></th>' +
    '<th>IP Address</th>' +
    '<th>Hostname</th>' +
    '<th>Owner</th>' +
    '<th>Status</th>' +
    '<th style="width:100px">Actions</th>' +
    '</tr></thead><tbody>';

  data.ips.forEach(function (ip) {
    var isSpecial = ip.type === "network" || ip.type === "broadcast";
    var r = ip.reservation;
    var rowClass = isSpecial ? ' class="ip-row-special"' : '';

    var dotClass, statusLabel;
    if (isSpecial) {
      dotClass = "ip-dot-reserved";
      statusLabel = ip.type === "network" ? "Network" : "Broadcast";
    } else if (r && r.status === "active" && r.owner === "dhcp-reservation") {
      dotClass = "ip-dot-dhcp-reservation";
      statusLabel = "DHCP Reservation";
    } else if (r && r.status === "active" && r.owner === "dhcp-lease") {
      dotClass = "ip-dot-dhcp-lease";
      statusLabel = "DHCP Lease";
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

    var hostname = r ? escapeHtml(r.hostname || "-") : '<span style="color:var(--color-text-tertiary)">-</span>';
    var ownerDisplay;
    if (!r) {
      ownerDisplay = '<span style="color:var(--color-text-tertiary)">-</span>';
    } else if (r.owner === "dhcp-reservation" || r.owner === "dhcp-lease") {
      // Extract MAC from notes if present (format: "... — MAC: AA:BB:CC:DD:EE:FF")
      var macMatch = r.notes ? r.notes.match(/MAC:\s*([\w:]+)/) : null;
      ownerDisplay = macMatch
        ? '<span class="mono" style="font-size:0.75rem">' + escapeHtml(macMatch[1]) + '</span>'
        : escapeHtml(r.owner);
    } else {
      ownerDisplay = escapeHtml(r.owner || "-");
    }
    var owner = ownerDisplay;

    var actions = "";
    if (isSpecial) {
      actions = "";
    } else if (r && r.status === "active") {
      actions =
        '<button class="btn btn-sm btn-secondary ip-edit-btn" data-rid="' + r.id + '" title="Edit">Edit</button>' +
        (isAdmin() ? '<button class="btn btn-sm btn-danger ip-release-btn" data-rid="' + r.id + '" title="Release">Free</button>' : '');
    } else if (r && r.status === "expired") {
      actions = '<button class="btn btn-sm btn-secondary ip-edit-btn" data-rid="' + r.id + '" title="Edit">Edit</button>';
    } else if (!r && isAdmin()) {
      actions = '<button class="btn btn-sm btn-primary ip-reserve-btn" data-ip="' + escapeHtml(ip.address) + '">Reserve</button>';
    }

    html += '<tr' + rowClass + '>' +
      '<td style="text-align:center"><span class="ip-status-dot ' + dotClass + '"></span></td>' +
      '<td class="mono" style="font-size:0.8rem">' + escapeHtml(ip.address) + '</td>' +
      '<td>' + hostname + '</td>' +
      '<td>' + owner + '</td>' +
      '<td style="font-size:0.78rem">' + statusLabel + '</td>' +
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

  body.innerHTML = html;

  // Wire up pagination
  var prevBtn = document.getElementById("ip-pg-prev");
  var nextBtn = document.getElementById("ip-pg-next");
  if (prevBtn) prevBtn.addEventListener("click", function () { _ipPanelPage--; _fetchIpPage(); });
  if (nextBtn) nextBtn.addEventListener("click", function () { _ipPanelPage++; _fetchIpPage(); });

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

function _openReserveModal(subnetId, ipAddress) {
  var s = _ipPanelData ? _ipPanelData.subnet : null;
  var subnetLabel = s ? escapeHtml(s.name) + ' (' + escapeHtml(s.cidr) + ')' : subnetId;

  var body =
    '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
    '<div class="form-group"><label>IP Address' + (ipAddress ? '' : ' *') + '</label>' +
      (ipAddress
        ? '<input type="text" value="' + escapeHtml(ipAddress) + '" disabled>'
        : '<input type="text" id="f-ipAddress" placeholder="e.g. ' + (s ? escapeHtml(s.cidr.replace(/\/.*/, '').replace(/\.0$/, '.10')) : '10.0.1.10') + '">') +
    '</div>' +
    '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" placeholder="e.g. web-server-01"></div>' +
    '<div class="form-group"><label>Owner *</label><input type="text" id="f-owner" placeholder="e.g. platform-team"></div>' +
    '<div class="form-group"><label>Project Ref *</label><input type="text" id="f-projectRef" placeholder="e.g. INFRA-001"></div>' +
    '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt"><p class="hint">Optional TTL</p></div>' +
    '<div class="form-group"><label>Notes</label><textarea id="f-notes" placeholder="Optional notes"></textarea></div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create Reservation</button>';
  openModal("Reserve IP", body, footer);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var ipEl = document.getElementById("f-ipAddress");
      var expiresVal = document.getElementById("f-expiresAt").value;
      var input = {
        subnetId: subnetId,
        ipAddress: ipAddress || (ipEl ? ipEl.value.trim() : undefined) || undefined,
        hostname: document.getElementById("f-hostname").value.trim() || undefined,
        owner: document.getElementById("f-owner").value.trim(),
        projectRef: document.getElementById("f-projectRef").value.trim(),
        expiresAt: expiresVal ? new Date(expiresVal).toISOString() : undefined,
        notes: document.getElementById("f-notes").value.trim() || undefined,
      };
      await api.reservations.create(input);
      closeModal();
      showToast("Reservation created");
      _fetchIpPage();
      if (typeof loadSubnets === "function") loadSubnets();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function _openEditReservationModal(reservationId) {
  api.reservations.get(reservationId).then(function (r) {
    var subnetLabel = r.subnet ? escapeHtml(r.subnet.name) + " (" + escapeHtml(r.subnet.cidr) + ")" : r.subnetId;
    var expiresVal = r.expiresAt ? _toDatetimeLocal(r.expiresAt) : "";
    var body =
      '<div class="form-group"><label>Network</label><input type="text" value="' + subnetLabel + '" disabled></div>' +
      '<div class="form-group"><label>IP Address</label><input type="text" value="' + escapeHtml(r.ipAddress || "Full network") + '" disabled></div>' +
      '<div class="form-group"><label>Status</label>' + statusBadge(r.status) + '</div>' +
      '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" value="' + escapeHtml(r.hostname || "") + '"></div>' +
      '<div class="form-group"><label>Owner</label><input type="text" id="f-owner" value="' + escapeHtml(r.owner) + '"></div>' +
      '<div class="form-group"><label>Project Ref</label><input type="text" id="f-projectRef" value="' + escapeHtml(r.projectRef) + '"></div>' +
      '<div class="form-group"><label>Expires At</label><input type="datetime-local" id="f-expiresAt" value="' + expiresVal + '"></div>' +
      '<div class="form-group"><label>Notes</label><textarea id="f-notes">' + escapeHtml(r.notes || "") + '</textarea></div>';
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Reservation", body, footer);

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

async function _confirmReleaseFromPanel(reservationId) {
  var ok = await showConfirm("Release this reservation? This will free the IP.");
  if (!ok) return;
  try {
    await api.reservations.release(reservationId);
    showToast("Reservation released");
    _fetchIpPage();
    if (typeof loadSubnets === "function") loadSubnets();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function _toDatetimeLocal(isoStr) {
  var d = new Date(isoStr);
  var pad = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
