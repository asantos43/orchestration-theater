// SPDX-License-Identifier: MPL-2.0
import {
  InvalidInput,
  Cancelled,
  type Clock,
  type EventLog,
  type TelemetryStore,
  type UsageRegistry,
} from '@otheater/core';
import type {
  AnalysisGroupBy,
  AnalysisPeriod,
  AnalysisReport,
  GetAnalysisQuery,
} from '@otheater/protocol';
import type { Logger } from '../logger.js';
import { situationSubject, situationText, type SituationSink } from '../situations.js';
import type { AnalysisSettings } from './analysis-config.js';
import { DayAggregator, readEventsBetween } from './aggregator.js';
import { addDays, dayBoundary, daysBetween, isRealDay, type DayBoundary } from './day.js';
import { buildBottlenecks, buildGroups, buildSummary, compareSummaries } from './report.js';

/** The most days one catch-up builds (a base kept for years does not stall the start-up). */
const MAX_CATCH_UP_DAYS = 400;

export interface AnalysisServiceDeps {
  readonly clock: Clock;
  readonly telemetry: TelemetryStore;
  readonly events: Pick<EventLog, 'readFrom' | 'lastId'>;
  readonly usage: Pick<UsageRegistry, 'list'>;
  /** The projector of the daemon spans: a day is built after it has read the log up to now. */
  readonly daemonSpans?: { settle(): Promise<void> } | undefined;
  /** Read at each use; the `analysis` block is cold, so it does not change while the daemon runs. */
  readonly settings: () => AnalysisSettings;
  readonly situations?: SituationSink | undefined;
  readonly logger: Pick<Logger, 'warn' | 'info'>;
}

/** What building one day did. */
export interface DayResult {
  readonly day: string;
  readonly rows: number;
  /** The raw telemetry of the day was gone and the aggregates it already had were kept. */
  readonly kept: boolean;
}

/**
 * The analysis of the system (Phase 8, P9; architecture 5.11, N55 and N217). [proposta]
 * - {@link aggregateDay} folds a day of spans, events and usage into `rollups_daily` and replaces
 *   what the day had: the same base gives the same rows, so building a day again is harmless. A
 *   day whose raw telemetry was purged (it gives no row at all) keeps the aggregates it has.
 * - {@link catchUp} builds the days that are missing, up to yesterday, marks them as ready and
 *   applies `analysis.retention.days`. The schedule runs it when the daemon starts and at each
 *   rollover of the day (`analysis.schedule.mode`), on the clock handed in.
 * - {@link readyThrough} is the hook of P8: the last day with its aggregates stored. The purge of
 *   the raw telemetry may only reach the days up to it.
 * - {@link report} is what the API and `ot analysis` show.
 * Today is never built by the schedule (it is not over), so a report reaches yesterday.
 */
export class AnalysisService {
  readonly #deps: AnalysisServiceDeps;
  readonly #aggregator: DayAggregator;
  readonly #abort = new AbortController();
  #loop: Promise<void> | undefined;
  /** One build at a time: the schedule and a manual call never write the same day together. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(deps: AnalysisServiceDeps) {
    this.#deps = deps;
    this.#aggregator = new DayAggregator({
      telemetry: deps.telemetry,
      events: (from, to) => readEventsBetween(deps.events, from, to),
      usage: async (from, to) =>
        (await deps.usage.list({ since: from, until: to - 1 })).filter(
          (r) => r.occurredAt >= from && r.occurredAt < to,
        ),
      producerWaitStates: () => deps.settings().producer_wait_states,
    });
  }

  #boundary(): DayBoundary {
    return dayBoundary(this.#deps.settings().day_boundary);
  }

  /** Today, by the day boundary and the clock. */
  today(): string {
    return this.#boundary().dayOf(this.#deps.clock.now());
  }

  /** The last day whose aggregates are stored (`null` before the first). P8 purges up to it. */
  readyThrough(): Promise<string | null> {
    return this.#deps.telemetry.readRollupsReadyThrough();
  }

