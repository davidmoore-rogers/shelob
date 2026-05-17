// public/js/mobile/reservations-tab.js — Reservations tab.
//
// Lists active reservations. Each row collapses to IP (headline) +
// MAC / hostname (subtitle). Tapping the row expands it inline to
// show owner/subnet/source/notes plus role-gated action buttons:
//   • Edit  — opens an inline edit sheet (PUT /reservations/:id).
//             Visible to admin/networkadmin always; user/assetsadmin
//             only when r.createdBy === user.username.
//   • Free  — releases the reservation (DELETE /reservations/:id).
//             Same role gating as Edit.
//   • Reserve — only on `sourceType="dhcp_lease"` rows. Opens the
//             standard reserve sheet (subnet-detail.js global helper)
//             pre-populated with IP / MAC / hostname. On submit, the
//             helper releases the lease first then creates a manual
//             reservation that pushes to the FortiGate when the
//             subnet's integration has DHCP push enabled.
//             Visible to any role with create access
//             (admin/networkadmin/assetsadmin/user).
//
// Only one row stays expanded at a time. Tapping the same row again
// collapses it.

(function () {
  var LIST_LIMIT = 200;
  var CREATE_ROLES = ["admin", "networkadmin", "assetsadmin", "user"];
  var ADMIN_ROLES  = ["admin", "networkadmin"];

  var _state = { rows: [], expandedId: null, user: null };

  function canCreate(user) {
    return !!(user && user.role && CREATE_ROLES.indexOf(user.role) !== -1);
  }
  // Edit / Free: admin + networkadmin pass unconditionally; user +
  // assetsadmin only when they created the row. Matches the
  // requireUserOrAbove + isNetworkAdminOrAbove guards on the backend
  // (see src/api/routes/reservations.ts).
  function canModify(user, row) {
    if (!canCreate(user)) return false;
    if (ADMIN_ROLES.indexOf(user.role) !== -1) return true;
    return !!(row && row.createdBy && user.username && row.createdBy === user.username);
  }

  var Reservations = {
    title: "Reservations",
    icon: "#i-bookmark",
    renderTopbar: function () {
      return ""
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Reservations</div>'
        + '  <div class="trailing">'
        + '    <button class="icon-btn" id="reservations-refresh-btn" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body, ctx) {
      _state.user = (ctx && ctx.user) || null;
      _state.expandedId = null;
      body.innerHTML = '<div id="reservations-host"></div>';
      load();

      var btn = document.getElementById("reservations-refresh-btn");
      if (btn) btn.addEventListener("click", function () {
        btn.disabled = true;
        load().finally(function () { btn.disabled = false; });
      });
    },
  };

  function load() {
    var host = document.getElementById("reservations-host");
    if (!host) return Promise.resolve();
    host.innerHTML = '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';

    return api.reservations.list({ status: "active", limit: LIST_LIMIT }).then(function (resp) {
      _state.rows = (resp && resp.reservations) || [];
      _state.total = (resp && resp.total) || _state.rows.length;
      renderList();
    }).catch(function (err) {
      host.innerHTML = ""
        + '<div class="empty-state" style="padding-top:48px;">'
        + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
        + '  <div class="ttl">Couldn’t load</div>'
        + '  <div class="desc">' + escapeHtml(err && err.message ? err.message : "error") + '</div>'
        + '</div>';
    });
  }

  function renderList() {
    var host = document.getElementById("reservations-host");
    if (!host) return;
    var rs = _state.rows;
    if (rs.length === 0) {
      host.innerHTML = ""
        + '<div class="empty-state" style="padding-top:48px;">'
        + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-bookmark"/></svg></div>'
        + '  <div class="ttl">No reservations</div>'
        + '  <div class="desc">No active reservations on file.</div>'
        + '</div>';
      return;
    }

    var html = ""
      + '<div class="section-head">Active<span class="count">'
      + escapeHtml(String(rs.length))
      + (_state.total > rs.length ? " of " + escapeHtml(String(_state.total)) : "")
      + '</span></div>';

    rs.forEach(function (r, i) {
      var expanded = _state.expandedId === r.id;
      var subtitleBits = [];
      if (r.macAddress) subtitleBits.push('<span class="mono">' + escapeHtml(r.macAddress) + '</span>');
      if (r.hostname) subtitleBits.push(escapeHtml(r.hostname));
      if (subtitleBits.length === 0 && r.subnet) {
        // Nothing identifying the device — fall back to the subnet label
        // so the row still has a useful second line.
        if (r.subnet.name) subtitleBits.push(escapeHtml(r.subnet.name));
        else if (r.subnet.cidr) subtitleBits.push('<span class="mono">' + escapeHtml(r.subnet.cidr) + '</span>');
      }
      var subtitle = subtitleBits.join(" · ") || '<span style="color:var(--md-on-surface-variant);">—</span>';

      var chevHref = expanded ? "#i-chev-down" : "#i-chev-right";
      var ip = r.ipAddress || "—";

      html += ""
        + '<button class="list-item two-line" data-id="' + escapeHtml(r.id) + '"' + (expanded ? ' aria-expanded="true"' : '') + '>'
        + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-bookmark"/></svg></span>'
        + '  <div class="content">'
        + '    <div class="headline"><span class="mono">' + escapeHtml(ip) + '</span></div>'
        + '    <div class="supporting">' + subtitle + '</div>'
        + '  </div>'
        + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="' + chevHref + '"/></svg></div>'
        + '</button>'
        + (expanded ? renderExpandedPanel(r) : '')
        + (i < rs.length - 1 ? '<div class="list-divider"></div>' : "");
    });
    host.innerHTML = html;

    wireRowHandlers();
  }

  function renderExpandedPanel(r) {
    var detailRows = [];
    if (r.hostname) detailRows.push(detailRow("Hostname", escapeHtml(r.hostname)));
    if (r.owner)    detailRows.push(detailRow("Owner", escapeHtml(r.owner)));
    if (r.subnet) {
      var subnetText = r.subnet.name
        ? escapeHtml(r.subnet.name) + (r.subnet.cidr ? ' <span class="mono" style="color:var(--md-on-surface-variant);font-size:12px;">' + escapeHtml(r.subnet.cidr) + '</span>' : '')
        : (r.subnet.cidr ? '<span class="mono">' + escapeHtml(r.subnet.cidr) + '</span>' : '—');
      detailRows.push(detailRow("Network", subnetText));
    }
    if (r.sourceType) detailRows.push(detailRow("Source", escapeHtml(String(r.sourceType).replace(/_/g, " "))));
    if (r.notes)    detailRows.push(detailRow("Notes", escapeHtml(r.notes)));
    if (r.expiresAt) detailRows.push(detailRow("Expires", escapeHtml(formatDate(r.expiresAt))));
    if (r.createdBy) detailRows.push(detailRow("Created by", escapeHtml(r.createdBy)));

    var user = _state.user;
    var buttons = [];
    var isLease = r.sourceType === "dhcp_lease";
    if (isLease && canCreate(user)) {
      // Green when push-eligible so the operator sees that confirming
      // also writes the reservation to the FortiGate.
      var reserveCls = r.pushEligible ? "btn-success" : "btn-filled";
      var reserveTitle = r.pushEligible ? "Reserve on Gate" : "Reserve in Polaris";
      buttons.push('<button class="btn ' + reserveCls + '" data-act="reserve" data-id="' + escapeHtml(r.id) + '" title="' + reserveTitle + '">Reserve</button>');
    }
    if (canModify(user, r)) {
      buttons.push('<button class="btn btn-tonal" data-act="edit" data-id="' + escapeHtml(r.id) + '">Edit</button>');
      // Leases → Revoke (forgets the current lease, client can re-acquire);
      // reservations → Release (gives up the reservation).
      var freeLabel = isLease ? "Revoke" : "Release";
      var freeTitle = isLease ? "Revoke Lease" : "Release Reservation";
      buttons.push('<button class="btn btn-error" data-act="free" data-id="' + escapeHtml(r.id) + '" title="' + freeTitle + '">' + freeLabel + '</button>');
    }
    if (r.subnetId) {
      buttons.push('<button class="btn btn-text" data-act="open-subnet" data-subnet="' + escapeHtml(r.subnetId) + '">Open network</button>');
    }

    var btnBar = buttons.length
      ? '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:12px;">' + buttons.join("") + '</div>'
      : '';

    var emptyHint = (detailRows.length === 0 && buttons.length === 0)
      ? '<div style="color:var(--md-on-surface-variant);font-size:13px;">No additional details.</div>'
      : '';

    return ''
      + '<div class="reservation-expand" style="background:var(--md-surface-container-low);padding:12px 16px 16px;border-radius:0 0 var(--shape-md) var(--shape-md);">'
      +   detailRows.join('')
      +   emptyHint
      +   btnBar
      + '</div>';
  }

  function detailRow(label, valueHtml) {
    return ''
      + '<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:13px;">'
      + '  <span style="color:var(--md-on-surface-variant);flex-shrink:0;">' + escapeHtml(label) + '</span>'
      + '  <span style="text-align:right;word-break:break-word;">' + valueHtml + '</span>'
      + '</div>';
  }

  function wireRowHandlers() {
    var host = document.getElementById("reservations-host");
    if (!host) return;

    // Action buttons inside an expanded panel — bound first so the
    // row-collapse handler doesn't swallow them via stopPropagation.
    host.querySelectorAll(".reservation-expand button[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var act = btn.dataset.act;
        var id = btn.dataset.id;
        var row = _state.rows.find(function (r) { return r.id === id; });
        if (act === "edit"          && row) openEditSheet(row);
        if (act === "free"          && row) confirmFree(row);
        if (act === "reserve"       && row) startReserveFromLease(row);
        if (act === "open-subnet")          PolarisRouter.go("subnet/" + btn.dataset.subnet);
      });
    });

    // Row click → toggle expansion.
    host.querySelectorAll(".list-item[data-id]").forEach(function (row) {
      row.addEventListener("click", function () {
        var id = row.dataset.id;
        _state.expandedId = (_state.expandedId === id) ? null : id;
        renderList();
      });
    });
  }

  // ─── Reserve-from-lease ────────────────────────────────────────────────
  function startReserveFromLease(row) {
    if (!row.subnetId) {
      PolarisTabs.showSnackbar("Lease has no subnet — can't promote.", { error: true });
      return;
    }
    window.PolarisReserveSheet.open(row.subnetId, _state.user, {
      ip: row.ipAddress,
      mac: row.macAddress,
      hostname: row.hostname,
      notes: row.notes,
    }, {
      existingLeaseId: row.id,
      onSuccess: function () {
        _state.expandedId = null;
        load();
      },
    });
  }

  // ─── Free (release) ────────────────────────────────────────────────────
  function confirmFree(row) {
    var label = row.ipAddress || row.hostname || "this reservation";
    if (!window.confirm("Release " + label + "?")) return;
    api.reservations.release(row.id).then(function () {
      PolarisTabs.showSnackbar("Released " + label);
      _state.expandedId = null;
      load();
    }).catch(function (err) {
      PolarisTabs.showSnackbar(err && err.message ? err.message : "Release failed", { error: true });
    });
  }

  // ─── Edit sheet ────────────────────────────────────────────────────────
  // Inline edit modal. Fields: hostname, owner, MAC, notes, expires.
  // PUT /reservations/:id. Pulls subnet shell first so we know push
  // eligibility — on push-eligible subnets, clearing the MAC is rejected
  // server-side (DHCP reservations are MAC→IP); the UI hides the clear
  // hint and labels MAC as required.
  function openEditSheet(row) {
    closeEditSheet();
    if (!row.subnetId) {
      PolarisTabs.showSnackbar("Reservation has no subnet — can't edit.", { error: true });
      return;
    }
    api.subnets.ips(row.subnetId, { page: 1, pageSize: 1 }).then(function (resp) {
      var subnet = resp && resp.subnet;
      renderEditSheet(row, subnet);
    }).catch(function (err) {
      PolarisTabs.showSnackbar(err && err.message ? err.message : "Could not load network", { error: true });
    });
  }

  function renderEditSheet(row, subnet) {
    var pushEligible = !!(subnet && subnet.pushEligible);
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "edit-rsv-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "edit-rsv-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '  <h3 class="sheet-title" style="margin:0;">Edit reservation</h3>'
      + '  <button class="icon-btn" id="edit-rsv-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div style="color:var(--md-on-surface-variant);font-size:13px;margin-bottom:12px;"><span class="mono">' + escapeHtml(row.ipAddress || "") + '</span>'
      +   (subnet && subnet.cidr ? ' · in <span class="mono">' + escapeHtml(subnet.cidr) + '</span>' : '')
      + '</div>'
      + '<div id="edit-rsv-error" class="hidden" style="background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'
      + '<form id="edit-rsv-form" autocomplete="off">'
      + '  <div class="tf-outlined"><span class="lbl">Hostname</span>'
      + '    <input class="field" id="e-hostname" maxlength="100" value="' + escapeHtml(row.hostname || "") + '">'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Owner</span>'
      + '    <input class="field" id="e-owner" maxlength="100" value="' + escapeHtml(row.owner || "") + '">'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">MAC address' + (pushEligible ? ' *' : '') + '</span>'
      + '    <input class="field mono" id="e-mac" placeholder="aa:bb:cc:dd:ee:ff" value="' + escapeHtml(row.macAddress || "") + '"' + (pushEligible ? ' required' : '') + '>'
      +     (pushEligible
              ? '    <div class="support">Pushed to ' + escapeHtml((subnet && subnet.fortigateDevice) || "FortiGate") + '. Clearing the MAC is not allowed — release the reservation instead.</div>'
              : '')
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Notes</span>'
      + '    <input class="field" id="e-notes" maxlength="500" value="' + escapeHtml(row.notes || "") + '">'
      +     (pushEligible ? '    <div class="support">Saved to the FortiGate reservation comment.</div>' : '')
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Expires (YYYY-MM-DD)</span>'
      + '    <input class="field mono" id="e-expires" placeholder="" value="' + escapeHtml(formatDate(row.expiresAt) || "") + '">'
      + '  </div>'
      + '  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">'
      + '    <button type="button" class="btn btn-text" id="edit-rsv-cancel">Cancel</button>'
      + '    <button type="submit" class="btn btn-filled" id="edit-rsv-submit">Save</button>'
      + '  </div>'
      + '</form>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeEditSheet);
    document.getElementById("edit-rsv-close").addEventListener("click", closeEditSheet);
    document.getElementById("edit-rsv-cancel").addEventListener("click", closeEditSheet);
    document.getElementById("edit-rsv-form").addEventListener("submit", function (e) {
      e.preventDefault();
      submitEdit(row, pushEligible);
    });
  }

  function submitEdit(row, pushEligible) {
    clearEditError();
    var hostname = (document.getElementById("e-hostname").value || "").trim();
    var owner    = (document.getElementById("e-owner").value || "").trim();
    var mac      = (document.getElementById("e-mac").value || "").trim();
    var notes    = (document.getElementById("e-notes").value || "").trim();
    var expires  = (document.getElementById("e-expires").value || "").trim();

    if (pushEligible && !mac) { showEditError("MAC is required on DHCP-push networks"); return; }

    // Send empty strings (not undefined) so the server clears the field
    // — the backend treats "" as a deliberate clear on hostname/owner/
    // notes/projectRef. MAC is only sent when it changed AND is non-empty
    // on push-eligible subnets (clearing is rejected server-side anyway).
    var body = {
      hostname: hostname,
      owner: owner,
      notes: notes,
      expiresAt: expires || null,
    };
    if (!pushEligible || mac) body.macAddress = mac;

    var btn = document.getElementById("edit-rsv-submit");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>';

    api.reservations.update(row.id, body).then(function () {
      closeEditSheet();
      PolarisTabs.showSnackbar("Saved");
      load();
    }).catch(function (err) {
      btn.disabled = false;
      btn.innerHTML = "Save";
      showEditError(err && err.message ? err.message : "Update failed");
    });
  }

  function closeEditSheet() {
    var s = document.getElementById("edit-rsv-sheet");
    var sc = document.getElementById("edit-rsv-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }
  function showEditError(msg) {
    var el = document.getElementById("edit-rsv-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function clearEditError() {
    var el = document.getElementById("edit-rsv-error");
    if (el) el.classList.add("hidden");
  }

  // ─── Helpers ───────────────────────────────────────────────────────────
  function formatDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  window.PolarisReservationsTab = { spec: Reservations };
})();
