// -----------------------------------------------------------------------------
// The kvmd client: pinned TLS (nothing written before the check), answers
// bounded in size and time, envelope and statuses, the 2FA login.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import {
  KvmdError,
  atxOf,
  cleanReason,
  createKvmd,
  infoOf,
  login,
  parseAnswer,
  pinnedRequest,
  readFingerprint,
  retryAfterOf,
} from '../src/kvmd.js';
import { CODE, PASSWORD, USER, fakePikvm } from './helpers/fakePikvm.js';
import { certs } from './kit/certs.mjs';

const answer = (status, body, headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('parseAnswer: the kvmd envelope first; statuses to kinds', () => {
  assert.deepEqual(parseAnswer(answer(200, { ok: true, result: { a: 1 } })), { a: 1 });
  const kind = (a) => {
    try {
      parseAnswer(a);
    } catch (err) {
      return err.kind;
    }
    return 'none';
  };
  assert.equal(kind(answer(200, { result: { a: 1 } })), 'format');
  assert.equal(kind(answer(200, { ok: true, result: [] })), 'format');
  assert.equal(kind(answer(200, 'hello')), 'format');
  assert.equal(kind(answer(401, {})), 'unauth');
  assert.equal(kind(answer(403, {})), 'auth');
  assert.equal(kind(answer(409, {})), 'busy');
  assert.equal(kind(answer(429, {})), 'rate');
  assert.equal(kind(answer(503, {})), 'server');
  assert.equal(kind(answer(302, {})), 'redirect');
  assert.equal(kind(answer(404, {})), 'notfound');
  assert.equal(
    kind(answer(400, { ok: false, result: { error_msg: 'ATX is disabled' } })),
    'refused',
  );
  const err = (() => {
    try {
      parseAnswer(answer(400, { ok: false, result: { error_msg: `bad ${PASSWORD}` } }), {
        secrets: [PASSWORD],
      });
    } catch (e) {
      return e;
    }
  })();
  assert.ok(!err.message.includes(PASSWORD));
});

test('the ATX state: strict booleans, anything else unknown (never false)', () => {
  assert.deepEqual(atxOf({ enabled: true, busy: false, leds: { power: true, hdd: false } }), {
    enabled: true,
    busy: false,
    power: true,
    hdd: false,
  });
  assert.deepEqual(atxOf({ enabled: 1, busy: 'no', leds: { power: 0, hdd: '' } }), {
    enabled: undefined,
    busy: undefined,
    power: undefined,
    hdd: undefined,
  });
  assert.deepEqual(atxOf(null), {
    enabled: undefined,
    busy: undefined,
    power: undefined,
    hdd: undefined,
  });
});

test('the info: temperature only when a finite number in range', () => {
  assert.equal(infoOf({ hw: { health: { temp: { cpu: 51.26 } } } }).temperature, 51.3);
  assert.equal(infoOf({ hw: { health: { temp: { cpu: '51' } } } }).temperature, undefined);
  assert.equal(infoOf({ hw: { health: { temp: { cpu: 999 } } } }).temperature, undefined);
  assert.equal(infoOf({}).temperature, undefined);
  assert.equal(infoOf({ hw: { platform: { model: 'x\u0000y' } } }).model, undefined);
});

test('cleanReason and Retry-After', () => {
  assert.equal(cleanReason(`a ${'Z'.repeat(30)} b`), 'a *** b');
  assert.equal(cleanReason('x\u0007y'), 'x y');
  assert.equal(retryAfterOf('2'), 2000);
  assert.equal(
    retryAfterOf('Wed, 01 Jan 2026 00:01:00 GMT', 'Wed, 01 Jan 2026 00:00:00 GMT'),
    60_000,
  );
  assert.equal(retryAfterOf('Wed, 01 Jan 2026 00:01:00 GMT'), undefined);
});

test('another certificate: refused at the handshake, not one HTTP byte written', async (t) => {
  const pv = await fakePikvm({ cert: certs.impostor });
  t.after(() => pv.close());
  const client = createKvmd({
    host: '127.0.0.1',
    port: pv.port,
    pin: certs.device.fingerprint256,
    auth: () => ({ username: USER, password: PASSWORD }),
  });
  await assert.rejects(client.atx(), (err) => err.kind === 'pin' && !err.sent);
  assert.equal(pv.requests.length, 0);
});

test('no pin: refused before any connection', async () => {
  await assert.rejects(
    pinnedRequest({ host: '127.0.0.1', port: 1, pin: undefined, method: 'GET', path: '/' }),
    (err) => err.kind === 'nopin',
  );
});

test('readFingerprint: the certificate seen, nothing sent', async (t) => {
  const pv = await fakePikvm();
  t.after(() => pv.close());
  assert.equal(await readFingerprint({ host: '127.0.0.1', port: pv.port }), pv.fingerprint);
  assert.equal(pv.requests.length, 0);
});

/** A TLS server with the device certificate and a raw handler. */
async function rawServer(t, handler) {
  const server = createServer({ key: certs.device.key, cert: certs.device.cert }, handler);
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(() => r()));
  });
  return server.address().port;
}

