// SPDX-License-Identifier: MPL-2.0
import type { Clock, Store, TelemetryStore, UsageRecord } from '@otheater/core';
import { TELEMETRY_BATCH_REJECT_REASONS } from '@otheater/protocol';
import type { PoolStats } from '../execution/pool.js';
import type { Logger } from '../logger.js';
import { BUDGET_HIT_WINDOW, LIMIT_HIT_WINDOW } from '../quota/state.js';
import type { EventMetrics } from './metrics-events.js';
import type { OtlpExporterStats } from './otlp-exporter.js';
import type { TelemetryReceiverStats } from './receiver.js';
import type { UpdateCounters } from '../updates/checker.js';
import { renderPrometheus, type MetricFamily, type MetricSample } from './prometheus.js';

/**
 * The metrics of `GET /metrics` (Phase 8, P7; N70, N218). [proposta] Every metric comes from what the
 * daemon already has: the last quota readings, the usage table, the session pool and the prompt
 * queue, the health of the telemetry base and the counters of {@link EventMetrics}. A source that
 * fails is left out of that scrape (and said at `debug`): one broken table never makes the whole
 * answer an error. What has no source is not made up.
 *
 * Phase 9, P2 (N225 (2) and (3)) added three metrics of the waits, which {@link EventMetrics} derives
 * from `wait.started` and `wait.ended` (so only a wait past `events.wait_threshold` is counted), and
 * one of the batches the receiver refused, by reason, read from its `stats`. What is still left out
 * is the wait of the selection of an Executor itself (`demand.waiting`, `scenario.director_waiting`),
 * which has events of its own and not `wait.*`: see the report of the step.
 *
 * - Labels never carry an e-mail or an account id. The profile goes by its name, the client by its
 *   adapter id, the Executor by its id (`<model>[-<effort>]@<client>/<profile>`).
 * - The usage totals are read from the table and cached for `telemetry.prometheus.cache_ttl`, so a
 *   scrape every few seconds does not read the table each time. The other gauges are read each time.
 */

export interface MetricsSources {
  readonly clock: Clock;
  readonly store: Pick<Store, 'quotaSnapshots' | 'usage' | 'promptQueue'>;
  /** `execution.pool.stats()`; `undefined` while there is no execution (no clients). */
  readonly pool: () => PoolStats | undefined;
  readonly events: Pick<
    EventMetrics,
    'attempts' | 'resumes' | 'failures' | 'waits' | 'waitSeconds' | 'waitsActive'
  >;
  /** The telemetry base; `undefined` when telemetry is off. */
  readonly telemetry?: Pick<TelemetryStore, 'health'> | undefined;
  /** What the OTLP exporter dropped; `undefined` when it is not running. */
  readonly exporter?: (() => OtlpExporterStats | undefined) | undefined;
  /** What the OTLP receiver took and refused; `undefined` when it is not running. */
  readonly receiver?: (() => Pick<TelemetryReceiverStats, 'rejected'> | undefined) | undefined;
  /** The searches for updates and the versions refused (P7 of Phase 10); `undefined` when there is no service. */
  readonly updates?: (() => UpdateCounters | undefined) | undefined;
  /** `telemetry.prometheus.cache_ttl` in ms. */
  readonly cacheTtl: number;
  readonly logger: Pick<Logger, 'debug'>;
}

const RESERVED_WINDOWS: ReadonlySet<string> = new Set([LIMIT_HIT_WINDOW, BUDGET_HIT_WINDOW]);
const UNKNOWN = 'unknown';

/** `<client>/<profile>` as the label `client` and the label `profile`. */
export function splitProfileId(id: string): { readonly client: string; readonly profile: string } {
  const at = id.indexOf('/');
  return at < 0
    ? { client: UNKNOWN, profile: id }
    : { client: id.slice(0, at), profile: id.slice(at + 1) };
}

function sorted(samples: MetricSample[]): MetricSample[] {
  return samples.sort((a, b) =>
    JSON.stringify(Object.values(a.labels)).localeCompare(JSON.stringify(Object.values(b.labels))),
  );
}

function family(
  name: string,
  help: string,
  type: MetricFamily['type'],
  samples: MetricSample[],
): MetricFamily {
  return { name, help, type, samples: sorted(samples) };
}

