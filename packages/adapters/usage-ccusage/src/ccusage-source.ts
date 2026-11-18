// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  USAGE_SOURCE_PORT_VERSION,
  type UsageSource,
  type UsageSourceEntry,
  type UsageSourceQuery,
  type UsageSourceStatus,
} from '@otheater/core';
import { CCUSAGE_SUBCOMMANDS, assertAbsoluteDir, neutralEnv, profileEnv } from './env.js';
import { isCalendarDay, parseCcusageOutput } from './parse.js';

/**
 * The version of `ccusage` this adapter is written for (decision N118, 2026-11-17 and 2026-11-18):
 * published 2026-11-02, MIT. Another version is "wrong version": the adapter stays off.
 */
export const CCUSAGE_PINNED_VERSION = '20.0.48';

/** Default wait for one run of the tool, in ms [proposta]: it reads a folder of logs. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Largest output accepted from one run: a year of days by model is far below it. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** How the executable is found: `explicit` is an absolute path; `path` searches `PATH` by name. */
export const COMMAND_MODES = ['explicit', 'path'] as const;
export type CommandMode = (typeof COMMAND_MODES)[number];

/** Where the prices come from: `offline` makes no network call; `online` lets the tool fetch them. */
export const PRICING_MODES = ['offline', 'online'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

export interface CcusageSourceOptions {
  /**
   * The executable. With `commandMode: explicit` (default) an absolute path; with `path` a bare
   * name (default `ccusage`) looked up in `PATH` at each run, then run by its absolute path.
   */
  readonly command: string;
  readonly commandMode?: CommandMode;
  /**
   * The folder the tool sees as `HOME` and runs in. It must be a folder of the daemon itself
   * (inside its data directory), never the user's home: that is the point. Created on first use.
   */
  readonly homeDir: string;
  /** Version the tool must report (`--version`). Default {@link CCUSAGE_PINNED_VERSION}. */
  readonly requiredVersion?: string;
  readonly timeoutMs?: number;
  /** Default `offline`: no call to a price list on the network. */
  readonly pricing?: PricingMode;
  /** The parent environment, read for `PATH` only. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first executable called `name` in the folders of `pathVariable`, or `undefined`. */
export function findOnPath(name: string, pathVariable: string | undefined): string | undefined {
  if (pathVariable === undefined) return undefined;
  for (const folder of pathVariable.split(delimiter)) {
    if (folder.length === 0 || !isAbsolute(folder)) continue;
    const candidate = join(folder, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

interface RunOk {
  readonly ok: true;
  readonly stdout: string;
}
interface RunFailed {
  readonly ok: false;
  readonly notFound: boolean;
  readonly detail: string;
}

/** The first version number in the text (`20.0.48`, `ccusage 20.0.48`, `v20.0.48`). */
export function versionOf(text: string): string | undefined {
  return /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(text)?.[1];
}

/**
 * `UsageSource` over the `ccusage` CLI (architecture 5.6, 5.18; decision N118): a level C tool, a
 * separate process the user installs. The adapter never imports it as a library, never installs
 * it, and runs it with a built environment (see `env.ts`): `HOME`, the XDG folders and the
 * variables of the three clients always point at the profile or at an empty folder of the daemon.
 * It keeps from the output only counts, costs, days and model names, and it puts nothing the tool
 * printed in an error message (the output may hold paths and text of conversations).
 */
export class CcusageSource implements UsageSource {
  readonly id = 'ccusage';
  readonly implements = { port: 'UsageSource', range: `^${USAGE_SOURCE_PORT_VERSION}` } as const;

  readonly #command: string;
  readonly #mode: CommandMode;
  readonly #home: string;
  readonly #required: string;
  readonly #timeoutMs: number;
  readonly #offline: boolean;
  readonly #parent: Readonly<Record<string, string | undefined>>;
  #verified: string | undefined;

  constructor(options: CcusageSourceOptions) {
    const mode = options.commandMode ?? 'explicit';
    if (options.command.length === 0 || options.command.includes('\0')) {
      throw new InvalidInput('the ccusage command must not be empty');
    }
    if (mode === 'explicit') assertAbsoluteDir(options.command, 'the ccusage command');
    else if (/[\\/]/.test(options.command)) {
      throw new InvalidInput('with command mode "path" the command is a bare name, with no folder');
    }
    assertAbsoluteDir(options.homeDir, 'the ccusage home folder');
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1) {
      throw new InvalidInput('timeoutMs must be a positive whole number');
    }
    this.#command = options.command;
    this.#mode = mode;
    this.#home = options.homeDir;
    this.#required = options.requiredVersion ?? CCUSAGE_PINNED_VERSION;
    this.#timeoutMs = timeout;
    this.#offline = (options.pricing ?? 'offline') === 'offline';
    this.#parent = options.env ?? process.env;
  }

  async check(): Promise<UsageSourceStatus> {
    this.#verified = undefined;
    const resolved = this.#resolve();
    if (resolved === undefined) {
      return { ok: false, reason: 'not_found', detail: 'the ccusage executable was not found' };
    }
    const run = await this.#run(resolved, ['--version'], neutralEnv(this.#home, this.#parent));
    if (!run.ok) {
      return {
        ok: false,
        reason: run.notFound ? 'not_found' : 'failed',
        detail: run.detail,
      };
    }
    const version = versionOf(run.stdout);
    if (version === undefined) {
      return { ok: false, reason: 'failed', detail: 'ccusage did not say its version' };
    }
    if (version !== this.#required) {
      return {
        ok: false,
        reason: 'wrong_version',
        detail: `ccusage is ${version}; ${this.#required} is required`,
      };
    }
    this.#verified = version;
    return { ok: true, version };
  }

  async read(query: UsageSourceQuery): Promise<readonly UsageSourceEntry[]> {
    const subcommand = CCUSAGE_SUBCOMMANDS[query.clientId];
    if (subcommand === undefined) {
      throw new InvalidInput(`ccusage has no source for the client "${query.clientId}"`);
    }
    const env = profileEnv(query.clientId, query.profileDir, this.#home, this.#parent);
    for (const [what, day] of [
      ['sinceDay', query.sinceDay],
      ['untilDay', query.untilDay],
    ] as const) {
      if (day !== undefined && !isCalendarDay(day)) {
        throw new InvalidInput(`${what} must be a day as YYYY-MM-DD`);
      }
    }
    if (this.#verified === undefined) {
      const status = await this.check();
      if (!status.ok) throw new AdapterUnavailable(status.detail);
    }
    const resolved = this.#resolve();
    if (resolved === undefined)
      throw new AdapterUnavailable('the ccusage executable was not found');
    // [V, ccusage 20.0.48, 2026-11-18] `ccusage claude` exits 1 when the config folder has no
    // `projects/`, which is a profile that never ran a session: that is "no data", not a failure.
    if (query.clientId === 'claude-code' && !isDirectory(join(query.profileDir, 'projects'))) {
      return [];
    }
    const args = [subcommand, 'daily', '--json', '--timezone', 'UTC'];
    if (this.#offline) args.push('--offline');
    if (query.sinceDay !== undefined) args.push('--since', query.sinceDay);
    if (query.untilDay !== undefined) args.push('--until', query.untilDay);
    const run = await this.#run(resolved, args, env);
    if (!run.ok) throw new AdapterUnavailable(run.detail);
    return parseCcusageOutput(run.stdout);
  }

  /** The absolute path to run, or `undefined` when there is none. */
  #resolve(): string | undefined {
    if (this.#mode === 'explicit') return isExecutable(this.#command) ? this.#command : undefined;
    return findOnPath(this.#command, this.#parent.PATH);
  }

  async #run(
    command: string,
    args: readonly string[],
    env: Record<string, string>,
  ): Promise<RunOk | RunFailed> {
    await mkdir(this.#home, { recursive: true, mode: 0o700 });
    return new Promise((resolve) => {
      const child = execFile(
        command,
        [...args],
        {
          env,
          cwd: this.#home,
          timeout: this.#timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout) => {
          if (error === null) {
            resolve({ ok: true, stdout });
            return;
          }
          const code: unknown = (error as { code?: unknown }).code;
          const killed = (error as { killed?: unknown }).killed === true;
          const detail =
            code === 'ENOENT'
              ? 'the ccusage executable was not found'
              : killed
                ? `ccusage did not answer in ${String(this.#timeoutMs)} ms`
                : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                  ? 'ccusage printed more than the limit'
                  : typeof code === 'number'
                    ? `ccusage failed with exit code ${String(code)}`
                    : 'ccusage could not run';
          resolve({ ok: false, notFound: code === 'ENOENT', detail });
        },
      );
      child.stdin?.end();
    });
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
