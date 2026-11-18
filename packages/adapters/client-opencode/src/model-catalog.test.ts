// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  Transient,
  type Executor,
  type ModelInfo,
  type ProfileRef,
} from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODELS_VERBOSE_OUTPUT, renderVerbose } from './fixtures/models-verbose.js';
import {
  acceptsEffort,
  isLocalUrl,
  OpenCodeModelCatalog,
  parseModelsVerbose,
  requireProfileDir,
  type OpenCodeModelCatalogOptions,
} from './model-catalog.js';
import { ScriptedLauncher, type Script } from './testing/scripted-launcher.js';

const PROFILE: ProfileRef = { client: 'opencode', profile: 'work' };

function byId(models: readonly ModelInfo[], id: string): ModelInfo {
  const found = models.find((model) => model.id === id);
  if (found === undefined) throw new Error(`model ${id} not in the list`);
  return found;
}

describe('parseModelsVerbose', () => {
  const parsed = parseModelsVerbose(MODELS_VERBOSE_OUTPUT);

  it('reads every model of the fixture and skips none', () => {
    expect(parsed.skipped).toBe(0);
    expect(parsed.models.map((model) => model.id)).toEqual([
      'alpha/reasoner-large',
      'alpha/reasoner-small',
      'gateway/alpha-reasoner-large',
      'gateway/mystery-model',
      'local/llama-8b',
      'local/completion-only',
      'beta/unspecified',
    ]);
  });

  it('takes the efforts from the variants, the name and the family from the registry', () => {
    expect(byId(parsed.models, 'alpha/reasoner-large')).toMatchObject({
      name: 'Reasoner Large',
      family: 'reasoner',
      efforts: ['low', 'medium', 'high'],
    });
    expect(byId(parsed.models, 'alpha/reasoner-small').efforts).toEqual([]);
  });

  it('never takes the family from the prefix of the id, and leaves an empty family unset', () => {
    const gateway = byId(parsed.models, 'gateway/alpha-reasoner-large');
    expect(gateway.family).toBe('reasoner');
    expect(byId(parsed.models, 'gateway/mystery-model')).not.toHaveProperty('family');
  });

  it('reads the context window, the tool calls and the cost', () => {
    expect(byId(parsed.models, 'alpha/reasoner-large')).toMatchObject({
      contextWindow: 200000,
      toolCalls: true,
      cost: {
        inputPerMTokUsd: 3,
        outputPerMTokUsd: 15,
        cacheReadPerMTokUsd: 0.3,
        cacheWritePerMTokUsd: 3.75,
      },
    });
    expect(byId(parsed.models, 'alpha/reasoner-small').cost).toEqual({
      inputPerMTokUsd: 0.25,
      outputPerMTokUsd: 1.25,
    });
    expect(byId(parsed.models, 'local/completion-only').toolCalls).toBe(false);
  });

  it('reads whether the model reasons and where it is called (the cadastro of P14 uses both)', () => {
    expect(byId(parsed.models, 'alpha/reasoner-large')).toMatchObject({
      reasoning: true,
      baseUrl: 'https://api.alpha.example/v1',
    });
    expect(byId(parsed.models, 'local/llama-8b').baseUrl).toBe('http://localhost:11434/v1');
    expect(byId(parsed.models, 'beta/unspecified').reasoning).toBeUndefined();
  });

  it('does not invent what the list does not say', () => {
    const model = byId(parsed.models, 'beta/unspecified');
    expect(model).not.toHaveProperty('toolCalls');
    expect(model).not.toHaveProperty('cost');
    expect(model).not.toHaveProperty('contextWindow');
    expect(byId(parsed.models, 'gateway/mystery-model')).not.toHaveProperty('cost');
  });

  it('marks as local only a model whose api url is on this machine', () => {
    expect(byId(parsed.models, 'local/llama-8b').local).toBe(true);
    expect(byId(parsed.models, 'local/completion-only').local).toBe(true);
    expect(byId(parsed.models, 'alpha/reasoner-large').local).toBe(false);
    expect(byId(parsed.models, 'beta/unspecified').local).toBe(false);
  });

  it('skips a block with broken JSON and keeps the rest', () => {
    const output = [
      'bad/model',
      '{',
      '  "id": ',
      '}',
      renderVerbose({ 'ok/model': { name: 'Ok' } }),
    ].join('\n');
    const result = parseModelsVerbose(output);
    expect(result.skipped).toBe(1);
    expect(result.models.map((model) => model.id)).toEqual(['ok/model']);
  });

  it('keeps a header with no block (plain `opencode models`) with what the id says', () => {
    const result = parseModelsVerbose('a/one\nb/two\n');
    expect(result.models).toEqual([
      { id: 'a/one', efforts: [], local: false },
      { id: 'b/two', efforts: [], local: false },
    ]);
  });

  it('ignores a notice before the list, CRLF line ends and duplicated ids', () => {
    const output = `Update available!\r\n${MODELS_VERBOSE_OUTPUT.replace(/\n/g, '\r\n')}\r\n${MODELS_VERBOSE_OUTPUT}`;
    const result = parseModelsVerbose(output);
    expect(result.models).toHaveLength(7);
  });

  it('a block that never closes is counted as skipped, not guessed', () => {
    const result = parseModelsVerbose('a/one\n{\n  "name": "x"\n');
    expect(result.models).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('gives nothing for empty output', () => {
    expect(parseModelsVerbose('')).toEqual({ models: [], skipped: 0 });
  });
});

describe('isLocalUrl and acceptsEffort', () => {
  it('recognises the loopback hosts and nothing else', () => {
    expect(isLocalUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLocalUrl('http://LOCALHOST/v1')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalUrl('http://[::1]:9000')).toBe(true);
    expect(isLocalUrl('https://localhost.example.com')).toBe(false);
    expect(isLocalUrl('http://192.168.0.5')).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
  });

  it('accepts the variants of the model and `default`', () => {
    const model: ModelInfo = { id: 'a/b', efforts: ['low', 'high'], local: false };
    expect(acceptsEffort(model, 'low')).toBe(true);
    expect(acceptsEffort(model, 'default')).toBe(true);
    expect(acceptsEffort(model, 'medium')).toBe(false);
  });
});

describe('OpenCodeModelCatalog', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'otheater-opencode-catalog-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function catalog(
    script: Script | readonly Script[],
    extra: Partial<OpenCodeModelCatalogOptions> = {},
  ): { catalog: OpenCodeModelCatalog; launcher: ScriptedLauncher } {
    const launcher = new ScriptedLauncher(
      ...((Array.isArray(script) ? script : [script]) as readonly Script[]),
    );
    return {
      launcher,
      catalog: new OpenCodeModelCatalog({
        launcher,
        baseEnv: { PATH: '/usr/bin', HOME: '/home/base' },
        profileDir: (profile) => join(root, profile.profile),
        ...extra,
      }),
    };
  }

  const good: Script = { stdout: MODELS_VERBOSE_OUTPUT };

  it('discovers by assistance: the list comes from the client, the Producer confirms', () => {
    expect(catalog(good).catalog.discovery).toBe('assisted');
  });

  it('runs `opencode models --verbose` in the profile dir with the isolation env', async () => {
    const { catalog: models, launcher } = catalog(good);
    const list = await models.list(PROFILE);
    expect(list).toHaveLength(7);
    expect(launcher.launched).toHaveLength(1);
    const options = launcher.launched[0]?.options;
    const dir = join(root, 'work');
    expect(options).toMatchObject({ cmd: 'opencode', args: ['models', '--verbose'], cwd: dir });
    expect(options?.env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/base',
      XDG_DATA_HOME: join(dir, 'data'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      OPENCODE_DB: join(dir, 'db', 'opencode.db'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    });
  });

  it('uses the configured command, closes stdin and kills the tree when done', async () => {
    const { catalog: models, launcher } = catalog(good, { cmd: '/opt/oc/opencode' });
    await models.list(PROFILE);
    const process = launcher.launched[0];
    expect(process?.options.cmd).toBe('/opt/oc/opencode');
    expect(process?.stdinClosed).toBe(true);
    expect(process?.killTreeCalls).toBe(1);
  });

  it('prepares the profile files the same way the adapter does', async () => {
    const { catalog: models } = catalog(good);
    await models.list(PROFILE);
    const config = await readFile(
      join(root, 'work', 'config', 'opencode', 'opencode.json'),
      'utf8',
    );
    expect(JSON.parse(config)).toMatchObject({ autoupdate: false, share: 'disabled' });
  });

  it('reads a list that arrives in many chunks', async () => {
    const { catalog: models } = catalog({ ...good, chunks: 17 });
    expect(await models.list(PROFILE)).toHaveLength(7);
  });

  it('reuses the list inside the cache window and reads again after it', async () => {
    let clock = 1_000;
    const { catalog: models, launcher } = catalog(good, { cacheMs: 100, now: () => clock });
    await models.list(PROFILE);
    clock += 50;
    await models.list(PROFILE);
    expect(launcher.launched).toHaveLength(1);
    clock += 60;
    await models.list(PROFILE);
    expect(launcher.launched).toHaveLength(2);
  });

  it('cacheMs 0 reads every time, and each profile has its own cache', async () => {
    const zero = catalog(good, { cacheMs: 0 });
    await zero.catalog.list(PROFILE);
    await zero.catalog.list(PROFILE);
    expect(zero.launcher.launched).toHaveLength(2);
    const two = catalog(good);
    await two.catalog.list(PROFILE);
    await two.catalog.list({ client: 'opencode', profile: 'home' });
    expect(two.launcher.launched).toHaveLength(2);
  });

  it('shares one read between simultaneous calls', async () => {
    const { catalog: models, launcher } = catalog(good, { cacheMs: 0 });
    const [first, second] = await Promise.all([models.list(PROFILE), models.list(PROFILE)]);
    expect(launcher.launched).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('does not cache a failure', async () => {
    const { catalog: models, launcher } = catalog([{ code: 1, stderr: 'boom' }, good]);
    await expect(models.list(PROFILE)).rejects.toBeInstanceOf(AdapterUnavailable);
    expect(await models.list(PROFILE)).toHaveLength(7);
    expect(launcher.launched).toHaveLength(2);
  });

  it('a non-zero exit is AdapterUnavailable with the tail of stderr', async () => {
    const { catalog: models, launcher } = catalog({ code: 2, stderr: 'no such provider' });
    await expect(models.list(PROFILE)).rejects.toThrow(/code 2.*no such provider/s);
    expect(launcher.launched[0]?.killTreeCalls).toBe(1);
  });

  it('a process that ends by signal says so', async () => {
    const { catalog: models } = catalog({ code: null });
    await expect(models.list(PROFILE)).rejects.toThrow(/ended with signal/);
  });

  it('output with no readable model is AdapterUnavailable, not an empty list', async () => {
    await expect(catalog({ stdout: '' }).catalog.list(PROFILE)).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
    await expect(
      catalog({ stdout: 'warning: nothing here\n' }).catalog.list(PROFILE),
    ).rejects.toThrow(/no model that could be read/);
  });

  it('a process that never ends is Transient after the timeout, and is killed', async () => {
    const { catalog: models, launcher } = catalog({ hang: true }, { timeoutMs: 30 });
    await expect(models.list(PROFILE)).rejects.toBeInstanceOf(Transient);
    expect(launcher.launched[0]?.killTreeCalls).toBe(1);
  });

  it('refuses an output larger than the limit', async () => {
    const { catalog: models } = catalog(good, { maxOutputBytes: 100 });
    await expect(models.list(PROFILE)).rejects.toThrow(/larger than 100 bytes/);
  });

  it('a profile dir that is not absolute is InvalidInput', async () => {
    const { catalog: models } = catalog(good, { profileDir: () => 'relative/dir' });
    await expect(models.list(PROFILE)).rejects.toBeInstanceOf(InvalidInput);
  });

  describe('suggest', () => {
    const { catalog: models } = catalog(good);
    const parsed = parseModelsVerbose(MODELS_VERBOSE_OUTPUT).models;

    it('fills effort (medium when offered), family, local, window and cost', () => {
      expect(models.suggest(byId(parsed, 'alpha/reasoner-large'))).toEqual({
        effort: 'medium',
        family: 'reasoner',
        local: false,
        contextWindow: 200000,
        cost: {
          inputPerMTokUsd: 3,
          outputPerMTokUsd: 15,
          cacheReadPerMTokUsd: 0.3,
          cacheWritePerMTokUsd: 3.75,
        },
      });
    });

    it('falls to the next preference, then to the first variant, then to nothing', () => {
      expect(models.suggest(byId(parsed, 'gateway/alpha-reasoner-large')).effort).toBe('low');
      expect(models.suggest(byId(parsed, 'gateway/mystery-model')).effort).toBe('max');
      expect(models.suggest(byId(parsed, 'alpha/reasoner-small'))).not.toHaveProperty('effort');
    });

    it('leaves out the family the registry does not give', () => {
      expect(models.suggest(byId(parsed, 'gateway/mystery-model'))).not.toHaveProperty('family');
    });

    it('flags a local model and leaves out a missing window and price', () => {
      expect(models.suggest(byId(parsed, 'local/llama-8b'))).toMatchObject({ local: true });
      const bare = models.suggest(byId(parsed, 'beta/unspecified'));
      expect(bare).not.toHaveProperty('contextWindow');
      expect(bare).not.toHaveProperty('cost');
    });

    it('follows the configured effort preference', () => {
      const custom = catalog(good, { effortPreference: ['high', 'low'] }).catalog;
      expect(custom.suggest(byId(parsed, 'alpha/reasoner-large')).effort).toBe('high');
    });
  });

  describe('validate', () => {
    const executor = (model: string, effort?: string): Executor => ({
      profile: PROFILE,
      model,
      ...(effort === undefined ? {} : { effort }),
    });

    it('passes a model that exists, with an accepted effort and tool calls', async () => {
      const { catalog: models } = catalog(good);
      expect(await models.validate(executor('alpha/reasoner-large', 'high'))).toEqual({
        ok: true,
        issues: [],
      });
      expect((await models.validate(executor('alpha/reasoner-large', 'default'))).ok).toBe(true);
      expect((await models.validate(executor('alpha/reasoner-large'))).ok).toBe(true);
    });

    it('fails a model that is not in the list', async () => {
      const result = await catalog(good).catalog.validate(executor('alpha/missing'));
      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toEqual(['model_not_found']);
    });

    it('fails an effort the model does not offer', async () => {
      const result = await catalog(good).catalog.validate(executor('alpha/reasoner-large', 'max'));
      expect(result.ok).toBe(false);
      expect(result.issues[0]).toMatchObject({ code: 'effort_not_accepted', severity: 'error' });
    });

    it('fails a model that does not call tools', async () => {
      const result = await catalog(good).catalog.validate(executor('local/completion-only'));
      expect(result.ok).toBe(false);
      expect(result.issues[0]).toMatchObject({ code: 'no_tool_calls', severity: 'error' });
    });

    it('only warns when the list does not say whether the model calls tools', async () => {
      const result = await catalog(good).catalog.validate(executor('beta/unspecified'));
      expect(result.ok).toBe(true);
      expect(result.issues[0]).toMatchObject({ code: 'no_tool_calls', severity: 'warning' });
    });

    it('checks the context window only when a minimum is set, with the configured severity', async () => {
      const unchecked = await catalog(good).catalog.validate(executor('alpha/reasoner-small'));
      expect(unchecked.issues).toEqual([]);
      const warn = await catalog(good, { minContextWindow: 100000 }).catalog.validate(
        executor('alpha/reasoner-small'),
      );
      expect(warn.ok).toBe(true);
      expect(warn.issues[0]).toMatchObject({ code: 'context_too_small', severity: 'warning' });
      const error = await catalog(good, {
        minContextWindow: 100000,
        contextSeverity: 'error',
      }).catalog.validate(executor('alpha/reasoner-small'));
      expect(error.ok).toBe(false);
      const unknown = await catalog(good, { minContextWindow: 1 }).catalog.validate(
        executor('beta/unspecified'),
      );
      expect(unknown.issues.map((issue) => issue.code)).toContain('context_too_small');
    });

    it('a profile the list cannot be read for is profile_invalid', async () => {
      const result = await catalog({ code: 1, stderr: 'broken' }).catalog.validate(
        executor('alpha/reasoner-large'),
      );
      expect(result.ok).toBe(false);
      expect(result.issues[0]).toMatchObject({ code: 'profile_invalid', severity: 'error' });
    });

    it('a Transient failure is rethrown: a busy machine does not invalidate an Executor', async () => {
      const { catalog: models } = catalog({ hang: true }, { timeoutMs: 20 });
      await expect(models.validate(executor('alpha/reasoner-large'))).rejects.toBeInstanceOf(
        Transient,
      );
    });
  });
});

describe('requireProfileDir', () => {
  it('returns the resolver, or one that fails when used', () => {
    const resolver = (): string => '/x';
    expect(requireProfileDir(resolver)).toBe(resolver);
    expect(() => requireProfileDir(undefined)(PROFILE)).toThrow(InvalidInput);
  });
});
