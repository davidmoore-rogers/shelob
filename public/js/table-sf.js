/**
 * public/js/table-sf.js — Per-column sort + inline filter for data tables
 *
 * Usage:
 *   var sf = new TableSF("tbody-id", onChange);
 *   var processed = sf.apply(rawData);
 *
 * Mark sortable/filterable columns with data-sf-key and data-sf-type attributes:
 *   <th data-sf-key="name" data-sf-type="string">Name</th>
 *
 * Supported types: string (default), number, date, ip, array
 * Nested keys work:  data-sf-key="block.name"  or  data-sf-key="_count.subnets"
 */
function TableSF(tbodyId, onChange) {
  var tbody = document.getElementById(tbodyId);
  this._thead = tbody ? tbody.closest("table").querySelector("thead") : null;
  this._onChange = onChange;
  this._sortKey = null;
  this._sortDir = "asc";
  this._filters = {};
  if (this._thead) this._setup();
}

TableSF.prototype._setup = function () {
  var self = this;
  this._thead.querySelectorAll("th[data-sf-key]").forEach(function (th) {
    var key   = th.getAttribute("data-sf-key");
    var label = th.textContent.trim();

    th.classList.add("sf-th");
    th.innerHTML =
      '<div class="sf-header">' +
        '<span class="sf-label">' + escapeHtml(label) + '</span>' +
        '<span class="sf-sort-icon">⇅</span>' +
      '</div>' +
      '<input class="sf-filter" type="text" placeholder="filter…"' +
        ' title="Type to filter. Prefix with ! to exclude rows (e.g. !foo).">';

    th.querySelector(".sf-header").addEventListener("click", function () {
      if (self._sortKey === key) {
        self._sortDir = self._sortDir === "asc" ? "desc" : "asc";
      } else {
        self._sortKey = key;
        self._sortDir = "asc";
      }
      self._updateIcons();
      self._onChange();
    });

    var inp = th.querySelector(".sf-filter");
    inp.addEventListener("click", function (e) { e.stopPropagation(); });
    inp.addEventListener("input", debounce(function () {
      var v = inp.value.trim();
      if (v && v !== "!") self._filters[key] = v;
      else                delete self._filters[key];
      self._onChange();
    }, 200));
  });
};

TableSF.prototype._updateIcons = function () {
  var self = this;
  this._thead.querySelectorAll("th[data-sf-key]").forEach(function (th) {
    var icon = th.querySelector(".sf-sort-icon");
    if (!icon) return;
    var active = th.getAttribute("data-sf-key") === self._sortKey;
    icon.textContent = active ? (self._sortDir === "asc" ? "▲" : "▼") : "⇅";
    icon.classList.toggle("sf-sort-active", active);
  });
};

TableSF.prototype._val = function (row, key) {
  var v = row;
  key.split(".").forEach(function (p) { v = v != null ? v[p] : null; });
  if (Array.isArray(v)) return v.join(" ");
  return v == null ? "" : v;
};

TableSF.prototype._ipNum = function (ip) {
  var p = String(ip || "").split(".");
  if (p.length !== 4) return 0;
  return p.reduce(function (n, o) { return n * 256 + (parseInt(o, 10) || 0); }, 0);
};

TableSF.prototype.apply = function (data) {
  var self = this;
  var result = data;

  var fKeys = Object.keys(self._filters);
  if (fKeys.length) {
    result = result.filter(function (row) {
      return fKeys.every(function (k) {
        var raw     = self._filters[k];
        var exclude = raw.charAt(0) === "!";
        var q       = (exclude ? raw.slice(1) : raw).toLowerCase();
        if (!q) return true;
        var match = String(self._val(row, k)).toLowerCase().includes(q);
        return exclude ? !match : match;
      });
    });
  }

  if (self._sortKey) {
    var k    = self._sortKey;
    var thEl = self._thead.querySelector('th[data-sf-key="' + k + '"]');
    var type = thEl ? (thEl.getAttribute("data-sf-type") || "string") : "string";
    var dir  = self._sortDir === "asc" ? 1 : -1;
    result = result.slice().sort(function (a, b) {
      var av = self._val(a, k), bv = self._val(b, k);
      if (type === "number") return (parseFloat(av) - parseFloat(bv)) * dir;
      if (type === "date")   return (new Date(av)   - new Date(bv))   * dir;
      if (type === "ip")     return (self._ipNum(av) - self._ipNum(bv)) * dir;
      var as = String(av).toLowerCase(), bs = String(bv).toLowerCase();
      return (as < bs ? -1 : as > bs ? 1 : 0) * dir;
    });
  }

  return result;
};
