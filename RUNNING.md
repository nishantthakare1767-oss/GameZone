# Running GameHub — setup to server up

Everything below was run against this repository. Copy-paste order matters only the first time.

---

## 0. TL;DR

```bash
npm install
npm run db:seed      # development demo data (optional)
npm run dev          # API :4000 + dashboard :5173
```

Open **http://localhost:5173** → sign in as `admin` / `ChangeMe123!`.

For the real café server instead of development mode: `npm run build` then `npm start --workspace server`, and open **http://localhost:4000**.

---

## 1. What you need

| Requirement | Notes |
| --- | --- |
| Node.js 20+ (24 tested) | `node --version` |
| npm 10+ | ships with Node |
| PostgreSQL 16–18 | **optional** — omit `DATABASE_URL` and the server uses embedded PostgreSQL (PGlite) stored on disk |
| .NET SDK 8 | only to build the Windows PC agent (`agent/`), not needed for the server |

No Docker, no external database and no internet connection are required at runtime.

---

## 2. One-time setup

Run every command from the repository root (`D:\New folder (2)` or wherever you cloned it).

### 2.1 Install dependencies

```bash
npm install
```

This installs all three workspaces (`server`, `web`, root tooling). Takes ~1 minute on a fresh machine.

### 2.2 Configure (optional, recommended)

```bash
# Windows PowerShell
Copy-Item .env.example server\.env

# macOS / Linux
cp .env.example server/.env
```

The server reads `.env` from **its own directory** (`server/.env`), not the repo root. With no
`.env` at all it still starts using defaults: port `4000`, embedded database in `server/data`,
dashboard origins `localhost:5173` and `localhost:4000`.

Settings you may want to change for a café server:

```ini
NODE_ENV=production
PORT=4000
DATABASE_URL=                 # empty = embedded PostgreSQL; or postgres://user:pass@host:5432/gamehub
COOKIE_SECURE=false           # true only when served over HTTPS
CORS_ORIGIN=http://localhost:4000,http://192.168.1.10:4000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=               # blank in production = generated once and printed to the log
```

Never commit `server/.env` — it is git-ignored.

### 2.3 Create / update the database

> **Stop the server before any `db:*`, `backup` or `restore` command** when using the embedded
database. It is a single-process engine and refuses a second connection with
*"already in use by PID …"*. With external PostgreSQL this restriction does not apply.

```bash
npm run db:migrate
```

Applies the SQL migrations in `server/drizzle/`. Safe to run repeatedly; it is also applied
automatically every time the server starts.

### 2.4 Create the first accounts

```bash
npm run db:seed
```

* Creates an administrator if none exists (`admin`).
* In development only, adds demo staff (`riya`, `arjun`), 8 PCs and 2 consoles with realistic
  sessions, plus one-time enrollment codes printed to the console.
* Refuses to seed demo data when `NODE_ENV=production`.

Administrator only, no demo data:

```bash
npm run db:seed --workspace server -- --bootstrap-only
```

In production, if `ADMIN_PASSWORD` is empty, the generated password is printed **once** in the
server log under `seed.admin_created_generated_password` — sign in and change it immediately.

---

## 3. Start the server

### Option A — development (hot reload, two ports)

```bash
npm run dev
```

* API + worker: **http://localhost:4000**
* Dashboard (Vite, hot reload): **http://localhost:5173** (proxies `/api` and `/socket.io` to 4000)

Vite binds IPv6 `localhost`; use `http://localhost:5173`, not `http://127.0.0.1:5173`.

Stop with `Ctrl+C` in that terminal.

### Option B — single-box server (one URL, production-shaped)

```bash
npm run build
npm start --workspace server
```

* Dashboard **and** API on **http://localhost:4000** (the server serves `web/dist`)
* Re-run `npm run build` after changing frontend code; the API alone needs `npm start` only.

To reach it from other devices on the café LAN, open `http://<server-ip>:4000` and add that
origin to `CORS_ORIGIN` (same-origin requests are always allowed, so this is only needed for
cross-origin dashboards).

---

## 4. Sign in

| Account | Password | Role | Exists when |
| --- | --- | --- | --- |
| `admin` | `ChangeMe123!` | Administrator | development seed |
| `riya` | `ChangeMe123!` | Staff | development seed |
| `arjun` | `ChangeMe123!` | Staff | development seed |
| `admin` | value of `ADMIN_PASSWORD`, or the generated one in the log | Administrator | production bootstrap |

