// -----------------------------------------------------------------------------
// Review r1: frozen credentials of a shutdown (I1), a Power on / Reset that
// left cancels a kept shutdown (I2), and one test per guard of the kept
// shutdown and the buttons (I3, m1-m7).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { PASSWORD, fakePikvm } from './helpers/fakePikvm.js';
import { idle, pause, setup, statusText, until, waitFor, within } from './helpers/setup.js';

const ALL_ON = { allow_power_on: true, allow_force_off: true, allow_reset: true };
const NEW = 'New-Pass-of-B-77';
const ok = (result) => ({ status: 200, body: { ok: true, result } });
const offPosts = (pv) =>
  pv.requests.filter((r) => r.method === 'POST' && r.query.action === 'off').length;

async function online(t, options = {}) {
  const ctx = await setup(t, options);
  if (options.power !== undefined) ctx.pv.atx.leds.power = options.power;
  await until(ctx, () => ctx.app.online, 'online');
  await idle(ctx);
  return ctx;
}

async function ack(ctx, promise, step = 50) {
  let done;
  promise.then(
    (v) => (done = { v }),
    (e) => (done = { e }),
  );
  await until(ctx, () => done, 'the ack', { step, timeout: 8000 });
  if (done.e) throw done.e;
  return done.v;
}

/** A shutdown the PiKVM does not take (503): kept in /data. */
async function keptStop(ctx) {
  let down = true;
  ctx.pv.replyFor = (r) => (down && r.method === 'POST' ? { status: 503, body: 'x' } : undefined);
  const res = await ack(ctx, ctx.press('shutdown'));
  assert.match(res.error, /kept and sent again/);
  assert.ok(ctx.store.data.pendingStop);
  down = false;
  ctx.pv.replyFor = undefined;
}

/** A second PiKVM B (pinned too) to switch the configuration to. */
async function otherPikvm(t, ctx) {
  const b = await fakePikvm();
  t.after(() => b.close());
  ctx.app.memory.pins[b.address] = b.fingerprint;
  return b;
}

const neverGot = (pv, secret) =>
  assert.ok(
    !pv.requests.some((r) => r.headers['x-kvmd-passwd'] === secret),
    'the new password never reaches the old PiKVM',
  );

test('I1: a kept shutdown read in flight while another PiKVM is saved: nothing to the old one', async (t) => {
  const ctx = await online(t, { power: true });
  const b = await otherPikvm(t, ctx);
  await keptStop(ctx);
  ctx.pv.latencyMs = (r) => (r.method === 'GET' ? 200 : 0);
  const posts = offPosts(ctx.pv);
  const gets = ctx.pv.count('GET /api/atx');
  // The work timer fires: its read is in flight on A.
  await until(ctx, () => ctx.pv.count('GET /api/atx') > gets, 'read of the kept shutdown', {
    step: 1000,
  });
  await ctx.gladys.fake.configUpdated({ ...ctx.raw, host: b.address, password: NEW });
  await pause(400);
  await ctx.clock.advance(30_000);
  await pause(100);
  neverGot(ctx.pv, NEW);
  assert.equal(offPosts(ctx.pv), posts, 'no shutdown through the old client');
  assert.equal(b.count('POST'), 0, 'never sent to B either');
});

test('I1: the retries of a shutdown keep the credentials of the PiKVM clicked; nothing kept for B', async (t) => {
  const ctx = await online(t, { power: true });
  const b = await otherPikvm(t, ctx);
  ctx.pv.replyFor = (r) =>
    r.method === 'POST'
      ? { status: 409, body: { ok: false, result: { error: 'AtxIsBusyError' } } }
      : undefined;
  const pending = ctx.press('shutdown');
  await waitFor(() => ctx.pv.count('POST') >= 1, 'first try');
  await ctx.gladys.fake.configUpdated({ ...ctx.raw, host: b.address, password: NEW });
  const res = await ack(ctx, pending);
  assert.equal(res.success, false);
  neverGot(ctx.pv, NEW);
  assert.ok(
    ctx.pv.requests
      .filter((r) => r.method === 'POST')
      .every((r) => r.headers['x-kvmd-passwd'] === PASSWORD),
  );
  assert.equal(ctx.store.data.pendingStop ?? null, null, 'never kept for another PiKVM');
  await ctx.clock.advance(60_000);
  await pause(50);
  assert.equal(b.count('POST'), 0);
});

test('I2: a Reset that left without an answer cancels the kept shutdown (never sent over it)', async (t) => {
  const ctx = await online(t, { power: true, config: ALL_ON });
  await keptStop(ctx);
  // Neither on nor off read for a while (the kept shutdown waits), past the 60 s guard.
  ctx.pv.atx.leds.power = null;
  await ctx.clock.advance(61_000);
  await pause(30);
  ctx.pv.atx.leds.power = true;
  ctx.pv.replyFor = (r) =>
    r.method === 'POST' && r.query.action === 'reset_hard' ? 'silent' : undefined;
  const posts = offPosts(ctx.pv);
  const res = await within(ctx.press('reset'), 'ack', 15_000);
  assert.match(res.error, /without confirmation/);
  assert.equal(ctx.store.data.pendingStop, null);
  ctx.pv.replyFor = undefined;
  await ctx.clock.advance(60_000);
  await pause(50);
  assert.equal(offPosts(ctx.pv), posts, 'no shutdown after the Reset');
});

