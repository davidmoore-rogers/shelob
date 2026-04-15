# Shelob — Claude Code Project

## Project Overview

**Shelob** is an IP management tool that allows users to reserve and manage IP address space (IPv4 and IPv6) for use across other infrastructure projects. Named after Tolkien's great spider — because subnets are webs, and Shelob spins them. It provides a central registry for subnets, individual IPs, and reservations — preventing conflicts and giving teams visibility into IP utilization.

---

## Architecture

```
shelob/
├── CLAUDE.md                    # This file
├── README.md
├── .env.example
├── package.json
├── tsconfig.json
├── prisma/
│   └── schema.prisma            # Database schema
├── src/
│   ├── index.ts                 # Entry point
│   ├── config.ts                # App config / env vars
│   ├── db.ts                    # Prisma client singleton
│   ├── api/
│   │   ├── router.ts            # Express router aggregator
│   │   ├── middleware/
│   │   │   ├── auth.ts          # API key / JWT auth middleware
│   │   │   ├── validate.ts      # Zod request validation middleware
│   │   │   └── errorHandler.ts  # Global error handler
│   │   └── routes/
│   │       ├── blocks.ts        # IP block CRUD
│   │       ├── subnets.ts       # Subnet CRUD & allocation
│   │       ├── reservations.ts  # Reservation CRUD
│   │       └── utilization.ts   # Reporting endpoints
│   ├── services/
│   │   ├── ipService.ts         # Core IP math & validation logic
│   │   ├── blockService.ts      # Block business logic
│   │   ├── subnetService.ts     # Subnet allocation logic
│   │   └── reservationService.ts# Reservation business logic
│   ├── models/
│   │   └── types.ts             # Shared TypeScript interfaces
│   └── utils/
│       ├── cidr.ts              # CIDR parsing, contains(), overlap()
│       └── logger.ts            # Structured logging (pino)
└── tests/
    ├── unit/
    │   ├── cidr.test.ts
    │   ├── ipService.test.ts
    │   └── subnetService.test.ts
    └── integration/
        ├── blocks.test.ts
        ├── subnets.test.ts
        └── reservations.test.ts
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ / TypeScript |
| Framework | Express 5 |
| ORM | Prisma |
| Database | PostgreSQL 15 |
| Validation | Zod |
| Logging | Pino |
| Testing | Vitest + Supertest |
| IP Math | `ip-cidr` + `netmask` npm packages |

---

## Domain Model

### Core Entities

```
IpBlock
  id            UUID PK
  name          String          -- Human-readable label (e.g. "Corporate Datacenter")
  cidr          String          -- e.g. "10.0.0.0/8"
  ipVersion     Enum(v4, v6)
  description   String?
  tags          String[]
  createdAt     DateTime
  updatedAt     DateTime
  subnets       Subnet[]

Subnet
  id            UUID PK
  blockId       UUID FK → IpBlock
  cidr          String          -- Must be contained within parent block; host bits zeroed on write
  name          String          -- Required human-readable label, e.g. "K8s Node Pool"
  purpose       String?         -- Description of what the subnet is for, e.g. "Production Kubernetes workers"
  status        Enum(available, reserved, deprecated)
  vlan          Int?            -- 802.1Q VLAN ID (1–4094); shown in dashboard and reservation views
  tags          String[]
  createdAt     DateTime
  updatedAt     DateTime
  reservations  Reservation[]

Reservation
  id            UUID PK
  subnetId      UUID FK → Subnet
  ipAddress     String?         -- Null = full subnet reservation
  hostname      String?
  owner         String          -- Team or service name
  projectRef    String          -- External project identifier
  expiresAt     DateTime?       -- Optional TTL
  notes         String?
  status        Enum(active, expired, released)
  createdAt     DateTime
  updatedAt     DateTime
