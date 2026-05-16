// public/js/topology-render.js — shared topology graph builders.
//
// Both the desktop Device Map (public/js/map.js) and the mobile topology
// surface (public/js/mobile/topology-tab.js) consume the /map/sites/:id/topology
// payload and render it via Cytoscape. Element construction + the visual
// stylesheet are identical between the two — node colors per monitor health,
// edge styles for controller / interface-inferred / LLDP edges, ghost LLDP
// nodes, cross-site remote assets, operator-uploaded icons. Diverging those
// rules across desktop and mobile would just be drift bait, so they live
// here.
//
// Mobile-only knobs (top-to-bottom dagre, no drag-to-reposition) stay in the
// mobile module — this file only exposes shared building blocks.

(function () {
  // Color a Fortinet-infrastructure node (FortiGate, FortiSwitch, FortiAP)
  // from its monitor health. Same priority as the asset list Status pill:
  // confirmed-down probe wins over the dependency-suppression flag, so a
  // suppressed-but-actually-down node still renders red.
  function fortinetNodeColor(asset) {
    if (!asset || !asset.monitored) return "#757575"; // gray — unmonitored
    if (asset.dependencySuppressed && asset.monitorHealth !== "down") return "#607d8b"; // slate — Dep. Down
    switch (asset.monitorHealth) {
      case "up":       return "#2e7d32"; // green
      case "degraded": return "#f9a825"; // amber
      case "down":     return "#c62828"; // red
      default:         return "#9e9e9e"; // unknown
    }
  }

  // Build the elements array Cytoscape consumes from a /topology payload.
  // The shape mirrors what desktop map.js used to construct inline; mobile
  // and desktop now both call this so a new node/edge type only needs to
  // be added in one place.
  function buildTopologyElements(data) {
    if (!data) return [];
    var elements = [];

    if (data.fortigate) {
      elements.push({
        data: {
          id: data.fortigate.id,
          label: data.fortigate.hostname || "FortiGate",
          role: "fortigate",
          nodeColor: fortinetNodeColor(data.fortigate),
          iconUrl: data.fortigate.iconUrl || null,
          hasIcon: data.fortigate.iconUrl ? 1 : 0,
          iconSize: 44, // ~70% of 64px fortigate node
        },
      });
    }
    (data.switches || []).forEach(function (s) {
      elements.push({
        data: {
          id: s.id,
          label: s.hostname || "FortiSwitch",
          role: "fortiswitch",
          nodeColor: fortinetNodeColor(s),
          iconUrl: s.iconUrl || null,
          hasIcon: s.iconUrl ? 1 : 0,
          iconSize: 30, // ~70% of 44px default node
        },
      });
    });
    (data.aps || []).forEach(function (a) {
      elements.push({
        data: {
          id: a.id,
          label: a.hostname || "FortiAP",
          role: "fortiap",
          nodeColor: fortinetNodeColor(a),
          iconUrl: a.iconUrl || null,
          hasIcon: a.iconUrl ? 1 : 0,
          iconSize: 24, // ~70% of 36px fortiap node
        },
      });
      // Wireless stations connected to this AP. Each station becomes a
      // small diamond node hanging off the AP via a dashed-cyan "wireless"
      // edge. Stations matched to a Polaris asset get the asset's
      // hostname as the label and the asset id as a tap target; unmatched
      // stations show their MAC (the only identity available).
      (a.stations || []).forEach(function (s) {
        var stationNodeId = "wsta-" + a.id + "-" + s.macAddress;
        elements.push({
          data: {
            id:        stationNodeId,
            label:     s.hostname || s.macAddress,
            role:      "wireless-station",
            assetId:   s.id || null,
            assetType: s.assetType || null,
            ssid:      s.ssid || null,
            mac:       s.macAddress,
          },
        });
        elements.push({
          data: {
            id: "we-" + a.id + "-" + s.macAddress,
            source: a.id, target: stationNodeId,
            label: s.ssid || "",
            isWireless: 1,
          },
        });
      });
    });
    (data.edges || []).forEach(function (e, i) {
      elements.push({
        data: {
          id: "e" + i, source: e.source, target: e.target,
          label: e.label || "",
          reason: e.reason || "",
        },
      });
    });
    (data.lldpNodes || []).forEach(function (n) {
      var label = n.hostname || n.managementIp || n.chassisId || "Unknown";
      elements.push({
        data: { id: n.id, label: label, role: "lldp" },
      });
    });
    (data.remoteAssetNodes || []).forEach(function (n) {
      var label = n.hostname || n.ipAddress || n.id;
      elements.push({
        data: {
          id: n.id, label: label, role: "remote-asset",
          assetId: n.id, assetType: n.assetType || null,
          iconUrl: n.iconUrl || null, hasIcon: n.iconUrl ? 1 : 0,
          iconSize: 30, // ~70% of 44px remote-asset node
        },
      });
    });
    (data.lldpEdges || []).forEach(function (e, i) {
      elements.push({
        data: {
          id: "le" + i, source: e.source, target: e.target,
          label: e.label || "", isLldp: 1,
          reason: e.reason || "",
        },
      });
    });
    (data.interfaceEdges || []).forEach(function (e, i) {
      elements.push({
        data: {
          id: "ie" + i, source: e.source, target: e.target,
          label: e.label || "", isIface: 1,
          reason: e.reason || "",
        },
      });
    });

    return elements;
  }

  // Cytoscape stylesheet — node colors per role, edge styles per source
  // (controller / interface-inferred / LLDP), selected/dimmed/pulse states,
  // and the operator-uploaded icon overlay. `theme` is "dark" or "light";
  // text + edge color swap accordingly so the graph reads well on either
  // basemap. `opts.includeEndpointOverlay` adds the synthetic endpoint
  // and dim styles used by desktop's connection-path overlay — mobile
  // doesn't carry that feature so it leaves it off.
  function topologyStylesheet(theme, opts) {
    opts = opts || {};
    var isDark = theme === "dark";
    var textColor = isDark ? "#eef0f4" : "#1a1a1a";
    var edgeColor = isDark ? "#6a7388" : "#9aa2b1";
    var textBg    = isDark ? "#1c2029" : "#ffffff";

    var style = [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "text-wrap": "wrap",
          "text-max-width": 160,
          color: textColor,
          "font-size": "11px",
          "font-family": "Inter, system-ui, sans-serif",
          "text-valign": "bottom",
          "text-margin-y": 6,
          "background-color": "#546e7a",
          width: 44,
          height: 44,
          "border-width": 2,
          "border-color": "#ffffff",
          "border-opacity": 0.85,
        },
      },
      { selector: 'node[role="fortigate"]',   style: { "background-color": "data(nodeColor)", width: 64, height: 64, "font-weight": 700 } },
      { selector: 'node[role="fortiswitch"]', style: { "background-color": "data(nodeColor)" } },
      { selector: 'node[role="fortiap"]',     style: { "background-color": "data(nodeColor)", width: 36, height: 36 } },
      {
        selector: 'node[role="lldp"]',
        style: {
          "background-color": "#7a4f1a",
          "border-color": "#f59e0b",
          "border-style": "dashed",
          width: 36,
          height: 36,
        },
      },
      {
        selector: 'node[role="remote-asset"]',
        style: {
          "background-color": "#1e3a5f",
          "border-color": "#4fc3f7",
          "border-style": "solid",
          "border-width": 2,
          width: 44,
          height: 44,
        },
      },
      // Wireless station — diamond shape so it's visually distinct from
      // wired endpoints + LLDP ghosts. Smaller than an AP since one AP
      // can carry dozens of stations and we don't want them dominating
      // the layout. Cyan border-bg matches the "wireless" edge style so
      // the eye groups the AP + its stations as one cluster.
      {
        selector: 'node[role="wireless-station"]',
        style: {
          "background-color": "#0e2a3a",
          "border-color":     "#22d3ee",
          "border-style":     "solid",
          "border-width":     2,
          shape:              "diamond",
          width:              24,
          height:             24,
          "font-size":        "9px",
        },
      },
      // Vendor logo overlay. Both signals stay visible: the THICK
      // colored border carries the monitor health (green/amber/red/
      // grey — the same role/nodeColor used on plain nodes), the
      // logo identifies the vendor + model. White interior fill so
      // the logo's colors pop against any basemap (dark or light),
      // and the image is shrunk to ~70% of the node so a square logo
      // bounding box fits cleanly inside the circle without its
      // corners clipping against the border (geometry: a square
      // inscribed in a circle has side = diameter / √2 ≈ 70.7%).
      //
      // Sizing uses explicit pixel `iconSize` (set per role on the
      // element data) instead of "70%" because Cytoscape 3.30's
      // percentage `background-width`/`background-height` are
      // computed against the rendered (zoom-scaled) node bounds, so
      // the icon visibly grows past the border ring as the operator
      // zooms in. Pixel values are model-space and stay stable.
      {
        selector: 'node[hasIcon = 1]',
        style: {
          "background-image": "data(iconUrl)",
          "background-fit": "contain",
          "background-clip": "node",
          "background-image-containment": "inside",
          "background-width": "data(iconSize)",
          "background-height": "data(iconSize)",
          "background-position-x": "50%",
          "background-position-y": "50%",
          "background-color": "#ffffff",
          "background-opacity": 1,
          "border-color": "data(nodeColor)",
          "border-width": 5,
          "border-opacity": 1,
        },
      },
      {
        selector: "edge",
        style: {
          width: 1.8,
          "line-color": edgeColor,
          "target-arrow-color": edgeColor,
          "target-arrow-shape": "none",
          "curve-style": "bezier",
          label: "data(label)",
          "font-size": "9px",
          color: textColor,
          "text-background-color": textBg,
          "text-background-opacity": 0.85,
          "text-background-padding": 2,
          "text-rotation": "autorotate",
        },
      },
      {
        selector: 'edge[isLldp = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#f59e0b",
          "target-arrow-color": "#f59e0b",
        },
      },
      {
        selector: 'edge[isIface = 1]',
        style: {
          "line-style": "solid",
          "line-color": "#14b8a6",
          "target-arrow-color": "#14b8a6",
          width: 2.4,
        },
      },
      // Wireless edge: AP → connected station. Dashed cyan, lighter than
      // the wired controller / interface edges so the eye doesn't read
      // station-cluster fanout as critical topology.
      {
        selector: 'edge[isWireless = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#22d3ee",
          "target-arrow-color": "#22d3ee",
          width: 1.4,
          opacity: 0.7,
        },
      },
      {
        selector: 'node.topology-pulse',
        style: {
          "border-color": "#22d3ee",
          "border-width": 4,
          "border-opacity": 1,
        },
      },
      {
        selector: 'node:selected',
        style: {
          "border-color": "#22d3ee",
          "border-width": 5,
          "border-opacity": 1,
          "overlay-color": "#22d3ee",
          "overlay-opacity": 0.18,
          "overlay-padding": 6,
        },
      },
      {
        selector: 'edge:selected',
        style: {
          "line-color": "#22d3ee",
          "target-arrow-color": "#22d3ee",
          width: 3,
          "overlay-color": "#22d3ee",
          "overlay-opacity": 0.15,
          "overlay-padding": 3,
        },
      },
      {
        selector: 'core',
        style: {
          "selection-box-color":        "#22d3ee",
          "selection-box-border-color": "#22d3ee",
          "selection-box-border-width": 1.5,
          "selection-box-opacity":      0.22,
          "active-bg-color":            "#22d3ee",
          "active-bg-opacity":          0.14,
        },
      },
    ];

    if (opts.includeEndpointOverlay) {
      style.push({
        selector: 'node[role="endpoint"]',
        style: {
          "background-color": "data(nodeColor)",
          shape: "round-rectangle",
          width: 44,
          height: 36,
        },
      });
      style.push({
        selector: 'node.dimmed',
        style: { display: 'none' },
      });
      style.push({
        selector: 'edge.dimmed',
        style: { display: 'none' },
      });
    }

    return style;
  }

  // Legend rows for the topology overlay. Colors here mirror the constants
  // used by `fortinetNodeColor()` (status hues) and `topologyStylesheet()`
  // (node fills + edge styles) so a stylesheet change has exactly one place
  // the legend has to follow.
  function topologyLegendSpec() {
    return {
      nodes: [
        { label: "FortiGate",         kind: "circle",          size: "lg", fill: "data(nodeColor)", desc: "Color = monitor health" },
        { label: "FortiSwitch",       kind: "circle",          size: "md", fill: "data(nodeColor)" },
        { label: "FortiAP",           kind: "circle",          size: "sm", fill: "data(nodeColor)" },
        { label: "Endpoint",          kind: "round-rectangle", size: "md", fill: "data(nodeColor)", desc: "Color = monitor health (when monitored)" },
        { label: "Wireless station",  kind: "diamond",         size: "sm", fill: "#0e2a3a", border: "#22d3ee" },
        { label: "LLDP ghost",        kind: "circle",          size: "md", fill: "#7a4f1a", border: "#f59e0b", borderStyle: "dashed", desc: "Non-Polaris device" },
        { label: "Remote asset",      kind: "circle",          size: "md", fill: "#1e3a5f", border: "#4fc3f7", desc: "Polaris asset at another site" },
      ],
      health: [
        { label: "Up",                color: "#2e7d32" },
        { label: "Degraded",          color: "#f9a825" },
        { label: "Down",              color: "#c62828" },
        { label: "Dep. Down",         color: "#607d8b" },
        { label: "Unmonitored",       color: "#757575" },
      ],
      edges: [
        { label: "Controller",        color: "#6a7388", style: "solid",  desc: "FortiLink / managed-AP authoritative" },
        { label: "Interface-inferred",color: "#14b8a6", style: "solid",  desc: "Naming-convention peer link" },
        { label: "LLDP",              color: "#f59e0b", style: "dashed" },
        { label: "Wireless",          color: "#22d3ee", style: "dashed", desc: "AP → station" },
      ],
    };
  }

  window.PolarisTopologyRender = {
    fortinetNodeColor: fortinetNodeColor,
    buildTopologyElements: buildTopologyElements,
    topologyStylesheet: topologyStylesheet,
    topologyLegendSpec: topologyLegendSpec,
  };
})();
