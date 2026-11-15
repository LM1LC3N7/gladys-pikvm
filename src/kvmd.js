// -----------------------------------------------------------------------------
// The HTTP API of a PiKVM (kvmd), as documented at https://docs.pikvm.org/api/.
// kvmd is GPL-3.0 software running on the user's PiKVM: this module only calls
// its documented API; nothing of kvmd is copied nor ported.
//
// TLS: a PiKVM shows a self-signed certificate. The CA check is replaced by a
// pin: every connection is a bare TLS handshake first; the certificate seen is
// compared with the pinned SHA-256 fingerprint BEFORE anything is written or
// read. A mismatch closes the socket: the password never reaches another
// server. Then one HTTP request is written on that socket (`createConnection`,
// no agent, `Connection: close`): one request per connection, never a pipeline.
// There is no pin without the user: the first one comes from the fingerprint
// typed in the configuration or from two clicks on "Trust the certificate".
//
// Access (docs, "Authentication"): the user name and password in the
// `X-KVMD-User` / `X-KVMD-Passwd` headers of each request; with two-factor
// authentication, a session token (`auth_token` cookie) given by
// POST /api/auth/login for the password followed by the current code. Neither
// is ever logged nor put in an error message; errors never carry the path.
// Redirections are never followed.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { LIMITS, PATHS, TIMINGS } from './constants.js';

export class KvmdError extends Error {
  /**
   * @param {'nopin'|'pin'|'auth'|'unauth'|'busy'|'rate'|'notfound'|'refused'|'server'|'redirect'|'network'|'timeout'|'size'|'format'|'aborted'|'cancelled'} kind
   * @param {string} message never a token nor a password
   * @param {{ status?: number, sent?: boolean, retryAfter?: number, fingerprint?: string }} details
   *   sent: the request was written (it may have been done); status: the PiKVM answered
   */
  constructor(kind, message, { status, sent = false, retryAfter, fingerprint } = {}) {
    super(message);
    this.name = 'KvmdError';
    this.kind = kind;
    this.status = status;
    this.sent = sent || status !== undefined;
    this.retryAfter = retryAfter;
    this.fingerprint = fingerprint;
  }

  /** The PiKVM answered (any status): the request reached it. */
  get answered() {
    return this.status !== undefined;
  }
}

const NETWORK = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

const networkError = (err, sent) =>
  err instanceof KvmdError
    ? err
    : new KvmdError('network', NETWORK[err?.code] ?? 'network error', { sent });

/** A short text of the PiKVM: no control character, nothing that looks like a token or a secret. */
export function cleanReason(text, secrets = []) {
  let out = typeof text === 'string' ? text : '';
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out
    .replace(/[0-9A-Za-z+/=_-]{20,}/g, '***')
    .replace(/[^\x20-\x7e\u00a0-\u024f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Retry-After (seconds, decimals accepted, or an HTTP date) -> ms, or undefined. */
export function retryAfterOf(value, serverDate) {
  if (value === undefined || value === null || value === '') return undefined;
  if (/^\d{1,9}(\.\d+)?$/.test(String(value).trim())) {
    return Math.round(Number(String(value).trim()) * 1000);
  }
  // An HTTP date is compared with the PiKVM's own Date header, never with the
  // local clock; without a readable one, the default pause applies.
  const date = Date.parse(String(value));
  const now = Date.parse(String(serverDate ?? ''));
  return Number.isFinite(date) && Number.isFinite(now) ? Math.max(0, date - now) : undefined;
}

export const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
/** A session token of kvmd as it comes in the cookie (some room kept). */
export const TOKEN = /^[A-Za-z0-9._~+/=-]{8,512}$/;

/**
 * A TLS connection whose certificate is the pinned one; nothing is written nor
 * read before the check. Without a pin: refused (nothing sent).
 */
export function connectPinned({ host, port, pin, timeout = TIMINGS.connectTimeout, signal }) {
  return new Promise((resolve, reject) => {
    if (!pin) {
      reject(new KvmdError('nopin', 'certificate not pinned'));
      return;
    }
    let done = false;
    const socket = tls.connect({
      host,
      port,
      servername: isIP(host) ? undefined : host,
      // Self-signed: the CA check cannot pass; the pin below replaces it, on
      // this connection only (never for the whole process).
      rejectUnauthorized: false,
    });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('secureConnect', onSecure);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const onAbort = () => finish(new KvmdError('aborted', 'stopped'));
    const onSecure = () => {
      const seen = socket.getPeerCertificate()?.fingerprint256;
      if (seen !== pin) {
        finish(
          new KvmdError('pin', 'the certificate of the PiKVM changed', {
            fingerprint: typeof seen === 'string' && FINGERPRINT.test(seen) ? seen : undefined,
          }),
        );
        return;
      }
      finish();
    };
    const timer = setTimeout(
      () => finish(new KvmdError('timeout', 'no TLS connection within the delay')),
      timeout,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('secureConnect', onSecure);
    socket.on('error', (err) => finish(networkError(err, false)));
  });
}

/** The fingerprint of the certificate the PiKVM shows (a bare handshake: nothing is sent). */
export function readFingerprint({ host, port, timeout = TIMINGS.connectTimeout }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = tls.connect({
      host,
      port,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    });
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new KvmdError('timeout', 'no TLS connection within the delay')),
      timeout,
    );
    socket.once('secureConnect', () => {
      const seen = socket.getPeerCertificate()?.fingerprint256;
      if (typeof seen === 'string' && FINGERPRINT.test(seen)) finish(undefined, seen);
      else finish(new KvmdError('format', 'no certificate shown'));
    });
    socket.on('error', (err) => finish(networkError(err, false)));
  });
}

