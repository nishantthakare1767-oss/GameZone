# Operations

## Offline policy

| Scenario | Behaviour |
| --- | --- |
| Internet down, café LAN up | Everything keeps working locally: dashboard, sessions, expiry, agent heartbeats. Only remote access is affected. |
| PC loses contact with the café server | The agent keeps the current session running to its **server-issued expiry**. It retries every 5 s. |
| Silence longer than `graceSeconds` (default 900, per-device override) | The station shows a **controlled recovery** lock ("Reconnecting… ask staff"). No new play time. |
| Contact restored | The agent re-reads `/api/agent/session-state`; an extension granted meanwhile takes effect immediately. |
| Café server restarted | On boot the worker immediately processes everything overdue, writes one notification per session (dedupe keys) and emits a `SERVER_RECOVERY` alert if anything was recovered. |
| Server down for hours | PCs lock at their local expiry; the dashboard is unavailable until the server returns; no time is silently extended. |

Nothing in the offline path grants extra play time — the grace window only decides how long
the *existing* authorization is trusted.

Optional stricter mode: **Settings → "Block sessions when a PC agent is offline"**. With it
on, staff cannot start a session on a PC whose agent is not heartbeating.

## Remote administration

The local API must never be exposed directly to the internet. Choose one:

### Option A — WireGuard / Tailscale (recommended)

* Install Tailscale (or WireGuard) on the café server and on each admin device.
* Reach the dashboard at `http://<tailscale-ip>:4000`.
* No port forwarding, no public listener. Access is bound to your tailnet identity.
* Keep `COOKIE_SECURE=false` for plain HTTP-over-tailnet, or terminate TLS (Option C) and
  set it to `true`.

### Option B — Cloudflare Tunnel (or similar outbound tunnel)

* `cloudflared tunnel --url http://127.0.0.1:4000` as a Windows service.
* Put Cloudflare Access in front of the hostname so only your staff emails can reach it.
* Set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.

### Option C — reverse proxy with TLS

* Caddy/nginx on the café server with a real certificate, proxying to `127.0.0.1:4000`.
* Set `TRUST_PROXY=true`, `COOKIE_SECURE=true`, and add the public origin to `CORS_ORIGIN`.

**Never** open port 4000 on the router. **Never** disable the login rate limit to "make it
work" — fix the network path instead.

Features that need internet: remote dashboard access, optional console bridge. Everything
else (sessions, timers, agent control, notifications) is local.

## Backup and restore

### Automatic (recommended)

Windows Task Scheduler, nightly:

```powershell
schtasks /create /tn "GameHub Backup" /sc daily /st 04:00 /ru SYSTEM ^
  /tr "cmd /c cd /d C:\gamehub && npm run backup"
```

Linux cron:

```cron
0 4 * * * cd /opt/gamehub && /usr/bin/npm run backup >> /var/log/gamehub-backup.log 2>&1
```

`npm run backup` writes `backups/gamehub-<timestamp>.json.gz` containing every table.
Keep at least 7 daily copies, ideally on another machine. Stop the server first when using
the embedded database — the CLI refuses to open a database that the server is holding.

### Restore

```bash
npm run restore -- ./backups/gamehub-2026-03-01T04-00-00-000Z.json.gz
```

The restore truncates and reloads all tables in foreign-key order, preserving ids and
timestamps. **Stop the server first** so nothing writes during the restore, then restart —
active sessions and their remaining time are preserved exactly.

### Physical backup (external PostgreSQL)

```bash
pg_dump --format=custom --file=gamehub.dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" gamehub.dump
```

## Monitoring

* `GET /api/health` → database kind, expiry worker last run/status/processed count.
  Poll it from your monitoring tool; alert if `lastRunAt` is older than 60 s.
* The dashboard's **Settings → System health** shows the same data.
* Audit log (`/api/audit`, admin only) records every privileged action.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| PCs show **Offline** | agent not installed / wrong server URL / firewall | check `GameHubAgent` service, `agent.json`, and that the PC can reach `http://server:4000/api/health` |
| PC shows **Never connected** | enrollment code never used | re-issue the code from **Devices → Manage** and re-run the installer |
| Enrollment says *Invalid or expired code* | code already used or older than 60 min | issue a new code |
| Sessions expire but PC stays unlocked | session host not running as the kiosk shell | verify the `Winlogon\Shell` value and that the account is the one signed in |
| Dashboard stuck at **Restricted** after a new session started | agent offline | the next heartbeat clears it; check the agent log |
| `EADDRINUSE` on start | another instance running | `netstat -ano | findstr :4000`, stop the old process |
| Login says *Too many attempts* | rate limiter (20/min) | wait a minute; do not disable it |
| `HTTP 403 CORS_DENIED` | dashboard opened from an origin not in `CORS_ORIGIN` | add the origin (same-origin is always allowed) |
| `already in use by PID …` | a second process (server or CLI) opened the embedded database | stop it; the CLI must not run while the server holds `server/data/pglite` |
| `Could not open the embedded database …` after a forced kill or power loss | embedded PostgreSQL was not shut down cleanly | restore a backup, or move `server/data/pglite` aside and re-run `npm run db:migrate` + `npm run db:seed`. Prefer real PostgreSQL for production |
| Restore fails with foreign key errors | server was running during restore | stop the server, restore, start |
| Worker `lastStatus: ERROR` | database unavailable | check the server log; the worker retries every 5 s |

Logs are JSON lines on stdout (and the Windows service log). Never paste tokens or
passwords from logs into chat or tickets.