test('an answer too large is cut before it is read whole (declared or streamed)', async (t) => {
  let streamed = 0;
  const port = await rawServer(t, (req, res) => {
    if (req.url === '/declared') {
      res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
      res.write('{');
      return;
    }
    res.writeHead(200);
    const timer = setInterval(() => {
      streamed += 16 * 1024;
      if (!res.write(Buffer.alloc(16 * 1024, 0x20))) return;
      if (streamed > 2 * 1024 * 1024) clearInterval(timer);
    }, 1);
    res.on('close', () => clearInterval(timer));
  });
  const base = { host: '127.0.0.1', port, pin: certs.device.fingerprint256, method: 'GET' };
  await assert.rejects(pinnedRequest({ ...base, path: '/declared' }), (e) => e.kind === 'size');
  await assert.rejects(pinnedRequest({ ...base, path: '/streamed' }), (e) => e.kind === 'size');
  assert.ok(streamed < 2 * 1024 * 1024, 'cut early');
});

test('a frozen answer (no byte for 2 s) is cut, sent but unanswered', async (t) => {
  const port = await rawServer(t, (req, res) => {
    res.writeHead(200);
    res.write('{"ok":');
  });
  const started = performance.now();
  await assert.rejects(
    pinnedRequest({
      host: '127.0.0.1',
      port,
      pin: certs.device.fingerprint256,
      method: 'GET',
      path: '/',
      idleTimeout: 300,
    }),
    (e) => e.kind === 'timeout' && e.sent,
  );
  assert.ok(performance.now() - started < 3000);
});

test('beforeSend throwing: nothing written', async (t) => {
  const pv = await fakePikvm();
  t.after(() => pv.close());
  await assert.rejects(
    pinnedRequest({
      host: '127.0.0.1',
      port: pv.port,
      pin: pv.fingerprint,
      method: 'POST',
      path: '/api/atx/power?action=on&wait=0',
      beforeSend: () => {
        throw new KvmdError('cancelled', 'no');
      },
    }),
    (e) => e.kind === 'cancelled',
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pv.requests.length, 0);
});

test('login: the password followed by the code, the token from the cookie; 403 refused', async (t) => {
  const pv = await fakePikvm({ twoFactor: true });
  t.after(() => pv.close());
  const base = { host: '127.0.0.1', port: pv.port, pin: pv.fingerprint, username: USER };
  const token = await login({ ...base, passwd: `${PASSWORD}${CODE}` });
  assert.ok(pv.tokens.has(token));
  const sent = new URLSearchParams(pv.requests[0].body);
  assert.equal(sent.get('passwd'), `${PASSWORD}${CODE}`);
  await assert.rejects(login({ ...base, passwd: `${PASSWORD}000000` }), (e) => e.kind === 'auth');
  // With the token, the API answers; the headers carry no password.
  const client = createKvmd({ ...base, auth: () => ({ token }) });
  assert.equal((await client.atx()).enabled, true);
  assert.equal(pv.requests.at(-1).headers['x-kvmd-passwd'], undefined);
});

test('login without a session cookie is a format error, never a success', async (t) => {
  const pv = await fakePikvm();
  t.after(() => pv.close());
  pv.replyFor = () => ({ status: 200, body: { ok: true, result: {} } });
  await assert.rejects(
    login({ host: '127.0.0.1', port: pv.port, pin: pv.fingerprint, username: USER, passwd: 'x' }),
    (e) => e.kind === 'format',
  );
});
