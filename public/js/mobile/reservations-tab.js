// public/js/mobile/reservations-tab.js — Reservations tab.
//
// Lists active reservations. Tap a row -> jump to the parent subnet
// (where the actual reserve/release controls live; this surface stays
// read-only to match the rest of the mobile shell).

(function () {
  var LIST_LIMIT = 200;

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
    render: function (body) {
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
      // listReservations returns { reservations, total, limit, offset }
      var rs = (resp && resp.reservations) || [];
      if (rs.length === 0) {
        host.innerHTML = ""
          + '<div class="empty-state" style="padding-top:48px;">'
          + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-bookmark"/></svg></div>'
          + '  <div class="ttl">No reservations</div>'
          + '  <div class="desc">No active reservations on file.</div>'
          + '</div>';
        return;
      }

      var total = (resp && resp.total) || rs.length;
      var html = ""
        + '<div class="section-head">Active<span class="count">'
        + escapeHtml(String(rs.length))
        + (total > rs.length ? " of " + escapeHtml(String(total)) : "")
        + '</span></div>';

      rs.forEach(function (r, i) {
        var headline = r.hostname || r.ipAddress || "reservation";
        var ipBit = r.ipAddress ? '<span class="mono">' + escapeHtml(r.ipAddress) + '</span>' : "";
        var subnetBit = "";
        if (r.subnet) {
          if (r.subnet.name) subnetBit = escapeHtml(r.subnet.name);
          else if (r.subnet.cidr) subnetBit = '<span class="mono">' + escapeHtml(r.subnet.cidr) + '</span>';
        }
        var ownerBit = r.owner ? escapeHtml(r.owner) : "";
        var sourceBit = r.sourceType && r.sourceType !== "manual" ? escapeHtml(r.sourceType.replace(/_/g, " ")) : "";
        var subtitle = [ipBit, subnetBit, ownerBit, sourceBit].filter(Boolean).join(" · ");

        html += ""
          + '<button class="list-item two-line" data-subnet="' + escapeHtml(r.subnetId || "") + '">'
          + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-bookmark"/></svg></span>'
          + '  <div class="content">'
          + '    <div class="headline">' + escapeHtml(headline) + '</div>'
          + '    <div class="supporting">' + subtitle + '</div>'
          + '  </div>'
          + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
          + '</button>'
          + (i < rs.length - 1 ? '<div class="list-divider"></div>' : "");
      });
      host.innerHTML = html;

      host.querySelectorAll(".list-item").forEach(function (row) {
        row.addEventListener("click", function () {
          var subnet = row.dataset.subnet;
          if (subnet) PolarisRouter.go("subnet/" + subnet);
          else PolarisTabs.showSnackbar("This reservation isn’t tied to a network.");
        });
      });
    }).catch(function (err) {
      host.innerHTML = ""
        + '<div class="empty-state" style="padding-top:48px;">'
        + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
        + '  <div class="ttl">Couldn’t load</div>'
        + '  <div class="desc">' + escapeHtml(err && err.message ? err.message : "error") + '</div>'
        + '</div>';
    });
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  window.PolarisReservationsTab = { spec: Reservations };
})();
