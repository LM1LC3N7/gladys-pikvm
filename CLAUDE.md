# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It drives the ATX power of the machine wired to a
PiKVM through the kvmd HTTP API (https://docs.pikvm.org/api/). kvmd is GPL-3.0:
call its API, never copy nor port its code.

## Commands

```bash
npm install
gi test                                   # or npm test (node --test --test-timeout=60000)
node --test test/commands.test.js         # one file (through memcap on the dev VM)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run cover                             # cover.png (800x534), plain Node
memcap node scripts/mutants.mjs "$(mktemp -d)"   # mutants of the guards, one at a time
```

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/app.js                        PikvmApp: lifecycle, reads, buttons, kept shutdown, config buttons
src/kvmd.js                       kvmd client on a pinned TLS socket, answers, 2FA login
src/devices.js                    the Gladys device (pure)
src/store.js                      /data: pins, refused-credentials mark, pause, stop guard, kept shutdown
src/config.js                     DEFAULT_CONFIG (mirrors the manifest) + normalization
src/i18n.js                       texts in English and French
test/helpers/fakePikvm.js         simulated PiKVM (HTTPS) on 127.0.0.1
test/kit/                         parts of gladys-testkit (clocks, certificates)
scripts/mutants.mjs               mutants of the guards (list and runner)
```

## Safety rules of this integration

- **Shut down is protective** (kvmd `off`: a short press, nothing when the
  machine is off): no option, not held back by a pause, a read or a command in
  flight. Refused only without a usable path (config error, no pin, refused
  credentials, 2FA without session). Retried within the 3.5 s ack budget when
  not taken (409, 5xx, 429, not sent); then kept in /data (2 min, 3 answered
  sends) and sent again only by its own reads (every 10 s) that show the
  machine on; dropped by any read showing it off. A send that left without an
  answer is never sent again.
- **Power on, Force power off, Reset are off by default** (one option each),
  `button`/`push` features, never a switch. Each decides on a read of the ATX
  made after the click, is checked again right before the first byte
  (`beforeSend`: option, stop count, pause, stop guard, deadline), runs one at
  a time, one per 30 s, and leaves within 3.5 s or not at all. Power on and
  Reset are refused for 60 s after a shutdown or forced power off (guard in
  /data).
- **A kept shutdown never goes over a newer Power on / Reset** (dropped in
  their `beforeSend`, `startMark` checked before its send), nor through a
  client of an older configuration (credentials frozen per client).
- **Nothing sent before a stop leaves after it**: the stop count (`epoch`) is
  checked after the read and in `beforeSend`.
- The password goes only to the configured address, in the kvmd headers, on a
  connection whose certificate is the pinned one, checked before the first
  byte; never logged, never in /data, a status nor an error. The 2FA token
  lives in memory only; the code is never kept. The first certificate is
  trusted on two clicks (or typed); a changed one is never learnt alone.
- A 403 on the ATX read with the headers refuses the credentials (6-bit mark
  in /data); a 401/403 on `/api/info` or a command never does.
- Clocks: monotonic for every decision; wall time only for /data.

## Rules

- **External ids are forever**: `pikvm:<address id>` (config.js `addressId`),
  built with `gladys.externalIds`. The same goes for the manifest keys and the
  feature keys (`power`, `hdd`, `pikvm_temperature`, `power_on`, `shutdown`,
  `force_off`, `reset`).
- **A device published again never loses a feature** (`withCreatedFeatures`).
- **The container rootfs is read-only**: write only under `/data`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  that package.json, the lock and the manifest agree.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), docs in sync with
  the code.
- **Tests never touch the network** beyond 127.0.0.1; every wait is bounded
  (a test fails, it never hangs).
