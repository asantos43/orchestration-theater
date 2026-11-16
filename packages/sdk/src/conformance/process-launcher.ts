// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROCESS_LAUNCHER_PORT_VERSION,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessLauncher,
} from '@otheater/core';
import { afterEach, describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

export interface ProcessLauncherHarness extends Disposable {
  readonly launcher: ProcessLauncher;
}

/** Upper bound of every test of the suite: a hung child must fail the test, not the run. */
const TEST_TIMEOUT_MS = 30_000;
/** How long the suite waits for the OS to forget a process (zombies are reaped asynchronously). */
const GONE_WAIT_MS = 3000;
const NODE = process.execPath;
/**
 * Variables the OS sets in every child even with an empty env. macOS adds
 * `__CF_USER_TEXT_ENCODING` (secondary source, not checked here; seen as one extra key on the
 * macOS runner of run 43906063921).
 */
const OS_INJECTED_ENV: ReadonlySet<string> =
  process.platform === 'darwin' ? new Set(['__CF_USER_TEXT_ENCODING']) : new Set();
/** Words a shell or a unit-file parser would change: spaces, expansions, quotes, empty, non-ASCII. */
const ARGS_SAMPLE = ['a b', '$HOME', '${HOME}', '$$', '%h', '*;|', '"q"', "it's", '', 'é\\n'];

/**
 * Registers the `ProcessLauncher` conformance tests (port version
 * {@link PROCESS_LAUNCHER_PORT_VERSION}) in the calling Vitest file. Call it at the top level of a
 * test file, once per adapter. Every child is a `node -e` script run with `process.execPath`, so
 * the suite needs nothing but Node on the machine.
 *
 * Tests that only make sense with signals and process groups (`treeKill !== 'job-object'`) look
 * at `capabilities()` and skip themselves otherwise: a Windows launcher runs the rest and adds
 * its own tests for the Job Object.
 *
 * Whatever a test starts is ended in `afterEach`, even when the test fails.
 */
export function describeProcessLauncherConformance(
  name: string,
  factory: AdapterFactory<ProcessLauncherHarness>,
): void {
  describe(
    `ProcessLauncher conformance: ${name} (port ${PROCESS_LAUNCHER_PORT_VERSION})`,
    { timeout: TEST_TIMEOUT_MS },
    () => {
      const harness = useHarness(factory);
      const scratch = new Scratch();
      // Declared after `useHarness`, so it runs first (hooks run in reverse order): the processes
      // are ended while the launcher still exists.
      afterEach(async () => {
        await scratch.cleanUp();
      });

      const start = (script: string, extra: Partial<LaunchOptions> = {}) =>
        scratch.launch(harness().launcher, script, extra);
      /** True when signals and process groups exist (everything but a Job Object launcher). */
      const usesSignals = (): boolean =>
        harness().launcher.capabilities().treeKill !== 'job-object';

      it('declares the port it implements and a coherent capabilities() report', () => {
        const { launcher } = harness();
        expect(launcher.implements.port).toBe('ProcessLauncher');
        expect(launcher.id.length).toBeGreaterThan(0);
        const caps = launcher.capabilities();
        expect(['job-object', 'process-group', 'descendants']).toContain(caps.treeKill);
        expect(typeof caps.memoryLimit).toBe('boolean');
        expect(typeof caps.suspendedStart).toBe('boolean');
        expect(launcher.capabilities()).toEqual(caps);
      });

      describe('streams and exit', () => {
        it('echoes stdin to stdout and ends with code 0 once stdin is closed', async () => {
          const proc = await start('process.stdin.pipe(process.stdout)');
          expect(proc.pid).toBeGreaterThan(0);
          const writer = proc.stdin.getWriter();
          const reading = readText(proc.stdout);
          await writer.write(new TextEncoder().encode('hello '));
          await writer.write(new TextEncoder().encode('launcher'));
          await writer.close();
          expect(await reading).toBe('hello launcher');
          expect(await proc.exited).toEqual({ code: 0, signal: null });
        });

        it('moves a large payload through stdin and stdout without losing a byte', async () => {
          const proc = await start('process.stdin.pipe(process.stdout)');
          const chunk = Buffer.alloc(64 * 1024);
          const sent = createHash('sha256');
          const writing = (async () => {
            const writer = proc.stdin.getWriter();
            for (let i = 0; i < 32; i++) {
              chunk.fill(i + 1);
              sent.update(chunk);
              await writer.write(new Uint8Array(chunk));
            }
            await writer.close();
          })();
          const received = createHash('sha256');
          let length = 0;
          for await (const part of proc.stdout) {
            received.update(part);
            length += part.byteLength;
          }
          await writing;
          expect(length).toBe(32 * 64 * 1024);
          expect(received.digest('hex')).toBe(sent.digest('hex'));
          expect((await proc.exited).code).toBe(0);
        });

        it('keeps stdout and stderr apart', async () => {
          const proc = await start(
            'process.stdout.write("to-out");process.stderr.write("to-err");',
          );
          const [out, err] = await Promise.all([readText(proc.stdout), readText(proc.stderr)]);
          expect(out).toBe('to-out');
          expect(err).toBe('to-err');
          expect(await proc.exited).toEqual({ code: 0, signal: null });
        });

        it('reports the exit code', async () => {
          const proc = await start('process.exit(7)');
          expect(await proc.exited).toEqual({ code: 7, signal: null });
        });

        it('reports the signal that ended the process', async ({ skip }) => {
          if (!usesSignals()) skip('signals do not exist on this launcher');
          const proc = await start('process.kill(process.pid, "SIGKILL")');
          expect(await proc.exited).toEqual({ code: null, signal: 'SIGKILL' });
        });

        it('exited resolves even when nobody reads the streams', async () => {
          const proc = await start(
            'process.stdout.write("x".repeat(1000));process.stderr.write("y")',
          );
          expect(await proc.exited).toEqual({ code: 0, signal: null });
        });

        it('a write after the process is gone fails the write, not the run', async () => {
          const proc = await start('process.exit(0)');
          await proc.exited;
          const writer = proc.stdin.getWriter();
          await rejectionOf(
            (async () => {
              // The first write may still be accepted into the pipe buffer; EPIPE follows.
              for (let i = 0; i < 20; i++) {
                await writer.write(new Uint8Array(64 * 1024));
                await new Promise<void>((resolve) => {
                  setTimeout(resolve, 10);
                });
              }
            })(),
          );
        });
      });

      describe('options', () => {
        it('gives the child exactly the env it was given, nothing of the parent', async () => {
          const key = 'OT_CONFORMANCE_PARENT_ONLY';
          process.env[key] = 'leaked';
          try {
            const proc = await start('process.stdout.write(JSON.stringify(process.env))', {
              env: { OT_CONFORMANCE_VISIBLE: 'yes' },
            });
            const seen = JSON.parse(await readText(proc.stdout)) as Record<string, string>;
            expect(seen.OT_CONFORMANCE_VISIBLE).toBe('yes');
            expect(seen[key]).toBeUndefined();
            if (usesSignals()) {
              // Posix adds nothing of its own, except what macOS puts in every process.
              const keys = Object.keys(seen);
              expect(
                keys.filter((k) => !OS_INJECTED_ENV.has(k)),
                `env keys seen by the child: ${keys.join(', ')}`,
              ).toEqual(['OT_CONFORMANCE_VISIBLE']);
            }
            await proc.exited;
          } finally {
            Reflect.deleteProperty(process.env, key);
          }
        });

        it('starts the process in the cwd it was given', async () => {
          const dir = await realpath(await scratch.tempDir());
          const proc = await start('process.stdout.write(process.cwd())', { cwd: dir });
          expect(await realpath(await readText(proc.stdout))).toBe(dir);
          await proc.exited;
        });

        it('passes args as they are, without a shell', async () => {
          const proc = await scratch.launchRaw(harness().launcher, {
            cmd: NODE,
            args: [
              '-e',
              'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
              ...ARGS_SAMPLE,
            ],
          });
          expect(JSON.parse(await readText(proc.stdout))).toEqual(ARGS_SAMPLE);
          await proc.exited;
        });
      });

      describe('launch errors', () => {
        it('rejects invalid options with INVALID_INPUT', async () => {
          const { launcher } = harness();
          const base = { cmd: NODE, args: [], cwd: tmpdir(), env: {} };
          for (const bad of [
            { ...base, cmd: '' },
            { ...base, cwd: 'relative/dir' },
            { ...base, env: { 'A=B': 'x' } },
            { ...base, args: ['a\0b'] },
          ]) {
            expect(await rejectionOf(launcher.launch(bad))).toMatchObject({
              code: 'INVALID_INPUT',
            });
          }
        });

        it('rejects with ADAPTER_UNAVAILABLE when the executable does not exist', async () => {
          const { launcher } = harness();
          const error = await rejectionOf(
            launcher.launch({
              cmd: join(await scratch.tempDir(), 'no-such-executable'),
              args: [],
              cwd: tmpdir(),
              env: {},
            }),
          );
          expect(error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
        });

        it('rejects with ADAPTER_UNAVAILABLE when the cwd does not exist', async () => {
          const { launcher } = harness();
          const error = await rejectionOf(
            launcher.launch({
              cmd: NODE,
              args: ['-e', ''],
              cwd: join(await scratch.tempDir(), 'no-such-dir'),
              env: {},
            }),
          );
          expect(error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
        });

        it('refuses memoryLimitBytes, never ignoring it, without the capability', async ({
          skip,
        }) => {
          const { launcher } = harness();
          if (launcher.capabilities().memoryLimit) skip('this launcher can limit memory');
          const error = await rejectionOf(
            launcher.launch({
              cmd: NODE,
              args: ['-e', ''],
              cwd: tmpdir(),
              env: {},
              memoryLimitBytes: 256 * 1024 * 1024,
            }),
          );
          expect(error).toMatchObject({ code: 'INVALID_INPUT' });
        });

        it('accepts memoryLimitBytes with the capability', async ({ skip }) => {
          const { launcher } = harness();
          if (!launcher.capabilities().memoryLimit) skip('this launcher cannot limit memory');
          const proc = await scratch.launchRaw(launcher, {
            cmd: NODE,
            args: ['-e', 'process.stdout.write("limited")'],
            memoryLimitBytes: 1024 ** 3,
          });
          expect(await readText(proc.stdout)).toBe('limited');
          expect((await proc.exited).code).toBe(0);
        });
      });

      describe('killTree', () => {
        it('ends a three-level tree (child, grandchild, great-grandchild) without leftovers', async () => {
          const file = await scratch.pidsFile();
          const proc = await start(treeScript(3), { env: { PIDS_FILE: file } });
          const pids = await scratch.waitForPids(file, 3);

          const began = performance.now();
          const report = await proc.killTree({ graceMs: 10_000 });

          expect(report.remaining).toEqual([]);
          expect(report.found).toBeGreaterThanOrEqual(3);
          // The polite signal was enough: the grace period was not waited out.
          expect(performance.now() - began).toBeLessThan(5000);
          await expectGone(pids);
          await proc.exited;
        });

        it('lets the process answer the polite signal before anything is forced', async ({
          skip,
        }) => {
          if (!usesSignals()) skip('no polite signal on this launcher');
          const marker = join(await scratch.tempDir(), 'goodbye');
          const proc = await start(
            `process.on("SIGTERM",()=>{require("node:fs").writeFileSync(process.env.MARKER,"bye");process.exit(0)});` +
              `process.stdout.write("ready");setInterval(()=>{},1000)`,
            { env: { MARKER: marker } },
          );
          await readUntil(proc.stdout, 'ready');

          const report = await proc.killTree({ graceMs: 10_000 });

          expect(report).toMatchObject({ forced: false, remaining: [] });
          expect(await readFile(marker, 'utf8')).toBe('bye');
          expect(await proc.exited).toEqual({ code: 0, signal: null });
        });

        it('forces a process that ignores SIGTERM once graceMs has passed', async ({ skip }) => {
          if (!usesSignals()) skip('no polite signal on this launcher');
          const proc = await start(
            'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)',
          );
          await readUntil(proc.stdout, 'ready');

          const began = performance.now();
          const report = await proc.killTree({ graceMs: 300 });
          const elapsed = performance.now() - began;

          expect(report).toMatchObject({ forced: true, remaining: [] });
          expect(report.found).toBeGreaterThanOrEqual(1);
          expect(elapsed).toBeGreaterThanOrEqual(250);
          expect(await proc.exited).toEqual({ code: null, signal: 'SIGKILL' });
          await expectGone([proc.pid]);
        });

        it('with graceMs 0 goes straight to the forced kill', async ({ skip }) => {
          if (!usesSignals()) skip('no polite signal on this launcher');
          const proc = await start(
            'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)',
          );
          await readUntil(proc.stdout, 'ready');
          const report = await proc.killTree({ graceMs: 0 });
          expect(report).toMatchObject({ forced: true, remaining: [] });
          await expectGone([proc.pid]);
        });

        it('also ends a grandchild that left the process group (setsid / detached)', async ({
          skip,
        }) => {
          if (harness().launcher.capabilities().treeKill === 'job-object') {
            skip('a Job Object holds even a detached descendant by construction');
          }
          const file = await scratch.pidsFile();
          // child -> grandchild (new session) -> great-grandchild (inherits the new group)
          const proc = await start(treeScript(3, { detachedLevel: 2 }), {
            env: { PIDS_FILE: file },
          });
          const pids = await scratch.waitForPids(file, 3);

          const report = await proc.killTree({ graceMs: 10_000 });

          expect(report.remaining).toEqual([]);
          expect(report.found).toBeGreaterThanOrEqual(3);
          await expectGone(pids);
        });

        it('ends descendants that outlive a root that already exited', async () => {
          const file = await scratch.pidsFile();
          // The root starts one child and leaves at once.
          const proc = await start(
            `const fs=require("node:fs");fs.appendFileSync(process.env.PIDS_FILE,process.pid+"\\n");` +
              `const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(
                `require("node:fs").appendFileSync(process.env.PIDS_FILE,process.pid+"\\n");setInterval(()=>{},1000)`,
              )}],{stdio:"ignore"});c.unref();`,
            { env: { PIDS_FILE: file } },
          );
          const pids = await scratch.waitForPids(file, 2);
          await proc.exited;
          const orphan = pids[1] ?? -1;
          expect(isAlive(orphan)).toBe(true);

          const report = await proc.killTree({ graceMs: 10_000 });

          expect(report.remaining).toEqual([]);
          await expectGone(pids);
        });

        it('is idempotent: repeated and concurrent calls all resolve with an empty remainder', async () => {
          const file = await scratch.pidsFile();
          const proc = await start(treeScript(2), { env: { PIDS_FILE: file } });
          const pids = await scratch.waitForPids(file, 2);

          const [first, second] = await Promise.all([
            proc.killTree({ graceMs: 5000 }),
            proc.killTree({ graceMs: 5000 }),
          ]);
          const third = await proc.killTree({ graceMs: 5000 });

          expect(first.remaining).toEqual([]);
          expect(second.remaining).toEqual([]);
          expect(third).toEqual({ found: 0, forced: false, remaining: [] });
          await expectGone(pids);
        });

        it('resolves after the process ended on its own', async () => {
          const proc = await start('process.exit(0)');
          await proc.exited;
          const report = await proc.killTree();
          expect(report).toEqual({ found: 0, forced: false, remaining: [] });
        });

        it('resolves after the process was already killed by an earlier killTree', async () => {
          const proc = await start('setInterval(()=>{},1000)');
          await proc.killTree({ graceMs: 5000 });
          await proc.exited;
          expect(await proc.killTree({ graceMs: 5000 })).toEqual({
            found: 0,
            forced: false,
            remaining: [],
          });
        });

        it('rejects a negative or non-finite graceMs with INVALID_INPUT', async () => {
          const proc = await start('setInterval(()=>{},1000)');
          for (const graceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(await rejectionOf(proc.killTree({ graceMs }))).toMatchObject({
              code: 'INVALID_INPUT',
            });
          }
          // The process is still ours to end: afterEach does it.
        });
      });
    },
  );
}

/** Options of {@link treeScript}. */
interface TreeScriptOptions {
  /** 1-based level whose process is started `detached` (a new session on posix). */
  readonly detachedLevel?: number;
}

/**
 * A node script that is level 1 of a chain of `levels` processes: each records its pid in the file
 * named by `PIDS_FILE`, starts the next level with stdio detached from the launcher's pipes, and
 * idles. `detachedLevel` makes that level leave the process group.
 */
function treeScript(levels: number, options: TreeScriptOptions = {}, level = 1): string {
  const record = `require("node:fs").appendFileSync(process.env.PIDS_FILE,process.pid+"\\n");`;
  if (level >= levels) return `${record}setInterval(()=>{},1000)`;
  const next = JSON.stringify(treeScript(levels, options, level + 1));
  const detached = options.detachedLevel === level + 1;
  return (
    `${record}require("node:child_process").spawn(process.execPath,["-e",${next}],` +
    `{stdio:"ignore",detached:${String(detached)}});setInterval(()=>{},1000)`
  );
}

/** Reads a stream to its end as UTF-8 text. */
async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const part of stream) text += decoder.decode(part, { stream: true });
  return text + decoder.decode();
}

/** Reads until the text seen so far contains `marker`; fails after `timeoutMs`. */
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: string,
  timeoutMs = 10_000,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for ${JSON.stringify(marker)}; saw ${JSON.stringify(seen)}`),
      );
    }, timeoutMs);
  });
  try {
    while (!seen.includes(marker)) {
      const step = await Promise.race([reader.read(), timeout]);
      if (step.done) throw new Error(`Stream ended before ${JSON.stringify(marker)}`);
      seen += decoder.decode(step.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/**
 * Whether the OS still has the process. A zombie (ended, not yet reaped by its new parent) counts
 * as gone: it holds nothing, and a bare container without an init may never reap it.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  return !isZombie(pid);
}

function isZombie(pid: number): boolean {
  let text: string;
  try {
    // Linux only; elsewhere the read fails and the process counts as alive (`kill 0` said so).
    text = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    return false;
  }
  const state = text.charAt(text.lastIndexOf(')') + 2);
  return state === 'Z' || state === 'X';
}

/** Waits for every pid to disappear (`kill(pid, 0)` gives `ESRCH`), then asserts it. */
async function expectGone(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + GONE_WAIT_MS;
  while (pids.some(isAlive) && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  expect(pids.filter(isAlive)).toEqual([]);
}

/** What one test created: processes to end, pid files, temp directories. */
class Scratch {
  readonly #procs: LaunchedProcess[] = [];
  readonly #pids = new Set<number>();
  readonly #dirs: string[] = [];

  async tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ot-launcher-conformance-'));
    this.#dirs.push(dir);
    return dir;
  }

  async pidsFile(): Promise<string> {
    const file = join(await this.tempDir(), 'pids');
    await appendFile(file, '');
    return file;
  }

  /** Waits until `count` pids are in the file and returns them in the order they were written. */
  async waitForPids(file: string, count: number, timeoutMs = 10_000): Promise<number[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pids = (await readFile(file, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map(Number);
      for (const pid of pids) this.#pids.add(pid);
      if (pids.length >= count) return pids;
      if (Date.now() > deadline) {
        throw new Error(`Timed out: ${String(pids.length)} of ${String(count)} pids in ${file}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }

  async launch(
    launcher: ProcessLauncher,
    script: string,
    extra: Partial<LaunchOptions> = {},
  ): Promise<LaunchedProcess> {
    return this.launchRaw(launcher, { cmd: NODE, args: ['-e', script], ...extra });
  }

  async launchRaw(
    launcher: ProcessLauncher,
    opts: Partial<LaunchOptions> & Pick<LaunchOptions, 'cmd' | 'args'>,
  ): Promise<LaunchedProcess> {
    const proc = await launcher.launch({ cwd: tmpdir(), env: {}, ...opts });
    this.#procs.push(proc);
    this.#pids.add(proc.pid);
    return proc;
  }

  /** Ends everything the test left running, then removes the directories. Never throws. */
  async cleanUp(): Promise<void> {
    await Promise.allSettled(this.#procs.map((proc) => proc.killTree({ graceMs: 0 })));
    for (const pid of this.#pids) {
      if (!isAlive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone in the meantime.
      }
    }
    await Promise.allSettled(this.#dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    this.#procs.length = 0;
    this.#pids.clear();
    this.#dirs.length = 0;
  }
}
