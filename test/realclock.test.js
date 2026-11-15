// -----------------------------------------------------------------------------
// The real clock, 20 times faster, against the simulated PiKVM: the period of
// the reads and of the work on a kept shutdown, measured (wide margins: a
// timer is late under load, never early). The app is stopped in t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PikvmApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { PASSWORD, USER, fakePikvm } from './helpers/fakePikvm.js';
import { createdDevice, waitFor, within } from './helpers/setup.js';

async function start(t, config) {
  const pv = await fakePikvm();
  t.after(() => pv.close());
  const clock = realClock({ speed: 20 });
  t.after(() => clock.close());
  const raw = {
    host: pv.address,
    username: USER,
    password: PASSWORD,
    poll_interval: 30,
    ...config,
  };
  const device = createdDevice(pv.address);
  const gladys = createFakeGladys({ config: raw, devices: [device] });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new PikvmApp({
    gladys,
    logger,
    store: memoryStore({ pins: { [pv.address]: pv.fingerprint } }),
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.shutdown());
  return { pv, clock, gladys, app, device };
}

test('real clock x20: the reads come at the interval (30 s), measured', async (t) => {
  const { clock, gladys, app } = await start(t);
  const spy = spyOn(app, 'tick', clock);
  t.after(() => spy.restore());
  await within(gladys.connect(), 'connect');
  const gaps = await measurePeriod(spy, { count: 4, period: 30_000 });
  assert.equal(gaps.length, 3);
});

test('real clock x20: a kept shutdown is worked on every 10 s, measured, then taken', async (t) => {
  const { pv, clock, gladys, app, device } = await start(t);
  pv.atx.leds.power = true;
  await within(gladys.connect(), 'connect');
  await waitFor(() => app.online, 'online', 6000);
  let down = true;
  pv.replyFor = (r) => (down && r.method === 'POST' ? { status: 503, body: 'x' } : undefined);
  const spy = spyOn(app, 'workStop', clock);
  t.after(() => spy.restore());
  const ack = gladys.fake.setValue(device, { external_id: `${device.external_id}:shutdown` }, 1);
  assert.equal((await within(ack, 'ack')).success, false);
  const gaps = await measurePeriod(spy, { count: 3, period: 10_000 });
  assert.equal(gaps.length, 2);
  down = false;
  await waitFor(() => pv.powerActions.includes('off'), 'taken', 6000);
  await waitFor(() => app.memory.pendingStop === null, 'dropped', 6000);
});

test('real clock: a shutdown busy without end is acked within the 3.5 s budget (R39)', async (t) => {
  const pv = await fakePikvm();
  t.after(() => pv.close());
  const clock = realClock({ speed: 1 });
  t.after(() => clock.close());
  const raw = { host: pv.address, username: USER, password: PASSWORD };
  const device = createdDevice(pv.address);
  const gladys = createFakeGladys({ config: raw, devices: [device] });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new PikvmApp({
    gladys,
    logger,
    store: memoryStore({ pins: { [pv.address]: pv.fingerprint } }),
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.shutdown());
  await within(gladys.connect(), 'connect');
  pv.latencyMs = (r) => (r.method === 'POST' ? 600 : 0);
  pv.replyFor = (r) =>
    r.method === 'POST'
      ? { status: 409, body: { ok: false, result: { error: 'AtxIsBusyError' } } }
      : undefined;
  const started = performance.now();
  const res = await within(
    gladys.fake.setValue(device, { external_id: `${device.external_id}:shutdown` }, 1),
    'ack',
  );
  const took = performance.now() - started;
  assert.equal(res.success, false);
  assert.ok(took < 3500, `acked after ${Math.round(took)} ms`);
  assert.ok(pv.count('POST') <= 3, `${pv.count('POST')} tries`);
});
