// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonObject, JsonValue } from '@otheater/core';
import { FakeBrowserSession, InMemoryStore } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { ToolFailure, ToolWithImage, type ToolCall, type ToolCaller } from '../mcp/handlers.js';
import { buildDaemonRegistries } from '../registries.js';
import { ToolRefusal } from '../tools/context.js';
import {
  ATTEMPT_ID,
  DEMAND_ID,
  PLAY_ID,
  eventsOf,
  makeToolsRig,
  realClock,
  type ToolsRig,
  type ToolsRigOptions,
} from '../tools/tools-fixture.js';
import { BrowserTools, type BrowserToolsDeps } from './handlers.js';
import type { AskApproval } from './approval.js';

const registries = buildDaemonRegistries();

interface Setup {
  readonly rig: ToolsRig;
  readonly session: FakeBrowserSession;
  readonly tools: BrowserTools;
  readonly dataDir: string;
  call(name: string, input: unknown, caller?: Partial<ToolCaller>): Promise<unknown>;
  fail(name: string, input: unknown, caller?: Partial<ToolCaller>): Promise<ToolFailure>;
}

const cleanups: (() => Promise<void>)[] = [];

interface SetupOptions extends ToolsRigOptions {
  /** The global `browser:` block, as YAML lines under `browser:`. */
  readonly browser?: string;
  readonly askApproval?: AskApproval | undefined;
  readonly isSecret?: BrowserToolsDeps['isSecret'];
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const rig = await makeToolsRig(options, {
    store: new InMemoryStore({ clock: realClock }),
    clock: realClock,
  });
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'otheater-browser-data-')));
  const session = new FakeBrowserSession();
  const browser = parseConfig(
    options.browser === undefined ? '' : `browser:\n${options.browser}\n`,
  ).browser;
  const tools = new BrowserTools({
    ...rig.deps,
    browser,
    session,
    dataDir,
    askApproval: options.askApproval,
    isSecret: options.isSecret,
  });
  const handlers = tools.handlers();
  cleanups.push(async () => {
    await tools.close();
    await rig.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  function callOf(name: string, input: unknown, caller: Partial<ToolCaller>): ToolCall {
    const tool = registries.tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return {
      tool,
      input: tool.input.parse(input),
      caller: {
        role: 'actor',
        attemptId: ATTEMPT_ID,
        sessionId: undefined,
        correlation: { playId: PLAY_ID, demandId: DEMAND_ID, attemptId: ATTEMPT_ID },
        worktree: rig.worktree,
        networkAllow: options.networkAllow ?? [],
        record: (event) => {
          rig.events.push(event);
          return Promise.resolve();
        },
        ...caller,
      },
    };
  }
  async function call(name: string, input: unknown, caller: Partial<ToolCaller> = {}) {
    const handler = handlers[name];
    if (handler === undefined) throw new Error(`no handler ${name}`);
    return await handler(callOf(name, input, caller));
  }
  return {
    rig,
    session,
    tools,
    dataDir,
    call,
    async fail(name, input, caller) {
      try {
        await call(name, input, caller);
      } catch (error) {
        if (error instanceof ToolFailure) return error;
        throw error;
      }
      throw new Error(`${name} did not fail`);
    },
  };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const PAGE_URL = 'http://localhost:4173/app';
const TREE = '- button "Save" [ref=e1]\n- textbox "Name" [ref=e2]';

function withPage(s: Setup): void {
  s.session.addPage(PAGE_URL, { title: 'App', text: 'hello world', tree: TREE });
}

/** An approval channel the test answers by hand. */
function channel() {
  const asked: { scenarioId: string; question: string }[] = [];
  const answers: ((value: JsonValue) => void)[] = [];
  const ask: AskApproval = (scenarioId, input) => {
    asked.push({ scenarioId, question: input.questions[0]?.question ?? '' });
    const answer = new Promise<JsonValue>((resolve) => answers.push(resolve));
    return Promise.resolve({ decisionId: `dec-${String(asked.length)}`, answer });
  };
  return { ask, asked, answer: (index: number, value: JsonValue) => answers[index]?.(value) };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** The payload of the event at `index` (negative counts from the end); fails the test when absent. */
function payloadAt(events: readonly { readonly payload: JsonObject }[], index: number): JsonObject {
  const event = events.at(index);
  if (event === undefined) throw new Error(`no event at ${String(index)}`);
  return event.payload;
}

describe('the browser tools, with the defaults of N40', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
    withPage(s);
  });

  it('open, read, screenshot and click work with no approval', async () => {
    const opened = await s.call('browser_open', { url: PAGE_URL });
    expect(opened).toMatchObject({ url: PAGE_URL, title: 'App', untrusted: true });

    const read = await s.call('browser_read', {});
    expect(read).toMatchObject({
      text: 'hello world',
      tree: TREE,
      truncated: false,
      untrusted: true,
    });

    const shot = await s.call('browser_screenshot', {});
    expect(shot).toBeInstanceOf(ToolWithImage);

    const clicked = await s.call('browser_click', { ref: 'e1' });
    expect(clicked).toMatchObject({ url: PAGE_URL, reused: false, untrusted: true });
    expect(s.session.callCount('click')).toBe(1);
    expect(s.session.calls.find((c) => c.method === 'open')?.scenarioId).toBe('s1');
  });

  it('records browser.action with the URL, and a screenshot file for a write', async () => {
    await s.call('browser_open', { url: PAGE_URL });
    await s.call('browser_click', { ref: 'e1' });
    const actions = eventsOf(s.rig, 'browser.action');
    expect(actions.map((e) => e.payload.action)).toEqual(['open', 'click']);
    const click = payloadAt(actions, 1);
    expect(click).toMatchObject({ outcome: 'ok', url: PAGE_URL, ref: 'e1', scenarioId: 's1' });
    expect(click.idempotencyKey).toBe(`${PLAY_ID}:browser_click:${ATTEMPT_ID}:1`);
    // the path is relative to the data directory
    const shot = click.screenshot as string;
    expect(typeof shot).toBe('string');
    expect(shot.startsWith(join('browser', 's1'))).toBe(true);
    expect(existsSync(join(s.dataDir, shot))).toBe(true);
    // action_screenshots "writes": the open and the read leave none
    expect(payloadAt(actions, 0).screenshot).toBeUndefined();
  });

  it('saves the screenshot of browser_screenshot as a PNG under the data dir', async () => {
    await s.call('browser_open', { url: PAGE_URL });
    await s.call('browser_screenshot', {});
    const action = payloadAt(eventsOf(s.rig, 'browser.action'), -1);
    const bytes = await readFile(join(s.dataDir, action.screenshot as string));
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  });

  it('never puts what was typed in an event or in the side effect', async () => {
    await s.call('browser_open', { url: PAGE_URL });
    await s.call('browser_fill', { ref: 'e2', value: 'correct-horse-battery' });
    const fill = payloadAt(eventsOf(s.rig, 'browser.action'), -1);
    expect(fill.valueChars).toBe(21);
    expect(JSON.stringify(s.rig.events)).not.toContain('correct-horse');
    const effects = await s.rig.store.sideEffects.list({ types: ['browser_fill'] });
    expect(effects).toHaveLength(1);
    expect(JSON.stringify(effects)).not.toContain('correct-horse');
    expect(effects[0]).toMatchObject({ state: 'done', target: 'localhost' });
  });

  it('a write before any page is a no_page failure; an unknown ref is not_found', async () => {
    expect((await s.fail('browser_click', { ref: 'e1' })).code).toBe('no_page');
    await s.call('browser_open', { url: PAGE_URL });
    expect((await s.fail('browser_click', { ref: 'e99' })).code).toBe('not_found');
  });

  it('clicks the same button twice when the agent does it twice (a step for each)', async () => {
    await s.call('browser_open', { url: PAGE_URL });
    await s.call('browser_click', { ref: 'e1' });
    await s.call('browser_click', { ref: 'e1' });
    expect(s.session.callCount('click')).toBe(2);
    const keys = (await s.rig.store.sideEffects.list({ types: ['browser_click'] })).map(
      (r) => r.idempotencyKey,
    );
    expect(keys).toEqual([
      `${PLAY_ID}:browser_click:${ATTEMPT_ID}:1`,
      `${PLAY_ID}:browser_click:${ATTEMPT_ID}:2`,
    ]);
  });

  it('cuts the text at read_max_chars and says so', async () => {
    const small = await setup({ browser: '  read_max_chars: 5' });
    withPage(small);
    await small.call('browser_open', { url: PAGE_URL });
    const read = (await small.call('browser_read', {})) as JsonObject;
    expect(read.text).toBe('hello');
    expect(read.truncated).toBe(true);
  });

  it('maps an invalid URL to a refusal and writes browser.refused', async () => {
    const failure = await s.fail('browser_open', { url: 'ftp://example.com/x' });
    expect(failure).toBeInstanceOf(ToolRefusal);
    expect(failure.code).toBe('invalid_url');
    const refused = eventsOf(s.rig, 'browser.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.payload).toMatchObject({ kind: 'call', code: 'invalid_url' });
    expect(payloadAt(eventsOf(s.rig, 'browser.action'), 0).outcome).toBe('refused');
  });
});

describe('browser.write_approval', () => {
  it('"always" asks the Producer BEFORE the click, and clicks on Allow', async () => {
    const chat = channel();
    const s = await setup({
      askApproval: chat.ask,
      configOverride: { browser: { write_approval: 'always' } },
    });
    withPage(s);
    await s.call('browser_open', { url: PAGE_URL });
    // looking is free: only the actions ask
    await s.call('browser_read', {});
    expect(chat.asked).toHaveLength(0);

    const pending = s.call('browser_click', { ref: 'e1' });
    await tick();
    expect(chat.asked).toHaveLength(1);
    expect(chat.asked[0]?.scenarioId).toBe('s1');
    expect(chat.asked[0]?.question).toContain('localhost');
    expect(s.session.callCount('click')).toBe(0);

    chat.answer(0, 'Allow');
    await expect(pending).resolves.toMatchObject({ reused: false });
    expect(s.session.callCount('click')).toBe(1);
    const states = eventsOf(s.rig, 'browser.approval').map((e) => e.payload.state);
    expect(states).toEqual(['requested', 'granted']);
  });

  it('a Deny, an unexpected answer and both options all mean no, and nothing is clicked', async () => {
    const chat = channel();
    const s = await setup({
      askApproval: chat.ask,
      configOverride: { browser: { write_approval: 'always' } },
    });
    withPage(s);
    await s.call('browser_open', { url: PAGE_URL });
    for (const [index, answer] of (
      [['Deny'], ['ok sure'], [['Allow', 'Deny']]] as const
    ).entries()) {
      const pending = s.fail('browser_click', { ref: 'e1' });
      await tick();
      chat.answer(index, answer[0] as JsonValue);
      const failure = await pending;
      expect(failure).toBeInstanceOf(ToolRefusal);
      expect(failure.code).toBe('approval_denied');
    }
    expect(s.session.callCount('click')).toBe(0);
    expect(chat.asked).toHaveLength(3);
    expect(await s.rig.store.sideEffects.list({ types: ['browser_click'] })).toHaveLength(0);
  });

  it('"per_domain" asks once for a domain and remembers the yes', async () => {
    const chat = channel();
    const s = await setup({
      askApproval: chat.ask,
      configOverride: { browser: { write_approval: 'per_domain' } },
    });
    withPage(s);
    await s.call('browser_open', { url: PAGE_URL });
    const first = s.call('browser_click', { ref: 'e1' });
    await tick();
    chat.answer(0, 'Allow');
    await first;
    await s.call('browser_click', { ref: 'e1' });
    await s.call('browser_press_key', { key: 'Enter' });
    expect(chat.asked).toHaveLength(1);
    expect(s.session.callCount('click')).toBe(2);
    const approvals = eventsOf(s.rig, 'browser.approval').map((e) => e.payload.state);
    expect(approvals).toEqual(['requested', 'granted', 'granted', 'granted']);
  });

  it('refuses when nobody can be asked: never a yes by default', async () => {
    const s = await setup({
      askApproval: undefined,
      configOverride: { browser: { write_approval: 'always' } },
    });
    withPage(s);
    await s.call('browser_open', { url: PAGE_URL });
    const failure = await s.fail('browser_click', { ref: 'e1' });
    expect(failure).toBeInstanceOf(ToolRefusal);
    expect(failure.code).toBe('approval_unavailable');
    expect(s.session.callCount('click')).toBe(0);
  });

  it('an approval that is cancelled fails the call without clicking', async () => {
    const s = await setup({
      askApproval: () =>
        Promise.resolve({ decisionId: 'd', answer: Promise.reject(new Error('cancelled')) }),
      configOverride: { browser: { write_approval: 'always' } },
    });
    withPage(s);
    await s.call('browser_open', { url: PAGE_URL });
    expect((await s.fail('browser_click', { ref: 'e1' })).code).toBe('approval_cancelled');
    expect(s.session.callCount('click')).toBe(0);
  });
});

describe('browser.domains, blocked_domains and local_urls', () => {
  it('"allowlist" refuses a domain outside the network.allow of the role', async () => {
    const s = await setup({
      networkAllow: ['example.com'],
      configOverride: { browser: { domains: 'allowlist' } },
    });
    s.session.addPage('https://example.com/', { title: 'Example' });
    await expect(s.call('browser_open', { url: 'https://example.com/' })).resolves.toMatchObject({
      title: 'Example',
    });
    const failure = await s.fail('browser_open', { url: 'https://other.test/' });
    expect(failure).toBeInstanceOf(ToolRefusal);
    expect(failure.code).toBe('domain_not_allowed');
    expect(failure.message).toContain('example.com');
    const refused = eventsOf(s.rig, 'browser.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.payload).toMatchObject({ kind: 'call', code: 'domain_not_allowed' });
  });

  it('opens localhost by default, and refuses it with local_urls "deny"', async () => {
    const open = await setup();
    open.session.addPage('http://localhost:3000/', { title: 'Dev server' });
    await expect(
      open.call('browser_open', { url: 'http://localhost:3000/' }),
    ).resolves.toMatchObject({
      title: 'Dev server',
    });
    const closed = await setup({ configOverride: { browser: { local_urls: 'deny' } } });
    const failure = await closed.fail('browser_open', { url: 'http://localhost:3000/' });
    expect(failure.code).toBe('local_url_denied');
    expect((await closed.fail('browser_open', { url: 'http://192.168.1.1/' })).code).toBe(
      'local_url_denied',
    );
  });

  it('blocked_domains refuses a host in any mode', async () => {
    const s = await setup({ configOverride: { browser: { blocked_domains: ['*.evil.test'] } } });
    expect((await s.fail('browser_open', { url: 'https://a.evil.test/' })).code).toBe(
      'domain_blocked',
    );
  });

  it('a scenario cannot override the keys of the machine (sandbox, max_instances...)', async () => {
    const s = await setup({ configOverride: { browser: { sandbox: false } } });
    const failure = await s.fail('browser_open', { url: PAGE_URL });
    expect(failure.code).toBe('invalid_config');
  });
});

describe('file:// URLs, enforced by the daemon', () => {
  let home: string;
  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'otheater-fake-home-')));
    await mkdir(join(home, '.ssh'));
    await writeFile(join(home, '.ssh', 'id_fake'), 'FAKE-KEY');
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('opens a file of the worktree: the browser gets the daemon origin, the agent sees file:///', async () => {
    const s = await setup({ isSecret: (path) => path.startsWith(join(home, '.ssh')) });
    await s.rig.write('page.html', '<h1>hi</h1>');
    const path = join(s.rig.worktree, 'page.html');
    s.session.addPage(pathToFileURL(path).href, { title: 'never' }); // the fake is asked for another URL
    const opened = (await s.call('browser_open', { url: pathToFileURL(path).href })) as JsonObject;
    expect(opened.url).toBe(pathToFileURL(path).href);
    const asked = s.session.calls.find((c) => c.method === 'open')?.args[0] as string;
    expect(asked).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/files\/[A-Za-z0-9_-]+\//);
    // the token is not in anything the agent or the log sees
    const token = /\/files\/([A-Za-z0-9_-]+)\//.exec(asked)?.[1] ?? '';
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(opened)).not.toContain(token);
    expect(JSON.stringify(s.rig.events)).not.toContain(token);
  });

  it('refuses a path of the secret list (fake list, temporary HOME) and never opens the browser on it', async () => {
    const s = await setup({ isSecret: (path) => path.startsWith(join(home, '.ssh')) });
    const failure = await s.fail('browser_open', {
      url: pathToFileURL(join(home, '.ssh', 'id_fake')).href,
    });
    expect(failure).toBeInstanceOf(ToolRefusal);
    expect(failure.code).toBe('secret_path');
    expect(s.session.callCount('open')).toBe(0);
    expect(eventsOf(s.rig, 'browser.refused')[0]?.payload).toMatchObject({
      kind: 'call',
      code: 'secret_path',
    });
  });

  it('fails closed for except_secrets while the list of P4 is not wired', async () => {
    const s = await setup();
    await s.rig.write('page.html', 'x');
    const failure = await s.fail('browser_open', {
      url: pathToFileURL(join(s.rig.worktree, 'page.html')).href,
    });
    expect(failure.code).toBe('secret_list_unavailable');
  });

  it('file_urls "deny" opens nothing, "any" opens a secret, "scenario" stays in the folders', async () => {
    const deny = await setup({ configOverride: { browser: { file_urls: 'deny' } } });
    await deny.rig.write('a.html', 'x');
    expect(
      (
        await deny.fail('browser_open', {
          url: pathToFileURL(join(deny.rig.worktree, 'a.html')).href,
        })
      ).code,
    ).toBe('file_urls_denied');

    const any = await setup({ configOverride: { browser: { file_urls: 'any' } } });
    await expect(
      any.call('browser_open', { url: pathToFileURL(join(home, '.ssh', 'id_fake')).href }),
    ).resolves.toMatchObject({ untrusted: true });

    const scoped = await setup({ configOverride: { browser: { file_urls: 'scenario' } } });
    await scoped.rig.write('a.html', 'x');
    await expect(
      scoped.call('browser_open', { url: pathToFileURL(join(scoped.rig.worktree, 'a.html')).href }),
    ).resolves.toMatchObject({ untrusted: true });
    expect(
      (
        await scoped.fail('browser_open', {
          url: pathToFileURL(join(home, '.ssh', 'id_fake')).href,
        })
      ).code,
    ).toBe('outside_scenario');
  });

  it('a missing file is file_not_found, not a refusal', async () => {
    const s = await setup({ configOverride: { browser: { file_urls: 'any' } } });
    const failure = await s.fail('browser_open', {
      url: pathToFileURL(join(s.rig.worktree, 'missing.html')).href,
    });
    expect(failure.code).toBe('file_not_found');
    expect(failure).not.toBeInstanceOf(ToolRefusal);
  });
});