  /**
   * The ready day and the first instant after it (epoch ms), or `null` before the first day is
   * ready. The purge of the raw telemetry (P8) removes nothing at or after that instant.
   */
  async readyCutoff(): Promise<{ readonly day: string; readonly untilMs: number } | null> {
    const day = await this.#deps.telemetry.readRollupsReadyThrough();
    return day === null ? null : { day, untilMs: this.#boundary().endOf(day) };
  }

  /** Starts the schedule; a second call does nothing. With `analysis.schedule.mode: off` nothing runs. */
  start(): void {
    if (this.#loop !== undefined) return;
    if (this.#deps.settings().schedule.mode === 'off') return;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loop;
    await this.#tail.catch(() => undefined);
  }

  async #run(): Promise<void> {
    const { clock } = this.#deps;
    try {
      await this.catchUp();
      while (this.#deps.settings().schedule.mode === 'daily') {
        const boundary = this.#boundary();
        const next = boundary.endOf(boundary.dayOf(clock.now()));
        await clock.sleep(Math.max(1, next - clock.now()), this.#abort.signal);
        await this.catchUp();
      }
    } catch (error) {
      if (!this.#abort.signal.aborted && !(error instanceof Cancelled)) {
        this.#deps.logger.warn({ err: error }, 'the schedule of the analysis stopped');
      }
    }
  }

  /** Builds one day (serialised with every other build). A day is a real calendar day, `YYYY-MM-DD`. */
  aggregateDay(day: string): Promise<DayResult> {
    return this.#serial(() => this.#aggregateDay(day));
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #aggregateDay(day: string): Promise<DayResult> {
    if (!isRealDay(day)) throw new InvalidInput(`Not a day: ${day}`);
    const { telemetry, daemonSpans } = this.#deps;
    const boundary = this.#boundary();
    // What the projector has not written yet would be missing from the day.
    await daemonSpans?.settle();
    await telemetry.flush();
    const rows = await this.#aggregator.aggregate(day, boundary.startOf(day), boundary.endOf(day));
    if (
      rows.length === 0 &&
      (await telemetry.readRollups({ fromDay: day, toDay: day })).length > 0
    ) {
      return { day, rows: 0, kept: true };
    }
    await telemetry.replaceRollupDay(day, rows);
    return { day, rows: rows.length, kept: false };
  }

  /**
   * Builds the days after the ready one up to yesterday (all the days with raw telemetry, when
   * none is ready yet), marks each one ready as it is stored, and applies the retention. A day
   * that fails stops the run (the ready marker stays contiguous), is told as a notice and is tried
   * again at the next start or rollover.
   */
  catchUp(): Promise<readonly DayResult[]> {
    return this.#serial(() => this.#catchUp());
  }

  async #catchUp(): Promise<readonly DayResult[]> {
    const { telemetry, logger } = this.#deps;
    const settings = this.#deps.settings();
    const boundary = this.#boundary();
    const today = boundary.dayOf(this.#deps.clock.now());
    const yesterday = addDays(today, -1);
    const results: DayResult[] = [];
    try {
      const ready = await telemetry.readRollupsReadyThrough();
      let first: string;
      if (ready === null) {
        const [oldest] = await telemetry.readSpans({ limit: 1 });
        if (oldest === undefined) return results;
        first = boundary.dayOf(Number(oldest.startTimeUnixNano / 1_000_000n));
      } else {
        first = addDays(ready, 1);
      }
      if (settings.retention.days > 0) {
        const oldestKept = addDays(today, -settings.retention.days);
        if (first < oldestKept) first = oldestKept;
      }
      const days = daysBetween(first, yesterday).slice(-MAX_CATCH_UP_DAYS);
      for (const day of days) {
        try {
          const result = await this.#aggregateDay(day);
          await telemetry.markRollupsReady(day);
          results.push(result);
        } catch (error) {
          this.#failed(day, error);
          break;
        }
      }
      if (settings.retention.days > 0) {
        const removed = await telemetry.deleteRollupsBefore(
          addDays(today, -settings.retention.days),
        );
        if (removed > 0) logger.info({ removed }, 'the aggregates past the retention were removed');
      }
    } catch (error) {
      this.#failed('retention', error);
    }
    return results;
  }

  #failed(subject: string, error: unknown): void {
    this.#deps.logger.warn({ err: error, subject }, 'the daily aggregates could not be built');
    this.#deps.situations?.record('daemon.notice', {
      kind: 'analysis_failed',
      subject: situationSubject(subject),
      detail: situationText(error),
    });
  }