/**
 * One request on a pinned connection; resolves { status, headers, body }.
 * `beforeSend()` runs once the certificate is checked, just before the first
 * byte of the request: it may throw to cancel (nothing sent).
 * `auth`: { username, password } (headers) or { token } (cookie).
 */
export async function pinnedRequest({
  host,
  port,
  pin,
  method,
  path,
  auth,
  form,
  timeout = TIMINGS.readTimeout,
  idleTimeout = TIMINGS.idleTimeout,
  maxBytes = LIMITS.responseBytes,
  beforeSend,
  signal,
}) {
  const started = performance.now();
  const socket = await connectPinned({
    host,
    port,
    pin,
    timeout: Math.min(timeout, TIMINGS.connectTimeout),
    signal,
  });
  try {
    beforeSend?.();
  } catch (err) {
    socket.destroy();
    throw err;
  }
  const left = Math.max(1, timeout - (performance.now() - started));
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let idle;
    let req;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
      req?.destroy();
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => settle(new KvmdError('aborted', 'stopped', { sent }));
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => settle(new KvmdError('timeout', 'the PiKVM stopped answering', { sent })),
        idleTimeout,
      );
    };
    const headers = { Accept: 'application/json', Connection: 'close' };
    if (auth?.token) headers.Cookie = `auth_token=${auth.token}`;
    else if (auth?.username) {
      headers['X-KVMD-User'] = auth.username;
      headers['X-KVMD-Passwd'] = auth.password;
    }
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    } else if (method === 'POST') {
      headers['Content-Length'] = 0;
    }
    const timer = setTimeout(
      () => settle(new KvmdError('timeout', 'no answer within the delay', { sent })),
      left,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // No agent: the verified socket is the connection (never `agent: false`).
      req = http.request({
        host,
        port,
        method,
        path,
        headers,
        createConnection: () => socket,
      });
    } catch {
      // An invalid header value (refused by Node before any byte is written).
      settle(new KvmdError('format', 'request not built'));
      return;
    }
    req.on('response', (res) => {
      armIdle();
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        settle(new KvmdError('size', 'answer too large', { status: res.statusCode }));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(new KvmdError('size', 'answer too large', { status: res.statusCode }));
          return;
        }
        chunks.push(chunk);
        armIdle();
      });
      res.on('end', () =>
        settle(undefined, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(networkError(err, true)));
    });
    req.on('error', (err) => settle(networkError(err, sent)));
    sent = true;
    armIdle();
    req.end(body);
  });
}

/**
 * The `result` of an answer, or the KvmdError it is. kvmd answers
 * `{ "ok": true, "result": {...} }` (docs); the envelope is read before
 * anything else, so another web server is never taken for a PiKVM.
 * A 403 is "credentials or token refused" for the caller to judge (a refusal
 * of the account only on the main read); a 401 is "no credentials".
 */
