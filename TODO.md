# TODO — PiKVM v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-11-15): kvmd client on a pinned TLS socket
      (headers auth, 2FA login, envelope, bounded answers), one device (LEDs,
      temperature, four buttons), Shut down protective with a kept shutdown,
      guarded Power on / Force power off / Reset, refusal mark, 429/5xx pause,
      last read in /data, two-click certificate trust, docs en/fr. Tested
      against the SDK's fake Gladys and a simulated PiKVM over HTTPS on
      127.0.0.1. **Never tested with a real PiKVM.**

## Decisions

- **Version 0.1.0** set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-pikvm:0.1.0`);
  the first release (patch) gives 0.1.1.
- **Reference**: the official PiKVM API documentation
  (https://docs.pikvm.org/api/), kvmd v4.235 (GPL-3.0, latest tag on
  2026-11-15). Only the documented HTTP API is called; nothing of kvmd is read
  as code, copied or ported. Notice in `THIRD_PARTY_NOTICES.md`.
- **Shut down = kvmd `off`** (POST /api/atx/power?action=off), not
  `/api/atx/click?button=power`: `off` does nothing when the power LED is off,
  so a shutdown can never turn the machine on. Power on = `on` (nothing when
  already on), Force power off = `off_hard`, Reset = `reset_hard`. Always
  `wait=0`: answered once the press started (an `off_hard` lasts 5 s+).
- **Protective vs guarded** (lot 24 brief): Shut down needs no option; Power
  on, Force power off and Reset are off by default. Force power off cancels
  what waits (it is a stop) but needs its option (data loss).
- **Kept shutdown, no blind replay**: a shutdown is a press of the power
  button, close to a movement. Kept only when never taken (409, 5xx, 429, not
  sent); resent only by a read made after the click showing the machine on,
  2 min and 3 answered sends at most, also after a restart (it waits for the
  configuration and a read, never sent from /data alone). A send without an
  answer is never resent (a second press could be taken by the OS).
- **Review r1 (I1)**: every client (session, shutdown, kept shutdown) freezes
  the address, pin and credentials of the configuration it was built on; a
  kept shutdown is worked on only while that same configuration is current,
  and a shutdown whose tries end after another address was saved is not kept.
- **Review r1 (I2), safest rule chosen**: a Power on or Reset whose first
  byte leaves (`beforeSend`, answered or not) drops the kept shutdown at once,
  and `workStop` compares the start counter (`startMark`) after its read and
  again in the `beforeSend` of its own send, at the first byte (after the TLS
  handshake; review r2, I2b); the read of a guarded command goes through `considerPending` too. The
  latest click wins, a shutdown is never sent over a machine that may be
  starting. The unused general `counter` is removed. The status says when a
  Power on or Reset dropped the kept shutdown.
- **Accepted gap with the fiche (review r2)**: the fiche says a 4xx, 429 or
  redirection does not count as "left". Here a Power on or Reset whose first
  byte was written drops the kept shutdown even when kvmd then refuses it
  (409 busy, 400): resuming a shutdown more than 60 s old after the user asked
  for a Reset would go against the latest intent, and a machine left on is no
  danger. The status tells the user the kept shutdown was dropped.
- **Another address saved drops the kept shutdown** (review r2, m2): it never
  comes back when the old address is saved again.
- **Stop guard 60 s** after a shutdown or forced power off (Power on and Reset
  refused), set in memory before the first byte, written to /data in the
  background: a failed /data write never holds back a shutdown; after a
  restart within 60 s with a failed write, the guard is lost (the fresh read still
  applies; the 30 s spacing is in memory only and starts again at a restart).
- **2FA**: kvmd needs the current code appended to the password; with
  per-request headers that would need the TOTP secret, which is not kept. So a
  configuration-screen action takes the code once and opens a session
  (`POST /api/auth/login`); the token lives in memory only (never /data). A
  restart of the container asks for a new code. With 2FA and no session,
  nothing can be sent, Shut down included (documented).
- **Identity**: the device id comes from the address typed (`addressId`); the
  pinned certificate makes sure each request reaches the same PiKVM. A
  reinstalled PiKVM (new certificate) needs the two-click trust again.
- **Credentials**: printable ASCII only (they travel in HTTP headers; Node
  refuses other bytes there). Only a 403 on `/api/atx` with the headers
  refuses them; a 401 is "not taken" (a proxy may drop the headers).
- **LED values**: published only when `enabled` is true and the value is a
  boolean; otherwise unknown (never 0).
- **Feature categories**: LEDs as `unknown`/`binary` read only (as
  gladys-esxi); temperature `temperature-sensor`/`decimal` in °C; buttons
  `button`/`push`.
- **Categories**: `servers`, `network`. No `keywords` (rule). World-wide (no
  `countries`).
- **CI**: `timeout-minutes` added to the jobs of `.github/workflows/ci.yml`
  (a hanging test never holds a runner).

## Next

- Test with a real PiKVM (v3/v4, with and without the ATX board; 2FA).
- Check the error statuses of kvmd for a busy ATX (409 assumed, any 4xx is
  "not done") and for a disabled ATX.
- Maybe: `/api/atx/click` buttons, the MSD and GPIO (out of v1).
- [ ] r3 mineurs : test du contrôle « même arrêt gardé » dans beforeSend (app.js:1273, scénario s10 de pikvm-r3-scen), test de l'annulation traitée comme panne (app.js:1286).
