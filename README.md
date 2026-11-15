# gladys-pikvm

[Gladys Assistant](https://gladysassistant.com) external integration for the
**PiKVM** IP-KVM: the ATX power of the machine wired to it (power on, shut
down, forced power off, reset), its power and disk LEDs, and the PiKVM
temperature, through the local HTTPS API of the PiKVM (kvmd), with the
certificate pinned on the user's confirmation.

Unofficial, not affiliated with PiKVM. **Never tested with a real device yet.**

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Access: a user of the PiKVM web interface (headers `X-KVMD-User` /
  `X-KVMD-Passwd`); with two-factor authentication, a session opened by a
  button with the current code, kept in memory only.
- Safety: Shut down (a short press of the power button) is never held back by
  an option, a pause, a read or a command in flight; Power on, Force power off
  and Reset are off by default (one option each), decided on a fresh read of
  the power LED, one per 30 s, never as a switch.

## Development

```bash
npm install
gi test    # or: npm test (node --test --test-timeout=60000)
gi ci      # format, lint, tests on Node 24 and 22, Docker build, store validator
```

The tests run against the SDK's fake Gladys and a simulated PiKVM on
127.0.0.1 (HTTPS with a self-signed certificate), never the network. See
`CLAUDE.md` for the architecture and the rules, `TODO.md` for the decisions
and what comes next.

## License

Apache-2.0 (`LICENSE`). Written from the official PiKVM API documentation;
kvmd (GPL-3.0) is only called over the network, none of its code is here. See
`THIRD_PARTY_NOTICES.md`.
