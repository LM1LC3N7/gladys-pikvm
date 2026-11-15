// -----------------------------------------------------------------------------
// Constants of the PiKVM integration: API paths, timings, limits, keys.
// The API is the one documented by PiKVM (https://docs.pikvm.org/api/); kvmd
// itself (GPL-3.0) runs on the user's PiKVM and nothing of it is copied here.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 443;

/** The device type in the external ids: `ext:<selector>:pikvm:<address id>`. */
export const DEVICE_TYPE = 'pikvm';

export const PATHS = {
  atx: '/api/atx',
  info: '/api/info?fields=hw',
  login: '/api/auth/login',
  /** POST, `action` = on | off | off_hard | reset_hard; `wait=0`: answered once started. */
  power: (action) => `/api/atx/power?action=${action}&wait=0`,
};

/** Refresh interval (seconds) of the ATX state. */
export const POLL_INTERVAL = { min: 10, max: 600, default: 30 };

export const LANGUAGES = ['fr', 'en'];

/** The only value a `button`/`push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

export const FEATURES = {
  POWER: 'power',
  HDD: 'hdd',
  TEMPERATURE: 'pikvm_temperature',
  POWER_ON: 'power_on',
  SHUTDOWN: 'shutdown',
  FORCE_OFF: 'force_off',
  RESET: 'reset',
};

/**
 * The buttons: the kvmd action each one sends and the option that allows it.
 * `shutdown` (a short press of the power button, kvmd `off`: nothing when the
 * machine is already off) is protective: never held back by an option.
 */
export const BUTTONS = {
  [FEATURES.POWER_ON]: { action: 'on', option: 'allowPowerOn', stop: false },
  [FEATURES.SHUTDOWN]: { action: 'off', option: null, stop: true },
  [FEATURES.FORCE_OFF]: { action: 'off_hard', option: 'allowForceOff', stop: true },
  [FEATURES.RESET]: { action: 'reset_hard', option: 'allowReset', stop: false },
};

export const ACTIONS = {
  TEST: 'test_connection',
  TRUST: 'trust_certificate',
  LOGIN: 'login_2fa',
};

export const TIMINGS = {
  /** TLS handshake. */
  connectTimeout: 3000,
  /** A whole read. */
  readTimeout: 8000,
  /** No byte for this long during an answer: the read is cut (a frozen read). */
  idleTimeout: 2000,
  /** A command is answered to Gladys within this (Gladys gives up at 5 s). */
  commandBudget: 3500,
  /** Time kept for the send itself after the read of a guarded command. */
  sendReserve: 700,
  /** Retries of a shutdown not taken by the PiKVM (busy, 5xx, not sent), within the budget. */
  stopRetries: [250, 500, 1000],
  /** A shutdown never taken: kept (in /data) and sent again by the reads, this long after the click. */
  stopKeep: 120_000,
  /** After a shutdown or a forced power off: power on and reset are refused this long. */
  stopGuard: 60_000,
  /** At most one guarded command (power on, forced off, reset) per this delay. */
  commandSpacing: 30_000,
  /** Reads that confirm a command, after its answer. */
  confirmOn: [5000, 20_000],
  confirmOff: [5000, 20_000, 60_000, 120_000],
  confirmForceOff: [10_000, 20_000],
  /** The PiKVM's own data (temperature): read at most this often. */
  infoEvery: 300_000,
  /** A secondary read refused (401/403): spaced, doubling up to this. */
  secondaryMax: 3_600_000,
  /** 429 / 5xx: pause bounds. */
  rateLimitMin: 60_000,
  rateLimitMax: 6 * 3_600_000,
  /** Other failures: back-off bounds. */
  retryMin: 30_000,
  retryMax: 15 * 60_000,
  /** /data: one read at a time, each bounded; unreadable: read again every 10 s. */
  dataWait: 2000,
  dataRetry: 10_000,
  /** The time of the last read written to /data at most this often. */
  attemptWriteEvery: 60_000,
  /** getConfig() failing: tried again after these delays, then every minute. */
  configRetry: [5000, 15_000, 30_000, 60_000],
  /** Test button: its last result given again within this delay. */
  testSpacing: 10_000,
  /** The second click of "Trust the certificate" must come within this. */
  trustWindow: 120_000,
  /** An unchanged state sent again this often (it stays recently dated in Gladys). */
  stateHeartbeat: 30 * 60_000,
};

export const LIMITS = {
  /** An answer of the PiKVM (JSON): a larger one is cut before it is read whole. */
  responseBytes: 64 * 1024,
  /** States sent to Gladys per minute (the host API takes 300). */
  statesPerMinute: 120,
  /** Sends of a kept shutdown, all paths together. */
  stopSends: 3,
};
