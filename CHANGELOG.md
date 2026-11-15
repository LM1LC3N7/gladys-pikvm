# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- PiKVM over its local HTTPS API (kvmd): one device with the power and disk
  LEDs of the machine (ATX), the PiKVM temperature, and the Shut down, Power
  on, Force power off and Reset buttons.
- Certificate of the PiKVM trusted in two clicks (or typed); a changed one
  stops everything until trusted again.
- User name and password in the kvmd headers; a 403 on the ATX read refuses
  them (6-bit salted mark in /data), never tried again until new credentials
  or the Test button. Two-factor authentication: "Log in with a 2FA code"
  button, the session token in memory only, the code never kept.
- Shut down never held back (no option, pause, read nor command in flight);
  retried while the PiKVM does not take it, kept in /data and sent again by
  reads showing the machine on (3 times, 2 min at most).
- Power on, Force power off and Reset off by default, decided on a fresh read,
  one per 30 s, refused for 1 min after a shutdown.
- 429/5xx pause (1 min to 6 h) kept in /data; the last read paces a restart.
