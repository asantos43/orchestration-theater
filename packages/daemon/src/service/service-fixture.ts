// SPDX-License-Identifier: MPL-2.0
import type { CommandResult, CommandRunner } from './command-runner.js';
import {
  ServiceError,
  type InstallResult,
  type ServiceManager,
  type ServiceSpec,
  type ServiceStatus,
} from './types.js';

/** One call of a {@link FakeCommandRunner}. */
export interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * A command runner that records what it was asked and answers from a table. The answer of a call is
 * the first rule whose `match` text is in `command + ' ' + args`; no rule is exit 0 with no output.
 * With it no test ever reaches `systemctl`, `launchctl` or `schtasks`.
 */
export class FakeCommandRunner {
  readonly calls: RecordedCall[] = [];
  readonly #rules: { match: string; result: Partial<CommandResult> }[] = [];

  /** Answers every call that holds `match` with `result` (earlier rules win). */
  on(match: string, result: Partial<CommandResult>): this {
    this.#rules.push({ match, result });
    return this;
  }

  readonly run: CommandRunner = (command, args) => {
    this.calls.push({ command, args: [...args] });
    const line = `${command} ${args.join(' ')}`;
    const rule = this.#rules.find((entry) => line.includes(entry.match));
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...rule?.result });
  };

  /** The calls as `command arg arg` lines, for an exact order check. */
  get lines(): string[] {
    return this.calls.map((call) => [call.command, ...call.args].join(' '));
  }
}

/** A service manager in memory: it installs nothing, it only keeps what was asked. */
export class FakeServiceManager implements ServiceManager {
  readonly kind = 'fake' as const;
  readonly id = 'otheater-fake';
  spec: ServiceSpec | undefined;
  installed = false;
  active = false;
  readonly calls: string[] = [];
  /** What `start` does besides setting `active` (tests start an in-process daemon here). */
  onStart: (() => Promise<void> | void) | undefined;
  /** Makes `start` fail as the real managers do. */
  startError: ServiceError | undefined;

  install(spec: ServiceSpec): Promise<InstallResult> {
    this.calls.push('install');
    this.spec = spec;
    this.installed = true;
    return Promise.resolve({ location: `fake:${spec.id}`, notes: [] });
  }

  uninstall(): Promise<void> {
    this.calls.push('uninstall');
    this.installed = false;
    this.active = false;
    this.spec = undefined;
    return Promise.resolve();
  }

  status(): Promise<ServiceStatus> {
    this.calls.push('status');
    return Promise.resolve({
      installed: this.installed,
      location: `fake:${this.spec?.id ?? 'none'}`,
      ...(this.installed ? { enabled: true, active: this.active } : {}),
    });
  }

  async start(): Promise<void> {
    this.calls.push('start');
    if (!this.installed)
      throw new ServiceError('not_installed', 'the fake service is not installed');
    if (this.startError !== undefined) throw this.startError;
    this.active = true;
    await this.onStart?.();
  }

  stop(): Promise<void> {
    this.calls.push('stop');
    if (!this.installed) {
      return Promise.reject(new ServiceError('not_installed', 'the fake service is not installed'));
    }
    this.active = false;
    return Promise.resolve();
  }
}
