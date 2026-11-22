// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LaunchedProcess, type LaunchOptions, type ProcessLauncher } from '@otheater/core';
import { ApiClient } from '@otheater/client';
import { API_ROUTES, type ApiSseMessage, type ChatServerMessage } from '@otheater/protocol';
import { FakeCodeHost, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, realClientFlags, testGit } from '@otheater/sdk';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { CLIENT_IDS, LIMIT_PRESET_NAMES, parseConfig, type ClientId } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { RealHeadCodeHost, waitFor } from '../orchestration/e2e-fixture.js';
import { dataPaths, profileDirOf, type ProfileNames } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeWorkspaceRig } from '../workspace/workspace-fixture.js';

/**
 * The acceptance of Phase 9 at the REAL level (P13 of docs/20) [proposta]: one play with a real
 * client (Claude Code, a small model) in every role, with the example plugin `notes` turned on in
 * the project. The Actor is asked to add a note with the tool of the plugin; the criteria are about
 * who was handed the tool and what the daemon did with the call, not about what the model wrote.
 * Nothing here runs by default: a plain `pnpm test` skips the file, so no client is started and no
 * quota is spent.
 *
 * Needs `OT_TEST_REAL_CLIENTS=1`, `OT_TEST_REAL_PROMPTS=1` and `OT_TEST_REAL_PHASE9=1`, and, for each
 * client, `OT_TEST_<CLAUDE|CODEX|OPENCODE>_PROFILE_DIR` (a profile already logged in, only pointed
 * at: nothing here reads or copies a credential file) and `_MODEL` (and, optional, `_MODE`).
 * Optional:
 * - `OT_TEST_PHASE9_CLIENTS`: a comma-separated list of `claude-code`, `codex` and `opencode`, one play
 *   each. Default `claude-code` (the other two are off unless named);
 * - `OT_TEST_PHASE9_EDIT_RULES=1`: the test-only rule of N180 that lets Codex and OpenCode edit
 *   inside the worktree (as `OT_TEST_PHASE8_EDIT_RULES` of the Phase 8 level);
 * - `OT_TEST_PLAY_TIMEOUT_MS` (default 25 minutes), `OT_TEST_PLAY_LIMITS` (default `moderate`) and
 *   `OT_TEST_SANDBOX_EXTRA_DOMAINS` (for the provider of OpenCode).
 *
 * What it requires:
 * - the play reaches DONE;
 * - the tool `notes__add_note` was handed to the Actor (the grants the daemon opened for the
 *   attempts say who got it) and to no other role, the Critic among them, whose grant has no tool of
 *   the plugin;
 * - the Actor really called it: the event `plugin.notes.note_added` is in the log, the note is in the
 *   file of the project (`.plugin-notes.json`) and `GET /v1/plugins/notes/panel` shows it;
 * - the tool that asks for the Producer's approval (`clear_notes`) was given to no role, so it was
 *   never called by a model;
 * - no process of the test is alive after the daemon stops.
 * [N] Not run when written: the owner runs it. Whether a real client lists and calls a tool of the
 * `otheater` MCP server named `notes__add_note`, and how it words the call, is not confirmed.
 */

const flags = realClientFlags();
const phase9Flag = process.env.OT_TEST_REAL_PHASE9 === '1';
const supported = process.platform !== 'win32';
const ENV_PREFIX: Readonly<Record<ClientId, string>> = {
  'claude-code': 'OT_TEST_CLAUDE',
  codex: 'OT_TEST_CODEX',
  opencode: 'OT_TEST_OPENCODE',
};

function clientsOfTheRun(): readonly ClientId[] {
  const raw = (process.env.OT_TEST_PHASE9_CLIENTS ?? '').trim();
  if (raw === '') return ['claude-code'];
  const list = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const name of list) {
    if (!(CLIENT_IDS as readonly string[]).includes(name)) {
      throw new Error(`OT_TEST_PHASE9_CLIENTS: "${name}" is not one of ${CLIENT_IDS.join(', ')}`);
    }
  }
  return [...new Set(list)] as ClientId[];
}

