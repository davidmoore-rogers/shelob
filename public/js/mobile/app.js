// public/js/mobile/app.js — Mobile app orchestrator.
//
// On boot, calls /auth/me. If unauthenticated, hands over to PolarisAuth.
// If authenticated, renders the tab shell and dispatches to the tab matching
// the current hash route.
//
// All state-changing requests funnel through window.api (loaded from the
// shared /js/api.js). The 401 hook below redirects to the in-app login
// rather than /login.html, so session expiry pops a familiar screen.

// Apply persisted theme BEFORE the IIFE below runs, so the first paint
// uses the right surface color (no dark-flash on a light-mode user's
// reload). Same `polaris-theme` localStorage key the desktop uses, so a
// preference set on either surface flows to the other.
(function () {
  var saved = "dark";
  try { saved = localStorage.getItem("polaris-theme") || "dark"; } catch (e) {}
  document.documentElement.setAttribute("data-theme", saved);
})();

// Tiny shared get/set so map-tab and more-tab can flip theme without
// duplicating the localStorage key.
window.PolarisTheme = {
  get: function () { return document.documentElement.getAttribute("data-theme") || "dark"; },
  set: function (theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("polaris-theme", theme); } catch (e) {}
  },
};

(function () {
  var app = document.getElementById("app");
  var currentUser = null;

  // Hook the shared api.js 401 handler so it routes back to our in-app
  // login screen instead of /login.html.
  window.__polarisOn401 = function () {
    currentUser = null;
    PolarisAuth.renderLogin(app);
  };

  // Best-effort portrait lock. Honored on Android Chrome / Firefox; iOS
  // Safari outside an installed PWA silently rejects, which is fine —
  // mobile.css carries a landscape lockout overlay as the universal
  // fallback for that case. Wrapped in try/catch because the API throws
  // synchronously on some platforms when called outside fullscreen.
  try {
    if (screen && screen.orientation && typeof screen.orientation.lock === "function") {
      screen.orientation.lock("portrait").catch(function () { /* unsupported — fall through to CSS overlay */ });
    }
  } catch (e) { /* silent — same path as a quiet rejection */ }

  // ─── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    app.dataset.tab = "";
    app.innerHTML = '<div class="loading-screen"><div class="spinner"></div></div>';

    var user = null;
    try {
      var res = await fetch("/api/v1/auth/me");
      if (res.ok) {
        var data = await res.json();
        // /auth/me returns { authenticated, username, role, authProvider } —
        // a flat object, not a nested user. Translate to the shape the rest
        // of the mobile bundle expects.
        if (data && data.authenticated) {
          user = {
            username:     data.username,
            role:         data.role,
            authProvider: data.authProvider,
            displayName:  data.username,
          };
        }
      }
    } catch (_) {}

    if (!user) {
      currentUser = null;
      PolarisAuth.renderLogin(app);
      return;
    }

    currentUser = user;
    // Make the current user available to api.js callers (avatar, role checks).
    window.__polarisUser = user;

    renderShell();
    PolarisRouter.onChange(routeChanged);
    if (!window.location.hash) PolarisRouter.go("search", { replace: true });
  }

  // ─── Shell ─────────────────────────────────────────────────────────────
  function renderShell() {
    app.innerHTML = ''
      + '<div id="topbar-slot"></div>'
      + '<main class="app-body" id="app-body"></main>'
      + buildNavbar();
    wireNavbar();
  }

  function buildNavbar() {
    var html = '<nav class="m3-navbar" id="navbar">';
    PolarisTabs.list.forEach(function (t) {
      html += ''
        + '<button class="nav-item" data-tab="' + t.id + '">'
        + '  <div class="nav-icon-pill">'
        + '    <svg viewBox="0 0 24 24"><use href="' + t.spec.icon + '"/></svg>'
        + '  </div>'
        + '  <div class="nav-label">' + t.spec.title + '</div>'
        + '</button>';
    });
    html += '</nav>';
    return html;
  }

  function wireNavbar() {
    var nav = document.getElementById("navbar");
    if (!nav) return;
    nav.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var tabId = btn.dataset.tab;
        PolarisRouter.go(tabId);
      });
    });
  }

  function setActiveTab(tabId) {
    app.dataset.tab = tabId || "";
    var nav = document.getElementById("navbar");
    if (!nav) return;
    nav.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.tab === tabId);
    });
  }

  // ─── Route handler ─────────────────────────────────────────────────────
  function routeChanged(route) {
    if (!currentUser) return;

    var topbar = document.getElementById("topbar-slot");
    var body = document.getElementById("app-body");
    if (!topbar || !body) {
      // Shell got torn down (login screen showing) — re-render and retry.
      renderShell();
      topbar = document.getElementById("topbar-slot");
      body = document.getElementById("app-body");
    }

    // Top-level tab?
    var tabSpec = PolarisTabs.byId(route.name);
    if (tabSpec) {
      setActiveTab(route.name);
      topbar.innerHTML = tabSpec.renderTopbar
        ? tabSpec.renderTopbar({ user: currentUser, route: route }) : '';
      tabSpec.render(body, { user: currentUser, route: route });
      body.scrollTop = 0;
      return;
    }

    // Detail route? (asset, subnet, block, site)
    var details = window.PolarisDetails || {};
    var detailSpec = details[route.name];
    if (detailSpec) {
      // Detail specs may declare a parentTab — when set, the corresponding
      // navbar item stays highlighted so the user understands which tab
      // they're conceptually inside. Without a parentTab the navbar is
      // visible but no item is active (e.g. block detail).
      var parentTab = detailSpec.parentTab || "";
      app.dataset.tab = parentTab || route.name;
      var nav = document.getElementById("navbar");
      if (nav) nav.querySelectorAll(".nav-item").forEach(function (b) {
        b.classList.toggle("active", parentTab !== "" && b.dataset.tab === parentTab);
      });

      topbar.innerHTML = detailSpec.renderTopbar
        ? detailSpec.renderTopbar({ user: currentUser, route: route }) : '';
      detailSpec.render(body, { user: currentUser, route: route });
      body.scrollTop = 0;
      return;
    }

    // Unknown route — bounce to search.
    PolarisRouter.go("search", { replace: true });
  }

  // ─── Public surface ────────────────────────────────────────────────────
  window.PolarisMobile = {
    boot: boot,
    user: function () { return currentUser; },
  };

  // Kick off on DOM ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
