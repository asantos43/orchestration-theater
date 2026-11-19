// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject, JsonValue } from '@otheater/core';
import { InMemoryStore } from '@otheater/core/testing';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { defaultBrowser, defaultLauncher } from '../compose.js';
import { parseConfig } from '../config.js';
import { ToolFailure, type ToolCall, type ToolCaller } from '../mcp/handlers.js';
import { buildDaemonRegistries } from '../registries.js';
import {
  ATTEMPT_ID,
  DEMAND_ID,
  PLAY_ID,
  eventsOf,
  makeToolsRig,
  realClock,
  type ToolsRig,
} from '../tools/tools-fixture.js';
import type { AskApproval } from './approval.js';
import { BrowserTools } from './handlers.js';
import { NO_LAUNCHER } from '../launcher-fixture.js';

/**
 * Acceptance of P6 (architecture 5.19) with a REAL Chromium, built the way the daemon builds it:
 * `defaultBrowser(...)` of the composition, no adapter imported here. The pages are served by THIS
 * test on 127.0.0.1 (never the internet), a test opens at most one browser, and `afterEach` closes
 * it. Where Chromium is not installed the tests are skipped with a message (and fail on CI, where
 * it must be: the `linux` job downloads it). The secrets are fakes in a temporary HOME; no real
 * secret path is read.
 */
const registries = buildDaemonRegistries();
const ON_CI = process.env.CI !== undefined;
/** Only the `linux` job downloads Chromium (N95); on another platform a missing browser is a skip. */
const MUST_RUN = ON_CI && process.platform === 'linux';

const PAGE = `<html><head><title>Acceptance</title></head><body>
<h1>Hello</h1><p>some text here</p>
<input aria-label="Name" id="n">
<button id="b" onclick="document.title='clicked'">Go</button>
</body></html>`;

let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/' || req.url === '/app' ? PAGE : '<title>other</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  origin = String(address.port);
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

interface Run {
  readonly rig: ToolsRig;
  readonly tools: BrowserTools;
  readonly home: string;
  call(name: string, input: unknown): Promise<unknown>;
  fail(name: string, input: unknown): Promise<ToolFailure>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface RunOptions {
  readonly browser?: JsonObject;
  readonly networkAllow?: string[];
  readonly askApproval?: AskApproval;
  readonly isSecret?: (path: string) => boolean;
}

async function start(options: RunOptions = {}): Promise<Run> {
  const rig = await makeToolsRig(
    { configOverride: { browser: options.browser ?? {} } },
    { store: new InMemoryStore({ clock: realClock }), clock: realClock },
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-browser-acc-')));
  const home = join(root, 'home');
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'id_fake'), 'FAKE-PRIVATE-KEY-DO-NOT-LEAK');
  // The CI runners refuse the user namespaces of the Chromium sandbox.
  const config = parseConfig(`browser:\n  sandbox: ${String(!ON_CI)}\n  timeout_ms: 30000\n`);
  const session = defaultBrowser(
    config,
    join(root, 'profiles'),
    defaultLauncher(),
    pino({ level: 'silent' }),
  );
  if (session === undefined) throw new Error('no launcher on this platform');
  const tools = new BrowserTools({
    ...rig.deps,
    browser: config.browser,
    session,
    dataDir: join(root, 'data'),
    askApproval: options.askApproval,
    isSecret: options.isSecret,
  });
  const handlers = tools.handlers();
  cleanups.push(async () => {
    await tools.close();
    await session.close();
    await rig.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const callOf = (name: string, input: unknown): ToolCall => {
    const tool = registries.tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    const caller: ToolCaller = {
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
    };
    return { tool, input: tool.input.parse(input), caller };
  };
  const call = async (name: string, input: unknown): Promise<unknown> => {
    const handler = handlers[name];
    if (handler === undefined) throw new Error(`no handler ${name}`);
    return await handler(callOf(name, input));
  };
  return {
    rig,
    tools,
    home,
    call,
    async fail(name, input) {
      try {
        await call(name, input);
      } catch (error) {
        if (error instanceof ToolFailure) return error;
        throw error;
      }
      throw new Error(`${name} did not fail`);
    },
  };
}

/** Opens a page; skips the test (not on CI) when this machine has no Chromium to run it. */
async function openOrSkip(run: Run, ctx: TestContext, url: string): Promise<JsonObject> {
  try {
    return (await run.call('browser_open', { url })) as JsonObject;
  } catch (error) {
    if (!MUST_RUN && error instanceof ToolFailure && error.code === 'unavailable') {
      console.warn(`[browser acceptance] skipped, no Chromium to run: ${error.message}`);
      ctx.skip();
    }
    throw error;
  }
}

async function buttonRef(run: Run): Promise<string> {
  const read = (await run.call('browser_read', {})) as { tree: string };
  const ref = /button "Go" \[ref=(e\d+)\]/.exec(read.tree)?.[1];
  if (ref === undefined) throw new Error(`no button in ${read.tree}`);
  return ref;
}

const titleOf = async (run: Run): Promise<string> =>
  ((await run.call('browser_read', {})) as { title: string }).title;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 200));

