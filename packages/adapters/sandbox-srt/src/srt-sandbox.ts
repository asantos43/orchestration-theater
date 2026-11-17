// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import {
  AdapterUnavailable,
  InvalidInput,
  isOTheaterError,
  type LaunchOptions,
  type Sandbox,
  type SandboxAvailability,
  type SandboxCapabilities,
  type SandboxRequest,
} from '@otheater/core';
import {
  SRT_SANDBOX_ADAPTER,
  SrtSandboxConfigSchema,
  type SrtSandboxConfig,
  type SrtSandboxConfigInput,
} from './config.js';
import { allowedDomains, commandIdFor, filesystemRules, shellLine } from './policy.js';

/** The shell that runs the wrapped line outside the sandbox. [proposta] Present on Linux and macOS. */
const OUTER_SHELL = '/bin/bash';
/** [proposta] Longest wait for the probe command. */
const PROBE_TIMEOUT_MS = 15_000;
/** The platforms that have a mechanism (N94: Windows is a gate and has none). */
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'darwin'];

/** What a test may replace. */
export interface SrtSandboxDeps {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
}

function assertAbsolute(name: string, value: string): void {
  if (!value.startsWith('/') || value.includes('\0')) {
    throw new InvalidInput(`${name} must be an absolute path (got "${value}")`);
  }
}

/**
 * Layer 3 of the permissions through `@anthropic-ai/sandbox-runtime` (architecture 5.8, 5.18):
 * bubblewrap on Linux, Seatbelt on macOS. `sandbox-runtime` keeps one global manager per process, so
 * a process holds one open `SrtSandbox` at a time; `close()` releases it.
 *
 * What a confined command gets (every path below is checked by the operating system, not by this
 * code): writes only in the worktree, the profile folders, `extraWritePaths` and the temporary
 * folder of the adapter (the library also keeps `/tmp/claude` writable for itself); no network but
 * the domains of the request, through a proxy of the library that runs in this process, so the
 * event loop of the host must stay free (the caller spawns asynchronously); no read of the secret
 * paths. A server the command starts inside has its own loopback and is NOT reachable from outside
 * (measured, `--unshare-net`).
 *
 * [proposta] The network list is registered per worktree-and-policy (the id is a secret HMAC of
 * the request), so two commands of the same worktree and policy share a list, and one command that
 * learns its own id can present it. The library says the same of its ids: attribution, not a
 * boundary between concurrent commands. The lists stay until `close()`.
 */
export class SrtSandbox implements Sandbox {
  readonly id = SRT_SANDBOX_ADAPTER.id;
  readonly implements = SRT_SANDBOX_ADAPTER.implements;
  readonly config: SrtSandboxConfig;
  readonly #platform: NodeJS.Platform;
  readonly #tempDir: string;
  readonly #secret = randomBytes(32);
  readonly #registered = new Set<string>();
  #started: Promise<void> | undefined;
  #availability: Promise<SandboxAvailability> | undefined;
  #previousTmpdir: string | undefined;
  #tmpdirSet = false;
  #closed = false;

