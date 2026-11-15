// -----------------------------------------------------------------------------
// The configuration: address, fingerprint, credentials, options, /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addressId,
  normalizeConfig,
  parseAddress,
  parseFingerprint,
  sameSession,
} from '../src/config.js';
import { fileStore, normalizeMemory } from '../src/store.js';

test('addresses: HTTPS only, no path, no credentials, no broadcast, no .local', () => {
  assert.deepEqual(parseAddress('192.168.1.20'), {
    host: '192.168.1.20',
    port: 443,
    key: '192.168.1.20:443',
  });
  assert.equal(parseAddress('https://pikvm.lan:8443/').key, 'pikvm.lan:8443');
  assert.equal(parseAddress('[fe80::1]').key, '[fe80::1]:443');
  for (const [raw, error] of [
    ['', 'empty'],
    ['http://1.2.3.4', 'scheme'],
    ['https://u:p@1.2.3.4', 'credentials'],
    ['1.2.3.4/api', 'path'],
    ['1.2.3.4?x', 'path'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'broadcast'],
    ['0.0.0.0', 'broadcast'],
    ['pikvm.local', 'local-name'],
    ['a b', 'invalid'],
    ['1.2.3.4\r\nX: y', 'invalid'],
    ['300.1.1.1', 'invalid'],
  ]) {
    assert.equal(parseAddress(raw).error, error, raw);
  }
});

test('the device id from the address: fixed rule, no dot nor colon', () => {
  assert.equal(addressId('192.168.1.20:443'), '192-168-1-20-443');
  assert.equal(addressId('[fe80::1]:443'), 'fe80-1-443');
  assert.equal(addressId('PiKVM.lan:8443'), 'pikvm-lan-8443');
});

test('fingerprints: 64 hex digits, with or without colons', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(parseFingerprint(hex).fingerprint, 'AB:'.repeat(31) + 'AB');
  assert.equal(parseFingerprint(`SHA256=${hex}`).fingerprint, 'AB:'.repeat(31) + 'AB');
  assert.equal(parseFingerprint('abcd').error, 'fingerprint');
  assert.deepEqual(parseFingerprint(''), {});
});

test('credentials: a password without a user name refused; printable ASCII only', () => {
  const base = { host: '10.0.0.2', username: 'admin', password: 'pw' };
  assert.equal(normalizeConfig(base).error, undefined);
  assert.equal(normalizeConfig({ ...base, username: '' }).error, 'no-username');
  assert.equal(normalizeConfig({ ...base, password: '' }).error, 'no-password');
  assert.equal(normalizeConfig({ ...base, username: '', password: '' }).error, 'no-credentials');
  assert.equal(normalizeConfig({ ...base, password: 'a\r\nb' }).error, 'bad-password');
  assert.equal(normalizeConfig({ ...base, password: 'mot-de-passé' }).error, 'bad-password');
  assert.equal(normalizeConfig({ ...base, username: 'a\u0000' }).error, 'bad-username');
  // A refused configuration never keeps the password.
  assert.equal(normalizeConfig({ ...base, password: 'a\nb' }).password, '');
});

test('options: only true turns a button on; the interval is bounded', () => {
  const c = normalizeConfig({ allow_power_on: 'yes', allow_reset: 1, allow_force_off: true });
  assert.equal(c.allowPowerOn, false);
  assert.equal(c.allowReset, false);
  assert.equal(c.allowForceOff, true);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 600);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 30);
  assert.equal(normalizeConfig({}).twoFactor, false);
  const a = normalizeConfig({ host: '1.2.3.4', username: 'u', password: 'p' });
  assert.equal(sameSession(a, { ...a, allowReset: true }), true);
  assert.equal(sameSession(a, { ...a, twoFactor: true }), false);
});

test('/data repaired: future dates distrusted, sends bounded, pending stop at most 2 min old', () => {
  const now = 1_000_000_000;
  const m = normalizeMemory(
    {
      pins: { 'x:443': 'AB:'.repeat(31) + 'AB', bad: 'zz' },
      pausedUntil: now + 99 * 3_600_000,
      lastReadAt: now + 50_000,
      stopGuard: { address: 'x:443', until: now + 999_999 },
      pendingStop: { address: 'x:443', action: 'off', at: now - 1000, sends: 'x' },
    },
    now,
  );
  assert.deepEqual(Object.keys(m.pins), ['x:443']);
  assert.equal(m.pausedUntil, now + 6 * 3_600_000);
  assert.equal(m.lastReadAt, now);
  assert.equal(m.stopGuard.until, now + 60_000);
  assert.equal(m.pendingStop, null, 'an unreadable count is used up');
  const p = normalizeMemory(
    { pendingStop: { address: 'x:443', action: 'off', at: now - 1000, sends: 1 } },
    now,
  );
  assert.equal(p.pendingStop.sends, 1);
  for (const pendingStop of [
    { address: 'x:443', action: 'off', at: now + 10, sends: 0 },
    { address: 'x:443', action: 'off', at: now - 121_000, sends: 0 },
    { address: 'x:443', action: 'on', at: now - 1000, sends: 0 },
  ]) {
    assert.equal(normalizeMemory({ pendingStop }, now).pendingStop, null);
  }
});

test('fileStore: no file is null; unreadable or special throws; written 0600', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pikvm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ a: 1 });
  assert.deepEqual(await store.load(), { a: 1 });
  await writeFile(path, '{nope');
  await assert.rejects(store.load(), /not JSON/);
  const sub = join(dir, 'd');
  await mkdir(sub);
  await assert.rejects(fileStore(sub).load(), /not a regular file/);
});