// No process launcher on this platform yet (5.9, Windows): no browser, so nothing to run there.
describe.skipIf(NO_LAUNCHER)(
  'the browser of an agent, with a real Chromium',
  { timeout: 90_000 },
  () => {
    it('opens, reads, takes a screenshot and clicks with no approval by default', async (ctx) => {
      const run = await start();
      const url = `http://127.0.0.1:${origin}/app`;
      const opened = await openOrSkip(run, ctx, url);
      expect(opened).toMatchObject({ title: 'Acceptance', untrusted: true });

      const read = (await run.call('browser_read', {})) as { text: string; tree: string };
      expect(read.text).toContain('some text here');

      const shot = await run.call('browser_screenshot', {});
      expect(shot).toBeDefined();

      await run.call('browser_click', { ref: await buttonRef(run) });
      expect(await titleOf(run)).toBe('clicked');

      const actions = eventsOf(run.rig, 'browser.action').map((e) => e.payload);
      expect(actions.map((a) => a.action)).toEqual(
        expect.arrayContaining(['open', 'read', 'screenshot', 'click']),
      );
      expect(actions.find((a) => a.action === 'click')).toMatchObject({
        url,
        outcome: 'ok',
        idempotencyKey: `${PLAY_ID}:browser_click:${ATTEMPT_ID}:1`,
      });
      expect(eventsOf(run.rig, 'browser.approval')).toHaveLength(0);
    });

    it('with write_approval "always" the Producer answers BEFORE the click', async (ctx) => {
      let answer: (value: JsonValue) => void = () => undefined;
      const questions: string[] = [];
      const run = await start({
        browser: { write_approval: 'always' },
        askApproval: (_scenario, input) => {
          questions.push(input.questions[0]?.question ?? '');
          return Promise.resolve({
            decisionId: 'd1',
            answer: new Promise<JsonValue>((resolve) => {
              answer = resolve;
            }),
          });
        },
      });
      await openOrSkip(run, ctx, `http://127.0.0.1:${origin}/app`);
      const ref = await buttonRef(run);

      const pending = run.call('browser_click', { ref });
      await tick();
      expect(questions).toHaveLength(1);
      // The calls of a scenario go one at a time, so a read would wait behind the click. What
      // proves nothing was done yet is that the click is not even recorded as intended.
      expect(await run.rig.store.sideEffects.list({ types: ['browser_click'] })).toHaveLength(0);

      answer('Allow');
      await pending;
      expect(await titleOf(run)).toBe('clicked');
      expect(eventsOf(run.rig, 'browser.approval').map((e) => e.payload.state)).toEqual([
        'requested',
        'granted',
      ]);
    });

    it('with write_approval "always" a Deny leaves the page as it was', async (ctx) => {
      const run = await start({
        browser: { write_approval: 'always' },
        askApproval: () => Promise.resolve({ decisionId: 'd1', answer: Promise.resolve('Deny') }),
      });
      await openOrSkip(run, ctx, `http://127.0.0.1:${origin}/app`);
      const failure = await run.fail('browser_click', { ref: await buttonRef(run) });
      expect(failure.code).toBe('approval_denied');
      expect(await titleOf(run)).toBe('Acceptance');
    });

    it('with domains "allowlist" refuses a domain outside the list and opens one inside it', async (ctx) => {
      const run = await start({
        browser: { domains: 'allowlist' },
        networkAllow: ['127.0.0.1'],
      });
      const opened = await openOrSkip(run, ctx, `http://127.0.0.1:${origin}/app`);
      expect(opened.title).toBe('Acceptance');
      const failure = await run.fail('browser_open', { url: 'http://not-in-the-list.test/' });
      expect(failure.code).toBe('domain_not_allowed');
      expect(eventsOf(run.rig, 'browser.refused')).toHaveLength(1);
    });

    it('opens localhost', async (ctx) => {
      const run = await start();
      const opened = await openOrSkip(run, ctx, `http://localhost:${origin}/app`);
      expect(opened).toMatchObject({ title: 'Acceptance' });
    });

    it('opens a file of the worktree, served on the daemon origin, and never shows the token', async (ctx) => {
      const run = await start({ isSecret: (path) => path.includes('/.ssh/') });
      await run.rig.write('local.html', '<title>From a file</title><p>file page</p>');
      const url = `file://${join(run.rig.worktree, 'local.html')}`;
      const opened = await openOrSkip(run, ctx, url);
      expect(opened).toMatchObject({ title: 'From a file', url });
      const read = (await run.call('browser_read', {})) as { url: string; text: string };
      expect(read.text).toContain('file page');
      expect(read.url).toBe(url);
      expect(JSON.stringify(run.rig.events)).not.toContain('/files/');
    });

    it('refuses a secret path in file:// (fake list, temporary HOME) and a secret behind a link', async (ctx) => {
      const holder: { home: string } = { home: '' };
      const run = await start({ isSecret: (path) => path.startsWith(`${holder.home}/.ssh`) });
      holder.home = run.home;
      const secret = join(run.home, '.ssh', 'id_fake');
      const failure = await run.fail('browser_open', { url: `file://${secret}` });
      expect(failure.code).toBe('secret_path');
      expect(eventsOf(run.rig, 'browser.refused')[0]?.payload).toMatchObject({
        code: 'secret_path',
      });

      // a page of the worktree that tries to load the secret straight from the disk
      await run.rig.write(
        'sneaky.html',
        `<title>Sneaky</title><iframe src="file://${secret}"></iframe><p>after</p>`,
      );
      await openOrSkip(run, ctx, `file://${join(run.rig.worktree, 'sneaky.html')}`);
      const read = (await run.call('browser_read', {})) as { text: string; tree: string };
      expect(`${read.text}${read.tree}`).not.toContain('FAKE-PRIVATE-KEY');
      expect(JSON.stringify(run.rig.events)).not.toContain('FAKE-PRIVATE-KEY');
    });
  },
);