function sum(into: Map<string, MetricSample>, labels: Record<string, string>, value: number): void {
  const key = JSON.stringify(labels);
  const known = into.get(key);
  into.set(key, { labels, value: (known?.value ?? 0) + value });
}

export class MetricsCollector {
  readonly #o: MetricsSources;
  #usage: { readonly at: number; readonly families: MetricFamily[] } | undefined;

  constructor(options: MetricsSources) {
    this.#o = options;
  }

  /** The body of a scrape. */
  async render(): Promise<string> {
    return renderPrometheus(await this.collect());
  }

  async collect(): Promise<MetricFamily[]> {
    const families: MetricFamily[] = [];
    for (const part of [
      () => this.#quota(),
      () => this.#usageFamilies(),
      () => this.#queues(),
      () => this.#events(),
      () => this.#waits(),
      () => this.#dropped(),
      () => this.#batches(),
      () => this.#updates(),
    ]) {
      try {
        families.push(...(await part()));
      } catch (error) {
        this.#o.logger.debug({ err: String(error) }, 'a source of /metrics failed; left out');
      }
    }
    return families;
  }

  async #quota(): Promise<MetricFamily[]> {
    const rows = await this.#o.store.quotaSnapshots.list();
    const used: MetricSample[] = [];
    const resets: MetricSample[] = [];
    for (const row of rows) {
      if (RESERVED_WINDOWS.has(row.window)) continue;
      const { client, profile } = splitProfileId(row.profileId);
      const labels = { profile, client, window: row.window };
      used.push({ labels, value: row.usedPercent / 100 });
      if (row.resetsAt !== null) resets.push({ labels, value: row.resetsAt / 1000 });
    }
    return [
      family(
        'otheater_quota_used_ratio',
        'Share of a quota window used at the last reading (1 is full).',
        'gauge',
        used,
      ),
      family(
        'otheater_quota_resets_at_seconds',
        'When a quota window resets, in seconds since the Unix epoch, when the reading says.',
        'gauge',
        resets,
      ),
    ];
  }

  async #usageFamilies(): Promise<MetricFamily[]> {
    const now = this.#o.clock.now();
    if (this.#usage !== undefined && now - this.#usage.at < this.#o.cacheTtl) {
      return this.#usage.families;
    }
    const records = await this.#o.store.usage.list();
    const families = usageFamilies(records);
    this.#usage = { at: now, families };
    return families;
  }

  async #queues(): Promise<MetricFamily[]> {
    const samples: MetricSample[] = [];
    const pool = this.#o.pool();
    if (pool !== undefined) samples.push({ labels: { queue: 'session_pool' }, value: pool.queued });
    const pending = await this.#o.store.promptQueue.list({ states: ['pending'] });
    samples.push({ labels: { queue: 'prompts' }, value: pending.length });
    return [
      family(
        'otheater_scheduler_queue_depth',
        'Items waiting in a queue of the daemon: prompts not delivered, sessions waiting for a slot.',
        'gauge',
        samples,
      ),
    ];
  }

  #events(): MetricFamily[] {
    const from = (counts: readonly { labels: Record<string, string>; value: number }[]) =>
      counts.map((count) => ({ labels: count.labels, value: count.value }));
    return [
      family(
        'otheater_attempts_total',
        'Attempts that ended since the daemon started, by Executor, role and outcome.',
        'counter',
        from(this.#o.events.attempts()),
      ),
      family(
        'otheater_resumes_total',
        'Sessions resumed after an interruption since the daemon started, by Executor and cause.',
        'counter',
        from(this.#o.events.resumes()),
      ),
      family(
        'otheater_executor_failures_total',
        'Sessions interrupted by a failure since the daemon started, by Executor and cause.',
        'counter',
        from(this.#o.events.failures()),
      ),
    ];
  }

  #waits(): MetricFamily[] {
    const from = (counts: readonly { labels: Record<string, string>; value: number }[]) =>
      counts.map((count) => ({ labels: count.labels, value: count.value }));
    return [
      family(
        'otheater_waits_active',
        'Waits past events.wait_threshold that are going on, by kind (a prompt queued for the Director, a session queued for the pool).',
        'gauge',
        from(this.#o.events.waitsActive()),
      ),
      family(
        'otheater_waits_total',
        'Waits past events.wait_threshold that ended since the daemon started, by kind and outcome.',
        'counter',
        from(this.#o.events.waits()),
      ),
      family(
        'otheater_wait_seconds_total',
        'Seconds waited by the waits past events.wait_threshold that ended since the daemon started, by kind (the whole wait, from its start).',
        'counter',
        from(this.#o.events.waitSeconds()),
      ),
    ];
  }

  #batches(): MetricFamily[] {
    const rejected = this.#o.receiver?.()?.rejected;
    if (rejected === undefined) return [];
    return [
      family(
        'otheater_telemetry_batches_rejected_total',
        'Batches the OTLP receiver refused since the daemon started, by reason (format, size, token).',
        'counter',
        TELEMETRY_BATCH_REJECT_REASONS.map((reason) => ({
          labels: { reason },
          value: rejected[reason],
        })),
      ),
    ];
  }

  #updates(): MetricFamily[] {
    const counters = this.#o.updates?.();
    if (counters === undefined) return [];
    return [
      family(
        'otheater_updates_checks_total',
        'Searches for a new version since the daemon started, by result (up_to_date, found, ready, rejected, skipped, failed).',
        'counter',
        Object.entries(counters.checks).map(([result, value]) => ({ labels: { result }, value })),
      ),
      family(
        'otheater_updates_rejected_total',
        'Versions refused since the daemon started, by reason (signature, sha256, size, version_not_newer, wrong_channel, bad_manifest).',
        'counter',
        Object.entries(counters.rejected).map(([reason, value]) => ({ labels: { reason }, value })),
      ),
    ];
  }

  async #dropped(): Promise<MetricFamily[]> {
    const samples: MetricSample[] = [];
    if (this.#o.telemetry !== undefined) {
      const health = await this.#o.telemetry.health();
      samples.push(
        { labels: { reason: 'queue_overflow' }, value: health.droppedOverflow },
        { labels: { reason: 'discarded' }, value: health.discarded },
      );
    }
    const exporter = this.#o.exporter?.();
    if (exporter !== undefined) {
      for (const [reason, count] of Object.entries(exporter.dropped)) {
        samples.push({ labels: { reason: `export_${reason}` }, value: count });
      }
    }
    return [
      family(
        'otheater_telemetry_dropped_total',
        'Telemetry records lost: the queue of the base was full, the base was missing, or the OTLP destination did not take a batch.',
        'counter',
        samples,
      ),
    ];
  }
}

