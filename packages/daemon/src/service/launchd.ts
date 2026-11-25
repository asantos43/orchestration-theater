// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import type { CommandResult, CommandRunner } from './command-runner.js';
import {
  ServiceError,
  type InstallResult,
  type ServiceInstallNote,
  type ServiceManager,
  type ServiceSpec,
  type ServiceStatus,
} from './types.js';

/**
 * `~/Library/LaunchAgents/<label>.plist`: a LaunchAgent of the user. launchd exists only on macOS, so
 * the paths are POSIX on every host (the definitions are also rendered and tested elsewhere).
 */
export function launchAgentPath(home: string, id: string): string {
  return posix.join(home, 'Library', 'LaunchAgents', `${id}.plist`);
}

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Where launchd writes what the daemon prints (launchd has no journal). */
export function launchdLogFile(dataDir: string): string {
  return posix.join(dataDir, 'logs', 'service.log');
}

/**
 * The text of the plist. Pure. `RunAtLoad` follows `autostart`; the restart rule is `KeepAlive`:
 * `on_failure` is "keep it alive unless it exited cleanly", `always` is plain `KeepAlive`, `never`
 * has none. With `autostart: manual` there is no `KeepAlive` either: launchd would start the job
 * as soon as it is loaded (at the next login), which is what `manual` says no to.
 */
export function renderLaunchdPlist(spec: ServiceSpec): string {
  const str = (value: string): string => `<string>${escapeXml(value)}</string>`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Written by "ot service install" (OTheater). A new install rewrites this file. -->',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${str(spec.id)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[spec.command.command, ...spec.command.args].map((word) => `    ${str(word)}`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    spec.autostart === 'logon' ? '  <true/>' : '  <false/>',
  ];
  if (spec.autostart === 'logon' && spec.restart === 'always') {
    lines.push('  <key>KeepAlive</key>', '  <true/>');
  } else if (spec.autostart === 'logon' && spec.restart === 'on_failure') {
    lines.push(
      '  <key>KeepAlive</key>',
      '  <dict>',
      '    <key>SuccessfulExit</key>',
      '    <false/>',
      '  </dict>',
    );
  }
  lines.push('  <key>StandardOutPath</key>', `  ${str(launchdLogFile(spec.dataDir))}`);
  lines.push('  <key>StandardErrorPath</key>', `  ${str(launchdLogFile(spec.dataDir))}`);
  if (spec.path !== undefined) {
    lines.push(
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      '    <key>PATH</key>',
      `    ${str(spec.path)}`,
      '  </dict>',
    );
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

export interface LaunchdDeps {
  readonly id: string;
  readonly home: string;
  /** The numeric user id (`process.getuid()`): the agent lives in the domain `gui/<uid>`. */
  readonly uid: number;
  readonly run: CommandRunner;
}

/**
 * A LaunchAgent loaded by `launchctl bootstrap gui/<uid>`. [N] `bootstrap` needs the graphical
 * session of the user, which a macOS runner may not have: then the install fails with
 * `unavailable` after the plist is written, and the definition is still checked by the tests.
 */
export class LaunchdServiceManager implements ServiceManager {
  readonly kind = 'launchd' as const;
  readonly id: string;
  readonly #deps: LaunchdDeps;
  readonly #file: string;
  readonly #domain: string;
  readonly #target: string;

  constructor(deps: LaunchdDeps) {
    this.#deps = deps;
    this.id = deps.id;
    this.#file = launchAgentPath(deps.home, deps.id);
    this.#domain = `gui/${String(deps.uid)}`;
    this.#target = `${this.#domain}/${deps.id}`;
  }

  async install(spec: ServiceSpec): Promise<InstallResult> {
    await mkdir(dirname(this.#file), { recursive: true });
    await mkdir(dirname(launchdLogFile(spec.dataDir)), { recursive: true });
    const plist = renderLaunchdPlist({ ...spec, id: this.#deps.id });
    // The same plist is left as it is, and a loaded job is not taken out (that would stop the daemon).
    const unchanged = (await readOrUndefined(this.#file)) === plist;
    if (!unchanged) {
      // A loaded job keeps its old definition: take it out first (not an error if it is not there).
      await this.#ctl(['bootout', this.#target]);
      await writeFile(this.#file, plist, { mode: 0o644 });
    }
    if (spec.autostart === 'logon') {
      const loaded = unchanged && (await this.#ctl(['print', this.#target])).code === 0;
      if (!loaded) {
        this.#must(await this.#ctl(['bootstrap', this.#domain, this.#file]), 'launchctl bootstrap');
      }
    }
    const notes: ServiceInstallNote[] =
      spec.autostart === 'manual' && spec.restart !== 'never' ? ['no_restart_when_manual'] : [];
    if (unchanged) notes.push('unchanged');
    return { location: this.#file, notes };
  }

  async uninstall(): Promise<void> {
    await this.#ctl(['bootout', this.#target]);
    await rm(this.#file, { force: true });
  }

  async status(): Promise<ServiceStatus> {
    if (!(await this.#exists())) return { installed: false, location: this.#file };
    const printed = await this.#ctl(['print', this.#target]);
    if (printed.spawnFailed === true) {
      return { installed: true, location: this.#file, note: 'no_session' };
    }
    const loaded = printed.code === 0;
    return {
      installed: true,
      location: this.#file,
      enabled: loaded,
      active: loaded && /\bstate = running\b/.test(printed.stdout),
    };
  }

  async start(): Promise<void> {
    await this.#needInstalled();
    if ((await this.#ctl(['print', this.#target])).code !== 0) {
      this.#must(await this.#ctl(['bootstrap', this.#domain, this.#file]), 'launchctl bootstrap');
    }
    this.#must(await this.#ctl(['kickstart', this.#target]), 'launchctl kickstart');
  }

  async stop(): Promise<void> {
    await this.#needInstalled();
    // `bootout` also keeps a `KeepAlive` job from coming back at once; `start` loads it again.
    if ((await this.#ctl(['print', this.#target])).code !== 0) return;
    this.#must(await this.#ctl(['bootout', this.#target]), 'launchctl bootout');
  }

  #ctl(args: readonly string[]): Promise<CommandResult> {
    return this.#deps.run('launchctl', args);
  }

  #must(result: CommandResult, what: string): void {
    if (result.code === 0) return;
    throw new ServiceError(
      result.spawnFailed === true ? 'unavailable' : 'command_failed',
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

/** The text of a file, or `undefined` when it cannot be read (it is not there). */
export async function readOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
