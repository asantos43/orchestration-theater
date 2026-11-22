// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  otelBaseEnv,
  type Clock,
  type ClientOtel,
  type LaunchOptions,
  type OtelLaunch,
  type Profile,
  type ProcessLauncher,
} from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { PlaySpansSchema } from '@otheater/protocol';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { main } from './cli.js';
import { describeWithLauncher } from './launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayFakes,
} from './orchestration/e2e-fixture.js';
import { dataPaths } from './paths.js';
import { isolatedEnv } from './plugins/plugin-fixture.js';
import { FIXTURE_SERVER_PATH } from './plugins/test-plugin-fixture.js';
import { captureLogger } from './test-helpers.js';
import { SPAN_NAME } from './telemetry/span-conventions.js';
import { sessionSpanId, traceIdForPlay } from './telemetry/span-ids.js';

/**
 * Phase 9, P13, the automatic acceptance: ONE daemon with the fake agent in every role and two
 * plugins installed in the project through the CLI (the example `notes` of P9, built as it ships,
 * and a plugin with a secret, whose server is the test server). Nothing real runs: temporary HOME
 * and data folder, the fake agent, the vault in memory (never the keyring), loopback only. What it
 * holds together, step by step of the phase:
 * - P12: a flow of the configuration (`flows.<id>` and `scenario.flow`) runs the play to the
 *   delivery;
 * - P1: the spans the client exported are in the trace of the play, under the span of their
 *   session, so the play has one tree; P2: `GET /metrics` has the waits of the queue of prompts
 *   and counts the batches the receiver refused;
 * - P5/P6: the tool of a plugin is in the grant of the roles the manifest declares and in no other,
 *   a call outside the grant never reaches the plugin, and a tool that asks for approval waits for
 *   the Producer (an Allow runs it, a Deny does not);
 * - P7: the secret of a plugin reaches the process of its server and nothing else: no log line, no
 *   event, no answer of a route and no environment of an Executor holds it;
 * - P8: the event `plugin.notes.note_added` is in the log;
 * - P10: `GET /v1/plugins/:id/panel` answers the panel of the manifest (the tab of the TUI draws
 *   that same answer in `packages/tui/src/phase9-acceptance.e2e.test.tsx`).
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

/** The example plugin, as it is in the repository (its `dist` comes from `pnpm build`). */
const NOTES_DIR = fileURLToPath(new URL('../../../examples/plugin-notes', import.meta.url));

/** The value of the secret of the second plugin: it must be in no place but the plugin's process. */
const TOKEN = 'planted-plugin-token-5b9d41e07c';

/** The flow of the configuration the play runs: no review of the plan (P12). */
const CONFIG = `
flows:
  quick:
    version: 1
    description: no review of the plan
    steps:
      plan_review: { enabled: false }
scenario:
  flow: quick
telemetry:
  export: prometheus
  prometheus:
    cache_ttl: 1s
events:
  wait_threshold: always
`;

/** What a role that only reads, and a role that writes, have under their policy (the effects are read against it). */
const READER = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  network: { allow: [] },
} as const;
const WRITER = { ...READER, nativeTools: ['read', 'search', 'edit', 'write'] } as const;

/** The clock moving one millisecond at each reading, so the waits have a length and the times are coherent. */
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
}

/** The fake client exporting its telemetry to the receiver of the daemon, as the real ones do. */
class ExportingFake extends FakeClientAdapter {
  protected override otelLaunch(_profile: Profile, otel: ClientOtel): Promise<OtelLaunch> {
    return Promise.resolve({ env: otelBaseEnv(otel) });
  }
}

/** Every environment an Executor process was started with: the launcher the fake client uses records it. */
function recording(inner: ProcessLauncher, envs: Record<string, string>[]): ProcessLauncher {
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'launch') {
        return (options: LaunchOptions) => {
          envs.push({ ...options.env });
          return target.launch(options);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function fakes(
  startMs: number,
  vault: InMemorySecretVault,
  envs: Record<string, string>[],
): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new MovingClock(startMs),
    vault,
    client: (launcher, command, env) =>
      new ExportingFake({
        launcher: recording(launcher, envs),
        baseEnv: {},
        env,
        adapterVersion: '1.0.0',
        command,
      }),
  };
}

type Row = Record<string, unknown>;

