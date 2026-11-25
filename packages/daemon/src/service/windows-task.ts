// SPDX-License-Identifier: MPL-2.0
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from './command-runner.js';
import { escapeXml } from './launchd.js';
import {
  ServiceError,
  type InstallResult,
  type ServiceCommand,
  type ServiceInstallNote,
  type ServiceManager,
  type ServiceSpec,
  type ServiceStatus,
} from './types.js';

/**
 * One argument of a Windows command line, as `CommandLineToArgvW` (and the C runtime) read it:
 * quoted when it holds a space, a tab or a quote; the backslashes before a quote are doubled.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') out += '\\'.repeat(backslashes * 2 + 1) + '"';
    else out += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/**
 * What the task runs. `hidden` goes through `conhost.exe --headless`, which runs a console program
 * with no window **[N: not confirmed on a real Windows; `service.console: visible` is the way
 * out]**; `visible` runs the program as it is.
 */
export function taskAction(
  command: ServiceCommand,
  consoleMode: 'hidden' | 'visible',
): { readonly command: string; readonly args: string } {
  const words = [command.command, ...command.args].map(quoteWindowsArg);
  if (consoleMode === 'visible')
    return { command: command.command, args: words.slice(1).join(' ') };
  return { command: 'conhost.exe', args: ['--headless', ...words].join(' ') };
}

/**
 * The XML of the task (schema 1.4, Windows 10 and later). Pure. It carries no comment: the Task
 * Scheduler keeps its own copy and does not give one back [N: whether it accepts a comment is not confirmed]. It runs as the user, with the
 * token of the logon (`InteractiveToken`) and no elevation, at the logon of that user only; the
 * restart is `RestartOnFailure` (3 times, a minute apart). The Task Scheduler cannot restart after
 * a clean exit, so `restart: always` is the same as `on_failure` here.
 */
export function renderTaskXml(spec: ServiceSpec): string {
  const body = taskXmlBody(spec);
  return body.replace(DEFINITION_MARK, `[def:${definitionFingerprint(body)}]`);
}

/** The place, inside the description, of the fingerprint of the definition. */
const DEFINITION_MARK = '[def:]';

/**
 * [proposta] The fingerprint of a task definition: the first 16 hex digits of the SHA-256 of the XML
 * with an empty mark. It goes into the description, which the Task Scheduler keeps as it is; the XML
 * that `/Query /XML` prints is normalized by Windows, so it cannot be compared with ours directly.
 */
export function definitionFingerprint(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function taskXmlBody(spec: ServiceSpec): string {
  const action = taskAction(spec.command, spec.console);
  const user =
    spec.userId === undefined ? [] : [`      <UserId>${escapeXml(spec.userId)}</UserId>`];
  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>OTheater daemon (Orchestration Theater) ${DEFINITION_MARK}</Description>`,
    `    <URI>\\${escapeXml(spec.id)}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    `      <Enabled>${spec.autostart === 'logon' ? 'true' : 'false'}</Enabled>`,
    ...user,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    ...user,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
  ];
  if (spec.restart !== 'never') {
    lines.push(
      '    <RestartOnFailure>',
      '      <Interval>PT1M</Interval>',
      '      <Count>3</Count>',
      '    </RestartOnFailure>',
    );
  }
  lines.push(
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(action.command)}</Command>`,
    `      <Arguments>${escapeXml(action.args)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  );
  return lines.join('\n');
}

/** `schtasks /XML` reads UTF-16 little endian with a byte order mark. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

export interface WindowsTaskDeps {
  /** The task name: one word, in the root folder of the Task Scheduler. */
  readonly id: string;
  readonly run: CommandRunner;
  /** Where the XML is written for the `/Create` (and removed after). */
  readonly tmpDir: string;
}

/**
 * A Scheduled Task of the user (`schtasks.exe`), triggered at logon. [N] That a standard user can
 * create it without elevation is not confirmed on a real Windows: the CI runner is an
 * administrator, so the check that remains is the owner's (P12 of docs/21).
 */
export class WindowsTaskServiceManager implements ServiceManager {
  readonly kind = 'task' as const;
  readonly id: string;
  readonly #deps: WindowsTaskDeps;

  constructor(deps: WindowsTaskDeps) {
    this.#deps = deps;
    this.id = deps.id;
  }

  async install(spec: ServiceSpec): Promise<InstallResult> {
    const xml = renderTaskXml({ ...spec, id: this.#deps.id });
    const restartNote: ServiceInstallNote[] =
      spec.restart === 'always' ? ['restart_always_is_on_failure'] : [];
    // The same definition (its fingerprint is in the task) is left as it is; a different one, or a
    // task of an older version with no fingerprint, is rewritten with `/Create /F`.
    const mark = /\[def:[0-9a-f]{16}\]/.exec(xml)?.[0];
    const current = await this.#schtasks(['/Query', '/TN', this.#deps.id, '/XML']);
    if (mark !== undefined && current.code === 0 && current.stdout.includes(mark)) {
      return { location: this.#deps.id, notes: [...restartNote, 'unchanged'] };
    }
    await mkdir(this.#deps.tmpDir, { recursive: true });
    const file = join(this.#deps.tmpDir, `otheater-task-${randomUUID()}.xml`);
    await writeFile(file, encodeTaskXml(xml), {
      mode: 0o600,
    });
    try {
      this.#must(
        await this.#schtasks(['/Create', '/TN', this.#deps.id, '/XML', file, '/F']),
        'schtasks /Create',
      );
    } finally {
      await rm(file, { force: true });
    }
    return { location: this.#deps.id, notes: restartNote };
  }

  async uninstall(): Promise<void> {
    if (!(await this.#installed())) return;
    await this.#schtasks(['/End', '/TN', this.#deps.id]);
    this.#must(await this.#schtasks(['/Delete', '/TN', this.#deps.id, '/F']), 'schtasks /Delete');
  }

  async status(): Promise<ServiceStatus> {
    const query = await this.#schtasks(['/Query', '/TN', this.#deps.id]);
    // `Status` is printed in the language of Windows, so the state of the task is not read here:
    // `active` stays unknown, and the command asks the daemon itself (`api.json`).
    return { installed: query.code === 0, location: this.#deps.id };
  }

  async start(): Promise<void> {
    await this.#needInstalled();
    this.#must(await this.#schtasks(['/Run', '/TN', this.#deps.id]), 'schtasks /Run');
  }

  async stop(): Promise<void> {
    await this.#needInstalled();
    // `/End` ends the process at once (no clean stop of the daemon): Windows has no SIGTERM for it.
    await this.#schtasks(['/End', '/TN', this.#deps.id]);
  }

  #schtasks(args: readonly string[]): Promise<CommandResult> {
    return this.#deps.run('schtasks.exe', args);
  }

  #must(result: CommandResult, what: string): void {
    if (result.code === 0) return;
    throw new ServiceError(
      result.spawnFailed === true ? 'unavailable' : 'command_failed',
      `${what} failed`,
      (result.stderr || result.stdout).trim(),
    );
  }

  async #installed(): Promise<boolean> {
    return (await this.#schtasks(['/Query', '/TN', this.#deps.id])).code === 0;
  }

  async #needInstalled(): Promise<void> {
    if (!(await this.#installed())) {
      throw new ServiceError('not_installed', `the service ${this.#deps.id} is not installed`);
    }
  }
}