const CLIENTS = phase9Flag ? clientsOfTheRun() : [];
const EDIT_RULES = process.env.OT_TEST_PHASE9_EDIT_RULES === '1';
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
const ready = flags.clients && flags.prompts && phase9Flag && supported;

const DEFAULT_TIMEOUT_MS = 25 * 60_000;
const TEARDOWN_MARGIN_MS = 3 * 60_000;
const ANSWER_FALLBACK = 'Use your best judgment and keep it as small as possible.';
const NO_PLAY_GRACE_MS = 90_000;
/** The example plugin, as it is in the repository (its `dist` comes from `pnpm build`). */
const NOTES_DIR = fileURLToPath(new URL('../../../../examples/plugin-notes', import.meta.url));
const NOTE_TEXT = 'phase9 real acceptance note';
const WANTED_FILE = 'docs/phase9.txt';
const NEED = [
  'This project has a plugin called notes, whose tools are in the otheater MCP server.',
  `First call its tool add_note (the full name is notes__add_note) with exactly the text "${NOTE_TEXT}".`,
  `Then create the file ${WANTED_FILE} with one line: noted.`,
  'There is nothing to install and no command to run.',
  'This is the whole need: do not ask me anything else, and do not touch other files.',
].join(' ');

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
  process.stderr.write(`[phase9-real] ${text}\n`);
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

/** JSON of anything the stores return. */
function json(value: unknown): string {
  return JSON.stringify(value);
}

afterAll(disposeTestGitIsolation);

