// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  NotFound,
  PermissionDenied,
  type BrowserGuard,
  type BrowserProfileMode,
  type BrowserRequest,
  type BrowserScope,
} from '@otheater/core';
import { FakeProcessLauncher } from '@otheater/core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromiumPath, CHROMIUM_INSTALL_COMMAND } from './chromium.js';
import { PlaywrightBrowserSession } from './session.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';

/**
 * Tests with a real Chromium (the one `playwright-core` expects in `~/.cache/ms-playwright`) open
 * pages served by THIS test on 127.0.0.1, never the internet. One browser at most per test, closed
 * in `afterEach`. When Chromium is not there the real tests are skipped, and say so.
 */
const CHROMIUM = chromiumPath(undefined);
const HAS_CHROMIUM = existsSync(CHROMIUM);
if (!HAS_CHROMIUM) {
  console.warn(
    `[browser-playwright] Chromium not found at ${CHROMIUM}: the tests with a real browser are skipped. Run \`${CHROMIUM_INSTALL_COMMAND}\` to run them.`,
  );
}
/** CI runners (Ubuntu 24.04) refuse the user namespaces of the Chromium sandbox. */
const SANDBOX = process.env.CI === undefined;

const PAGE = `<html><head><title>Test page</title></head><body>
<h1>Hello</h1><p>some text here</p>
<input aria-label="Name" id="n">
<input type="password" aria-label="Secret" id="p" value="hunter2-secret">
<button id="b" onclick="document.title='clicked'">Click me</button>
<a href="file:///etc/hostname">filelink</a>
<a href="/two" target="_blank">popup</a>
<img src="/pixel.png">
</body></html>`;

let server: Server;
let origin = '';
let work: string;
let launcher: NodeProcessLauncher;
let session: PlaywrightBrowserSession | undefined;
let requested: string[];

