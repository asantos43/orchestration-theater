// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../cli.js';
import type { ClientFactory } from '../clients.js';
import { InstanceLock } from '../instance-lock.js';
import { dataPaths } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { fixtureOpenCodeCatalog } from './opencode-catalog-fixture.js';
import type { TestSession } from './test-session.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const ID = 'minimax-m2-medium@opencode/local';

interface Rig {
  readonly dir: string;
  run(
    argv: readonly string[],
    extra?: Partial<CliDeps>,
  ): Promise<{ code: number; out: string[]; err: string[] }>;
  json(
    argv: readonly string[],
    extra?: Partial<CliDeps>,
  ): Promise<{ code: number; value: unknown }>;
  config(): Promise<string>;
}

function rigFor(dir: string): Rig {
  const vault = new InMemorySecretVault();
  const clock = new FakeClock(NOW);
  const launcher = new FakeProcessLauncher();
  const transport = new FakeSessionTransport();
  const clients: ClientFactory = (parts) => [
    new FakeClientAdapter({
      id: 'opencode',
      launcher: parts.launcher,
      baseEnv: { PATH: '/bin' },
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: ['--acp'] },
      loginState: 'logged_in',
      // The real parser on the fixture of `opencode models --verbose`; the real command never runs.
      models: fixtureOpenCodeCatalog({ profileRoot: join(dir, 'profiles-of-catalog') }).catalog,
    }),
  ];
  const run: Rig['run'] = async (argv, extra = {}) => {
    const captured = { out: [] as string[], err: [] as string[] };
    const code = await main([...argv, '--data-dir', dir], {
      env: {},
      platform: 'linux',
      homedir: dir,
      out: (line) => captured.out.push(line),
      err: (line) => captured.err.push(line),
      systemLocale: 'en',
      version: '1.2.3',
      overrides: { clock, vault, launcher, transport },
      clients,
      ...extra,
    });
    return { ...captured, code };
  };
  const json: Rig['json'] = async (argv, extra) => {
    const result = await run([...argv, '--json'], extra);
    return { code: result.code, value: JSON.parse(result.out.join('\n')) as unknown };
  };
  return { dir, run, json, config: () => readFile(dataPaths(dir).config, 'utf8') };
}

async function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = await makeTempDataDir();
  try {
    const rig = rigFor(tmp.dir);
    const added = await rig.run(['profile', 'add', 'opencode', 'local', '--provider', 'minimax']);
    expect(added.code).toBe(0);
    await body(rig);
  } finally {
    await tmp.dispose();
  }
}

