// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import type { DiffStat, EventEnvelope, Vcs } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  gatherContinuationPackage,
  maskSecrets,
  readAttemptEvents,
  renderContinuationPackage,
  scrubPackageText,
  summarizeTrajectory,
  touchesSecretPath,
  type PackageReason,
  type PackageRequest,
  type PackageSummarizer,
} from './continuation-package.js';
import { DEFAULT_PACKAGE_SETTINGS } from './settings.js';

const WORKTREE = '/work/tree';
const SECRETS = ['.env', '*.pem', '/home/dev/.aws'];
const SCOPE = { secretPaths: SECRETS, home: '/home/dev' } as const;

let nextId = 1;

function envelope(type: string, payload: Record<string, unknown>, attemptId = 'a1'): EventEnvelope {
  const id = nextId++;
  return {
    id,
    timestamp: id,
    type,
    schemaVersion: 1,
    payload,
    attemptId,
  } as EventEnvelope;
}

function toolCall(
  id: string,
  title: string,
  toolKind: string,
  status: string,
  paths: readonly string[] = [],
  sessionId = 's-1',
): EventEnvelope {
  return envelope('session.update', {
    sessionId,
    update: {
      kind: 'tool_call',
      toolCallId: id,
      title,
      toolKind,
      status,
      ...(paths.length === 0 ? {} : { locations: paths.map((path) => ({ path })) }),
    },
  });
}

