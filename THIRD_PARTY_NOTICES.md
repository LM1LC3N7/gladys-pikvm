# Third-party notices

This integration is distributed under the Apache License 2.0 (see `LICENSE`).

## PiKVM HTTP API (protocol documentation)

- Source: the PiKVM documentation, "HTTP API" (https://docs.pikvm.org/api/), read on 2026-11-15
  (kvmd v4.235 was the latest tag of https://github.com/pikvm/kvmd that day).
- What was used: the routes (`/api/atx`, `/api/atx/power`, `/api/info`, `/api/auth/login`), the
  authentication headers, the two-factor rule (the code appended to the password) and the shapes of the
  answers, to write the client and the simulated PiKVM of the tests.
- kvmd itself is GPL-3.0 software that runs on the user's PiKVM. No code is copied or ported from it, and
  none of it is shipped in this image: the integration only calls its documented HTTP API over the network.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), installed from npm.
