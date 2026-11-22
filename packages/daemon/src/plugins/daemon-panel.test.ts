// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../cli.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { dataPaths } from '../paths.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, NO_CLIENTS } from '../test-helpers.js';
import { isolatedEnv } from './plugin-fixture.js';
import { panelManifestInput } from './test-plugin-fixture.js';

/** An event of the log, as the tests read it. */
interface Logged {
  readonly type: string;
  readonly payload: unknown;
  readonly scenarioId?: string;
}

/** The value at a path of a JSON answer (`unknown` all the way: what a test checks it states). */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const step of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

/** What a test reads of an answer of the API. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

interface Context {
  readonly daemon: DaemonHandle;
  readonly get: (path: string, token?: string | null) => Promise<Answer>;
  readonly post: (path: string, body: unknown) => Promise<Answer>;
  readonly logged: (type?: string) => Promise<Logged[]>;
  /** Everything the API said, to prove no value of a plugin leaks. */
  readonly said: string[];
}

/**
 * A daemon with the plugin `panel-demo` installed (the server of the tests with `--panel`) and the
 * scenario `sc1`. The plugin is NOT turned on: each test does it, over REST.
 */
async function withPanelDaemon(
  configText: string,
  body: (context: Context) => Promise<void>,
): Promise<void> {
  const data = await makeTempDataDir();
  const work = await makeTempDataDir();
  try {
    const clock = new FakeClock(Date.UTC(2026, 10, 22, 15));
    const daemon = await startDaemon({
      dataDir: data.dir,
      clientSearch: NO_CLIENTS,
      config: parseConfig(`backup:\n  when: manual\n${configText}`),
      overrides: { clock, store: new InMemoryStore({ clock }), vault: new InMemorySecretVault() },
      logger: createSilentLogger(),
    });
    try {
      await daemon.store.scenarios.create({
        id: 'sc1',
        kind: 'project',
        flowId: 'software',
        name: 'Scenario',
        folder: work.dir,
        profile: 'software',
        conventions: {},
        configOverride: {},
      });
      const folder = join(work.dir, 'panel-demo');
      await mkdir(folder, { recursive: true });
      // JSON is YAML.
      await writeFile(join(folder, 'plugin.yaml'), JSON.stringify(panelManifestInput(), null, 2));
      const code = await main(['plugin', 'install', folder, '--data-dir', data.dir], {
        env: isolatedEnv(work.dir),
        platform: 'linux',
        homedir: work.dir,
        cwd: work.dir,
        out: () => undefined,
        err: () => undefined,
        systemLocale: 'en',
        version: '1.2.3',
        overrides: { clock },
      });
      expect(code).toBe(0);

      const token = (await readFile(dataPaths(data.dir).apiToken, 'utf8')).trim();
      const said: string[] = [];
      const answer = async (response: Response): Promise<Answer> => {
        const text = await response.text();
        said.push(text);
        return {
          status: response.status,
          text,
          body: text === '' ? {} : (JSON.parse(text) as unknown),
        };
      };
      const context: Context = {
        daemon,
        said,
        get: async (path, bearer = token) =>
          await answer(
            await fetch(`${daemon.api.url}${path}`, {
              headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
            }),
          ),
        post: async (path, payload) =>
          await answer(
            await fetch(`${daemon.api.url}${path}`, {
              method: 'POST',
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }),
          ),
        logged: async (type) => {
          const all = (await daemon.store.events.readFrom(0, 10_000)) as unknown as Logged[];
          return all.filter((event) => type === undefined || event.type === type);
        },
      };
      await body(context);
    } finally {
      await daemon.stop();
    }
  } finally {
    await data.dispose();
    await work.dispose();
  }
}

/** The refusals of the Producer's calls (the server of the tests also exposes tools the manifest does not declare). */
async function refusals(logged: Context['logged']): Promise<unknown[]> {
  return (await logged('plugin.tool_rejected'))
    .map((event) => event.payload as { role?: string })
    .filter((payload) => payload.role === 'producer');
}

