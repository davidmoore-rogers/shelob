/**
 * public/js/subnets.js — Networks list + CRUD + next-available
 */

var cachedBlocks = [];
var _subnetsPageSize = 15;
var _subnetsPage = 1;
var _subnetsData = [];

document.addEventListener("DOMContentLoaded", async function () {
  await loadBlockOptions();
  loadSubnets();

  var addBtn = document.getElementById("btn-add-subnet");
  if (addBtn) addBtn.addEventListener("click", openCreateModal);
  var allocBtn = document.getElementById("btn-auto-alloc");
  if (allocBtn) allocBtn.addEventListener("click", openAllocateModal);
  document.getElementById("subnets-tbody").addEventListener("click", function (e) {
    var link = e.target.closest(".subnet-name-link");
    if (!link) return;
    e.preventDefault();
    openIpPanel(link.getAttribute("data-subnet-id"));
  });
  document.getElementById("filter-block").addEventListener("change", function () { _subnetsPage = 1; loadSubnets(); });
  document.getElementById("filter-status").addEventListener("change", function () { _subnetsPage = 1; loadSubnets(); });
  document.getElementById("filter-tag").addEventListener("input", debounce(function () { _subnetsPage = 1; loadSubnets(); }, 300));
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    _subnetsPageSize = parseInt(this.value, 10) || 15;
    _subnetsPage = 1;
    renderSubnetsPage();
  });
});

async function loadBlockOptions() {
  try {
    cachedBlocks = await api.blocks.list();
    var sel = document.getElementById("filter-block");
    cachedBlocks.forEach(function (b) {
      var opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.name + " (" + b.cidr + ")";
      sel.appendChild(opt);
    });
  } catch (err) {
    showToast("Failed to load blocks: " + err.message, "error");
  }
}

function blockSelectHTML(id, required) {
  var opts = '<option value="">' + (required ? "Select a block..." : "All blocks") + '</option>';
  cachedBlocks.forEach(function (b) {
    opts += '<option value="' + b.id + '">' + escapeHtml(b.name) + ' (' + escapeHtml(b.cidr) + ')</option>';
  });
  return '<select id="' + id + '">' + opts + '</select>';
}

