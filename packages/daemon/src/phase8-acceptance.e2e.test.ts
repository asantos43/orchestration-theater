// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  otelBaseEnv,
  Secret,
  type Clock,
  type EventEnvelope,
  type ClientOtel,
  type OtelLaunch,
  type Profile,
} from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import {
  AnalysisReportSchema,
  AtifTrajectorySchema,
  PlaySpansSchema,
  TelemetryStatusSchema,
} from '@otheater/protocol';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeWithLauncher } from './launcher-fixture.js';
import { parseConfig } from './config.js';
import { createSilentLogger } from './logger.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayFakes,
  type PlayHarness,
} from './orchestration/e2e-fixture.js';
import { dataPaths } from './paths.js';
import { AtifExporter } from './atif/atif-exporter.js';
import { usageSettingsOf } from './usage/index.js';
import { Redactor } from './telemetry/redaction.js';
import { TelemetryReceiver } from './telemetry/receiver.js';
import { TelemetrySessions } from './telemetry/sessions.js';
import { SPAN_NAME } from './telemetry/span-conventions.js';
import { traceIdForPlay } from './telemetry/span-ids.js';
import { MemoryTelemetryStore } from './telemetry/telemetry-fixture.js';

/**
 * Phase 8, P13, the automatic acceptance: ONE play of the fake agent, with `telemetry.export:
 * both`, the client exporting its own telemetry to the daemon's receiver, the real telemetry base
 * (SQLite) and a test OTLP destination. What it holds together, step by step of the phase:
 * - P2/P3: the client's span, metric and log are in `telemetry.sqlite` tied to the play, the
 *   attempt and the session; P4: the daemon's span tree is in the same base, with the same ids;
 * - the redaction (P2): an email and a secret the client exported, and the same pair in the
 *   prompt, are in no row of any table and in no file of the ATIF;
 * - P5/P6: the ATIF of the play passes the zod schema, and, with `OT_ATIF_OUT` (the CI job `atif`),
 *   it is left in `valid/phase8-acceptance-<content>/` for the Harbor validator;
 * - P7: the trace reaches the OTLP destination and `GET /metrics` answers in Prometheus text;
 * - P9: the analysis report has the day of the play, once the day is over; P8: the purge does not
 *   remove what the aggregates do not cover; P10: `GET /v1/telemetry` shows the receiver, the base
 *   and the export, and `GET /v1/plays/:id/spans` the tree.
 * The clock is a fake one, started at the real instant (the client stamps its records with the real
 * time, and the report of a day only joins what falls in it) and moved by the test.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

/** Fake personal data: the email of an account and a secret, as a client might export them. */
const EMAIL = 'maria.teste.fake@example.com';
const SECRET = 'planted-secret-value-7f3a91c2';
const VAULT_PATH = 'profiles/planted/api_key';
const DESTINATION_TOKEN = 'otlp/destination-token';

const MS_PER_DAY = 86_400_000;

/** The span the fake agent exports for each prompt turn. */
const CLIENT_SPAN = 'fake_agent.turn';

/** The clock moving one millisecond at each reading (coherent times), and the test moves it by `advance`. */
class MovingClock implements Clock {
  readonly #base: FakeClock;
  #ticks = 0;
  constructor(startMs: number) {
    this.#base = new FakeClock(startMs);
  }
  now(): number {
    this.#ticks += 1;
    return this.#base.now() + this.#ticks;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.#base.sleep(ms, signal);
  }
  advance(ms: number): Promise<void> {
    return this.#base.advance(ms);
  }
}

/** The fake client exporting its telemetry (as the real ones do), with an email and a secret in its resource. */
class ExportingFake extends FakeClientAdapter {
  protected override otelLaunch(_profile: Profile, otel: ClientOtel): Promise<OtelLaunch> {
    const env = otelBaseEnv(otel);
    env.OTEL_RESOURCE_ATTRIBUTES = `${env.OTEL_RESOURCE_ATTRIBUTES ?? ''},user.email=${EMAIL},deploy.note=${SECRET}`;
    return Promise.resolve({ env });
  }
}