export function parseAnswer({ status, headers = {}, body }, { secrets = [] } = {}) {
  let json;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  const envelope = json && typeof json === 'object' && !Array.isArray(json) ? json : undefined;
  const result =
    envelope?.result && typeof envelope.result === 'object' && !Array.isArray(envelope.result)
      ? envelope.result
      : undefined;
  const reason = cleanReason(result?.error_msg ?? result?.error, secrets);
  const at = { status };
  if (status >= 300 && status < 400) {
    throw new KvmdError('redirect', `redirected (HTTP ${status})`, at);
  }
  if (status === 401) throw new KvmdError('unauth', 'no credentials taken (HTTP 401)', at);
  if (status === 403) throw new KvmdError('auth', 'credentials refused (HTTP 403)', at);
  if (status === 409) throw new KvmdError('busy', 'the ATX is busy (HTTP 409)', at);
  if (status === 429) {
    throw new KvmdError('rate', 'too many requests (HTTP 429)', {
      ...at,
      retryAfter: retryAfterOf(headers['retry-after'], headers.date),
    });
  }
  if (status === 404) throw new KvmdError('notfound', 'not found (HTTP 404)', at);
  if (status >= 500) throw new KvmdError('server', `HTTP ${status}`, at);
  if (status >= 400) {
    throw new KvmdError('refused', reason ? `${reason} (HTTP ${status})` : `HTTP ${status}`, at);
  }
  if (status < 200 || status >= 300) throw new KvmdError('format', `HTTP ${status}`, at);
  if (envelope?.ok !== true || !result) {
    throw new KvmdError('format', 'not an answer of a PiKVM', at);
  }
  return result;
}

const bool = (v) => (typeof v === 'boolean' ? v : undefined);

/**
 * The ATX state of GET /api/atx (docs): `enabled`, `busy`, `leds.power`,
 * `leds.hdd`, strict booleans; anything else is unknown (undefined), never
 * false.
 */
export function atxOf(result) {
  const leds = result?.leds && typeof result.leds === 'object' ? result.leds : {};
  return {
    enabled: bool(result?.enabled),
    busy: bool(result?.busy),
    power: bool(leds.power),
    hdd: bool(leds.hdd),
  };
}

/** The PiKVM's own data of GET /api/info?fields=hw: CPU temperature (°C) and model, when readable. */
export function infoOf(result) {
  const hw = result?.hw && typeof result.hw === 'object' ? result.hw : {};
  const temp = hw.health?.temp?.cpu;
  const platform = hw.platform && typeof hw.platform === 'object' ? hw.platform : {};
  const text = (v) =>
    typeof v === 'string' && /^[\x20-\x7e]{1,40}$/.test(v.trim()) ? v.trim() : undefined;
  return {
    temperature:
      typeof temp === 'number' && Number.isFinite(temp) && temp > -40 && temp < 150
        ? Math.round(temp * 10) / 10
        : undefined,
    model: text(platform.model),
    board: text(platform.board),
  };
}

/**
 * A client of one PiKVM: its address and pinned certificate are frozen for
 * the client's life; the credentials are read from `auth()` at each request.
 */
export function createKvmd({ host, port, pin, auth, secrets = () => [], request, signal }) {
  const send = request ?? pinnedRequest;
  const call = async (method, path, options = {}) => {
    const answer = await send({ host, port, pin, method, path, signal, auth: auth(), ...options });
    return parseAnswer(answer, { secrets: secrets() });
  };
  return {
    host,
    port,
    pin,
    atx: async (o) => atxOf(await call('GET', PATHS.atx, o)),
    info: async (o) => infoOf(await call('GET', PATHS.info, o)),
    /** One ATX power action (docs: on, off, off_hard, reset_hard); `{}` when started. */
    power: (action, o) => call('POST', PATHS.power(action), o),
  };
}

/**
 * The session login of two-factor authentication (docs): the password
 * followed by the current code, in a form. Resolves the session token (never
 * log it). A 403 is "password or code refused".
 */
export async function login({ host, port, pin, username, passwd, request, signal }) {
  const send = request ?? pinnedRequest;
  const answer = await send({
    host,
    port,
    pin,
    method: 'POST',
    path: PATHS.login,
    form: { user: username, passwd },
    timeout: TIMINGS.readTimeout,
    maxBytes: 16 * 1024,
    signal,
  });
  const { status } = answer;
  if (status === 200) {
    const cookies = [].concat(answer.headers?.['set-cookie'] ?? []);
    for (const line of cookies) {
      const match = /^\s*auth_token=([^;\s]*)/.exec(String(line));
      if (match && TOKEN.test(match[1])) return match[1];
    }
    throw new KvmdError('format', 'the PiKVM answered without a session', { status });
  }
  parseAnswer(answer, { secrets: [passwd] });
  throw new KvmdError('format', 'the PiKVM answered without a session', { status });
}
