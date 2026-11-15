// -----------------------------------------------------------------------------
// Review r2: the kept shutdown checks a newer start at its first byte (I2b),
// says when a start dropped it (m1), is dropped by another address (m2); an
// older follow-up never confirms a newer command (R13); the badge after the
// last follow-up even while reads are held (N2).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinnedRequest } from '../src/kvmd.js';
import { fakePikvm } from './helpers/fakePikvm.js';
import { idle, pause, setup, statusText, until, waitFor, within } from './helpers/setup.js';

const ALL_ON = { allow_power_on: true, allow_force_off: true, allow_reset: true };

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

async function keptStop(ctx) {
  ctx.pv.replyFor = (r) => (r.method === 'POST' ? { status: 503, body: 'x' } : undefined);
  const res = await ack(ctx, ctx.press('shutdown'));
  assert.match(res.error, /kept and sent again/);
  ctx.pv.replyFor = undefined;
}

test('I2b: a Reset leaving while the kept shutdown connects: the shutdown never follows it', async (t) => {
  let hold;
  const request = async (options) => {
    if (options.method === 'POST' && options.path.includes('action=off') && hold) await hold();
    return pinnedRequest(options);
  };
  const ctx = await online(t, { power: true, config: ALL_ON, request });
  await keptStop(ctx);
  // Neither on nor off read until the 60 s guard and the 503 pause are over.
  ctx.pv.atx.leds.power = null;
  await ctx.clock.advance(61_000);
  await pause(30);
  ctx.pv.atx.leds.power = true;
  let release;
  let reached = false;
  hold = () => {
    hold = undefined;
    reached = true;
    return new Promise((r) => (release = r));
  };
  // The kept work reads "on" and starts its send: held before its first byte.
  await until(ctx, () => reached, 'the kept send connecting', { step: 1000 });
  const res = await within(ctx.press('reset'), 'ack');
  assert.equal(res.success, true);
  release();
  await pause(200);
  await ctx.clock.advance(30_000);
  await pause(50);
  assert.deepEqual(ctx.pv.powerActions, ['reset_hard']);
  assert.equal(ctx.store.data.pendingStop, null);
  assert.match(statusText(ctx), /kept shutdown was dropped: a Power on or Reset left/);
});

test('m1: a refused Reset that dropped the kept shutdown says so', async (t) => {
  const ctx = await online(t, { power: true, config: ALL_ON });
  await keptStop(ctx);
  ctx.pv.atx.leds.power = null;
  await ctx.clock.advance(61_000);
  await pause(30);
  ctx.pv.atx.leds.power = true;
  ctx.pv.replyFor = (r) =>
    r.method === 'POST' && r.query.action === 'reset_hard'
      ? { status: 409, body: { ok: false, result: { error: 'AtxIsBusyError' } } }
      : undefined;
  const res = await within(ctx.press('reset'), 'ack');
  assert.equal(res.success, false);
  assert.equal(ctx.store.data.pendingStop, null);
  assert.match(statusText(ctx), /nothing sent.*kept shutdown was dropped/);
});

test('m2: another address saved drops the kept shutdown; the old address back never resends it', async (t) => {
  const ctx = await online(t, { power: true });
  const b = await fakePikvm();
  t.after(() => b.close());
  ctx.app.memory.pins[b.address] = b.fingerprint;
  await keptStop(ctx);
  await ctx.gladys.fake.configUpdated({ ...ctx.raw, host: b.address });
  assert.equal(ctx.store.data.pendingStop, null);
  assert.match(statusText(ctx), /another PiKVM address was saved/);
  await ctx.gladys.fake.configUpdated({ ...ctx.raw });
  await ctx.clock.advance(60_000);
  await pause(50);
  assert.deepEqual(ctx.pv.powerActions, []);
});

test('R13: a follow-up of an older Power on never confirms after a newer stop click', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  assert.equal((await within(ctx.press('power_on'), 'ack')).success, true);
  // The shutdown is refused by the PiKVM (400): no follow-up of its own.
  ctx.pv.replyFor = (r) =>
    r.method === 'POST'
      ? { status: 400, body: { ok: false, result: { error_msg: 'ATX is disabled' } } }
      : undefined;
  const res = await within(ctx.press('shutdown'), 'ack');
  assert.equal(res.success, false);
  await ctx.clock.advance(25_000);
  await pause(50);
  assert.doesNotMatch(statusText(ctx), /machine reads on/);
});

test('N2: the badge drops "not confirmed" after the last follow-up even during a pause', async (t) => {
  const ctx = await online(t, { power: true, config: ALL_ON });
  ctx.pv.replyFor = (r) => (r.method === 'POST' ? 'silent' : undefined);
  await within(ctx.press('reset'), 'ack', 15_000);
  await waitFor(() => ctx.gladys.fake.transports.at(-1)?.degraded === true, 'degraded');
  ctx.pv.replyFor = undefined;
  ctx.app.pauseEnd = ctx.clock.monotonic() + 600_000;
  await ctx.clock.advance(6000);
  await waitFor(() => ctx.gladys.fake.transports.at(-1)?.degraded !== true, 'badge back');
});
