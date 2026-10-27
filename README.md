# GameHub Control Center

Device and session control for a gaming café: PCs, PlayStation consoles, time-limited
sessions, server-authoritative expiry, extensions, access restrictions and a complete
audit trail.

**Not a billing system.** There is no payment, invoicing, cashier or revenue code
anywhere in this repository.

---

## What works today

| Area | State |
| --- | --- |
| Dashboard (dark, responsive, live) | Built and exercised against a running server |
| Devices (add / edit / archive / maintenance / enrollment) | Works, no hardcoded device count |
| Sessions (start / extend / end / history) | Works, transactional and idempotent |
| Automatic expiry worker | Works, DB-backed, restart-safe, deduplicated |
| Real-time updates | Socket.IO, verified in the browser |
| Staff & admin accounts, permissions, audit log | Works, enforced server-side |
| Backup / restore | Works, round-trip covered by tests |
| Playwright-free UI testing | Manual + API-level; see *Known limitations* |
| Windows PC agent | Source complete; **not compiled or tested here** (no .NET SDK on the build machine) |
| PlayStation automation | Deliberately **manual/staff-assisted** — no verified consumer API exists. A pluggable bridge adapter is included but marked unverified |

Test suite: **72 tests across 7 files**, all passing (`npm test`).

## Screens

1. **Overview** – key metrics, filterable device grid with live countdowns, activity feed, attention panel.
2. **Devices** – inventory, add/edit/archive, maintenance, enrollment codes, agent health.
3. **Active sessions** – live board with remaining time and inline extend/end.
4. **Session history** – filters by device/state/date/staff/nickname, with a per-session timeline.
5. **Notifications** – persistent alerts with read state and sound.
6. **Staff** – accounts, roles, activation, password resets (admin only).
7. **Settings** – durations, warnings, offline grace, PlayStation integration, audit log, health.

Times are stored in UTC and rendered in **Asia/Kolkata**; the dashboard shows an IST clock.

## Architecture

```
web/  (React 19 · TypeScript · Vite · Tailwind 4 · TanStack Query · Socket.IO client)
  │  fetch + websocket
server/ (Node · Express 5 · TypeScript · Drizzle ORM · Socket.IO)
  │
  ├─ PostgreSQL  (node-postgres in production, embedded PGlite for a single-box install)
  ├─ ExpiryWorker  — every 5 s: claim overdue sessions with one conditional UPDATE,
  │                  write notifications/audit, notify agents, emit realtime events
  └─ Device API  — enrollment, heartbeat, authoritative session state, access events

agent/ (C# · .NET 8)  — Windows service (network + state) + kiosk session host (desktop)
```

### Why PGlite?

Both modes speak PostgreSQL and share one schema and one set of SQL migrations
(`server/drizzle`). PGlite (PostgreSQL compiled to WASM) means a café can run the whole
system from `npm start` with no database server to install, while a larger venue can point
`DATABASE_URL` at a real PostgreSQL instance with no code changes. Tests run against real
PostgreSQL semantics in memory.

## Quick start (development)

```bash
npm install
cp .env.example server/.env      # adjust if needed
npm run db:migrate
npm run db:seed                  # demo devices, staff and sessions (development only)
npm run dev                      # API on :4000, dashboard on :5173
```

Step-by-step, verified commands (including the single-box production start):
[RUNNING.md](RUNNING.md).

Sign in with the seeded accounts (development only):

| Account | Password | Role |
| --- | --- | --- |
| `admin` | `ChangeMe123!` | Administrator |
| `riya` | `ChangeMe123!` | Staff |
| `arjun` | `ChangeMe123!` | Staff |

In production the first administrator is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`;
if no password is supplied one is generated and logged once.

### Single-box (recommended for the café)

```bash
npm run build
npm run db:seed --workspace server   # optional demo data
npm start --workspace server         # API + dashboard on http://<server>:4000
```

The server serves `web/dist` when it exists, so staff open one URL.

## Documentation

| Document | Contents |
| --- | --- |
| [RUNNING.md](RUNNING.md) | Setup → server up, ports, accounts, health check, startup errors |
| [docs/installation.md](docs/installation.md) | Prerequisites, PostgreSQL vs embedded, migrations, first run, systemd/NSSM service |
| [docs/windows-agent.md](docs/windows-agent.md) | Build, install, device registration, kiosk setup, enforcement boundaries |
| [docs/playstation.md](docs/playstation.md) | What is (and is not) supported, adapter contract, staff workflow |
| [docs/operations.md](docs/operations.md) | Offline policy, remote access, backup/restore, troubleshooting |
| [docs/security.md](docs/security.md) | Hardening checklist and known limitations |

## API

All routes are JSON under `/api` and require an authenticated session cookie (dashboard)
or a device bearer token (agent).

| Method | Route | Notes |
| --- | --- | --- |
| POST | `/api/auth/login` | rate limited, audited |
| POST | `/api/auth/logout` | revokes the token |
| GET | `/api/auth/me` | current user |
| POST | `/api/auth/password` | revokes other sessions |
| GET | `/api/dashboard/summary` | totals, active sessions, activity |
| GET/POST | `/api/devices` | list / create (admin) |
| GET/PATCH | `/api/devices/:id` | read / update (admin) |
| POST | `/api/devices/:id/maintenance` | toggle (admin) |
| POST | `/api/devices/:id/archive` \| `/restore` | soft delete / restore (admin) |
| POST | `/api/devices/:id/enrollment` | new one-time code (admin) |
| GET | `/api/devices/:id/history` | sessions + device + access events |
| GET/POST | `/api/sessions` | history / start |
| GET | `/api/sessions/active` | live sessions |
| GET | `/api/sessions/:id` | session + extensions + timeline |
| POST | `/api/sessions/:id/extend` | requires `idempotencyKey` |
| POST | `/api/sessions/:id/end` | requires `reason` |
| POST | `/api/agent/register` | one-time enrollment code → device token |
| POST | `/api/agent/heartbeat` | device auth; returns authorization |
| GET | `/api/agent/session-state` | device auth; authoritative state |
| POST | `/api/agent/events` | restriction applied/failed, sync |
| GET/POST | `/api/notifications…` | list, mark read, read all |
| GET/POST/PATCH | `/api/staff…` | roster, create, update, reset password |
| GET/PATCH | `/api/settings` | café policy |
| GET | `/api/audit` | admin only |
| GET | `/api/health` | worker + database status |

## Design decisions worth knowing

* **One place decides time.** `expires_at` is written by the server; the dashboard renders a
  countdown for humans but always refetches the authoritative value.
* **The database is the scheduler.** The worker claims rows with a single
  `UPDATE … WHERE status = 'ACTIVE' AND expires_at <= now()`; a crash, restart or second
  worker cannot expire a session twice. Notifications carry unique dedupe keys as a second
  gate.
* **Extensions are idempotent.** Every extension carries a client key with a unique index;
  a retry returns the original result instead of adding time again.
* **One active session per device is a database rule**, enforced by a partial unique index.
* **Operational status ≠ connectivity.** A PC can be "In session" and "Offline" at once —
  the dashboard shows both because staff need both.
* **Consoles are honest.** Retail PS5 has no verified remote lock, so those sessions are
  timed server-side and escalated to staff. Nothing pretends otherwise.
