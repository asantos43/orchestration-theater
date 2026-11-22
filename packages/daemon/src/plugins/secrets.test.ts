// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { InvalidInput, Secret, VaultLocked, type SecretVault } from '@otheater/core';
import { FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Redactor } from '../telemetry/redaction.js';
import { VaultValues } from '../telemetry/vault-values.js';
import { captureLogger } from '../test-helpers.js';
import type { ActivePlugin } from './aggregate.js';
import { maskValues, type PluginConnector } from './mcp-client.js';
import { PluginCallError, PluginProcessPool } from './process-pool.js';
import { DEFAULT_PLUGIN_RUNTIME, type PluginNotice } from './runtime-config.js';
import { PluginSecrets, pluginExtraEnv, pluginSecretKey } from './secrets.js';
import { fixturePlugin } from './test-plugin-fixture.js';

// A value long enough for the telemetry redaction (it does not search short ones).
const TOKEN = 'tok-general-0123456789';
const PROJECT_TOKEN = 'tok-project-9876543210';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** The fixture plugin, with the secrets its manifest declares. */
function withSecrets(names: readonly string[]): ActivePlugin {
  const base = fixturePlugin();
  return { ...base, manifest: { ...base.manifest, secrets: [...names] } };
}

function setup(options: { vault?: SecretVault; connector?: PluginConnector } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ot-secrets-'));
  homes.push(home);
  const vault = options.vault ?? new InMemorySecretVault();
  const { logger, lines } = captureLogger();
  const notices: PluginNotice[] = [];
  const pool = new PluginProcessPool({
    clock: new FakeClock(),
    logger,
    runtime: () => DEFAULT_PLUGIN_RUNTIME,
    homeRoot: home,
    extraEnv: pluginExtraEnv({ vault, logger, onNotice: (notice) => notices.push(notice) }),
    ...(options.connector === undefined ? {} : { connector: options.connector }),
  });
  return { pool, vault, logger, lines, notices };
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

async function report(
  pool: PluginProcessPool,
  plugin: ActivePlugin,
  project: string,
  name: string,
): Promise<{ keys: string[]; value: string | null }> {
  const result = await pool.call(plugin, project, 'env_report', { name });
  return JSON.parse(textOf(result)) as { keys: string[]; value: string | null };
}

describe('pluginSecretKey', () => {
  it('names the general value and the one of a project', () => {
    expect(pluginSecretKey('demo', 'API_TOKEN')).toBe('plugin/demo/API_TOKEN');
    expect(pluginSecretKey('demo', 'API_TOKEN', 'p1')).toBe('plugin/demo/p1/API_TOKEN');
  });
});

describe('PluginSecrets', () => {
  it('stores under the key and reads it back', async () => {
    const vault = new InMemorySecretVault();
    const secrets = new PluginSecrets(vault);
    await secrets.set('demo', 'API_TOKEN', new Secret(TOKEN));
    await secrets.set('demo', 'API_TOKEN', new Secret(PROJECT_TOKEN), 'p1');
    expect((await vault.get('plugin/demo/API_TOKEN'))?.reveal()).toBe(TOKEN);
    expect((await vault.get('plugin/demo/p1/API_TOKEN'))?.reveal()).toBe(PROJECT_TOKEN);
    expect(await secrets.has('demo', 'API_TOKEN')).toBe(true);
    expect(await secrets.has('demo', 'OTHER')).toBe(false);
    expect(await secrets.has('demo', 'API_TOKEN', 'p2')).toBe(false);
  });

  it('refuses an empty value', async () => {
    const secrets = new PluginSecrets(new InMemorySecretVault());
    await expect(secrets.set('demo', 'API_TOKEN', new Secret(''))).rejects.toBeInstanceOf(
      InvalidInput,
    );
  });

  it('the value of the project wins over the general one, which is the fallback', async () => {
    const secrets = new PluginSecrets(new InMemorySecretVault());
    await secrets.set('demo', 'API_TOKEN', new Secret(TOKEN));
    await secrets.set('demo', 'API_TOKEN', new Secret(PROJECT_TOKEN), 'p1');
    await secrets.set('demo', 'ONLY_GENERAL', new Secret(TOKEN));
    const p1 = await secrets.resolve('demo', ['API_TOKEN', 'ONLY_GENERAL'], 'p1');
    expect(p1).toEqual({ env: { API_TOKEN: PROJECT_TOKEN, ONLY_GENERAL: TOKEN }, missing: [] });
    const p2 = await secrets.resolve('demo', ['API_TOKEN', 'ONLY_GENERAL'], 'p2');
    expect(p2).toEqual({ env: { API_TOKEN: TOKEN, ONLY_GENERAL: TOKEN }, missing: [] });
  });

  it('lists the missing names in the order of the manifest; an empty value counts as missing', async () => {
    const vault = new InMemorySecretVault();
    await vault.set('plugin/demo/B', new Secret(''));
    await vault.set('plugin/demo/C', new Secret(TOKEN));
    const found = await new PluginSecrets(vault).resolve('demo', ['A', 'B', 'C'], 'p1');
    expect(found).toEqual({ env: { C: TOKEN }, missing: ['A', 'B'] });
  });

  it('falls back to the general value when the project is not a valid key', async () => {
    const secrets = new PluginSecrets(new InMemorySecretVault());
    await secrets.set('demo', 'API_TOKEN', new Secret(TOKEN));
    const found = await secrets.resolve('demo', ['API_TOKEN'], 'bad project!');
    expect(found.env).toEqual({ API_TOKEN: TOKEN });
  });

  it('keeps the secrets of another plugin apart', async () => {
    const secrets = new PluginSecrets(new InMemorySecretVault());
    await secrets.set('other', 'API_TOKEN', new Secret(TOKEN));
    const found = await secrets.resolve('demo', ['API_TOKEN'], 'p1');
    expect(found).toEqual({ env: {}, missing: ['API_TOKEN'] });
  });
});

describe('pluginExtraEnv', () => {
  it('never touches the vault for a plugin that declares no secret', async () => {
    const get = vi.fn();
    const vault = { get, set: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as SecretVault;
    const { logger } = captureLogger();
    const extra = pluginExtraEnv({ vault, logger });
    expect(await extra(fixturePlugin(), 'p1')).toEqual({});
    expect(await extra(withSecrets([]), 'p1')).toEqual({});
    expect(get).not.toHaveBeenCalled();
  });

  it('hands the values over', async () => {
    const vault = new InMemorySecretVault();
    await new PluginSecrets(vault).set('demo', 'API_TOKEN', new Secret(TOKEN));
    const { logger } = captureLogger();
    const extra = pluginExtraEnv({ vault, logger });
    expect(await extra(withSecrets(['API_TOKEN']), 'p1')).toEqual({ API_TOKEN: TOKEN });
  });

  it('a missing secret: unavailable, one warning and one notice, with names and no value', async () => {
    const vault = new InMemorySecretVault();
    await new PluginSecrets(vault).set('demo', 'HAS_VALUE', new Secret(TOKEN));
    const { logger, lines } = captureLogger();
    const notices: PluginNotice[] = [];
    const extra = pluginExtraEnv({ vault, logger, onNotice: (notice) => notices.push(notice) });
    const plugin = withSecrets(['HAS_VALUE', 'API_TOKEN', 'OTHER']);
    const failure = await extra(plugin, 'p1').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PluginCallError);
    expect((failure as PluginCallError).code).toBe('unavailable');
    expect((failure as PluginCallError).message).toContain('API_TOKEN, OTHER');
    expect((failure as PluginCallError).message).not.toContain(TOKEN);
    // The same set again does not repeat the warning or the notice.
    await expect(extra(plugin, 'p1')).rejects.toBeInstanceOf(PluginCallError);
    expect(notices).toEqual([
      { kind: 'secret_missing', plugin: 'demo', project: 'p1', secrets: ['API_TOKEN', 'OTHER'] },
    ]);
    const warnings = lines.filter((line) => line.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    // Another project is told on its own.
    await expect(extra(plugin, 'p2')).rejects.toBeInstanceOf(PluginCallError);
    expect(notices).toHaveLength(2);
  });

  it('says it again when the set of missing names changes, or after it worked', async () => {
    const vault = new InMemorySecretVault();
    const secrets = new PluginSecrets(vault);
    const { logger } = captureLogger();
    const notices: PluginNotice[] = [];
    const extra = pluginExtraEnv({ vault, logger, onNotice: (notice) => notices.push(notice) });
    const plugin = withSecrets(['A', 'B']);
    await expect(extra(plugin, 'p1')).rejects.toBeInstanceOf(PluginCallError);
    await secrets.set('demo', 'A', new Secret(TOKEN));
    await expect(extra(plugin, 'p1')).rejects.toBeInstanceOf(PluginCallError);
    expect(
      notices.map((notice) => (notice.kind === 'secret_missing' ? notice.secrets : [])),
    ).toEqual([['A', 'B'], ['B']]);
    await secrets.set('demo', 'B', new Secret(TOKEN));
    expect(await extra(plugin, 'p1')).toEqual({ A: TOKEN, B: TOKEN });
    await vault.delete('plugin/demo/B');
    await expect(extra(plugin, 'p1')).rejects.toBeInstanceOf(PluginCallError);
    expect(notices).toHaveLength(3);
  });

  it('a notice sink that throws does not change the answer', async () => {
    const { logger, lines } = captureLogger();
    const extra = pluginExtraEnv({
      vault: new InMemorySecretVault(),
      logger,
      onNotice: () => {
        throw new Error('sink down');
      },
    });
    await expect(extra(withSecrets(['A']), 'p1')).rejects.toBeInstanceOf(PluginCallError);
    expect(lines.some((line) => line.msg === 'plugin notice sink failed')).toBe(true);
  });

  it('a locked vault: unavailable and no notice', async () => {
    const vault: SecretVault = {
      get: () => Promise.reject(new VaultLocked('locked')),
      set: () => Promise.reject(new VaultLocked('locked')),
      delete: () => Promise.reject(new VaultLocked('locked')),
      list: () => Promise.reject(new VaultLocked('locked')),
    };
    const { logger, lines } = captureLogger();
    const notices: PluginNotice[] = [];
    const extra = pluginExtraEnv({ vault, logger, onNotice: (notice) => notices.push(notice) });
    const failure = await extra(withSecrets(['A']), 'p1').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PluginCallError);
    expect((failure as PluginCallError).code).toBe('unavailable');
    expect(notices).toEqual([]);
    expect(lines.some((line) => line.level === 'warn')).toBe(true);
  });
});

describe('the process pool with secrets (real test server)', () => {
  it('hands the secret to the server as an environment variable, and to nothing else', async () => {
    const { pool, vault, lines, notices } = setup();
    await new PluginSecrets(vault).set('demo', 'API_TOKEN', new Secret(TOKEN));
    const plugin = withSecrets(['API_TOKEN']);
    try {
      const seen = await report(pool, plugin, 'p1', 'API_TOKEN');
      expect(seen.value).toBe(TOKEN);
      expect(seen.keys).toContain('API_TOKEN');
      // The daemon itself never had it in its environment.
      expect(process.env.API_TOKEN).toBeUndefined();
      // The log and the notices carry no value.
      expect(JSON.stringify(lines)).not.toContain(TOKEN);
      expect(JSON.stringify(notices)).not.toContain(TOKEN);
    } finally {
      await pool.stop();
    }
  });

  it('the value of the project wins over the general one, and each project gets its own', async () => {
    const { pool, vault } = setup();
    const secrets = new PluginSecrets(vault);
    await secrets.set('demo', 'API_TOKEN', new Secret(TOKEN));
    await secrets.set('demo', 'API_TOKEN', new Secret(PROJECT_TOKEN), 'p1');
    const plugin = withSecrets(['API_TOKEN']);
    try {
      expect((await report(pool, plugin, 'p1', 'API_TOKEN')).value).toBe(PROJECT_TOKEN);
      expect((await report(pool, plugin, 'p2', 'API_TOKEN')).value).toBe(TOKEN);
    } finally {
      await pool.stop();
    }
  });

  it('without the secret the server does not start in that project, and the notice goes out', async () => {
    const { pool, vault, lines, notices } = setup();
    const plugin = withSecrets(['API_TOKEN']);
    try {
      await expect(pool.ensure(plugin, 'p1')).rejects.toMatchObject({ code: 'unavailable' });
      expect(pool.running).toBe(0);
      expect(notices).toEqual([
        { kind: 'secret_missing', plugin: 'demo', project: 'p1', secrets: ['API_TOKEN'] },
      ]);
      expect(lines.some((line) => line.level === 'warn')).toBe(true);
      // It is not a failure of the process: no restart is counted and nothing waits.
      expect(notices.some((notice) => notice.kind === 'process_failed')).toBe(false);
      expect(pool.status('p1', 'demo')).toMatchObject({ failures: 0, retryAt: 0 });
      // A project that has its own value starts; the one that has not still does not.
      await new PluginSecrets(vault).set('demo', 'API_TOKEN', new Secret(TOKEN), 'p2');
      expect((await report(pool, plugin, 'p2', 'API_TOKEN')).value).toBe(TOKEN);
      await expect(pool.ensure(plugin, 'p1')).rejects.toMatchObject({ code: 'unavailable' });
      // Setting the value is enough: the next use starts the server.
      await new PluginSecrets(vault).set('demo', 'API_TOKEN', new Secret(TOKEN));
      expect((await report(pool, plugin, 'p1', 'API_TOKEN')).value).toBe(TOKEN);
    } finally {
      await pool.stop();
    }
  });

  it('gives the connector the values to hide in what the server writes on stderr', async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const connector: PluginConnector = (spec) => {
      seen.push(spec.secretValues);
      return Promise.reject(new Error('stop here'));
    };
    const { pool, vault } = setup({ connector });
    await new PluginSecrets(vault).set('demo', 'API_TOKEN', new Secret(TOKEN));
    await expect(pool.ensure(withSecrets(['API_TOKEN']), 'p1')).rejects.toBeDefined();
    expect(seen).toEqual([[TOKEN]]);
  });
});

