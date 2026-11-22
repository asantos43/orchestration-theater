// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
   The refusal tests break one field of a valid manifest at a time: the fixture is a loose object on purpose. */
import { describe, expect, it } from 'vitest';
import { PLUGIN_DAEMON_EVENT_NAMES } from '../registries/events.js';
import {
  describeManifestProblems,
  parsePluginManifest,
  parsePluginManifestText,
  PLUGIN_MANIFEST_MAX_CHARS,
  type PluginManifestProblem,
} from './manifest.js';

/** The example of architecture 5.14 (`postgres-db`), with what the format asks on top of it: the version of the format, and a catalog for the texts the panel shows. */
function postgres(): Record<string, any> {
  return {
    manifest_version: 1,
    id: 'postgres-db',
    version: '1.0.0',
    server: { type: 'stdio', command: ['node', 'dist/server.js'] },
    tools: [
      { name: 'query_sql', roles: ['actor', 'critic'], specialties: ['sql'], effects: 'read' },
      {
        name: 'migrate',
        roles: ['actor'],
        effects: 'external_write',
        requires_producer_approval: true,
      },
      { name: 'list_migrations', roles: [], effects: 'read' },
    ],
    secrets: ['PG_URL'],
    events: ['migration_applied'],
    panel: [
      { type: 'table', title: 'panel.pending', source: 'list_migrations' },
      { type: 'action', label: 'panel.migrate', tool: 'migrate' },
    ],
    i18n: {
      en: { 'panel.pending': 'Pending migrations', 'panel.migrate': 'Migrate' },
      'pt-BR': { 'panel.pending': 'Migrações pendentes', 'panel.migrate': 'Migrar' },
    },
  };
}

type Mutator = (manifest: Record<string, any>) => void;

/** Applies `change` to a fresh `postgres-db` and returns the problems (it must be refused). */
function refused(change: Mutator, options?: Parameters<typeof parsePluginManifest>[1]) {
  const manifest = postgres();
  change(manifest);
  const result = parsePluginManifest(manifest, options);
  if (result.ok) throw new Error('the manifest was accepted');
  return result.problems;
}

function only(problems: readonly PluginManifestProblem[]): PluginManifestProblem {
  expect(problems).toHaveLength(1);
  const [problem] = problems;
  if (problem === undefined) throw new Error('unreachable');
  return problem;
}

