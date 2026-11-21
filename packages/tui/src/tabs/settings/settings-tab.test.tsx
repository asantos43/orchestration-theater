// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import type {
  AddProfileBody,
  AddProfileResult,
  ApiConfig,
  ApiEventEnvelope,
  ApiExecutor,
  ApiProfile,
  ApiRoles,
  ConfigEditBody,
  ConfigEditResult,
  RemoveProfileResult,
  StartProfileLoginResult,
} from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, type RenderedApp } from '../../ink.test-support.js';
import { fakeOnline, seedStores, type FakeOnline } from '../../layout.test-support.js';
import type { TabContentMap } from '../../layout/tab-content.js';
import type { SettingsApi } from './api.js';
import { createSettingsTab, errorText } from './settings-tab.js';

/**
 * The tab Settings over a fake API (P16 of Phase 7): fake accounts, a fake login, no daemon. What
 * the screen asks of the daemon is recorded, so a test says what was written and in which order.
 */

afterEach(cleanupApps);

const NOW = 1_000_000;

function requestError(
  routeId: string,
  code: string,
  status: number,
  message: string,
  issues?: readonly { path: string[]; message: string }[],
): ApiRequestError {
  return new ApiRequestError(
    {
      status,
      body: { code, message, ...(issues === undefined ? {} : { details: { issues } }) },
    } as never,
    { routeId },
  );
}

function profile(
  client: string,
  name: string,
  kind: 'token_plan' | 'api' = 'token_plan',
): ApiProfile {
  return {
    profile: { id: `${client}/${name}`, client, name, kind, provider: client, state: 'active' },
    hasSecret: kind === 'api',
    executors: { valid: 1, invalid: 0 },
    quota: {
      profile: `${client}/${name}`,
      state: 'ok',
      windows: [{ window: '5h', usedPercent: 40, resetsAt: NOW + 2 * 3_600_000 }],
    },
  } as unknown as ApiProfile;
}

function executor(model: string, client: string, name: string, roles: string[]): ApiExecutor {
  return {
    id: `${model}-high@${client}/${name}`,
    profileId: `${client}/${name}`,
    client,
    profile: name,
    model,
    effort: 'high',
    provider: client,
    validity: 'valid',
    invalidReason: null,
    configured: true,
    roles,
  } as unknown as ApiExecutor;
}

const A = executor('opus', 'claude-code', 'main', ['author']);
const B = executor('sonnet', 'claude-code', 'main', ['author']);
const C = executor('gpt', 'codex', 'work', ['author']);

function rolesOf(order: readonly string[], whenExhausted: 'next' | 'wait'): ApiRoles {
  const all = [A, B, C];
  return {
    preset: 'moderate',
    capabilityCheck: 'warn',
    allowedProfiles: [],
    roles: [
      {
        role: 'author',
        source: 'config',
        whenExhausted,
        executors: order.map((id) => {
          const found = all.find((e) => e.id === id);
          return { ...found, origin: 'config', blockedBy: null, shortfalls: [] };
        }),
        next: null,
      },
    ],
    notes: [],
  } as unknown as ApiRoles;
}

class FakeSettingsApi implements SettingsApi {
  accounts: ApiProfile[] = [profile('claude-code', 'main'), profile('codex', 'work')];
  order: string[] = [A.id, B.id, C.id];
  whenExhausted: 'next' | 'wait' = 'next';
  limits: Record<string, unknown> = { attempts_per_demand: 3 };
  edits: ConfigEditBody[] = [];
  added: AddProfileBody[] = [];
  removed: string[] = [];
  codes: string[] = [];
  cancelled: string[] = [];
  loginAnswer: StartProfileLoginResult = {
    status: 'started',
    profileId: 'claude-code/main',
    mode: 'browser',
    url: 'https://login.example.test/oauth?state=abc',
    code: null,
    takesCode: true,
  };
  rejectEdit: string | undefined;
  noticeFirst = false;
  onCode: (code: string) => void = () => undefined;

