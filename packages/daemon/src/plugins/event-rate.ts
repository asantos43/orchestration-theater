// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '@otheater/core';
import type { PluginEventRate } from './runtime-config.js';

/**
 * The rate of the events of a plugin (N243 item 67; `plugins.event_rate`, [proposta]). A plugin is
 * code the daemon does not trust, and every event it sends, or is refused, is a line in the log
 * and a row in the event log. This counts them per plugin and project (one process each, N238) in a
 * fixed window that starts at the first one, and says no to what comes after the limit.
 *
 * What it does with a drop: it counts it (per plugin, for the metric
 * `otheater_plugin_events_dropped_total`) and, when the window ends, tells {@link onDropped} once
 * with the count, so the log and the event log get one line for the window and not one per event,
 * which would be the flood the limit holds back. The timer is a `Clock.sleep`, stopped by
 * {@link close}; the summary of a window the daemon ended before is lost, the metric keeps the count.
 */

/** What a window that dropped events tells when it ends. */
export interface DroppedEvents {
  readonly plugin: string;
  readonly project: string;
  readonly dropped: number;
  readonly max: number;
  readonly windowMs: number;
}

interface Window {
  readonly end: number;
  used: number;
  dropped: number;
}

/** Past this many windows, the ones that already ended are swept (a project and a plugin are few). */
const SWEEP_ABOVE = 1024;

export class PluginEventLimiter {
  readonly #clock: Clock;
  readonly #onDropped: (summary: DroppedEvents) => void;
  readonly #windows = new Map<string, Window>();
  readonly #dropped = new Map<string, number>();
  readonly #abort = new AbortController();

  /** `onDropped` logs its own failures; one that still throws is swallowed here. */
  constructor(clock: Clock, onDropped: (summary: DroppedEvents) => void) {
    this.#clock = clock;
    this.#onDropped = onDropped;
  }

  /**
   * Counts one event or refusal of `plugin` in `project`. True when it is within `rate`, false when
   * it is over the limit of the window (drop it).
   */
  admit(plugin: string, project: string, rate: PluginEventRate): boolean {
    const now = this.#clock.now();
    const key = `${project}\u0000${plugin}`;
    let window = this.#windows.get(key);
    if (window === undefined || now >= window.end) {
      this.#sweep(now);
      window = { end: now + rate.windowMs, used: 0, dropped: 0 };
      this.#windows.set(key, window);
    }
    if (window.used < rate.max) {
      window.used += 1;
      return true;
    }
    window.dropped += 1;
    this.#dropped.set(plugin, (this.#dropped.get(plugin) ?? 0) + 1);
    if (window.dropped === 1) this.#arm(key, window, { plugin, project, rate });
    return false;
  }

  /** How many events and refusals were dropped since the daemon started, by plugin. */
  droppedByPlugin(): readonly { readonly plugin: string; readonly dropped: number }[] {
    return [...this.#dropped].map(([plugin, dropped]) => ({ plugin, dropped }));
  }

  /** Stops the timers; the summaries that were waiting for their window to end are not told. */
  close(): void {
    this.#abort.abort();
    this.#windows.clear();
  }

  #arm(
    key: string,
    window: Window,
    of: { plugin: string; project: string; rate: PluginEventRate },
  ): void {
    const wait = Math.max(0, window.end - this.#clock.now());
    void this.#clock.sleep(wait, this.#abort.signal).then(
      () => {
        if (this.#windows.get(key) === window) this.#windows.delete(key);
        try {
          this.#onDropped({
            plugin: of.plugin,
            project: of.project,
            dropped: window.dropped,
            max: of.rate.max,
            windowMs: of.rate.windowMs,
          });
        } catch {
          // The callback logs its own failures; a throw here would be an unhandled rejection.
        }
      },
      () => undefined,
    );
  }

  #sweep(now: number): void {
    if (this.#windows.size < SWEEP_ABOVE) return;
    for (const [key, window] of this.#windows) {
      if (now >= window.end && window.dropped === 0) this.#windows.delete(key);
    }
  }
}
