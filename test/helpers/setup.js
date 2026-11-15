// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the simulated PiKVM
// (test/helpers/fakePikvm.js), with the exact wiring of the container
// (src/handlers.js). The app's timers are virtual (the kit's testClock: they
// fire only on `advance`), the network is real (127.0.0.1): every wait on the
// network is bounded in real time, so a test fails, it never hangs.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PikvmApp } from '../../src/app.js';
import { addressId } from '../../src/config.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { testClock } from '../kit/clock.mjs';
import { PASSWORD, USER, fakePikvm } from './fakePikvm.js';

/** Real-time wait for a condition, bounded: throws (never hangs) after `timeout` ms. */
export async function waitFor(fn, what = 'the condition', timeout = 4000) {
  const end = performance.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A promise bounded in real time: rejects (never hangs) after `timeout` ms. */
export function within(promise, what = 'the promise', timeout = 6000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} never settled`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded in real time: runs the due virtual timers (advancing `step` ms each
 * turn) until `fn()` is true; throws (never hangs) after `timeout` real ms.
 */
export async function until(ctx, fn, what = 'the condition', { step = 0, timeout = 4000 } = {}) {
  const end = performance.now() + timeout;
  for (;;) {
    await ctx.clock.advance(step);
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The loop is idle: no read in flight, the next one scheduled. */
export const idle = (ctx, what = 'the loop idle') =>
  waitFor(() => !ctx.app.reading && ctx.app.readTimer !== undefined, what);

/** The created device of the PiKVM at `address` (as a user would create it from the Discovery). */
export function createdDevice(address) {
  const id = `ext:test-integration:pikvm:${addressId(address)}`;
  const keys = ['power', 'hdd', 'pikvm_temperature', 'power_on', 'shutdown', 'force_off', 'reset'];
  return {
    external_id: id,
    name: 'PiKVM',
    features: keys.map((k) => ({ external_id: `${id}:${k}`, name: k })),
  };
}

export async function setup(
  t,
  {
    server = {},
    config = {},
    memory,
    store,
    pinned = true,
    connect = true,
    create = true,
    getConfig,
    request,
    clock = testClock(),
  } = {},
) {
  const pv = await fakePikvm(server);
  t.after(() => pv.close());
  const kept =
    store ??
    memoryStore(
      memory === undefined ? (pinned ? { pins: { [pv.address]: pv.fingerprint } } : null) : memory,
    );
  const raw = {
    host: pv.address,
    username: USER,
    password: PASSWORD,
    language: 'en',
    ...config,
  };
  const device = createdDevice(pv.address);
  const gladys = createFakeGladys({ config: raw, devices: create ? [device] : [] });
  if (getConfig) gladys.getConfig = getConfig;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  const app = new PikvmApp({
    gladys,
    logger,
    store: kept,
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
    request,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.shutdown());
  const feature = (key) => ({ external_id: `${device.external_id}:${key}` });
  const press = (key, value = 1) => gladys.fake.setValue(device, feature(key), value);
  const ctx = { pv, gladys, app, clock, store: kept, logs, raw, device, feature, press };
  if (connect) {
    await within(gladys.connect(), 'connect');
  }
  return ctx;
}

/** The last state published for a feature key. */
export const stateOf = (ctx, key) => ctx.gladys.fake.lastState(`${ctx.device.external_id}:${key}`);

/** The text of the last connection status, in English. */
export const statusText = (ctx) => {
  const s = ctx.gladys.fake.connectionStatus;
  const m = s?.message;
  return typeof m === 'string' ? m : (m?.en ?? '');
};