describe('the /v1/plugins routes on a daemon', () => {
  it('lists, shows, turns on and off, with the errors in the standard format', async () => {
    await withPanelDaemon('', async ({ get, post, said }) => {
      // Same auth as the other routes.
      expect((await get('/v1/plugins', null)).status).toBe(401);
      expect((await get('/v1/plugins', 'wrong-token')).status).toBe(401);

      const list = await get('/v1/plugins');
      expect(list.status).toBe(200);
      expect(at(list.body, 'plugins')).toHaveLength(1);
      expect(at(list.body, 'plugins', 0)).toMatchObject({
        id: 'panel-demo',
        version: '1.0.0',
        description: 'A plugin with a panel',
        problem: null,
        projects: [],
      });
      expect(at((await get('/v1/plugins?project=sc1')).body, 'plugins')).toEqual([]);

      const detail = await get('/v1/plugins/panel-demo');
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        id: 'panel-demo',
        manifest: { id: 'panel-demo' },
        summary: { id: 'panel-demo', panelBlocks: 9 },
      });
      expect(at(detail.body, 'activation')).not.toHaveLength(0);
      const hash = at(detail.body, 'currentManifestHash');
      expect(hash).toBe(at(detail.body, 'manifestHash'));
      // The activation text follows the language asked.
      const portuguese = await get('/v1/plugins/panel-demo?lang=pt-BR');
      expect(at(portuguese.body, 'activation')).not.toEqual(at(detail.body, 'activation'));

      const missing = await get('/v1/plugins/nobody');
      expect(missing.status).toBe(404);
      expect(at(missing.body, 'error', 'code')).toBe('not_found');

      // Not turned on yet: the panel is a conflict, not a 404.
      const early = await get('/v1/plugins/panel-demo/panel?project=sc1');
      expect(early.status).toBe(409);
      expect(at(early.body, 'error', 'code')).toBe('conflict');
      // The project must exist.
      expect((await get('/v1/plugins/panel-demo/panel?project=nothing')).status).toBe(404);
      expect((await post('/v1/plugins/panel-demo/enable', { project: 'nothing' })).status).toBe(
        404,
      );
      expect((await post('/v1/plugins/nobody/enable', { project: 'sc1' })).status).toBe(404);
      // The body is validated like every route: `project` is required.
      expect((await post('/v1/plugins/panel-demo/enable', {})).status).toBe(400);

      // A hash that is not the manifest on disk approves nothing.
      const stale = await post('/v1/plugins/panel-demo/enable', {
        project: 'sc1',
        manifestHash: 'f'.repeat(64),
      });
      expect(stale.status).toBe(409);
      expect(at((await get('/v1/plugins?project=sc1')).body, 'plugins')).toEqual([]);

      const enabled = await post('/v1/plugins/panel-demo/enable', {
        project: 'sc1',
        manifestHash: hash,
      });
      expect(enabled.status).toBe(200);
      expect(enabled.body).toEqual({
        id: 'panel-demo',
        project: 'sc1',
        changed: true,
        manifestHash: hash,
      });
      const again = await post('/v1/plugins/panel-demo/enable', { project: 'sc1' });
      expect(at(again.body, 'changed')).toBe(false);
      const after = await get('/v1/plugins?project=sc1');
      expect(at(after.body, 'plugins', 0, 'projects')).toEqual([
        { project: 'sc1', state: 'active' },
      ]);

      const off = await post('/v1/plugins/panel-demo/disable', { project: 'sc1' });
      expect(off.status).toBe(200);
      expect(off.body).toEqual({ id: 'panel-demo', project: 'sc1', disabled: true });
      const offAgain = await post('/v1/plugins/panel-demo/disable', { project: 'sc1' });
      expect(at(offAgain.body, 'disabled')).toBe(false);
      expect((await get('/v1/plugins/panel-demo/panel?project=sc1')).status).toBe(409);
      expect((await post('/v1/plugins/nobody/disable', { project: 'sc1' })).status).toBe(404);

      expect(said.join('\n')).not.toContain('hunter2');
    });
  });

  it('draws the panel, with the texts in the language asked and the data of the tools', async () => {
    await withPanelDaemon('', async ({ get, post, said }) => {
      expect((await post('/v1/plugins/panel-demo/enable', { project: 'sc1' })).status).toBe(200);
      const panel = await get('/v1/plugins/panel-demo/panel?project=sc1&lang=pt-BR');
      expect(panel.status).toBe(200);
      expect(panel.body).toMatchObject({ plugin: 'panel-demo', project: 'sc1', language: 'pt-BR' });
      const block = (index: number): unknown => at(panel.body, 'blocks', index);
      expect(block(0)).toMatchObject({
        type: 'table',
        title: 'Linhas',
        error: null,
        columns: [
          { key: 'name', label: 'Nome' },
          { key: 'id', label: 'Número' },
        ],
      });
      expect(at(block(0), 'rows')).toHaveLength(5);
      expect(at(block(2), 'items')).toEqual(['a', 'b', 'c']);
      expect(block(3)).toMatchObject({
        title: 'Numbers',
        metrics: [
          { key: 'open', value: 2 },
          { key: 'done', value: 5 },
        ],
      });
      expect(at(block(4), 'error', 'code')).toBe('invalid_result');
      expect(at(block(5), 'error', 'code')).toBe('tool_error');
      expect([6, 7, 8].map((index) => at(block(index), 'approval'))).toEqual([
        'none',
        'manifest',
        'policy',
      ]);

      const english = await get('/v1/plugins/panel-demo/panel?project=sc1');
      expect(at(english.body, 'language')).toBe('en');
      expect(at(english.body, 'blocks', 0, 'title')).toBe('Rows');
      // The language of the request is validated like any query.
      expect(
        (await get('/v1/plugins/panel-demo/panel?project=sc1&lang=not%20a%20tag')).status,
      ).toBe(400);
      expect(said.join('\n')).not.toContain('hunter2');
    });
  });

  it('cuts to plugins.panel with a warning event, and the panel still answers 200', async () => {
    await withPanelDaemon(
      'plugins:\n  panel:\n    max_rows: 2\n',
      async ({ get, post, logged }) => {
        await post('/v1/plugins/panel-demo/enable', { project: 'sc1' });
        const panel = await get('/v1/plugins/panel-demo/panel?project=sc1');
        expect(panel.status).toBe(200);
        expect(at(panel.body, 'blocks', 0, 'rows')).toHaveLength(2);
        expect(at(panel.body, 'blocks', 0, 'truncated')).toEqual({
          reason: 'rows',
          total: 5,
          kept: 2,
          limit: 2,
        });
        await vi.waitFor(async () => {
          const events = await logged('plugin.panel_truncated');
          expect(events[0]).toMatchObject({
            scenarioId: 'sc1',
            payload: {
              plugin: 'panel-demo',
              project: 'sc1',
              source: 'rows',
              reason: 'rows',
              total: 5,
              kept: 2,
              limit: 2,
            },
          });
        });
      },
    );
  });

  it('an action goes through the path of any call: the permission events are written', async () => {
    await withPanelDaemon('', async ({ post, logged, said }) => {
      await post('/v1/plugins/panel-demo/enable', { project: 'sc1' });

      const done = await post('/v1/plugins/panel-demo/actions/clear', { project: 'sc1' });
      expect(done.status).toBe(200);
      expect(done.body).toEqual({
        plugin: 'panel-demo',
        project: 'sc1',
        tool: 'clear',
        ok: true,
        result: 'clear done',
        truncated: null,
        error: null,
      });

      // Only the tools an action block names; the others are for the agents.
      const other = await post('/v1/plugins/panel-demo/actions/counter', { project: 'sc1' });
      expect(other.status).toBe(404);
      expect(at(other.body, 'error', 'code')).toBe('not_found');
      expect((await post('/v1/plugins/panel-demo/actions/clear', {})).status).toBe(400);
      expect(
        (await post('/v1/plugins/panel-demo/actions/clear', { project: 'nothing' })).status,
      ).toBe(404);

      // This daemon has no client to ask the Producer (the orchestration is not bound): an action
      // that needs approval is 503, never a yes, and the tool does not run.
      const asked = await post('/v1/plugins/panel-demo/actions/purge', { project: 'sc1' });
      expect(asked.status).toBe(503);
      expect(at(asked.body, 'error', 'code')).toBe('unavailable');
      await vi.waitFor(async () => {
        expect(await logged('permission.asked')).toHaveLength(1);
        const answered = await logged('permission.answered');
        expect(answered).toHaveLength(1);
        expect(answered[0]?.payload).toMatchObject({
          sessionId: 'producer',
          tool: 'panel-demo__purge',
          answer: 'reject',
          reason: 'plugin_tool_refused',
        });
        expect(await refusals(logged)).toMatchObject([
          { tool: 'purge', role: 'producer', reason: 'approval_unavailable' },
        ]);
      });
      expect(said.join('\n')).not.toContain('hunter2');
    });
  });

  it('the deny modes of plugins.permissions refuse an action with 403', async () => {
    await withPanelDaemon(
      'plugins:\n  permissions:\n    local_write: deny\n',
      async ({ post, logged }) => {
        await post('/v1/plugins/panel-demo/enable', { project: 'sc1' });
        const answer = await post('/v1/plugins/panel-demo/actions/clear', { project: 'sc1' });
        expect(answer.status).toBe(403);
        expect(at(answer.body, 'error', 'code')).toBe('forbidden');
        await vi.waitFor(async () => {
          expect(await refusals(logged)).toMatchObject([
            { tool: 'clear', role: 'producer', reason: 'not_allowed' },
          ]);
        });
      },
    );
  });
});
