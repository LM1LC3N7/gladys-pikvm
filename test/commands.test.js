// -----------------------------------------------------------------------------
// The buttons: Shut down (protective, never held back), Power on, Force power
// off and Reset (off by default, decided on a fresh read, checked again right
// before the first byte).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinnedRequest } from '../src/kvmd.js';
import { memoryStore } from '../src/store.js';
import { idle, pause, setup, statusText, until, waitFor, within } from './helpers/setup.js';

const ALL_ON = { allow_power_on: true, allow_force_off: true, allow_reset: true };

/** Starts the app and waits for the first read. */
async function online(t, options = {}) {
  const ctx = await setup(t, options);
  if (options.power !== undefined) ctx.pv.atx.leds.power = options.power;
  await until(ctx, () => ctx.app.online, 'online');
  await idle(ctx);
  return ctx;
}

/** A press acked, the virtual clock moving `step` ms per turn meanwhile. */
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

test('Shut down: always allowed (every option off), kvmd "off", confirmed by a later read', async (t) => {
  const ctx = await online(t, { power: true });
  const res = await within(ctx.press('shutdown'), 'ack');
  assert.equal(res.success, true);
  assert.deepEqual(ctx.pv.powerActions, ['off']);
  const post = ctx.pv.requests.find((r) => r.method === 'POST');
  assert.equal(post.query.wait, '0');
  await until(ctx, () => /machine reads off/.test(statusText(ctx)), 'confirmed', { step: 1000 });
});

test('Shut down leaves during a 429 pause, without a read, while a read hangs', async (t) => {
  const ctx = await online(t, { power: true });
  ctx.app.pauseEnd = ctx.clock.monotonic() + 600_000;
  let hang = true;
  ctx.pv.replyFor = (r) => (hang && r.method === 'GET' ? 'silent' : undefined);
  const before = ctx.pv.count('GET /api/atx');
  const res = await within(ctx.press('shutdown'), 'ack');
  assert.equal(res.success, true);
  assert.deepEqual(ctx.pv.powerActions, ['off']);
  assert.equal(ctx.pv.count('GET /api/atx'), before, 'no read before a shutdown');
  hang = false;
});

test('Shut down right after a restart, before any read (no getConfig wait beyond start)', async (t) => {
  const ctx = await setup(t, { connect: true });
  ctx.pv.atx.leds.power = true;
  // The first read is not run yet (virtual timer not advanced).
  assert.equal(ctx.pv.count('GET /api/atx'), 0);
  const res = await within(ctx.press('shutdown'), 'ack');
  assert.equal(res.success, true);
  assert.deepEqual(ctx.pv.powerActions, ['off']);
});

test('Shut down retried within the ack budget when the ATX is busy', async (t) => {
  const ctx = await online(t, { power: true });
  let busy = 2;
  ctx.pv.replyFor = (r) =>
    r.method === 'POST' && busy-- > 0
      ? { status: 409, body: { ok: false, result: { error: 'AtxIsBusyError' } } }
      : undefined;
  const res = await ack(ctx, ctx.press('shutdown'));
  assert.equal(res.success, true);
  assert.equal(ctx.pv.count('POST /api/atx/power'), 3);
  assert.equal(ctx.store.data.pendingStop, null);
});

test('Shut down never taken: kept in /data, sent again by its reads, dropped when read off', async (t) => {
  const ctx = await online(t, { power: true });
  let busy = true;
  ctx.pv.replyFor = (r) => (busy && r.method === 'POST' ? { status: 503, body: 'x' } : undefined);
  const res = await ack(ctx, ctx.press('shutdown'));
  assert.equal(res.success, false);
  assert.match(res.error, /kept and sent again/);
  assert.equal(ctx.store.data.pendingStop.action, 'off');
  assert.match(statusText(ctx), /shutdown not taken by the PiKVM is kept/);
  busy = false;
  await until(ctx, () => ctx.pv.powerActions.includes('off'), 'sent again', { step: 1000 });
  await until(ctx, () => ctx.store.data.pendingStop === null, 'dropped', { step: 1000 });
});

test('a kept shutdown is dropped by a read of the machine off; never sent then', async (t) => {
  const ctx = await online(t, { power: true });
  ctx.pv.replyFor = (r) => (r.method === 'POST' ? { status: 503, body: 'x' } : undefined);
  await ack(ctx, ctx.press('shutdown'));
  assert.ok(ctx.store.data.pendingStop);
  // Turned off by hand meanwhile.
  ctx.pv.atx.leds.power = false;
  ctx.pv.replyFor = undefined;
  await until(ctx, () => ctx.store.data.pendingStop === null, 'dropped', { step: 1000 });
  assert.deepEqual(ctx.pv.powerActions, []);
});