describe('the manifest of a plugin', () => {
  it('accepts the postgres-db example of architecture 5.14 and fills the defaults', () => {
    const result = parsePluginManifest(postgres());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe('postgres-db');
    const [query, migrate, list] = result.manifest.tools;
    expect(query?.requires_producer_approval).toBe(false);
    expect(migrate?.requires_producer_approval).toBe(true);
    expect(list?.roles).toEqual([]);
  });

  it('accepts the smallest manifest: no secrets, no events, no panel, no catalog', () => {
    const result = parsePluginManifest({
      manifest_version: 1,
      id: 'notes',
      version: '0.1.0-rc.1+build.5',
      server: { type: 'http', url: 'http://127.0.0.1:8123/mcp' },
      tools: [{ name: 'add_note', roles: ['actor'], effects: 'local_write' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest).toMatchObject({ secrets: [], events: [], panel: [] });
  });

  it('accepts the four kinds of block, with the columns of a table', () => {
    const result = parsePluginManifest({
      ...postgres(),
      panel: [
        {
          type: 'table',
          title: 'panel.pending',
          source: 'list_migrations',
          columns: [{ key: 'name', label: 'panel.migrate' }],
        },
        { type: 'list', title: 'panel.pending', source: 'list_migrations' },
        { type: 'metrics', title: 'panel.pending', source: 'query_sql' },
        { type: 'action', label: 'panel.migrate', tool: 'migrate' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  describe('refuses, and the message names the field', () => {
    it('a field the format does not have, at the root and inside a tool', () => {
      expect(only(refused((m) => (m.extra = 1)))).toEqual({
        path: 'extra',
        message: 'is not a field of the manifest',
      });
      expect(only(refused((m) => (m.tools[0].effect = 'read'))).path).toBe('tools[0].effect');
    });

    it('another version of the format, or none', () => {
      expect(only(refused((m) => (m.manifest_version = 2))).path).toBe('manifest_version');
      expect(only(refused((m) => delete m.manifest_version)).path).toBe('manifest_version');
    });

    it('an id outside the pattern and a version that is not semver', () => {
      for (const id of ['Postgres', '1db', 'a.b', 'a b', '', 'x'.repeat(65)]) {
        expect(only(refused((m) => (m.id = id))).path, id).toBe('id');
      }
      for (const version of ['1.0', 'v1.0.0', '01.0.0', 1.0, '1.0.0.0']) {
        expect(only(refused((m) => (m.version = version))).path, String(version)).toBe('version');
      }
    });

    it('an id that is a name of the events of the daemon (plugin.installed, plugin.server_failed...)', () => {
      for (const id of PLUGIN_DAEMON_EVENT_NAMES) {
        const problem = only(refused((m) => (m.id = id)));
        expect(problem.path, id).toBe('id');
        expect(problem.message).toContain('reserved');
      }
    });

    it('a stdio server with no command, or with a working directory outside the plugin folder', () => {
      expect(only(refused((m) => (m.server.command = []))).path).toBe('server.command');
      for (const cwd of ['/etc', '../other', 'a/../../b', 'C:\\x', '~/x', '']) {
        const problem = only(refused((m) => (m.server.cwd = cwd)));
        expect(problem, cwd).toMatchObject({ path: 'server.cwd' });
        expect(problem.message).toContain('relative path inside the folder of the plugin');
      }
      const result = parsePluginManifest({
        ...postgres(),
        server: { type: 'stdio', command: ['x'], cwd: 'dist/sub' },
      });
      expect(result.ok).toBe(true);
    });

    it('an http server that is not in the loopback, is not http, or carries a password', () => {
      const url = (value: string) => refused((m) => (m.server = { type: 'http', url: value }));
      for (const bad of [
        'http://example.com/mcp',
        'http://127.0.0.1.example.com/mcp',
        'http://localhost.example.com/',
        'http://10.0.0.5:80/',
        'http://0.0.0.0/',
        'http://[::2]/',
      ]) {
        const problem = only(url(bad));
        expect(problem.path, bad).toBe('server.url');
        expect(problem.message, bad).toContain('loopback');
      }
      expect(only(url('ftp://127.0.0.1/')).message).toContain('http: or https:');
      expect(only(url('not a url')).message).toContain('not a valid URL');
      expect(only(url('http://user:pw@127.0.0.1/')).message).toContain('user name');
      for (const good of [
        'http://localhost:9/mcp',
        'https://127.1.2.3/',
        'http://[::1]:4000/mcp',
      ]) {
        const result = parsePluginManifest({ ...postgres(), server: { type: 'http', url: good } });
        expect(result.ok, good).toBe(true);
      }
    });

    it('a server of another type', () => {
      const problem = only(
        refused((m) => (m.server = { type: 'websocket', url: 'ws://localhost' })),
      );
      expect(problem.path).toBe('server.type');
    });

    it('a tool with a bad name, an unknown role, or an effect outside the vocabulary', () => {
      expect(only(refused((m) => (m.tools[0].name = 'Query-SQL'))).path).toBe('tools[0].name');
      expect(only(refused((m) => (m.tools[0].roles = ['director']))).path).toBe(
        'tools[0].roles[0]',
      );
      expect(only(refused((m) => (m.tools[0].roles = ['wizard']))).path).toBe('tools[0].roles[0]');
      for (const effects of ['none', 'worktree', 'write', '']) {
        expect(only(refused((m) => (m.tools[1].effects = effects))).path, effects).toBe(
          'tools[1].effects',
        );
      }
      for (const effects of ['read', 'local_write', 'network', 'external_write']) {
        const manifest = postgres();
        manifest.tools[0].effects = effects;
        expect(parsePluginManifest(manifest).ok, effects).toBe(true);
      }
    });

    it('a tool declared twice, and a role or a specialty listed twice', () => {
      const twice = only(refused((m) => m.tools.push({ ...m.tools[0] })));
      expect(twice).toEqual({
        path: 'tools[3].name',
        message: 'tool "query_sql" is declared twice',
      });
      expect(only(refused((m) => (m.tools[0].roles = ['actor', 'actor']))).path).toBe(
        'tools[0].roles',
      );
      expect(only(refused((m) => (m.tools[0].specialties = ['sql', 'sql']))).path).toBe(
        'tools[0].specialties',
      );
      const none = refused((m) => {
        m.tools = [];
        m.panel = [];
      });
      expect(only(none).path).toBe('tools');
    });

    it('a tool named like a tool of the framework', () => {
      const problem = only(refused((m) => (m.tools[0].name = 'git_commit')));
      expect(problem.path).toBe('tools[0].name');
      expect(problem.message).toContain('tool of the framework');
      // The list can be the one of the daemon: a name it does not have is free, one it has is not.
      const custom = refused((m) => (m.tools[0].name = 'query_sql'), {
        frameworkToolNames: ['query_sql'],
      });
      expect(only(custom).path).toBe('tools[0].name');
      const free = postgres();
      free.tools[0].name = 'git_commit';
      expect(parsePluginManifest(free, { frameworkToolNames: [] }).ok).toBe(true);
    });

    it('a source that is not a tool of the plugin', () => {
      const problem = only(refused((m) => (m.panel[0].source = 'query_other')));
      expect(problem).toEqual({
        path: 'panel[0].source',
        message: 'the source "query_other" is not a tool of this plugin',
      });
    });

    it('a source whose tool writes, in the three ways it can write', () => {
      for (const effects of ['local_write', 'network', 'external_write']) {
        const problem = only(
          refused((m) => {
            m.tools[2].effects = effects;
            if (effects === 'external_write') m.tools[2].requires_producer_approval = true;
          }),
        );
        expect(problem.path, effects).toBe('panel[0].source');
        expect(problem.message, effects).toContain(
          `must have effects: read, and it has effects: ${effects}`,
        );
      }
    });

    it('an action whose tool is not of the plugin', () => {
      const problem = only(refused((m) => (m.panel[1].tool = 'drop_database')));
      expect(problem).toEqual({
        path: 'panel[1].tool',
        message: 'the action calls "drop_database", which is not a tool of this plugin',
      });
    });

    it('a block of a type the panel does not have, or with a field that is not its own', () => {
      const unknown = only(
        refused((m) => (m.panel[0] = { type: 'chart', title: 'panel.pending' })),
      );
      expect(unknown.path).toBe('panel[0].type');
      expect(unknown.message).toContain('"table", "list", "metrics" or "action"');
      expect(only(refused((m) => (m.panel[1].source = 'list_migrations'))).path).toBe(
        'panel[1].source',
      );
      expect(only(refused((m) => (m.panel[0].columns = []))).path).toBe('panel[0].columns');
    });

    it('a screen text that is not a key of the catalog: free text, and a key "en" lacks', () => {
      const literal = only(refused((m) => (m.panel[0].title = 'Migrações pendentes')));
      expect(literal.path).toBe('panel[0].title');
      expect(literal.message).toContain('key of the i18n catalog');
      expect(only(refused((m) => (m.panel[1].label = 'panel.nothing'))).message).toBe(
        '"panel.nothing" is not a key of the "en" catalog (i18n.en)',
      );
      const column = only(
        refused((m) => (m.panel[0].columns = [{ key: 'name', label: 'panel.nothing' }])),
      );
      expect(column.path).toBe('panel[0].columns[0].label');
    });

    it('a panel with no "en" catalog, and a catalog with no "en"', () => {
      expect(only(refused((m) => delete m.i18n))).toEqual({
        path: 'i18n',
        message: 'a plugin with a panel needs the "en" catalog in "i18n"',
      });
      expect(only(refused((m) => delete m.i18n.en)).path).toBe('i18n.en');
    });

    it('a translation of a key "en" does not have, and a language tag that is not one', () => {
      expect(only(refused((m) => (m.i18n['pt-BR']['panel.extra'] = 'x'))).path).toBe(
        'i18n.pt-BR.panel.extra',
      );
      expect(only(refused((m) => (m.i18n.Portuguese = {}))).path).toBe('i18n.Portuguese');
      expect(only(refused((m) => (m.i18n.en['panel.pending'] = ''))).path).toBe(
        'i18n.en.panel.pending',
      );
    });

    it('an event name that carries the prefix the daemon adds, or that is repeated', () => {
      const prefixed = only(refused((m) => (m.events = ['plugin.postgres-db.migration_applied'])));
      expect(prefixed.path).toBe('events[0]');
      expect(prefixed.message).toContain('carries the prefix "plugin."');
      expect(prefixed.message).toContain('plugin.postgres-db.<name>');
      expect(only(refused((m) => (m.events = ['a', 'a']))).path).toBe('events[1]');
      expect(only(refused((m) => (m.events = ['Bad Name']))).path).toBe('events[0]');
    });

    it('a secret that is not a variable name, or that is repeated', () => {
      expect(only(refused((m) => (m.secrets = ['pg_url']))).path).toBe('secrets[0]');
      expect(only(refused((m) => (m.secrets = ['PG_URL', 'PG_URL']))).path).toBe('secrets[1]');
    });

    it('collects every problem, not only the first', () => {
      const problems = refused((m) => {
        m.id = 'Bad';
        m.tools[0].effects = 'none';
        m.events = ['plugin.x'];
      });
      expect(problems.map((problem) => problem.path)).toEqual(['id', 'tools[0].effects']);
      const rules = refused((m) => {
        m.panel[0].source = 'migrate';
        m.panel[1].tool = 'nope';
        m.events = ['plugin.x'];
      });
      expect(rules.map((problem) => problem.path)).toEqual([
        'events[0]',
        'panel[0].source',
        'panel[1].tool',
      ]);
      expect(describeManifestProblems(rules)).toContain('panel[1].tool: the action calls "nope"');
    });

    it('anything that is not an object, without throwing', () => {
      for (const value of [null, undefined, 42, 'text', [], true]) {
        const result = parsePluginManifest(value);
        expect(result.ok).toBe(false);
      }
    });
  });

  describe('the text of the manifest', () => {
    it('is read by the reader the caller passes, then validated', () => {
      const result = parsePluginManifestText(JSON.stringify(postgres()), JSON.parse);
      expect(result.ok).toBe(true);
    });

    it('refuses text the reader cannot read, and text that is too long', () => {
      const broken = parsePluginManifestText('{', JSON.parse);
      expect(broken.ok).toBe(false);
      if (!broken.ok) {
        expect(broken.problems[0]).toMatchObject({ path: '' });
        expect(broken.problems[0]?.message).toContain('not valid YAML');
      }
      const big = parsePluginManifestText('x'.repeat(PLUGIN_MANIFEST_MAX_CHARS + 1), JSON.parse);
      expect(big.ok).toBe(false);
      if (!big.ok) expect(big.problems[0]?.message).toContain('more than');
    });

    it('validates what the reader returns, with the same messages', () => {
      const result = parsePluginManifestText('"just a string"', JSON.parse);
      expect(result.ok).toBe(false);
    });
  });
});
