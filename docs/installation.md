# Installation

## Prerequisites

| Component | Version | Notes |
| --- | --- | --- |
| Node.js | 20 or newer (24 tested) | server + dashboard build |
| PostgreSQL | 16–18 | optional; embedded PGlite is used when `DATABASE_URL` is empty |
| Windows (server) | 10/11 or Server 2019+ | the café box may also be a Linux host |
| .NET SDK | 8 | only for building the PC agent |

## 1. Install dependencies

```bash
npm install
```

This installs both workspaces (`server`, `web`).

## 2. Configure

Copy `.env.example` to `server/.env` (the server loads `.env` from its working directory):

```bash
cp .env.example server/.env
```

Minimum for a local café server:

```ini
NODE_ENV=production
PORT=4000
DATABASE_URL=            # empty → embedded PostgreSQL in DATA_DIR/pglite
DATA_DIR=./data
COOKIE_SECURE=false      # true when served over HTTPS
CORS_ORIGIN=http://localhost:4000,http://192.168.1.10:4000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=          # blank → generated once, printed in the log
```

Never commit `server/.env`. It is git-ignored.

## 3. Database

### Option A — embedded PostgreSQL (zero install, recommended for one venue)

Leave `DATABASE_URL` empty. On first start the server creates `DATA_DIR/pglite`, applies
all migrations from `server/drizzle` and keeps running through restarts. Back it up with
`npm run backup`.

### Option B — external PostgreSQL

```sql
CREATE DATABASE gamehub;
CREATE USER gamehub WITH PASSWORD '…';
GRANT ALL PRIVILEGES ON DATABASE gamehub TO gamehub;
```

```ini
DATABASE_URL=postgres://gamehub:…@127.0.0.1:5432/gamehub
```

### Migrations

Migrations are plain SQL in `server/drizzle/*.sql` and are applied automatically at boot.

```bash
npm run db:migrate          # apply pending migrations
npm run db:generate         # after editing server/src/db/schema.ts
```

Migrations are additive and safe to re-run; `drizzle-kit` tracks what has run in
`drizzle.__drizzle_migrations`.

### Seed data

```bash
npm run db:seed              # demo devices/staff/sessions — development only
npm run db:seed --workspace server -- --bootstrap-only   # administrator account only
```

`seedDevelopment` refuses to run when `NODE_ENV=production`.

## 4. Build and start

```bash
npm run build
npm start --workspace server
```

* `http://<server-ip>:4000` → dashboard (served from `web/dist`)
* `http://<server-ip>:4000/api/health` → liveness + worker status

For development with hot reload: `npm run dev` (API 4000, Vite 5173 with proxy).

## 5. Run as a Windows service

Use NSSM (or `sc.exe` with a wrapper):

```powershell
nssm install GameHub "C:\Program Files\nodejs\node.exe" "C:\gamehub\server\dist\index.js"
nssm set GameHub AppDirectory C:\gamehub\server
nssm set GameHub AppEnvironmentExtra NODE_ENV=production
nssm start GameHub
```

`sc.exe` alternative: create the service pointing at `node.exe` with the same arguments and
set `AppDirectory` via the registry, or use Task Scheduler "At startup".

## 6. Run as a systemd service (Linux)

```ini
# /etc/systemd/system/gamehub.service
[Unit]
Description=GameHub Control Center
After=network.target postgresql.service

[Service]
Type=simple
User=gamehub
WorkingDirectory=/opt/gamehub/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now gamehub
```

## 7. First sign-in checklist

1. Sign in as the administrator.
2. **Settings → Session policy**: set durations, warning thresholds and offline grace.
3. **Staff**: create a staff account for the front desk (do not share the admin login).
4. **Staff → reset password** on the admin account if a generated password was used.
5. **Devices**: add each PC (copy the enrollment code) and each console.
6. Install the Windows agent on each PC (see [windows-agent.md](windows-agent.md)).
7. Schedule backups (see [operations.md](operations.md)).
