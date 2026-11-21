// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import type {
  ApiDirectItem,
  ApiDirectSession,
  ApiDirectSessionDetail,
  ApiExecutor,
  DirectWorkspace,
  OpenDirectBody,
  OpenDirectResult,
} from '@otheater/protocol';
import { KEYS, type RenderedApp } from '../../ink.test-support.js';
import type { DirectApi } from './api.js';

/** What the tests of the tab Direct session share: a fake daemon of sessions and the way to open the tab. */

export function executor(id: string): ApiExecutor {
  return {
    id,
    profileId: 'fake/one',
    client: 'fake',
    profile: 'one',
    model: 'fake-model',
    effort: null,
    provider: 'fake',
    validity: 'valid',
    invalidReason: null,
    configured: true,
    roles: ['actor'],
  };
}

export function session(
  id: string,
  extra: Partial<ApiDirectSession> = {},
  items: ApiDirectItem[] = [],
): ApiDirectSessionDetail {
  return {
    id,
    scenarioId: 'S',
    executor: 'e1',
    profile: 'fake/one',
    client: 'fake',
    model: 'fake-model',
    workspace: 'worktree',
    branch: `direct/${id}`,
    state: 'idle',
    turns: 0,
    openedAt: 1,
    lastActivityAt: 1,
    closedAt: null,
    commands: [],
    ...extra,
    items,
  };
}

export function said(from: 'producer' | 'actor', text: string, turn = 1): ApiDirectItem {
  return { kind: 'message', from, turn, at: 1, text, streaming: false };
}

export function requestError(code: string, status: number, message: string): ApiRequestError {
  return new ApiRequestError({ status, body: { code, message } } as never, { routeId: 'direct' });
}

/** The calls the tab made, in order: `open {...}`, `send d1 hello`... */
export class FakeDirectApi implements DirectApi {
  readonly calls: string[] = [];
  readonly openBodies: OpenDirectBody[] = [];
  executorList: ApiExecutor[] = [executor('e1'), executor('e2')];
  readonly sessions = new Map<string, ApiDirectSessionDetail>();
  /** What `open` answers; absent: a session is opened. */
  openError: Error | undefined;
  askConfirm = false;
  /** The workspace a session opens with when the body names none. */
  defaultWorkspace: DirectWorkspace = 'worktree';
  private count = 0;

  executors(): Promise<readonly ApiExecutor[]> {
    return Promise.resolve(this.executorList);
  }

  list(): Promise<readonly ApiDirectSession[]> {
    return Promise.resolve(
      [...this.sessions.values()].reverse().map((detail) => {
        const summary: Partial<ApiDirectSessionDetail> = { ...detail };
        delete summary.items;
        return summary as ApiDirectSession;
      }),
    );
  }

  get(sessionId: string): Promise<ApiDirectSessionDetail> {
    const found = this.sessions.get(sessionId);
    return found === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(found);
  }

  open(scenarioId: string, body: OpenDirectBody): Promise<OpenDirectResult> {
    this.calls.push(`open ${scenarioId}`);
    this.openBodies.push(body);
    if (this.openError !== undefined) return Promise.reject(this.openError);
    const workspace = body.workspace ?? this.defaultWorkspace;
    if (workspace === 'scenario' && body.confirm !== true && this.askConfirm) {
      return Promise.resolve({ status: 'confirm', workspace });
    }
    this.count += 1;
    const opened = session(`d${String(this.count)}`, {
      workspace,
      executor: body.executor ?? 'e1',
      branch: workspace === 'worktree' ? `direct/d${String(this.count)}` : null,
    });
    this.sessions.set(opened.id, opened);
    return Promise.resolve({ status: 'opened', workspace, session: opened });
  }

  send(sessionId: string, text: string): Promise<{ turn: number }> {
    this.calls.push(`send ${sessionId} ${text}`);
    return Promise.resolve({ turn: 1 });
  }

  command(sessionId: string, text: string): Promise<{ turn: number }> {
    this.calls.push(`command ${sessionId} ${text}`);
    return Promise.resolve({ turn: 1 });
  }

  cancel(sessionId: string): Promise<{ cancelled: boolean }> {
    this.calls.push(`cancel ${sessionId}`);
    return Promise.resolve({ cancelled: true });
  }

  close(sessionId: string): Promise<{ work: 'kept'; branch: string }> {
    this.calls.push(`close ${sessionId}`);
    return Promise.resolve({ work: 'kept', branch: `direct/${sessionId}` });
  }

  promote(
    sessionId: string,
    target: 'demand' | 'piece',
  ): Promise<{ target: 'demand' | 'piece'; ref: string }> {
    this.calls.push(`promote ${sessionId} ${target}`);
    return Promise.resolve({ target, ref: target === 'demand' ? 'I1' : 'PL1' });
  }
}

/** The words of the screen the helper waits for, in the language of the test. */
export interface TabWords {
  readonly palette: string;
  readonly tab: string;
}
const ENGLISH: TabWords = { palette: 'Command palette', tab: 'Direct session' };

/** Opens the tab through the palette (the tab has no key of its own), and waits for it to draw. */
export async function openDirectTab(app: RenderedApp, words: TabWords = ENGLISH): Promise<string> {
  app.press('\x1bk');
  await app.waitForText(words.palette);
  app.press(words.tab);
  await app.waitForText(words.tab);
  app.press(KEYS.enter);
  return app.settle();
}
