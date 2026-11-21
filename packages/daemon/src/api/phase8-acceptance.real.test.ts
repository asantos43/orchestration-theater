// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  Secret,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessLauncher,
} from '@otheater/core';
import { ApiClient } from '@otheater/client';
import {
  API_ROUTES,
  AnalysisReportSchema,
  AtifTrajectorySchema,
  TelemetryStatusSchema,
  type ApiSseMessage,
  type ChatServerMessage,
} from '@otheater/protocol';
import { FakeCodeHost, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, realClientFlags, testGit } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { AtifExporter } from '../atif/atif-exporter.js';
import { defaultLauncher, productionClients } from '../compose.js';
import { CLIENT_IDS, LIMIT_PRESET_NAMES, parseConfig, type ClientId } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { RealHeadCodeHost, waitFor } from '../orchestration/e2e-fixture.js';
import { dataPaths, profileDirOf, type ProfileNames } from '../paths.js';
import { Redactor } from '../telemetry/redaction.js';
import { TelemetryReceiver } from '../telemetry/receiver.js';
import { TelemetrySessions } from '../telemetry/sessions.js';
import { SPAN_NAME } from '../telemetry/span-conventions.js';
import { traceIdForPlay } from '../telemetry/span-ids.js';
import { MemoryTelemetryStore } from '../telemetry/telemetry-fixture.js';
import { usageSettingsOf } from '../usage/index.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeWorkspaceRig } from '../workspace/workspace-fixture.js';

/**
 * The acceptance of Phase 8 at the REAL level (P13 of docs/19) [proposta]: one play with a real
 * client (Claude Code, a small model) in every role, with `telemetry.export: both` and the OTLP
 * receiver of the daemon on, then the criteria of the phase over what the client really sent. Nothing
 * here runs by default: a plain `pnpm test` skips the file, so no client is started and no quota is
 * spent.
 *
 * Needs `OT_TEST_REAL_CLIENTS=1`, `OT_TEST_REAL_PROMPTS=1` and `OT_TEST_REAL_PHASE8=1`, and, for each
 * client, `OT_TEST_<CLAUDE|CODEX|OPENCODE>_PROFILE_DIR` (a profile already logged in, only pointed
 * at: nothing here reads or copies a credential file) and `_MODEL` (and, optional, `_MODE`).
 * Optional:
 * - `OT_TEST_PHASE8_CLIENTS`: a comma-separated list of `claude-code`, `codex` and `opencode`, one play
 *   each. Default `claude-code` (the other two are off unless named);
 * - `OT_TEST_PHASE8_TRACES=off`: do not ask Claude Code for its traces (the enhanced telemetry beta,
 *   `telemetry.clients.claude-code.traces`); without it the test requires client spans too;
 * - `OT_TEST_PHASE8_TELEMETRY_WAIT_MS`: how long, after the play ends, the records of the client
 *   may still take to reach the base (default 3 minutes: the clients flush on a timer or on exit);
 * - `OT_TEST_PHASE8_EDIT_RULES=1`: the test-only rule of N180 that lets Codex and OpenCode edit
 *   inside the worktree (as `OT_TEST_PHASE6_EDIT_RULES` of the Phase 6 level);
 * - `OT_TEST_PLAY_TIMEOUT_MS` (default 25 minutes), `OT_TEST_PLAY_LIMITS` (default `moderate`) and
 *   `OT_TEST_SANDBOX_EXTRA_DOMAINS` (for the provider of OpenCode).
 *
 * What it requires (about what arrived, not about what the model wrote):
 * - the play reaches DONE, and the tree of the daemon (P4) is in `telemetry.sqlite`: one
 *   `otheater.play`, stages and one `invoke_agent` span per attempt;
 * - the records of the client (metrics and logs, and spans with the traces on) are in the base with
 *   the same correlation (scenario, play, attempt and session) as the daemon's attempts (P2, P3);
 * - the email of the account appears in no table of `telemetry.sqlite` and in no ATIF of the play. The
 *   email is what the client itself reports (`claude auth status --json` run with the pointed
 *   profile, for Claude Code): no credential file is read, and it is never printed, logged or
 *   written, only "present" or "absent". For a client with no such command, or when the answer
 *   has no email, the test says so and falls back to a scan for any email-shaped text;
 * - the ATIF of the play (full and redacted) passes the schema (P5);
 * - `GET /metrics` answers in the Prometheus format and the OTLP destination (a receiver of the test,
 *   on loopback) holds the trace of the play (P7); `GET /v1/telemetry` shows the receiver (P10);
 * - the analysis report has the day of the play (P9). The real clock cannot pass midnight in a
 *   test, so the test asks the service to build the day (`aggregateDay`, which the schedule never
 *   does for today), and the report is read for it.
 * The criteria end with no process of the test alive after the daemon stops.
 * [N] Not run when written: the owner runs it. The shape of `claude auth status --json` and what
 * each client puts in its telemetry are not confirmed.
 */