function fakes(clock: Clock, vault: InMemorySecretVault): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock,
    vault,
    client: (launcher, command, env) =>
      new ExportingFake({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

/** The destination: the receiver of P2 on a test port, writing to a store the test can read. */
async function startDestination(): Promise<{
  receiver: TelemetryReceiver;
  store: MemoryTelemetryStore;
}> {
  const store = new MemoryTelemetryStore();
  const receiver = await TelemetryReceiver.start({
    store,
    sessions: new TelemetrySessions(),
    redactor: new Redactor({ mode: 'default' }),
    port: 'auto',
    maxBody: 8 * 1024 * 1024,
    logger: createSilentLogger(),
  });
  return { receiver, store };
}

const CONFIG = (endpoint: string, dir: string): string => `
telemetry:
  export: both
  otlp:
    endpoint: ${endpoint}
    headers:
      Authorization: ${DESTINATION_TOKEN}
    retry:
      retries: 0
    # The day is moved by the fake clock: a short interval or timeout would fire many times
    # (a lap per interval, a timeout per request), so both are longer than the whole test.
    interval: 30d
    timeout: 30d
analysis:
  day_boundary: utc
atif:
  export:
    on: manual
    dir: ${dir}
`;

type Row = Record<string, unknown>;

/** Every row of every table of the telemetry file, read as the file is (the daemon keeps it open). */
function readTables(file: string): Record<string, Row[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const tables: Record<string, Row[]> = {};
    for (const { name } of names) {
      tables[name] = db.prepare(`SELECT * FROM "${name}"`).all();
    }
    return tables;
  } finally {
    db.close();
  }
}

function asJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? String(item) : item,
  );
}