  profiles(): Promise<readonly ApiProfile[]> {
    return Promise.resolve(this.accounts);
  }
  executors(): Promise<readonly ApiExecutor[]> {
    return Promise.resolve([A, B, C]);
  }
  roles(): Promise<ApiRoles> {
    return Promise.resolve(rolesOf(this.order, this.whenExhausted));
  }
  config(): Promise<ApiConfig> {
    return Promise.resolve({ config: { limits: this.limits }, redactedPaths: [] } as ApiConfig);
  }
  scenarioOverride(): Promise<Readonly<Record<string, unknown>>> {
    return Promise.resolve({ limits: { plan_reviews: 5 } });
  }
  addProfile(body: AddProfileBody): Promise<AddProfileResult> {
    if (this.noticeFirst && body.acceptNotice !== true) {
      return Promise.resolve({
        status: 'needs_notice',
        notice: { provider: body.provider, existing: ['claude-code/main'], mode: 'warn' },
      } as unknown as AddProfileResult);
    }
    this.added.push(body);
    const added = profile(body.client, body.name, body.kind);
    this.accounts.push(added);
    return Promise.resolve({
      status: 'added',
      profile: added.profile,
    } as unknown as AddProfileResult);
  }
  removeProfile(profileId: string): Promise<RemoveProfileResult> {
    this.removed.push(profileId);
    this.accounts = this.accounts.filter((entry) => entry.profile.id !== profileId);
    return Promise.resolve({} as RemoveProfileResult);
  }
  putConfig(edit: ConfigEditBody): Promise<ConfigEditResult> {
    if (this.rejectEdit !== undefined) {
      return Promise.reject(
        requestError('putConfig', 'invalid_input', 400, this.rejectEdit, [
          { path: ['limits', 'attempts_per_demand'], message: this.rejectEdit },
        ]),
      );
    }
    this.edits.push(edit);
    for (const set of edit.set ?? []) {
      if (set.path[0] === 'roles') {
        if (set.path[2] === 'executors') this.order = set.value as string[];
        else this.whenExhausted = set.value as 'next' | 'wait';
      } else if (set.path[0] === 'limits') {
        this.limits = { ...this.limits, [set.path.slice(1).join('.')]: set.value };
      }
    }
    for (const path of edit.remove ?? []) {
      if (path[0] === 'limits') {
        this.limits = Object.fromEntries(
          Object.entries(this.limits).filter(([name]) => name !== path.slice(1).join('.')),
        );
      }
    }
    return Promise.resolve({
      appliesOn: 'hot',
      set: edit.set?.map((s) => s.path.join('.')) ?? [],
      removed: [],
      hot: edit.set?.map((s) => s.path.join('.')) ?? [],
      restart: [],
    } as unknown as ConfigEditResult);
  }
  startLogin(): Promise<StartProfileLoginResult> {
    return Promise.resolve(this.loginAnswer);
  }
  submitLoginCode(_profileId: string, code: string): Promise<void> {
    this.codes.push(code);
    this.onCode(code);
    return Promise.resolve();
  }
  cancelLogin(profileId: string): Promise<void> {
    this.cancelled.push(profileId);
    return Promise.resolve();
  }
}

let eventId = 0;
function emit(online: FakeOnline, type: string, payload: Record<string, unknown>): void {
  eventId += 1;
  const events = online.stores.events.getState().events;
  online.stores.events.setState({
    events: [
      ...events,
      { id: eventId + 1000, type, payload, timestamp: NOW } as unknown as ApiEventEnvelope,
    ],
  } as never);
}

async function open(
  api: FakeSettingsApi,
  options: { runLocal?: (command: string) => Promise<number | null> } = {},
): Promise<{ app: RenderedApp; online: FakeOnline }> {
  const online = fakeOnline();
  seedStores(online.stores);
  const tabContent: TabContentMap = {
    settings: createSettingsTab({ api, now: () => NOW, runLocal: options.runLocal }),
  };
  const app = await renderApp({
    connector: online.connector,
    size: { columns: 140, rows: 60 },
    tabContent,
  });
  await app.waitForText('SCENARIOS');
  app.press('\x1b[15~');
  await app.waitForText('claude-code/main');
  return { app, online };
}

async function key(app: RenderedApp, sequence: string): Promise<string> {
  app.press(sequence);
  return app.settle();
}

