// -----------------------------------------------------------------------------
// The integration: one PiKVM (kvmd HTTP API, local HTTPS, pinned certificate)
// and the ATX power of the machine it is wired to, as one Gladys device: the
// power and disk LEDs, the PiKVM temperature, and four buttons.
//
// Access: the kvmd user name and password in the headers of each request
// (refused, 403 on the ATX read: kept as a 6-bit mark in /data, never tried
// again alone). With two-factor authentication: a session opened by the
// "Log in with a 2FA code" button (password + code, POST /api/auth/login),
// its token kept in memory only; lost (restart, 401/403): a new code is asked.
//
// Reads (GET /api/atx), at the interval, never sooner after the last one,
// even across a restart (/data). The PiKVM's own data (GET /api/info) every
// 5 min at most, a secondary read: its failure never stops the ATX reads.
// A 429 / 5xx pauses every path but the shutdown.
//
// Buttons:
//   - Shut down (kvmd `off`: a short press of the power button, nothing when
//     the machine is already off) is protective: never held back by an
//     option, a pause, a read or another command in flight; retried within
//     the ack budget when the PiKVM did not take it (busy, 5xx, not sent);
//     still not taken: kept in /data and sent again (3 times at most, 2 min
//     at most) by a read that shows the machine still on, dropped as soon as
//     a read shows it off. A send that left without an answer is never sent
//     again (a second press could be taken by the machine).
//   - Power on, Force power off (5 s press), Reset are off by default (one
//     option each); each one decides on a read of the ATX made after the
//     click, is checked again right before its first byte, one at a time, one
//     per 30 s; power on and reset are refused for 60 s after a shutdown.
//
// Clocks: wall time only for /data, monotonic for every decision.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseAddress, sameConfig, sameSession } from './config.js';
import { BUTTONS, FEATURES, LIMITS, PRESSED, TIMINGS } from './constants.js';
import { buildDevice, featureOf, pikvmIds } from './devices.js';
import { KvmdError, createKvmd, login, readFingerprint } from './kvmd.js';
import { T, word } from './i18n.js';
import { credentialsMark, emptyMemory, fileStore, newSalt, normalizeMemory } from './store.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/** A command refused or failed, with the text the user reads (in the configured language). */
export class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
  }
}

/** Retryable for a shutdown: the PiKVM did not take it (or it never left). */
const notTaken = (err) =>
  ['busy', 'server', 'rate'].includes(err?.kind) ||
  (['network', 'timeout'].includes(err?.kind) && !err.sent);