/** The `YYYY-MM-DD` of an instant, UTC (the `analysis.day_boundary: utc` of the config). */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Follows the events of the telemetry export until `stop()`; what it saw is in `events`. */
function watchExport(harness: PlayHarness): { events: EventEnvelope[]; stop: () => Promise<void> } {
  const controller = new AbortController();
  const events: EventEnvelope[] = [];
  const done = (async () => {
    for await (const event of harness.daemon.eventHub.follow({
      filter: { typePrefixes: ['telemetry.export'] },
      signal: controller.signal,
    })) {
      events.push(event);
    }
  })();
  return {
    events,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

/** The play's own ids in a row of `spans`, `metric_points` or `log_records`. */
interface Correlated {
  readonly scenario_id: string | null;
  readonly play_id: string | null;
  readonly attempt_id: string | null;
  readonly session_id: string | null;
}

describeWithLauncher('the acceptance of Phase 8, one play with everything on', () => {
  it(
    'the telemetry of a play: the base, the redaction, the ATIF, the export and the report agree',
    { timeout: 300_000 },
    async () => {
      // The client stamps its records with the real time and the report of a day only joins what
      // falls in it: a test that starts seconds before UTC midnight waits for the new day.
      const toMidnight = MS_PER_DAY - (Date.now() % MS_PER_DAY);
      if (toMidnight < 120_000) await sleep(toMidnight + 1_000);
      const startMs = Date.now();
      const playDay = utcDay(startMs);
      const clock = new MovingClock(startMs);
      const vault = new InMemorySecretVault();
      await vault.set(VAULT_PATH, new Secret(SECRET));
      const destination = await startDestination();
      await vault.set(DESTINATION_TOKEN, new Secret(`Bearer ${destination.receiver.token}`));
      const atifOut = process.env.OT_ATIF_OUT;
      const scratch = await mkdtemp(join(tmpdir(), 'otheater-phase8-'));
      let playId = '';
      let watched: ReturnType<typeof watchExport> | undefined;
      try {
        await withPlayDaemon(
          fakes(clock, vault),
          { extra: CONFIG(destination.receiver.url, join(scratch, 'atif')) },
          async (harness) => {
            const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
            const get = (path: string): Promise<Response> =>
              fetch(`${harness.daemon.api.url}${path}`, {
                headers: { authorization: `Bearer ${token}` },
              });
            const file = join(harness.dataDir, 'telemetry.sqlite');
            watched = watchExport(harness);

            // 1. The play: the secret is in the prompt and in the vault, the email in the client.
            const scenarioId = await harness.openChat();
            await harness.producer.send(
              scenarioId,
              `#ot-play write alpha and beta, key ${SECRET} #outcome:approved`,
            );
            const play = await waitFor(
              'the play',
              async () => (await harness.plays(scenarioId))[0],
            );
            playId = play.id;
            expect((await harness.daemon.store.plays.get(playId))?.need).toContain(SECRET);
            await waitFor(
              'DONE',
              async () => (await harness.daemon.store.plays.get(playId))?.state === 'DONE',
            );
            const attemptIds = new Set(
              (await harness.eventsOf(playId))
                .filter((event) => event.type === 'session.opened')
                .map((event) => event.attemptId ?? ''),
            );
            expect(attemptIds.size).toBeGreaterThanOrEqual(7);

            // 2. The base holds the daemon's tree (P4) and the client's records (P2, P3).
            const tables = await waitFor('the telemetry in the base', () => {
              const read = readTables(file);
              const spans = read.spans ?? [];
              const clientAttempts = new Set(
                spans
                  .filter((row) => row.name === CLIENT_SPAN && row.play_id === playId)
                  .map((row) => String(row.attempt_id)),
              );
              const done = spans.some(
                (row) => row.name === SPAN_NAME.play && row.play_id === playId,
              );
              const logged = new Set((read.log_records ?? []).map((row) => String(row.attempt_id)));
              return Promise.resolve(
                done && [...attemptIds].every((id) => clientAttempts.has(id) && logged.has(id))
                  ? read
                  : undefined,
              );
            });
            const spans = tables.spans as unknown as (Correlated & {
              name: string;
              trace_id: string;
              span_id: string;
              parent_span_id: string | null;
            })[];
            const ofPlay = spans.filter((row) => row.play_id === playId);
            const daemonSpans = ofPlay.filter((row) => row.name !== CLIENT_SPAN);
            const clientSpans = ofPlay.filter((row) => row.name === CLIENT_SPAN);

            // The daemon's tree: one trace for the play, one root, every parent in the trace.
            expect(new Set(daemonSpans.map((row) => row.trace_id))).toEqual(
              new Set([traceIdForPlay(playId)]),
            );
            const root = daemonSpans.filter((row) => row.parent_span_id === null);
            expect(root.map((row) => row.name)).toEqual([SPAN_NAME.play]);
            const ids = new Set(daemonSpans.map((row) => row.span_id));
            for (const row of daemonSpans) {
              if (row.parent_span_id !== null) expect(ids.has(row.parent_span_id)).toBe(true);
            }
            const attemptSpans = daemonSpans.filter((row) => row.name.startsWith('invoke_agent'));
            expect(new Set(attemptSpans.map((row) => row.attempt_id))).toEqual(attemptIds);

            // The client's records carry the same ids as the daemon's spans of their attempt.
            expect(new Set(clientSpans.map((row) => row.attempt_id))).toEqual(attemptIds);
            const scenarios = new Set(
              [...daemonSpans, ...clientSpans].map((row) => row.scenario_id),
            );
            expect(
              scenarios,
              asJson(
                [...daemonSpans, ...clientSpans]
                  .filter((r) => r.scenario_id === null)
                  .map((r) => r.name),
              ),
            ).toEqual(new Set([scenarioId]));
            for (const row of clientSpans) {
              expect(row.session_id, 'the session of a client span').not.toBeNull();
            }
            const metrics = (
              tables.metric_points as unknown as (Correlated & { name: string })[]
            ).filter((row) => row.play_id === playId);
            expect(metrics.length).toBeGreaterThan(0);
            for (const row of metrics) {
              expect(row.name).toBe('fake_agent.token.usage');
              expect(attemptIds.has(String(row.attempt_id))).toBe(true);
              expect(row.session_id).not.toBeNull();
            }
            const logs = (tables.log_records as unknown as Correlated[]).filter(
              (row) => row.play_id === playId,
            );
            expect(logs.length).toBeGreaterThan(0);
            for (const row of logs) expect(attemptIds.has(String(row.attempt_id))).toBe(true);
            // Nothing the client sent arrived without the play, except the Director's own attempt.
            for (const row of [...(tables.spans ?? []), ...(tables.metric_points ?? [])]) {
              expect(row.scenario_id, 'every row has its scenario').toBe(scenarioId);
            }

            // 3. The API: the tree of the play and the state of the telemetry (P10).
            const tree = PlaySpansSchema.parse(
              await (await get(`/v1/plays/${playId}/spans`)).json(),
            );
            expect(tree.playClosed).toBe(true);
            expect(tree.spans[0]).toMatchObject({ kind: 'play', parentSpanId: null });
            const status = TelemetryStatusSchema.parse(await (await get('/v1/telemetry')).json());
            expect(status.state).toBe('on');
            expect(status.receiver?.accepted.traces).toBeGreaterThanOrEqual(attemptIds.size);
            expect(status.receiver?.accepted.metrics).toBeGreaterThanOrEqual(1);
            expect(status.receiver?.accepted.logs).toBeGreaterThanOrEqual(1);
            expect(status.receiver?.rejected).toEqual({ format: 0, size: 0, token: 0 });
            expect(status.base?.state).toBe('ok');
            expect(status.export.mode).toBe('both');
            expect(status.export.prometheus).toBe(true);
            expect(status.export.otlp).not.toBeNull();

            // 4. /metrics answers in the Prometheus text format, behind the same token.
            const metricsResponse = await get('/metrics');
            expect(metricsResponse.status).toBe(200);
            const text = await metricsResponse.text();
            expect(text).toContain('# TYPE otheater_attempts_total counter');
            expect(text).toMatch(
              /otheater_attempts_total\{executor="[^"]+",role="[^"]+",outcome="/u,
            );
            expect(
              (await fetch(`${harness.daemon.api.url}/metrics`)).status,
              'no token, no metrics',
            ).toBe(401);

            // 5. The ATIF of the play: the schema (P5), no secret, and files for Harbor (P6).
            const config = parseConfig(CONFIG(destination.receiver.url, join(scratch, 'atif')));
            const exporter = new AtifExporter({
              store: harness.daemon.store,
              clock: harness.daemon.clock,
              vault,
              version: '0.0.0-test',
              dataDir: harness.dataDir,
              settings: () => config.atif.export,
              pricing: () => usageSettingsOf(config).pricing,
              situations: { record: () => undefined } as never,
            });
            for (const content of ['full', 'redacted'] as const) {
              const dir =
                atifOut === undefined || atifOut === ''
                  ? join(scratch, `atif-${content}`)
                  : join(atifOut, 'valid', `phase8-acceptance-${content}`);
              await mkdir(dir, { recursive: true });
              const [written] = await exporter.export(playId, { on: 'manual', content, dir });
              const body = await readFile(written?.path ?? '', 'utf8');
              const parsed = AtifTrajectorySchema.safeParse(JSON.parse(body));
              expect(parsed.success, `the ATIF (${content}) passes the schema`).toBe(true);
              expect(body).not.toContain(SECRET);
              expect(body).not.toContain(EMAIL);
              expect(written?.attempts).toBe(attemptIds.size);
            }

            // 6. The day is over: the analysis builds it (P9) and the report has it.
            expect(Date.now() - startMs, 'the play stayed in its day').toBeLessThan(
              MS_PER_DAY - (startMs % MS_PER_DAY),
            );
            const endOfDay = (Math.floor(startMs / MS_PER_DAY) + 1) * MS_PER_DAY;
            await clock.advance(endOfDay - clock.now() + 60_000);
            const report = await waitFor('the day in the report', async () => {
              const response = await get(`/v1/analysis?from=${playDay}&to=${playDay}&groupBy=role`);
              if (response.status !== 200) return undefined;
              const parsed = AnalysisReportSchema.parse(await response.json());
              return parsed.readyThrough === playDay ? parsed : undefined;
            });
            expect(report.missingDays).toBe(0);
            expect(report.period.summary.attempts.total).toBeGreaterThanOrEqual(attemptIds.size);
            expect(report.period.summary.coverage.attemptsWithClientTelemetry).toBeGreaterThan(0);
            expect(report.groups.length).toBeGreaterThan(1);

            // 7. P8: the purge ran with the day built and removed nothing of a day that is not
            //    older than `telemetry.retention.days`; the aggregates are in the base.
            const after = readTables(file);
            expect((after.rollups_daily ?? []).length).toBeGreaterThan(0);
            expect((after.spans ?? []).some((row) => row.play_id === playId)).toBe(true);

            // 8. No personal data in any row of any table (the daily aggregates included).
            for (const [table, rows] of Object.entries(after)) {
              const dump = asJson(rows);
              expect(dump, `the secret in ${table}`).not.toContain(SECRET);
              expect(dump, `the email in ${table}`).not.toContain(EMAIL);
            }
            // The redaction left a trace of what it removed, instead of silence.
            expect(asJson(after.metric_points)).toContain('resource:user.email');
          },
        );

        await watched?.stop();
        expect(watched?.events).toEqual([]);
        // 9. The daemon stopped, so its last pass sent what the clock never let the interval send.
        const sent = await destination.store.readSpans();
        const trace = sent.filter((span) => span.traceId === traceIdForPlay(playId));
        expect(trace.some((span) => span.name === SPAN_NAME.play)).toBe(true);
        expect(trace.some((span) => span.name === SPAN_NAME.stage)).toBe(true);
        const everything = asJson([
          sent,
          await destination.store.readMetrics(),
          await destination.store.readLogs(),
        ]);
        expect(everything).not.toContain(SECRET);
        expect(everything).not.toContain(EMAIL);
      } finally {
        await destination.receiver.stop();
        await rm(scratch, { recursive: true, force: true });
      }
    },
  );
});