test('I2: the read of a Power on showing the machine off ends the kept shutdown', async (t) => {
  const ctx = await online(t, { power: true, config: ALL_ON });
  await keptStop(ctx);
  ctx.pv.atx.leds.power = null;
  await ctx.clock.advance(61_000);
  await pause(30);
  ctx.pv.atx.leds.power = false; // turned off by hand
  ctx.pv.latencyMs = 0;
  const posts = offPosts(ctx.pv);
  const res = await within(ctx.press('power_on'), 'ack');
  assert.equal(res.success, true);
  assert.equal(ctx.store.data.pendingStop, null);
  await ctx.clock.advance(60_000);
  await pause(50);
  assert.equal(offPosts(ctx.pv), posts);
});

test('I3 R1b: a kept shutdown sent without an answer is dropped, never sent again', async (t) => {
  const ctx = await online(t, { power: true });
  await keptStop(ctx);
  // Written, then the connection cut: sent, never answered (fast).
  ctx.pv.replyFor = (r) => (r.method === 'POST' ? 'drop' : undefined);
  const posts = offPosts(ctx.pv);
  await until(ctx, () => offPosts(ctx.pv) > posts, 'sent by its read', { step: 1000 });
  await until(ctx, () => ctx.store.data.pendingStop === null, 'dropped', {
    step: 1000,
    timeout: 15_000,
  });
  await ctx.clock.advance(150_000);
  await pause(50);
  assert.equal(offPosts(ctx.pv), posts + 1);
});

test('I3 R30: a shutdown taken by a click drops an older kept one (one press only)', async (t) => {
  const ctx = await online(t, { power: true, server: { applyDelayMs: 60_000 } });
  await keptStop(ctx);
  const res = await within(ctx.press('shutdown'), 'ack');
  assert.equal(res.success, true);
  assert.equal(ctx.store.data.pendingStop, null);
  ctx.pv.atx.busy = false; // the LED still reads on: the OS takes its time
  await ctx.clock.advance(60_000);
  await pause(50);
  assert.deepEqual(ctx.pv.powerActions, ['off']);
});

test('I3 R2: a kept shutdown dropped during its own read is not sent', async (t) => {
  const ctx = await online(t, { power: true });
  await keptStop(ctx);
  let held = true;
  ctx.pv.latencyMs = (r) => (held && r.method === 'GET' ? 200 : 0);
  // The read of the kept shutdown answers "on" (as read before the click below).
  ctx.pv.replyFor = (r) =>
    held && r.method === 'GET'
      ? ok({ enabled: true, busy: false, leds: { power: true, hdd: false } })
      : undefined;
  const gets = ctx.pv.count('GET /api/atx');
  await until(ctx, () => ctx.pv.count('GET /api/atx') > gets, 'its read', { step: 1000 });
  assert.equal((await within(ctx.press('shutdown'), 'ack')).success, true);
  await pause(300);
  held = false;
  ctx.pv.replyFor = undefined;
  await ctx.clock.advance(30_000);
  await pause(50);
  assert.deepEqual(ctx.pv.powerActions, ['off']);
});

test('I3 R3: a Power on that left cancels a kept shutdown', async (t) => {
  const ctx = await online(t, { power: true, config: ALL_ON });
  await keptStop(ctx);
  ctx.pv.atx.leds.power = null;
  await ctx.clock.advance(61_000);
  await pause(30);
  // Read off, answered: the on leaves; then the LED is read on (machine starting).
  ctx.pv.replyFor = (r) =>
    r.method === 'GET' && !ctx.pv.actions.length
      ? ok({ enabled: true, busy: false, leds: { power: false, hdd: false } })
      : undefined;
  ctx.pv.atx.leds.power = true;
  // Keep the kept shutdown alive through the read (no "off" read for considerPending):
  ctx.app.considerPending = () => {};
  const posts = offPosts(ctx.pv);
  assert.equal((await within(ctx.press('power_on'), 'ack')).success, true);
  assert.equal(ctx.store.data.pendingStop, null);
  await ctx.clock.advance(60_000);
  await pause(50);
  assert.equal(offPosts(ctx.pv), posts);
});

test('I3 R8: a forced power off sets the 60 s guard (power on refused after it)', async (t) => {
  const ctx = await online(t, { power: true, config: ALL_ON });
  assert.equal((await within(ctx.press('force_off'), 'ack')).success, true);
  assert.ok(ctx.store.data.stopGuard?.until > ctx.clock.now());
  await ctx.clock.advance(31_000);
  ctx.pv.atx.leds.power = false;
  const res = await within(ctx.press('power_on'), 'ack');
  assert.match(res.error, /less than a minute ago/);
  await ctx.clock.advance(30_000);
  assert.equal((await within(ctx.press('power_on'), 'ack')).success, true);
});