  constructor(config: SrtSandboxConfigInput = {}, deps: SrtSandboxDeps = {}) {
    const parsed = SrtSandboxConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new InvalidInput(`Invalid sandbox-srt config: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    this.config = parsed.data;
    this.#platform = deps.platform ?? process.platform;
    const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
    this.#tempDir = this.config.tempDir ?? join(tmpdir(), `otheater-sandbox-${String(uid)}`);
    assertAbsolute('tempDir', this.#tempDir);
  }

  /** The temporary folder the commands write to (and see as `TMPDIR`). */
  get tempDir(): string {
    return this.#tempDir;
  }

  capabilities(): SandboxCapabilities {
    return SUPPORTED_PLATFORMS.includes(this.#platform)
      ? { fields: ['writeScope', 'network'] }
      : { fields: [] };
  }

  available(): Promise<SandboxAvailability> {
    this.#availability ??= this.#probe();
    return this.#availability;
  }

  async wrap(request: SandboxRequest): Promise<LaunchOptions> {
    this.#assertOpen();
    assertAbsolute('worktree', request.worktree);
    for (const dir of [...request.profileDirs, ...request.extraWritePaths]) {
      assertAbsolute('writable path', dir);
    }
    if (!SUPPORTED_PLATFORMS.includes(this.#platform)) {
      throw new AdapterUnavailable(
        `sandbox-srt has no mechanism for ${this.#platform} (layer 3 is missing there, N94)`,
      );
    }
    await this.#start();
    const rules = filesystemRules(request, this.#tempDir);
    const commandId = commandIdFor(this.#secret, request, this.#tempDir);
    try {
      SandboxManager.registerCommandNetworkLists(commandId, {
        allowedDomains: [...allowedDomains(request)],
      });
    } catch (error) {
      throw new InvalidInput(
        `invalid network domain in the sandbox request: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    this.#registered.add(commandId);
    const customConfig: Partial<SandboxRuntimeConfig> = {
      filesystem: {
        denyRead: [...rules.denyRead],
        allowRead: [...rules.allowRead],
        allowWrite: [...rules.allowWrite],
        denyWrite: [...rules.denyWrite],
      },
    };
    let wrapped: string;
    try {
      wrapped = await SandboxManager.wrapWithSandbox(
        shellLine(request.launch.cmd, request.launch.args),
        OUTER_SHELL,
        customConfig,
        undefined,
        { commandId },
      );
    } catch (error) {
      throw new AdapterUnavailable(
        `sandbox-runtime could not wrap the command: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return {
      cmd: OUTER_SHELL,
      args: ['-c', wrapped],
      cwd: request.launch.cwd,
      env: request.launch.env,
      ...(request.launch.memoryLimitBytes === undefined
        ? {}
        : { memoryLimitBytes: request.launch.memoryLimitBytes }),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const started = this.#started;
    this.#started = undefined;
    for (const id of this.#registered) SandboxManager.unregisterCommandNetworkLists(id);
    this.#registered.clear();
    if (started !== undefined) {
      await started.catch(() => undefined);
      await SandboxManager.reset();
    }
    this.#restoreTmpdir();
  }

  #assertOpen(): void {
    if (this.#closed) throw new AdapterUnavailable('the sandbox is closed');
  }

  /** Starts the library once: the folder, the `TMPDIR`, the proxy. Fails with `AdapterUnavailable`. */
  #start(): Promise<void> {
    this.#started ??= this.#initialize().catch((error: unknown) => {
      this.#started = undefined;
      throw isOTheaterError(error)
        ? error
        : new AdapterUnavailable(
            `sandbox-runtime did not start: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
    });
    return this.#started;
  }

  async #initialize(): Promise<void> {
    const check = SandboxManager.checkDependencies();
    if (check.errors.length > 0) {
      throw new AdapterUnavailable(`sandbox-runtime dependencies: ${check.errors.join('; ')}`);
    }
    await mkdir(this.#tempDir, { recursive: true, mode: 0o700 });
    // The library reads this variable when it wraps and puts it in the command as `TMPDIR`; without
    // it the command would write to a shared `/tmp/claude`.
    this.#previousTmpdir = process.env.CLAUDE_CODE_TMPDIR;
    process.env.CLAUDE_CODE_TMPDIR = this.#tempDir;
    this.#tmpdirSet = true;
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: [this.#tempDir],
        denyWrite: [],
      },
      mandatoryDenySearchDepth: this.config.mandatoryDenySearchDepth,
      ...(this.config.bwrapPath === undefined ? {} : { bwrapPath: this.config.bwrapPath }),
      ...(this.config.socatPath === undefined ? {} : { socatPath: this.config.socatPath }),
    });
  }

  #restoreTmpdir(): void {
    if (!this.#tmpdirSet) return;
    this.#tmpdirSet = false;
    if (this.#previousTmpdir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
    else process.env.CLAUDE_CODE_TMPDIR = this.#previousTmpdir;
  }

  /** Runs `true` inside the sandbox: only a command that really ran says the mechanism works here. */
  async #probe(): Promise<SandboxAvailability> {
    if (!SUPPORTED_PLATFORMS.includes(this.#platform)) {
      return {
        ok: false,
        reason: `layer 3 has no adapter for ${this.#platform} (N94): the OS-level guarantees are missing`,
      };
    }
    try {
      const launch = await this.wrap({
        launch: { cmd: 'true', args: [], cwd: this.#tempDir, env: { PATH: '/usr/bin:/bin' } },
        policy: { writeScope: 'worktree', network: { allow: [] } },
        worktree: this.#tempDir,
        profileDirs: [],
        extraWritePaths: [],
        secretPaths: [],
        domains: [],
      });
      const outcome = await runToEnd(launch);
      return outcome.code === 0
        ? { ok: true }
        : {
            ok: false,
            reason: `the confined test command failed (exit ${String(outcome.code)}): ${outcome.stderr.trim().slice(0, 400)}`,
          };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

interface Outcome {
  readonly code: number | null;
  readonly stderr: string;
}

/** Runs a launch to its end, asynchronously: the proxy of the library lives on this event loop. */
function runToEnd(launch: LaunchOptions): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(launch.cmd, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, PROBE_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}
