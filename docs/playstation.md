# PlayStation integration

## The honest starting point

Retail PlayStation 5 consoles expose **no public API** for remote session control,
application termination or screen locking. Anything that claims otherwise is either:

1. a commercial venue-management product with its own signed API and hardware, or
2. screen-scraping / automation of the console UI, which is fragile and unsupported.

GameHub therefore ships with a **manual (staff-assisted) adapter** as the default and
never claims a console was locked when it was not.

## What the system does for consoles today

* Devices of type `PLAYSTATION` are created with `controlMode = MANUAL`.
* Sessions have the same server-authoritative timer as PCs.
* At 5 minutes and 1 minute the dashboard raises warnings; at expiry it writes
  `SESSION_EXPIRED` and `STAFF_ASSIST_REQUIRED` notifications.
* The console card shows **"staff-assisted enforcement"** and the session is marked
  `requiresStaffEnforcement` everywhere it appears (cards, active sessions, history).
* Expiry does **not** create a fake "restricted" state. The device shows *Time expired*
  until staff end play and start a new session or clear the station.
* Session history records exactly what happened and who acted.

## Adapter interface

`server/src/integrations/playstation.ts`

```ts
interface PlayStationAdapter {
  capabilities: { automaticLock; verified; connectivity; appControl };
  status(device): Promise<{ reachable; detail; checkedAt }>;
  restrict(device, sessionId): Promise<{ ok: boolean; message: string }>;
  release(device, sessionId): Promise<{ ok: boolean; message: string }>;
}
```

Implementations:

| Adapter | Automatic lock | Verified | Notes |
| --- | --- | --- | --- |
| `ManualEnforcementAdapter` | no | yes (behaviour) | Default. No console network access needed. |
| `HttpBridgeAdapter` | yes | **no** | Calls your venue bridge: `POST {baseUrl}/sessions/restrict` and `/release`, `GET /health`. |

### Using the HTTP bridge

Only if you already run a supported venue-management bridge (for example the middleware
that ships with a commercial console-management product):

1. **Settings → PlayStation integration → Adapter → Venue bridge over HTTP**.
2. Enter the bridge base URL (LAN address).
3. Put the API key in the server environment as `PS_BRIDGE_API_KEY` — never in the
   database, never in the repository.
4. Test on a **spare console**: start a 2-minute session and confirm the console actually
   blocks. Then check the session's access-control events on the device history page.

The dashboard keeps the integration status as `UNVERIFIED` until you change it manually
after your own test — the software will not claim verification for you.

## Adding another supported mechanism

1. Implement `PlayStationAdapter` in a new file under `server/src/integrations/`.
2. Return `capabilities.automaticLock = true` only if it truly blocks play.
3. Register it in `resolveAdapter()` and add the option to the settings dropdown.
4. Record the result of every restrict/release in `access_control_events` (the agent
   events endpoint already models this for PCs; the bridge adapter should do the same).
5. Update this document with what you verified, on which hardware and firmware.