async function type(app: RenderedApp, text: string): Promise<string> {
  for (const char of text) await key(app, char);
  return app.frame();
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timeout waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const DOWN = '\x1b[B';
const SHIFT_UP = '\x1b[1;2A';
const SHIFT_DOWN = '\x1b[1;2B';

describe('the tab Settings', () => {
  it('draws the accounts with state and quota, the Executors, the roles and the limits', async () => {
    const { app } = await open(new FakeSettingsApi());
    const frame = await app.settle();
    expect(frame).toContain('claude-code/main');
    expect(frame).toContain('40%');
    expect(frame).toContain('opus-high@claude-code/main');
    expect(frame).toContain('author');
    expect(frame).toContain('attempts_per_demand');
  });

  it('logs in through the panel: the address and the code on screen, the browser code sent, the end announced', async () => {
    const api = new FakeSettingsApi();
    const { app, online } = await open(api);
    await key(app, 'l');
    let frame = await app.waitForText('https://login.example.test/oauth?state=abc');
    expect(frame).toContain('claude-code/main');
    await type(app, 'abc-123');
    await key(app, '\r');
    await waitUntil(() => api.codes.length === 1);
    expect(api.codes).toEqual(['abc-123']);
    emit(online, 'profile.login.completed', {
      profileId: 'claude-code/main',
      mode: 'browser',
      durationMs: 5,
    });
    frame = await app.waitForText('Signed in: claude-code/main');
    expect(frame).not.toContain('https://login.example.test');
  });

  it('shows the code of a device login and cancels it with Esc', async () => {
    const api = new FakeSettingsApi();
    api.loginAnswer = {
      status: 'started',
      profileId: 'claude-code/main',
      mode: 'device_code',
      url: 'https://device.example.test/activate',
      code: 'WXYZ-1234',
      takesCode: false,
    };
    const { app } = await open(api);
    await key(app, 'l');
    const frame = await app.waitForText('WXYZ-1234');
    expect(frame).toContain('https://device.example.test/activate');
    await key(app, '\x1b');
    await waitUntil(() => api.cancelled.length === 1);
    expect(api.cancelled).toEqual(['claude-code/main']);
  });

  it('says why a login failed when the event comes', async () => {
    const api = new FakeSettingsApi();
    const { app, online } = await open(api);
    await key(app, 'l');
    await app.waitForText('login.example.test');
    emit(online, 'profile.login.failed', {
      profileId: 'claude-code/main',
      mode: 'browser',
      reason: 'refused',
      durationMs: 5,
    });
    const frame = await app.waitForText('The sign-in of claude-code/main failed');
    expect(frame).not.toContain('login.example.test');
  });

  it('runs the login in the terminal of the person when the daemon leaves it to the terminal', async () => {
    const api = new FakeSettingsApi();
    api.loginAnswer = {
      status: 'local',
      profileId: 'claude-code/main',
      mode: 'terminal',
      command: 'fake-cli login --profile main',
    };
    const ran: string[] = [];
    const { app } = await open(api, {
      runLocal: (command) => {
        ran.push(command);
        return Promise.resolve(0);
      },
    });
    await key(app, 'l');
    await waitUntil(() => ran.length === 1);
    expect(ran).toEqual(['fake-cli login --profile main']);
    await app.waitForText('terminal');
  });

  it('writes the new order of a role when an Executor moves with Shift+Down and Shift+Up', async () => {
    const api = new FakeSettingsApi();
    const { app } = await open(api);
    // The cursor of the panel walks the sections: subscriptions, executors, roles.
    await key(app, DOWN);
    await key(app, DOWN);
    // The first item of the roles is the rule; the next one is the first Executor.
    await key(app, 'j');
    await key(app, SHIFT_DOWN);
    await waitUntil(() => api.edits.length === 1);
    expect(api.edits[0]?.set).toEqual([
      { path: ['roles', 'author', 'executors'], value: [B.id, A.id, C.id] },
    ]);
    await app.waitForText(`1. ${B.id}`);
    await key(app, SHIFT_UP);
    await waitUntil(() => api.edits.length === 2);
    expect(api.edits[1]?.set).toEqual([
      { path: ['roles', 'author', 'executors'], value: [A.id, B.id, C.id] },
    ]);
  });

  it('flips the rule next/wait of a role', async () => {
    const api = new FakeSettingsApi();
    const { app } = await open(api);
    await key(app, DOWN);
    await key(app, DOWN);
    await key(app, 'e');
    await waitUntil(() => api.edits.length === 1);
    expect(api.edits[0]?.set).toEqual([
      { path: ['roles', 'author', 'when_exhausted'], value: 'wait' },
    ]);
  });

  it('shows the key that failed when the configuration is invalid, and writes nothing', async () => {
    const api = new FakeSettingsApi();
    api.rejectEdit = 'must be at least 1';
    const { app } = await open(api);
    await key(app, DOWN);
    await key(app, DOWN);
    await key(app, DOWN);
    await key(app, 'e');
    await type(app, '0');
    await key(app, '\r');
    const frame = await app.waitForText('limits.attempts_per_demand');
    expect(frame).toContain('must be at least 1');
    expect(api.edits).toEqual([]);
    expect(api.limits).toEqual({ attempts_per_demand: 3 });
  });

  it('edits a count of the limits and unsets it', async () => {
    const api = new FakeSettingsApi();
    const { app } = await open(api);
    await key(app, DOWN);
    await key(app, DOWN);
    await key(app, DOWN);
    // The limits cursor: preset is first; attempts_per_demand is the fourth key.
    for (let index = 0; index < 3; index += 1) await key(app, 'j');
    await key(app, 'e');
    await type(app, '7');
    await key(app, '\r');
    await waitUntil(() => api.edits.length === 1);
    expect(api.edits[0]?.set).toEqual([{ path: ['limits', 'attempts_per_demand'], value: 7 }]);
    await key(app, 'u');
    await waitUntil(() => api.edits.length === 2);
    expect(api.edits[1]?.remove).toEqual([['limits', 'attempts_per_demand']]);
  });

  it('adds an account, asking for the key of an API one, and removes one after the confirmation', async () => {
    const api = new FakeSettingsApi();
    const { app } = await open(api);
    await key(app, 'a');
    await type(app, 'codex alt token_plan codex');
    await key(app, '\r');
    await waitUntil(() => api.added.length === 1);
    expect(api.added[0]).toMatchObject({ client: 'codex', name: 'alt', kind: 'token_plan' });
    await app.waitForText('codex/alt');

    await key(app, 'a');
    await type(app, 'opencode zen api openai');
    await key(app, '\r');
    await app.waitForText('API key');
    await type(app, 'sk-fake');
    const masked = app.frame();
    expect(masked).not.toContain('sk-fake');
    await key(app, '\r');
    await waitUntil(() => api.added.length === 2);
    expect(api.added[1]).toMatchObject({ kind: 'api', apiKey: 'sk-fake' });

    await key(app, 'x');
    await app.waitForText('Remove');
    await key(app, 'y');
    await waitUntil(() => api.removed.length === 1);
    expect(api.removed).toEqual(['claude-code/main']);
  });

  it('asks again with acceptNotice when the daemon wants the notice accepted', async () => {
    const api = new FakeSettingsApi();
    api.noticeFirst = true;
    const { app } = await open(api);
    await key(app, 'a');
    await type(app, 'claude-code second token_plan claude');
    await key(app, '\r');
    await app.waitForText('claude-code/main');
    await key(app, 'y');
    await waitUntil(() => api.added.length === 1);
    expect(api.added[0]?.acceptNotice).toBe(true);
  });

  it('reads the override of the project and does not write to it', async () => {
    const api = new FakeSettingsApi();
    const { app, online } = await open(api);
    const first = Object.keys(online.stores.scenarios.getState().byId)[0] ?? '';
    expect(first).not.toBe('');
    await key(app, 's');
    const frame = await app.waitForText('limits.plan_reviews');
    expect(frame).toContain('5');
    await key(app, 'e');
    await app.settle();
    expect(api.edits).toEqual([]);
    await key(app, 's');
    await app.waitForText('claude-code/main');
  });

  it('reloads when an event says the configuration changed', async () => {
    const api = new FakeSettingsApi();
    const { app, online } = await open(api);
    api.limits = { attempts_per_demand: 9 };
    emit(online, 'config.changed', { hot: ['limits.attempts_per_demand'], restart: [] });
    await app.waitForText('attempts_per_demand = 9');
  });
});

describe('errorText', () => {
  it('names the key of an issue and strips the prefix of a plain message', () => {
    const issue = requestError('putConfig', 'invalid_input', 400, 'bad', [
      { path: ['limits', 'turn_timeout'], message: 'not a duration' },
    ]);
    expect(errorText(issue)).toBe('limits.turn_timeout: not a duration');
    const plain = requestError('removeProfile', 'conflict', 409, 'in use by a play');
    expect(errorText(plain)).toBe('in use by a play');
    expect(errorText(new Error('boom'))).toBe('boom');
  });
});