test('a kept shutdown gives up after 3 answered sends or 2 min', async (t) => {
  const ctx = await online(t, { power: true });
  ctx.pv.replyFor = (r) =>
    r.method === 'POST'
      ? { status: 409, body: { ok: false, result: { error: 'AtxIsBusyError' } } }
      : undefined;
  await ack(ctx, ctx.press('shutdown'));
  await until(ctx, () => ctx.store.data.pendingStop === null, 'given up', {
    step: 2000,
    timeout: 8000,
  });
  // 4 in the budget + 3 by the reads at most.
  assert.ok(ctx.pv.count('POST /api/atx/power') <= 4 + 3, `${ctx.pv.count('POST')}`);
  assert.match(statusText(ctx), /given up/);
});

test('Shut down left without an answer: "sent, without confirmation", never sent again', async (t) => {
  const ctx = await online(t, { power: true });
  ctx.pv.replyFor = (r) => (r.method === 'POST' ? 'silent' : undefined);
  const res = await within(ctx.press('shutdown'), 'ack', 15_000);
  assert.equal(res.success, false);
  assert.match(res.error, /without confirmation/);
  assert.equal(ctx.store.data.pendingStop, null);
  await ctx.clock.advance(200_000);
  await pause(50);
  assert.equal(ctx.pv.count('POST /api/atx/power'), 1);
});

test('a kept shutdown in /data after a restart: sent only on a read showing the machine on', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, connect: false });
  store.data = {
    pins: { [ctx.pv.address]: ctx.pv.fingerprint },
    pendingStop: { address: ctx.pv.address, action: 'off', at: ctx.clock.now() - 1000, sends: 0 },
  };
  ctx.pv.atx.leds.power = true;
  await within(ctx.gladys.connect(), 'connect');
  await until(ctx, () => ctx.pv.powerActions.includes('off'), 'sent after a read', { step: 500 });
  const firstPost = ctx.pv.requests.findIndex((r) => r.method === 'POST');
  assert.ok(
    ctx.pv.requests.slice(0, firstPost).some((r) => r.path === '/api/atx'),
    'a read came first',
  );
});

test('a kept shutdown too old (> 2 min) or dated in the future is dropped at restart', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, connect: false });
  store.data = {
    pins: { [ctx.pv.address]: ctx.pv.fingerprint },
    pendingStop: { address: ctx.pv.address, action: 'off', at: ctx.clock.now() + 60_000, sends: 0 },
  };
  ctx.pv.atx.leds.power = true;
  await within(ctx.gladys.connect(), 'connect');
  await until(ctx, () => ctx.app.online, 'online', { step: 500 });
  await ctx.clock.advance(30_000);
  await pause(30);
  assert.deepEqual(ctx.pv.powerActions, []);
});

test('2FA without a session: Shut down says so, nothing sent', async (t) => {
  const ctx = await setup(t, { config: { two_factor: true } });
  ctx.pv.twoFactor = true;
  const res = await within(ctx.press('shutdown'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /log in with a code first/);
  assert.equal(ctx.pv.requests.length, 0);
});

test('Power on, Force power off, Reset: refused by default, nothing sent (no read either)', async (t) => {
  const ctx = await online(t, { power: false });
  const before = ctx.pv.requests.length;
  for (const key of ['power_on', 'force_off', 'reset']) {
    const res = await within(ctx.press(key), key);
    assert.equal(res.success, false, key);
    assert.match(res.error, /off in the configuration/);
  }
  assert.equal(ctx.pv.requests.length, before);
});

test('Power on allowed: a fresh read, then kvmd "on"; confirmed by the follow-up read', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  const reads = ctx.pv.count('GET /api/atx');
  const res = await within(ctx.press('power_on'), 'ack');
  assert.equal(res.success, true);
  assert.equal(ctx.pv.count('GET /api/atx'), reads + 1, 'read after the click');
  assert.deepEqual(ctx.pv.powerActions, ['on']);
  await until(ctx, () => /machine reads on/.test(statusText(ctx)), 'confirmed', { step: 1000 });
});

test('Power on: the machine already on, nothing sent', async (t) => {
  const ctx = await online(t, { power: true, config: ALL_ON });
  const res = await within(ctx.press('power_on'), 'ack');
  assert.equal(res.success, true);
  assert.deepEqual(ctx.pv.powerActions, []);
});