export class PikvmApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'pikvm' }),
    store = fileStore(),
    now = Date.now,
    mono = () => performance.now(),
    timers = globalThis,
    fingerprint = readFingerprint,
    loginFn = login,
    request,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.mono = mono;
    this.timers = timers;
    this.readFingerprint = fingerprint;
    this.login = loginFn;
    this.request = request;
    this.raw = {};
    this.config = normalizeConfig();
    this.memory = emptyMemory();
    /** 'unloaded' | 'loaded' | 'unreadable' */
    this.memoryState = 'unloaded';
    this.generation = 0;
    this.started = false;
    this.closed = false;
    this.connectSeq = 0;
    this.configFailures = 0;
    this.configTimer = undefined;
    // Session (reset at each start).
    this.client = null;
    this.abort = new AbortController();
    /** Shutdowns are not cut by a restart of the session, only by the container's end. */
    this.stopAbort = new AbortController();
    this.online = false;
    this.lastError = undefined;
    this.failures = 0;
    this.reading = false;
    this.readTimer = undefined;
    this.lastReadMono = -Infinity;
    this.blocked = false;
    this.pauseEnd = -Infinity;
    this.pinError = undefined;
    /** 2FA session token (memory only) and the account it belongs to. */
    this.token = '';
    this.tokenFor = '';
    this.tokenLost = false;
    // What was read.
    /** { enabled, busy, power, hdd, at (monotonic) } of the last ATX read */
    this.atx = undefined;
    /** { temperature, model, at } */
    this.info = undefined;
    this.infoDue = -Infinity;
    this.infoHold = undefined;
    // Commands.
    this.counter = 0;
    this.epoch = 0;
    this.stopGuardEnd = -Infinity;
    this.commandBusy = false;
    this.lastCommandMono = -Infinity;
    this.followUps = new Set();
    /** The last command result shown in the status: { text, at } */
    this.note = undefined;
    this.unconfirmed = false;
    // Kept shutdown.
    this.pendingDeadline = -Infinity;
    this.stopTimer = undefined;
    this.stopWorking = false;
    // Gladys side.
    this.created = new Set();
    this.publishedDevice = undefined;
    this.lastTransport = undefined;
    this.lastStatus = undefined;
    this.stateWindow = [];
    // Buttons of the configuration screen.
    this.lastTest = undefined;
    this.pendingTrust = undefined;
    this.lastAttemptSaved = -Infinity;
  }

  // --- /data ---------------------------------------------------------------------

  /** A promise bounded in time: a slow /data never holds what waits on it. */
  bounded(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => reject(new Error('timed out')), ms);
      Promise.resolve(promise).then(
        (v) => {
          this.timers.clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          this.timers.clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /** One read of /data at a time (a slow one is waited for by the next try). */
  readStore() {
    if (!this.loading) {
      this.loading = Promise.resolve()
        .then(() => this.store.load())
        .finally(() => {
          this.loading = undefined;
        });
    }
    return this.loading;
  }

  async loadMemory() {
    if (this.memoryState !== 'unloaded') return;
    try {
      const raw = await this.bounded(this.readStore(), TIMINGS.dataWait);
      this.memory = normalizeMemory(raw, this.now());
      this.memoryState = 'loaded';
    } catch (err) {
      // Unreadable is not empty: nothing learnt is written over it; read again
      // every 10 s (one read at a time), the start goes on meanwhile.
      this.memoryState = 'unreadable';
      this.logger.warn(`PiKVM: /data unreadable (${err?.message ?? 'error'}): read again in 10 s`);
      this.armMemoryRetry();
    }
    this.memoryTimes();
  }

  /** The pause, the last read and the stop guard kept in /data, applied to the clocks of this run. */
  memoryTimes() {
    const now = this.now();
    const mono = this.mono();
    const left = (this.memory.pausedUntil ?? 0) - now;
    if (left > 0) {
      this.pauseEnd = Math.max(this.pauseEnd, mono + Math.min(left, TIMINGS.rateLimitMax));
    }
    // Written at most once a minute: it may have been up to a minute later than kept.
    if (this.memory.lastReadAt !== null) {
      const ago = Math.max(0, now - this.memory.lastReadAt - TIMINGS.attemptWriteEvery);
      this.lastReadMono = Math.max(this.lastReadMono, mono - ago);
    }
    const guard = this.memory.stopGuard;
    if (guard && guard.until > now) {
      this.stopGuardEnd = Math.max(
        this.stopGuardEnd,
        mono + Math.min(guard.until - now, TIMINGS.stopGuard),
      );
    }
    const pending = this.memory.pendingStop;
    if (pending) {
      this.pendingDeadline = mono + Math.max(0, TIMINGS.stopKeep - (now - pending.at));
    }
  }

  armMemoryRetry() {
    if (this.memoryTimer !== undefined || this.closed) return;
    this.memoryTimer = this.timers.setTimeout(async () => {
      this.memoryTimer = undefined;
      if (this.memoryState !== 'unreadable' || this.closed) return;
      let raw;
      try {
        raw = await this.bounded(this.readStore(), TIMINGS.dataWait);
      } catch {
        this.armMemoryRetry();
        return;
      }
      if (this.memoryState !== 'unreadable' || this.closed) return;
      this.adoptLateMemory(raw);
    }, TIMINGS.dataRetry);
  }

  /** /data read at last: what this run decided meanwhile wins; the session starts again with it. */
  adoptLateMemory(raw) {
    const late = normalizeMemory(raw, this.now());
    const mine = this.memory;
    late.pins = { ...late.pins, ...mine.pins };
    if (mine.refused) late.refused = mine.refused;
    late.pausedUntil = Math.max(late.pausedUntil ?? 0, mine.pausedUntil ?? 0) || null;
    late.lastReadAt = Math.max(late.lastReadAt ?? 0, mine.lastReadAt ?? 0) || null;
    if (mine.stopGuard && (!late.stopGuard || mine.stopGuard.until > late.stopGuard.until)) {
      late.stopGuard = mine.stopGuard;
    }
    if (mine.pendingStop) late.pendingStop = mine.pendingStop;
    this.memory = late;
    this.memoryState = 'loaded';
    this.memoryTimes();
    this.logger.info('PiKVM: /data read');
    this.saveSoon().catch(() => {});
    if (this.started && !this.closed) this.background(this.start(this.raw));
  }

  /** Writes /data in the background (never awaited on a command path). */
  saveSoon() {
    if (this.memoryState !== 'loaded') return Promise.reject(new Error('/data unreadable'));
    const write = Promise.resolve(this.store.save(this.memory));
    write.catch((err) => this.logger.warn(`PiKVM: writing /data failed (${err?.message})`));
    return write;
  }

  /** Writes /data and waits for it, bounded: for what must be kept before going on (a pin). */
  async saveNow() {
    if (this.memoryState !== 'loaded') throw new Error('/data unreadable');
    await this.bounded(this.store.save(this.memory), TIMINGS.dataWait);
  }

  // --- Lifecycle -----------------------------------------------------------------

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read; when that fails, it is tried again, spaced (5 s,
   * 15 s, 30 s, then every minute), without end, the status saying so.
   */
  async connectedWith(getConfig) {
    const seq = ++this.connectSeq;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (seq !== this.connectSeq || this.closed) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `PiKVM: reading the configuration failed (${err?.message ?? 'error'}); next try in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(Math.round(wait / 1000)));
      if (seq !== this.connectSeq || this.closed) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connectedWith(getConfig).catch(() => this.logger.error('PiKVM: start failed'));
      }, wait);
      return;
    }
    if (seq !== this.connectSeq || this.closed) return;
    this.configFailures = 0;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw, { reconnected: true });
  }

  async configUpdated(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw, { reconnected: false });
  }

  /** The same configuration keeps the session; options only keep it too; another one starts again. */
  async applyConfig(raw, { reconnected }) {
    const next = normalizeConfig(raw);
    if (sameConfig(next, this.config)) {
      this.raw = { ...(raw ?? {}) };
      // Gladys may have restarted: what it keeps in memory only is sent again
      // (status, Discovery, badge), never an old value as a new one.
      this.lastStatus = undefined;
      this.publishedDevice = undefined;
      this.lastTransport = undefined;
      this.refreshCreated();
      await this.publishDevice();
      await this.showStatus();
      await this.publishTransport();
      return;
    }
    if (sameSession(next, this.config)) {
      // Options only (buttons, language, interval): the session goes on.
      this.raw = { ...(raw ?? {}) };
      this.config = next;
      await this.publishDevice();
      if (this.online && !this.reading) {
        const interval = this.readInterval();
        this.scheduleRead(
          this.generation,
          clamp(this.lastReadMono + interval - this.mono(), 0, interval),
        );
      }
      await this.showStatus();
      await this.publishTransport();
      return;
    }
    if (!reconnected) this.logger.info('PiKVM: configuration changed, starting again');
    await this.start(raw);
  }

  accountKey(c = this.config) {
    return c.address && c.username ? `${c.address}\n${c.username}\n${c.password}` : '';
  }

  /**
   * A new session. The first read is `tick`'s to time: never sooner than the
   * interval after the last read (this run, or /data after a restart), nor
   * during a pause; another address or account reads at once.
   */
  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    this.raw = { ...(raw ?? {}) };
    const previous = this.config;
    this.config = normalizeConfig(raw);
    await this.loadMemory();
    if (!this.current(generation)) return;
    const accountChanged =
      previous.address !== undefined && this.accountKey(previous) !== this.accountKey();
    if (accountChanged && this.memory.refused) {
      // Other credentials saved while running are tried: the refusal kept in
      // /data is the older ones' (its 6-bit mark alone would take the new ones
      // for them 1 time in 64).
      this.memory.refused = null;
      this.saveSoon().catch(() => {});
    }
    if (accountChanged) this.lastReadMono = -Infinity;
    if (previous.address !== this.config.address) {
      this.atx = undefined;
      this.info = undefined;
      this.infoDue = -Infinity;
    }
    if (this.tokenFor !== this.accountKey() || !this.config.twoFactor) {
      this.token = '';
      this.tokenFor = '';
    }
    this.abort = new AbortController();
    this.online = false;
    this.lastError = undefined;
    this.failures = 0;
    this.pinError = undefined;
    this.lastStatus = undefined;
    this.publishedDevice = undefined;
    this.lastTransport = undefined;
    this.infoHold = undefined;
    this.refreshCreated();
    this.adoptConfigPin();
    this.blocked = this.refusalKept();
    if (this.config.error) {
      await this.showStatus();
      return;
    }
    await this.publishDevice();
    await this.showStatus();
    if (!this.current(generation)) return;
    this.armStopWork(0);
    this.scheduleRead(generation, 0);
  }

  /** The reads and the timers of this run end; a shutdown in flight goes on. */
  stop({ shutdown = false } = {}) {
    this.generation += 1;
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    for (const timer of this.followUps) this.timers.clearTimeout(timer);
    this.followUps.clear();
    this.abort.abort();
    this.client = null;
    this.online = false;
    this.reading = false;
    if (shutdown) {
      this.closed = true;
      this.timers.clearTimeout(this.configTimer);
      this.timers.clearTimeout(this.memoryTimer);
      this.timers.clearTimeout(this.stopTimer);
      this.memoryTimer = undefined;
      this.configTimer = undefined;
      this.stopTimer = undefined;
    }
  }

  /** The container stops: everything ends; /data keeps the last state (bounded wait). */
  async shutdown() {
    this.stop({ shutdown: true });
    this.stopAbort.abort();
    if (this.memoryState === 'loaded') await this.saveNow().catch(() => {});
  }

  current(generation) {
    return generation === this.generation && !this.closed;
  }

  pauseLeft() {
    return Math.max(0, this.pauseEnd - this.mono());
  }

  paused() {
    return this.pauseLeft() > 0;
  }

  // --- Pin, credentials, refusal -------------------------------------------------------

  /** The pin of the configuration's address: the field typed by the user, else /data. */
  pin(address = this.config.address) {
    if (address === this.config.address && this.config.fingerprint) return this.config.fingerprint;
    return this.memory.pins[address];
  }

  /** A fingerprint typed in the configuration is kept in /data (it is the pin from then on). */
  adoptConfigPin() {
    const { address, fingerprint } = this.config;
    if (!address || !fingerprint || this.memory.pins[address] === fingerprint) return;
    this.memory.pins[address] = fingerprint;
    this.saveSoon().catch(() => {});
  }

  refusalKept() {
    const r = this.memory.refused;
    const c = this.config;
    if (c.twoFactor || !r || r.address !== c.address || !c.username) return false;
    return credentialsMark(r.salt, c.username, c.password) === r.mark;
  }

  /** The user name or password was refused (403 on the ATX read): kept, never tried alone. */
  refuseCredentials(account) {
    if (account.key !== this.accountKey()) return;
    if (this.blocked) return;
    this.blocked = true;
    this.logger.warn(
      'PiKVM: the user name or password was refused; waiting for new ones or the Test button',
    );
    const salt = newSalt();
    this.memory.refused = {
      address: account.address,
      salt,
      mark: credentialsMark(salt, account.username, account.password),
    };
    this.saveSoon().catch(() => {});
  }

  clearRefusal() {
    this.blocked = false;
    if (this.memory.refused) {
      this.memory.refused = null;
      this.saveSoon().catch(() => {});
    }
  }

  /** The credentials of a request: the headers, or the 2FA session token; null: none usable. */
  auth() {
    const c = this.config;
    if (c.error) return null;
    if (c.twoFactor) {
      return this.token && this.tokenFor === this.accountKey() ? { token: this.token } : null;
    }
    return { username: c.username, password: c.password };
  }

  /** The 2FA session is gone (401/403 with the token): a new code is asked. */
  dropToken(token) {
    if (!token || this.token !== token) return;
    this.token = '';
    this.tokenFor = '';
    this.tokenLost = true;
    this.logger.warn('PiKVM: the 2FA session ended; log in again with a new code');
  }

  /** A client of this session (address and pin frozen; credentials read at each request). */
  sessionClient() {
    if (!this.client) this.client = this.newClient(this.abort.signal);
    return this.client;
  }

  newClient(signal, c = this.config, pin = this.pin()) {
    return createKvmd({
      host: c.host,
      port: c.port,
      pin,
      auth: () => this.auth(),
      secrets: () => [c.password, this.token],
      request: this.request,
      signal,
    });
  }

  // --- Reading -------------------------------------------------------------------

  readInterval() {
    return this.config.pollInterval * 1000;
  }

  scheduleRead(generation, ms) {
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = this.timers.setTimeout(() => {
      this.readTimer = undefined;
      if (this.current(generation)) {
        this.tick(generation).catch((err) => this.logger.error(`PiKVM loop: ${err?.message}`));
      }
    }, ms);
  }

  /** Records the time of a read before it leaves (in /data at most once a minute). */
  noteAttempt() {
    const now = this.mono();
    this.lastReadMono = now;
    if (this.memoryState !== 'loaded') return;
    if (now - this.lastAttemptSaved < TIMINGS.attemptWriteEvery) return;
    this.lastAttemptSaved = now;
    this.memory.lastReadAt = this.now();
    this.saveSoon().catch(() => {});
  }

  /** Why no read can leave now (nothing sent), or undefined. */
  readBlocker() {
    if (this.config.error) return 'config';
    if (!this.pin()) return 'nopin';
    if (this.blocked) return 'credentials';
    if (!this.auth()) return 'code';
    return undefined;
  }

  async tick(generation) {
    if (!this.current(generation) || this.reading) return;
    if (this.readBlocker()) {
      this.online = false;
      await this.showStatus();
      await this.publishTransport();
      return;
    }
    if (this.paused()) {
      await this.showStatus();
      this.scheduleRead(generation, this.pauseLeft());
      return;
    }
    // Never sooner than the interval after the last read, whoever made it.
    const early = this.lastReadMono + this.readInterval() - this.mono();
    if (early > 0) {
      this.scheduleRead(generation, early);
      return;
    }
    this.reading = true;
    const client = this.sessionClient();
    const previousRead = this.lastReadMono;
    const auth = this.auth();
    this.noteAttempt();
    try {
      const atx = await client.atx({ timeout: TIMINGS.readTimeout });
      if (!this.current(generation)) return;
      await this.readInfo(client, generation);
      if (!this.current(generation)) return;
      await this.takeRead(atx);
    } catch (err) {
      // A certificate refused at the handshake: nothing reached the PiKVM, so
      // it does not count as a read.
      if (err?.kind === 'pin' || err?.kind === 'nopin') this.lastReadMono = previousRead;
      if (this.current(generation)) await this.fail(generation, err, auth);
      return;
    } finally {
      if (this.current(generation)) this.reading = false;
    }
    if (!this.current(generation)) return;
    this.scheduleRead(generation, this.readInterval());
  }

  /**
   * The PiKVM's own data, every 5 min at most: a secondary read. A 401/403
   * there is never a refusal (spaced, doubling up to 1 h); any failure leaves
   * the ATX reads alone; a 429 pauses, a changed certificate stops the cycle.
   */
  async readInfo(client, generation) {
    const now = this.mono();
    if (now < this.infoDue || (this.infoHold && now < this.infoHold.until)) return;
    try {
      const info = await client.info({ timeout: TIMINGS.readTimeout });
      if (!this.current(generation)) return;
      this.info = { ...info, at: this.mono() };
      this.infoHold = undefined;
      this.infoDue = this.mono() + TIMINGS.infoEvery;
    } catch (err) {
      if (['pin', 'nopin', 'aborted'].includes(err?.kind)) throw err;
      if (err?.kind === 'rate') this.pause(err);
      this.infoDue = this.mono() + TIMINGS.infoEvery;
      if (err?.kind === 'auth' || err?.kind === 'unauth') {
        const n = (this.infoHold?.n ?? 0) + 1;
        this.infoHold = {
          n,
          until: this.mono() + Math.min(TIMINGS.secondaryMax, TIMINGS.infoEvery * 2 ** n),
        };
      }
      this.logger.debug?.(`PiKVM: info not read (${err?.message})`);
    }
  }

  /** An ATX read done (by the loop, a command or the Test button): online, states, status. */
  async takeRead(atx) {
    const wasOnline = this.online;
    this.atx = { ...atx, at: this.mono() };
    this.online = true;
    this.failures = 0;
    this.lastError = undefined;
    this.pinError = undefined;
    this.tokenLost = false;
    if (!wasOnline) this.logger.info('PiKVM: connected');
    this.considerPending(atx);
    await this.publishStates();
    await this.showStatus();
    await this.publishTransport();
  }

  retryDelay(err) {
    if (err?.kind === 'rate' || err?.kind === 'server') {
      return clamp(
        err.retryAfter ?? TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMax,
      );
    }
    const backoff = Math.min(
      TIMINGS.retryMax,
      TIMINGS.retryMin * 2 ** Math.max(0, this.failures - 1),
    );
    return Math.max(backoff, this.readInterval());
  }

  /** A 429 or a 5xx: every path but the shutdown waits (bounded, kept in /data). */
  pause(err) {
    const delay = this.retryDelay(err);
    this.pauseEnd = Math.max(this.pauseEnd, this.mono() + delay);
    this.memory.pausedUntil = this.now() + delay;
    this.saveSoon().catch(() => {});
    return delay;
  }

  async fail(generation, err, auth) {
    this.online = false;
    this.lastError = err;
    if (err?.kind === 'auth' || err?.kind === 'unauth') {
      if (auth?.token) {
        // The 2FA session ended (expired, logged out on the PiKVM).
        this.dropToken(auth.token);
      } else if (err.kind === 'auth' && auth?.username) {
        // 403 on the main read with the user name and password: refused.
        const c = this.config;
        this.refuseCredentials({
          key: this.accountKey(c),
          address: c.address,
          username: c.username,
          password: c.password,
        });
      }
      if (this.readBlocker()) {
        await this.showStatus();
        await this.publishTransport();
        return;
      }
    }
    if (err?.kind === 'pin' || err?.kind === 'nopin') this.pinError = err;
    this.failures += 1;
    const delay =
      err?.kind === 'rate' || err?.kind === 'server' ? this.pause(err) : this.retryDelay(err);
    if (err instanceof KvmdError) {
      this.logger.warn(`PiKVM: ${err.message} (next read in ${Math.round(delay / 1000)} s)`);
    } else {
      this.logger.error('PiKVM: unexpected failure', err);
    }
    await this.showStatus();
    await this.publishTransport();
    if (this.current(generation)) this.scheduleRead(generation, delay);
  }

  /** A request that failed on a side path (command, follow-up): a 429 or 5xx pauses. */
  sideError(err) {
    if (err?.kind === 'rate' || err?.kind === 'server') this.pause(err);
  }

  // --- Discovery, states, badge, status ------------------------------------------

  deviceIds() {
    return pikvmIds(this.gladys, this.config.address);
  }

  async publishDevice() {
    const c = this.config;
    if (c.error) return;
    const device = buildDevice(this.gladys, {
      address: c.address,
      host: c.host,
      language: c.language,
    });
    const json = JSON.stringify(device);
    if (json === this.publishedDevice) return;
    try {
      await this.gladys.publishDiscoveredDevices([device]);
      this.publishedDevice = json;
    } catch (err) {
      this.logger.warn(`PiKVM: publishing the Discovery failed (${err?.message})`);
    }
  }

  /**
   * The values read, for the features created in Gladys: the LEDs of this
   * very read (unknown when the ATX is disabled or a value is not a boolean),
   * the temperature only when read within 10 min. Never a stale value as new.
   */
  async publishStates() {
    if (this.config.error || !this.atx) return;
    const ids = this.deviceIds();
    const states = [];
    const add = (key, value) => {
      const id = ids.feature(key);
      if (value !== undefined && this.created.has(id)) {
        states.push({ device_feature_external_id: id, state: value });
      }
    };
    if (this.atx.enabled === true) {
      add(FEATURES.POWER, this.atx.power === undefined ? undefined : Number(this.atx.power));
      add(FEATURES.HDD, this.atx.hdd === undefined ? undefined : Number(this.atx.hdd));
    }
    if (this.info && this.mono() - this.info.at <= 2 * TIMINGS.infoEvery) {
      add(FEATURES.TEMPERATURE, this.info.temperature);
    }
    if (states.length === 0) return;
    const now = this.mono();
    this.stateWindow = this.stateWindow.filter((t) => now - t < 60_000);
    if (this.stateWindow.length + states.length > LIMITS.statesPerMinute) return;
    try {
      const result = await this.gladys.publishChangedStates(states, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      for (let i = 0; i < (result?.count ?? states.length); i += 1) this.stateWindow.push(now);
    } catch (err) {
      this.logger.warn(`PiKVM: sending the states failed (${err?.message})`);
    }
  }

  transport() {
    if (!this.online) return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    if (this.memory.pendingStop && this.pendingFor()) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.stopKept };
    }
    if (this.atx?.enabled === false) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.atxDisabled };
    }
    if (this.unconfirmed) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.unconfirmed };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishTransport() {
    if (this.config.error || this.closed) return;
    const id = this.deviceIds().device;
    if (!this.createdDevice(id)) return;
    const badge = this.transport();
    const key = JSON.stringify(badge);
    if (key === this.lastTransport) return;
    this.lastTransport = key;
    await this.gladys
      .publishTransports([{ external_id: id, ...badge }])
      .catch((err) => this.logger.warn(`PiKVM: badge failed (${err?.message})`));
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`PiKVM: setConnectionStatus failed (${err?.message})`));
  }

  /** The status from what is known now (one text, bounded). */
  statusText() {
    const c = this.config;
    const parts = [];
    let connected = false;
    if (c.error) parts.push(T.configError(c.error));
    else if (this.pinError?.kind === 'pin') parts.push(T.pinChanged(this.pinError.fingerprint));
    else if (!this.pin()) parts.push(T.noPin);
    else if (this.blocked) parts.push(T.credentialsRefused);
    else if (!this.auth()) parts.push(this.tokenLost ? T.codeAgain : T.codeNeeded);
    else if (this.paused()) parts.push(T.paused(Math.ceil(this.pauseLeft() / 60_000)));
    else if (this.online) {
      connected = true;
      parts.push(T.connected(this.atx, c.pollInterval));
    } else if (this.lastError) parts.push(T.failure(this.lastError));
    else parts.push(T.connecting);
    if (this.memory.pendingStop && this.pendingFor()) parts.push(T.stopKept);
    if (this.note && this.mono() - this.note.at < 10 * 60_000) parts.push(this.note.text);
    if (this.memoryState === 'unreadable') parts.push(T.dataUnreadable);
    return { connected, message: T.join(parts) };
  }

  async showStatus() {
    if (this.closed) return;
    const { connected, message } = this.statusText();
    await this.setStatus(connected, message);
  }

  /** A promise not awaited: its failure is logged. */
  background(promise) {
    promise?.catch?.((err) => this.logger.warn(`PiKVM: ${err?.message}`));
  }

  // --- Devices created by the user -------------------------------------------------

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  createdDevice(id) {
    return (this.gladys.devices ?? []).some((d) => d?.external_id === id);
  }

  /** A device created (or updated): the values of the last read if it is recent, never older. */
  async deviceCreated(device) {
    this.refreshCreated();
    for (const f of device?.features ?? []) this.created.add(f.external_id);
    this.lastTransport = undefined;
    if (this.online && this.atx && this.mono() - this.atx.at <= this.readInterval()) {
      await this.publishStates();
    }
    await this.publishTransport();
  }

  async deviceDeleted() {
    this.refreshCreated();
    this.lastTransport = undefined;
  }

  /** The Scan button: the device again; never a read sooner than the interval after the last one. */
  async scan() {
    this.publishedDevice = undefined;
    await this.publishDevice();
    const generation = this.generation;
    if (this.reading || this.mono() - this.lastReadMono < this.readInterval()) return;
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    await this.tick(generation);
  }

  // --- Commands --------------------------------------------------------------------

  refusal(code, ...args) {
    const text = T.denied[code];
    return new Refusal(
      code,
      word(typeof text === 'function' ? text(...args) : text, this.config.language),
    );
  }

  /** The result of a command, kept in the status for 10 min (setValue's answer reaches no one). */
  noteResult(text) {
    this.note = { text, at: this.mono() };
    this.background(this.showStatus());
  }

  async setValue(_device, feature, value) {
    // The deadline counts from the arrival of the command, before any wait.
    const received = this.mono();
    const key = featureOf(this.gladys, this.config.address, feature?.external_id);
    if (!key) throw this.refusal('unknown');
    const button = BUTTONS[key];
    if (!button) throw this.refusal('readOnly');
    // Strictly the value of a button: never a 0, a true or an empty text.
    if (value !== PRESSED && value !== String(PRESSED)) throw this.refusal('badValue');
    if (key === FEATURES.SHUTDOWN) return this.protect(received);
    return this.guarded(key, button, received);
  }

  /** Sets the stop guard (power on and reset refused for 60 s), kept in /data. */
  setStopGuard() {
    this.stopGuardEnd = Math.max(this.stopGuardEnd, this.mono() + TIMINGS.stopGuard);
    this.memory.stopGuard = { address: this.config.address, until: this.now() + TIMINGS.stopGuard };
    this.saveSoon().catch(() => {});
  }

  stopGuardLeft() {
    return Math.max(0, this.stopGuardEnd - this.mono());
  }

  /**
   * Shut down: a short press of the power button (kvmd `off`, nothing when the
   * machine is already off). Never held back by an option, a pause, a read or
   * a command in flight. It cancels the guarded commands not yet sent.
   */
  async protect(received) {
    const deadline = received + TIMINGS.commandBudget;
    this.epoch += 1;
    this.setStopGuard();
    const c = this.config;
    if (c.error) throw this.refusal('notConfigured');
    const pin = this.pin();
    if (!pin) throw this.refusal('noPin');
    if (this.blocked) throw this.refusal('credentialsRefused');
    if (!this.auth()) throw this.refusal('codeNeeded');
    const client = this.newClient(this.stopAbort.signal, c, pin);
    const beforeSend = () => {
      this.counter += 1;
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        await client.power('off', {
          timeout: Math.max(500, Math.min(TIMINGS.readTimeout, deadline - this.mono())),
          beforeSend,
        });
        this.dropPending('taken');
        this.unconfirmed = false;
        this.noteResult(T.result.shutdownSent);
        this.scheduleFollowUps(TIMINGS.confirmOff, false);
        return undefined;
      } catch (err) {
        this.sideError(err);
        if (!notTaken(err)) {
          if (err?.sent && !err.answered) {
            // Left without an answer: maybe taken. Never sent again (a second
            // press could be taken too): reads follow.
            this.unconfirmed = true;
            this.noteResult(T.result.unconfirmed);
            this.scheduleFollowUps(TIMINGS.confirmOff, false);
            throw this.refusal('unconfirmed');
          }
          if (err?.kind === 'pin') this.pinError = err;
          if (err?.kind === 'auth' || err?.kind === 'unauth') this.dropToken(this.auth()?.token);
          this.noteResult(T.result.nothingSent(err));
          throw this.refusal('nothingSent', err);
        }
        const wait = TIMINGS.stopRetries[attempt];
        if (wait === undefined || this.mono() + wait + 300 > deadline || this.closed) {
          this.keepPending();
          throw this.refusal('stopKept', err);
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, wait));
      }
    }
  }

  /** Every check of a guarded command (again right before its first byte). */
  checkGuarded(key, button, epoch) {
    const c = this.config;
    if (c.error) throw this.refusal('notConfigured');
    if (!c[button.option]) throw this.refusal(`${key}Off`);
    if (!this.pin()) throw this.refusal('noPin');
    if (this.blocked) throw this.refusal('credentialsRefused');
    if (!this.auth()) throw this.refusal('codeNeeded');
    if (this.paused()) throw this.refusal('paused', Math.ceil(this.pauseLeft() / 1000));
    if (this.epoch !== epoch) throw this.refusal('stopArrived');
    if (!button.stop && this.stopGuardLeft() > 0) {
      throw this.refusal('stopGuard', Math.ceil(this.stopGuardLeft() / 1000));
    }
  }

  /**
   * Power on, Force power off, Reset: off by default; decided on a read of the
   * ATX made after the click; one at a time, one per 30 s; sent within 3.5 s
   * of the click or not at all.
   */
  async guarded(key, button, received) {
    const deadline = received + TIMINGS.commandBudget;
    const epoch = this.epoch;
    this.checkGuarded(key, button, epoch);
    if (this.commandBusy) throw this.refusal('busy');
    const since = this.mono() - this.lastCommandMono;
    if (since < TIMINGS.commandSpacing) {
      throw this.refusal('spacing', Math.ceil((TIMINGS.commandSpacing - since) / 1000));
    }
    this.commandBusy = true;
    try {
      const client = this.sessionClient();
      let atx;
      try {
        atx = await client.atx({
          timeout: Math.max(200, deadline - TIMINGS.sendReserve - this.mono()),
        });
      } catch (err) {
        this.sideError(err);
        throw this.refusal('readFailed', err);
      }
      if (atx.enabled !== true) throw this.refusal('atxDisabled');
      if (atx.busy !== false) throw this.refusal('atxBusy');
      if (atx.power === undefined) throw this.refusal('stateUnknown');
      if (key === FEATURES.POWER_ON && atx.power) {
        this.noteResult(T.result.alreadyOn);
        return undefined;
      }
      if (key === FEATURES.FORCE_OFF && !atx.power) {
        this.noteResult(T.result.alreadyOff);
        return undefined;
      }
      if (key === FEATURES.RESET && !atx.power) throw this.refusal('resetMachineOff');
      // Nothing changed during the read (option, stop arrived, pause, guard).
      this.checkGuarded(key, button, epoch);
      if (button.stop) {
        // A forced power off is a stop too: what waits is cancelled.
        this.epoch += 1;
      }
      const ownEpoch = this.epoch;
      const beforeSend = () => {
        this.checkGuarded(key, button, ownEpoch);
        if (this.mono() > deadline - 100) throw this.refusal('tooLate');
        this.counter += 1;
        this.lastCommandMono = this.mono();
        if (button.stop) this.setStopGuard();
      };
      try {
        await client.power(button.action, {
          timeout: Math.max(100, deadline - this.mono()),
          beforeSend,
        });
      } catch (err) {
        if (err instanceof Refusal) throw err;
        this.sideError(err);
        if (err?.sent && !err.answered) {
          this.unconfirmed = true;
          this.noteResult(T.result.unconfirmed);
          this.scheduleFollowUps(this.confirmDelays(key), this.wantedPower(key));
          throw this.refusal('unconfirmed');
        }
        this.noteResult(T.result.nothingSent(err));
        throw this.refusal('nothingSent', err);
      }
      // A newer command left: a kept shutdown is not sent again over it.
      if (!button.stop) this.dropPending('newer');
      this.unconfirmed = false;
      this.noteResult(T.result.sent(key));
      this.scheduleFollowUps(this.confirmDelays(key), this.wantedPower(key));
      return undefined;
    } finally {
      this.commandBusy = false;
    }
  }

  /** The power LED a command asks for (undefined: Reset, nothing to confirm on the LED). */
  wantedPower(key) {
    if (key === FEATURES.POWER_ON) return true;
    if (key === FEATURES.FORCE_OFF) return false;
    return undefined;
  }

  confirmDelays(key) {
    if (key === FEATURES.POWER_ON) return TIMINGS.confirmOn;
    if (key === FEATURES.FORCE_OFF) return TIMINGS.confirmForceOff;
    return [5000];
  }

  /**
   * Reads after a command (they do not count as the reads of the interval):
   * the LEDs published; `wantOn` true/false: the state the command asked for,
   * which clears "sent, unconfirmed" once read; undefined: nothing to confirm.
   */
  scheduleFollowUps(delays, wantOn) {
    for (const timer of this.followUps) this.timers.clearTimeout(timer);
    this.followUps.clear();
    const generation = this.generation;
    const epoch = this.epoch;
    for (const delay of delays) {
      const timer = this.timers.setTimeout(async () => {
        this.followUps.delete(timer);
        if (!this.current(generation) || this.readBlocker() || this.paused()) return;
        // A read that answers an older command never confirms a newer one.
        if (wantOn && this.epoch !== epoch) return;
        try {
          const atx = await this.sessionClient().atx({ timeout: TIMINGS.readTimeout });
          if (!this.current(generation)) return;
          if (atx.enabled === true && atx.power === wantOn) {
            this.unconfirmed = false;
            for (const t of this.followUps) this.timers.clearTimeout(t);
            this.followUps.clear();
            this.noteResult(wantOn ? T.result.confirmedOn : T.result.confirmedOff);
          }
          await this.takeRead(atx);
        } catch (err) {
          this.sideError(err);
        }
      }, delay);
      this.followUps.add(timer);
    }
  }

  // --- Kept shutdown ----------------------------------------------------------------

  /** The kept shutdown belongs to the PiKVM of the configuration. */
  pendingFor() {
    return this.memory.pendingStop?.address === this.config.address;
  }

  keepPending() {
    const existing = this.pendingFor() ? this.memory.pendingStop : null;
    this.memory.pendingStop = {
      address: this.config.address,
      action: 'off',
      at: existing?.at ?? this.now(),
      sends: existing?.sends ?? 0,
    };
    if (!existing) this.pendingDeadline = this.mono() + TIMINGS.stopKeep;
    this.saveSoon().catch(() => {});
    this.logger.warn('PiKVM: shutdown not taken by the PiKVM, kept and sent again by the reads');
    this.background(this.showStatus());
    this.background(this.publishTransport());
    this.armStopWork(TIMINGS.stopRetries.at(-1));
  }

  dropPending(why) {
    if (!this.memory.pendingStop) return;
    this.memory.pendingStop = null;
    this.timers.clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    this.saveSoon().catch(() => {});
    if (why === 'expired' || why === 'given-up') {
      this.noteResult(T.result.stopGivenUp);
      this.logger.warn('PiKVM: the kept shutdown was given up');
    }
    this.background(this.showStatus());
    this.background(this.publishTransport());
  }

  /** A read (any) of the machine off ends the kept shutdown: done, or off anyway. */
  considerPending(atx) {
    if (this.pendingFor() && atx.enabled === true && atx.power === false) {
      this.dropPending('applied');
      this.noteResult(T.result.confirmedOff);
    }
  }

  /** The work on a kept shutdown: every 10 s, its own reads (bounded: 2 min, 3 sends). */
  armStopWork(ms) {
    if (this.closed || !this.pendingFor()) return;
    this.timers.clearTimeout(this.stopTimer);
    this.stopTimer = this.timers.setTimeout(() => {
      this.stopTimer = undefined;
      this.workStop().catch((err) => this.logger.warn(`PiKVM: kept shutdown: ${err?.message}`));
    }, ms);
  }

  async workStop() {
    if (this.closed || this.stopWorking || !this.pendingFor()) return;
    const pending = this.memory.pendingStop;
    if (this.mono() >= this.pendingDeadline) {
      this.dropPending('expired');
      return;
    }
    if (pending.sends >= LIMITS.stopSends) {
      this.dropPending('given-up');
      return;
    }
    const c = this.config;
    const pin = this.pin();
    if (c.error || !pin || this.blocked || !this.auth()) {
      this.armStopWork(10_000);
      return;
    }
    this.stopWorking = true;
    try {
      const client = this.newClient(this.stopAbort.signal, c, pin);
      // A read started now (after the click): it decides, never an older one.
      const atx = await client.atx({ timeout: TIMINGS.readTimeout });
      if (this.memory.pendingStop !== pending) return;
      if (atx.enabled === true && atx.power === false) {
        this.dropPending('applied');
        this.noteResult(T.result.confirmedOff);
        return;
      }
      if (atx.enabled !== true || atx.busy !== false || atx.power !== true) return;
      try {
        await client.power('off', { timeout: TIMINGS.readTimeout });
        this.dropPending('taken');
        this.noteResult(T.result.shutdownSent);
        this.scheduleFollowUps(TIMINGS.confirmOff, false);
      } catch (err) {
        this.sideError(err);
        if (err?.sent && this.memory.pendingStop === pending) {
          pending.sends += 1;
          this.saveSoon().catch(() => {});
        }
        if (err?.sent && !err.answered) {
          // Maybe taken: never sent again.
          this.dropPending('unconfirmed');
          this.unconfirmed = true;
          this.noteResult(T.result.unconfirmed);
          this.scheduleFollowUps(TIMINGS.confirmOff, false);
        } else if (!notTaken(err)) {
          this.dropPending('given-up');
        }
      }
    } catch (err) {
      this.sideError(err);
    } finally {
      this.stopWorking = false;
      this.armStopWork(10_000);
    }
  }

  // --- Buttons of the configuration screen ------------------------------------------

  async testConnection() {
    await this.loadMemory();
    const now = this.mono();
    if (this.lastTest && now - this.lastTest.at < TIMINGS.testSpacing) return this.lastTest.result;
    const result = await this.runTest();
    this.lastTest = { at: this.mono(), result };
    return result;
  }

  async runTest() {
    const c = this.config;
    if (c.error) return T.configError(c.error);
    const generation = this.generation;
    const pin = this.pin();
    try {
      if (!pin) {
        const fp = await this.readFingerprint({ host: c.host, port: c.port });
        return T.test.noPin(fp);
      }
      if (this.paused()) {
        const { message } = this.statusText();
        return T.test.paused(message, Math.ceil(this.pauseLeft() / 1000));
      }
      const auth = this.auth();
      if (!auth) return this.tokenLost ? T.codeAgain : T.codeNeeded;
      // Never a read sooner than the interval after the last one; while the
      // account is refused (no read runs then), Test may try at once (once
      // per 10 s, the Test spacing).
      const wait = this.lastReadMono + this.readInterval() - this.mono();
      if (wait > 0 && !this.blocked) {
        const { message } = this.statusText();
        return T.test.waiting(message, Math.ceil(wait / 1000));
      }
      this.noteAttempt();
      const client = createKvmd({
        host: c.host,
        port: c.port,
        pin,
        auth: () => auth,
        secrets: () => [c.password, auth.token],
        request: this.request,
      });
      let atx;
      try {
        atx = await client.atx({ timeout: TIMINGS.readTimeout });
      } catch (err) {
        if (err?.kind === 'auth' && auth.username) {
          throw new KvmdError('credentials', 'user name or password refused', {
            status: err.status,
          });
        }
        throw err;
      }
      let info;
      try {
        info = await client.info({ timeout: TIMINGS.readTimeout });
      } catch {
        info = undefined;
      }
      const ok = T.test.ok(atx, info);
      if (!this.current(generation)) return ok;
      if (info) {
        this.info = { ...info, at: this.mono() };
        this.infoDue = this.mono() + TIMINGS.infoEvery;
      }
      if (this.blocked) {
        this.clearRefusal();
        this.logger.info('PiKVM: user accepted again (Test button)');
        this.background(this.start(this.raw));
      } else {
        this.background(this.takeRead(atx));
      }
      return ok;
    } catch (err) {
      this.sideError(err);
      if (err?.kind === 'credentials' && this.current(generation)) {
        this.refuseCredentials({
          key: this.accountKey(c),
          address: c.address,
          username: c.username,
          password: c.password,
        });
        return T.credentialsRefused;
      }
      if ((err?.kind === 'auth' || err?.kind === 'unauth') && this.current(generation)) {
        this.dropToken(this.token);
        return T.codeAgain;
      }
      if (err?.kind === 'pin' && this.current(generation)) this.pinError = err;
      if (!(err instanceof KvmdError)) this.logger.error('PiKVM: test failed', err);
      return T.failure(err);
    }
  }

  /**
   * "Log in with a 2FA code": the password followed by the code typed (6
   * digits) opens a session; its token stays in memory only. The code is
   * never kept nor logged.
   */
  async loginWithCode(fields = {}) {
    await this.loadMemory();
    const c = this.config;
    if (c.error) return T.configError(c.error);
    if (!c.twoFactor) return T.login.notEnabled;
    const code = String(fields?.code ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return T.login.badCode;
    const pin = this.pin();
    if (!pin) return T.noPin;
    const account = this.accountKey();
    try {
      const token = await this.login({
        host: c.host,
        port: c.port,
        pin,
        username: c.username,
        passwd: `${c.password}${code}`,
        request: this.request,
      });
      if (account !== this.accountKey() || this.closed) return T.login.changed;
      this.token = token;
      this.tokenFor = account;
      this.tokenLost = false;
      this.logger.info('PiKVM: 2FA session opened');
      this.lastReadMono = -Infinity;
      this.background(this.start(this.raw));
      return T.login.ok;
    } catch (err) {
      if (err?.kind === 'auth') return T.login.refused;
      if (err?.kind === 'pin') this.pinError = err;
      this.sideError(err);
      return T.failure(err);
    }
  }

  /**
   * "Trust the certificate", in two clicks: the first shows the fingerprint
   * seen (nothing else is sent), the second (within 2 min, the same one seen
   * again) pins it. The first pin and a changed certificate alike.
   */
  async trustCertificate() {
    await this.loadMemory();
    const c = this.config;
    const target = parseAddress(this.raw.host);
    if (target.error) return T.configError(target.error);
    let fp;
    try {
      fp = await this.readFingerprint({ host: target.host, port: target.port });
    } catch (err) {
      return T.failure(err);
    }
    const current = this.pin(target.key);
    if (fp === current) return T.trust.same(fp);
    if (c.fingerprint && target.key === c.address) return T.trust.typed(fp);
    const pending = this.pendingTrust;
    if (
      !pending ||
      pending.address !== target.key ||
      pending.fp !== fp ||
      this.mono() - pending.at > TIMINGS.trustWindow
    ) {
      this.pendingTrust = { address: target.key, fp, at: this.mono() };
      return T.trust.confirm(fp, current === undefined, target.key);
    }
    this.pendingTrust = undefined;
    if (this.memoryState !== 'loaded') return T.pinNotKept(fp);
    const before = this.memory.pins[target.key];
    this.memory.pins[target.key] = fp;
    try {
      await this.saveNow();
    } catch {
      if (before === undefined) delete this.memory.pins[target.key];
      else this.memory.pins[target.key] = before;
      return T.pinNotKept(fp);
    }
    this.logger.info('PiKVM: certificate trusted (two clicks)');
    // A new certificate may be another PiKVM: a 2FA session is opened again.
    this.token = '';
    this.tokenFor = '';
    this.background(this.start(this.raw));
    return T.trust.done(fp);
  }
}
