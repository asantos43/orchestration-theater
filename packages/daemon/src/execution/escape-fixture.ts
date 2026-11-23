// SPDX-License-Identifier: MPL-2.0
// Shared by the escape suite (P5): the fake and the real tests. Excluded from the build.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROLE_POLICY_FIELDS,
  type ClientAdapter,
  type Clock,
  type Enforcement,
  type EventEnvelope,
  type Profile,
  type RolePolicy,
  type SecretVault,
} from '@otheater/core';
import type { ClientFactoryParts } from '../clients.js';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig, type DaemonConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeRepo } from './attempt-fixture.js';
import type { AttemptSpec } from './attempt-runner.js';

export const FAKE_AGENT_CLI = fileURLToPath(
  new URL('../../../fake-agent/dist/cli.js', import.meta.url),
);

/** The base policy of the suite: native read and write, no native shell, nothing released. */
export const BASE_POLICY: RolePolicy = {
  nativeTools: ['read', 'search', 'edit', 'write'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

/** The `actor`: it also gets the shells of the daemon, which reach it as MCP tools. */
export const SHELLS_POLICY: RolePolicy = {
  ...BASE_POLICY,
  nativeShell: 'shells',
  mcpServers: ['otheater'],
  mcpTools: { otheater: 'all' },
};

/**
 * A client like the real ones as to the OS fields: it guarantees by itself everything but where it
 * writes and where it connects, which only layer 3 can.
 */
const ENFORCEMENT = Object.fromEntries(
  ROLE_POLICY_FIELDS.map((field) => [
    field,
    field === 'writeScope' || field === 'network' ? [] : ['client'],
  ]),
) as unknown as Enforcement;

/**
 * What the test files take from `@otheater/core/testing` (only `*.test.ts` files may import it, rule
 * `testing-only-from-tests`) and hand to this fixture, once, with `installFakes`.
 */
export interface EscapeFakes {
  readonly clock: () => Clock;
  readonly vault: () => SecretVault;
  /** The fake client adapter that runs the fake agent CLI over real ACP stdio. */
  readonly client: (options: {
    readonly parts: ClientFactoryParts;
    readonly unenforced: DaemonConfig['security']['unenforced'];
    readonly enforcement: Enforcement;
    readonly command: { readonly cmd: string; readonly args: readonly string[] };
  }) => ClientAdapter;
}

let installed: EscapeFakes | undefined;

export function installFakes(fakes: EscapeFakes): void {
  installed = fakes;
}

function fakes(): EscapeFakes {
  if (installed === undefined) throw new Error('call installFakes() first');
  return installed;
}

/** The "outside" of the suite: a folder and a local server that must receive nothing. */
export interface Outside {
  /** A folder outside every worktree, where no file may ever appear. */
  readonly outsideDir: string;
  /** The port of a server on the loopback of the host. */
  readonly port: number;
  /** How many requests the server saw. */
  readonly requests: () => number;
}

export async function withOutside(body: (outside: Outside) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'otheater-escape-')));
  const outsideDir = join(base, 'outside');
  await mkdir(outsideDir);
  await writeFile(join(outsideDir, 'secret.txt'), 'not a real secret\n');
  let seen = 0;
  const server: Server = createServer((_request, response) => {
    seen += 1;
    response.end('hello from the host\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await body({ outsideDir, port, requests: () => seen });
  } finally {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await rm(base, { recursive: true, force: true });
  }
}

export interface DaemonOptions {
  /** Extra YAML after the base config. */
  readonly config?: string;
  /** Adds `security.unenforced: warn`: the layers that need no sandbox, on a machine with none. */
  readonly unenforced?: boolean;
}

export interface Rig {
  readonly daemon: DaemonHandle;
  readonly repo: string;
  readonly profile: Profile;
}

/** A daemon with the fake agent as a client, over the real ACP stdio and the real launcher. */
export async function withFakeDaemon(
  options: DaemonOptions,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  const { clock, vault, client } = fakes();
  const tmp = await makeTempDataDir();
  const real = defaultLauncher();
  if (real === undefined) throw new Error('this platform has no process launcher');
  const unenforced = options.unenforced === true ? 'security:\n  unenforced: warn\n' : '';
  // `shell.node_inline: allow`: these suites measure what the operating system holds when an allowed
  // program does the harm (`node -e` is the example), and the default (`deny`, N290) would refuse it
  // before it ran.
  const config = parseConfig(
    `backup:\n  when: manual\nshell:\n  node_inline: allow\n${unenforced}${options.config ?? ''}`,
  );
  const profileDir = join(tmp.dir, 'profiles', 'fake', 'one');
  await mkdir(profileDir, { recursive: true });
  const profile: Profile = { client: 'fake', profile: 'one', id: 'fake/one', dir: profileDir };
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config,
    overrides: { clock: clock(), vault: vault(), launcher: real },
    clients: (parts) => [
      ...productionClients(config)(parts),
      client({
        parts,
        unenforced: config.security.unenforced,
        enforcement: ENFORCEMENT,
        command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
      }),
    ],
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  const { repo, dispose } = await makeRepo();
  try {
    await body({ daemon, repo, profile });
  } finally {
    await dispose();
    await daemon.stop();
    await tmp.dispose();
  }
}

export function specOf(
  rig: Rig,
  demandId: string,
  prompt: string,
  policy: RolePolicy,
  role: 'author' | 'actor' = 'actor',
): AttemptSpec {
  return {
    playId: 'play-escape',
    demandId,
    attempt: 1,
    repo: rig.repo,
    base: 'main',
    profile: rig.profile,
    executor: { model: 'fake-model' },
    policy,
    prompt,
    role,
  };
}

/** The text of the message chunks the agent streamed in an attempt. */
export function chunksOf(events: readonly EventEnvelope[], attemptId: string): string {
  return events
    .filter((event) => event.attemptId === attemptId && event.type === 'session.update')
    .map((event) => JSON.stringify(event.payload))
    .join('\n');
}

const inAttempt = (events: readonly EventEnvelope[], attemptId: string): EventEnvelope[] =>
  events.filter((event) => event.attemptId === attemptId);

export interface PermissionAnswer {
  readonly tool: string | undefined;
  readonly kind: string | undefined;
  readonly answer: string;
  readonly rule: string;
  readonly reason: string;
  readonly overruledRule: string | undefined;
  readonly paths: readonly string[];
  readonly host: string | undefined;
}

/** The `permission.answered` events of an attempt (layer 2), in order. */
export function permissionsOf(
  events: readonly EventEnvelope[],
  attemptId: string,
): PermissionAnswer[] {
  return inAttempt(events, attemptId)
    .filter((event) => event.type === 'permission.answered')
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      return {
        tool: payload.tool as string | undefined,
        kind: payload.kind as string | undefined,
        answer: String(payload.answer),
        rule: String(payload.rule),
        reason: String(payload.reason),
        overruledRule: payload.overruledRule as string | undefined,
        paths: (payload.paths as string[] | undefined) ?? [],
        host: payload.host as string | undefined,
      };
    });
}

