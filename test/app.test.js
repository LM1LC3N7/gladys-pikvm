// -----------------------------------------------------------------------------
// The session: pin, reads, states, refusals, pauses, /data, 2FA, Gladys side.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PikvmApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { CODE, PASSWORD, USER } from './helpers/fakePikvm.js';
import {
  idle,
  pause,
  setup,
  stateOf,
  statusText,
  until,
  waitFor,
  within,
} from './helpers/setup.js';
import { testClock } from './kit/clock.mjs';
import { certs } from './kit/certs.mjs';

test('reads the ATX at start and publishes the LEDs and the temperature', async (t) => {
  const ctx = await setup(t, { server: {} });
  ctx.pv.atx.leds.power = true;
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.online, 'online');
  await waitFor(() => stateOf(ctx, 'power') !== undefined, 'power state');
  assert.equal(stateOf(ctx, 'power'), 1);
  assert.equal(stateOf(ctx, 'hdd'), 0);
  assert.equal(stateOf(ctx, 'pikvm_temperature'), 47.3);
  assert.match(statusText(ctx), /Connected: machine on/);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  // The credentials travel in the headers, on the pinned connection only.
  const r = ctx.pv.requests[0];
  assert.equal(r.headers['x-kvmd-user'], USER);
  assert.equal(r.headers['x-kvmd-passwd'], PASSWORD);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, ctx.device.external_id);
  for (const f of device.features) {
    if (['power_on', 'shutdown', 'force_off', 'reset'].includes(f.external_id.split(':').pop())) {
      assert.equal(f.category, 'button');
      assert.equal(f.type, 'push');
    } else {
      assert.equal(f.read_only, true);
      assert.notEqual(f.category, 'switch');
    }
  }
  assert.ok(!ctx.logs.join('\n').includes(PASSWORD), 'the password never logged');
});

test('never sooner than the interval; then at the interval', async (t) => {
  const ctx = await setup(t, { config: { poll_interval: 30 } });
  await ctx.clock.advance(0);
  await waitFor(() => ctx.pv.count('GET /api/atx') === 1, 'first read');
  await idle(ctx);
  await ctx.clock.advance(29_000);
  assert.equal(ctx.pv.count('GET /api/atx'), 1);
  await ctx.clock.advance(1100);
  await waitFor(() => ctx.pv.count('GET /api/atx') === 2, 'second read');
  // Scan and Test within the interval: no read.
  await ctx.gladys.fake.scanRequest();
  assert.equal(ctx.pv.count('GET /api/atx'), 2);
  const msg = await ctx.app.testConnection();
  assert.match(msg.en, /Read less than the refresh interval ago/);
  assert.equal(ctx.pv.count('GET /api/atx'), 2);
});

test('the last read in /data paces a restart', async (t) => {
  const first = await setup(t);
  await first.clock.advance(0);
  await waitFor(() => first.pv.count('GET /api/atx') === 1, 'read');
  await waitFor(() => first.store.data?.lastReadAt, 'kept');
  await idle(first);
  await first.app.shutdown();
  // The container restarts 10 s later (wall clock) on the same /data.
  const clock = testClock({ start: first.clock.now() + 10_000 });
  const app = new PikvmApp({
    gladys: first.gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    store: first.store,
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
  });
  t.after(() => app.shutdown());
  await app.configUpdated(first.raw);
  await clock.advance(0);
  await pause(100);
  assert.equal(first.pv.count('GET /api/atx'), 1, 'not at once');
  await clock.advance(29_000);
  await pause(50);
  assert.equal(first.pv.count('GET /api/atx'), 1, 'not before the interval');
  await clock.advance(2000);
  await waitFor(() => first.pv.count('GET /api/atx') === 2, 'at the interval');
});

test('no pin: nothing sent; Trust the certificate in two clicks pins it, then reads', async (t) => {
  const ctx = await setup(t, { pinned: false });
  await ctx.clock.advance(0);
  assert.equal(ctx.pv.requests.length, 0);
  assert.match(statusText(ctx), /not pinned yet: nothing is sent/);
  const first = await ctx.app.trustCertificate();
  assert.match(first.en, new RegExp(ctx.pv.fingerprint));
  assert.match(first.en, /Click again within 2 minutes/);
  assert.equal(ctx.pv.requests.length, 0, 'a bare handshake only');
  const second = await ctx.app.trustCertificate();
  assert.match(second.en, /trusted/);
  assert.equal(ctx.store.data.pins[ctx.pv.address], ctx.pv.fingerprint);
  await until(ctx, () => ctx.app.online, 'online after the pin');
});

test('the first click alone never pins; a click after 2 min starts over', async (t) => {
  const ctx = await setup(t, { pinned: false });
  await ctx.app.trustCertificate();
  await ctx.clock.advance(121_000);
  const again = await ctx.app.trustCertificate();
  assert.match(again.en, /Click again within 2 minutes/);
  assert.equal(ctx.store.data?.pins?.[ctx.pv.address], undefined);
});