test('I3 R15: a shutdown in flight is not cut by a restart of the session', async (t) => {
  const ctx = await online(t, { power: true });
  ctx.pv.latencyMs = (r) => (r.method === 'POST' ? 300 : 0);
  const press = ctx.press('shutdown');
  await waitFor(() => ctx.pv.count('POST') === 1, 'in flight');
  await ctx.app.start(ctx.raw);
  const res = await within(press, 'ack');
  assert.equal(res.success, true);
  assert.deepEqual(ctx.pv.powerActions, ['off']);
});

test('m1: a Reset follow-up with an unreadable LED never says "reads off"', async (t) => {
  const ctx = await online(t, { power: true, config: ALL_ON });
  assert.equal((await within(ctx.press('reset'), 'ack')).success, true);
  ctx.pv.atx.leds.power = null;
  await until(ctx, () => ctx.app.followUps.size === 0, 'follow-ups done', { step: 1000 });
  await pause(50);
  assert.doesNotMatch(statusText(ctx), /reads off/);
});

test('m2: "not confirmed yet" ends after the last follow-up read', async (t) => {
  const ctx = await online(t, { power: true, config: ALL_ON });
  ctx.pv.replyFor = (r) => (r.method === 'POST' ? 'silent' : undefined);
  await within(ctx.press('reset'), 'ack', 15_000);
  assert.equal(ctx.app.unconfirmed, true);
  ctx.pv.replyFor = undefined;
  await until(ctx, () => ctx.app.unconfirmed === false, 'cleared', { step: 1000 });
  await waitFor(() => ctx.gladys.fake.transports.at(-1)?.degraded !== true, 'badge back');
});

test('m3: Test with the headers and a 401 is a plain failure, never "2FA session ended"', async (t) => {
  const ctx = await online(t);
  ctx.pv.replyFor = () => ({ status: 401, body: { ok: false, result: {} } });
  await ctx.clock.advance(31_000);
  await pause(50);
  ctx.app.lastReadMono = -Infinity;
  const msg = await ctx.app.testConnection();
  assert.doesNotMatch(msg.en, /2FA/);
  assert.match(msg.en, /401/);
});

test('m4: Shut down to a changed certificate says why', async (t) => {
  const ctx = await setup(t, { memory: { pins: {} } });
  ctx.app.memory.pins[ctx.pv.address] = 'AB:'.repeat(31) + 'AB';
  const res = await within(ctx.press('shutdown'), 'ack');
  assert.match(res.error, /certificate of the PiKVM changed/);
  assert.equal(ctx.pv.requests.length, 0);
});

test('m7 R6: a 429 on the PiKVM info pauses the reads', async (t) => {
  const ctx = await setup(t);
  ctx.pv.replyFor = (r) => (r.path === '/api/info' ? { status: 429, body: 'x' } : undefined);
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.paused(), 'paused');
});

test('m7 R28: a guarded command refused when "busy" is missing from the ATX state', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  delete ctx.pv.atx.busy;
  assert.match((await within(ctx.press('power_on'), 'a')).error, /busy/);
  assert.deepEqual(ctx.pv.powerActions, []);
});

test('m7 R33: a kept shutdown is not sent while the credentials are refused', async (t) => {
  const ctx = await online(t, { power: true });
  await keptStop(ctx);
  ctx.app.blocked = true;
  const posts = offPosts(ctx.pv);
  await ctx.clock.advance(60_000);
  await pause(50);
  assert.equal(offPosts(ctx.pv), posts);
});

test('m7 R36: after a restart, a kept shutdown lives 2 min from the click, not from the restart', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, connect: false });
  store.data = {
    pins: { [ctx.pv.address]: ctx.pv.fingerprint },
    pendingStop: {
      address: ctx.pv.address,
      action: 'off',
      at: ctx.clock.now() - 100_000,
      sends: 0,
    },
  };
  ctx.pv.atx.leds.power = null; // never sendable
  await within(ctx.gladys.connect(), 'connect');
  await until(ctx, () => store.data.pendingStop === null, 'expired', { step: 2000 });
  assert.ok(ctx.clock.elapsed < 40_000, `expired at ${ctx.clock.elapsed}`);
});

test('I2: the read of a guarded command that sends nothing still ends a kept shutdown (machine off)', async (t) => {
  const ctx = await online(t, { power: true, config: ALL_ON });
  await keptStop(ctx);
  ctx.pv.atx.leds.power = false; // turned off by hand
  ctx.app.pauseEnd = -Infinity; // the 503s paused the reads (not the point here)
  const res = await within(ctx.press('force_off'), 'ack');
  assert.equal(res.success, true);
  assert.deepEqual(ctx.pv.powerActions, []);
  assert.equal(ctx.store.data.pendingStop, null, 'dropped by that read, before any timer');
});