const flags = realClientFlags();
const phase8Flag = process.env.OT_TEST_REAL_PHASE8 === '1';
const supported = process.platform !== 'win32';
const ENV_PREFIX: Readonly<Record<ClientId, string>> = {
  'claude-code': 'OT_TEST_CLAUDE',
  codex: 'OT_TEST_CODEX',
  opencode: 'OT_TEST_OPENCODE',
};

function clientsOfTheRun(): readonly ClientId[] {
  const raw = (process.env.OT_TEST_PHASE8_CLIENTS ?? '').trim();
  if (raw === '') return ['claude-code'];
  const list = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const name of list) {
    if (!(CLIENT_IDS as readonly string[]).includes(name)) {
      throw new Error(`OT_TEST_PHASE8_CLIENTS: "${name}" is not one of ${CLIENT_IDS.join(', ')}`);
    }
  }
  return [...new Set(list)] as ClientId[];
}

const CLIENTS = phase8Flag ? clientsOfTheRun() : [];
const TRACES = process.env.OT_TEST_PHASE8_TRACES !== 'off';
const EDIT_RULES = process.env.OT_TEST_PHASE8_EDIT_RULES === '1';
const EDIT_RULES_YAML = ['actor', 'consultant']
  .map(
    (role) =>
      `  ${role}:\n    policy:\n      on_ask: rules\n      rules:\n        - { id: edit-in-worktree, action: allow, kind: edit, path: "**" }\n`,
  )
  .join('');
const EXTRA_DOMAINS = (process.env.OT_TEST_SANDBOX_EXTRA_DOMAINS ?? '')
  .split(',')
  .map((domain) => domain.trim())
  .filter((domain) => domain !== '');
const ready = flags.clients && flags.prompts && phase8Flag && supported;

const DEFAULT_TIMEOUT_MS = 25 * 60_000;
const DEFAULT_TELEMETRY_WAIT_MS = 3 * 60_000;
const TEARDOWN_MARGIN_MS = 3 * 60_000;
const ANSWER_FALLBACK = 'Use your best judgment and keep it as small as possible.';
const NO_PLAY_GRACE_MS = 90_000;
const DESTINATION_TOKEN_KEY = 'otlp/destination-token';
const WANTED_FILES = ['src/slugify.js', 'src/slugify.test.js'] as const;
const NEED = [
  'Add to this project a function slugify(text) that turns a text into a URL slug:',
  'lower case, accents removed, every run of characters that are not letters or digits becomes',
  'one hyphen, and no hyphen at the start or at the end.',
  `Put the function, exported by name, in ${WANTED_FILES[0]} (an ES module) and its tests in`,
  `${WANTED_FILES[1]}, written with the node:test module and node:assert/strict.`,
  'The project has no dependencies and nothing to install: the check is the command',
  '"node --test" run in the root of the project, and it must pass.',
  'This is the whole need: do not ask me anything else, and do not touch other files.',
].join(' ');
/** Text that looks like an email address (a TLD of letters, so `name@1.2.3` is not one). */
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
/** Account variables of Claude Code that would win over the login of the pointed profile. */
const ACCOUNT_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

