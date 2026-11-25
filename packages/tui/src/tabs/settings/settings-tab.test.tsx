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
import {
  cleanupApps,
  plain,
  renderApp,
  TEST_UI_SETTINGS,
  type RenderAppOptions,
  type RenderedApp,
} from '../../ink.test-support.js';
import { fakeOnline, seedStores, type FakeOnline } from '../../layout.test-support.js';
import type { TabContentMap } from '../../layout/tab-content.js';
import { MOUSE_DISABLE_SEQUENCE, mouseEnableSequence } from '../../mouse/modes.js';
import type { OpenCommand, OpenPorts } from '../../open-url.js';
import type { UiSettings } from '../../settings.js';
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
  /** `profiles.add.login` of the fake daemon; `off` here so the older tests add an account and nothing more. */
  addLogin: 'ask' | 'auto' | 'off' = 'off';
  /** What the client says about a new subscription account. */
  newLogin: 'logged_in' | 'logged_out' | 'unknown' = 'logged_out';
  loginsStarted: string[] = [];
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
    return Promise.resolve({
      config: { limits: this.limits, profiles: { add: { login: this.addLogin } } },
      redactedPaths: [],
    } as ApiConfig);
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
      login: body.kind === 'api' ? null : this.newLogin,
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
  startLogin(profileId: string): Promise<StartProfileLoginResult> {
    this.loginsStarted.push(profileId);
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

/** What the fake opener of the browser was asked to run: no test starts a browser. */
class FakeOpener {
  readonly commands: OpenCommand[] = [];
  works = true;
  readonly run = (command: OpenCommand): Promise<boolean> => {
    this.commands.push(command);
    return Promise.resolve(this.works);
  };
}

const LOCAL_LINUX = { platform: 'linux', env: {} } as const;

async function open(
  api: FakeSettingsApi,
  options: {
    runLocal?: (command: string) => Promise<number | null>;
    opener?: FakeOpener;
    environment?: OpenPorts['environment'];
    browser?: 'auto' | 'key' | 'off';
    columns?: number;
    mouseWrites?: string[];
    mouseClipboard?: RenderAppOptions['mouseClipboard'];
    clipboardCopy?: UiSettings['clipboardCopy'];
    /** The text that says the tab is drawn (an account, by default). */
    ready?: string;
  } = {},
): Promise<{ app: RenderedApp; online: FakeOnline; opener: FakeOpener }> {
  const online = fakeOnline();
  seedStores(online.stores);
  const opener = options.opener ?? new FakeOpener();
  const tabContent: TabContentMap = {
    settings: createSettingsTab({
      api,
      now: () => NOW,
      runLocal: options.runLocal,
      open: { run: opener.run, environment: options.environment ?? LOCAL_LINUX },
    }),
  };
  const app = await renderApp({
    connector: online.connector,
    size: { columns: options.columns ?? 140, rows: 60 },
    tabContent,
    settings: {
      ...TEST_UI_SETTINGS,
      login: { browser: options.browser ?? 'off' },
      clipboardCopy: options.clipboardCopy ?? TEST_UI_SETTINGS.clipboardCopy,
    },
    mouseWrites: options.mouseWrites,
    mouseClipboard: options.mouseClipboard,
  });
  await app.waitForText('SCENARIOS');
  app.press('\x1b[15~');
  await app.waitForText(options.ready ?? 'claude-code/main');
  return { app, online, opener };
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

/** The text of the right column (the tab) of each row of the frame, trimmed. */
function panelRows(frame: string): string[] {
  return frame.split('\n').map((line) => {
    const parts = line.split(/[│┃]/);
    return (parts.at(-2) ?? '').trim();
  });
}

/** The text of the tab as one line: the wrapping of the narrow column does not matter to a message. */
function flat(frame: string): string {
  return panelRows(frame)
    .filter((row) => row !== '')
    .join(' ');
}

const LONG_URL =
  'https://auth.example.test/oauth/authorize?client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fcallback.example.test%2Fcb&scope=' +
  'a'.repeat(120) +
  '&state=' +
  'b'.repeat(120) +
  '&code_challenge=zz';

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

  it('says how to add an account when there is none: the bar has A, L and W, and L names them (N324)', async () => {
    const api = new FakeSettingsApi();
    api.accounts = [];
    const { app } = await open(api, { ready: 'No account yet', columns: 260 });
    const frame = await app.settle();
    expect(flat(frame)).toContain('No account yet. A adds one; W opens the assistant.');
    expect(frame).toContain('Add account');
    expect(frame).toContain('Log in');
    expect(frame).toContain('Assistant');
    const after = await key(app, 'l');
    expect(flat(after)).toContain('No account yet: A adds one; W opens the assistant.');
    expect(after).not.toContain('Nothing under the cursor');
    expect(api.loginsStarted).toEqual([]);
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

  describe('the address of the sign-in (ui.login.browser)', () => {
    async function openLogin(
      options: Parameters<typeof open>[1] = {},
      url: string = LONG_URL,
      takesCode = true,
    ): Promise<{ app: RenderedApp; opener: FakeOpener; api: FakeSettingsApi }> {
      const api = new FakeSettingsApi();
      api.loginAnswer = { ...(api.loginAnswer as object), url, takesCode } as never;
      const { app, opener } = await open(api, { columns: 140, ...options });
      await key(app, 'l');
      await app.waitForText('Address:');
      return { app, opener, api };
    }

    it('shows the whole address on rows, nothing cut, each row inside the same OSC 8 link', async () => {
      const { app } = await openLogin({ columns: 100 });
      const frame = await app.settle();
      const rows = panelRows(frame);
      const start = rows.indexOf('Address:');
      const end = rows.findIndex((row, index) => index > start && row.startsWith('Ctrl+'));
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start + 3);
      expect(rows.slice(start + 1, end).join('')).toBe(LONG_URL);
      const raw = app.rawFrame();
      const opening = `\x1b]8;id=otheater-login;${LONG_URL}\x1b\\`;
      expect(raw.split(opening).length - 1).toBe(end - start - 1);
      expect(raw.split('\x1b]8;;\x1b\\').length - 1).toBe(end - start - 1);
      expect(plain(raw)).not.toContain('\x1b');
    });

    it('opens the whole address with Ctrl+O in the browser command of the system and says so', async () => {
      const { app, opener } = await openLogin({ browser: 'key' });
      expect(opener.commands).toEqual([]);
      const frame = await key(app, '\x0f');
      expect(opener.commands).toEqual([{ command: 'xdg-open', args: [LONG_URL] }]);
      expect(flat(frame)).toContain('Opened in the browser (xdg-open).');
    });

    it('uses open on macOS and rundll32 on Windows, with the address as one argument', async () => {
      const mac = await openLogin({ browser: 'key', environment: { platform: 'darwin', env: {} } });
      await key(mac.app, '\x0f');
      expect(mac.opener.commands).toEqual([{ command: 'open', args: [LONG_URL] }]);
      const win = await openLogin({ browser: 'key', environment: { platform: 'win32', env: {} } });
      await key(win.app, '\x0f');
      expect(win.opener.commands).toEqual([
        { command: 'rundll32', args: ['url.dll,FileProtocolHandler', LONG_URL] },
      ]);
    });

    it('does not open over SSH and says to copy the address instead', async () => {
      const { app, opener } = await openLogin({
        browser: 'key',
        environment: { platform: 'linux', env: { SSH_TTY: '/dev/pts/3' } },
      });
      const frame = await key(app, '\x0f');
      expect(opener.commands).toEqual([]);
      expect(flat(frame)).toContain('runs over SSH');
      expect(flat(frame)).toContain('Ctrl+Y');
    });

    it('does not open an address that is not http or https, and does not make it a link', async () => {
      const { app, opener } = await openLogin({ browser: 'key' }, 'file:///etc/passwd?client_id=x');
      const frame = await key(app, '\x0f');
      expect(opener.commands).toEqual([]);
      expect(flat(frame)).toContain('Only http and https addresses are opened.');
      expect(app.rawFrame()).not.toContain('\x1b]8;');
    });

    it('says when the opener could not start', async () => {
      const opener = new FakeOpener();
      opener.works = false;
      const { app } = await openLogin({ browser: 'key', opener });
      const frame = await key(app, '\x0f');
      expect(opener.commands).toHaveLength(1);
      expect(flat(frame)).toContain('Could not start xdg-open.');
    });

    it('copies the whole address with Ctrl+Y through the terminal and says which route', async () => {
      const writes: string[] = [];
      const { app } = await openLogin({ mouseWrites: writes });
      const frame = await key(app, '\x19');
      const sequence = writes.find((write) => write.includes(']52;'));
      expect(sequence).toBeDefined();
      const payload = /\]52;[a-z]*;([A-Za-z0-9+/=]+)/.exec(sequence ?? '')?.[1] ?? '';
      expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(LONG_URL);
      expect(flat(frame)).toContain(
        `Sent ${String(LONG_URL.length)} characters to the clipboard through the terminal (OSC 52).`,
      );
      expect(flat(frame)).toContain(
        'Set ui.clipboard.copy to auto or system to use wl-copy or xclip.',
      );
    });

    it('copies with the clipboard tool of the system when ui.clipboard.copy says so', async () => {
      const ran: { command: string; text: string }[] = [];
      const writes: string[] = [];
      const { app } = await openLogin({
        mouseWrites: writes,
        clipboardCopy: 'system',
        mouseClipboard: {
          environment: { platform: 'linux', env: { DISPLAY: ':0' } },
          tmux: false,
          run: (tool, text) => {
            ran.push({ command: tool.command, text });
            return Promise.resolve(true);
          },
        },
      });
      const frame = await key(app, '\x19');
      await waitUntil(() => ran.length === 1);
      expect(ran[0]?.text).toBe(LONG_URL);
      expect(writes.some((write) => write.includes(']52;'))).toBe(false);
      expect(flat(await app.settle())).toContain(
        `Copied ${String(LONG_URL.length)} characters with the clipboard tool of the system.`,
      );
      expect(frame).toContain('Address:');
    });

    it('lets the keys of the address stay out of the code field', async () => {
      const { app, opener, api } = await openLogin({ browser: 'key' });
      await type(app, 'abc');
      await key(app, '\x0f');
      await key(app, '\x19');
      await type(app, '-1');
      await key(app, '\r');
      await waitUntil(() => api.codes.length === 1);
      expect(api.codes).toEqual(['abc-1']);
      expect(opener.commands).toHaveLength(1);
    });

    it('opens on its own once with auto, and the key opens it again', async () => {
      const { app, opener } = await openLogin({ browser: 'auto' });
      await waitUntil(() => opener.commands.length === 1);
      expect(opener.commands).toEqual([{ command: 'xdg-open', args: [LONG_URL] }]);
      await key(app, '\x0f');
      expect(opener.commands).toHaveLength(2);
    });

    it('does not open on its own with key or off, and off says so on the key', async () => {
      const onKey = await openLogin({ browser: 'key' });
      await onKey.app.settle();
      expect(onKey.opener.commands).toEqual([]);
      const off = await openLogin({ browser: 'off' });
      await off.app.settle();
      expect(off.opener.commands).toEqual([]);
      const frame = await key(off.app, '\x0f');
      expect(off.opener.commands).toEqual([]);
      expect(flat(frame)).toContain('Opening the browser is off (ui.login.browser).');
      expect(flat(frame)).not.toContain('Ctrl+O opens');
    });

    it('does not open on its own over SSH even with auto', async () => {
      const { app, opener } = await openLogin({
        browser: 'auto',
        environment: { platform: 'linux', env: { SSH_CONNECTION: '1 2 3 4' } },
      });
      await app.settle();
      expect(opener.commands).toEqual([]);
    });
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

  it('gives the terminal to the login with the mouse off, and turns the mouse on again after', async () => {
    const api = new FakeSettingsApi();
    api.loginAnswer = {
      status: 'local',
      profileId: 'claude-code/main',
      mode: 'terminal',
      command: 'fake-cli login --profile main',
    };
    const mouseWrites: string[] = [];
    let whileLogin: string[] = [];
    const { app } = await open(api, {
      mouseWrites,
      runLocal: () => {
        whileLogin = [...mouseWrites];
        // What a client does when it ends: it turns the mouse reports off.
        mouseWrites.push(MOUSE_DISABLE_SEQUENCE);
        return Promise.resolve(0);
      },
    });
    await key(app, 'l');
    await app.waitForText('terminal');
    expect(whileLogin.at(-1)).toBe(MOUSE_DISABLE_SEQUENCE);
    expect(mouseWrites.at(-1)).toBe(mouseEnableSequence('full'));
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

  describe('the login that goes with a new account (profiles.add.login)', () => {
    const ADD_CODEX = 'codex alt token_plan codex';

    async function addAccount(app: RenderedApp, form = ADD_CODEX): Promise<void> {
      await key(app, 'a');
      await type(app, form);
      await key(app, '\r');
    }

    it('ask: y after "Account added" starts the login of the new account, the same one as L', async () => {
      const api = new FakeSettingsApi();
      api.addLogin = 'ask';
      const { app } = await open(api);
      await addAccount(app);
      const frame = await app.waitForText('Log in now?');
      expect(flat(frame)).toContain('codex/alt was added');
      expect(api.loginsStarted).toEqual([]);
      await key(app, 'y');
      await waitUntil(() => api.loginsStarted.length === 1);
      expect(api.loginsStarted).toEqual(['codex/alt']);
      await app.waitForText('https://login.example.test/oauth?state=abc');
    });

    it('ask: any other key leaves the login for later', async () => {
      const api = new FakeSettingsApi();
      api.addLogin = 'ask';
      const { app } = await open(api);
      await addAccount(app);
      await app.waitForText('Log in now?');
      await key(app, 'n');
      const frame = await app.settle();
      expect(frame).not.toContain('Log in now?');
      expect(frame).toContain('codex/alt');
      expect(api.loginsStarted).toEqual([]);
    });

    it('ask: with the notice of a second subscription, the question comes after the acceptance', async () => {
      const api = new FakeSettingsApi();
      api.addLogin = 'ask';
      api.noticeFirst = true;
      const { app } = await open(api);
      await addAccount(app, 'claude-code second token_plan claude');
      await app.waitForText('claude-code/main');
      await key(app, 'y');
      await app.waitForText('Log in now?');
      await key(app, 'y');
      await waitUntil(() => api.loginsStarted.length === 1);
      expect(api.loginsStarted).toEqual(['claude-code/second']);
    });

    it('auto: starts the login without asking, and a login that stays at the terminal runs there', async () => {
      const api = new FakeSettingsApi();
      api.addLogin = 'auto';
      api.loginAnswer = {
        status: 'local',
        profileId: 'codex/alt',
        mode: 'terminal',
        command: 'fake-cli login --profile alt',
      };
      const ran: string[] = [];
      const { app } = await open(api, {
        runLocal: (command) => {
          ran.push(command);
          return Promise.resolve(0);
        },
      });
      await addAccount(app);
      await waitUntil(() => ran.length === 1);
      expect(api.loginsStarted).toEqual(['codex/alt']);
      expect(ran).toEqual(['fake-cli login --profile alt']);
      expect(app.frame()).not.toContain('Log in now?');
    });

    it('off: does not ask and does not start the login', async () => {
      const api = new FakeSettingsApi();
      api.addLogin = 'off';
      const { app } = await open(api);
      await addAccount(app);
      const frame = await app.waitForText('Account added: codex/alt');
      expect(frame).not.toContain('Log in now?');
      expect(api.loginsStarted).toEqual([]);
    });

    it.each(['ask', 'auto'] as const)(
      'does nothing for an API account when the mode is %s',
      async (mode) => {
        const api = new FakeSettingsApi();
        api.addLogin = mode;
        const { app } = await open(api);
        await addAccount(app, 'opencode zen api openai');
        await app.waitForText('API key');
        await type(app, 'sk-fake');
        await key(app, '\r');
        await waitUntil(() => api.added.length === 1);
        await app.waitForText('opencode/zen');
        expect(app.frame()).not.toContain('Log in now?');
        expect(api.loginsStarted).toEqual([]);
      },
      15_000,
    );

    it('does nothing for an account that already has a login', async () => {
      const api = new FakeSettingsApi();
      api.addLogin = 'auto';
      api.newLogin = 'logged_in';
      const { app } = await open(api);
      await addAccount(app);
      await app.waitForText('codex/alt');
      expect(api.loginsStarted).toEqual([]);
    }, 15_000);
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