test('Reset of a machine off is refused; on: kvmd "reset_hard"', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  const res = await within(ctx.press('reset'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /machine is off: Reset refused/);
  ctx.pv.atx.leds.power = true;
  const ok = await within(ctx.press('reset'), 'ack');
  assert.equal(ok.success, true);
  assert.deepEqual(ctx.pv.powerActions, ['reset_hard']);
});

test('Force power off: kvmd "off_hard" on a machine on; already off: nothing sent', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  const off = await within(ctx.press('force_off'), 'ack');
  assert.equal(off.success, true);
  assert.deepEqual(ctx.pv.powerActions, []);
  ctx.pv.atx.leds.power = true;
  const res = await within(ctx.press('force_off'), 'ack');
  assert.equal(res.success, true);
  assert.deepEqual(ctx.pv.powerActions, ['off_hard']);
});

test('one guarded command per 30 s; power on and reset refused for 60 s after a shutdown', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  assert.equal((await within(ctx.press('power_on'), 'ack')).success, true);
  ctx.pv.atx.leds.power = false;
  const again = await within(ctx.press('power_on'), 'ack');
  assert.match(again.error, /One command per 30 s/);
  await ctx.clock.advance(31_000);
  ctx.pv.atx.leds.power = true;
  assert.equal((await within(ctx.press('shutdown'), 'ack')).success, true);
  ctx.pv.atx.leds.power = false;
  const guarded = await within(ctx.press('power_on'), 'ack');
  assert.match(guarded.error, /shutdown was asked less than a minute ago/);
  assert.ok(ctx.store.data.stopGuard.until > ctx.clock.now());
  const reset = await within(ctx.press('reset'), 'ack');
  assert.match(reset.error, /less than a minute ago/);
  await ctx.clock.advance(61_000);
  assert.equal((await within(ctx.press('power_on'), 'ack')).success, true);
});

test('the stop guard survives a restart (/data)', async (t) => {
  const store = memoryStore(null);
  const ctx = await setup(t, { store, connect: false, config: ALL_ON });
  store.data = {
    pins: { [ctx.pv.address]: ctx.pv.fingerprint },
    stopGuard: { address: ctx.pv.address, until: ctx.clock.now() + 40_000 },
  };
  await within(ctx.gladys.connect(), 'connect');
  await until(ctx, () => ctx.app.online, 'online');
  const res = await within(ctx.press('power_on'), 'ack');
  assert.match(res.error, /less than a minute ago/);
  assert.deepEqual(ctx.pv.powerActions, []);
});

test('a shutdown arriving during the read of a power on cancels it: nothing sent after the stop', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  ctx.pv.latencyMs = (r) => (r.method === 'GET' ? 150 : 0);
  const on = ctx.press('power_on');
  await waitFor(() => ctx.pv.requests.at(-1)?.method === 'GET', 'the read of the power on');
  const stop = ctx.press('shutdown');
  const [a, b] = await within(Promise.all([on, stop]), 'acks');
  assert.equal(a.success, false);
  assert.match(a.error, /shutdown came after this command/);
  assert.equal(b.success, true);
  assert.ok(!ctx.pv.powerActions.includes('on'));
});

test('the option is checked again right before the first byte', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  ctx.pv.latencyMs = (r) => (r.method === 'GET' ? 150 : 0);
  const on = ctx.press('power_on');
  await waitFor(() => ctx.pv.requests.at(-1)?.method === 'GET', 'the read');
  await ctx.gladys.fake.configUpdated({ ...ctx.raw, ...ALL_ON, allow_power_on: false });
  const res = await within(on, 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /off in the configuration/);
  assert.deepEqual(ctx.pv.powerActions, []);
});

test('a guarded command refused while the ATX is busy, disabled or the LED unreadable', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  ctx.pv.atx.busy = true;
  assert.match((await within(ctx.press('power_on'), 'a')).error, /busy/);
  ctx.pv.atx.busy = false;
  ctx.pv.atx.enabled = false;
  assert.match((await within(ctx.press('power_on'), 'b')).error, /ATX is disabled/);
  ctx.pv.atx.enabled = true;
  ctx.pv.atx.leds.power = null;
  assert.match((await within(ctx.press('power_on'), 'c')).error, /could not be read/);
  assert.deepEqual(ctx.pv.powerActions, []);
});

test('a guarded command during a 429 pause is refused; a failed read sends nothing', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  ctx.app.pauseEnd = ctx.clock.monotonic() + 60_000;
  assert.match((await within(ctx.press('power_on'), 'a')).error, /asked to wait/);
  ctx.app.pauseEnd = -Infinity;
  ctx.pv.replyFor = (r) => (r.method === 'GET' ? { status: 500, body: 'x' } : undefined);
  assert.match((await within(ctx.press('power_on'), 'b')).error, /could not be read/);
  assert.deepEqual(ctx.pv.powerActions, []);
});

