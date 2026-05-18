/**
 * widgets/recentEvents.js — recent audit-log rows filtered by severity.
 * Permission-gated on events:read.
 */

(function () {
  var LEVEL_PILL = { info: "widget-pill-watch", warning: "widget-pill-amber", error: "widget-pill-red" };

  function renderRows(el, rows, levels) {
    var allowed = new Set(levels);
    var filtered = rows.filter(function (r) { return allowed.has(r.level); });
    if (!filtered.length) { el.innerHTML = '<p class="empty-state">No matching events</p>'; return; }
    el.innerHTML = filtered.slice(0, 20).map(function (e) {
      var pillCls = LEVEL_PILL[e.level] || "widget-pill-watch";
      return '<div class="recent-item" style="cursor:default">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="recent-item-title"><span class="widget-pill ' + pillCls + '" style="margin-right:6px">' + escapeHtml(e.level) + '</span><span>' + escapeHtml(e.action || "") + '</span></div>' +
          '<div class="recent-item-meta">' + escapeHtml(e.message || "") + '</div>' +
        '</div>' +
        '<span class="recent-item-time">' + timeAgo(e.timestamp) + '</span>' +
      '</div>';
    }).join("");
  }

  PolarisWidgets.register({
    type: "recentEvents",
    label: "Recent events",
    description: "Audit-log feed filtered by severity (info / warning / error).",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { levels: ["warning", "error"] },
    requiredPermission: { key: "events", level: "read" },

    fetchData: function (config) {
      // No level filter on the API — pull 50 and filter client-side so the
      // widget can show "what's noisy lately" across multiple severity mixes
      // without changing the request.
      return api.events.list({ limit: 50 })
        .then(function (resp) { return (resp && Array.isArray(resp.events)) ? resp.events : (Array.isArray(resp) ? resp : []); })
        .catch(function () { return []; });
    },

    renderInstance: function (el, config, data) {
      var levels = (config && Array.isArray(config.levels) && config.levels.length) ? config.levels : ["warning", "error"];
      var rows = Array.isArray(data) ? data : (data && Array.isArray(data.events) ? data.events : []);
      renderRows(el, rows, levels);
    },

    renderPreview: function (el) {
      var now = new Date();
      renderRows(el, [
        { level: "warning", action: "monitor.status_changed", message: "fgt-branch-12 transitioned to down",      timestamp: new Date(now.getTime() - 4 * 60 * 1000).toISOString() },
        { level: "error",   action: "integration.discover.failed", message: "FortiManager DC discovery aborted", timestamp: new Date(now.getTime() - 18 * 60 * 1000).toISOString() },
        { level: "info",    action: "reservation.created",     message: "10.4.2.42 reserved by anna",            timestamp: new Date(now.getTime() - 32 * 60 * 1000).toISOString() },
      ], ["warning", "error", "info"]);
    },

    renderConfig: function (el, config, onChange) {
      var current = new Set((config && config.levels) || ["warning", "error"]);
      el.innerHTML =
        '<label>Show levels</label>' +
        ["info", "warning", "error"].map(function (lv) {
          var id = "rel_" + lv;
          return '<label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;margin:3px 0">' +
            '<input type="checkbox" id="' + id + '" data-lv="' + lv + '"' + (current.has(lv) ? " checked" : "") + '> ' + escapeHtml(lv) +
          '</label>';
        }).join("");
      el.querySelectorAll('input[data-lv]').forEach(function (cb) {
        cb.addEventListener("change", function () {
          if (cb.checked) current.add(cb.getAttribute("data-lv"));
          else current.delete(cb.getAttribute("data-lv"));
          onChange("levels", Array.from(current));
        });
      });
    },
  });
})();
