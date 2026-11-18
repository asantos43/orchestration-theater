// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  type AdapterImplements,
  type Clock,
  type Disposable,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';
import {
  parseStatuslineQuota,
  readStatuslineFile,
  STATUSLINE_WINDOWS,
} from './quota-statusline.js';

/** How often `watch` looks at the quota file. */
export const DEFAULT_WATCH_EVERY_MS = 2000;

export interface ClaudeQuotaProbeOptions {
  /** The directory of a profile (`CLAUDE_CONFIG_DIR`), where the statusline command writes. */
  readonly profileDir?: (profile: ProfileRef) => string;
  /** Default: the system clock. A reading from the future is held back to this instant. */
  readonly clock?: Pick<Clock, 'now'>;
  /** Default {@link DEFAULT_WATCH_EVERY_MS}. */
  readonly watchEveryMs?: number;
}

/**
 * The quota probe of Claude Code (architecture 5.6, P6). The source is the statusline: the command
 * the adapter installs in the `settings.json` of the profile keeps `rate_limits.five_hour` and
 * `seven_day` in a file of the profile directory, and this probe reads that file. Nothing here
 * calls the client, a model or the network, so a reading costs no quota.
 *
 * - `read` gives the windows `5h` and `7d` with their reset; the number is the one of the last
 *   reply of a real session, so it is old when the machine was idle (the freshness rule is the
 *   `QuotaService`'s). With no file, no `rate_limits`, no window still open or a value outside
 *   0..100, it rejects with `AdapterUnavailable` and the reason, and the profile stays `unknown`.
 * - `watch` looks at the file and delivers a reading each time the command wrote a new one.
 * - The resolution is about one point and the client may show 0% where a later reply shows 1%
 *   (Phase 0 [V]), hence `approximate`.
 *
 * What a running session says goes another way: the `rate_limit_event` becomes a quota signal
 * (`quotaSignalOf`).
 */
export class ClaudeQuotaProbe implements QuotaProbe {
  readonly id = 'claude-code';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };

  readonly #profileDir: ((profile: ProfileRef) => string) | undefined;
  readonly #clock: Pick<Clock, 'now'>;
  readonly #watchEveryMs: number;

  constructor(options: ClaudeQuotaProbeOptions = {}) {
    this.#profileDir = options.profileDir;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#watchEveryMs = options.watchEveryMs ?? DEFAULT_WATCH_EVERY_MS;
  }

  capabilities(): QuotaCapabilities {
    return {
      windows: Object.values(STATUSLINE_WINDOWS),
      delivery: 'both',
      precision: 'approximate',
    };
  }

  async read(profile: ProfileRef): Promise<QuotaReading> {
    const text = await readStatuslineFile(this.#dirOf(profile));
    const parsed = parseStatuslineQuota(text, this.#clock.now());
    if (!parsed.ok) {
      throw new AdapterUnavailable(`no usable Claude quota reading: ${parsed.reason}`);
    }
    return parsed.reading;
  }

  watch(profile: ProfileRef, onChange: (reading: QuotaReading) => void): Disposable {
    this.#dirOf(profile);
    let stopped = false;
    let busy = false;
    let last: number | undefined;
    const look = async (): Promise<void> => {
      if (stopped || busy) return;
      busy = true;
      try {
        const reading = await this.read(profile);
        if (stopped || reading.observedAt === last) return;
        last = reading.observedAt;
        onChange(reading);
      } catch {
        // No file yet, or one that is not usable: nothing new to deliver. `read` says why.
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void look(), this.#watchEveryMs);
    timer.unref();
    return {
      dispose: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  #dirOf(profile: ProfileRef): string {
    if (this.#profileDir === undefined) {
      throw new AdapterUnavailable('the Claude quota probe has no profile directory resolver');
    }
    return this.#profileDir(profile);
  }
}
