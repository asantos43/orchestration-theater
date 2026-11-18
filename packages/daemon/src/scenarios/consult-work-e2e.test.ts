// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayFakes,
  type PlayHarness,
  type PlayHarnessOptions,
} from '../orchestration/e2e-fixture.js';

const run = promisify(execFile);

/**
 * The consultant of the chat with the fake agent (P10, N86): it writes only in the folder of the
 * chat, with the confinement of the shell tools; it researches with `http_get` when its role has a
 * network allowlist; it gets an image only through a client that declares it. The fake agent is
 * the compiled `dist/cli.js`, so `pnpm build` comes first.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const VISION = 'fake-vision';

const VISION_ALTERNATIVE = `
scenarios:
  consultant_alternatives:
    - client: ${VISION}
      profile: one
      model: fake-model
`;

function withChatDaemon(
  options: PlayHarnessOptions,
  body: (harness: PlayHarness) => Promise<void>,
): Promise<void> {
  const clock = new FakeClock();
  const fakes: PlayFakes = {
    codeHost: new FakeCodeHost(),
    clock,
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) => [
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
      new FakeClientAdapter({
        id: VISION,
        capabilities: { inputTypes: ['image'] },
        launcher,
        baseEnv: {},
        env,
        adapterVersion: '1.0.0',
        command,
      }),
    ],
  };
  return withDaemon(fakes, options, body);
}

async function waitForReply(
  harness: PlayHarness,
  scenarioId: string,
  text: string,
): Promise<string> {
  return waitFor(`a reply with "${text}"`, async () =>
    (await harness.producer.poll(scenarioId, 0)).replies
      .map((reply) => reply.text)
      .find((reply) => reply.includes(text)),
  );
}

async function folderOf(harness: PlayHarness, scenarioId: string): Promise<string> {
  const scenario = await harness.daemon.store.scenarios.get(scenarioId);
  if (scenario === undefined) throw new Error('no scenario');
  return scenario.folder;
}

async function branchesOf(folder: string): Promise<string[]> {
  const { stdout } = await run('git', ['-C', folder, 'branch', '--format=%(refname:short)']);
  return stdout.split('\n').filter((line) => line !== '');
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function workOf(harness: PlayHarness, scenarioId: string): Promise<Record<string, unknown>> {
  const [decision] = await harness.daemon.store.decisions.list({ scenarioId });
  const answer = decision?.answer as { work?: Record<string, unknown> } | null | undefined;
  return answer?.work ?? {};
}

// A one-pixel PNG: the magic bytes are what the daemon takes the type from.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

describe('the consultant writes in the folder of the chat (P10)', { timeout: 120_000 }, () => {
  it('puts the file it wrote in the chat folder, after the checks, and leaves no branch behind', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const folder = await folderOf(harness, scenarioId);
      await harness.producer.send(scenarioId, '#ot-consult save write:notes/plan.md=the_plan');
      const reply = await waitForReply(harness, scenarioId, 'write notes/plan.md ok');
      expect(reply).toContain('notes/plan.md');

      expect(await readFile(join(folder, 'notes', 'plan.md'), 'utf8')).toBe('the plan');
      expect(await workOf(harness, scenarioId)).toMatchObject({
        outcome: 'merged',
        files: ['notes/plan.md'],
      });
      // The branch and the worktree of the consultation are gone: the work is in main.
      expect(await branchesOf(folder)).toEqual(['main']);
      const { stdout } = await run('git', ['-C', folder, 'log', '--format=%s', '-n', '3']);
      expect(stdout).toContain('consult:');
    });
  });

  it('writes nothing outside the folder: a path that climbs out is refused', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const folder = await folderOf(harness, scenarioId);
      await harness.producer.send(
        scenarioId,
        '#ot-consult save write:../outside.txt=x write:/tmp/otheater-p10-abs.txt=x',
      );
      const reply = await waitForReply(harness, scenarioId, 'write ../outside.txt refused');
      expect(reply).toContain('write /tmp/otheater-p10-abs.txt refused');
      expect(await exists(join(dirname(folder), 'outside.txt'))).toBe(false);
      expect(await exists('/tmp/otheater-p10-abs.txt')).toBe(false);
      expect(await workOf(harness, scenarioId)).toMatchObject({ outcome: 'none', files: [] });
      expect(await branchesOf(folder)).toEqual(['main']);
    });
  });

  it('refuses a symlink that leads out of the folder and keeps the work on its branch', async () => {
    await withChatDaemon({}, async (harness) => {
      const outside = await mkdtemp(join(tmpdir(), 'otheater-p10-out-'));
      try {
        const secret = join(outside, 'secret.txt');
        await writeFile(secret, 'not for the chat');
        const scenarioId = await harness.openGenericChat('talk');
        const folder = await folderOf(harness, scenarioId);
        await harness.producer.send(
          scenarioId,
          `#ot-consult save write:ok.md=fine link:escape=${secret}`,
        );
        const reply = await waitForReply(harness, scenarioId, 'link escape ok');
        // The Director is told, in the data, why nothing arrived.
        expect(reply).toContain('refused');
        expect(reply).toContain('leads out of the worktree');

        expect(await exists(join(folder, 'escape'))).toBe(false);
        // Nothing of that consultation went in, not even the harmless file next to the link.
        expect(await exists(join(folder, 'ok.md'))).toBe(false);
        expect(await workOf(harness, scenarioId)).toMatchObject({ outcome: 'refused' });
        const branches = await branchesOf(folder);
        expect(branches).toContain('main');
        expect(branches.some((branch) => branch.includes('consult-1'))).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('merges even with a loose file in the folder and an attachment, which stays out of git', async () => {
    await withChatDaemon({ extra: VISION_ALTERNATIVE }, async (harness) => {
      const dir = await mkdtemp(join(tmpdir(), 'otheater-p10-'));
      try {
        const file = join(dir, 'diagram.png');
        await writeFile(file, PNG);
        const scenarioId = await harness.openGenericChat('talk');
        const folder = await folderOf(harness, scenarioId);
        await harness.producer.attach(scenarioId, { path: file });
        await writeFile(join(folder, 'draft.txt'), 'written by someone else');
        await harness.producer.send(
          scenarioId,
          '#ot-consult describe it write:notes/a.md=done\n#ot-attach A1',
        );
        await waitForReply(harness, scenarioId, 'write notes/a.md ok');
        expect(await workOf(harness, scenarioId)).toMatchObject({ outcome: 'merged' });
        expect(await readFile(join(folder, 'notes', 'a.md'), 'utf8')).toBe('done');
        expect(await readFile(join(folder, 'draft.txt'), 'utf8')).toBe('written by someone else');
        const { stdout } = await run('git', ['-C', folder, 'ls-files']);
        expect(stdout.split('\n')).toEqual(expect.arrayContaining(['draft.txt', 'notes/a.md']));
        expect(stdout).not.toContain('attachments/');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('scenarios.consultant_writes: keep leaves the work on a branch, discard drops it', async () => {
    await withChatDaemon({ extra: 'scenarios:\n  consultant_writes: keep\n' }, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const folder = await folderOf(harness, scenarioId);
      await harness.producer.send(scenarioId, '#ot-consult save write:notes/k.md=kept');
      await waitForReply(harness, scenarioId, 'write notes/k.md ok');
      expect(await exists(join(folder, 'notes', 'k.md'))).toBe(false);
      expect(await workOf(harness, scenarioId)).toMatchObject({
        outcome: 'kept',
        files: ['notes/k.md'],
      });
      expect((await branchesOf(folder)).some((branch) => branch.includes('consult-1'))).toBe(true);
    });
    await withChatDaemon(
      { extra: 'scenarios:\n  consultant_writes: discard\n' },
      async (harness) => {
        const scenarioId = await harness.openGenericChat('talk');
        const folder = await folderOf(harness, scenarioId);
        await harness.producer.send(scenarioId, '#ot-consult save write:notes/d.md=dropped');
        await waitForReply(harness, scenarioId, 'write notes/d.md ok');
        expect(await exists(join(folder, 'notes', 'd.md'))).toBe(false);
        expect(await workOf(harness, scenarioId)).toMatchObject({ outcome: 'discarded' });
        expect(await branchesOf(folder)).toEqual(['main']);
      },
    );
  });
});

describe('the consultant researches and sees images (P10)', { timeout: 120_000 }, () => {
  async function withServer(body: (url: string) => Promise<void>): Promise<void> {
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('docs say: use the queue');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      await body(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/doc`);
    } finally {
      await new Promise<void>((done) =>
        server.close(() => {
          done();
        }),
      );
    }
  }

  it('uses http_get against a local server when the role lists the domain', async () => {
    await withServer(async (url) => {
      const extra =
        'roles:\n  consultant:\n    policy:\n      network:\n        allow: [127.0.0.1]\n';
      await withChatDaemon({ extra }, async (harness) => {
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.send(scenarioId, `#ot-consult look it up http:${url}`);
        const reply = await waitForReply(harness, scenarioId, 'docs say');
        expect(reply).toContain(`http ${url} 200 docs say: use the queue`);
      });
    });
  });

  it('has no http_get when the role asks for no network (the default): the call is refused', async () => {
    await withServer(async (url) => {
      await withChatDaemon({}, async (harness) => {
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.send(scenarioId, `#ot-consult look it up http:${url}`);
        const reply = await waitForReply(harness, scenarioId, 'consulted');
        expect(reply).toContain(`http ${url} refused`);
        expect(reply).not.toContain('docs say');
      });
    });
  });

  it('shows the image to a client that declares it, as an image block of the tool result', async () => {
    await withChatDaemon({ extra: VISION_ALTERNATIVE }, async (harness) => {
      const dir = await mkdtemp(join(tmpdir(), 'otheater-p10-img-'));
      try {
        const file = join(dir, 'diagram.png');
        await writeFile(file, PNG);
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.attach(scenarioId, { path: file });
        await harness.producer.send(scenarioId, '#ot-consult what is in it\n#ot-attach A1');
        const reply = await waitForReply(harness, scenarioId, 'A1 is image/png');
        expect(reply).toContain(`seen as image/png (${String(PNG.length)} bytes)`);
        const attempts = (await harness.daemon.store.attempts.list()).filter((attempt) =>
          attempt.demandId.startsWith('consult-'),
        );
        expect(attempts.map((attempt) => attempt.client)).toEqual([VISION]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