  /** The report of a period, with its comparison when asked. */
  async report(query: GetAnalysisQuery = {}): Promise<AnalysisReport> {
    const { telemetry } = this.#deps;
    const settings = this.#deps.settings();
    const ready = await telemetry.readRollupsReadyThrough();
    const groupBy: AnalysisGroupBy = query.groupBy ?? 'day';
    const to = query.to ?? ready ?? addDays(this.today(), -1);
    const from = query.from ?? addDays(to, 1 - settings.report.default_days);
    checkPeriod(from, to);
    if (query.compareScenario !== undefined && query.scenario === undefined) {
      throw new InvalidInput('compareScenario needs scenario');
    }
    if ((query.compareFrom === undefined) !== (query.compareTo === undefined)) {
      throw new InvalidInput('compareFrom and compareTo come together');
    }
    if (query.compareScenario !== undefined && query.compareFrom !== undefined) {
      throw new InvalidInput('Compare two periods or two scenarios, not both');
    }
    if (query.compareFrom !== undefined && query.compareTo !== undefined) {
      checkPeriod(query.compareFrom, query.compareTo);
    }

    const main = await this.#period(from, to, query.scenario, ready, settings.report.top);
    const groupRows = await telemetry.readRollups({
      fromDay: from,
      toDay: to,
      ...(query.scenario === undefined ? {} : { scenarioId: query.scenario }),
    });
    const grouped = buildGroups(groupRows, groupBy);
    let approximate = main.approximate || grouped.approximate;

    let compare: AnalysisReport['compare'] = null;
    if (query.compareFrom !== undefined && query.compareTo !== undefined) {
      const other = await this.#period(
        query.compareFrom,
        query.compareTo,
        query.scenario,
        ready,
        settings.report.top,
      );
      approximate ||= other.approximate;
      compare = {
        period: other.period,
        deltas: compareSummaries(main.period.summary, other.period.summary),
      };
    } else if (query.compareScenario !== undefined) {
      const other = await this.#period(from, to, query.compareScenario, ready, settings.report.top);
      approximate ||= other.approximate;
      compare = {
        period: other.period,
        deltas: compareSummaries(main.period.summary, other.period.summary),
      };
    }
    return {
      groupBy,
      readyThrough: ready,
      period: main.period,
      groups: grouped.groups,
      compare,
      missingDays: main.missingDays,
      percentilesApproximate: approximate,
    };
  }

  async #period(
    from: string,
    to: string,
    scenario: string | undefined,
    ready: string | null,
    top: number,
  ): Promise<{ period: AnalysisPeriod; approximate: boolean; missingDays: number }> {
    const rows = await this.#deps.telemetry.readRollups({
      fromDay: from,
      toDay: to,
      ...(scenario === undefined ? {} : { scenarioId: scenario }),
    });
    const built = buildSummary(rows);
    const withData = new Set(rows.map((r) => r.day));
    const missingDays = daysBetween(from, to).filter(
      (day) => ready === null || day > ready || !withData.has(day),
    ).length;
    return {
      approximate: built.approximate,
      missingDays,
      period: {
        from,
        to,
        scenario: scenario ?? null,
        summary: built.summary,
        bottlenecks: buildBottlenecks(built.summary, top),
      },
    };
  }
}

function checkPeriod(from: string, to: string): void {
  if (!isRealDay(from) || !isRealDay(to)) throw new InvalidInput(`Not a day: ${from} to ${to}`);
  if (from > to) throw new InvalidInput(`The period ends before it starts: ${from} to ${to}`);
  if (daysBetween(from, to).length > 3660)
    throw new InvalidInput('The period is longer than 3660 days');
}
