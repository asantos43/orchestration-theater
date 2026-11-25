// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CommandRunner, CommandResult } from './command-runner.js';
import { readOrUndefined } from './launchd.js';
import {
  ServiceError,
  type InstallResult,
  type ServiceManager,
  type ServiceSpec,
  type ServiceStatus,
} from './types.js';

/** Where the user units live: `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user`. */
export function systemdUnitPath(configHome: string, id: string): string {
  return join(configHome, 'systemd', 'user', `${id}.service`);
}

/** The folder above `systemd/user`: `XDG_CONFIG_HOME` when it is absolute (as the XDG spec says), else `~/.config`. */
export function systemdConfigHome(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg?.startsWith('/') === true ? xdg : join(home, '.config');
}

const SAFE_WORD = /^[A-Za-z0-9_@+=:,./-]+$/;

/** One word of `ExecStart=` or `Environment=`: systemd splits on spaces and reads C-style quotes; `%` and `$` are specifiers. */
export function systemdQuote(word: string): string {
  const escaped = word.replaceAll('%', '%%').replaceAll('$', '$$$$');
  if (SAFE_WORD.test(word)) return escaped;
  return `"${escaped.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

const RESTART = { on_failure: 'on-failure', always: 'always', never: 'no' } as const;

/** The text of the unit. Pure: the reference file of the test is compared with it. */
export function renderSystemdUnit(spec: ServiceSpec): string {
  const exec = [spec.command.command, ...spec.command.args].map(systemdQuote).join(' ');
  const lines = [
    '# Written by "ot service install" (OTheater). A new install rewrites this file.',
    '[Unit]',
    'Description=OTheater daemon (Orchestration Theater)',
    // A second start on the same data folder exits with an error (the instance lock): without a
    // limit, `Restart=on-failure` would try again every RestartSec for ever.
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${exec}`,
    `Restart=${RESTART[spec.restart]}`,
    'RestartSec=5',
    'TimeoutStopSec=30',
  ];
  if (spec.path !== undefined) lines.push(`Environment=${systemdQuote(`PATH=${spec.path}`)}`);
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

export interface SystemdDeps {
  readonly id: string;
  /** The folder above `systemd/user` (see {@link systemdConfigHome}). */
  readonly configHome: string;
  readonly run: CommandRunner;
}

const NO_SESSION = /Failed to connect to (user )?bus|No medium found|XDG_RUNTIME_DIR/i;

/** `systemd --user`: a unit, enabled for `default.target`. No `loginctl enable-linger`: it runs only with a session. */
export class SystemdServiceManager implements ServiceManager {
  readonly kind = 'systemd' as const;
  readonly id: string;
  readonly #deps: SystemdDeps;
  readonly #file: string;
  readonly #unit: string;

  constructor(deps: SystemdDeps) {
    this.#deps = deps;
    this.id = deps.id;
    this.#file = systemdUnitPath(deps.configHome, deps.id);
    this.#unit = `${deps.id}.service`;
  }

  async install(spec: ServiceSpec): Promise<InstallResult> {
    const unit = renderSystemdUnit(spec);
    // The same unit is left as it is (no daemon-reload); a different one (an older command) is rewritten.
    const unchanged = (await readOrUndefined(this.#file)) === unit;
    if (!unchanged) {
      await mkdir(dirname(this.#file), { recursive: true });
      await writeFile(this.#file, unit, { mode: 0o644 });
      this.#must(await this.#ctl(['daemon-reload']), 'systemctl daemon-reload');
    }
    if (spec.autostart === 'logon') {
      this.#must(await this.#ctl(['enable', this.#unit]), `systemctl enable ${this.#unit}`);
    } else {
      await this.#ctl(['disable', this.#unit]);
    }
    return { location: this.#file, notes: unchanged ? ['unchanged'] : [] };
  }

  async uninstall(): Promise<void> {
    if (!(await this.#exists())) return;
    await this.#ctl(['stop', this.#unit]);
    await this.#ctl(['disable', this.#unit]);
    await rm(this.#file, { force: true });
    await this.#ctl(['daemon-reload']);
  }

  async status(): Promise<ServiceStatus> {
    if (!(await this.#exists())) return { installed: false, location: this.#file };
    const enabled = await this.#ctl(['is-enabled', this.#unit]);
    const active = await this.#ctl(['is-active', this.#unit]);
    if (this.#noSession(enabled) && this.#noSession(active)) {
      return { installed: true, location: this.#file, note: 'no_session' };
    }
    return {
      installed: true,
      location: this.#file,
      enabled: enabled.stdout.trim().startsWith('enabled'),
      active: active.stdout.trim() === 'active',
    };
  }

  async start(): Promise<void> {
    await this.#needInstalled();
    this.#must(await this.#ctl(['start', this.#unit]), `systemctl start ${this.#unit}`);
  }

  async stop(): Promise<void> {
    await this.#needInstalled();
    this.#must(await this.#ctl(['stop', this.#unit]), `systemctl stop ${this.#unit}`);
  }

  #ctl(args: readonly string[]): Promise<CommandResult> {
    return this.#deps.run('systemctl', ['--user', ...args]);
  }

  #noSession(result: CommandResult): boolean {
    return result.spawnFailed === true || NO_SESSION.test(result.stderr);
  }

  #must(result: CommandResult, what: string): void {
    if (result.code === 0) return;
    throw new ServiceError(
      this.#noSession(result) ? 'unavailable' : 'command_failed',
      `${what} failed`,
      (result.stderr || result.stdout).trim(),
    );
  }

  async #exists(): Promise<boolean> {
    try {
      await readFile(this.#file);
      return true;
    } catch {
      return false;
    }
  }

  async #needInstalled(): Promise<void> {
    if (!(await this.#exists())) {
      throw new ServiceError('not_installed', `the service ${this.#deps.id} is not installed`);
    }
  }
}