test('a guarded command left without an answer: "sent, without confirmation"', async (t) => {
  const ctx = await online(t, { power: false, config: ALL_ON });
  ctx.pv.replyFor = (r) => (r.method === 'POST' ? 'silent' : undefined);
  const res = await within(ctx.press('power_on'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /without confirmation/);
});

test('only a press: 0, true or a text are refused; a LED feature is read only', async (t) => {
  const ctx = await online(t, { power: true });
  for (const value of [0, 2, 'x']) {
    const res = await within(ctx.press('shutdown', value), 'ack');
    assert.equal(res.success, false);
  }
  const ro = await within(ctx.press('power'), 'ack');
  assert.match(ro.error, /read only/);
  assert.deepEqual(ctx.pv.powerActions, []);
});

test('a scene pressing Shut down on a slow PiKVM still gets it through', async (t) => {
  const ctx = await online(t, { power: true });
  ctx.pv.latencyMs = 800;
  const res = await within(ctx.press('shutdown'), 'ack');
  assert.equal(res.success, true);
  assert.deepEqual(ctx.pv.powerActions, ['off']);
});

test('beforeSend: the option unchecked between the read and the first byte sends nothing', async (t) => {
  let hook;
  const request = async (options) => {
    if (options.method === 'POST' && hook) await hook();
    return pinnedRequest(options);
  };
  const ctx = await online(t, { power: false, config: ALL_ON, request });
  hook = () => ctx.gladys.fake.configUpdated({ ...ctx.raw, ...ALL_ON, allow_power_on: false });
  const res = await within(ctx.press('power_on'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /off in the configuration/);
  assert.deepEqual(ctx.pv.powerActions, []);
  assert.equal(ctx.pv.count('POST'), 0);
});

test('beforeSend: a shutdown between the read and the first byte cancels a power on', async (t) => {
  let hook;
  const request = async (options) => {
    if (options.method === 'POST' && options.path.includes('action=on') && hook) {
      const h = hook;
      hook = undefined;
      await h();
    }
    return pinnedRequest(options);
  };
  const ctx = await online(t, { power: false, config: ALL_ON, request });
  let stop;
  hook = async () => {
    stop = ctx.press('shutdown');
    await pause(1);
  };
  const res = await within(ctx.press('power_on'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /shutdown came after|less than a minute/);
  await within(stop, 'stop');
  assert.ok(!ctx.pv.powerActions.includes('on'));
});

test('beforeSend: past the 3.5 s budget, nothing is sent ("too late")', async (t) => {
  let hook;
  const request = async (options) => {
    if (options.method === 'POST' && hook) await hook();
    return pinnedRequest(options);
  };
  const ctx = await online(t, { power: false, config: ALL_ON, request });
  hook = () => ctx.clock.advance(3450);
  const res = await within(ctx.press('power_on'), 'ack');
  assert.equal(res.success, false);
  assert.match(res.error, /too slowly/);
  assert.equal(ctx.pv.count('POST'), 0);
});

test('a kept shutdown expires 2 min after the click when the ATX stays busy', async (t) => {
  const ctx = await online(t, { power: true });
  ctx.pv.replyFor = (r) => (r.method === 'POST' ? { status: 503, body: 'x' } : undefined);
  await ack(ctx, ctx.press('shutdown'));
  ctx.pv.replyFor = undefined;
  ctx.pv.atx.busy = true;
  const posts = ctx.pv.count('POST');
  await until(ctx, () => ctx.store.data.pendingStop === null, 'expired', {
    step: 5000,
    timeout: 8000,
  });
  assert.equal(ctx.pv.count('POST'), posts, 'never sent while busy');
  assert.ok(ctx.clock.elapsed >= 120_000);
});

test('a kept shutdown is not sent while the power LED reads neither on nor off', async (t) => {
  const ctx = await online(t, { power: true });
  ctx.pv.replyFor = (r) => (r.method === 'POST' ? { status: 503, body: 'x' } : undefined);
  await ack(ctx, ctx.press('shutdown'));
  ctx.pv.replyFor = undefined;
  ctx.pv.atx.leds.power = null;
  const posts = ctx.pv.count('POST');
  await until(ctx, () => ctx.store.data.pendingStop === null, 'expired', {
    step: 5000,
    timeout: 8000,
  });
  assert.equal(ctx.pv.count('POST'), posts);
});
