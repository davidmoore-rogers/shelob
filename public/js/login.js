// public/js/login.js — Login page logic (extracted from login.html inline
// script so we can drop 'unsafe-inline' from the script CSP).

// Show any error from query string (e.g. SSO errors)
(function () {
  var params = new URLSearchParams(window.location.search);
  var err = params.get("error");
  if (err) {
    var errEl = document.getElementById("login-error");
    errEl.textContent = decodeURIComponent(err);
    errEl.style.display = "block";
  }
})();

// Apply branding
(async function () {
  var h2 = document.querySelector(".login-card h2");
  var subEl = document.querySelector(".login-card .subtitle");
  var logo = document.querySelector(".login-logo");
  try {
    var res = await fetch("/api/v1/server-settings/branding");
    if (res.ok) {
      var b = await res.json();
      h2.textContent = b.appName || "Shelob";
      document.title = (b.appName || "Shelob") + " — Login";
      subEl.textContent = b.subtitle || "";
      subEl.style.display = b.subtitle ? "" : "none";
      if (b.logoUrl) {
        logo.src = b.logoUrl;
        var fav = document.querySelector('link[rel="icon"]');
        if (fav) fav.href = b.logoUrl;
      }
    }
  } catch (_) {}
  h2.style.visibility = "";
  subEl.style.visibility = "";
  logo.style.visibility = "";
})();

// Check SSO config and show button if enabled
(async function () {
  try {
    var res = await fetch("/api/v1/auth/azure/config");
    if (!res.ok) return;
    var cfg = await res.json();
    if (!cfg.enabled) return;

    var btn = document.getElementById("btn-sso");
    if (cfg.brand === "microsoft") {
      btn.innerHTML = '<svg viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg> Sign in with Microsoft';
    } else if (cfg.brand === "google") {
      btn.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/></svg> Sign in with Google';
    } else if (cfg.brand === "okta") {
      btn.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px"><path fill="#007DC1" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5z"/></svg> Sign in with Okta';
    }

    document.getElementById("sso-section").style.display = "block";
  } catch (_) {}
})();

// SSO button click
document.getElementById("btn-sso").addEventListener("click", function () {
  window.location.href = "/api/v1/auth/azure/login";
});

// Show "View Setup Wizard" in demo mode
(async function () {
  try {
    var res = await fetch("/api/setup/status");
    if (!res.ok) return;
    var data = await res.json();
    // Demo server returns needsSetup: false — if we got a response, setup endpoint exists
    if (data.needsSetup === false) {
      document.getElementById("demo-setup-section").style.display = "block";
    }
  } catch (_) {}
})();
document.getElementById("btn-demo-setup").addEventListener("click", function () {
  window.location.href = "/setup.html";
});

document.getElementById("login-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  var errEl = document.getElementById("login-error");
  errEl.style.display = "none";

  var username = document.getElementById("username").value.trim();
  var password = document.getElementById("password").value;

  try {
    var res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password }),
    });
    var data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || "Login failed";
      errEl.style.display = "block";
      return;
    }
    window.location.href = "/";
  } catch (err) {
    errEl.textContent = "Network error — try again";
    errEl.style.display = "block";
  }
});
