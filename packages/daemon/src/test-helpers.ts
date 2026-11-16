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

/** A temporary data directory removed by `dispose()`. Never the real one. */
export async function makeTempDataDir(): Promise<{ dir: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'otheater-daemon-'));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
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