const execFileAsync = promisify(execFile);

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60_000) {
    throw new Error(`${name} must be an integer of at least 60000, got "${raw}"`);
  }
  return value;
}

function limitsPreset(): string {
  const raw = process.env.OT_TEST_PLAY_LIMITS;
  if (raw === undefined || raw === '') return 'moderate';
  if (!(LIMIT_PRESET_NAMES as readonly string[]).includes(raw)) {
    throw new Error(
      `OT_TEST_PLAY_LIMITS must be one of ${LIMIT_PRESET_NAMES.join(', ')}, got "${raw}"`,
    );
  }
  return raw;
}

function log(text: string): void {
  // `console.log` of a passing test is hidden by vitest; stderr is not.
  process.stderr.write(`[phase8-real] ${text}\n`);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recording(inner: ProcessLauncher): { launcher: ProcessLauncher; pids: number[] } {
  const pids: number[] = [];
  const launcher: ProcessLauncher = {
    id: inner.id,
    implements: inner.implements,
    capabilities: () => inner.capabilities(),
    launch: async (options: LaunchOptions): Promise<LaunchedProcess> => {
      const process = await inner.launch(options);
      pids.push(process.pid);
      return process;
    },
  };
  return { launcher, pids };
}

/** The `YYYY-MM-DD` of an instant, UTC (the `analysis.day_boundary: utc` of the config below). */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The email-shaped strings of a text, lower-cased and without repeats. */
function emailsIn(text: string): string[] {
  return [...new Set((text.match(EMAIL_SHAPE) ?? []).map((email) => email.toLowerCase()))];
}

/**
 * The emails the client itself reports for the account of the pointed profile. Claude Code only:
 * `claude auth status --json`, run the way the login probe of the adapter runs it (the profile in
 * `CLAUDE_CONFIG_DIR`). The answer is scanned for email-shaped text, whatever its shape (it is not
 * confirmed), and never printed or kept beyond this process. Nothing is read from the credential
 * files of the profile: the client does that. `[]` when the client has no such command or says none.
 */
async function emailsReportedBy(client: ClientId, profileDir: string): Promise<string[]> {
  if (client !== 'claude-code') return [];
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !ACCOUNT_ENV.includes(name)),
    ),
    CLAUDE_CONFIG_DIR: profileDir,
  };
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status', '--json'], {
      env,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return emailsIn(stdout);
  } catch {
    return [];
  }
}

type Row = Record<string, unknown>;

/** Every row of every table of the telemetry file, as the file is (the daemon keeps it open). */
function readTables(file: string): Record<string, Row[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const tables: Record<string, Row[]> = {};
    for (const { name } of names) tables[name] = db.prepare(`SELECT * FROM "${name}"`).all();
    return tables;
  } finally {
    db.close();
  }
}

