// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  formatProfileId,
  type AdapterImplements,
  type Clock,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { SituationSink } from '../situations.js';
import { DaemonHttpError, daemonGet, type DaemonNetworkPolicy } from './daemon-http.js';
import { recordProbeFailed } from './notices.js';
import { parseResetsAt } from './service.js';

/**
 * The quota probe of the MiniMax Token Plan (P8, architecture 5.6): `GET /v1/token_plan/remains`
 * with the key of the profile, which comes from the vault by P2.
 *
 * What is known about the endpoint:
 * - [S] Endpoint and `Authorization: Bearer <key>` come from the official FAQ of the M Plan
 *   (consulted 2026-11-15, Phase 0); the page gives no example of the answer.
 * - [V] A fake key answers HTTP 200 with `base_resp.status_code: 1004` on `www.minimax.io` and on
 *   `api.minimax.io` (Phase 0, 2026-11-15). So HTTP 200 is not success, and `1004` is "no reading":
 *   the key was not accepted, which says nothing about the quota. It is never taken as exhausted.
 * - [S] The shape of a good answer is not documented. The fields below come from third-party notes
 *   and an issue of the MiniMax-M2 repository (`data.current_interval_{total,usage}_count`,
 *   `current_interval_reset_time`, `current_weekly_*`). Whether `*_usage_count` holds what is
 *   LEFT or what was USED is ambiguous there (the issue suggests "left"). It is the
 *   `usageCountMeans` option (`quota.minimax.usage_count_means`), default `remaining` [proposta].
 *   The real answer depends on the key of the owner (item 11) [N].
 *
 * So the parser is strict: a field missing, of another type, a total of zero, a count above the
 * total or a time that is not a time make the answer `unknown_format`, never a guess. The probe
 * then rejects (the service leaves the state alone) and logs the SHAPE it saw (the paths and the
 * types of the values, never the values), once per distinct shape, so the format can be learned.
 *
 * Every failure rejects with a {@link MiniMaxProbeError}; none of them is a limit hit. A 429 of
 * this endpoint means the probe itself is being throttled: it waits for `Retry-After` (or a
 * minute) before it calls again, and it says nothing about the plan.
 */

/** The window names the probe reports. The 5-hour one is the one every plan has [S]. */
export const MINIMAX_WINDOW_INTERVAL = '5h';
export const MINIMAX_WINDOW_WEEKLY = 'weekly';

/** `Retry-After` when a 429 gives none, and the longest wait the probe accepts from one. */
export const MINIMAX_DEFAULT_BACKOFF_MS = 60_000;
export const MINIMAX_MAX_BACKOFF_MS = 3_600_000;

/** What the owner gets: where the answer failed. */
export type MiniMaxFailure =
  | 'no_key'
  | 'no_reading'
  | 'unknown_format'
  | 'rate_limited'
  | 'unauthorized'
  | 'http_error'
  | 'timeout'
  | 'unreachable';

export class MiniMaxProbeError extends AdapterUnavailable {
  readonly reason: MiniMaxFailure;

  constructor(reason: MiniMaxFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

/** What `usage_count` counts in the answer; see the header. */
export type UsageCountMeans = 'remaining' | 'used';

const count = z.number().int().min(0);
const time = z.union([z.string().min(1), z.number()]);

const Envelope = z.looseObject({
  base_resp: z.looseObject({
    status_code: z.number().int(),
    status_msg: z.string().optional(),
  }),
});

const Data = z.looseObject({
  current_interval_total_count: count,
  current_interval_usage_count: count,
  current_interval_reset_time: time,
  current_weekly_total_count: count.optional(),
  current_weekly_usage_count: count.optional(),
  current_weekly_reset_time: time.optional(),
});

export interface MiniMaxProbeOptions {
  /** `https://api.minimax.io`, or a loopback address in a test. No path, no credentials. */
  readonly baseUrl: string;
  /** The network policy of the daemon for this call. */
  readonly network: DaemonNetworkPolicy;
  readonly usageCountMeans: UsageCountMeans;
  /** The key of the profile from the vault (P2), or `undefined` when it has none. Never logged. */
  readonly keyOf: (profile: ProfileRef) => Promise<string | undefined>;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
  /** Where the failures are also written as `quota.probe_failed` (P24); the same gating as the log. */
  readonly situations?: SituationSink | undefined;
}

/** The paths and the types of a JSON value, never its values: `data.x:number`. Capped. */
export function shapeOf(value: unknown, limit = 40): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (out.length >= limit) return;
    if (Array.isArray(node)) {
      out.push(`${path}:array(${String(node.length)})`);
      if (node.length > 0 && depth < 4) walk(node[0], `${path}[]`, depth + 1);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      const keys = Object.keys(node).sort().slice(0, limit);
      if (keys.length === 0) out.push(`${path}:object(empty)`);
      for (const key of keys) {
        const child = (node as Record<string, unknown>)[key];
        walk(child, path === '' ? key : `${path}.${key}`, depth + 1);
      }
      return;
    }
    out.push(`${path}:${node === null ? 'null' : typeof node}`);
  };
  walk(value, '', 0);
  return out;
}

