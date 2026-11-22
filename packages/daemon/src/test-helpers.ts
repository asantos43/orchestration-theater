// SPDX-License-Identifier: MPL-2.0
// Shared by the tests only (excluded from the build of the package).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Transient,
  type AgentSession,
  type ContentBlock,
  type Disposable,
  type NormalizedUpdate,
  type Profile,
  type RolePolicy,
  type SessionTransport,
  type UpdateListener,
} from '@otheater/core';
import pino, { type Logger } from 'pino';
import type { DaemonEventPayloads, DaemonEventType } from '@otheater/protocol';
import { chooseLauncher, probeSandbox } from './compose.js';
import type { SituationCorrelation, SituationSink } from './situations.js';

/**
 * What a start with the default sandbox and no client writes on this platform after
 * `daemon.started`: the `api.started` of the API server (P3 of Phase 6), the execution that stays
 * `daemon.notice` (no client) and, where layer 3 is missing (Windows, 5.9), first the
 * `sandbox_unavailable` of the composition, which the log writes before the API starts. With the
 * default config the `telemetry.receiver_started` of the OTLP receiver (P2 of Phase 8) comes
 * after the composition and before the API. On Windows without `ot-job-launcher.exe` (Phase 10, P2;
 * the cross job of the CI does not build it), the `windows_launcher_not_found` notice comes first.
 */
export async function startNotices(): Promise<
  ('api.started' | 'daemon.notice' | 'telemetry.receiver_started')[]
> {
  const layer3 = await probeSandbox();
  const launcher =
    chooseLauncher({ windows_launcher: 'auto', windows_shims: 'resolve' }).fallback === undefined
      ? []
      : (['daemon.notice'] as const);
  return layer3.ok
    ? [...launcher, 'telemetry.receiver_started', 'api.started', 'daemon.notice']
    : [...launcher, 'daemon.notice', 'telemetry.receiver_started', 'api.started', 'daemon.notice'];
}

/** A temporary data directory removed by `dispose()`. Never the real one. */
export async function makeTempDataDir(): Promise<{ dir: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'otheater-daemon-'));
  // A managed-adapter install that fails offline may still be tidying its temporary files.
  return {
    dir,
    dispose: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }),
  };
}

/** A profile and a policy of the fake client, for the tests of the execution of sessions. */
export const TEST_PROFILE: Profile = {
  client: 'fake',
  profile: 'one',
  id: 'fake/one',
  dir: '/profiles/fake/one',
};

export const TEST_POLICY: RolePolicy = {
  nativeTools: ['read', 'search', 'edit', 'write'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

/**
 * Wraps a transport so a prompt can make the Executor write files, as a real client does and the
 * fake does not. A first line `#edits {"files":{"a.txt":"text"}}` writes those files under the
 * `cwd` of the session and streams one completed `edit` tool call per file; the rest of the
 * prompt goes on to the wrapped session (`#script:hang`, `#script:echo`...). A prompt that starts
 * with `#throw transient` fails with a `Transient` error, and `#throw boom` with an untyped one. Tests only.
 */
export function editingTransport(inner: SessionTransport): SessionTransport {
  const wrap = (session: AgentSession, cwd: string): AgentSession => {
    const listeners = new Set<UpdateListener>();
    let calls = 0;
    const emit = (update: NormalizedUpdate): void => {
      for (const listener of listeners) listener(update);
    };
    return {
      get sessionId() {
        return session.sessionId;
      },
      get canLoad() {
        return session.canLoad;
      },
      get configOptions() {
        return session.configOptions;
      },
      onUpdate(listener: UpdateListener): Disposable {
        listeners.add(listener);
        const below = session.onUpdate(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
            below.dispose();
          },
        };
      },
      async prompt(blocks: readonly ContentBlock[]) {
        const first = blocks[0];
        if (first?.type === 'text' && first.text.startsWith('#throw transient')) {
          throw new Transient('the client reported a transient error');
        }
        if (first?.type === 'text' && first.text.startsWith('#throw boom')) {
          throw new Error('boom');
        }
        const match =
          first?.type === 'text' ? /^#edits[ \t]*(.*)(?:\r?\n|$)/.exec(first.text) : null;
        if (first?.type !== 'text' || match === null) return session.prompt(blocks);
        const { files } = JSON.parse(match[1] ?? '{}') as { files: Record<string, string> };
        for (const [path, content] of Object.entries(files)) {
          await mkdir(dirname(join(cwd, path)), { recursive: true });
          await writeFile(join(cwd, path), content);
          calls += 1;
          const toolCallId = `edit-${String(calls)}`;
          emit({
            kind: 'tool_call',
            toolCallId,
            title: `Write ${path}`,
            toolKind: 'edit',
            status: 'in_progress',
          });
          emit({ kind: 'tool_call_update', toolCallId, status: 'completed' });
        }
        return session.prompt([
          { type: 'text', text: first.text.slice(match[0].length) },
          ...blocks.slice(1),
        ]);
      },
      cancel: () => session.cancel(),
      setConfig: (id, value) => session.setConfig(id, value),
      close: () => session.close(),
    };
  };
  return {
    id: inner.id,
    open: async (params) => wrap(await inner.open(params), params.cwd),
    load: async (params) => wrap(await inner.load(params), params.cwd),
  };
}

/** Files of an `#edits` directive, for the prompt of a test. */
export function editsPrompt(files: Record<string, string>, rest = ''): string {
  return `#edits ${JSON.stringify({ files })}\n${rest}`;
}

/** A line the {@link captureLogger} logger wrote: the level name, the message and the fields. */
export interface LoggedLine {
  readonly level: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/** A logger that keeps what it writes in memory, to test what the daemon says. Tests only. */
export function captureLogger(): { logger: Logger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = [];
  const logger = pino(
    { level: 'debug', base: null, timestamp: false },
    {
      write: (chunk: string) => {
        const { level, msg, ...fields } = JSON.parse(chunk) as Record<string, unknown>;
        lines.push({
          level: LEVEL_NAMES[Number(level)] ?? String(level),
          msg: String(msg),
          fields,
        });
      },
    },
  );
  return { logger, lines };
}

/**
 * Says no client is installed, so a daemon started without `clients` never looks at the real
 * `PATH` and the test stays hermetic.
 */
export const NO_CLIENTS = { env: { PATH: '' }, findExecutable: () => undefined } as const;

/** What a {@link RecordingSituations} kept: the type, the payload and the correlation. */
export interface RecordedSituation {
  readonly type: string;
  readonly payload: unknown;
  readonly correlation: SituationCorrelation;
}

/**
 * A {@link SituationSink} that keeps what it is given, for the tests of the places that record a
 * situation (P24). `of(type)` is the payloads of one type, in order. Tests only.
 */
export class RecordingSituations implements SituationSink {
  readonly recorded: RecordedSituation[] = [];

  record<T extends DaemonEventType>(
    type: T,
    payload: DaemonEventPayloads[T],
    correlation: SituationCorrelation = {},
  ): void {
    this.recorded.push({ type, payload, correlation });
  }

  of(type: string): unknown[] {
    return this.recorded.filter((item) => item.type === type).map((item) => item.payload);
  }
}