describe.skipIf(!ready)(
  'a real play with the plugin notes (OT_TEST_REAL_CLIENTS=1, OT_TEST_REAL_PROMPTS=1, OT_TEST_REAL_PHASE9=1)',
  () => {
    const limitMs = ready
      ? envMs('OT_TEST_PLAY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

    for (const executor of CLIENTS) {
      it(
        `${executor}: the Actor calls add_note, the Critic does not see the tool, the event and the panel agree`,
        async () => {
          const prefix = ENV_PREFIX[executor];
          const profileDirEnv = process.env[`${prefix}_PROFILE_DIR`] ?? '';
          const model = process.env[`${prefix}_MODEL`] ?? '';
          const mode = process.env[`${prefix}_MODE`];
          if (profileDirEnv === '' || model === '') {
            throw new Error(`${prefix}_PROFILE_DIR and ${prefix}_MODEL are needed for ${executor}`);
          }
          const tmp = await makeTempDataDir();
          const scratch = await mkdtemp(join(tmpdir(), 'otheater-phase9-real-'));
          const real = defaultLauncher();
          if (real === undefined) throw new Error('this platform has no process launcher');
          const { launcher, pids } = recording(real);
          log(`client: ${executor}, model: ${model}`);

          const profileSource = await realpath(profileDirEnv);
          const vault = new InMemorySecretVault();
          const config = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
limits:
  preset: ${limitsPreset()}
${EXTRA_DOMAINS.length === 0 ? '' : `sandbox:\n  extra_domains: ${json(EXTRA_DOMAINS)}\n`}${EDIT_RULES ? `roles:\n${EDIT_RULES_YAML}` : ''}orchestration:
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
          await testGit(rig.repo, 'push', '--quiet', 'origin', 'main');
          fakeHost.seedRemote(rig.repo, 'main');

          const grants: { role: string; pluginTools: readonly string[] }[] = [];
          const realGrant = daemon.mcp.grant.bind(daemon.mcp);
          vi.spyOn(daemon.mcp, 'grant').mockImplementation((input) => {
            grants.push({ role: input.role, pluginTools: input.pluginTools ?? [] });
            return realGrant(input);
          });

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
          let scenarioId: string | undefined;
          let playId: string | undefined;
          const stream = client.events({ since: 0 });
          stream.onMessage((message) => received.push(message));
          stream.start();
          let chat: ReturnType<ApiClient['chat']> | undefined;
          try {
            // 0. The plugin is installed and turned on in the project, as `ot plugin install` and
            //    `ot plugin enable` leave it (the folder is the example of the repository).
            const opened = await client.call(API_ROUTES.openScenario, { body: { repo: rig.repo } });
            scenarioId = opened.scenario.id;
            const manifest = await readFile(join(NOTES_DIR, 'plugin.yaml'));
            const hash = createHash('sha256').update(manifest).digest('hex');
            await daemon.plugins.register({
              id: 'notes',
              version: '1.0.0',
              origin: { kind: 'path', path: NOTES_DIR },
              dir: NOTES_DIR,
              manifestHash: hash,
            });
            await daemon.plugins.enable('notes', scenarioId, hash);

            // 1. The play, driven as a screen would: the chat, the questions, the stream.
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

            // 2. Roles: the tool of the plugin is in the grant of the Actor and of no other role.
            const byRole = new Map<string, Set<string>>();
            for (const grant of grants) {
              const names = byRole.get(grant.role) ?? new Set<string>();
              for (const name of grant.pluginTools) names.add(name);
              byRole.set(grant.role, names);
            }
            log(
              `grants by role: ${[...byRole.entries()]
                .map(([role, names]) => `${role}=${String(names.size)}`)
                .join(', ')}`,
            );
            const holders = [...byRole.entries()]
              .filter(([, names]) => names.has('notes__add_note'))
              .map(([role]) => role);
            expect(holders, 'only the Actor is handed add_note').toEqual(['actor']);
            expect(byRole.has('critic'), 'the Critic ran, and its grant is a real one').toBe(true);
            for (const [role, names] of byRole) {
              if (role === 'actor') continue;
              expect([...names], `no tool of the plugin for the ${role}`).toEqual([]);
            }
            expect(
              [...byRole.values()].some((names) => names.has('notes__clear_notes')),
              'the tool that needs approval is in no grant',
            ).toBe(false);

            // 3. The Actor really called it: the event, the file of the project and the panel agree.
            const noted = await waitFor(
              'the event plugin.notes.note_added',
              async () => {
                const found = (await daemon.store.events.readFrom(0, 1_000_000)).filter(
                  (event) => event.type === 'plugin.notes.note_added',
                );
                return found.length > 0 ? found : undefined;
              },
              60_000,
            );
            log(`events plugin.notes.note_added: ${String(noted.length)}`);
            const notes = JSON.parse(
              await readFile(join(rig.repo, '.plugin-notes.json'), 'utf8'),
            ) as {
              notes: { text: string }[];
            };
            expect(
              notes.notes.map((note) => note.text),
              'the note the Actor wrote is in the file of the project',
            ).toContain(NOTE_TEXT);
            const panel = (await (
              await get(`/v1/plugins/notes/panel?project=${scenarioId}`)
            ).json()) as { blocks: { type: string; rows?: { text: string }[] }[] };
            const table = panel.blocks.find((block) => block.type === 'table');
            expect(
              table?.rows?.map((row) => row.text),
              'the panel shows the note',
            ).toContain(NOTE_TEXT);
            log(`the panel of notes shows ${String(table?.rows?.length ?? 0)} note(s)`);
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
            await rm(scratch, { recursive: true, force: true });
            survivors = await waitFor(
              'the processes of the clients to exit',
              () => Promise.resolve(pids.some(alive) ? undefined : []),
              15_000,
            ).catch(() => pids.filter(alive));
            log(
              `processes started: ${String(pids.length)}; left alive: ${String(survivors.length)}`,
            );
          }
          if (stopFailure !== undefined) {
            failure ??= new Error('the daemon did not stop clean', { cause: stopFailure });
          }
          if (failure !== undefined) {
            throw failure instanceof Error
              ? failure
              : new Error('the phase 9 run failed', { cause: failure });
          }
          expect(pids.length).toBeGreaterThan(0);
          expect(survivors).toEqual([]);
        },
        limitMs + TEARDOWN_MARGIN_MS,
      );
    }
  },
);