beforeAll(async () => {
  server = createServer((req, res) => {
    requested.push(req.url ?? '');
    if (req.url === '/pixel.png') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.alloc(0));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/two' ? '<title>Second</title><h1>two</h1>' : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
});

beforeEach(async () => {
  requested = [];
  work = await mkdtemp(join(tmpdir(), 'otheater-browser-'));
  launcher = new NodeProcessLauncher();
  session = undefined;
});

afterEach(async () => {
  await session?.close();
  await rm(work, { recursive: true, force: true });
});

function make(overrides: Partial<ConstructorParameters<typeof PlaywrightBrowserSession>[0]> = {}) {
  session = new PlaywrightBrowserSession({
    launcher,
    profilesDir: join(work, 'profiles'),
    sandbox: SANDBOX,
    minFreeMemoryBytes: 0,
    ...overrides,
  });
  return session;
}

const allowAll: BrowserGuard = () => ({ allow: true });

function scope(
  scenarioId: string,
  guard: BrowserGuard = allowAll,
  profile: BrowserProfileMode = 'shared',
): BrowserScope {
  return { scenarioId, profile, guard };
}

describe('admission and start (no Chromium needed)', () => {
  it('does not start a browser when the machine has too little free RAM', async () => {
    const fake = new FakeProcessLauncher();
    const adapter = new PlaywrightBrowserSession({
      launcher: fake,
      profilesDir: join(work, 'profiles'),
      freeMemoryBytes: () => 100 * 1024 * 1024,
      minFreeMemoryBytes: 1024 * 1024 * 1024,
    });
    await expect(adapter.open(scope('s1'), `${origin}/`)).rejects.toThrow(AdapterUnavailable);
    await expect(adapter.open(scope('s1'), `${origin}/`)).rejects.toThrow(/min_free_memory_mb/);
    expect(fake.launched).toHaveLength(0);
  });

  it('does not start more browsers than browser.max_instances', async () => {
    const fake = new FakeProcessLauncher();
    const adapter = new PlaywrightBrowserSession({
      launcher: fake,
      profilesDir: join(work, 'profiles'),
      maxInstances: 0,
      minFreeMemoryBytes: 0,
    });
    await expect(adapter.open(scope('s1'), `${origin}/`)).rejects.toThrow(/max_instances/);
    expect(fake.launched).toHaveLength(0);
  });

  it('says how to get Chromium when it is not installed', async () => {
    const fake = new FakeProcessLauncher();
    const adapter = new PlaywrightBrowserSession({
      launcher: fake,
      profilesDir: join(work, 'profiles'),
      executablePath: join(work, 'no-chromium'),
      minFreeMemoryBytes: 0,
    });
    const error = await adapter.open(scope('s1'), `${origin}/`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterUnavailable);
    expect((error as Error).message).toContain(CHROMIUM_INSTALL_COMMAND);
    expect(fake.launched).toHaveLength(0);
  });

  it('refuses file: and other schemes before any browser starts', async () => {
    const fake = new FakeProcessLauncher();
    const adapter = new PlaywrightBrowserSession({
      launcher: fake,
      profilesDir: join(work, 'profiles'),
    });
    await expect(adapter.open(scope('s1'), 'file:///etc/hostname')).rejects.toThrow(
      PermissionDenied,
    );
    await expect(adapter.open(scope('s1'), 'javascript:alert(1)')).rejects.toThrow(
      PermissionDenied,
    );
    await expect(adapter.open(scope('s1'), 'not a url')).rejects.toThrow(InvalidInput);
    expect(fake.launched).toHaveLength(0);
  });

  it('ends the process and reports AdapterUnavailable when Chromium dies before it announces itself', async () => {
    const fake = new FakeProcessLauncher();
    const exe = join(work, 'fake-chromium');
    await writeFile(exe, '#!/bin/sh\n', { mode: 0o755 });
    const adapter = new PlaywrightBrowserSession({
      launcher: fake,
      profilesDir: join(work, 'profiles'),
      executablePath: exe,
      minFreeMemoryBytes: 0,
      launchTimeoutMs: 5000,
    });
    const opening = adapter.open(scope('s1'), `${origin}/`).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fake.launched[0]?.exit(1);
    const error = await opening;
    expect(error).toBeInstanceOf(AdapterUnavailable);
    expect(fake.launched[0]?.killTreeCalls).toBeGreaterThan(0);
    // The browser runs as the launcher says: private HOME, the flags of the daemon, no daemon env.
    const launched = fake.launched[0]?.options;
    expect(launched?.args).toContain('--headless=new');
    expect(launched?.args).toContain('--remote-debugging-port=0');
    expect(launched?.args.some((arg) => arg.startsWith('--user-data-dir='))).toBe(true);
    expect(launched?.env.HOME).toContain('profiles');
    expect(Object.keys(launched?.env ?? {})).not.toContain('ANTHROPIC_API_KEY');
  });

  it('gives up with AdapterUnavailable when Chromium never announces its endpoint', async () => {
    const fake = new FakeProcessLauncher();
    const exe = join(work, 'fake-chromium');
    await writeFile(exe, '#!/bin/sh\n', { mode: 0o755 });
    const adapter = new PlaywrightBrowserSession({
      launcher: fake,
      profilesDir: join(work, 'profiles'),
      executablePath: exe,
      minFreeMemoryBytes: 0,
      launchTimeoutMs: 200,
    });
    await expect(adapter.open(scope('s1'), `${origin}/`)).rejects.toThrow(/no DevTools endpoint/);
    expect(fake.launched[0]?.killTreeCalls).toBeGreaterThan(0);
  });

  it('rejects calls after close and needs open before read', async () => {
    const adapter = make();
    await expect(adapter.read(scope('s1'), { maxChars: 100 })).rejects.toThrow(NotFound);
    await adapter.close();
    await expect(adapter.open(scope('s1'), `${origin}/`)).rejects.toThrow(AdapterUnavailable);
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

describe.skipIf(!HAS_CHROMIUM)('a real Chromium', () => {
  it('opens a local page, reads it, takes a screenshot, clicks, fills and presses a key', async () => {
    const adapter = make();
    const s = scope('s1');
    const opened = await adapter.open(s, `${origin}/`);
    expect(opened).toEqual({ url: `${origin}/`, title: 'Test page' });

    const read = await adapter.read(s, { maxChars: 10_000 });
    expect(read.text).toContain('some text here');
    expect(read.tree).toContain('button "Click me"');
    expect(read.truncated).toBe(false);

    const button = /button "Click me" \[ref=([a-z0-9]+)\]/.exec(read.tree)?.[1];
    const name = /textbox "Name" \[ref=([a-z0-9]+)\]/.exec(read.tree)?.[1];
    expect(button).toBeDefined();
    expect(name).toBeDefined();

    const shot = await adapter.screenshot(s);
    expect(shot.mimeType).toBe('image/png');
    expect(Array.from(shot.data.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const element = await adapter.screenshot(s, button);
    expect(element.data.length).toBeGreaterThan(8);

    expect((await adapter.click(s, button as string)).title).toBe('clicked');
    await adapter.fill(s, name as string, 'Anderson');
    const after = await adapter.read(s, { maxChars: 10_000 });
    expect(after.tree).toContain('Anderson');
    await adapter.pressKey(s, 'Tab');
    expect(await adapter.state('s1')).toMatchObject({ url: `${origin}/` });
    await expect(adapter.pressKey(s, 'NotAKey')).rejects.toThrow(InvalidInput);
  });

  it('never returns the value of a password field', async () => {
    const adapter = make();
    const s = scope('s1');
    await adapter.open(s, `${origin}/`);
    const read = await adapter.read(s, { maxChars: 10_000 });
    expect(read.tree).toContain('textbox "Secret"');
    expect(read.tree).not.toContain('hunter2-secret');
    expect(read.text).not.toContain('hunter2-secret');
    const secret = /textbox "Secret" \[ref=([a-z0-9]+)\]/.exec(read.tree)?.[1] as string;
    const scoped = await adapter.read(s, { ref: secret, maxChars: 10_000 });
    expect(scoped.tree).not.toContain('hunter2-secret');
  });

  it('cuts text and tree at maxChars and says so', async () => {
    const adapter = make();
    const s = scope('s1');
    await adapter.open(s, `${origin}/`);
    const read = await adapter.read(s, { maxChars: 20 });
    expect(read.text.length).toBeLessThanOrEqual(20);
    expect(read.tree.length).toBeLessThanOrEqual(20);
    expect(read.truncated).toBe(true);
  });

  it('refuses a ref the page does not have and a malformed one', async () => {
    const adapter = make();
    const s = scope('s1');
    await adapter.open(s, `${origin}/`);
    await adapter.read(s, { maxChars: 10_000 });
    await expect(adapter.click(s, 'e999999')).rejects.toThrow(NotFound);
    await expect(adapter.click(s, 'e1; rm -rf')).rejects.toThrow(InvalidInput);
  });

  it('asks the guard for EVERY request of the page and obeys its refusal', async () => {
    const adapter = make();
    const seen: BrowserRequest[] = [];
    const guard: BrowserGuard = (request) => {
      seen.push(request);
      return request.url.endsWith('/pixel.png')
        ? { allow: false, reason: 'images are off in this test' }
        : { allow: true };
    };
    await adapter.open(scope('s1', guard), `${origin}/`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen.map((r) => r.url)).toContain(`${origin}/`);
    expect(seen.find((r) => r.url === `${origin}/`)?.navigation).toBe(true);
    expect(seen.find((r) => r.url.endsWith('/pixel.png'))?.navigation).toBe(false);
    expect(requested).not.toContain('/pixel.png');
  });

  it('rejects a refused page with PermissionDenied and the reason, without a request to the server', async () => {
    const adapter = make();
    const guard: BrowserGuard = () => ({ allow: false, reason: 'domain not in the allowlist' });
    const error = await adapter.open(scope('s1', guard), `${origin}/`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermissionDenied);
    expect((error as Error).message).toContain('domain not in the allowlist');
    expect(requested).toHaveLength(0);
    // The next page opens normally, even right after a refusal.
    await expect(adapter.open(scope('s1'), `${origin}/two`)).resolves.toMatchObject({
      title: 'Second',
    });
  });

  it('treats a throwing guard as a refusal', async () => {
    const adapter = make();
    const guard: BrowserGuard = () => {
      throw new Error('boom');
    };
    await expect(adapter.open(scope('s1', guard), `${origin}/`)).rejects.toThrow(PermissionDenied);
    expect(requested).toHaveLength(0);
  });

  it('never loads a file: URL, not even from a link on the page', async () => {
    const adapter = make();
    const seen: string[] = [];
    const guard: BrowserGuard = (request) => {
      seen.push(request.url);
      return { allow: true };
    };
    const s = scope('s1', guard);
    await adapter.open(s, `${origin}/`);
    const read = await adapter.read(s, { maxChars: 10_000 });
    const link = /link "filelink" \[ref=([a-z0-9]+)\]/.exec(read.tree)?.[1] as string;
    await adapter.click(s, link);
    expect((await adapter.state('s1'))?.url).toBe(`${origin}/`);
    expect(seen.some((url) => url.startsWith('file:'))).toBe(false);
  });

  it('keeps a popup under the guard of the scenario and moves the scenario to it', async () => {
    const adapter = make();
    const seen: string[] = [];
    const guard: BrowserGuard = (request) => {
      seen.push(request.url);
      return { allow: true };
    };
    const s = scope('s1', guard);
    await adapter.open(s, `${origin}/`);
    const read = await adapter.read(s, { maxChars: 10_000 });
    const link = /link "popup" \[ref=([a-z0-9]+)\]/.exec(read.tree)?.[1] as string;
    const after = await adapter.click(s, link);
    expect(seen).toContain(`${origin}/two`);
    expect(after.url).toBe(`${origin}/two`);
    expect(after.title).toBe('Second');
  });

  it('refuses a popup the guard refuses', async () => {
    const adapter = make();
    const guard: BrowserGuard = (request) =>
      request.url.endsWith('/two') ? { allow: false, reason: 'no second pages' } : { allow: true };
    const s = scope('s1', guard);
    await adapter.open(s, `${origin}/`);
    const read = await adapter.read(s, { maxChars: 10_000 });
    const link = /link "popup" \[ref=([a-z0-9]+)\]/.exec(read.tree)?.[1] as string;
    await adapter.click(s, link);
    expect(requested).not.toContain('/two');
  });

  it('gives each scenario its own page in the shared browser, and ends the browser with the last one', async () => {
    const adapter = make();
    await adapter.open(scope('a'), `${origin}/`);
    await adapter.open(scope('b'), `${origin}/two`);
    expect(adapter.instanceCount).toBe(1);
    expect((await adapter.state('a'))?.title).toBe('Test page');
    expect((await adapter.state('b'))?.title).toBe('Second');
    await adapter.closeScenario('a');
    expect(adapter.instanceCount).toBe(1);
    expect(await adapter.state('a')).toBeUndefined();
    expect((await adapter.state('b'))?.title).toBe('Second');
    await adapter.closeScenario('b');
    expect(adapter.instanceCount).toBe(0);
    await expect(adapter.closeScenario('b')).resolves.toBeUndefined();
  });

  it('runs a browser of its own, with a profile of its own, for each scenario of per_scenario', async () => {
    const adapter = make({ maxInstances: 2 });
    await adapter.open(scope('a', allowAll, 'per_scenario'), `${origin}/`);
    await adapter.open(scope('b', allowAll, 'per_scenario'), `${origin}/two`);
    expect(adapter.instanceCount).toBe(2);
    expect(launcher.pids).toHaveLength(2);
    await adapter.closeScenario('a');
    expect(adapter.instanceCount).toBe(1);
  });

  it('admits at most max_instances browsers', async () => {
    const adapter = make({ maxInstances: 1 });
    await adapter.open(scope('a', allowAll, 'per_scenario'), `${origin}/`);
    await expect(adapter.open(scope('b', allowAll, 'per_scenario'), `${origin}/`)).rejects.toThrow(
      /max_instances/,
    );
    expect(adapter.instanceCount).toBe(1);
  });

  it('starts one browser for two scenarios that open at the same time', async () => {
    const adapter = make();
    await Promise.all([
      adapter.open(scope('a'), `${origin}/`),
      adapter.open(scope('b'), `${origin}/two`),
    ]);
    expect(adapter.instanceCount).toBe(1);
    expect(launcher.pids).toHaveLength(1);
  });

  it('ends every browser on close and leaves no process behind', async () => {
    const adapter = make({ maxInstances: 2 });
    await adapter.open(scope('a', allowAll, 'per_scenario'), `${origin}/`);
    await adapter.open(scope('b'), `${origin}/`);
    const pids = [...launcher.pids];
    await adapter.close();
    expect(adapter.instanceCount).toBe(0);
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  });

  it('reports a browser that vanished as no page, so the caller opens again', async () => {
    const adapter = make();
    const s = scope('a');
    await adapter.open(s, `${origin}/`);
    const pid = launcher.pids[0] as number;
    process.kill(-pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(adapter.read(s, { maxChars: 100 })).rejects.toThrow(NotFound);
    await expect(adapter.open(s, `${origin}/two`)).resolves.toMatchObject({ title: 'Second' });
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