/** The usage metrics of a list of usage records. Costs and counts that are unknown are not zero. */
export function usageFamilies(records: readonly UsageRecord[]): MetricFamily[] {
  const tokens = new Map<string, MetricSample>();
  const cost = new Map<string, MetricSample>();
  const equivalent = new Map<string, MetricSample>();
  for (const record of records) {
    const { profile } = splitProfileId(record.profileId);
    const base = { profile, executor: record.executorId };
    const kinds = [
      ['input', record.inputTokens],
      ['output', record.outputTokens],
      ['cached', record.cachedTokens],
    ] as const;
    for (const [kind, count] of kinds) {
      if (count !== null) sum(tokens, { ...base, model: record.model, kind }, count);
    }
    if (record.costUsd === null || record.costSource === null) continue;
    if (record.costKind === 'real') {
      sum(cost, { ...base, source: record.costSource }, record.costUsd);
    } else if (record.costKind === 'api_equivalent') {
      sum(equivalent, base, record.costUsd);
    }
  }
  return [
    family(
      'otheater_usage_tokens_total',
      'Tokens the turns consumed, by profile, Executor, model and kind (input, output, cached).',
      'counter',
      [...tokens.values()],
    ),
    family(
      'otheater_usage_cost_usd_total',
      'What the accounts were charged, in US dollars, by source (the client or the price table).',
      'counter',
      [...cost.values()],
    ),
    family(
      'otheater_usage_api_equivalent_usd_total',
      'What the tokens would cost by API, in US dollars (subscriptions are not charged this).',
      'counter',
      [...equivalent.values()],
    ),
  ];
}
