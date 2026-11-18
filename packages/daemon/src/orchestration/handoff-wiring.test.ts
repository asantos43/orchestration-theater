// SPDX-License-Identifier: MPL-2.0
import type { PromptSource } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import type { HandoffPort, HandoffRequest } from '../execution/handoff.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths } from '../paths.js';
import type { QuotaStatus } from '../quota/state.js';
import { buildDaemonRegistries } from '../registries.js';
import { createDaemonHandoff, createLateHandoff } from './handoff-wiring.js';
import { RoleSelection } from './role-selection.js';

/**
 * The baton wired in the daemon (P16b, N145): the late port, the choice with the selector of the
 * pipeline, the secret list and the summarizer of the Director model.
 */

const entry = (profile: string): string => `fake-model@fake/${profile}`;

const REQUEST: HandoffRequest = {
  attemptId: 'p1/d1/1',
  playId: 'p1',
  demandId: 'd1',
  role: 'actor',
  cause: 'quota_exhausted',
  from: entry('one'),
  used: [entry('one')],
};

function quotaStatus(profile: string, exhausted: boolean): QuotaStatus {
  return {
    profile,
    state: exhausted ? 'exhausted' : 'ok',
    cause: exhausted ? 'quota' : null,
    untilReset: null,
    windows: [],
    observedAt: null,
    nearLimitWindow: null,
    reason: exhausted ? 'exhausted' : 'ok',
  };
}

interface Acquire {
  readonly director?: boolean | undefined;
  readonly cwd: string;
}

async function rig(resume = '', out: ReadonlySet<string> = new Set()) {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const config = parseConfig(`
orchestration:
  executor: { client: fake, profile: one, model: fake-model }
executors:
  ${entry('one')}: { client: fake, profile: one, model: fake-model }
  ${entry('two')}: { client: fake, profile: two, model: fake-model }
roles:
  actor: { executors: [${entry('one')}, ${entry('two')}] }
selection:
  recheck_every: off
${resume}`);
  for (const name of ['one', 'two']) {
    await store.profiles.create({
      client: 'fake',
      name,
      kind: 'token_plan',
      provider: 'fake',
      dir: `/p/${name}`,
      secretRef: null,
    });
  }
  const paths = dataPaths('/data');
  const selection = new RoleSelection({
    store,
    config,
    quota: {
      statusOf: (target) => {
        const id = typeof target === 'string' ? target : `${target.client}/${target.profile}`;
        return Promise.resolve(quotaStatus(id, out.has(id)));
      },
    },
    pool: { slotOf: () => 'free' },
    paths,
    clock,
    logger: createSilentLogger(),
  });
  const acquired: Acquire[] = [];
  const prompts: string[] = [];
  const pool = {
    acquire: (request: Acquire) => {
      acquired.push(request);
      let listener: ((update: unknown) => void) | undefined;
      return Promise.resolve({
        session: {
          onUpdate: (callback: (update: unknown) => void) => {
            listener = callback;
            return { dispose: () => undefined };
          },
          prompt: (blocks: readonly { text: string }[]) => {
            prompts.push(blocks.map((block) => block.text).join('\n'));
            listener?.({
              kind: 'agent_message_chunk',
              content: { type: 'text', text: ' The short summary. ' },
            });
            return Promise.resolve();
          },
        },
        release: () => Promise.resolve(),
      });
    },
  };
  const source: PromptSource = {
    roles: () => Promise.resolve(['actor']),
    get: (role) => Promise.resolve(`You are the ${role}.`),
  };
  const port = createDaemonHandoff({
    config,
    store,
    selection,
    execution: { pool } as never,
    prompts: source,
    registries: buildDaemonRegistries(),
    paths,
    logger: createSilentLogger(),
    home: '/home/someone',
    dataDir: '/data',
  });
  return { port, acquired, prompts };
}

describe('the late port of the baton', () => {
  it('answers none with not_ready while nothing is bound, and the real port after', async () => {
    const late = createLateHandoff();
    expect(await late.port.choose(REQUEST)).toEqual({ kind: 'none', reason: 'not_ready' });
    expect(late.port.summarizer).toBeUndefined();
    expect(late.port.secretPaths).toBeUndefined();
    expect(await late.port.prefixOf('actor')).toBe('');

    const real: HandoffPort = {
      prefixOf: () => 'PREFIX',
      choose: () => Promise.resolve({ kind: 'none', reason: 'no_role' }),
      secretPaths: ['/x'],
      home: '/h',
    };
    late.bind(real);
    expect(await late.port.choose(REQUEST)).toEqual({ kind: 'none', reason: 'no_role' });
    expect(await late.port.prefixOf('actor')).toBe('PREFIX');
    expect(late.port.secretPaths).toEqual(['/x']);
    expect(late.port.home).toBe('/h');

    late.bind(undefined);
    expect(await late.port.choose(REQUEST)).toEqual({ kind: 'none', reason: 'not_ready' });
  });
});

describe('the baton of the daemon', () => {
  it('chooses the next Executor of the role, never one that already worked', async () => {
    const { port } = await rig();
    const choice = await port.choose(REQUEST);
    expect(choice.kind).toBe('selected');
    if (choice.kind !== 'selected') return;
    expect(choice.target.executorId).toBe(entry('two'));
    expect(choice.target.profile.id).toBe('fake/two');
    expect(choice.target.executor.model).toBe('fake-model');
    // The pipeline sets neither: the defaults of the spec stay.
    expect(choice.target.whenExhausted).toBeUndefined();
    expect(choice.target.inFlight).toBeUndefined();
  });

  it('says why there is nobody when the others are out of quota', async () => {
    const { port } = await rig('', new Set(['fake/two']));
    const choice = await port.choose(REQUEST);
    expect(choice.kind).toBe('none');
  });

  it('gives the stable prefix of the role and the resolved secret list', async () => {
    const { port } = await rig();
    expect(await port.prefixOf('actor')).toContain('You are the actor.');
    expect(await port.prefixOf(undefined)).toBe('');
    expect(port.home).toBe('/home/someone');
    expect(port.secretPaths?.length ?? 0).toBeGreaterThan(0);
  });

  it('has no summarizer unless resume.package.summarize is director_model', async () => {
    const { port } = await rig();
    expect(port.summarizer).toBeUndefined();
  });

  it('writes the summary with the Director model on a short director lease', async () => {
    const { port, acquired, prompts } = await rig(
      'resume:\n  package:\n    summarize: director_model\n',
    );
    expect(port.summarizer).toBeDefined();
    const text = await port.summarizer?.summarize({
      role: 'actor',
      demand: 'write alpha',
      deterministic: 'files: a.ts',
    });
    expect(text).toBe('The short summary.');
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.director).toBe(true);
    expect(prompts[0]).toContain('write alpha');
    expect(prompts[0]).toContain('files: a.ts');
  });
});