describe('ot executor models, add, list, check and remove', () => {
  it('models lists what the catalog offers with the fields it fills', async () => {
    await withRig(async (rig) => {
      const text = await rig.run(['executor', 'models', 'opencode/local']);
      expect(text.code).toBe(0);
      const all = text.out.join('\n');
      expect(all).toMatch(/minimax\/MiniMax-M2 .*effort=medium .*provider=minimax/);
      // A model whose catalog gives no family shows the field blank.
      expect(all).toMatch(/gateway\/mystery-model .*provider=\(blank\)/);
      const json = await rig.json(['executor', 'models', 'opencode/local']);
      const drafts = (json.value as { draft: { model: string; provider: string } }[]).map(
        (entry) => entry.draft,
      );
      expect(drafts.find((draft) => draft.model === 'minimax/MiniMax-M2')?.provider).toBe(
        'minimax',
      );
    });
  });

  it('add, in text and in JSON, with the cost from the catalog', async () => {
    await withRig(async (rig) => {
      const dry = await rig.run([
        'executor',
        'add',
        'opencode/local',
        'minimax/MiniMax-M2',
        '--dry-run',
      ]);
      expect(dry.code).toBe(0);
      expect(dry.out.join('\n')).toMatch(/Nothing was written \(--dry-run\)/);
      expect(await rig.config().catch(() => '')).not.toContain(ID);

      const text = await rig.run(['executor', 'add', 'opencode/local', 'minimax/MiniMax-M2']);
      expect(text.code).toBe(0);
      const all = text.out.join('\n');
      expect(all).toContain(`Executor ${ID} registered (provider minimax).`);
      expect(all).toMatch(/input 0\.3, output 1\.2/);
      expect(await rig.config()).toContain(ID);

      const again = await rig.run(['executor', 'add', 'opencode/local', 'minimax/MiniMax-M2']);
      expect(again.code).toBe(1);
      expect(again.err.join('\n')).toMatch(/already/);
    });
  });

  it('add --json reports the result; a refusal and a missing field exit 1 and write nothing', async () => {
    await withRig(async (rig) => {
      const missing = await rig.json([
        'executor',
        'add',
        'opencode/local',
        'gateway/mystery-model',
      ]);
      expect(missing.code).toBe(1);
      expect(missing.value).toMatchObject({
        status: 'needs_input',
        missing: ['family'],
        draft: { provider: null },
      });
      const text = await rig.run(['executor', 'add', 'opencode/local', 'gateway/mystery-model']);
      expect(text.out.join('\n')).toMatch(/Missing: family/);

      const refused = await rig.json([
        'executor',
        'add',
        'opencode/local',
        'local/completion-only',
      ]);
      expect(refused.code).toBe(1);
      expect(refused.value).toMatchObject({
        status: 'refused',
        issues: [expect.objectContaining({ code: 'no_tool_calls' })],
      });
      const refusedText = await rig.run([
        'executor',
        'add',
        'opencode/local',
        'local/completion-only',
      ]);
      expect(refusedText.out.join('\n')).toMatch(/\[error\] no_tool_calls/);
      expect(refusedText.out.join('\n')).toMatch(/Refused\. Nothing was written\./);

      const ok = await rig.json([
        'executor',
        'add',
        'opencode/local',
        'gateway/mystery-model',
        '--family',
        'mystery',
      ]);
      expect(ok.code).toBe(0);
      expect(ok.value).toMatchObject({ status: 'registered', executor: { provider: 'mystery' } });
    });
  });

  it('a local model writes the local block of the profile and says so', async () => {
    await withRig(async (rig) => {
      const result = await rig.run(['executor', 'add', 'opencode/local', 'local/qwen-coder']);
      expect(result.code).toBe(0);
      expect(result.out.join('\n')).toMatch(/profiles\.opencode\/local\.local written/);
      const config = await rig.config();
      expect(config).toMatch(/http:\/\/127\.0\.0\.1:8080\/v1/);
    });
  });

  it('--role and on_register: ask lists the roles, --role writes the list', async () => {
    await withRig(async (rig) => {
      const asked = await rig.run(['executor', 'add', 'opencode/local', 'minimax/MiniMax-M2']);
      expect(asked.out.join('\n')).toMatch(/executors\.on_register is "ask"/);
      await rig.run(['executor', 'remove', ID]);
      const placed = await rig.json([
        'executor',
        'add',
        'opencode/local',
        'minimax/MiniMax-M2',
        '--role',
        'critic:0',
      ]);
      expect(placed.value).toMatchObject({
        status: 'registered',
        placements: [{ role: 'critic', via: 'list', position: 0 }],
      });
      expect(await rig.config()).toMatch(/critic:/);
    });
  });

  it('list, check and remove', async () => {
    await withRig(async (rig) => {
      expect((await rig.run(['executor', 'list'])).out).toEqual(['No Executors.']);
      await rig.run(['executor', 'add', 'opencode/local', 'minimax/MiniMax-M2']);

      const list = await rig.run(['executor', 'list']);
      expect(list.out.join('\n')).toContain(`${ID} [valid]`);
      const byProfile = await rig.json(['executor', 'list', '--profile', 'opencode/none']);
      expect(byProfile.value).toEqual([]);

      const check = await rig.run(['executor', 'check']);
      expect(check.code).toBe(0);
      expect(check.out.join('\n')).toContain(`${ID} [valid]`);
      const checkJson = await rig.json(['executor', 'check', ID]);
      expect(checkJson.value).toEqual([expect.objectContaining({ id: ID, validity: 'valid' })]);

      const removed = await rig.run(['executor', 'remove', ID]);
      expect(removed.code).toBe(0);
      expect(removed.out.join('\n')).toContain(`Executor ${ID} removed.`);
      expect((await rig.run(['executor', 'list'])).out).toEqual(['No Executors.']);
      const all = await rig.json(['executor', 'list', '--all']);
      expect(all.value).toEqual([expect.objectContaining({ id: ID, validity: 'invalid' })]);
      const twice = await rig.run(['executor', 'remove', ID]);
      expect(twice.code).toBe(1);
    });
  });

  it('the short test session runs only when asked and fails the add when the model fails it', async () => {
    await withRig(async (rig) => {
      const calls: string[] = [];
      const session = (ok: boolean): TestSession => ({
        run: (request) => {
          calls.push(request.executorId);
          return Promise.resolve({ ok, detail: ok ? 'submitted' : 'nothing came back' });
        },
      });
      const plain = await rig.json(
        ['executor', 'add', 'opencode/local', 'minimax/MiniMax-M2', '--dry-run'],
        {
          executorTestSession: session(true),
        },
      );
      expect(plain.value).toMatchObject({ testSession: 'skipped' });
      expect(calls).toEqual([]);

      const bad = await rig.json(
        ['executor', 'add', 'opencode/local', 'minimax/MiniMax-M2', '--test-session'],
        { executorTestSession: session(false) },
      );
      expect(bad.value).toMatchObject({ status: 'registered', testSession: 'failed' });
      expect(calls).toEqual([ID]);
    });
  });

  it('refuses while a daemon holds the data directory, and speaks pt-BR when asked', async () => {
    await withRig(async (rig) => {
      const paths = dataPaths(rig.dir);
      const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
      try {
        const refused = await rig.run(['executor', 'list'], { systemLocale: 'pt-BR' });
        expect(refused.code).toBe(1);
        expect(refused.err[0]).toMatch(/O daemon está rodando/);
      } finally {
        await lock.release();
      }
      const empty = await rig.run(['executor', 'list'], { systemLocale: 'pt-BR' });
      expect(empty.out).toEqual(['Nenhum Executor.']);
      const added = await rig.run(['executor', 'add', 'opencode/local', 'minimax/MiniMax-M2'], {
        systemLocale: 'pt-BR',
      });
      expect(added.out.join('\n')).toMatch(/Executor minimax-m2-medium@opencode\/local cadastrado/);
    });
  });

  it.each([
    ['no action', ['executor'], /needs an action/],
    ['an unknown action', ['executor', 'burn'], /Unknown action "burn"/],
    ['models without the profile', ['executor', 'models'], /needs the profile id/],
    [
      'add without the model',
      ['executor', 'add', 'opencode/local'],
      /needs the profile id and the model/,
    ],
    ['too many arguments', ['executor', 'list', 'x'], /Too many arguments/],
    ['remove without the id', ['executor', 'remove'], /needs the Executor id/],
    [
      'a bad role',
      ['executor', 'add', 'opencode/local', 'minimax/MiniMax-M2', '--role', 'boss'],
      /roles: /,
    ],
    [
      'a bad position',
      ['executor', 'add', 'opencode/local', 'minimax/MiniMax-M2', '--role', 'critic:x'],
      /the position is a number/,
    ],
    [
      'a bad local server',
      ['executor', 'add', 'opencode/local', 'local/qwen-coder', '--local-server', 'vllm'],
      /llama-cpp or ollama/,
    ],
    [
      'both test-session flags',
      [
        'executor',
        'add',
        'opencode/local',
        'minimax/MiniMax-M2',
        '--test-session',
        '--no-test-session',
      ],
      /only one of/,
    ],
  ])('usage error: %s', async (_name, argv, message) => {
    await withRig(async (rig) => {
      const result = await rig.run(argv);
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toMatch(message);
    });
  });
});
