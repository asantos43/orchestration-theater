// SPDX-License-Identifier: MPL-2.0
import type { DaemonConfig, PluginEventMode, PluginProjectDirMode } from '../config.js';

/**
 * What the processes of the plugins and the calls to them read of the configuration
 * (`plugins.*`, architecture 5.14; Phase 9, P5). A plain value, so the pool and the aggregator are
 * tested without the whole `DaemonConfig`.
 */
export interface PluginRuntimeConfig {
  /** `plugins.idle_timeout` in ms; `null` is `off` (the process lives until the daemon stops). */
  readonly idleTimeoutMs: number | null;
  /** `plugins.max_restarts`: failures in a row after which the process stays stopped. */
  readonly maxRestarts: number;
  /** `plugins.call_timeout` in ms. */
  readonly callTimeoutMs: number;
  /** `plugins.start_timeout` in ms. */
  readonly startTimeoutMs: number;
  /** `plugins.restart_backoff`, in ms. */
  readonly restartBackoff: { readonly initialMs: number; readonly maxMs: number };
  /** `plugins.http`. */
  readonly http: 'loopback' | 'off';
  /** `plugins.events` (P8): `off` refuses every event a plugin publishes. */
  readonly events: PluginEventMode;
  /** `plugins.event_max_bytes` (P8): the biggest payload of an event of a plugin, in bytes of JSON. */
  readonly eventMaxBytes: number;
  /** `plugins.project_dir`: `off` leaves `OTHEATER_PROJECT_DIR` out of the process. */
  readonly projectDir: PluginProjectDirMode;
  /** `plugins.panel.max_rows` (P10): the most rows of one block of the panel. */
  readonly panelMaxRows: number;
  /** `plugins.panel.max_bytes` (P10): the most bytes of the JSON of one block; `null` is `off`. */
  readonly panelMaxBytes: number | null;
}

/** The defaults of `plugins.*`, the same the configuration schema gives. */
export const DEFAULT_PLUGIN_RUNTIME: PluginRuntimeConfig = {
  idleTimeoutMs: 10 * 60_000,
  maxRestarts: 3,
  callTimeoutMs: 60_000,
  startTimeoutMs: 30_000,
  restartBackoff: { initialMs: 1_000, maxMs: 60_000 },
  http: 'loopback',
  events: 'declared',
  eventMaxBytes: 16_384,
  projectDir: 'scenario',
  panelMaxRows: 200,
  panelMaxBytes: 1_048_576,
};

/** The runtime values of a parsed `plugins` section. */
export function pluginRuntimeFromConfig(section: DaemonConfig['plugins']): PluginRuntimeConfig {
  return {
    idleTimeoutMs: section.idle_timeout,
    maxRestarts: section.max_restarts,
    callTimeoutMs: section.call_timeout,
    startTimeoutMs: section.start_timeout,
    restartBackoff: {
      initialMs: section.restart_backoff.initial,
      maxMs: section.restart_backoff.max,
    },
    http: section.http,
    events: section.events,
    eventMaxBytes: section.event_max_bytes,
    projectDir: section.project_dir,
    panelMaxRows: section.panel.max_rows,
    panelMaxBytes: section.panel.max_bytes,
  };
}

/**
 * Something the daemon says about a plugin that is also a fact for the log of events. The events
 * (`plugin.*`, P8) are not built yet: P5 writes the line in the log and hands the notice to the
 * {@link PluginNoticeSink} of the options, which is the extension point P8 binds to turn each
 * notice into an event (the rule "situations become events"). The notices carry no tool argument,
 * no result and no secret: only ids, names and the reason.
 */
export type PluginNotice =
  | {
      /** The server exposes a tool the manifest does not declare: it stays out. */
      readonly kind: 'tool_not_declared';
      readonly plugin: string;
      readonly project: string;
      readonly tool: string;
    }
  | {
      /** The manifest declares a tool the server does not expose: it is unavailable. */
      readonly kind: 'tool_not_exposed';
      readonly plugin: string;
      readonly project: string;
      readonly tool: string;
    }
  | {
      /** The name `<id>__<tool>` is too long, or already taken: the tool stays out. */
      readonly kind: 'tool_name_rejected';
      readonly plugin: string;
      readonly project: string;
      readonly tool: string;
      readonly reason: 'too_long' | 'taken';
    }
  | {
      /** The process of the plugin started in this project (the first use, or after a stop). */
      readonly kind: 'process_started';
      readonly plugin: string;
      readonly project: string;
      readonly pid: number | undefined;
    }
  | {
      /** The process was stopped on purpose; a failure is `process_failed`, not this. */
      readonly kind: 'process_stopped';
      readonly plugin: string;
      readonly project: string;
      readonly reason: 'idle' | 'shutdown' | 'inactive' | 'replaced';
    }
  | {
      /** A start failed or a running process died; the next use starts it again after a wait. */
      readonly kind: 'process_failed';
      readonly plugin: string;
      readonly project: string;
      readonly failures: number;
      readonly retryInMs: number;
      readonly reason: string;
    }
  | {
      /**
       * Too many failures in a row (`plugins.max_restarts`), or a start that cannot work: the
       * process stays stopped until `reset`. This is the one the architecture calls the final fall.
       */
      readonly kind: 'process_given_up';
      readonly plugin: string;
      readonly project: string;
      readonly failures: number;
      readonly reason: string;
    }
  | {
      /**
       * A call to a plugin tool did not run because of the permissions (P6): the tool is not in
       * the grant of the session (`not_allowed`), or the Producer refused the call
       * (`approval_denied`), nobody could be asked (`approval_unavailable`) or the question ended
       * with no answer (`approval_cancelled`).
       */
      readonly kind: 'tool_refused';
      readonly plugin: string;
      readonly project: string;
      readonly tool: string;
      readonly role: string;
      readonly reason:
        'not_allowed' | 'approval_denied' | 'approval_unavailable' | 'approval_cancelled';
    }
  | {
      /**
       * The manifest declares secrets that have no value in the vault (Phase 9, P7, N239): the
       * server does not start in this project. Only the names, never a value. [proposta]
       */
      readonly kind: 'secret_missing';
      readonly plugin: string;
      readonly project: string;
      readonly secrets: readonly string[];
    }
  | {
      /**
       * The answer of the `source` of a panel block was cut (P10, [proposta]): more rows than
       * `plugins.panel.max_rows` or more bytes than `plugins.panel.max_bytes`. No data in it.
       */
      readonly kind: 'panel_truncated';
      readonly plugin: string;
      readonly project: string;
      readonly source: string;
      readonly reason: 'rows' | 'bytes';
      readonly total: number;
      readonly kept: number;
      readonly limit: number;
    };

/** Where the notices go besides the log. Must not throw: a throw is caught and logged. */
export type PluginNoticeSink = (notice: PluginNotice) => void;

/**
 * An event notification a server of a plugin sent (P8): who sent it and the `params` as they came,
 * unchecked (the sink checks the name, the manifest and the size). It never carries a secret of the
 * pool; what the plugin put in `params` is the plugin's own.
 */
export interface PluginEventNotification {
  readonly plugin: string;
  readonly project: string;
  readonly params: unknown;
}

/** Where the event notifications of the servers go. Must not throw: a throw is caught and logged. */
export type PluginEventSink = (event: PluginEventNotification) => void;
