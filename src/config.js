// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized. Nothing here
// talks to the network.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LANGUAGES, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  certificate_fingerprint: '',
  username: '',
  two_factor: false,
  poll_interval: POLL_INTERVAL.default,
  allow_power_on: false,
  allow_force_off: false,
  allow_reset: false,
  language: 'fr',
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** What an HTTP header carries safely: printable ASCII. */
const PRINTABLE = /^[\x20-\x7e]*$/;

/**
 * The PiKVM address from what the user typed: "192.168.1.20",
 * "192.168.1.20:8443" or "https://192.168.1.20/".
 * @returns {{ host: string, port: number, key: string } | { error: string }}
 */
export function parseAddress(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { error: 'empty' };
  if (CONTROL.test(text) || /\s/.test(text)) return { error: 'invalid' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'invalid' };
  }
  if (url.protocol !== 'https:') return { error: 'scheme' };
  if (url.username || url.password) return { error: 'credentials' };
  if (url.pathname !== '/' || url.search || url.hash) return { error: 'path' };
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[')) {
    host = host.slice(1, -1);
    if (/^ff/i.test(host) || host === '::') return { error: 'broadcast' };
  } else if (IPV4.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some((p) => p > 255)) return { error: 'invalid' };
    if (parts[0] === 0 || (parts[0] >= 224 && parts[0] <= 239) || parts.every((p) => p === 255)) {
      return { error: 'broadcast' };
    }
  } else if (!HOSTNAME.test(host)) {
    return { error: 'invalid' };
  } else if (/\.local$/.test(host)) {
    // mDNS names do not resolve inside the container (bridge network).
    return { error: 'local-name' };
  }
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (!(port >= 1 && port <= 65535)) return { error: 'invalid' };
  const shown = host.includes(':') ? `[${host}]` : host;
  return { host, port, key: `${shown}:${port}` };
}

/**
 * The platform id of the device, from the address (fixed rule, documented):
 * small letters, digits and dashes only, the port at the end. The pinned
 * certificate makes sure it is the same PiKVM at each request.
 */
export const addressId = (key) =>
  String(key ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/**
 * A SHA-256 certificate fingerprint as Node shows it (`AB:CD:...`, 32 bytes),
 * from hex with or without colons; '' is none.
 * @returns {{ fingerprint?: string, error?: 'fingerprint' }}
 */
export function parseFingerprint(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^sha-?256[:=\s]*/i, '');
  if (text === '') return {};
  const hex = text.replace(/[:\s]/g, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) return { error: 'fingerprint' };
  return { fingerprint: hex.toUpperCase().match(/../g).join(':') };
}

/** Only true (or "true") turns an option on: anything else keeps it off. */
const on = (raw) => raw === true || raw === 'true';

const bounded = (raw, { min, max, default: fallback }) => {
  if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(Math.max(min, Math.min(max, n))) : fallback;
};

/**
 * The kvmd user name and password. They travel in HTTP headers
 * (`X-KVMD-User`, `X-KVMD-Passwd`): printable ASCII only, no control character.
 */
function credentialsOf(c) {
  const username = typeof c.username === 'string' ? c.username.trim() : '';
  const password = typeof c.password === 'string' ? c.password : '';
  if (username === '' && password === '') return { error: 'no-credentials' };
  if (username === '') return { error: 'no-username' };
  if (password === '') return { error: 'no-password' };
  if (!PRINTABLE.test(username) || username.length > 64) return { error: 'bad-username' };
  if (!PRINTABLE.test(password) || password.length > 128) return { error: 'bad-password' };
  return { username, password };
}

/**
 * @returns {{ host?: string, port?: number, address?: string, username: string,
 *   password: string, fingerprint?: string, error?: string, twoFactor: boolean,
 *   pollInterval: number, allowPowerOn: boolean, allowForceOff: boolean,
 *   allowReset: boolean, language: 'fr'|'en' }}
 */
export function normalizeConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const target = parseAddress(c.host);
  const pin = parseFingerprint(c.certificate_fingerprint);
  const creds = credentialsOf(c);
  const error = target.error ?? pin.error ?? creds.error;
  return {
    host: target.host,
    port: target.port,
    address: target.key,
    username: creds.error ? '' : creds.username,
    password: creds.error ? '' : creds.password,
    fingerprint: pin.fingerprint,
    error,
    twoFactor: on(c.two_factor),
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    allowPowerOn: on(c.allow_power_on),
    allowForceOff: on(c.allow_force_off),
    allowReset: on(c.allow_reset),
    language: LANGUAGES.includes(c.language) ? c.language : DEFAULT_CONFIG.language,
  };
}

/** Two configurations that run the same way (a reconnection to Gladys keeps everything). */
export const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The parts of the configuration that make another session (address, account, pin, 2FA). */
export const sameSession = (a, b) =>
  a.address === b.address &&
  a.username === b.username &&
  a.password === b.password &&
  a.fingerprint === b.fingerprint &&
  a.twoFactor === b.twoFactor &&
  !a.error &&
  !b.error;
