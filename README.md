# Polaris

A network management tool. Polaris started as IPAM and grew out from there: it tracks IPv4/IPv6 space, runs a network asset inventory, auto-discovers from FortiManager / FortiGate / Windows DHCP / Entra ID / Active Directory, monitors devices over FortiOS REST and SNMP (response time, telemetry, system info, LLDP topology), maps managed FortiGates with their FortiSwitch/FortiAP/LLDP topology, and pushes MAC quarantine to FortiGates from sighted DHCP activity.

## Features

### IP management
- **Blocks, subnets, reservations** with conflict detection, VLAN tagging, next-available allocation, and per-block / per-subnet utilization.
- **Bulk site allocation** — save a multi-subnet template (e.g. `RGIHardware /25`, `RGIUsers /25`, `RGIVoice /26`, plus `skip` entries to leave gaps) and stamp it out for each site. Allocations are anchor-aligned (default `/24`, per-user) and all-or-nothing inside one transaction.
- **Stale reservation alerts** — DHCP reservations whose target client hasn't actively held the IP within a configurable window surface in a sidebar badge with snooze / permanent-ignore controls.
- **Global typeahead search** — the header search classifies IP / CIDR / MAC / text and returns blocks, subnets, reservations, assets, and individual IPs in one dropdown.

### Asset inventory & discovery
- **Assets** — servers, switches, firewalls, APs, workstations with full MAC history, serials, warranty/procurement info, OS, IP source tracking, location, and status changes attributed to who set them and when.
- **FortiManager / FortiGate** — DHCP scopes, static reservations, live leases, interface IPs, VIPs, managed FortiSwitches, managed FortiAPs, and FortiGate inventory. Per-device transport is selectable: query each FortiGate directly (parallel, scalable) or proxy every call through FortiManager (serial, simpler firewall posture).
- **Windows Server** — DHCP scopes via WinRM.
- **Microsoft Entra ID / Intune** — registered devices via Microsoft Graph, optionally enriched with Intune managed-device data (serial, MAC, manufacturer, model, primary user, compliance).
- **Active Directory** — on-prem computer objects via LDAP/LDAPS simple bind. Hybrid-joined devices are cross-linked to Entra by SID so the same machine never appears twice.
- **Conflict resolution** — discovery values that differ from an existing manual record become `Conflict` records for admin review. Asset conflicts cover hostname matches, NetBIOS-truncated matches, MAC collisions, and duplicate Entra/AD registrations; reservation conflicts cover sourceType/owner/notes drift.
- **Discovery filters** — wildcard device-name include/exclude on FortiGate inventory, OU include/exclude on AD, name patterns on Entra.
- **DNS resolution** — per-asset reverse PTR and forward A/AAAA lookups using the configured resolver (system, DoH, or DoT). Results are TTL-cached so repeated discovery doesn't hammer DNS.

### Monitoring
Asset monitoring runs on three independent cadences, each with its own retention setting:

- **Response-time probe** (default 60 s) — FortiOS REST, SNMP `sysUpTime`, WinRM SOAP, SSH connect+auth, or ICMP. Records round-trip time on success and `null` on failure ("packet loss"). Down/up transitions emit audit events and drive the sidebar status pill.
- **Telemetry** (default 60 s) — CPU, memory, and per-sensor temperatures. Vendor-specific SNMP profiles ship for Cisco, Juniper, Mikrotik, Fortinet, HP/Aruba, and Dell, falling back to HOST-RESOURCES-MIB and ENTITY-SENSOR-MIB.
- **System info** (default 600 s) — interfaces (with `ifAlias` / FortiOS CMDB description, error counters, IP/MAC), storage mountpoints, IPsec phase-1 tunnels (with phase-2 rollup and parent-interface nesting), and LLDP neighbors. LLDP rows are matched back to Polaris assets by management IP, chassis MAC, or system name, so the topology graph can show a clickable cross-link.

Operators can pin specific interfaces, mountpoints, or IPsec tunnels for **sub-minute polling** without re-walking the full table. Each FMG/FortiGate integration carries per-stream **REST ↔ SNMP toggles** (response time, telemetry, interfaces, LLDP) so branch-class FortiGates whose REST sensor endpoints 404 on FortiOS 7.4.x can be moved to SNMP one stream at a time. Per-asset overrides take precedence when set.

The asset details panel renders charts for response time, CPU/memory, temperature per sensor, per-interface throughput + errors, mountpoint usage, and IPsec status timeline + bytes. Admin operators also get an **SNMP Walk** tab for ad-hoc OID exploration on any reachable host.