Change the password from **Staff → Reset password** (or `POST /api/auth/password` for your own)
and create one account per staff member rather than sharing the admin login.

---

## 5. Confirm it is running

```bash
curl http://localhost:4000/api/health
```

Healthy response:

```json
{"ok":true,"serverTime":"2026-10-27T05:40:00.000Z","timezone":"Asia/Kolkata",
 "database":"pglite","expiryWorker":{"lastRunAt":"…","lastStatus":"OK","lastProcessed":0}}
```

* `lastStatus: "OK"` and a `lastRunAt` within the last 60 s means the expiry worker is alive.
* The dashboard's **Settings → System health** shows the same values.
* If the dashboard loads but stays empty, check `/api/auth/me` — you are probably signed out.

---

## 6. Stop and restart

| | Development | Single-box |
| --- | --- | --- |
| Stop | `Ctrl+C` | `Ctrl+C` (or stop the service) |
| Restart | `npm run dev` | `npm start --workspace server` |
| After a frontend change | automatic | `npm run build` then restart |

Sessions, timers and notifications survive restarts — they live in the database, not in memory.
On startup the worker immediately processes anything that expired while the server was down.

Always stop with `Ctrl+C` (or the service manager) rather than killing the process: the
embedded PostgreSQL engine needs a clean shutdown. Forced kills can leave `server/data/pglite`
unusable until it is recreated or restored from backup — another reason to run PostgreSQL and
nightly backups in a real venue.

---

## 7. Where things live

| Path | Contents |
| --- | --- |
| `server/.env` | local configuration (git-ignored) |
| `server/data/pglite/` | embedded database when `DATABASE_URL` is empty (git-ignored, back this up) |
| `server/drizzle/` | SQL migrations |
| `backups/` | output of `npm run backup` |
| `web/dist/` | built dashboard served by the API in single-box mode |

PostgreSQL instead of embedded: set `DATABASE_URL=postgres://user:pass@127.0.0.1:5432/gamehub`
in `server/.env` and run `npm run db:migrate`. Same schema, same SQL, same migrations.

---

## 8. Everyday commands

| Command | Does |
| --- | --- |
| `npm run dev` | API + dashboard with hot reload |
| `npm run build` | typecheck + build server and dashboard |
| `npm start --workspace server` | run the built server (serves the dashboard) |
| `npm test` | 72 server tests (in-memory PostgreSQL, fake clock) |
| `npm run typecheck` | TypeScript checks for both workspaces |
| `npm run db:migrate` | apply pending migrations |
| `npm run db:seed` | development demo data |
| `npm run backup` | compressed JSON snapshot into `backups/` |
| `npm run restore -- <file>` | restore a snapshot (stop the server first) |

---

## 9. If startup fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| `EADDRINUSE` / port 4000 busy | another instance is running | `netstat -ano | findstr :4000` → stop that PID, or change `PORT` |
| Server starts but the browser cannot reach it | you opened `127.0.0.1` while it listens on `localhost` (IPv6), or a firewall blocks the LAN IP | use `http://localhost:4000`, or allow Node through the firewall |
| Dashboard shows `403 CORS_DENIED` | dashboard origin not allowed | add it to `CORS_ORIGIN`; same-origin is always allowed |
| Login says "Too many attempts" | 20 attempts/minute rate limit | wait a minute |
| `The .env file has no effect` | it is in the repo root instead of `server/` | move it to `server/.env` |
| `Port 0` in the startup log | your shell exports `PORT=0` | set `PORT=4000` in `server/.env` (the server already ignores `0`) |
| `already in use by PID …` | a server or CLI already holds the embedded database | stop that process, or switch to PostgreSQL |
| `Could not open the embedded database …` after a crash or `taskkill /F` | the embedded database was not shut down cleanly | restore a backup, or move `server/data/pglite` aside and re-run `npm run db:migrate` + `npm run db:seed` |
| `npm : command not found` | Node not installed / not on PATH | install Node 20+ |
| Demo data missing after seeding | `NODE_ENV=production` | seeding demo data is refused in production by design |

Full operational detail: [docs/operations.md](docs/operations.md). Installation for a real venue
(service registration, hardened config): [docs/installation.md](docs/installation.md).
