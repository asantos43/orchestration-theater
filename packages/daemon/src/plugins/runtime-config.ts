// SPDX-License-Identifier: MPL-2.0
import type { DaemonConfig } from '../config.js';

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
}

/** The defaults of `plugins.*`, the same the configuration schema gives. */
export const DEFAULT_PLUGIN_RUNTIME: PluginRuntimeConfig = {
  idleTimeoutMs: 10 * 60_000,
  maxRestarts: 3,
  callTimeoutMs: 60_000,
  startTimeoutMs: 30_000,
  restartBackoff: { initialMs: 1_000, maxMs: 60_000 },
  http: 'loopback',
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
       * The manifest declares secrets that have no value in the vault (Phase 9, P7, N239): the
       * server does not start in this project. Only the names, never a value. [proposta]
       */
      readonly kind: 'secret_missing';
      readonly plugin: string;
      readonly project: string;
      readonly secrets: readonly string[];
    };

/** Where the notices go besides the log. Must not throw: a throw is caught and logged. */
export type PluginNoticeSink = (notice: PluginNotice) => void;