### Device Map
A Leaflet basemap pinned with every FortiGate that has geo coordinates configured on the device. Pin color reflects monitor health (green / amber / red / gray). Clicking a pin opens a Cytoscape topology modal showing the FortiGate, its managed FortiSwitches and FortiAPs, its discovered subnets, and any LLDP-observed neighbors that aren't part of the managed fleet — including ghost nodes for non-Polaris devices. Header search autocompletes hostnames and serials.

### MAC Quarantine
Polaris records which FortiGate every asset has been sighted on via DHCP. From the asset details panel (or via API token from a SIEM), an operator can quarantine a device — the asset's MACs are pushed as MAC-based address-group entries to every FortiGate that sighted the device within the configured window, after which the device's status flips to `quarantined`.

- **Drift detection** runs the FortiGate-side state back through verify on demand and during the next discovery cycle.
- **Auto-quarantine** re-fires when a quarantined device shows up on a new FortiGate.
- **Release** is best-effort: device-side failures don't block the Polaris release so an offline FortiGate doesn't trap an operator.
- **Infrastructure assets** (firewalls, switches, APs) cannot be quarantined — quarantining the device that does the quarantining would lock the operator out of the network.
- **Bulk operations** are wired through both the asset list and the API.

### DHCP push to FortiGate
When the FMG/FortiGate integration's **DHCP Push** toggle is on, manual reservations created in Polaris are written to the originating FortiGate at create time, with read-back verify — the Polaris row only commits if the device write lands. The same toggle gates **lease release**: freeing a discovered DHCP lease tells FortiOS to forget it. Release-time unpush is best-effort and audits both success and orphan-on-device cases.

### Quarantine push
A separate FMG integration toggle gates whether quarantine pushes target this integration's FortiGates. Off by default; pairs with the per-API-token integration scoping so an external caller can only reach the FortiGates it's been authorized for.

### MIB Database
Admin-uploaded SNMP MIB modules drive vendor-specific telemetry. Uploads are validated by a minimal SMI parser (real ASN.1 modules only — binaries and arbitrary text are rejected) and scoped three ways: **Manufacturer-wide** (the common case), **Device-specific** (overrides one model), or **Generic** (shared across vendors). Resolution priority at probe time is *device → vendor → generic → built-in seed*. The MIB Database card shows live **Vendor Profile Status** so an admin can see which built-in profile symbols resolve and which MIB provided each.

### Manufacturer aliases
A built-in alias map collapses IEEE legal forms (`Fortinet, Inc.`) into marketing names (`Fortinet`) consistently across asset rows, MIB scoping, and vendor-profile matching. Ships ~25 default mappings; admins extend the map and existing rows are backfilled in the background.

### Capacity grading
Server Settings → Maintenance shows host CPU/RAM/disk, database size with sample-table breakdown and dead-tuple ratios, monitoring workload (asset count, pinned-interface count, cadences, retention), and a steady-state size projection. Critical conditions (disk free <10%, projected DB > 8× host RAM, autovacuum stale on a populated table) drive a non-dismissible sidebar alert; amber conditions are snoozable.

### Authentication & RBAC
- **Local accounts** — argon2id-hashed passwords with strength rules and per-account temporary lockout.
- **TOTP second factor** — RFC 6238 enrollment via QR code, single-use backup codes, admin reset for lost devices.
- **Azure SAML SSO** — auto-provisioning, single logout, optional skip-login-page redirect.
- **Roles** — Admin, Network Admin, Assets Admin, User, Read-Only. Network and asset surfaces are role-scoped; users own the records they create.
- **API tokens** — long-lived bearer tokens for external callers (e.g. SIEM-driven quarantine). Per-token integration scoping is required for `assets:quarantine`; the raw token is shown once at creation and only the argon2 hash is stored.

### Audit & operations
- **Event log** with syslog (CEF) forwarding, SFTP/SCP archival, configurable retention.
- **HTTPS** with built-in cert management (TLS 1.2+, AEAD-only).
- **Helmet CSP / HSTS / CSRF** synchronizer-token (`polaris_csrf` cookie + `X-CSRF-Token` header).
- **Encrypted backups** with versioned magic header (`POLARIS\0`), retained on disk and surfaced for in-app restore.
- **In-app updates** from Server Settings → Maintenance, with automatic rollback if any step fails.
- **PDF / CSV export** for assets, networks, events, and IP panel data.

## System requirements