/** The ids of the resources the daemon itself wrote (`service.name` `otheater`); the rest is the client's. */
function daemonResourceIds(resources: Row[]): Set<unknown> {
  return new Set(
    resources
      .filter((row) => {
        try {
          return (
            (JSON.parse(String(row.attributes)) as Record<string, unknown>)['service.name'] ===
            'otheater'
          );
        } catch {
          return false;
        }
      })
      .map((row) => row.id),
  );
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

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

afterAll(disposeTestGitIsolation);

describe.skipIf(!ready)(
  'a real play with the whole telemetry on (OT_TEST_REAL_CLIENTS=1, OT_TEST_REAL_PROMPTS=1, OT_TEST_REAL_PHASE8=1)',
  () => {
    const limitMs = ready
      ? envMs('OT_TEST_PLAY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    const waitMs = ready
      ? envMs('OT_TEST_PHASE8_TELEMETRY_WAIT_MS', DEFAULT_TELEMETRY_WAIT_MS)
      : DEFAULT_TELEMETRY_WAIT_MS;

    for (const executor of CLIENTS) {
      it(
        `${executor}: the telemetry of the client and of the daemon agree, no personal data, report with the day`,
        async () => {
          const prefix = ENV_PREFIX[executor];
          const profileDirEnv = process.env[`${prefix}_PROFILE_DIR`] ?? '';
          const model = process.env[`${prefix}_MODEL`] ?? '';
          const mode = process.env[`${prefix}_MODE`];
          if (profileDirEnv === '' || model === '') {
            throw new Error(`${prefix}_PROFILE_DIR and ${prefix}_MODEL are needed for ${executor}`);
          }
          const tmp = await makeTempDataDir();
          const scratch = await mkdtemp(join(tmpdir(), 'otheater-phase8-real-'));
          const real = defaultLauncher();
          if (real === undefined) throw new Error('this platform has no process launcher');
          const { launcher, pids } = recording(real);
          log(`client: ${executor}, model: ${model}, traces: ${TRACES ? 'on' : 'off'}`);

          // What the client says about the account, before anything else, in this process only.
          const profileSource = await realpath(profileDirEnv);
          const accountEmails = await emailsReportedBy(executor, profileSource);
          log(
            `the client reports the email of the account: ${accountEmails.length > 0 ? 'yes' : 'no (the scan for any email-shaped text takes its place)'}`,
          );

          const vault = new InMemorySecretVault();
          const destination = await startDestination();
          await vault.set(
            DESTINATION_TOKEN_KEY,
            new Secret(`Bearer ${destination.receiver.token}`),
          );
          const config = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
limits:
  preset: ${limitsPreset()}
${EXTRA_DOMAINS.length === 0 ? '' : `sandbox:\n  extra_domains: ${json(EXTRA_DOMAINS)}\n`}${EDIT_RULES ? `roles:\n${EDIT_RULES_YAML}` : ''}analysis:
  day_boundary: utc
telemetry:
  export: both
  otlp:
    endpoint: ${destination.receiver.url}
    headers:
      Authorization: ${DESTINATION_TOKEN_KEY}
${executor === 'claude-code' && TRACES ? '  clients:\n    claude-code:\n      traces: on\n' : ''}orchestration:
  executor:
    client: ${executor}
    profile: real
    model: ${json(model)}
${mode === undefined || mode === '' ? '' : `    mode: ${json(mode)}\n`}`);
          // The profile is the owner's logged-in one, pointed at (never copied), as in the Phase 6 level.
          const profileDir = (ref: ProfileNames): string =>
            ref.client === executor && ref.profile === 'real'
              ? profileSource
              : profileDirOf(dataPaths(tmp.dir), ref);

          const fakeHost = new FakeCodeHost();
          const codeHost = new RealHeadCodeHost(fakeHost);
          const daemon = await startDaemon({
            dataDir: tmp.dir,
            config,
            overrides: { vault, launcher, codeHost, profileDir },
            clients: productionClients(config),
            logger: createSilentLogger(),
            version: '0.0.0-test',
          });
          const rig = await makeWorkspaceRig({ store: daemon.store, codeHost });
          await writeFile(
            join(rig.repo, 'package.json'),
            `${JSON.stringify({ name: 'tiny-project', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
          );
          await testGit(rig.repo, 'add', '-A');
          await testGit(rig.repo, 'commit', '--quiet', '-m', 'the tiny project');
          await testGit(rig.repo, 'push', '--quiet', 'origin', 'main');
          fakeHost.seedRemote(rig.repo, 'main');

          const started = Date.now();
          const received: ApiSseMessage[] = [];
          let replies = 0;
          let failure: unknown;
          let stopFailure: unknown;
          let survivors: number[];
          const token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
          const client = new ApiClient({ url: daemon.api.url, token });
          const get = (path: string): Promise<Response> =>
            fetch(`${daemon.api.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
          const file = join(tmp.dir, 'telemetry.sqlite');
          let scenarioId: string | undefined;
          let playId: string | undefined;
          const stream = client.events({ since: 0 });
          stream.onMessage((message) => received.push(message));
          stream.start();
          let chat: ReturnType<ApiClient['chat']> | undefined;
          try {
            // 1. The play, driven as a screen would: the chat, the questions, the stream.
            const opened = await client.call(API_ROUTES.openScenario, { body: { repo: rig.repo } });
            scenarioId = opened.scenario.id;
            chat = client.chat(scenarioId, {});
            const answered = new Set<string>();
            chat.onMessage((frame: ChatServerMessage) => {
              if (frame.type === 'director_reply' && frame.final) replies += 1;
              if (frame.type === 'ask' && !answered.has(frame.decisionId)) {
                answered.add(frame.decisionId);
                const input = frame.input as { questions?: { options?: { label?: unknown }[] }[] };
                if (frame.kind === 'producer_question') {
                  const answers = (input.questions ?? []).map((question) => {
                    const first = question.options?.[0]?.label;
                    return typeof first === 'string' && first !== '' ? first : ANSWER_FALLBACK;
                  });
                  chat?.send({ type: 'answer', decisionId: frame.decisionId, answer: { answers } });
                } else {
                  // A menu is a limit that ran out: a failure of the run, so the play is cancelled.
                  chat?.send({
                    type: 'answer',
                    decisionId: frame.decisionId,
                    answer: { option: 'cancel', reason: 'the real test gave up' },
                  });
                }
              }
            });
            chat.start();
            await waitFor(
              'the chat to open',
              () => Promise.resolve(chat?.state === 'open' || undefined),
              60_000,
            );
            chat.send({ type: 'message', text: NEED });
            const finished = (): boolean =>
              received.some(
                (message) =>
                  message.data.type === 'play.transitioned' &&
                  ['DONE', 'CANCELLED', 'FAILED'].includes(
                    String((message.data.payload as { to?: unknown }).to),
                  ),
              );
            const { producer } = daemon;
            if (producer === undefined) throw new Error('the daemon has no Producer channel');
            const deadline = started + limitMs;
            let idleSince: number | undefined;
            while (!finished()) {
              if (Date.now() > deadline) throw new Error('Timed out waiting for the play to end');
              const state = await producer.state(scenarioId);
              const plays = await daemon.store.plays.list({ scenarioId });
              const waiting =
                plays.length === 0 && replies > 0 && state.asks.length === 0 && !state.busy;
              if (!waiting) {
                idleSince = undefined;
              } else {
                idleSince ??= Date.now();
                if (Date.now() - idleSince >= NO_PLAY_GRACE_MS) {
                  throw new Error('the Director answered without opening a play');
                }
              }
              await new Promise((resolve) => setTimeout(resolve, 2_000));
            }
            playId = received.find((message) => message.data.type === 'play.created')?.data.playId;
            if (playId === undefined) throw new Error('the stream never showed play.created');
            const path = received
              .filter((message) => message.data.type === 'play.transitioned')
              .map((message) => String((message.data.payload as { to?: unknown }).to));
            expect(path.at(-1), `the play must reach DONE (path: ${path.join(' > ')})`).toBe(
              'DONE',
            );
            log(`play ${playId}: ${path.join(' > ')} in ${seconds(Date.now() - started)}`);
            const events = await daemon.store.events.readFrom(0, 1_000_000);
            const attemptIds = new Set(
              events
                .filter((event) => event.type === 'session.opened' && event.playId === playId)
                .map((event) => event.attemptId)
                .filter((id): id is string => id !== undefined),
            );
            expect(attemptIds.size, 'the play opened sessions').toBeGreaterThan(0);

            // 2. The base: the tree of the daemon and the records of the client, with the same
            //    correlation. The client flushes on a timer or on exit, so the base is polled.
            const tables = await waitFor(
              `the telemetry of ${executor} in the base (up to ${seconds(waitMs)})`,
              () => {
                const read = readTables(file);
                const own = daemonResourceIds(read.resources ?? []);
                const ofPlay = (rows: Row[] | undefined): Row[] =>
                  (rows ?? []).filter((row) => row.play_id === playId && !own.has(row.resource_id));
                const have =
                  (read.spans ?? []).some(
                    (row) => row.name === SPAN_NAME.play && row.play_id === playId,
                  ) &&
                  ofPlay(read.metric_points).length > 0 &&
                  ofPlay(read.log_records).length > 0 &&
                  (executor !== 'claude-code' || !TRACES || ofPlay(read.spans).length > 0);
                return Promise.resolve(have ? read : undefined);
              },
              waitMs,
            );
            const own = daemonResourceIds(tables.resources ?? []);
            const daemonSpans = (tables.spans ?? []).filter(
              (row) => row.play_id === playId && own.has(row.resource_id),
            );
            expect(daemonSpans.filter((row) => row.name === SPAN_NAME.play)).toHaveLength(1);
            expect(daemonSpans.some((row) => row.name === SPAN_NAME.stage)).toBe(true);
            const attemptSpans = daemonSpans.filter((row) =>
              String(row.name).startsWith('invoke_agent'),
            );
            expect(new Set(attemptSpans.map((row) => row.attempt_id))).toEqual(attemptIds);
            const clientRows = (rows: Row[] | undefined): Row[] =>
              (rows ?? []).filter((row) => row.play_id === playId && !own.has(row.resource_id));
            const clientSpans = clientRows(tables.spans);
            const clientMetrics = clientRows(tables.metric_points);
            const clientLogs = clientRows(tables.log_records);
            log(
              `base: daemon spans ${String(daemonSpans.length)}; client spans ${String(clientSpans.length)}, metrics ${String(clientMetrics.length)}, logs ${String(clientLogs.length)}`,
            );
            for (const row of [...clientSpans, ...clientMetrics, ...clientLogs]) {
              expect(row.scenario_id, 'the scenario of a client record').toBe(scenarioId);
              expect(attemptIds.has(String(row.attempt_id)), 'the attempt of a client record').toBe(
                true,
              );
              expect(row.session_id, 'the session of a client record').not.toBeNull();
            }
            expect(clientMetrics.length + clientLogs.length).toBeGreaterThan(0);
            if (executor === 'claude-code' && TRACES) expect(clientSpans.length).toBeGreaterThan(0);

            // 3. No personal data: the email of the account is in no table (nor the analysis
            //    rollups, read again below) and the scan for email-shaped text finds what is left.
            const dump = json(tables).toLowerCase();
            const inTables = accountEmails.some((email) => dump.includes(email));
            const shapedInTables = emailsIn(dump);
            log(
              `the email of the account in the tables of telemetry.sqlite: ${inTables ? 'PRESENT' : 'absent'}`,
            );
            log(`email-shaped texts in the tables: ${String(shapedInTables.length)}`);
            expect(inTables, 'the email of the account must be in no table').toBe(false);
            if (accountEmails.length === 0) {
              expect(
                shapedInTables,
                'no email-shaped text without a known email to compare',
              ).toEqual([]);
            }

            // 4. The ATIF of the play, in both contents: the schema, and no email.
            const exporter = new AtifExporter({
              store: daemon.store,
              clock: daemon.clock,
              vault,
              version: '0.0.0-test',
              dataDir: tmp.dir,
              settings: () => config.atif.export,
              pricing: () => usageSettingsOf(config).pricing,
              situations: { record: () => undefined } as never,
            });
            let emailInAtif = false;
            const shapedInAtif = new Set<string>();
            for (const content of ['full', 'redacted'] as const) {
              const dir = join(scratch, `atif-${content}`);
              await mkdir(dir, { recursive: true });
              const [written] = await exporter.export(playId, { on: 'manual', content, dir });
              const body = await readFile(written?.path ?? '', 'utf8');
              expect(
                AtifTrajectorySchema.safeParse(JSON.parse(body)).success,
                `the ATIF (${content}) passes the schema`,
              ).toBe(true);
              if (accountEmails.some((email) => body.toLowerCase().includes(email)))
                emailInAtif = true;
              for (const email of emailsIn(body)) shapedInAtif.add(email);
            }
            log(`the email of the account in the ATIF: ${emailInAtif ? 'PRESENT' : 'absent'}`);
            expect(emailInAtif, 'the email of the account must be in no ATIF').toBe(false);
            if (accountEmails.length === 0) expect([...shapedInAtif]).toEqual([]);

            // 5. The API: /metrics (P7), the state of the telemetry (P10).
            const metricsResponse = await get('/metrics');
            expect(metricsResponse.status).toBe(200);
            expect(await metricsResponse.text()).toContain(
              '# TYPE otheater_attempts_total counter',
            );
            const status = TelemetryStatusSchema.parse(await (await get('/v1/telemetry')).json());
            expect(status.receiver?.accepted.metrics).toBeGreaterThanOrEqual(1);
            expect(status.receiver?.rejected).toEqual({ format: 0, size: 0, token: 0 });
            expect(status.export.mode).toBe('both');

            // 6. The analysis (P9): the real clock cannot pass midnight, so the service builds the
            //    day(s) of the play (the schedule never builds today) and the report is read for them.
            const { analysis } = daemon;
            if (analysis === undefined) throw new Error('the daemon has no analysis service');
            const firstDay = utcDay(started);
            const lastDay = analysis.today();
            for (const day of firstDay === lastDay ? [firstDay] : [firstDay, lastDay]) {
              await analysis.aggregateDay(day);
            }
            const report = AnalysisReportSchema.parse(
              await (await get(`/v1/analysis?from=${firstDay}&to=${lastDay}&groupBy=role`)).json(),
            );
            expect(report.period.summary.attempts.total).toBeGreaterThanOrEqual(attemptIds.size);
            expect(report.period.summary.coverage.attemptsWithClientTelemetry).toBeGreaterThan(0);
            log(
              `analysis ${firstDay} to ${lastDay}: attempts ${String(report.period.summary.attempts.total)}, with client telemetry ${String(report.period.summary.coverage.attemptsWithClientTelemetry)}, groups ${String(report.groups.length)}`,
            );
            const rollups = readTables(file).rollups_daily ?? [];
            expect(rollups.length).toBeGreaterThan(0);
            if (accountEmails.some((email) => json(rollups).toLowerCase().includes(email))) {
              throw new Error('the email of the account is in rollups_daily');
            }
          } catch (error) {
            failure = error;
          } finally {
            chat?.close();
            stream.close();
            await rig.dispose();
            try {
              await daemon.stop();
            } catch (error) {
              stopFailure = error;
              log(`the daemon did not stop clean: ${String(error)}`);
            }
            await tmp.dispose();
            survivors = await waitFor(
              'the processes of the clients to exit',
              () => Promise.resolve(pids.some(alive) ? undefined : []),
              15_000,
            ).catch(() => pids.filter(alive));
            log(
              `processes started: ${String(pids.length)}; left alive: ${String(survivors.length)}`,
            );
          }
          // 7. The daemon stopped: its last pass sent what the interval had not (P7).
          try {
            if (failure === undefined && playId !== undefined) {
              const sent = await destination.store.readSpans();
              const trace = sent.filter((span) => span.traceId === traceIdForPlay(playId));
              log(`the OTLP destination holds ${String(trace.length)} spans of the play`);
              expect(trace.some((span) => span.name === SPAN_NAME.play)).toBe(true);
              const everything = json([
                sent,
                await destination.store.readMetrics(),
                await destination.store.readLogs(),
              ]).toLowerCase();
              expect(
                accountEmails.some((email) => everything.includes(email)),
                'the email of the account must not reach the destination',
              ).toBe(false);
            }
          } catch (error) {
            failure = error;
          } finally {
            await destination.receiver.stop();
            await rm(scratch, { recursive: true, force: true });
          }
          if (stopFailure !== undefined) {
            failure ??= new Error('the daemon did not stop clean', { cause: stopFailure });
          }
          if (failure !== undefined) {
            throw failure instanceof Error
              ? failure
              : new Error('the phase 8 run failed', { cause: failure });
          }
          expect(pids.length).toBeGreaterThan(0);
          expect(survivors).toEqual([]);
        },
        limitMs + waitMs + TEARDOWN_MARGIN_MS,
      );
    }
  },
);