/** Every row of the table of the telemetry file, read as the file is (the daemon keeps it open). */
function readTable(file: string, table: string): Row[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM "${table}"`).all();
  } finally {
    db.close();
  }
}

/** The value at a path of a JSON answer (`unknown` all the way: what a test checks it states). */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const step of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

/** What a test reads of an answer of the API. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

/** A value of a row read as text (the columns of the telemetry table are `unknown`). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The notes the example plugin keeps in the project folder. */
async function notesOf(projectDir: string): Promise<unknown[]> {
  const file = JSON.parse(await readFile(join(projectDir, '.plugin-notes.json'), 'utf8')) as {
    notes: unknown[];
  };
  return file.notes;
}

/** A line of `GET /metrics`, by the name of the family and the labels it must have. */
function sample(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  for (const row of text.split('\n')) {
    if (!row.startsWith(`${name}{`) && !row.startsWith(`${name} `)) continue;
    const found = Object.entries(labels).every(([key, value]) => row.includes(`${key}="${value}"`));
    if (found) return Number(row.slice(row.lastIndexOf(' ') + 1));
  }
  return undefined;
}

describeWithLauncher('the acceptance of Phase 9, one daemon with a flow and two plugins', () => {
  it(
    'the flow runs to the delivery with one tree of spans and the new metrics, and the plugins keep their roles, approval, secret, event and panel',
    { timeout: 300_000 },
    async () => {
      expect(
        existsSync(join(NOTES_DIR, 'dist/server.js')),
        'the example plugin is built: run "pnpm build" first',
      ).toBe(true);
      const startMs = Date.now();
      const vault = new InMemorySecretVault();
      const executorEnvs: Record<string, string>[] = [];
      const { logger, lines } = captureLogger();
      const work = await mkdtemp(join(tmpdir(), 'otheater-phase9-'));
      try {
        await withPlayDaemon(
          fakes(startMs, vault, executorEnvs),
          { extra: CONFIG, logger },
          async (harness) => {
            const { daemon, producer } = harness;
            const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
            const said: string[] = [];
            const answer = async (response: Response): Promise<Answer> => {
              const text = await response.text();
              said.push(text);
              return {
                status: response.status,
                text,
                body: text === '' || !text.startsWith('{') ? {} : (JSON.parse(text) as unknown),
              };
            };
            const get = async (path: string, bearer: string | null = token): Promise<Answer> =>
              await answer(
                await fetch(`${daemon.api.url}${path}`, {
                  headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
                }),
              );
            const post = async (path: string, body: unknown): Promise<Answer> =>
              await answer(
                await fetch(`${daemon.api.url}${path}`, {
                  method: 'POST',
                  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                  body: JSON.stringify(body),
                }),
              );
            const events = async (type?: string) =>
              (await daemon.store.events.readFrom(0, 100_000)).filter(
                (event) => type === undefined || event.type === type,
              );

            // The project is the scenario of the repository; the two plugins are installed in it
            // through the CLI of the data folder, as a person does, with the HOME in a temporary folder.
            const scenarioId = await harness.openChat();
            const projectDir = (await daemon.store.scenarios.get(scenarioId))?.folder ?? '';
            expect(projectDir).not.toBe('');
            const ot = async (input: string | undefined, ...argv: string[]): Promise<number> =>
              await main([...argv, '--data-dir', harness.dataDir], {
                env: isolatedEnv(work),
                platform: 'linux',
                homedir: work,
                cwd: work,
                out: () => undefined,
                err: () => undefined,
                systemLocale: 'en',
                version: '1.2.3',
                ...(input === undefined ? {} : { input: Readable.from([input]) }),
                overrides: { clock: daemon.clock, vault },
              });
            const vaulted = join(work, 'vaulted');
            await mkdir(vaulted, { recursive: true });
            await writeFile(
              join(vaulted, 'plugin.yaml'),
              [
                'manifest_version: 1',
                'id: vaulted',
                'version: 1.0.0',
                'server:',
                '  type: stdio',
                `  command: ${JSON.stringify([process.execPath, FIXTURE_SERVER_PATH])}`,
                'tools:',
                '  - name: env_report',
                '    roles: [actor]',
                '    effects: read',
                'secrets: [API_TOKEN]',
                '',
              ].join('\n'),
            );
            expect(await ot(undefined, 'plugin', 'install', NOTES_DIR)).toBe(0);
            expect(await ot(undefined, 'plugin', 'install', vaulted)).toBe(0);
            for (const id of ['notes', 'vaulted']) {
              expect(
                await ot(undefined, 'plugin', 'enable', id, '--project', scenarioId, '--yes'),
              ).toBe(0);
            }
            expect(
              await ot(
                `${TOKEN}\n`,
                'plugin',
                'secret',
                'set',
                'vaulted',
                'API_TOKEN',
                '--project',
                scenarioId,
              ),
            ).toBe(0);
            await vi.waitFor(() => {
              expect(
                daemon.plugins
                  .activeFor(scenarioId)
                  .map((plugin) => plugin.id)
                  .sort(),
              ).toEqual(['notes', 'vaulted']);
            });
            expect((await vault.get(`plugin/vaulted/${scenarioId}/API_TOKEN`))?.reveal()).toBe(
              TOKEN,
            );

            // 1. P12: the play of the flow of the configuration, to the delivery. The grants the
            //    attempts of this play get are recorded: they are what the real roles were handed.
            const grants: { role: string; pluginTools: readonly string[] | undefined }[] = [];
            const realGrant = daemon.mcp.grant.bind(daemon.mcp);
            vi.spyOn(daemon.mcp, 'grant').mockImplementation((input) => {
              grants.push({ role: input.role, pluginTools: input.pluginTools });
              return realGrant(input);
            });
            await harness.producer.send(
              scenarioId,
              '#ot-play write alpha and beta #outcome:approved',
            );
            const play = await waitFor(
              'the play',
              async () => (await harness.plays(scenarioId))[0],
            );
            const playId = play.id;
            await waitFor(
              'DONE',
              async () => (await daemon.store.plays.get(playId))?.state === 'DONE',
            );
            const path = await harness.pathOf(playId);
            expect(path).not.toContain('REVIEWING_PLAN');
            expect(path).toEqual(
              expect.arrayContaining(['PLANNING', 'SCRIPTING', 'EXECUTING', 'CRITIQUING']),
            );
            expect(path.at(-1)).toBe('DONE');
            expect(harness.codeHost.pullRequests()).toHaveLength(1);
            const { flow } = (
              (await daemon.store.plays.get(playId))?.snapshot as unknown as {
                context: { flow?: { id: string; skip: string[] } };
              }
            ).context;
            expect(flow).toMatchObject({ id: 'quick', skip: ['plan_review'] });

            // 2. P1: one tree. The client's spans are in the trace of the play, under the span of
            //    their session, and that span is the daemon's own.
            const file = join(harness.dataDir, 'telemetry.sqlite');
            const attemptIds = new Set(
              (await harness.eventsOf(playId))
                .filter((event) => event.type === 'session.opened')
                .map((event) => event.attemptId ?? ''),
            );
            const spans = await waitFor('the spans in the base', () => {
              const rows = readTable(file, 'spans').filter((row) => row.play_id === playId);
              const clients = new Set(
                rows
                  .filter((row) => row.name === 'fake_agent.turn')
                  .map((row) => String(row.attempt_id)),
              );
              const closed = rows.some((row) => row.name === SPAN_NAME.play);
              return Promise.resolve(
                closed && [...attemptIds].every((id) => clients.has(id)) ? rows : undefined,
              );
            });
            const trace = traceIdForPlay(playId);
            expect(
              new Set(spans.map((row) => row.trace_id)),
              'one trace for daemon and clients',
            ).toEqual(new Set([trace]));
            const ids = new Set(spans.map((row) => String(row.span_id)));
            const roots = spans.filter((row) => row.parent_span_id === null);
            expect(
              roots.map((row) => row.name),
              'one root',
            ).toEqual([SPAN_NAME.play]);
            for (const row of spans) {
              if (row.parent_span_id !== null) {
                expect(
                  ids.has(text(row.parent_span_id)),
                  `the parent of ${String(row.name)} is in the tree`,
                ).toBe(true);
              }
            }
            const clientSpans = spans.filter((row) => row.name === 'fake_agent.turn');
            expect(clientSpans.length).toBeGreaterThanOrEqual(attemptIds.size);
            for (const row of clientSpans) {
              expect(row.parent_span_id).toBe(sessionSpanId(String(row.session_id)));
            }
            const tree = PlaySpansSchema.parse((await get(`/v1/plays/${playId}/spans`)).body);
            expect(tree.playClosed).toBe(true);

            // 3. P2: the waits of the queue of prompts and the batches the receiver refused.
            const metrics = async (): Promise<string> => {
              const response = await get('/metrics');
              expect(response.status).toBe(200);
              return response.text;
            };
            const before = await metrics();
            expect(before).toContain('# TYPE otheater_waits_active gauge');
            expect(before).toContain('# TYPE otheater_waits_total counter');
            expect(before).toContain('# TYPE otheater_wait_seconds_total counter');
            expect(
              sample(before, 'otheater_waits_total', {
                kind: 'prompt_queue',
                outcome: 'delivered',
              }),
            ).toBeGreaterThanOrEqual(1);
            expect(
              sample(before, 'otheater_wait_seconds_total', { kind: 'prompt_queue' }),
            ).toBeGreaterThan(0);
            expect(sample(before, 'otheater_waits_active', { kind: 'prompt_queue' })).toBe(0);
            expect(
              sample(before, 'otheater_telemetry_batches_rejected_total', { reason: 'token' }),
            ).toBe(0);
            const receiver = daemon.telemetryUrl ?? '';
            expect(receiver).not.toBe('');
            const refused = await fetch(`${receiver}/v1/traces`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            });
            expect(refused.status).toBe(401);
            expect(
              sample(await metrics(), 'otheater_telemetry_batches_rejected_total', {
                reason: 'token',
              }),
            ).toBe(1);

            // 4. P5/P6: the tool of the plugin is in the grant of the roles the manifest declares,
            //    and only there. First the real attempts of the play, then the policies by hand.
            expect(grants.length).toBeGreaterThan(0);
            const withNotes = new Set(
              grants
                .filter((grant) => grant.pluginTools?.includes('notes__add_note') === true)
                .map((grant) => grant.role),
            );
            expect([...withNotes], 'only the Actor is handed add_note').toEqual(['actor']);
            for (const grant of grants) {
              expect(grant.pluginTools ?? []).not.toContain('notes__list_notes');
              expect(grant.pluginTools ?? []).not.toContain('notes__clear_notes');
            }
            const correlation = { playId, demandId: 'probe', attemptId: `${playId}/probe` };
            const toolsOf = async (role: string, policy: typeof READER | typeof WRITER) =>
              await daemon.mcp.pluginTools?.({ role, correlation, project: scenarioId, policy });
            expect(await toolsOf('actor', WRITER)).toEqual([
              'notes__add_note',
              'vaulted__env_report',
            ]);
            expect(
              await toolsOf('actor', READER),
              'a write tool needs the policy that writes',
            ).toEqual(['vaulted__env_report']);
            expect(await toolsOf('critic', WRITER)).toEqual([]);
            expect(await toolsOf('director', WRITER)).toEqual([]);

            const recorded: unknown[] = [];
            const open = (role: string, pluginTools: readonly string[]) =>
              daemon.mcp.grant({
                attemptId: `${playId}/probe/${role}`,
                role,
                project: scenarioId,
                pluginTools,
                correlation: { ...correlation, attemptId: `${playId}/probe/${role}` },
                record: (entry: unknown) => {
                  recorded.push(entry);
                  return Promise.resolve();
                },
              });
            const rpc = async (grant: ReturnType<typeof open>, method: string, params: unknown) => {
              const response = await fetch(daemon.mcpUrl, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  accept: 'application/json, text/event-stream',
                  ...grant.server.headers,
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
              });
              const text = await response.text();
              const raw = text.startsWith('{')
                ? text
                : (text
                    .split('\n')
                    .find((row) => row.startsWith('data:'))
                    ?.slice(5)
                    .trim() ?? '{}');
              return {
                raw,
                ...(JSON.parse(raw) as {
                  result?: {
                    content?: { text: string }[];
                    isError?: boolean;
                    tools?: { name: string }[];
                  };
                  error?: unknown;
                }),
              };
            };
            const names = async (grant: ReturnType<typeof open>): Promise<string[]> =>
              ((await rpc(grant, 'tools/list', {})).result?.tools ?? []).map((tool) => tool.name);

            const critic = open('critic', (await toolsOf('critic', READER)) ?? []);
            expect((await names(critic)).filter((name) => name.includes('__'))).toEqual([]);
            const blocked = await rpc(critic, 'tools/call', {
              name: 'notes__add_note',
              arguments: { text: 'from the critic' },
            });
            expect(blocked.result?.isError === true || blocked.error !== undefined).toBe(true);
            expect(existsSync(join(projectDir, '.plugin-notes.json')), 'nothing was written').toBe(
              false,
            );

            const actor = open('actor', (await toolsOf('actor', WRITER)) ?? []);
            expect((await names(actor)).filter((name) => name.includes('__')).sort()).toEqual([
              'notes__add_note',
              'vaulted__env_report',
            ]);

            // 5. P8: the Actor adds a note; the file is in the project and the event is in the log.
            const added = await rpc(actor, 'tools/call', {
              name: 'notes__add_note',
              arguments: { text: 'remember the milk' },
            });
            expect(added.result?.isError ?? false).toBe(false);
            expect(JSON.parse(added.result?.content?.[0]?.text ?? '{}')).toMatchObject({
              id: 1,
              text: 'remember the milk',
            });
            const noted = await waitFor(
              'plugin.notes.note_added',
              async () => (await events('plugin.notes.note_added'))[0],
            );
            expect(noted).toMatchObject({
              scenarioId,
              payload: { id: 1, length: 'remember the milk'.length },
            });
            expect(
              JSON.parse(await readFile(join(projectDir, '.plugin-notes.json'), 'utf8')),
            ).toMatchObject({
              notes: [{ id: 1, text: 'remember the milk' }],
            });

            // 6. P10: the panel of the manifest, from the route, in both languages.
            const panel = await get(`/v1/plugins/notes/panel?project=${scenarioId}`);
            expect(panel.status).toBe(200);
            expect(panel.body).toMatchObject({
              plugin: 'notes',
              project: scenarioId,
              language: 'en',
            });
            expect(at(panel.body, 'blocks', 0)).toMatchObject({
              type: 'table',
              title: 'Notes',
              source: 'list_notes',
              error: null,
              rows: [{ id: 1, text: 'remember the milk' }],
            });
            expect(at(panel.body, 'blocks', 1)).toMatchObject({
              type: 'action',
              label: 'Delete all notes',
              tool: 'clear_notes',
              approval: 'manifest',
            });
            expect(
              at(
                (await get(`/v1/plugins/notes/panel?project=${scenarioId}&lang=pt-BR`)).body,
                'blocks',
                0,
                'title',
              ),
            ).toBe('Notas');

            // 7. P6: the action asks the Producer, and nothing runs before the answer.
            const pendingAsk = async () =>
              waitFor('the card of the approval', async () =>
                (await producer.state(scenarioId)).asks.find((ask) =>
                  JSON.stringify(ask.input).includes('notes__clear_notes'),
                ),
              );
            let settled = false;
            const refusal = post('/v1/plugins/notes/actions/clear_notes', {
              project: scenarioId,
            }).finally(() => {
              settled = true;
            });
            const denied = await pendingAsk();
            const labels = (at(denied.input, 'questions', 0, 'options') as { label: string }[]).map(
              (option) => option.label,
            );
            expect(labels).toEqual(['Allow', 'Deny']);
            expect(settled, 'the route waits for the Producer').toBe(false);
            expect(await notesOf(projectDir), 'nothing ran yet').toHaveLength(1);
            await producer.answer(denied.id, { answers: ['Deny'] });
            const denial = await refusal;
            expect(denial.status).not.toBe(200);
            expect(await notesOf(projectDir), 'a Deny runs nothing').toHaveLength(1);

            const approval = post('/v1/plugins/notes/actions/clear_notes', { project: scenarioId });
            const allowed = await waitFor('the second card', async () => {
              const asks = (await producer.state(scenarioId)).asks.filter(
                (ask) =>
                  ask.id !== denied.id && JSON.stringify(ask.input).includes('notes__clear_notes'),
              );
              return asks.at(0);
            });
            await producer.answer(allowed.id, { answers: ['Allow'] });
            const done = await approval;
            expect(done.status).toBe(200);
            expect(done.body).toMatchObject({ plugin: 'notes', tool: 'clear_notes', ok: true });
            expect(await notesOf(projectDir), 'an Allow runs it').toEqual([]);

            // 8. P7: the secret is in the process of the plugin's server and in no other place.
            const keys = await rpc(actor, 'tools/call', {
              name: 'vaulted__env_report',
              arguments: {},
            });
            const report = JSON.parse(keys.result?.content?.[0]?.text ?? '{}') as {
              keys: string[];
            };
            expect(report.keys).toContain('API_TOKEN');
            const corpus = (): string =>
              JSON.stringify({ lines, recorded, said, executorEnvs, listed: keys.raw });
            expect(corpus()).not.toContain(TOKEN);
            expect(JSON.stringify(await events())).not.toContain(TOKEN);
            expect(executorEnvs.length, 'the Executors were launched').toBeGreaterThan(0);
            expect(process.env.API_TOKEN).toBeUndefined();
            for (const env of executorEnvs) expect(Object.keys(env)).not.toContain('API_TOKEN');
            const revealed = await rpc(actor, 'tools/call', {
              name: 'vaulted__env_report',
              arguments: { name: 'API_TOKEN' },
            });
            expect(JSON.parse(revealed.result?.content?.[0]?.text ?? '{}')).toMatchObject({
              value: TOKEN,
            });
            expect(corpus()).not.toContain(TOKEN);
            expect(JSON.stringify(await events())).not.toContain(TOKEN);
          },
        );
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );
});
