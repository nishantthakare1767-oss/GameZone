# Security hardening & known limitations

## Implemented controls

| Control | Where |
| --- | --- |
| Password hashing | scrypt (N=16384, r=8, p=1) in `auth/password.ts` |
| Password policy | ≥10 chars, upper + lower + digit, enforced on create/change/reset |
| Session tokens | 32-byte random, stored as SHA-256 hashes, httpOnly cookie, 12 h TTL, revocable |
| Session revocation | logout, deactivation, password change/reset revoke all tokens |
| Authorization | `requireAuth` / `requireAdmin` on the server; the UI only hides what the API also denies |
| Device auth | hashed bearer tokens, one active credential per device, rotation revokes the old token |
| Device enrollment | one-time code, 60-minute expiry, hashed at rest |
| Login throttling | 20 attempts/minute/IP |
| Input validation | zod schemas on every mutating route and on query params |
| SQL injection | Drizzle parameterised queries only |
| Headers | helmet (CSP in production, no sniffing, no framing) |
| CORS | same-origin always allowed; everything else must be listed |
| Audit | every privileged action with actor, target, outcome, IP |
| Idempotency | unique keys on extensions, dedupe keys on notifications |
| Data minimisation | only an optional nickname; no payment data, no identity documents |
| Secrets | environment variables only; no credentials in the repository |
| Agent token at rest | DPAPI machine scope, ACL-restricted folder |

## Hardening checklist for a real café

- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true` behind TLS.
- [ ] Change the bootstrap admin password; create one staff account per person.
- [ ] Keep `ADMIN` for one or two people; front desk gets `STAFF`.
- [ ] Restrict dashboard access to the LAN and a VPN/tunnel — never port-forward 4000.
- [ ] Put the café server on a separate VLAN from customer Wi-Fi where possible.
- [ ] Windows: kiosk account is a **standard user**; staff have a separate admin account.
- [ ] Enable BitLocker on the server and on gaming PCs.
- [ ] Allow-list apps with AppLocker/WDAC on kiosk accounts.
- [ ] Run the agent service under a dedicated account, not a domain admin.
- [ ] Schedule nightly backups and **test a restore** quarterly.
- [ ] Review the audit log weekly for `DENIED` entries.
- [ ] Rotate device enrollment codes if a PC is re-imaged or sold.
- [ ] Keep Node.js, PostgreSQL and .NET patched.
- [ ] Confirm NTP is enabled so countdowns and audit timestamps agree.

## Threat model summary

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Customer extends their own session | No client authority; extension requires an authenticated staff request | none in-app |
| Customer bypasses the lock | kiosk shell + standard user | local admin can bypass — accept and monitor |
| Staff misuse | roles, audit trail, per-action actor | collusion between staff is out of scope |
| Stolen dashboard cookie | httpOnly, TLS, 12 h TTL, revocation | physical access to an unlocked desk PC |
| Stolen device token | DPAPI at rest, rotation, revocation on archive | admin access to the PC's machine store |
| Duplicate expiry/extension | DB-level idempotency and dedupe keys | none observed in tests |
| Database loss | nightly backups, tested restore | up to 24 h of history if the disk dies |
| Remote attacker | no inbound exposure, VPN/tunnel + Access policy | misconfiguration |

## Known limitations

1. **Windows agent is unbuilt/unverified in this environment.** No .NET SDK was available.
   Compile it and test on a managed PC before claiming PC enforcement works.
2. **Not tamper-proof.** Shell-level restriction stops ordinary customers, not local
   administrators. There is no anti-cheat or kernel driver.
3. **PlayStation automation is not implemented** beyond a pluggable, explicitly unverified
   HTTP bridge; retail consoles have no supported remote lock.
4. **`Ctrl+Alt+Del` cannot be blocked** by user-mode software. Use Windows policy.
5. **No push notifications** — alerts are in-dashboard with an optional browser chime.
6. **No multi-venue tenancy.** One café, one installation (multiple sites = multiple
   servers with separate databases).
7. **No billing, by design.** Prices, invoices and cash handling are intentionally absent.
8. **PGlite mode is single-process.** Two server processes must not point at the same
   embedded data directory; use PostgreSQL for any multi-instance setup.
9. **Timezone display is fixed to Asia/Kolkata** (configurable only by code change today).
10. **Browser UI has no automated end-to-end test suite** — server behaviour is covered by
    72 API/integration tests; the UI was exercised manually against a live server.
