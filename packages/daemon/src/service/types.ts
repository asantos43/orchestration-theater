// SPDX-License-Identifier: MPL-2.0

/**
 * The logon service of the daemon (Phase 10, P3; architecture 5.21 and 10). One port, three
 * adapters picked by `process.platform` (systemd --user, launchd, the Windows Task Scheduler) and a
 * fake for tests. The service is the USER's: it runs only while the user is logged on (5.21).
 */

export const SERVICE_KINDS = ['systemd', 'launchd', 'task', 'fake'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** A program and its arguments; `command` is an absolute path (a service has no `PATH` to search). */
export interface ServiceCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** What a manager writes into the definition it registers. */
export interface ServiceSpec {
  /** `com.otheater.daemon` on macOS, `otheater-daemon` elsewhere (see `serviceIdOf`). */
  readonly id: string;
  /** What the service runs, with the arguments of `daemon` already in (see `daemonCommandOf`). */
  readonly command: ServiceCommand;
  /** The data folder: where the logs of the service go (launchd has no journal). */
  readonly dataDir: string;
  /** `service.restart` of the configuration. */
  readonly restart: 'on_failure' | 'always' | 'never';
  /** `service.autostart`: `manual` registers the service without the logon trigger. */
  readonly autostart: 'logon' | 'manual';
  /** `service.console`: only the Windows task reads it. */
  readonly console: 'hidden' | 'visible';
  /** `DOMAIN\user` of the person (the Windows task is theirs); unknown outside Windows. */
  readonly userId?: string | undefined;
  /**
   * The `PATH` of the shell that ran `ot service install`. A user service starts with a minimal
   * `PATH` (systemd, launchd), and the daemon finds `claude` and `codex` through it, so it is
   * written into the definition. The Windows task keeps the one of the user's logon.
   */
  readonly path?: string | undefined;
}

/** What `status` found. `active` and `enabled` are `undefined` when the manager cannot tell. */
export interface ServiceStatus {
  readonly installed: boolean;
  /** The definition file (or the task name on Windows). */
  readonly location: string;
  readonly enabled?: boolean | undefined;
  readonly active?: boolean | undefined;
  /** Something the person should know (for example, that the manager has no user session). */
  readonly note?: 'no_session' | undefined;
}

/** What `install` did, for the message and for the notes of the limits of the platform. */
export interface InstallResult {
  readonly location: string;
  /** Limits of the platform that changed what the person asked for (shown after the install). */
  readonly notes: readonly ServiceInstallNote[];
}

export type ServiceInstallNote = 'restart_always_is_on_failure' | 'no_restart_when_manual';

export type ServiceErrorCode = 'command_failed' | 'unavailable' | 'not_installed';

/** A failure of the service manager of the system; `detail` is what it printed (never a secret). */
export class ServiceError extends Error {
  override name = 'ServiceError';
  readonly code: ServiceErrorCode;
  readonly detail: string;

  constructor(code: ServiceErrorCode, message: string, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** The port. Every method is idempotent: installing twice rewrites, uninstalling twice is a no-op. */
export interface ServiceManager {
  readonly kind: ServiceKind;
  /** The id the service is registered with (see `serviceIdOf`). */
  readonly id: string;
  /** Writes the definition and registers it (with the logon trigger when `autostart: logon`). Does not start the daemon. */
  install(spec: ServiceSpec): Promise<InstallResult>;
  /** Stops the service and removes the definition. Never touches the data of the daemon. */
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  /** Starts the daemon now through the service. Rejects with {@link ServiceError} `not_installed` if there is none. */
  start(): Promise<void>;
  /** Stops the daemon through the service (the manager sends the signal of a clean stop where it can). */
  stop(): Promise<void>;
}
