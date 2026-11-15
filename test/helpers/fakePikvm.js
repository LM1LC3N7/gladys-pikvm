// -----------------------------------------------------------------------------
// A simulated PiKVM (kvmd HTTP API as documented at docs.pikvm.org/api) over
// real HTTPS on 127.0.0.1, with the kit's self-signed device certificate.
// Every request is recorded (method, path, query, headers, body); answers can
// be replaced per request (`replyFor`), delayed (`latencyMs`) or held
// (`silent`). Power actions apply after `applyDelayMs`.
// -----------------------------------------------------------------------------

import { createServer } from 'node:https';
import { certs } from '../kit/certs.mjs';

export const USER = 'gladys';
export const PASSWORD = 'Secret-Pass-42';
export const CODE = '123456';

const ok = (result) => ({ status: 200, body: { ok: true, result } });
const error = (status, name, msg) => ({
  status,
  body: { ok: false, result: { error: name, error_msg: msg } },
});

export async function fakePikvm({ cert = certs.device, ...options } = {}) {
  const sockets = new Set();
  const pv = {
    atx: { enabled: true, busy: false, leds: { power: false, hdd: false } },
    hw: { health: { temp: { cpu: 47.25 } }, platform: { model: 'v4plus', board: 'rpi4' } },
    twoFactor: false,
    tokens: new Set(),
    applyDelayMs: 0,
    latencyMs: 0,
    /** (request) => { status, body, headers } | 'silent' | 'drop' | undefined */
    replyFor: undefined,
    requests: [],
    actions: [],
    fingerprint: cert.fingerprint256,
    ...options,
    count(match) {
      return this.requests.filter((r) => `${r.method} ${r.path}`.includes(match)).length;
    },
    get powerActions() {
      return this.actions.map((a) => a.action);
    },
  };

  const authorized = (req) => {
    const cookie = /auth_token=([^;\s]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (cookie) return pv.tokens.has(cookie) ? true : 403;
    const user = req.headers['x-kvmd-user'];
    const pass = req.headers['x-kvmd-passwd'];
    if (user === undefined && pass === undefined) return 401;
    if (pv.twoFactor) return 403;
    return user === USER && pass === PASSWORD ? true : 403;
  };

  const route = (r) => {
    if (r.method === 'POST' && r.path === '/api/auth/login') {
      const form = new URLSearchParams(r.body);
      const expected = pv.twoFactor ? `${PASSWORD}${CODE}` : PASSWORD;
      if (form.get('user') !== USER || form.get('passwd') !== expected) {
        return error(403, 'ForbiddenError', 'Forbidden');
      }
      const token = `tok${Math.random().toString(16).slice(2).padEnd(13, '0')}${pv.tokens.size}`;
      pv.tokens.add(token);
      return {
        status: 200,
        body: { ok: true, result: {} },
        headers: { 'set-cookie': `auth_token=${token}; Path=/; HttpOnly` },
      };
    }
    const auth = authorized(r);
    if (auth === 401) return error(401, 'UnauthorizedError', 'Unauthorized');
    if (auth === 403) return error(403, 'ForbiddenError', 'Forbidden');
    if (r.method === 'GET' && r.path === '/api/atx') return ok(structuredClone(pv.atx));
    if (r.method === 'GET' && r.path === '/api/info') return ok({ hw: structuredClone(pv.hw) });
    if (r.method === 'POST' && r.path === '/api/atx/power') {
      const action = r.query.action;
      if (!['on', 'off', 'off_hard', 'reset_hard'].includes(action)) {
        return error(400, 'ValidatorError', 'bad action');
      }
      if (!pv.atx.enabled) return error(400, 'AtxDisabledError', 'ATX is disabled');
      if (pv.atx.busy) return error(409, 'AtxIsBusyError', 'Performing another ATX operation');
      pv.actions.push({ action, at: performance.now() });
      const wasOn = pv.atx.leds.power;
      const change =
        (action === 'on' && !wasOn) || ((action === 'off' || action === 'off_hard') && wasOn);
      if (change || action === 'reset_hard') {
        pv.atx.busy = true;
        setTimeout(() => {
          if (action === 'on') pv.atx.leds.power = true;
          if (action === 'off' || action === 'off_hard') pv.atx.leds.power = false;
          pv.atx.busy = false;
        }, pv.applyDelayMs);
      }
      return ok({});
    }
    return { status: 404, body: 'not found' };
  };

  const server = createServer({ key: cert.key, cert: cert.cert }, async (req, res) => {
    res.on('error', () => {});
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'https://127.0.0.1');
    const r = {
      at: performance.now(),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    pv.requests.push(r);
    const latency = typeof pv.latencyMs === 'function' ? pv.latencyMs(r) : pv.latencyMs;
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    if (res.destroyed) return;
    const answer = pv.replyFor?.(r) ?? route(r);
    if (answer === 'silent') return;
    if (answer === 'drop') {
      req.socket.destroy();
      return;
    }
    const text = typeof answer.body === 'string';
    const payload = text ? answer.body : JSON.stringify(answer.body);
    res.writeHead(answer.status, {
      'content-type': text ? 'text/plain' : 'application/json',
      ...(answer.headers ?? {}),
    });
    res.end(payload);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  pv.port = server.address().port;
  pv.address = `127.0.0.1:${pv.port}`;
  pv.close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  };
  return pv;
}
