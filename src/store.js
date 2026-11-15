// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in one small JSON file readable by the container user only:
//   - the certificate pinned for each PiKVM address (a public value);
//   - a user name and password refused by the PiKVM, as a 6-bit salted mark
//     only (it can never tell them, it only says "the same ones were refused");
//   - the end of a 429 / 5xx pause, the time of the last read;
//   - the end of the guard that follows a shutdown (power on and reset are
//     refused until then);
//   - a shutdown that the PiKVM never took (busy, unreachable), with the date
//     of the click: sent again by a read that still shows the machine on, at
//     most 2 min after the click, never once a read showed it off.
// No token, no password, no code, no personal data.
//
// `load()` tells "no file" (null) from "a file that cannot be read" (throws):
// an unreadable /data is never taken for an empty one (no pin is learnt over
// it). A special file (FIFO, device, directory) is refused without opening
// it. Writes go one at a time (temporary file, then rename).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/pikvm-state.json';
const MAX_SIZE = 64 * 1024;

export function fileStore(path = STATE_FILE) {
  let chain = Promise.resolve();
  return {
    async load() {
      let info;
      try {
        info = await lstat(path);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (!info.isFile()) throw new Error('state file unreadable (not a regular file)');
      if (info.size > MAX_SIZE) throw new Error('state file too large');
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (text.length > MAX_SIZE) throw new Error('state file too large');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('state file not JSON');
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        if (text.length > MAX_SIZE) throw new Error('state too large');
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip; `failLoad`, `failSave`, `hang`, `hangLoad` break it. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failLoad: false,
    failSave: false,
    hang: false,
    hangLoad: false,
    async load() {
      if (this.hangLoad) return new Promise(() => {});
      if (this.failLoad) throw new Error('state file unreadable (EIO)');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.failSave) throw new Error('EROFS');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** The 6-bit mark of a user name and password with a salt (0 to 63): never enough to find them. */
export const credentialsMark = (salt, username, password) =>
  createHash('sha256').update(`${salt}\n${username}\n${password}`, 'utf8').digest()[0] & 0x3f;

export const newSalt = () => randomBytes(8).toString('hex');

const ADDRESS = /^[a-z0-9.:[\]-]{1,260}$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** An empty memory. */
export const emptyMemory = () => ({
  pins: {},
  refused: null,
  pausedUntil: null,
  lastReadAt: null,
  stopGuard: null,
  pendingStop: null,
});

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * The persisted state, repaired and bounded. A date in the future is not
 * trusted: the last read counts as now, a pause is at most 6 h from now, a
 * stop guard at most its full length from now; a kept shutdown dated in the
 * future or older than 2 min is dropped. An unreadable count of sends is the
 * maximum (never "more sends left").
 */
export function normalizeMemory(raw, now) {
  const data = isObject(raw) ? raw : {};
  const out = emptyMemory();
  for (const [address, fp] of isObject(data.pins) ? Object.entries(data.pins).slice(0, 8) : []) {
    if (ADDRESS.test(address) && typeof fp === 'string' && FINGERPRINT.test(fp)) {
      out.pins[address] = fp;
    }
  }
  const r = data.refused;
  if (
    isObject(r) &&
    typeof r.address === 'string' &&
    ADDRESS.test(r.address) &&
    typeof r.salt === 'string' &&
    /^[0-9a-f]{16}$/.test(r.salt) &&
    Number.isInteger(r.mark) &&
    r.mark >= 0 &&
    r.mark < 64
  ) {
    out.refused = { address: r.address, salt: r.salt, mark: r.mark };
  }
  if (Number.isFinite(data.pausedUntil) && data.pausedUntil > now) {
    out.pausedUntil = Math.min(data.pausedUntil, now + TIMINGS.rateLimitMax);
  }
  if (Number.isFinite(data.lastReadAt)) out.lastReadAt = Math.min(data.lastReadAt, now);
  const g = data.stopGuard;
  if (isObject(g) && typeof g.address === 'string' && ADDRESS.test(g.address)) {
    if (Number.isFinite(g.until) && g.until > now) {
      out.stopGuard = { address: g.address, until: Math.min(g.until, now + TIMINGS.stopGuard) };
    }
  }
  const p = data.pendingStop;
  if (
    isObject(p) &&
    typeof p.address === 'string' &&
    ADDRESS.test(p.address) &&
    p.action === 'off' &&
    Number.isFinite(p.at) &&
    p.at <= now &&
    now - p.at <= TIMINGS.stopKeep
  ) {
    const sends =
      Number.isInteger(p.sends) && p.sends >= 0 && p.sends <= LIMITS.stopSends
        ? p.sends
        : LIMITS.stopSends;
    if (sends < LIMITS.stopSends) {
      out.pendingStop = { address: p.address, action: 'off', at: p.at, sends };
    }
  }
  return out;
}
