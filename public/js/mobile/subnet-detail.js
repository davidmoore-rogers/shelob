// public/js/mobile/subnet-detail.js — Subnet detail + Reserve sheet.
//
// Phase 8 deliverable. Two pieces:
//   1. Subnet detail screen (#subnet/<id>): info hero + paged IP list with
//      reservation status. Tapping a reserved row navigates to the linked
//      asset; tapping a free row opens the Reserve sheet pre-filled with
//      that IP.
//   2. Reserve sheet (modal): IP / hostname / MAC (required when
//      `pushEligible`) / notes + collapsible "more fields" for projectRef /
//      expiresAt. POST /reservations on submit. Notes flow into the FortiOS
//      reserved-address description on push-eligible subnets — operator typing
//      here shows up on the FortiGate's reservation comment field.
//
// Role gates: readonly users see the list but no Reserve FAB and tapping
// a free IP shows a snackbar instead of the sheet. user / assetsadmin /
// networkadmin / admin can reserve. The mobile UI doesn't expose
// ownership-edit guarding yet; release happens on desktop.

(function () {
  var IP_PAGE_SIZE = 256;

  // Per-subnet state cache so navigating back from a quick reserve doesn't
  // refetch the IP list.
  var _mounts = Object.create(null);
  function mountState(id) {
    if (!_mounts[id]) {
      _mounts[id] = { subnet: null, ips: [], page: 1, totalIps: 0, loading: false, ipv6: false };
    }
    return _mounts[id];
  }

  // Roles that can create reservations.
  var WRITE_ROLES = ["admin", "networkadmin", "assetsadmin", "user"];
  function canWrite(user) {
    return !!(user && user.role && WRITE_ROLES.indexOf(user.role) !== -1);
  }

  // ─── Top-level renderers ───────────────────────────────────────────────
  function renderTopbar(ctx) {
    return ''
      + '<div class="m3-topbar">'
      + '  <div class="leading">'
      + '    <button class="icon-btn" id="subnet-back-btn" aria-label="Back"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
      + '  </div>'
      + '  <div class="title" id="subnet-topbar-title">Network</div>'
      + '  <div class="trailing"></div>'
      + '</div>';
  }

  function render(body, ctx) {
    var id = (ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
    if (!id) {
      body.innerHTML = '<div class="empty-state" style="padding-top:64px;"><div class="ttl">Network id missing</div></div>';
      return;
    }
    var st = mountState(id);
    body.innerHTML = ''
      + '<div id="subnet-host"><div class="loading-screen"><div class="spinner"></div></div></div>'
      + (canWrite(ctx.user)
        ? '<button class="fab-ext" id="subnet-fab" style="position:fixed;right:16px;bottom:calc(var(--navbar-h) + 16px);z-index:30;display:none;"><svg viewBox="0 0 24 24"><use href="#i-add"/></svg>Reserve</button>'
        : '');

    var back = document.getElementById("subnet-back-btn");
    if (back) back.addEventListener("click", function () {
      if (window.history.length > 1) window.history.back();
      else PolarisRouter.go("more/subnets", { replace: true });
    });

    loadSubnet(id, st, ctx.user);
  }

  function loadSubnet(id, st, user) {
    api.subnets.ips(id, { page: 1, pageSize: IP_PAGE_SIZE }).then(function (resp) {
      st.subnet = resp.subnet;
      st.ips = resp.ips || [];
      st.page = resp.page || 1;
      st.totalIps = resp.totalIps || st.ips.length;
      st.ipv6 = !!resp.ipv6;
      var topbar = document.getElementById("subnet-topbar-title");
      if (topbar) topbar.textContent = st.subnet.name || st.subnet.cidr || "Network";

      renderShell(st, user);
      mountRefreshButton(id, st, user);

      var fab = document.getElementById("subnet-fab");
      if (fab) {
        fab.style.display = "";
        fab.addEventListener("click", function () { openReserveSheet(id, st, user, null); });
      }
    }).catch(function (err) {
      var host = document.getElementById("subnet-host");
      if (host) host.innerHTML = errorState(err && err.message ? err.message : "Failed to load network");
    });
  }


  // The refresh button lives in the topbar trailing slot. Only shown for
  // FortiGate-discovered subnets (`fortigateDevice` non-empty) AND callers
  // who can write — matches the backend's `requireUserOrAbove` guard on
  // POST /subnets/:id/refresh. Tap reconciles that single scope's CMDB
  // reservations + live leases against Polaris, then re-fetches the IP list
  // so the operator sees the result without leaving the page.
  function mountRefreshButton(id, st, user) {
    var topbar = document.querySelector("#subnet-topbar-title");
    if (!topbar) return;
    var trailing = topbar.parentElement && topbar.parentElement.querySelector(".trailing");
    if (!trailing) return;
    trailing.innerHTML = "";
    if (!st.subnet || !st.subnet.fortigateDevice || !canWrite(user)) return;

    var btn = document.createElement("button");
    btn.className = "icon-btn";
    btn.id = "subnet-refresh-btn";
    btn.setAttribute("aria-label", "Refresh from " + (st.subnet.fortigateDevice || "FortiGate"));
    btn.title = "Refresh from " + (st.subnet.fortigateDevice || "FortiGate");
    btn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg>';
    trailing.appendChild(btn);

    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add("spinning");
      api.subnets.refresh(id).then(function (r) {
        var parts = [];
        if (r.created)  parts.push(r.created + " created");
        if (r.updated)  parts.push(r.updated + " updated");
        if (r.released) parts.push(r.released + " released");
        if (r.skipped)  parts.push(r.skipped + " skipped");
        var summary = parts.length ? parts.join(", ") : "no changes";
        PolarisTabs.showSnackbar("Refreshed " + (st.subnet.fortigateDevice || "FortiGate") + " — " + summary);
        return api.subnets.ips(id, { page: 1, pageSize: IP_PAGE_SIZE }).then(function (resp) {
          st.subnet = resp.subnet;
          st.ips = resp.ips || [];
          st.totalIps = resp.totalIps || st.ips.length;
          renderShell(st, user);
          mountRefreshButton(id, st, user);
        });
      }).catch(function (err) {
        PolarisTabs.showSnackbar(err && err.message ? err.message : "Refresh failed", { error: true });
      }).finally(function () {
        btn.disabled = false;
        btn.classList.remove("spinning");
      });
    });
  }

  function errorState(msg) {
    return ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
      + '  <div class="ttl">Couldn’t load network</div>'
      + '  <div class="desc">' + escapeHtml(msg) + '</div>'
      + '</div>';
  }

  function renderShell(st, user) {
    var host = document.getElementById("subnet-host");
    if (!host) return;
    var s = st.subnet;
    var heroBits = [];
    heroBits.push('<span class="mono">' + escapeHtml(s.cidr) + '</span>');
    if (s.purpose) heroBits.push(escapeHtml(s.purpose));
    if (s.vlan) heroBits.push("VLAN " + s.vlan);
    if (s.fortigateDevice) heroBits.push(escapeHtml(s.fortigateDevice));

    var pushBadge = s.pushEligible
      ? '<span class="status-pill warn" style="margin-top:8px;display:inline-flex;"><svg viewBox="0 0 24 24" width="14" height="14" style="fill:currentColor;"><use href="#i-info"/></svg>DHCP-push network — MAC required</span>'
      : '';

    var reservedCount = st.ips.filter(function (i) { return i.reservation; }).length;
    var paged = st.ips.length < st.totalIps;

    host.innerHTML = ''
      + '<div class="asset-hero">'
      + '  <div class="hero-name">' + escapeHtml(s.name || s.cidr) + '</div>'
      + '  <div class="hero-sub">' + heroBits.join(" · ") + '</div>'
      + '  ' + pushBadge
      + '</div>'
      + '<div class="section-head">IPs<span class="count">' + reservedCount + ' reserved · ' + (st.totalIps + (paged ? "+" : "")) + ' total</span></div>'
      + '<div id="subnet-ip-list"></div>'
      + (paged ? '<div style="text-align:center;padding:12px 0 24px;color:var(--md-on-surface-variant);font-size:12px;">Showing first ' + st.ips.length + ' addresses — open network on desktop for full pagination.</div>' : '');

    renderIpList(st, user);
  }

  function renderIpList(st, user) {
    var host = document.getElementById("subnet-ip-list");
    if (!host) return;

    var html = "";
    st.ips.forEach(function (ip, idx) {
      var r = ip.reservation;
      var reserved = !!r;
      var iconHref = reserved ? "#i-bookmark" : "#i-add";
      var leadCls  = reserved ? "tonal" : "";
      var headlineMain = '<span class="mono">' + escapeHtml(ip.address) + '</span>';
      var sub = "";
      if (reserved) {
        var bits = [];
        if (r.hostname) bits.push(escapeHtml(r.hostname));
        if (r.owner) bits.push(escapeHtml(r.owner));
        if (r.macAddress) bits.push('<span class="mono">' + escapeHtml(r.macAddress) + '</span>');
        if (r.sourceType && r.sourceType !== "manual") bits.push(escapeHtml(r.sourceType.replace(/_/g, " ")));
        sub = bits.join(" · ");
      } else {
        sub = ip.type === "host" ? "Free" : escapeHtml(ip.type);
      }
      html += ''
        + '<button class="list-item' + (sub ? " two-line" : "") + '" data-ip="' + escapeHtml(ip.address) + '" data-reserved="' + (reserved ? "1" : "0") + '" data-asset="' + escapeHtml(ip.assetId || "") + '" data-type="' + escapeHtml(ip.type) + '">'
        + '  <span class="leading ' + leadCls + '"><svg viewBox="0 0 24 24"><use href="' + iconHref + '"/></svg></span>'
        + '  <div class="content">'
        + '    <div class="headline">' + headlineMain + '</div>'
        + (sub ? '    <div class="supporting">' + sub + '</div>' : '')
        + '  </div>'
        + '</button>'
        + (idx < st.ips.length - 1 ? '<div class="list-divider"></div>' : '');
    });
    host.innerHTML = html;

    host.querySelectorAll(".list-item").forEach(function (row) {
      row.addEventListener("click", function () {
        var ip = row.dataset.ip;
        var reserved = row.dataset.reserved === "1";
        var assetId = row.dataset.asset;
        var type = row.dataset.type;
        if (reserved) {
          if (assetId) PolarisRouter.go("asset/" + assetId);
          else PolarisTabs.showSnackbar(ip + " — reserved (no linked asset)");
          return;
        }
        if (type !== "host") {
          PolarisTabs.showSnackbar(ip + " — " + type + " address (not reservable)");
          return;
        }
        if (!canWrite(user)) {
          PolarisTabs.showSnackbar("Read-only role — reservations live on desktop.");
          return;
        }
        // Find subnetId from the route (the host element doesn't carry it)
        var subnetRoute = PolarisRouter.current();
        var subnetId = subnetRoute.parts[0];
        var st = mountState(subnetId);
        openReserveSheet(subnetId, st, user, ip);
      });
    });
  }

  // ─── Reserve sheet ─────────────────────────────────────────────────────
  // prefill: either a string (IP) for back-compat, or an object
  //   { ip?, mac?, hostname?, notes? }.
  // opts (optional):
  //   { existingLeaseId, onSuccess }
  //   existingLeaseId: when set, the lease reservation is released before
  //     the new manual reservation is created — this is the "promote DHCP
  //     lease to manual reservation (and push to gate)" flow invoked from
  //     the Reservations tab.
  //   onSuccess: callback fired after a successful create. When omitted,
  //     the subnet-detail page reloads its IP list (legacy behavior).
  function openReserveSheet(subnetId, st, user, prefill, opts) {
    closeReserveSheet();

    var s = st.subnet;
    var pushEligible = !!s.pushEligible;
    var pf = (prefill && typeof prefill === "object") ? prefill : { ip: prefill || "" };
    var defaultIp = pf.ip || pickNextFreeIp(st) || "";
    opts = opts || {};

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "reserve-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "reserve-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '  <h3 class="sheet-title" style="margin:0;">Reserve IP</h3>'
      + '  <button class="icon-btn" id="reserve-close-btn" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div id="reserve-error" class="hidden" style="background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'
      + '<form id="reserve-form" autocomplete="off">'
      + '  <div class="tf-outlined"><span class="lbl">IP address</span>'
      + '    <input class="field mono" id="r-ip" value="' + escapeHtml(defaultIp) + '" required>'
      + '    <div class="support">Inside ' + escapeHtml(s.cidr) + '</div>'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Hostname</span>'
      + '    <input class="field" id="r-hostname" maxlength="100" value="' + escapeHtml(pf.hostname || "") + '">'
      + '  </div>'
      + (pushEligible
        ? '  <div class="tf-outlined"><span class="lbl">MAC address *</span>'
          + '    <input class="field mono" id="r-mac" placeholder="aa:bb:cc:dd:ee:ff" required value="' + escapeHtml(pf.mac || "") + '">'
          + '    <div class="support" style="display:flex;justify-content:space-between;align-items:center;gap:8px;">'
          + '      <span>Will be pushed to ' + escapeHtml(s.fortigateDevice || "FortiGate") + ' as a DHCP reservation.</span>'
          + '      <button type="button" class="btn btn-text" id="r-mac-gen" title="Generate a locally-administered MAC (02:xx:xx:xx:xx:xx) — placeholder when the device’s real MAC isn’t known yet" style="font-size:13px;padding:4px 10px;flex-shrink:0;">Generate</button>'
          + '    </div>'
          + '  </div>'
        : '  <div class="tf-outlined"><span class="lbl">MAC address</span>'
          + '    <input class="field mono" id="r-mac" placeholder="optional" value="' + escapeHtml(pf.mac || "") + '">'
          + '    <div class="support" style="display:flex;justify-content:flex-end;">'
          + '      <button type="button" class="btn btn-text" id="r-mac-gen" title="Generate a locally-administered MAC (02:xx:xx:xx:xx:xx) — placeholder when the device’s real MAC isn’t known yet" style="font-size:13px;padding:4px 10px;">Generate</button>'
          + '    </div>'
          + '  </div>')
      + '  <div class="tf-outlined"><span class="lbl">Notes</span>'
      + '    <input class="field" id="r-notes" maxlength="500" placeholder="' + (pushEligible ? "Saved to the FortiGate reservation comment" : "") + '" value="' + escapeHtml(pf.notes || "") + '">'
      + (pushEligible ? '    <div class="support">Saved to the FortiGate reservation comment.</div>' : '')
      + '  </div>'
      + '  <details style="margin-bottom:16px;">'
      + '    <summary style="color:var(--md-primary);font-size:14px;font-weight:500;letter-spacing:.1px;cursor:pointer;padding:8px 0;">More fields</summary>'
      + '    <div class="tf-outlined" style="margin-top:12px;"><span class="lbl">Project / ticket</span>'
      + '      <input class="field" id="r-project" maxlength="120">'
      + '    </div>'
      + '    <div class="tf-outlined"><span class="lbl">Expires (YYYY-MM-DD)</span>'
      + '      <input class="field mono" id="r-expires" placeholder="">'
      + '    </div>'
      + '  </details>'
      + '  <div style="display:flex;justify-content:flex-end;gap:8px;">'
      + '    <button type="button" class="btn btn-text" id="reserve-cancel">Cancel</button>'
      + '    <button type="submit" class="btn btn-filled" id="reserve-submit">Reserve</button>'
      + '  </div>'
      + '</form>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeReserveSheet);
    document.getElementById("reserve-close-btn").addEventListener("click", closeReserveSheet);
    document.getElementById("reserve-cancel").addEventListener("click", closeReserveSheet);
    document.getElementById("reserve-form").addEventListener("submit", function (e) {
      e.preventDefault();
      onSubmit(subnetId, st, user, opts);
    });
    var genBtn = document.getElementById("r-mac-gen");
    var macInput = document.getElementById("r-mac");
    if (genBtn && macInput) {
      genBtn.addEventListener("click", function () {
        macInput.value = generateLocalMac();
        macInput.focus();
        try { macInput.select(); } catch (_) {}
      });
    }
  }

  // Generate a locally-administered unicast MAC for placeholder use when the
  // real client MAC isn't known yet (e.g. reserving an IP before the device
  // is racked). First octet fixed at 02 so the locally-administered bit is
  // set and the multicast bit is clear — same convention as desktop's
  // _generateLocalMac() in public/js/ip-panel.js.
  function generateLocalMac() {
    var bytes = ["02"];
    for (var i = 0; i < 5; i++) {
      var b = Math.floor(Math.random() * 256);
      bytes.push((b < 16 ? "0" : "") + b.toString(16));
    }
    return bytes.join(":").toUpperCase();
  }

  function closeReserveSheet() {
    var s = document.getElementById("reserve-sheet");
    var sc = document.getElementById("reserve-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

  function pickNextFreeIp(st) {
    for (var i = 0; i < st.ips.length; i++) {
      var ip = st.ips[i];
      if (ip.type === "host" && !ip.reservation) return ip.address;
    }
    return "";
  }

  function showReserveError(msg) {
    var el = document.getElementById("reserve-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function clearReserveError() {
    var el = document.getElementById("reserve-error");
    if (el) el.classList.add("hidden");
  }

  function onSubmit(subnetId, st, user, opts) {
    clearReserveError();
    opts = opts || {};
    var ip       = (document.getElementById("r-ip").value || "").trim();
    var hostname = (document.getElementById("r-hostname").value || "").trim();
    var mac      = (document.getElementById("r-mac") ? document.getElementById("r-mac").value || "" : "").trim();
    var notes    = (document.getElementById("r-notes") ? document.getElementById("r-notes").value || "" : "").trim();
    var project  = (document.getElementById("r-project") ? document.getElementById("r-project").value || "" : "").trim();
    var expires  = (document.getElementById("r-expires") ? document.getElementById("r-expires").value || "" : "").trim();

    if (!ip) { showReserveError("IP address is required"); return; }
    var body = { subnetId: subnetId, ipAddress: ip };
    if (hostname) body.hostname = hostname;
    if (mac) body.macAddress = mac;
    if (notes) body.notes = notes;
    if (project) body.projectRef = project;
    if (expires) body.expiresAt = expires;

    var btn = document.getElementById("reserve-submit");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>';

    // When promoting a DHCP lease, release the lease row first so the
    // new manual reservation doesn't collide with the
    // @@unique([subnetId, ipAddress, status]) constraint. If the create
    // fails after the lease is gone, the operator can retry — the IP is
    // free at that point.
    var pre = opts.existingLeaseId
      ? api.reservations.release(opts.existingLeaseId).catch(function () { /* tolerate already-gone */ })
      : Promise.resolve();

    pre.then(function () {
      return api.reservations.create(body);
    }).then(function () {
      closeReserveSheet();
      PolarisTabs.showSnackbar("Reserved " + ip);
      if (typeof opts.onSuccess === "function") opts.onSuccess();
      else reloadList(subnetId, st, user);
    }).catch(function (err) {
      btn.disabled = false;
      btn.innerHTML = "Reserve";
      showReserveError(err && err.message ? err.message : "Reservation failed");
    });
  }

  function reloadList(subnetId, st, user) {
    api.subnets.ips(subnetId, { page: 1, pageSize: IP_PAGE_SIZE }).then(function (resp) {
      st.ips = resp.ips || [];
      st.totalIps = resp.totalIps || st.ips.length;
      renderIpList(st, user);
    }).catch(function () { /* ignore */ });
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  window.PolarisSubnetDetail = {
    spec: {
      parentTab: null,
      renderTopbar: renderTopbar,
      render: render,
    },
  };

  // ─── Cross-tab reserve-sheet entry point ───────────────────────────────
  // Used by the Reservations tab to promote a DHCP lease into a Polaris-
  // pushed manual reservation without navigating to the subnet detail page.
  // Loads a minimal subnet shell (so we know pushEligible + fortigateDevice
  // for the form's required-MAC + comment-field hints) then opens the same
  // reserve sheet the subnet detail page uses.
  window.PolarisReserveSheet = {
    open: function (subnetId, user, prefill, opts) {
      if (!subnetId) return;
      api.subnets.ips(subnetId, { page: 1, pageSize: 1 }).then(function (resp) {
        var st = { subnet: resp.subnet, ips: resp.ips || [], page: 1, totalIps: resp.totalIps || 0, ipv6: !!resp.ipv6, loading: false };
        openReserveSheet(subnetId, st, user, prefill, opts);
      }).catch(function (err) {
        PolarisTabs.showSnackbar(err && err.message ? err.message : "Could not load network", { error: true });
      });
    },
  };
})();