describe('maskValues', () => {
  it('replaces every occurrence of each value', () => {
    expect(maskValues(`a ${TOKEN} b ${TOKEN} c ${PROJECT_TOKEN}`, [TOKEN, PROJECT_TOKEN])).toBe(
      'a [REDACTED] b [REDACTED] c [REDACTED]',
    );
  });

  it('leaves the text alone with no values, and ignores an empty one', () => {
    expect(maskValues('plain text', [])).toBe('plain text');
    expect(maskValues('plain text', [''])).toBe('plain text');
  });
});

describe('the telemetry redaction knows the secrets of the plugins', () => {
  it('replaces the value of a plugin secret wherever it appears', async () => {
    const vault = new InMemorySecretVault();
    const secrets = new PluginSecrets(vault);
    await secrets.set('demo', 'API_TOKEN', new Secret(TOKEN));
    await secrets.set('demo', 'API_TOKEN', new Secret(PROJECT_TOKEN), 'p1');
    const values = new VaultValues(vault);
    await values.refresh();
    const redactor = new Redactor({ mode: 'default', secrets: () => values.values() });
    const out = redactor.redact({
      logs: [
        {
          scenarioId: null,
          playId: null,
          attemptId: null,
          sessionId: null,
          timeUnixNano: 1n,
          severity: 9,
          severityText: null,
          body: `calling with ${TOKEN}`,
          traceId: null,
          spanId: null,
          attributes: { cmd: `curl -H ${PROJECT_TOKEN}` },
          resource: {},
        },
      ],
    });
    const text = JSON.stringify(out.logs, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PROJECT_TOKEN);
    expect(text).toContain('[redacted]');
  });
});