async function loadSubnets() {
  var tbody = document.getElementById("subnets-tbody");
  try {
    var statusVal = document.getElementById("filter-status").value;
    var apiStatus = (statusVal === "hide-deprecated" || !statusVal) ? undefined : statusVal;
    var filters = {
      blockId: document.getElementById("filter-block").value || undefined,
      status: apiStatus,
      tag: document.getElementById("filter-tag").value || undefined,
    };
    _subnetsData = await api.subnets.list(filters);
    if (statusVal === "hide-deprecated") {
      _subnetsData = _subnetsData.filter(function (s) { return s.status !== "deprecated"; });
    }
    renderSubnetsPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function renderSubnetsPage() {
  var tbody = document.getElementById("subnets-tbody");
  if (_subnetsData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No networks found. Create one to get started.</td></tr>';
    document.getElementById("pagination").innerHTML = "";
    return;
  }
  var start = (_subnetsPage - 1) * _subnetsPageSize;
  var page = _subnetsData.slice(start, start + _subnetsPageSize);
  tbody.innerHTML = page.map(function (s) {
    var tags = (s.tags || []).map(function (t) { return escapeHtml(t); }).join(", ");
    var blockName = s.block ? escapeHtml(s.block.name) : "-";
    var fgtDevice = s.fortigateDevice ? escapeHtml(s.fortigateDevice) : "-";
    var source = s.integration
      ? escapeHtml(s.integration.name)
      : '<span style="color:var(--color-text-tertiary)">Manual</span>';
    return '<tr>' +
      '<td><a href="#" class="subnet-name-link" data-subnet-id="' + s.id + '"><strong>' + escapeHtml(s.name) + '</strong></a></td>' +
      '<td class="mono">' + escapeHtml(s.cidr) + '</td>' +
      '<td>' + blockName + '</td>' +
      '<td>' + escapeHtml(s.purpose || "-") + '</td>' +
      '<td>' + (s.vlan ? '<span class="badge badge-vlan">VLAN ' + s.vlan + '</span>' : '-') + '</td>' +
      '<td>' + statusBadge(s.status) + '</td>' +
      '<td>' + (tags || '<span style="color:var(--color-text-tertiary)">-</span>') + '</td>' +
      '<td>' + fgtDevice + '</td>' +
      '<td>' + source + '</td>' +
      '<td>' + (s._count ? s._count.reservations : 0) + '</td>' +
      '<td class="actions">' +
        (isAdmin() ? '<button class="btn btn-sm btn-secondary" onclick="openEditModal(\'' + s.id + '\')">Edit</button>' +
        '<button class="btn btn-sm btn-danger" onclick="confirmDelete(\'' + s.id + '\', \'' + escapeHtml(s.cidr) + '\')">Del</button>' : '') +
      '</td></tr>';
  }).join("");
  renderPageControls("pagination", _subnetsData.length, _subnetsPageSize, _subnetsPage, function (p) {
    _subnetsPage = p;
    renderSubnetsPage();
  });
}

async function openCreateModal() {
  await _ensureTagCache();
  var body = '<div class="form-group"><label>Block *</label>' + blockSelectHTML("f-blockId", true) + '</div>' +
    '<div class="form-group"><label>CIDR *</label><input type="text" id="f-cidr" placeholder="e.g. 10.0.3.0/24"></div>' +
    '<div class="form-group"><label>Name *</label><input type="text" id="f-name" placeholder="e.g. API Servers"></div>' +
    '<div class="form-group"><label>Purpose</label><textarea id="f-purpose" placeholder="What is this network for?"></textarea></div>' +
    '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" placeholder="1-4094"></div>' +
    tagFieldHTML([]);
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Create Network</button>';
  openModal("Add Network", body, footer);
  wireTagPicker();

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var vlan = document.getElementById("f-vlan").value;
      var input = {
        blockId: val("f-blockId"),
        cidr: val("f-cidr"),
        name: val("f-name"),
        purpose: val("f-purpose") || undefined,
        vlan: vlan ? parseInt(vlan, 10) : undefined,
        tags: getTagFieldValue(),
      };
      await api.subnets.create(input);
      closeModal();
      showToast("Network created");
      loadSubnets();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openAllocateModal() {
  await _ensureTagCache();
  var body = '<div class="form-group"><label>Block *</label>' + blockSelectHTML("f-blockId", true) + '</div>' +
    '<div class="form-group"><label>Prefix Length *</label><input type="number" id="f-prefix" min="8" max="32" placeholder="e.g. 24"><p class="hint">/8 to /32</p></div>' +
    '<div class="form-group"><label>Name *</label><input type="text" id="f-name" placeholder="e.g. New Subnet"></div>' +
    '<div class="form-group"><label>Purpose</label><textarea id="f-purpose" placeholder="What is this network for?"></textarea></div>' +
    '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" placeholder="1-4094"></div>' +
    tagFieldHTML([]);
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Allocate</button>';
  openModal("Auto-Allocate Next Network", body, footer);
  wireTagPicker();

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var vlan = document.getElementById("f-vlan").value;
      var input = {
        blockId: val("f-blockId"),
        prefixLength: parseInt(val("f-prefix"), 10),
        name: val("f-name"),
        purpose: val("f-purpose") || undefined,
        vlan: vlan ? parseInt(vlan, 10) : undefined,
        tags: getTagFieldValue(),
      };
      var subnet = await api.subnets.nextAvailable(input);
      closeModal();
      showToast("Allocated " + subnet.cidr);
      loadSubnets();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openEditModal(id) {
  try {
    var results = await Promise.all([api.subnets.get(id), _ensureTagCache()]);
    var subnet = results[0];
    var body = '<div class="form-group"><label>CIDR</label><input type="text" value="' + escapeHtml(subnet.cidr) + '" disabled></div>' +
      '<div class="form-group"><label>Name</label><input type="text" id="f-name" value="' + escapeHtml(subnet.name) + '"></div>' +
      '<div class="form-group"><label>Purpose</label><textarea id="f-purpose">' + escapeHtml(subnet.purpose || "") + '</textarea></div>' +
      '<div class="form-group"><label>Status</label><select id="f-status"><option value="available"' + (subnet.status === "available" ? " selected" : "") + '>Available</option><option value="reserved"' + (subnet.status === "reserved" ? " selected" : "") + '>Reserved</option><option value="deprecated"' + (subnet.status === "deprecated" ? " selected" : "") + '>Deprecated</option></select></div>' +
      '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" value="' + (subnet.vlan || "") + '" placeholder="Empty to clear"></div>' +
      tagFieldHTML(subnet.tags || []);
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Network", body, footer);
    wireTagPicker();

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        var vlanVal = document.getElementById("f-vlan").value;
        var input = {
          name: val("f-name") || undefined,
          purpose: val("f-purpose") || undefined,
          status: val("f-status"),
          vlan: vlanVal ? parseInt(vlanVal, 10) : null,
          tags: getTagFieldValue(),
        };
        await api.subnets.update(id, input);
        closeModal();
        showToast("Network updated");
        loadSubnets();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function confirmDelete(id, cidr) {
  var ok = await showConfirm('Delete network "' + cidr + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.subnets.delete(id);
    showToast("Network deleted");
    loadSubnets();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function val(id) { return document.getElementById(id).value.trim(); }

function debounce(fn, ms) {
  var timer;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