describe('a write that may or may not have happened (restart)', () => {
  it('says ambiguous once, then clicks again under the next key', async () => {
    const s = await setup();
    withPage(s);
    await s.call('browser_open', { url: PAGE_URL });
    // A click the daemon began and never ended: the record is `pending`.
    const callHash = createHash('sha256')
      .update(JSON.stringify(['click', 'e1', null, null]))
      .digest('hex')
      .slice(0, 16);
    const key = `${PLAY_ID}:browser_click:${ATTEMPT_ID}:1`;
    await s.rig.store.sideEffects.intend({
      idempotencyKey: key,
      type: 'browser_click',
      target: 'localhost',
      attemptId: ATTEMPT_ID,
      params: { callHash },
    });

    const failure = await s.fail('browser_click', { ref: 'e1' });
    expect(failure.code).toBe('ambiguous');
    expect(s.session.callCount('click')).toBe(0);
    expect((await s.rig.store.sideEffects.get(key))?.state).toBe('ambiguous');

    await expect(s.call('browser_click', { ref: 'e1' })).resolves.toMatchObject({ reused: false });
    expect(s.session.callCount('click')).toBe(1);
    const actions = eventsOf(s.rig, 'browser.action');
    expect(payloadAt(actions, -1).idempotencyKey).toBe(`${key}~2`);
  });
});

