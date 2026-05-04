// public/js/mobile/tabs.js — Tab renderers.
//
// Each tab exposes `render(body, ctx)` where:
//   body — the .app-body element to populate
//   ctx  — { user, route } so handlers can act on the current user/route
//
// Phase 1 ships the navigation shell and placeholder bodies. Subsequent
// phases replace the placeholder bodies with real implementations.

(function () {
  function placeholder(title, message) {
    return ''
      + '<div class="empty-state">'
      + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-construction"/></svg></div>'
      + '  <div class="ttl">' + title + '</div>'
      + '  <div class="desc">' + message + '</div>'
      + '</div>';
  }

  // ─── Search ────────────────────────────────────────────────────────────
  var Search = {
    title: "Search",
    icon: "#i-search",
    renderTopbar: function (ctx) {
      var initials = (ctx.user && ctx.user.username || "?")
        .slice(0, 2).toUpperCase();
      return ''
        + '<div class="m3-searchbar" style="margin:8px 16px 0;">'
        + '  <button class="icon-btn" aria-label="Search"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></button>'
        + '  <input class="input" type="search" placeholder="Search IPs, assets, subnets…" disabled>'
        + '  <div class="avatar" id="topbar-avatar">' + initials + '</div>'
        + '</div>';
    },
    render: function (body) {
      body.innerHTML = placeholder(
        "Search coming soon",
        "Type-ahead across IPs, assets, subnets, blocks and Device Map sites — wires the existing /search endpoint."
      );
    },
  };

  // ─── Map ───────────────────────────────────────────────────────────────
  var Map = {
    title: "Device Map",
    icon: "#i-map",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Device Map</div>'
        + '  <div class="trailing"></div>'
        + '</div>';
    },
    render: function (body) {
      body.innerHTML = placeholder(
        "Device Map coming soon",
        "Leaflet basemap + clustered pins for every FortiGate site, color-coded by monitor health."
      );
    },
  };

  // ─── Assets ────────────────────────────────────────────────────────────
  var Assets = {
    title: "Assets",
    icon: "#i-list",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Assets</div>'
        + '  <div class="trailing">'
        + '    <button class="icon-btn" aria-label="Search"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body) {
      body.innerHTML = placeholder(
        "Assets coming soon",
        "Card feed of every asset, filter chips for type/status, tap-through to a System tab with charts."
      );
    },
  };

  // ─── Alerts ────────────────────────────────────────────────────────────
  var Alerts = {
    title: "Alerts",
    icon: "#i-bell",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Alerts</div>'
        + '  <div class="trailing">'
        + '    <button class="icon-btn" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body) {
      body.innerHTML = placeholder(
        "Alerts coming soon",
        "Down-now monitored assets at the top, recent warning/error events below — pulls /events at level≥warning."
      );
    },
  };

  // ─── More ──────────────────────────────────────────────────────────────
  var More = {
    title: "More",
    icon: "#i-more",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">More</div>'
        + '  <div class="trailing"></div>'
        + '</div>';
    },
    render: function (body, ctx) {
      var user = ctx.user || {};
      var role = user.role || "?";
      var displayName = user.displayName || user.username || "user";

      // Phase 1 stub: just the profile card and sign-out, so the auth flow
      // is exercisable end-to-end. Sub-pages come in Phase 7.
      body.innerHTML = ''
        + '<div class="section-head">Account</div>'
        + '<div class="list-item two-line">'
        + '  <span class="leading tertiary"><svg viewBox="0 0 24 24"><use href="#i-person"/></svg></span>'
        + '  <div class="content"><div class="headline">' + escapeHtml(displayName) + '</div><div class="supporting">' + escapeHtml(role) + '</div></div>'
        + '</div>'
        + '<div class="list-divider"></div>'
        + '<a class="list-item two-line" href="/index.html">'
        + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-desktop"/></svg></span>'
        + '  <div class="content"><div class="headline">Desktop view</div><div class="supporting">Open the full app</div></div>'
        + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
        + '</a>'
        + '<div class="list-divider"></div>'
        + '<button class="list-item" id="sign-out-btn">'
        + '  <span class="leading error"><svg viewBox="0 0 24 24"><use href="#i-logout"/></svg></span>'
        + '  <div class="content"><div class="headline" style="color:var(--md-error);">Sign out</div></div>'
        + '</button>'
        + '<div style="text-align:center;padding:32px 0 24px;color:var(--md-on-surface-variant);font-size:11px;letter-spacing:.5px;" id="version-line">Polaris</div>';

      document.getElementById("sign-out-btn").addEventListener("click", function () {
        fetch("/api/v1/auth/logout", { method: "POST", headers: csrfHeaders() })
          .finally(function () { window.PolarisMobile.boot(); });
      });

      // Pull version into the footer (best-effort).
      fetch("/api/v1/auth/me").then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
        if (!data || !data.version) return;
        var v = data.version;
        var tag = (typeof v === "string") ? v : (v.tag || (v.major + "." + v.minor + "." + v.patch));
        document.getElementById("version-line").textContent = "Polaris " + tag;
      }).catch(function () {});
    },
  };

  // ─── Tab registry ──────────────────────────────────────────────────────
  // Order here drives the navbar layout. Keep at five — that's the MD3 spec
  // limit and what fits comfortably on a phone width.
  var TABS = [
    { id: "search",  spec: Search },
    { id: "map",     spec: Map },
    { id: "assets",  spec: Assets },
    { id: "alerts",  spec: Alerts },
    { id: "more",    spec: More },
  ];

  // ─── helpers ───────────────────────────────────────────────────────────
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function csrfHeaders() {
    var headers = {};
    var m = document.cookie.match(/(?:^|; )polaris_csrf=([^;]+)/);
    if (m) headers["X-CSRF-Token"] = decodeURIComponent(m[1]);
    return headers;
  }

  window.PolarisTabs = {
    list: TABS,
    byId: function (id) {
      for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i].spec;
      return null;
    },
    escapeHtml: escapeHtml,
    placeholder: placeholder,
  };
})();
