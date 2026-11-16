#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Secret } from '@otheater/core';
import type { TFunction } from 'i18next';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  runBackupCommand,
  runRestoreCommand,
  type CommandContext,
} from './commands.js';
import type { ComposeOverrides } from './compose.js';
import { loadConfig } from './config.js';
import { startDaemon, type PasswordPrompt } from './daemon.js';
import {
  createTranslator,
  detectSystemLocale,
  resolveLocale,
  type Locale,
  type LocaleSetting,
} from './i18n.js';
import { dataPaths, resolveDataDir, type Env } from './paths.js';
import { packageVersion } from './version.js';

/** Everything `main` takes from the outside, so a test can run the CLI without a process. */
export interface CliDeps {
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Aborting stops a running `ot daemon` (the entry point wires SIGINT and SIGTERM to it). */
  readonly signal?: AbortSignal | undefined;
  /** Builds the password prompt, given the translator; `undefined` when there is no terminal. */
  readonly passwordPrompt?: ((t: TFunction) => PasswordPrompt) | undefined;
  readonly overrides?: ComposeOverrides | undefined;
  /** Replaces `Intl`/`LANG` detection in tests. */
  readonly systemLocale?: string | undefined;
  readonly version?: string | undefined;
}

/** Period of the timer that keeps `ot daemon` alive (any value below 2^31 ms; it only has to exist). */
const KEEP_ALIVE_MS = 1_000_000_000;

const COMMANDS = ['daemon', 'backup', 'restore'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(name: string): name is Command {
  return (COMMANDS as readonly string[]).includes(name);
}

/**
 * Locale for what `ot` prints: `ui.locale` from `<data>/config.yaml` when it can be read, else the
 * system's. A broken config must not stop `ot --help`, so a failure here falls back to `auto`.
 */
async function localeFor(dataDir: string, deps: CliDeps): Promise<Locale> {
  let setting: LocaleSetting = 'auto';
  try {
    setting = (await loadConfig(dataPaths(dataDir).config)).ui.locale;
  } catch {
    // Reported by the command itself if it needs the config.
  }
  return resolveLocale(setting, deps.systemLocale ?? detectSystemLocale(deps.env));
}

/**
 * The `ot` command line. Returns the exit code: 0 good, 1 the command failed, 2 wrong usage.
 * Never calls `process.exit` and never reads `process.*`, see {@link CliDeps}.
 */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  let usageProblem: string | undefined;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    usageProblem = error instanceof Error ? error.message : String(error);
    parsed = { values: {}, positionals: [] };
  }
  const { values, positionals } = parsed;

  const dataDir = resolveDataDir({
    flag: values['data-dir'],
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir,
  });
  const t = await createTranslator(await localeFor(dataDir, deps));
  const version = deps.version ?? packageVersion();

  const usageError = (message: string): number => {
    deps.err(message);
    deps.err(t('usage.hint'));
    return EXIT_USAGE;
  };

  if (usageProblem !== undefined)
    return usageError(t('usage.invalidOption', { message: usageProblem }));
  if (values.help === true) {
    deps.out(t('usage.text'));
    return EXIT_OK;
  }
  if (values.version === true) {
    deps.out(version);
    return EXIT_OK;
  }
  const [command, ...rest] = positionals;
  if (command === undefined) return usageError(t('usage.missingCommand'));
  if (!isCommand(command)) return usageError(t('usage.unknownCommand', { command }));

  const context: CommandContext = {
    dataDir,
    t,
    out: deps.out,
    err: deps.err,
    overrides: deps.overrides,
    version,
  };
  try {
    switch (command) {
      case 'daemon':
        if (rest.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runDaemon(context, deps);
      case 'backup':
        if (rest.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runBackupCommand(context);
      case 'restore': {
        const [folder, ...extra] = rest;
        if (folder === undefined) return usageError(t('usage.missingBackupPath'));
        if (extra.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runRestoreCommand(context, folder);
      }
    }
  } catch (error) {
    deps.err(
      t('errors.prefix', { message: error instanceof Error ? error.message : String(error) }),
    );
    return EXIT_FAILED;
  }
}

function parseCliArgs(argv: readonly string[]): {
  values: {
    'data-dir'?: string | undefined;
    help?: boolean | undefined;
    version?: boolean | undefined;
  };
  positionals: string[];
} {
  return parseArgs({
    args: [...argv],
    options: {
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
    strict: true,
  });
}

async function runDaemon(context: CommandContext, deps: CliDeps): Promise<number> {
  const handle = await startDaemon({
    dataDir: context.dataDir,
    overrides: deps.overrides,
    signal: deps.signal,
    version: context.version,
    passwordPrompt: deps.passwordPrompt?.(context.t),
  });
  // Before the first message: a signal that arrives right now must still be announced.
  deps.signal?.addEventListener(
    'abort',
    () => {
      context.out(context.t('daemon.stopping'));
    },
    { once: true },
  );
  const status = handle.status();
  context.out(context.t('daemon.running', { pid: status.pid, dataDir: status.dataDir }));
  if (handle.vaultLocked) context.err(context.t('daemon.vaultLocked'));
  // A pending promise does not keep Node alive, and with `backup.when: manual` the daemon has no
  // timer at all (the HTTP server will hold the process later): this one does, until the stop.
  const keepAlive = setInterval(() => undefined, KEEP_ALIVE_MS);
  try {
    await handle.stopped;
  } finally {
    clearInterval(keepAlive);
  }
  context.out(context.t('daemon.stopped'));
  return EXIT_OK;
}

/**
 * Reads a line from the terminal without echo. Not covered by automated tests: it needs a real TTY
 * (checked by hand). The question is written to stderr so stdout stays clean for scripts.
 */
export function readHidden(
  question: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    output.write(question);
    const mute = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const lines = createInterface({ input, output: mute, terminal: true });
    let answered = false;
    lines.once('line', (line) => {
      answered = true;
      lines.close();
      output.write('\n');
      resolve(line);
    });
    // In raw mode Ctrl+C reaches readline, not the process: without this the prompt would hang.
    // Give up the prompt and pass the interrupt on, so the entry point stops as usual.
    lines.once('SIGINT', () => {
      lines.close();
      process.kill(process.pid, 'SIGINT');
    });
    lines.once('close', () => {
      if (!answered) {
        output.write('\n');
        resolve(undefined);
      }
    });
  });
}

/** [proposta] The master password is asked only on a terminal; piped input gets no prompt. */
function terminalPasswordPrompt(t: TFunction): PasswordPrompt {
  return async ({ attempt, maxAttempts }) => {
    const answer = await readHidden(
      t('daemon.passwordPrompt', { attempt, max: maxAttempts }),
      process.stdin,
      process.stderr,
    );
    return answer === undefined || answer === '' ? undefined : new Secret(answer);
  };
}

async function entry(): Promise<void> {
  const controller = new AbortController();
  let signals = 0;
  const onSignal = (): void => {
    signals += 1;
    // A second Ctrl+C means "now": do not wait for a stop that is stuck.
    if (signals > 1) process.exit(EXIT_FAILED);
    controller.abort(new Error('terminated by signal'));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const code = await main(process.argv.slice(2), {
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    signal: controller.signal,
    passwordPrompt: process.stdin.isTTY ? terminalPasswordPrompt : undefined,
  });
  process.exitCode = code;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}

/** Runs only when this file is the program (also through the `ot` symlink the package manager makes). */
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void entry();
}
