/**
 * public/js/widget-library.js — Add-a-Widget slide-in panel.
 *
 * Reuses the .slideover-* CSS family already used by the IP panel; the
 * panel chrome is defined in index.html. This file owns the rendered
 * mini-previews + the drag source registration.
 *
 * Exposes window.WidgetLibrary with {open, close, isOpen} so the
 * dashboard orchestrator can wire the +Widget button.
 */

(function () {
  var overlayEl = null;
  var bodyEl = null;
  var closeBtn = null;
  var _onAddCallback = null; // tap-to-add fallback for small viewports

  function init() {
    if (overlayEl) return;
    overlayEl = document.getElementById("widget-library-overlay");
    bodyEl = document.getElementById("widget-library-body");
    closeBtn = document.getElementById("widget-library-close");
    if (!overlayEl || !bodyEl || !closeBtn) return;
    closeBtn.addEventListener("click", close);
    overlayEl.addEventListener("click", function (e) { if (e.target === overlayEl) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isOpen()) close(); });
  }

  function isOpen() {
    return overlayEl && overlayEl.classList.contains("open");
  }

  function open(onAdd) {
    init();
    if (!overlayEl) return;
    _onAddCallback = onAdd || null;
    renderCatalog();
    overlayEl.classList.add("open");
    overlayEl.setAttribute("aria-hidden", "false");
  }

  function close() {
    if (!overlayEl) return;
    overlayEl.classList.remove("open");
    overlayEl.setAttribute("aria-hidden", "true");
    _onAddCallback = null;
  }

  function renderCatalog() {
    if (!bodyEl) return;
    var widgets = PolarisWidgets.getAllowed();
    if (!widgets.length) {
      bodyEl.innerHTML = '<p class="empty-state" style="margin-top:32px">No widgets available for your role.</p>';
      return;
    }
    bodyEl.innerHTML = widgets.map(function (w) {
      return '<div class="widget-library-card" data-type="' + escapeHtml(w.type) + '" draggable="true" tabindex="0" role="button">' +
        '<div class="widget-library-card-info">' +
          '<div class="widget-library-card-title">' + escapeHtml(w.label) + '</div>' +
          '<div class="widget-library-card-desc">' + escapeHtml(w.description || "") + '</div>' +
          '<div class="widget-library-card-tag">Drag onto dashboard · Default ' + w.defaultSize.width + '×' + w.defaultSize.height + '</div>' +
        '</div>' +
        '<div class="widget-library-preview" data-preview-for="' + escapeHtml(w.type) + '"></div>' +
      '</div>';
    }).join("");

    // Render the mini-previews + wire drag sources.
    widgets.forEach(function (w) {
      var previewEl = bodyEl.querySelector('[data-preview-for="' + w.type + '"]');
      if (previewEl) {
        try { w.renderPreview(previewEl); } catch (_err) { /* preview is best-effort */ }
      }
    });

    bodyEl.querySelectorAll(".widget-library-card").forEach(function (card) {
      card.addEventListener("dragstart", function (e) {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/x-polaris-widget", card.getAttribute("data-type"));
        // Plain text fallback for browsers that won't read our custom type.
        e.dataTransfer.setData("text/plain", card.getAttribute("data-type"));
      });
      // Tap-to-add fallback: clicking outside the drag area calls the
      // orchestrator's add callback so phones / tablets can still place
      // widgets. Closes the slide-in after one add (operator gets immediate
      // visual feedback that the widget landed).
      card.addEventListener("click", function () {
        if (typeof _onAddCallback === "function") {
          _onAddCallback(card.getAttribute("data-type"));
          close();
        }
      });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (typeof _onAddCallback === "function") {
            _onAddCallback(card.getAttribute("data-type"));
            close();
          }
        }
      });
    });
  }

  window.WidgetLibrary = { open: open, close: close, isOpen: isOpen };
})();
