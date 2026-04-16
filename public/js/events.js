/**
 * public/js/events.js — Events page logic
 */

(function () {
  var pageSize = 15;
  var currentOffset = 0;
  var currentTotal = 0;

  async function loadEvents() {
    var level = document.getElementById("filter-level").value;
    var resourceType = document.getElementById("filter-resource").value;
    var action = document.getElementById("filter-action").value.trim();

    try {
      var data = await api.events.list({
        limit: pageSize,
        offset: currentOffset,
        level: level || undefined,
        resourceType: resourceType || undefined,
        action: action || undefined,
      });

      var events = data.events || [];
      currentTotal = data.total || 0;
      renderTable(events);
      renderPagination();
    } catch (err) {
      document.getElementById("events-tbody").innerHTML =
        '<tr><td colspan="6" class="empty-state">Failed to load events</td></tr>';
    }
  }

  function renderTable(events) {
    var tbody = document.getElementById("events-tbody");
    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No events found</td></tr>';
      return;
    }

    tbody.innerHTML = events.map(function (ev) {
      var ts = new Date(ev.timestamp);
      var timeStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
        " " + ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      var levelClass = "badge-level-" + (ev.level || "info");
      var levelLabel = (ev.level || "info").toUpperCase();

      var resourceLabel = ev.resourceType || "-";
      var resourceName = ev.resourceName ? ' <span style="color:var(--color-text-tertiary);font-size:0.8rem">(' + escapeHtml(ev.resourceName) + ')</span>' : "";

      return '<tr>' +
        '<td style="font-family:var(--font-mono);font-size:0.82rem;white-space:nowrap">' + escapeHtml(timeStr) + '</td>' +
        '<td><span class="badge ' + levelClass + '">' + levelLabel + '</span></td>' +
        '<td style="font-family:var(--font-mono);font-size:0.82rem">' + escapeHtml(ev.action || "") + '</td>' +
        '<td>' + escapeHtml(resourceLabel) + resourceName + '</td>' +
        '<td>' + escapeHtml(ev.message || "") + '</td>' +
        '<td>' + escapeHtml(ev.actor || "-") + '</td>' +
        '</tr>';
    }).join("");
  }

  function renderPagination() {
    var container = document.getElementById("pagination");
    var totalPages = Math.max(1, Math.ceil(currentTotal / pageSize));
    var currentPage = Math.floor(currentOffset / pageSize) + 1;

    // Build page number buttons
    var pageButtons = "";
    var startPage = Math.max(1, currentPage - 2);
    var endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

    if (startPage > 1) {
      pageButtons += '<button class="btn btn-secondary btn-sm page-btn" data-page="1">1</button>';
      if (startPage > 2) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
    }

    for (var p = startPage; p <= endPage; p++) {
      if (p === currentPage) {
        pageButtons += '<button class="btn btn-primary btn-sm page-btn" data-page="' + p + '" disabled>' + p + '</button>';
      } else {
        pageButtons += '<button class="btn btn-secondary btn-sm page-btn" data-page="' + p + '">' + p + '</button>';
      }
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
      pageButtons += '<button class="btn btn-secondary btn-sm page-btn" data-page="' + totalPages + '">' + totalPages + '</button>';
    }

    container.innerHTML =
      '<button class="btn btn-secondary btn-sm" id="page-prev" ' + (currentPage <= 1 ? 'disabled' : '') + '>&laquo; Prev</button>' +
      pageButtons +
      '<button class="btn btn-secondary btn-sm" id="page-next" ' + (currentPage >= totalPages ? 'disabled' : '') + '>Next &raquo;</button>' +
      '<span style="font-size:0.82rem;color:var(--color-text-tertiary);margin-left:8px">' + currentTotal + ' events</span>';

    document.getElementById("page-prev").addEventListener("click", function () {
      if (currentOffset >= pageSize) {
        currentOffset -= pageSize;
        loadEvents();
      }
    });
    document.getElementById("page-next").addEventListener("click", function () {
      if (currentOffset + pageSize < currentTotal) {
        currentOffset += pageSize;
        loadEvents();
      }
    });
    container.querySelectorAll(".page-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var page = parseInt(btn.getAttribute("data-page"), 10);
        currentOffset = (page - 1) * pageSize;
        loadEvents();
      });
    });
  }

  // Filters
  document.getElementById("filter-level").addEventListener("change", function () { currentOffset = 0; loadEvents(); });
  document.getElementById("filter-resource").addEventListener("change", function () { currentOffset = 0; loadEvents(); });
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    pageSize = parseInt(this.value, 10) || 15;
    currentOffset = 0;
    loadEvents();
  });

  var actionTimer;
  document.getElementById("filter-action").addEventListener("input", function () {
    clearTimeout(actionTimer);
    actionTimer = setTimeout(function () { currentOffset = 0; loadEvents(); }, 400);
  });

  document.getElementById("btn-refresh").addEventListener("click", function () { loadEvents(); });

  // Initial load
  loadEvents();
})();
