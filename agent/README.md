# GameHub Windows Agent

Two components, by design:

| Component | Runs as | Job |
| --- | --- | --- |
| `GameHub.Agent.Service` | Windows service (SYSTEM or a dedicated service account) | Authenticates the PC, heartbeats every 15 s, holds the authoritative session state, and answers the interactive component over a named pipe. Never touches the customer's desktop directly. |
| `GameHub.Agent.SessionHost` | The **customer** Windows account, as its shell | Full-screen session UI: shows time remaining, launches the allowed shell when authorised, shows the lock screen when the session ends. |

Splitting them means the privileged network credential never lives in a user-writable
profile, and the interactive component never holds a device token.

## Build

```powershell
# Requires .NET SDK 8 on a Windows build machine
cd agent
dotnet publish GameHub.Agent.Service -c Release -r win-x64 --self-contained false
dotnet publish GameHub.Agent.SessionHost -c Release -r win-x64 --self-contained false
```

> **Status:** this repository was produced on a machine without the .NET SDK, so these
> projects have **not been compiled** here. Treat the agent as reviewed source, not as a
> tested binary, until `dotnet build` succeeds and it has been exercised on a real PC.
> The dashboard never claims a PC is locked until the agent reports
> `RESTRICTION_APPLIED` through `/api/agent/events`.

## Install

1. In the dashboard: **Devices → Add device** (type PC). Copy the one-time enrollment code.
2. On the PC, from an elevated PowerShell prompt:

   ```powershell
   .\install\install-agent.ps1 -ServerUrl http://192.168.1.10:4000 -DeviceId <device-id> -EnrollmentCode GHUB-XXXX-XXXX -KioskAccount "GameHubPlayer"
   ```

3. The script writes `C:\ProgramData\GameHub\agent.json`, installs the service, and
   configures the kiosk account's shell.
4. Sign in as the kiosk account: the session host opens and reports readiness.

## Offline behaviour

The service keeps the last server-issued authorization in memory and on disk:

* Session time keeps counting locally from `expiresAt` (the agent never invents time).
* If the server is unreachable, the current session continues to its expiry.
* After expiry with no server contact the PC enters a **controlled recovery state**: the
  lock screen stays up and shows "Reconnecting — ask staff".
* When contact returns, the agent re-reads `/api/agent/session-state` and follows it,
  including a fresh extension issued while offline.
* `graceSeconds` (per device, default 900) bounds how long a stale authorization may be
  trusted. It never grants *new* play time.

## Enforcement boundaries (read this before deploying)

* Enforcement relies on a **kiosk account whose shell is the session host**, that account
  being a standard user, and `Ctrl+Alt+Del`-level options being restricted by policy.
* The agent does **not** disable Windows security tools, kill arbitrary processes, modify
  customer data, or shut the machine down.
* A user with local administrator rights can bypass any shell-level restriction. Do not
  give customers administrator accounts. Combine with:
  * a separate local admin account used only by staff,
  * AppLocker/WDAC to allow-list the session host and games,
  * UAC left enabled, BitLocker on, and automatic sign-in only for the kiosk account.
* This is **not tamper-proof**. It is a deterrent plus an audit trail.
