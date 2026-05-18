/**
 * public/js/widgets/index.js — Dashboard widget registry + small shared helpers.
 *
 * Each widget module self-registers via PolarisWidgets.register({...}). The
 * dashboard orchestrator (public/js/dashboard.js) reads getAll() for the
 * library catalog and getByType(type) for instance rendering on the canvas.
 *
 * Widget module shape:
 *   {
 *     type:            string                              // stable id, used in saved layouts
 *     label:           string                              // display name
 *     description:     string                              // 1-line library blurb
 *     defaultSize:     { width, height }                   // grid cells (width ∈ 3|4|6|12, height ∈ 1|2)
 *     minSize?:        { width, height }                   // optional resize floor
 *     requiredPermission?: { key, level }                  // gates library visibility AND instance render
 *     fetchData?:      (config, summary) => Promise<any>   // optional — most widgets read pre-fetched summary
 *     renderInstance:  (el, config, data, ctx)             // full render
 *     renderPreview:   (el, ctx)                           // mock-data mini for library
 *     renderConfig?:   (el, config, onChange)              // gear popover
 *     defaultConfig?:  object                              // seed config on add
 *     onMount?:        (el, ctx)                           // optional post-mount hook (timers etc.)
 *     onUnmount?:      (el, ctx)                           // cleanup hook
 *   }
 */

(function () {
  var registry = [];

  window.PolarisWidgets = {
    register: function (widget) {
      // Defensive: replace if same type re-registered (hot reload, dup includes).
      registry = registry.filter(function (w) { return w.type !== widget.type; });
      registry.push(widget);
    },
    getAll: function () { return registry.slice(); },
    getByType: function (type) {
      for (var i = 0; i < registry.length; i++) if (registry[i].type === type) return registry[i];
      return null;
    },
    // Filter to widgets the current user is allowed to see. Uses the
    // permAtLeast() helper exposed by app.js.
    getAllowed: function () {
      return registry.filter(function (w) {
        if (!w.requiredPermission) return true;
        if (typeof permAtLeast !== "function") return true;
        return permAtLeast(w.requiredPermission.key, w.requiredPermission.level || "read");
      });
    },
  };

  // RFC4122 v4 (good-enough; not crypto). Used for widget instance ids.
  window.PolarisWidgets.uuid = function () {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };

  // Shared label/color maps for asset types (used by Monitor Alerts + Assets by Type).
  window.PolarisWidgets.ASSET_TYPE_LABELS = {
    server: "Server", switch: "Switch", router: "Router", firewall: "Firewall",
    workstation: "Workstation", printer: "Printer", access_point: "AP", other: "Other",
  };
  window.PolarisWidgets.ASSET_TYPE_COLORS = {
    server: "#4fc3f7", switch: "#26c6da", router: "#7e57c2", firewall: "#ef5350",
    workstation: "#66bb6a", printer: "#ffa726", access_point: "#ab47bc", other: "#90a4ae",
  };

  // "5m 03s" / "2h 17m" / "3d 4h" — same shape the legacy dashboard used.
  window.PolarisWidgets.durationSince = function (iso) {
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
  };
})();
