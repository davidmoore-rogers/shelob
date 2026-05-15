// Loaded by the tiny stub HTML served from /blocks.html and /subnets.html
// (see legacyIpamRedirect in src/app.ts). Forwards the request to
// /ipam.html with the legacy hash fragment preserved. External file so it
// survives the strict CSP scriptSrc: 'self' that blocks inline scripts.
(function () {
  var tab = window.location.pathname === "/blocks.html" ? "blocks" : "networks";
  var h = (window.location.hash || "").replace(/^#/, "");
  var prefix = "tab=" + tab;
  var target = "/ipam.html#" + (h ? prefix + "&" + h : prefix);
  window.location.replace(target);
})();