describe('the life of a scenario', () => {
  it('closes the page of a scenario that was idle for idle_close_ms, and only that one', async () => {
    const s = await setup({ browser: '  idle_close_ms: 50' });
    withPage(s);
    await s.call('browser_open', { url: PAGE_URL });
    expect(await s.tools.sweep()).toEqual([]);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(await s.tools.sweep()).toEqual(['s1']);
    expect(s.session.calls.some((c) => c.method === 'closeScenario' && c.scenarioId === 's1')).toBe(
      true,
    );
    expect(await s.session.state('s1')).toBeUndefined();
  });

  it('idle_close_ms 0 never closes', async () => {
    const s = await setup({ browser: '  idle_close_ms: 0' });
    withPage(s);
    await s.call('browser_open', { url: PAGE_URL });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(await s.tools.sweep()).toEqual([]);
  });

  it('endScenario closes its page, and close() leaves the session to the composition', async () => {
    const s = await setup();
    withPage(s);
    await s.call('browser_open', { url: PAGE_URL });
    await s.tools.endScenario('s1');
    expect(await s.session.state('s1')).toBeUndefined();
    await s.tools.close();
    await s.tools.close();
    expect(s.session.closed).toBe(false);
  });

  it('answers unavailable when the adapter has no browser to run', async () => {
    const s = await setup();
    const { AdapterUnavailable } = await import('@otheater/core');
    s.session.open = () => Promise.reject(new AdapterUnavailable('no chromium'));
    const failure = await s.fail('browser_open', { url: PAGE_URL });
    expect(failure.code).toBe('unavailable');
  });
});
