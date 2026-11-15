// Mutation checks of the guards: each mutant breaks one guard in a copy of the
// repository and must make a test fail (never hang: the whole process group is
// killed at the deadline). One at a time. Usage, from the repository:
//   memcap node scripts/mutants.mjs "$(mktemp -d)" [name filter]
// The directory given is the agent's own; it is emptied of each copy after use.
// node_modules is copied (never linked) into each copy.

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const C = 'test/commands.test.js';
const A = 'test/app.test.js';
const K = 'test/kvmd.test.js';
const G = 'test/config.test.js';
const R = 'test/realclock.test.js';
const ALL = [C, A, K, G, R, 'test/manifest.test.js', 'test/encoding.test.js'];
const APP = 'src/app.js';

/** [name, file, from (found exactly once), to, test files]. */
export const MUTANTS = [
  ['option of a guarded button', APP, 'if (!c[button.option]) throw', 'if (false) throw', [C]],
  ['stop arrived', APP, 'if (this.epoch !== epoch) throw', 'if (false) throw', [C]],
  ['stop guard', APP, 'if (!button.stop && this.stopGuardLeft() > 0) {', 'if (false) {', [C]],
  [
    'pause holds guarded',
    APP,
    "if (this.paused()) throw this.refusal('paused'",
    "if (false) throw this.refusal('paused'",
    [C],
  ],
  ['30 s spacing', APP, 'if (since < TIMINGS.commandSpacing) {', 'if (false) {', [C]],
  ['ATX busy', APP, 'if (atx.busy !== false) throw', 'if (false) throw', [C]],
  ['ATX disabled', APP, 'if (atx.enabled !== true) throw', 'if (false) throw', [C]],
  ['already on', APP, 'if (key === FEATURES.POWER_ON && atx.power) {', 'if (false) {', [C]],
  ['reset of a machine off', APP, 'if (key === FEATURES.RESET && !atx.power)', 'if (false)', [C]],
  ['checked before the first byte', APP, 'this.checkGuarded(key, button, ownEpoch);', '', [C]],
  ['too late before the first byte', APP, 'if (this.mono() > deadline - 100)', 'if (false)', [C]],
  [
    'shutdown cancels what waits',
    APP,
    '    this.epoch += 1;\n    this.setStopGuard();',
    '    this.setStopGuard();',
    [C],
  ],
  [
    'shutdown retried in budget',
    APP,
    'const wait = TIMINGS.stopRetries[attempt];',
    'const wait = undefined;',
    [C],
  ],
  ['unanswered never resent', APP, '&& !err.sent)', ')', [C]],
  [
    'kept shutdown only on a machine on',
    APP,
    'if (atx.enabled !== true || atx.busy !== false || atx.power !== true) return;',
    'if (atx.enabled !== true || atx.busy !== false) return;',
    [C],
  ],
  ['3 sends at most', APP, 'if (pending.sends >= LIMITS.stopSends) {', 'if (false) {', [C]],
  ['2 min at most', APP, 'if (this.mono() >= this.pendingDeadline) {', 'if (false) {', [C]],
  [
    'refusal kept at start',
    APP,
    'this.blocked = this.refusalKept();',
    'this.blocked = false;',
    [A],
  ],
  [
    'only a 403 refuses',
    APP,
    "} else if (err.kind === 'auth' && auth?.username) {",
    '} else if (auth?.username) {',
    [A],
  ],
  [
    'info 403 secondary',
    APP,
    "if (['pin', 'nopin', 'aborted'].includes(err?.kind)) throw err;",
    "if (['pin', 'nopin', 'aborted', 'auth'].includes(err?.kind)) throw err;",
    [A],
  ],
  [
    'never sooner than the interval',
    APP,
    'const early = this.lastReadMono + this.readInterval() - this.mono();',
    'const early = 0;',
    [A],
  ],
  ['last read in /data', APP, 'this.memory.lastReadAt = this.now();', '', [A]],
  ['LEDs only with ATX enabled', APP, 'if (this.atx.enabled === true) {', 'if (true) {', [A]],
  ['stop guard in /data', APP, 'this.memory.stopGuard = {', 'this.memory.stopGuardX = {', [C]],
  ['trust window', APP, 'this.mono() - pending.at > TIMINGS.trustWindow', 'false', [A]],
  ['a press only', APP, 'if (value !== PRESSED && value !== String(PRESSED))', 'if (false)', [C]],
  ['pin checked', 'src/kvmd.js', 'if (seen !== pin) {', 'if (false) {', [K, A]],
  [
    'answer size streamed',
    'src/kvmd.js',
    '        if (size > maxBytes) {',
    '        if (false) {',
    [K],
  ],
  [
    'envelope read',
    'src/kvmd.js',
    'if (envelope?.ok !== true || !result) {',
    'if (!result) {',
    [A, K],
  ],
  [
    'strict booleans',
    'src/kvmd.js',
    "const bool = (v) => (typeof v === 'boolean' ? v : undefined);",
    'const bool = (v) => (v === undefined ? undefined : Boolean(v));',
    [K, A],
  ],
  [
    'option strictly true',
    'src/config.js',
    "const on = (raw) => raw === true || raw === 'true';",
    'const on = (raw) => Boolean(raw);',
    [G],
  ],
  ['future pending dropped', 'src/store.js', '    p.at <= now &&', '    true &&', [G, C]],
];