export interface ToolEnd {
  readonly tool: string;
  readonly summary: string;
  readonly outcome: string;
  readonly errorCode: string | undefined;
  readonly exitCode: number | null | undefined;
}

/** The calls of the work tools of an attempt, `tool.called` joined to `tool.finished` by `callId`. */
export function toolEndsOf(events: readonly EventEnvelope[], attemptId: string): ToolEnd[] {
  const mine = inAttempt(events, attemptId);
  const summaries = new Map<string, string>();
  for (const event of mine) {
    if (event.type !== 'tool.called') continue;
    const payload = event.payload as { callId: string; summary: string };
    summaries.set(payload.callId, payload.summary);
  }
  return mine
    .filter((event) => event.type === 'tool.finished')
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      return {
        tool: String(payload.tool),
        summary: summaries.get(String(payload.callId)) ?? '',
        outcome: String(payload.outcome),
        errorCode: payload.errorCode as string | undefined,
        exitCode: payload.exitCode as number | null | undefined,
      };
    });
}

/** How many `tool.called` events an attempt has for the tool. */
export function toolCallsOf(
  events: readonly EventEnvelope[],
  attemptId: string,
  tool: string,
): number {
  return inAttempt(events, attemptId).filter(
    (event) => event.type === 'tool.called' && (event.payload as { tool?: string }).tool === tool,
  ).length;
}

/**
 * What the client of an attempt said and tried, from its `session.update` events: the text of its
 * reply (the `agent_message_chunk`s, joined) and its native tool calls (`tool_call`, with the last
 * status a `tool_call_update` gave). A report for the owner of the real suite, never a criterion:
 * an empty reply or no call tells that the model did not try, which a pass alone does not.
 */
export function transcriptOf(
  events: readonly EventEnvelope[],
  attemptId: string,
): { readonly reply: string; readonly toolCalls: readonly string[] } {
  let reply = '';
  const calls = new Map<string, { title: string; kind: string; status: string }>();
  for (const event of inAttempt(events, attemptId)) {
    if (event.type !== 'session.update') continue;
    const update = (event.payload as { update?: Record<string, unknown> }).update;
    if (update === undefined) continue;
    if (update.kind === 'agent_message_chunk') {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === 'text' && typeof content.text === 'string') reply += content.text;
    } else if (update.kind === 'tool_call' || update.kind === 'tool_call_update') {
      const id = String(update.toolCallId);
      const call = calls.get(id) ?? { title: '', kind: '?', status: '?' };
      if (typeof update.title === 'string' && update.title !== '') call.title = update.title;
      if (typeof update.toolKind === 'string') call.kind = update.toolKind;
      if (typeof update.status === 'string') call.status = update.status;
      calls.set(id, call);
    }
  }
  const toolCalls = [...calls.values()].map((call) => `${call.kind}:${call.status}:${call.title}`);
  return { reply, toolCalls };
}

/** The prompt that plays the escape script with these steps. */
export function escapePrompt(steps: readonly Record<string, unknown>[]): string {
  return `#script:escape ${JSON.stringify({ steps })}\nescape`;
}

export const present = (path: string): boolean => existsSync(path);
