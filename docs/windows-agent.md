# Windows PC agent

The agent is two processes:

| Process | Account | Responsibility |
| --- | --- | --- |
| `GameHub.Agent.Service` | Windows service (SYSTEM or dedicated service account) | Device authentication, heartbeat, authoritative session state, named-pipe server |
| `GameHub.Agent.SessionHost` | The kiosk customer account (its shell) | Countdown, launching the allowed shell, lock screen, acknowledgement |

Only the service holds the device token (DPAPI machine-scope). The kiosk account can ask
for state and acknowledge a lock — it can never grant time.

> **Build status:** the source in `agent/` was produced on a machine without the .NET SDK,
> so it has **not been compiled or run**. Compile and test it on a managed test PC before
> describing PC enforcement as working. Until then the dashboard reports PCs as
> "Waiting for the agent to confirm the lock".

## Build

```powershell
cd agent
dotnet restore
dotnet publish GameHub.Agent.Service -c Release -r win-x64 --self-contained false -o out/service
dotnet publish GameHub.Agent.SessionHost -c Release -r win-x64 --self-contained false -o out/sessionhost
```

## Device registration

1. Dashboard → **Devices → Add device** → type *Windows PC*.
2. Copy the **enrollment code** (single use, expires in 60 minutes) and the **device ID**.
3. Install with both values:

```powershell
.\install\install-agent.ps1 `
  -ServerUrl http://192.168.1.10:4000 `
  -DeviceId  6f1c2a7e-... `
  -EnrollmentCode GHUB-1A2B-3C4D `
  -KioskAccount GameHubPlayer
```

The script:

* copies binaries to `C:\Program Files\GameHub`,
* writes `agent.json` with the device id and server URL,
* registers and starts the `GameHubAgent` service,
* sets the kiosk account's `Winlogon\Shell` to the session host,
* grants the service account write access to `C:\ProgramData\GameHub`.

Rotate or revoke credentials any time from **Devices → Manage → Issue enrollment code**.

## Kiosk account setup (required for enforcement)

1. Create a **standard user** `GameHubPlayer` — never an administrator.
2. Enable automatic sign-in for that account only (or staff sign in manually).
3. Set the session host as its shell (the installer does this).
4. Set `GAMEHUB_LAUNCHER` (machine environment variable) to the game launcher the customer
   should get, e.g. `C:\Program Files (x86)\Steam\steam.exe`.
5. Optional but recommended hardening:
   * remove the kiosk account from any admin group,
   * hide drives and the Run dialog via policy,
   * block `Ctrl+Alt+Del` options for the kiosk account (Windows policy
     `Interactive logon: Do not display last user name`, `Remove Task Manager`),
   * AppLocker/WDAC allow-list for the games and the session host,
   * keep UAC enabled.
6. Test: start a 2-minute session from the dashboard, watch the PC, then let it expire.

## Behaviour

* Heartbeat every 15 s; the server responds with the authoritative state.
* Session time is computed from `expiresAt`, so a clock that drifts still ends on time
  relative to the server's last answer (NTP recommended).
* On expiry, or on a server state of `EXPIRED`/`DISABLED`/`MAINTENANCE`, the session host
  shows the lock screen and sends `ACK RESTRICTED <sessionId>`; the service forwards that
  as `RESTRICTION_APPLIED`, and only then does the dashboard show **Restricted**.
* If the session host cannot lock (crash, user killed it), no acknowledgement arrives; the
  dashboard keeps showing "expired, awaiting lock" and raises an agent-error alert.
* The agent never kills processes, wipes data, disables Windows security or shuts down.

## Offline

See [operations.md](operations.md#offline-policy). Short version: the current session
continues locally to its expiry, the agent keeps checking every 5 s, and after
`graceSeconds` of silence the station shows a "reconnecting" lock until the server returns.

## Uninstall

```powershell
.\install\uninstall-agent.ps1 -KioskAccount GameHubPlayer
```

Restores `explorer.exe` as the kiosk shell and removes the service. Add `-KeepData` to
retain the local token folder.

## What this is not

Not tamper-proof. A local administrator can bypass a shell-level restriction. The design
goal is: an ordinary customer, using the kiosk account, cannot start or extend play without
staff — plus a full audit trail of what actually happened.
