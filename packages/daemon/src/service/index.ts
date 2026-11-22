// SPDX-License-Identifier: MPL-2.0
import type { CommandRunner } from './command-runner.js';
import { LaunchdServiceManager } from './launchd.js';
import { serviceIdOf } from './self-command.js';
import { SystemdServiceManager, systemdConfigHome } from './systemd.js';
import type { ServiceManager } from './types.js';
import { WindowsTaskServiceManager } from './windows-task.js';

export * from './types.js';
export { execRunner, type CommandResult, type CommandRunner } from './command-runner.js';
export { daemonCommandOf, resolveServiceCommand, serviceIdOf } from './self-command.js';
export { renderSystemdUnit, systemdUnitPath } from './systemd.js';
export { launchAgentPath, renderLaunchdPlist } from './launchd.js';
export { encodeTaskXml, quoteWindowsArg, renderTaskXml } from './windows-task.js';

export interface ServiceManagerInput {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  /** `process.getuid()`; macOS needs it for the domain `gui/<uid>`. */
  readonly uid?: number | undefined;
  readonly run: CommandRunner;
  /** Where the Windows task writes its XML for `/Create`. */
  readonly tmpDir: string;
  /** Overrides {@link serviceIdOf}: the real tests give a test id, never the product's. */
  readonly id?: string | undefined;
}

/** The manager of this platform, or `undefined` where there is none (other Unixes: not a Phase 10 target). */
export function createServiceManager(input: ServiceManagerInput): ServiceManager | undefined {
  const id = input.id ?? serviceIdOf(input.platform);
  switch (input.platform) {
    case 'linux':
      return new SystemdServiceManager({
        id,
        configHome: systemdConfigHome(input.env, input.homedir),
        run: input.run,
      });
    case 'darwin':
      return new LaunchdServiceManager({
        id,
        home: input.homedir,
        uid: input.uid ?? 0,
        run: input.run,
      });
    case 'win32':
      return new WindowsTaskServiceManager({ id, run: input.run, tmpDir: input.tmpDir });
    default:
      return undefined;
  }
}