function message(text: string, sessionId = 's-1'): EventEnvelope {
  return envelope('session.update', {
    sessionId,
    update: { kind: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

describe('maskSecrets', () => {
  it('masks the known shapes of a key and the value of a named secret', () => {
    const text = [
      'key sk-abcdefghijklmnopqrstuvwx here',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'Authorization: Bearer abcdefghijklmnop.qrstu',
      'API_KEY=hunter2hunter2',
      '{"password": "swordfish"}',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const masked = maskSecrets(text);
    for (const leak of [
      'sk-abcdefghijklmnopqrstuvwx',
      'ghp_abcdef',
      'abcdefghijklmnop.qrstu',
      'hunter2',
      'swordfish',
      'MIIabc',
    ]) {
      expect(masked).not.toContain(leak);
    }
    expect(masked).toContain('API_KEY=[REDACTED]');
  });

  it('is idempotent and leaves plain text alone', () => {
    const once = maskSecrets('TOKEN=abc and sk-abcdefghijklmnopqrstuvwx');
    expect(maskSecrets(once)).toBe(once);
    expect(maskSecrets('Add the endpoint to src/app.ts')).toBe('Add the endpoint to src/app.ts');
  });
});

describe('scrubPackageText and touchesSecretPath', () => {
  it('replaces the paths of the secret list, with ~ read against the home', () => {
    const text = scrubPackageText('cat .env && cat ~/.aws/credentials && ls src', SCOPE);
    expect(text).not.toContain('.env');
    expect(text).not.toContain('.aws');
    expect(text).toContain('ls src');
    expect(text).toContain('[secret path]');
  });

  it('does nothing about paths when the list is empty', () => {
    expect(scrubPackageText('cat .env', { secretPaths: [] })).toBe('cat .env');
    expect(touchesSecretPath('cat .env', { secretPaths: [] })).toBe(false);
  });

  it('says a command touches the list', () => {
    expect(touchesSecretPath('cp config/server.pem /tmp', SCOPE)).toBe(true);
    expect(touchesSecretPath('cp src/a.ts /tmp', SCOPE)).toBe(false);
  });
});

describe('summarizeTrajectory', () => {
  const events = (): EventEnvelope[] => [
    message('Reading the code. '),
    toolCall('1', 'Read src/a.ts', 'read', 'completed', [`${WORKTREE}/src/a.ts`]),
    toolCall('2', 'Edit src/b.ts', 'edit', 'completed', [`${WORKTREE}/src/b.ts`]),
    toolCall('3', 'pnpm test', 'execute', 'failed'),
    toolCall('4', 'ls', 'execute', 'completed'),
    envelope('session.update', {
      sessionId: 's-1',
      update: { kind: 'tool_call_update', toolCallId: '3', status: 'completed' },
    }),
    message('Tests pass now.'),
    envelope('tool.called', {
      callId: 'c1',
      tool: 'install_deps',
      role: 'actor',
      summary: 'pnpm install',
      heavy: true,
    }),
    envelope('tool.finished', {
      callId: 'c1',
      tool: 'install_deps',
      role: 'actor',
      outcome: 'ok',
      durationMs: 5,
      queuedMs: 0,
    }),
  ];

  it('lists what was read and edited, the commands with their result and the last message', () => {
    const summary = summarizeTrajectory(events(), { worktree: WORKTREE, ...SCOPE });
    expect(summary.filesRead).toEqual(['src/a.ts']);
    expect(summary.filesEdited).toEqual(['src/b.ts']);
    expect(summary.commands).toEqual([
      { command: 'pnpm test', status: 'completed', test: true },
      { command: 'ls', status: 'completed', test: false },
    ]);
    expect(summary.lastMessage).toBe('Tests pass now.');
    expect(summary.frameworkCalls).toEqual([
      { tool: 'install_deps', summary: 'pnpm install', outcome: 'ok' },
    ]);
    expect(summary.events).toBe(9);
  });

  it('is the same for the same events', () => {
    const first = summarizeTrajectory(events(), { worktree: WORKTREE, ...SCOPE });
    const second = summarizeTrajectory(events(), { worktree: WORKTREE, ...SCOPE });
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('keeps the ids of two sessions apart', () => {
    const summary = summarizeTrajectory(
      [
        toolCall('1', 'Read a', 'read', 'completed', [`${WORKTREE}/a`], 's-1'),
        toolCall('1', 'Read b', 'read', 'completed', [`${WORKTREE}/b`], 's-2'),
      ],
      { worktree: WORKTREE, secretPaths: [] },
    );
    expect(summary.filesRead).toEqual(['a', 'b']);
  });

  it('leaves the secret paths and the commands that name them out, and counts them', () => {
    const summary = summarizeTrajectory(
      [
        toolCall('1', 'Read .env', 'read', 'completed', [`${WORKTREE}/.env`]),
        toolCall('2', 'cat config/server.pem', 'execute', 'completed'),
        toolCall('3', 'echo API_KEY=hunter2hunter2', 'execute', 'completed'),
        message('The token is sk-abcdefghijklmnopqrstuvwx, saved in .env'),
      ],
      { worktree: WORKTREE, ...SCOPE },
    );
    expect(summary.filesRead).toEqual([]);
    expect(summary.withheld).toBe(2);
    expect(summary.commands.map((command) => command.command)).toEqual(['echo API_KEY=[REDACTED]']);
    expect(summary.lastMessage).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(summary.lastMessage).not.toContain('.env');
  });

  it('cuts a long last message to the tail', () => {
    const summary = summarizeTrajectory([message(`${'x'.repeat(3000)}END`)], {
      worktree: WORKTREE,
      secretPaths: [],
      messageChars: 100,
    });
    expect(summary.lastMessage.length).toBeLessThanOrEqual(103);
    expect(summary.lastMessage.endsWith('END')).toBe(true);
  });
});

describe('readAttemptEvents', () => {
  it('reads the log in pages and keeps the events of the attempt', async () => {
    const all: EventEnvelope[] = [];
    for (let index = 0; index < 1200; index += 1) {
      all.push(envelope('session.opened', { sessionId: 's' }, index % 3 === 0 ? 'a1' : 'a2'));
    }
    const reads: number[] = [];
    const log = {
      readFrom(after: number, limit: number) {
        reads.push(after);
        return Promise.resolve(all.filter((event) => event.id > after).slice(0, limit));
      },
    };
    const mine = await readAttemptEvents(log, 'a1');
    expect(mine).toHaveLength(400);
    expect(reads.length).toBeGreaterThan(2);
  });
});

describe('gatherContinuationPackage and renderContinuationPackage', () => {
  const stat: DiffStat = {
    filesChanged: 1,
    insertions: 3,
    deletions: 1,
    files: [{ path: 'src/b.ts', insertions: 3, deletions: 1 }],
  };
  const vcs = { diffStat: () => Promise.resolve(stat) } as unknown as Vcs;
  const reason: PackageReason = {
    cause: 'quota_exhausted',
    policy: 'The quota ran out.',
    detail: 'resets at noon',
    from: 'm@fake/one',
    to: 'm@fake/two',
  };

  async function seeded(): Promise<InMemoryStore> {
    const store = new InMemoryStore({ clock: new FakeClock() });
    await store.scenarios.create({
      id: 's1',
      kind: 'project',
      flowId: 'play.default',
      name: 'n',
      folder: '/work/n',
      baseBranch: 'main',
    });
    await store.plays.create({
      id: 'p1',
      scenarioId: 's1',
      need: 'x',
      flowId: 'play.default',
      flowVersion: 1,
      state: 'EXECUTING',
      counters: {},
    });
    await store.demands.create({
      playId: 'p1',
      id: 'd1',
      title: 'The demand',
      description: 'Do the thing.',
      dependsOn: [],
      contract: { inputs: [], outputs: [] },
      expectedFiles: ['src/b.ts'],
      complexity: 'low',
      timeoutMin: 5,
      acceptanceCriteria: ['it works'],
      verify: [],
      verifyWaiver: 'none',
      state: 'running',
    });
    return store;
  }

  const request = (overrides: Partial<PackageRequest> = {}): PackageRequest => ({
    attemptId: 'a1',
    playId: 'p1',
    demandId: 'd1',
    role: 'actor',
    worktree: WORKTREE,
    branch: 'work/p1',
    base: 'main',
    checkpoint: 'abc1234',
    firstPrompt: 'PREFIX\n\nDo the thing, please.',
    prefix: 'PREFIX',
    reason,
    settings: DEFAULT_PACKAGE_SETTINGS,
    ...overrides,
  });

  it('builds the package from the store and renders the five parts in order', async () => {
    const store = await seeded();
    for (const event of [
      toolCall('1', 'Edit src/b.ts', 'edit', 'completed', [`${WORKTREE}/src/b.ts`]),
    ]) {
      await store.events.append({
        type: event.type,
        schemaVersion: 1,
        payload: event.payload,
        attemptId: 'a1',
      });
    }
    const pkg = await gatherContinuationPackage({ store, vcs, secretPaths: [] }, request());
    expect(pkg.task).toBe('Do the thing, please.');
    expect(pkg.trajectory.filesEdited).toEqual(['src/b.ts']);
    expect(pkg.instruction).toBe('continue');
    const { text, level } = renderContinuationPackage(pkg, { maxChars: 48_000, secretPaths: [] });
    expect(level).toBe(0);
    expect(text.startsWith('PREFIX')).toBe(true);
    const places = [
      '## Demand',
      '## Worktree',
      '## What happened so far',
      '## Effects already executed',
      '## Why you are resuming',
    ].map((heading) => text.indexOf(heading));
    expect(places.every((place) => place > 0)).toBe(true);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    expect(text).toContain('Last checkpoint commit: abc1234');
    expect(text).toContain('src/b.ts (+3 -1)');
  });

  it('renders the same text for the same records', async () => {
    const store = await seeded();
    const first = renderContinuationPackage(
      await gatherContinuationPackage({ store, vcs, secretPaths: [] }, request()),
      { maxChars: 48_000, secretPaths: [] },
    );
    const second = renderContinuationPackage(
      await gatherContinuationPackage({ store, vcs, secretPaths: [] }, request()),
      { maxChars: 48_000, secretPaths: [] },
    );
    expect(second).toEqual(first);
  });

  it('asks the cheap model only for director_model, and the deterministic summary stays', async () => {
    const store = await seeded();
    const calls: string[] = [];
    const summarizer: PackageSummarizer = {
      summarize: (input) => {
        calls.push(input.deterministic);
        return Promise.resolve('Short: edited b.ts. token=sk-abcdefghijklmnopqrstuvwx');
      },
    };
    const deterministic = await gatherContinuationPackage(
      { store, vcs, secretPaths: [] },
      request(),
      summarizer,
    );
    expect(calls).toHaveLength(0);
    expect(deterministic.modelSummary).toBeUndefined();

    const settings = { ...DEFAULT_PACKAGE_SETTINGS, summarize: 'director_model' } as const;
    const pkg = await gatherContinuationPackage(
      { store, vcs, secretPaths: [] },
      request({ settings }),
      summarizer,
    );
    expect(calls).toHaveLength(1);
    const { text } = renderContinuationPackage(pkg, { maxChars: 48_000, secretPaths: [] });
    expect(text).toContain('Short: edited b.ts.');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(text).toContain('## What happened so far');
    expect(text).toContain('Files edited');
  });

  it('keeps the deterministic summary when the cheap model fails', async () => {
    const store = await seeded();
    const settings = { ...DEFAULT_PACKAGE_SETTINGS, summarize: 'director_model' } as const;
    const pkg = await gatherContinuationPackage(
      { store, vcs, secretPaths: [] },
      request({ settings }),
      { summarize: () => Promise.reject(new Error('offline')) },
    );
    expect(pkg.modelSummary).toBeUndefined();
  });

  it('takes the orders in force now', async () => {
    const store = await seeded();
    const before = await gatherContinuationPackage({ store, vcs, secretPaths: [] }, request());
    expect(before.orders ?? '').not.toContain('Be brief');
    await store.directives.create({
      scope: 'local',
      scenarioId: 's1',
      kind: 'instruction',
      text: 'Be brief',
      origin: 'chat',
    });
    const after = await gatherContinuationPackage({ store, vcs, secretPaths: [] }, request());
    expect(after.orders).toContain('Be brief');
  });

  it('shrinks to fit max_chars and always keeps the reason and the prefix', async () => {
    const store = await seeded();
    const noisy = Array.from({ length: 300 }, (_, index) =>
      toolCall(String(index), `Read file${String(index)}.ts`, 'read', 'completed', [
        `${WORKTREE}/file${String(index)}.ts`,
      ]),
    );
    for (const event of noisy) {
      await store.events.append({
        type: event.type,
        schemaVersion: 1,
        payload: event.payload,
        attemptId: 'a1',
      });
    }
    const pkg = await gatherContinuationPackage({ store, vcs, secretPaths: [] }, request());
    const full = renderContinuationPackage(pkg, { maxChars: 1_000_000, secretPaths: [] });
    expect(full.level).toBe(0);
    const small = renderContinuationPackage(pkg, { maxChars: 2500, secretPaths: [] });
    expect(small.level).toBeGreaterThan(0);
    expect(small.text.length).toBeLessThanOrEqual(2500);
    expect(small.text.startsWith('PREFIX')).toBe(true);
    expect(small.text).toContain('## Why you are resuming');
    expect(small.text).toContain('Continue from this state; do not redo what is concluded.');
    const tiny = renderContinuationPackage(pkg, { maxChars: 900, secretPaths: [] });
    expect(tiny.level).toBe(4);
    expect(tiny.text).toContain('cut: the package reached resume.package.max_chars');
    expect(tiny.text).toContain('## Why you are resuming');
  });

  it('takes the instruction from the role and the mode', async () => {
    const store = await seeded();
    const settings = { ...DEFAULT_PACKAGE_SETTINGS, shortOutputRoles: ['critic'] } as const;
    const critic = await gatherContinuationPackage(
      { store, vcs, secretPaths: [] },
      request({ role: 'critic', settings }),
    );
    expect(critic.instruction).toBe('redo');
    const actor = await gatherContinuationPackage(
      { store, vcs, secretPaths: [] },
      request({ role: 'actor', settings }),
    );
    expect(actor.instruction).toBe('continue');
    const off = await gatherContinuationPackage(
      { store, vcs, secretPaths: [] },
      request({ role: 'critic', settings: { ...settings, shortOutput: 'continue' } }),
    );
    expect(off.instruction).toBe('continue');
  });
});