| Resource | Minimum (<50 devices) | Recommended (200+ devices, 200K+ reservations) |
|----------|----------------------|-----------------------------------------------|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB SSD | 50 GB SSD |
| OS | Windows Server 2019+, RHEL 9, Ubuntu 22.04+ | Windows Server 2022, RHEL 9, Ubuntu 22.04+ |
| PostgreSQL | 15+ | 15+ |
| Node.js | 20 LTS | 20 LTS |

Discovery pre-loads subnets, reservations, and assets for O(1) lookups; peak memory is ~200–400 MB on top of the Node.js base. Monitoring sample tables grow proportionally with monitored asset count × cadence × retention; the Capacity card on Server Settings → Maintenance projects this at runtime.

**PostgreSQL tuning for large deployments** (`postgresql.conf`):

```
shared_buffers = 2GB
work_mem = 32MB
effective_cache_size = 4GB
max_connections = 20
random_page_cost = 1.1
```

## Quick start (development)

1. **Install PostgreSQL 15+** and create the database:

   ```sql
   CREATE USER polaris WITH PASSWORD 'polaris';
   CREATE DATABASE polaris OWNER polaris;
   ```

2. **Install Node.js 20+** (https://nodejs.org).

3. **Clone, configure, run:**

   ```bash
   npm install
   cp .env.example .env          # edit DATABASE_URL if you changed creds
   npx prisma migrate dev --name init
   npm run db:seed               # optional sample data
   npm run dev
   ```

The dashboard is at `http://localhost:3000`; the API at `http://localhost:3000/api/v1`. On first visit the **Setup Wizard** walks through DB connection, admin account, and initial config (skip steps 1–2 above if you use it).

### Demo mode

```bash
node demo.mjs
```

In-memory server on port 3000 with sample data. No database required.

## Production deployment

Automated scripts install Node.js 20, PostgreSQL 15, the `polaris` system user, the database, app code (to `/opt/polaris` or `C:\polaris`), a random `SESSION_SECRET`, and a hardened service — then open port 3000 in the firewall.

**RHEL / Rocky / Alma 9:**

```bash
git clone https://github.com/davidmoore-rogers/polaris.git && cd polaris
bash deploy/setup-rhel.sh
```

**Ubuntu / Debian:**

```bash
git clone https://github.com/davidmoore-rogers/polaris.git && cd polaris
bash deploy/setup-ubuntu.sh
```

**Windows Server 2019 / 2022** (run as Administrator):

```powershell
git clone https://github.com/davidmoore-rogers/polaris.git; cd polaris
powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1
```

After the script finishes the app is live at `http://<server-ip>:3000` — log in with `admin` / `admin` and change the password.

### Updating

The recommended path is **Server Settings → Maintenance → Update**, which runs the same automated flow as the CLI scripts and rolls back on any failure:

```bash
bash deploy/update-linux.sh                                         # Linux
powershell -ExecutionPolicy Bypass -File deploy\update-windows.ps1  # Windows, as Admin
```

The flow: snapshot the commit → `pg_dump` backup (last 10 kept in `backups/`) → `git pull` → `npm ci` → build → stop service → migrate → start → HTTP smoke test. If any step fails the code, DB, and service are restored to the previous version.

### Managing the service

**Linux (systemd):** `systemctl status|restart polaris`, `journalctl -u polaris -f`
**Windows (NSSM):** `nssm status|restart Polaris`, logs in `C:\polaris\logs\service-stdout.log`

## API overview

All endpoints live under `/api/v1/`.

| Resource | Base path |
|---|---|
| IP Blocks | `/blocks` |
| Subnets | `/subnets` (incl. `/next-available`, `/bulk-allocate`) |
| Reservations | `/reservations` (incl. `/alerts`, `/stale-settings`) |
| Allocation Templates | `/allocation-templates` |
| Assets | `/assets` (incl. monitoring, quarantine, snmp-walk) |
| Map | `/map` (sites, search, topology) |
| Integrations | `/integrations` (incl. discovery, query, interface aggregate) |
| Conflicts | `/conflicts` |
| Credentials | `/credentials` |
| Manufacturer Aliases | `/manufacturer-aliases` |
| API Tokens | `/api-tokens` |
| Events | `/events` |
| Search | `/search` |
| Users | `/users` |
| Auth / SSO / TOTP | `/auth` |
| Utilization | `/utilization` |
| Server Settings | `/server-settings` (incl. MIBs, capacity, backups) |

Authentication is session-based for the UI; long-lived bearer tokens (`polaris_<32-char-base64url>`) are accepted on a small allow-listed surface for external callers. See `CLAUDE.md` for the full endpoint catalog and domain model.

## Integrations

### FortiManager
On-premise FortiManager **7.4.7+ / 7.6.2+** via JSON-RPC with a bearer API token. Discovers DHCP scopes, leases + static reservations (merged from CMDB and live monitor), interface IPs, VIPs, managed FortiSwitches, managed FortiAPs, and FortiGate inventory. Two transports are selectable per integration:

- **Proxy** (default) — every per-device call funnels through FMG's `/sys/proxy/json`. Simpler firewall posture; FMG-imposed serial polling caps the practical fleet size.
- **Direct** — FMG is queried only for the device roster; per-device calls go straight to each FortiGate's management IP using a shared REST API admin credential. Unlocks parallelism and is recommended above ~20 FortiGates.

DHCP push, quarantine push, monitoring transport (per-stream REST/SNMP toggles), per-class FortiSwitch/FortiAP direct polling, and per-class Auto-Monitor Interfaces selections are all configured per integration.

### Standalone FortiGate
A single FortiGate via REST API — same discovery scope as FortiManager — for deployments not managed by one. Requires a REST API admin token (System → Administrators → REST API Admin).

### Windows Server
Windows Server DHCP via WinRM (PowerShell remoting, port 5985 HTTP or 5986 HTTPS). Discovers v4 DHCP scopes.

### Microsoft Entra ID / Intune
Microsoft Graph via OAuth2 client credentials. Produces **assets only**.

- **Entra ID** (always) — hostname, OS, OS version, trust type, compliance, last sign-in. Requires `Device.Read.All` (application, admin-consented).
- **Intune** (toggle) — serial, MAC (Wi-Fi + Ethernet, both stored), manufacturer, model, primary user, compliance state. Merged onto Entra devices via `azureADDeviceId ↔ deviceId`. Requires `DeviceManagementManagedDevices.Read.All`.

### Active Directory (on-premise)
A domain controller via LDAP / LDAPS simple bind, read-only domain user. Produces **assets only** — computer objects under a configured base DN, mapping hostname, DNS name, OS / OS version, OU path, `whenCreated`, `lastLogonTimestamp`, and description. Disabled accounts can be imported as `decommissioned` or skipped. Wildcard OU include/exclude filters.

### Hybrid join cross-link
Active Directory and Entra ID identify the same hybrid-joined device with two unrelated GUIDs. Both services stamp `sid:{SID}` (uppercase) in the asset's tags so subsequent runs match the SID and don't re-create a duplicate row. Entra's `assetTag = entra:{deviceId}` always wins as the primary tag; the AD GUID is preserved as an `ad-guid:{guid}` tag so future AD runs still resolve.

## Security

- TLS 1.2+ with AEAD-only cipher suites and configurable certificates
- Helmet Content Security Policy, HSTS, X-Frame-Options
- Synchronizer-token CSRF protection on every state-changing call (`polaris_csrf` cookie + `X-CSRF-Token` header)
- 10 login attempts / 15-minute window per IP; per-account temporary lockout after repeated failures
- HttpOnly + SameSite=Lax session cookies, session ID regenerated on login, configurable inactivity timeout
- Argon2id password hashing; argon2id-hashed API tokens with timing-safe lookup
- SAML RelayState CSRF protection on SSO callbacks
- 1 MB max request body
- Setup wizard self-locks after first-run via a `.setup-complete` marker so a network attacker can't re-run provisioning against an installed host

## Running tests

```bash
npm test                  # all tests once
npm run test:watch        # watch mode
npm run test:coverage     # with coverage report
```

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ / TypeScript (ESM) |
| Framework | Express 5 |
| ORM | Prisma 7 (driver-adapter via `@prisma/adapter-pg`) |
| Database | PostgreSQL 15 |
| Sessions | express-session + connect-pg-simple |
| Validation | Zod |
| Logging | Pino |
| Auth | argon2id, `@node-saml/node-saml`, `otpauth` + `qrcode` |
| IP math | `ip-cidr`, `netmask`, `cidr-tools` |
| LDAP | `ldapts` |
| Monitoring transports | `net-snmp`, `ssh2`, built-in `node:https` (FortiOS REST + WinRM SOAP), system `ping` |
| Mapping | Leaflet + leaflet.markercluster + OpenStreetMap |
| Graph layout | Cytoscape.js + dagre + cytoscape-dagre |
| PDF | jspdf + jspdf-autotable |
| Security | Helmet, express-rate-limit |
| Testing | Vitest + Supertest |
| Frontend | Vanilla JavaScript + HTML, served from `/public` (no build step) |