test('another certificate: nothing is sent, the password neither; the status shows it', async (t) => {
  const ctx = await setup(t, {
    server: { cert: certs.impostor },
    memory: { pins: {} },
    connect: false,
  });
  ctx.store.data = { pins: { [ctx.pv.address]: certs.device.fingerprint256 } };
  await within(ctx.gladys.connect(), 'connect');
  await ctx.clock.advance(0);
  await waitFor(() => /certificate of the PiKVM changed/.test(statusText(ctx)), 'status');
  assert.equal(ctx.pv.requests.length, 0);
  assert.match(statusText(ctx), new RegExp(certs.impostor.fingerprint256));
  // Never learnt again by itself.
  await ctx.clock.advance(60_000);
  assert.equal(ctx.store.data.pins[ctx.pv.address], certs.device.fingerprint256);
});

test('a typed fingerprint is the pin (kept in /data); a wrong one sends nothing', async (t) => {
  const ctx = await setup(t, {
    memory: null,
    config: { certificate_fingerprint: certs.impostor.fingerprint256.replace(/:/g, '') },
  });
  await ctx.clock.advance(0);
  await waitFor(() => /changed/.test(statusText(ctx)), 'pin refused');
  assert.equal(ctx.pv.requests.length, 0);
});

test('credentials refused (403 on the ATX read): kept, never tried again alone; new ones are', async (t) => {
  const ctx = await setup(t, { config: { password: 'wrong-one' } });
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.blocked, 'refused');
  assert.match(statusText(ctx), /refused the user name or password/);
  assert.ok(ctx.store.data.refused);
  assert.ok(!JSON.stringify(ctx.store.data).includes('wrong-one'));
  await ctx.clock.advance(3_600_000);
  assert.equal(ctx.pv.count('GET /api/atx'), 1);
  // A restart with the same credentials: still refused (mark in /data).
  await ctx.app.start(ctx.raw);
  await ctx.clock.advance(0);
  await pause(100);
  assert.equal(ctx.pv.count('GET /api/atx'), 1);
  // New credentials saved: tried at once.
  await ctx.gladys.fake.configUpdated({ ...ctx.raw, password: PASSWORD });
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.online, 'online with the new ones');
  assert.equal(ctx.store.data.refused, null);
});

test('the Test button lifts a refusal when the PiKVM accepts the credentials again', async (t) => {
  const ctx = await setup(t, { config: {} });
  ctx.pv.twoFactor = true; // refuses the headers
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.blocked, 'refused');
  ctx.pv.twoFactor = false;
  const msg = await ctx.app.testConnection();
  assert.match(msg.en, /PiKVM reached/);
  await waitFor(() => !ctx.app.blocked && ctx.store.data.refused === null, 'lifted');
});

test('401/403 on the PiKVM info (secondary) is not a refusal; the ATX reads go on', async (t) => {
  const ctx = await setup(t);
  ctx.pv.replyFor = (r) =>
    r.path === '/api/info' ? { status: 403, body: { ok: false, result: {} } } : undefined;
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.online, 'online');
  assert.equal(ctx.app.blocked, false);
  assert.equal(ctx.store.data?.refused ?? null, null);
  await ctx.clock.advance(30_100);
  await waitFor(() => ctx.pv.count('GET /api/atx') === 2, 'next read');
  // Spaced: not asked again at each read.
  assert.equal(ctx.pv.count('GET /api/info'), 1);
});

test('an info route in failure (500) never blocks the ATX values', async (t) => {
  const ctx = await setup(t);
  ctx.pv.atx.leds.power = true;
  ctx.pv.replyFor = (r) => (r.path === '/api/info' ? { status: 500, body: 'x' } : undefined);
  await ctx.clock.advance(0);
  await waitFor(() => stateOf(ctx, 'power') === 1, 'power published');
});

test('429 pauses the reads, kept in /data; the pause survives a restart', async (t) => {
  const ctx = await setup(t);
  ctx.pv.replyFor = () => ({ status: 429, body: 'slow', headers: { 'retry-after': '120' } });
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.paused(), 'paused');
  assert.ok(ctx.store.data.pausedUntil > 0);
  assert.match(statusText(ctx), /reads paused/);
  ctx.pv.replyFor = undefined;
  await ctx.clock.advance(100_000);
  assert.equal(ctx.pv.count('GET /api/atx'), 1);
  await ctx.clock.advance(25_000);
  await waitFor(() => ctx.pv.count('GET /api/atx') === 2, 'after the pause');
});

test('getConfig() failing in connected: tried again, spaced, without end; then starts', async (t) => {
  let fail = 2;
  const ctx = await setup(t, { connect: false });
  const getConfig = async () => {
    if (fail > 0) {
      fail -= 1;
      throw new Error('down');
    }
    return ctx.raw;
  };
  await within(ctx.app.connectedWith(getConfig), 'connected');
  assert.match(statusText(ctx), /did not give the configuration: tried again in 5 s/);
  await ctx.clock.advance(5000);
  assert.match(statusText(ctx), /tried again in 15 s/);
  await ctx.clock.advance(15_000);
  await until(ctx, () => ctx.app.online, 'online');
});