export class MiniMaxQuotaProbe implements QuotaProbe {
  readonly id = 'minimax-token-plan';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };
  readonly #options: MiniMaxProbeOptions;
  readonly #url: string;
  /** Profile id to the instant before which the endpoint is not called again (after a 429). */
  readonly #notBefore = new Map<string, number>();
  /** What was already logged, so a poll every 5 minutes does not repeat the same line. */
  readonly #logged = new Set<string>();

  constructor(options: MiniMaxProbeOptions) {
    this.#options = options;
    this.#url = new URL('v1/token_plan/remains', ensureSlash(options.baseUrl)).toString();
  }

  /** Only the 5-hour window is demanded; the weekly one is reported when the answer has it. */
  capabilities(): QuotaCapabilities {
    return { windows: [MINIMAX_WINDOW_INTERVAL], delivery: 'poll', precision: 'exact' };
  }

  async read(profile: ProfileRef): Promise<QuotaReading> {
    const id = formatProfileId(profile);
    const { clock, logger } = this.#options;
    const wait = this.#notBefore.get(id);
    if (wait !== undefined && clock.now() < wait) {
      throw new MiniMaxProbeError('rate_limited', 'The MiniMax endpoint asked to wait; not called');
    }
    const key = await this.#options.keyOf(profile);
    if (key === undefined || key === '') {
      this.#once(id, 'no_key', () => {
        logger.info({ profile: id }, 'the MiniMax profile has no key in the vault; not read');
        recordProbeFailed(this.#options.situations, id, 'no_key');
      });
      throw new MiniMaxProbeError('no_key', 'The profile has no MiniMax key in the vault');
    }
    let answer;
    try {
      answer = await daemonGet(
        this.#url,
        this.#options.network,
        { authorization: `Bearer ${key}` },
        () => clock.now(),
      );
    } catch (error) {
      if (error instanceof DaemonHttpError) {
        throw new MiniMaxProbeError(
          error.reason === 'timeout' ? 'timeout' : 'unreachable',
          error.message,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
    if (answer.status === 429) {
      const backoff = Math.min(
        answer.retryAfterMs ?? MINIMAX_DEFAULT_BACKOFF_MS,
        MINIMAX_MAX_BACKOFF_MS,
      );
      this.#notBefore.set(id, clock.now() + backoff);
      logger.warn({ profile: id, backoffMs: backoff }, 'the MiniMax quota endpoint answered 429');
      recordProbeFailed(this.#options.situations, id, 'rate_limited', {
        status: 429,
        backoffMs: backoff,
      });
      throw new MiniMaxProbeError('rate_limited', 'The MiniMax endpoint answered 429');
    }
    if (answer.status === 401 || answer.status === 403) {
      this.#once(id, `http:${String(answer.status)}`, () => {
        logger.warn({ profile: id, status: answer.status }, 'MiniMax did not accept the key');
        recordProbeFailed(this.#options.situations, id, 'unauthorized', { status: answer.status });
      });
      throw new MiniMaxProbeError('unauthorized', `MiniMax answered ${String(answer.status)}`);
    }
    if (answer.status !== 200) {
      throw new MiniMaxProbeError('http_error', `MiniMax answered ${String(answer.status)}`);
    }
    this.#notBefore.delete(id);
    return this.#parse(id, answer.body, key);
  }

  #parse(profile: string, body: string, key: string): QuotaReading {
    const { logger } = this.#options;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return this.#unknown(profile, ['(body):not JSON'], 'the answer is not JSON');
    }
    const envelope = Envelope.safeParse(json);
    if (!envelope.success) return this.#unknown(profile, shapeOf(json), 'no base_resp');
    const { status_code: code, status_msg: message } = envelope.data.base_resp;
    if (code !== 0) {
      // [V] 1004 with a fake key. Whatever the code, an envelope that is not a success is not a
      // reading of the plan: it says the call failed, not that the plan is empty.
      const text = (message ?? '').split(key).join('[key]').slice(0, 200);
      this.#once(profile, `code:${String(code)}`, () => {
        logger.warn(
          { profile, statusCode: code, statusMsg: text },
          'MiniMax gave no reading (base_resp is not a success)',
        );
        recordProbeFailed(this.#options.situations, profile, 'no_reading', {
          status: code,
          detail: text,
        });
      });
      throw new MiniMaxProbeError(
        'no_reading',
        `MiniMax gave no reading (base_resp ${String(code)})`,
      );
    }
    const data = Data.safeParse((json as { data?: unknown }).data);
    if (!data.success) return this.#unknown(profile, shapeOf(json), 'data does not fit');
    const d = data.data;
    const weeklyTotal = d.current_weekly_total_count;
    const weeklyUsage = d.current_weekly_usage_count;
    const weeklyReset = d.current_weekly_reset_time;
    const weeklyPresent = [weeklyTotal, weeklyUsage, weeklyReset].filter(
      (field) => field !== undefined,
    ).length;
    if (weeklyPresent !== 0 && weeklyPresent !== 3) {
      return this.#unknown(profile, shapeOf(json), 'the weekly window is incomplete');
    }
    const windows = [];
    const interval = this.#window(
      MINIMAX_WINDOW_INTERVAL,
      d.current_interval_total_count,
      d.current_interval_usage_count,
      d.current_interval_reset_time,
    );
    if (interval === undefined)
      return this.#unknown(profile, shapeOf(json), 'the 5h window is not valid');
    windows.push(interval);
    if (weeklyTotal !== undefined && weeklyUsage !== undefined && weeklyReset !== undefined) {
      const weekly = this.#window(MINIMAX_WINDOW_WEEKLY, weeklyTotal, weeklyUsage, weeklyReset);
      if (weekly === undefined)
        return this.#unknown(profile, shapeOf(json), 'the weekly window is not valid');
      windows.push(weekly);
    }
    return { observedAt: this.#options.clock.now(), windows };
  }

  #window(
    name: string,
    total: number,
    usageCount: number,
    reset: string | number,
  ): { window: string; usedPercent: number; resetsAt: number } | undefined {
    if (total === 0 || usageCount > total) return undefined;
    const resetsAt = parseResetsAt(reset);
    if (resetsAt === null) return undefined;
    const used = this.#options.usageCountMeans === 'remaining' ? total - usageCount : usageCount;
    return {
      window: name,
      usedPercent: Math.round((used / total) * 10_000) / 100,
      resetsAt,
    };
  }

  /** An answer the parser does not know: log what it looked like (types only), then reject. */
  #unknown(profile: string, shape: readonly string[], why: string): never {
    const signature = shape.join('|');
    this.#once(profile, `shape:${signature}`, () => {
      this.#options.logger.warn(
        { profile, shape, why },
        'MiniMax answered a format the probe does not know; the reading is unknown',
      );
      recordProbeFailed(this.#options.situations, profile, 'unknown_format', { detail: why });
    });
    throw new MiniMaxProbeError(
      'unknown_format',
      `The MiniMax answer is not a known format (${why})`,
    );
  }

  #once(profile: string, what: string, log: () => void): void {
    const key = `${profile}\u0000${what}`;
    if (this.#logged.has(key)) return;
    if (this.#logged.size >= 200) this.#logged.clear();
    this.#logged.add(key);
    log();
  }
}

function ensureSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}