```

---

## API Endpoints

### IP Blocks  `GET|POST /api/v1/blocks`
- `GET    /api/v1/blocks`               — List all blocks (filterable by tag, ipVersion)
- `POST   /api/v1/blocks`               — Create a new top-level block
- `GET    /api/v1/blocks/:id`           — Get block + utilization summary
- `PUT    /api/v1/blocks/:id`           — Update block metadata
- `DELETE /api/v1/blocks/:id`           — Delete block (only if no active reservations)

### Subnets  `/api/v1/subnets`
- `GET    /api/v1/subnets`              — List subnets (filter by blockId, status, tag)
- `POST   /api/v1/subnets`             — Carve a new subnet from a block
- `GET    /api/v1/subnets/:id`          — Get subnet + reservation list
- `PUT    /api/v1/subnets/:id`          — Update subnet metadata / status
- `DELETE /api/v1/subnets/:id`          — Delete subnet (only if no active reservations)
- `POST   /api/v1/subnets/next-available` — Auto-allocate the next available subnet of a given prefix length

### Reservations  `/api/v1/reservations`
- `GET    /api/v1/reservations`         — List reservations (filter by owner, projectRef, status)
- `POST   /api/v1/reservations`         — Reserve an IP or entire subnet
- `GET    /api/v1/reservations/:id`     — Get reservation details
- `PUT    /api/v1/reservations/:id`     — Update reservation metadata / extend TTL
- `DELETE /api/v1/reservations/:id`     — Release a reservation

### Utilization  `/api/v1/utilization`
- `GET    /api/v1/utilization`          — Global utilization summary
- `GET    /api/v1/utilization/blocks/:id` — Per-block utilization breakdown
- `GET    /api/v1/utilization/subnets/:id` — Per-subnet utilization

---

## Business Rules & Constraints

1. **No overlapping subnets** within the same block. The `cidrContains()` and `cidrOverlaps()` helpers in `src/utils/cidr.ts` must be used before any subnet creation.
2. **Subnet must be contained within its parent block** — enforce at service layer, not just DB.
3. **No duplicate IP reservations** — a specific IP address may only have one `active` reservation per subnet.
4. **Auto-expire** — A scheduled job (`src/jobs/expireReservations.ts`) runs every 15 minutes to mark reservations past their `expiresAt` as `expired`.
5. **Block deletion protection** — Blocks and subnets with any `active` reservations must not be deleted. Return HTTP 409 with a clear message.
6. **CIDR validation** — Both IPv4 and IPv6 CIDR notation must be normalized on write (e.g., `10.1.1.0/24` not `10.1.1.5/24`).

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/shelob

# App
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Auth (choose one)
API_KEY_SECRET=changeme            # Simple static API key for internal use
JWT_SECRET=changeme                # For JWT-based auth
```

Copy `.env.example` to `.env` before running.

---

## Getting Started

```bash
# Install dependencies
npm install

# Setup database
npx prisma migrate dev --name init

# Seed example data
npm run db:seed

# Start dev server (with hot reload)
npm run dev

# Run tests
npm test

# Build for production
npm run build && npm start
```

---

## Key Coding Conventions

- All IP math lives in `src/utils/cidr.ts`. **Never** do string manipulation on IPs elsewhere.
- Services (`src/services/`) contain **all business logic**. Route handlers are thin — they validate input, call a service, and return a response.
- All Zod schemas live co-located with their route file (top of the file).
- Database calls go through service functions only — never raw Prisma in route handlers.
- All errors thrown by services should be instances of `AppError` (defined in `src/utils/errors.ts`) with an `httpStatus` property.
- Use `async/await` throughout; avoid `.then()` chains.
- Write a unit test for every public function in `src/utils/` and `src/services/`.

---

## Common Claude Code Tasks

When working in this project, Claude Code can help with:

- **`add a new field to Reservation`** — Update `prisma/schema.prisma`, generate migration, update Zod schema in `routes/reservations.ts`, update service types.
- **`implement next-available subnet allocation`** — Logic goes in `subnetService.ts`, uses `cidr.ts` helpers to find gaps in the block's assigned subnets.
- **`add bulk reservation import via CSV`** — New route `POST /api/v1/reservations/import`, service function handles row validation and upsert.
- **`add Redis caching for utilization queries`** — Wrap `utilizationService` calls with a Redis TTL cache.
- **`write integration tests for reservations`** — Use Vitest + Supertest against a test database spun up via Docker Compose.

---

## Out of Scope

The following are **explicitly not** part of this project and should be handled by consuming systems:

- DNS record management
- DHCP server configuration
- Network device provisioning
- Cloud provider VPC/subnet creation (AWS, GCP, Azure)
- Authentication identity provider (use API keys or JWT issued externally)