test('a reconnection with the same configuration sends status and Discovery again, no read', async (t) => {
  const ctx = await setup(t);
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.online, 'online');
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  const discoveries = ctx.gladys.fake.requests.filter(
    (r) => r.path === '/discovered_device',
  ).length;
  await ctx.gladys.fake.send('integration-connected', {}).catch(() => {});
  await ctx.app.connectedWith(async () => ctx.raw);
  assert.ok(ctx.gladys.fake.connectionStatuses.length > statuses);
  assert.ok(
    ctx.gladys.fake.requests.filter((r) => r.path === '/discovered_device').length > discoveries,
  );
  assert.equal(ctx.pv.count('GET /api/atx'), 1);
});

test('/data unreadable is not empty: no pin learnt over it; read again every 10 s', async (t) => {
  const store = memoryStore({ pins: {} });
  store.failLoad = true;
  const ctx = await setup(t, { store, pinned: false });
  await ctx.clock.advance(0);
  assert.match(statusText(ctx), /\/data is unreadable/);
  await ctx.app.trustCertificate();
  const msg = await ctx.app.trustCertificate();
  assert.match(msg.en, /could not keep it/);
  store.failLoad = false;
  store.data = { pins: { [ctx.pv.address]: ctx.pv.fingerprint } };
  await ctx.clock.advance(10_100);
  await waitFor(() => ctx.app.memoryState === 'loaded', 'read again');
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.online, 'online with the late pin');
});

test('ATX disabled: no LED published (unknown, never 0), badge degraded', async (t) => {
  const ctx = await setup(t);
  ctx.pv.atx.enabled = false;
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.online, 'online');
  assert.equal(stateOf(ctx, 'power'), undefined);
  assert.equal(stateOf(ctx, 'hdd'), undefined);
  assert.match(statusText(ctx), /ATX disabled/);
  await waitFor(() => ctx.gladys.fake.transports.at(-1)?.degraded === true, 'badge');
});

test('a LED that is not a boolean is unknown, never published', async (t) => {
  const ctx = await setup(t);
  ctx.pv.atx.leds = { power: 'on', hdd: null };
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.online, 'online');
  assert.equal(stateOf(ctx, 'power'), undefined);
  assert.equal(stateOf(ctx, 'hdd'), undefined);
});

test('another web server (no kvmd envelope) is not taken for a PiKVM', async (t) => {
  const ctx = await setup(t);
  ctx.pv.replyFor = () => ({ status: 200, body: { enabled: true, leds: { power: true } } });
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.lastError?.kind === 'format', 'format error');
  assert.equal(ctx.app.online, false);
  assert.equal(stateOf(ctx, 'power'), undefined);
});

test('2FA: nothing read before a code; the code opens a session (token in memory only)', async (t) => {
  const ctx = await setup(t, { config: { two_factor: true } });
  ctx.pv.twoFactor = true;
  await ctx.clock.advance(0);
  assert.equal(ctx.pv.requests.length, 0);
  assert.match(statusText(ctx), /Log in with a 2FA code/);
  const bad = await ctx.gladys.fake.action('login_2fa', { code: '12' });
  assert.match(JSON.stringify(bad), /6 digits/);
  const refused = await ctx.app.loginWithCode({ code: '654321' });
  assert.match(refused.en, /refused the password or the code/);
  const ok = await ctx.app.loginWithCode({ code: CODE });
  assert.match(ok.en, /Session opened/);
  await until(ctx, () => ctx.app.online, 'online');
  await idle(ctx);
  const read = ctx.pv.requests.find((r) => r.path === '/api/atx');
  assert.match(read.headers.cookie, /^auth_token=/);
  assert.equal(read.headers['x-kvmd-passwd'], undefined);
  const kept = JSON.stringify(ctx.store.data);
  assert.ok(!kept.includes(CODE) && !kept.includes('tok'), 'neither code nor token in /data');
  assert.ok(!ctx.logs.join('\n').includes(CODE));
  // The session ends on the PiKVM: a new code is asked, never a refusal of the account.
  ctx.pv.tokens.clear();
  await ctx.clock.advance(30_100);
  await waitFor(() => /2FA session ended/.test(statusText(ctx)), 'code asked again');
  assert.equal(ctx.app.blocked, false);
  const reads = ctx.pv.count('GET /api/atx');
  await ctx.clock.advance(600_000);
  assert.equal(ctx.pv.count('GET /api/atx'), reads, 'no read without a session');
});

test('a 401 on the ATX read (credentials not taken) is not a refusal', async (t) => {
  const ctx = await setup(t);
  ctx.pv.replyFor = () => ({ status: 401, body: { ok: false, result: {} } });
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.lastError?.kind === 'unauth', 'failed');
  assert.equal(ctx.app.blocked, false);
  assert.equal(ctx.store.data?.refused ?? null, null);
});