/** Equivalent mutants, with the reason (no test can tell them apart). */
export const EQUIVALENT = [
  [
    'stop arrived during the read of a power on / reset',
    APP,
    '      this.checkGuarded(key, button, epoch);\n      if (button.stop) {',
    'a shutdown also sets the 60 s stop guard, which beforeSend checks for power on and reset; a forced power off after a shutdown is harmless',
  ],
  [
    'declared content-length',
    'src/kvmd.js',
    'if (Number.isFinite(declared) && declared > maxBytes) {',
    'the streaming count cuts the same answer a few kilobytes later',
  ],
];

function run(dir, tests, ms) {
  return new Promise((done) => {
    const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-timeout=60000', ...tests], {
      cwd: dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
      done({ code: 'TIMEOUT', out });
    }, ms);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

async function main() {
  const base = process.argv[2];
  const filter = process.argv[3];
  if (!base) throw new Error('give your own temporary directory (mktemp -d)');
  const modules = join(base, 'node_modules');
  cpSync(join(REPO, 'node_modules'), modules, { recursive: true });
  // The unmodified suite first: a red baseline makes every mutant look killed.
  {
    const dir = mkdtempSync(join(base, 'baseline-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const { code } = await run(dir, ALL, 300_000);
      if (code !== 0) {
        console.log('baseline FAILED');
        rmSync(modules, { recursive: true, force: true });
        process.exitCode = 1;
        return;
      }
      console.log('baseline ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  let survived = 0;
  for (const [name, file, from, to, tests] of MUTANTS) {
    if (filter && !name.includes(filter)) continue;
    const dir = mkdtempSync(join(base, 'm-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const path = join(dir, file);
      const text = readFileSync(path, 'utf8');
      const n = text.split(from).length - 1;
      if (n !== 1) {
        console.log(`??       ${name}: ${n} matches`);
        survived += 1;
        continue;
      }
      writeFileSync(path, text.replace(from, to));
      const { code } = await run(dir, tests, 150_000);
      const killed = code !== 0 && code !== 'TIMEOUT';
      if (!killed) survived += 1;
      console.log(`${killed ? 'killed  ' : code === 'TIMEOUT' ? 'HANGS   ' : 'SURVIVED'} ${name}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  rmSync(modules, { recursive: true, force: true });
  for (const [name, , , why] of EQUIVALENT) console.log(`equiv.   ${name}: ${why}`);
  process.exitCode = survived > 0 ? 1 : 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
