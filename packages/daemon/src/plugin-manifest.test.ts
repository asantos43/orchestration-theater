// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parsePluginManifestText } from '@otheater/core';

/** The `plugin.yaml` of architecture 5.14, with the format version and the catalog the format asks for. */
const POSTGRES_DB = `
manifest_version: 1
id: postgres-db
version: 1.0.0
server:
  type: stdio
  command: [node, dist/server.js]
tools:
  - name: query_sql
    roles: [actor, critic]
    specialties: [sql]
    effects: read
  - name: migrate
    roles: [actor]
    effects: external_write
    requires_producer_approval: true
  - name: list_migrations
    roles: []
    effects: read
secrets: [PG_URL]
events: [migration_applied]
panel:
  - type: table
    title: panel.pending
    source: list_migrations
  - type: action
    label: panel.migrate
    tool: migrate
i18n:
  en:
    panel.pending: Pending migrations
    panel.migrate: Migrate
  pt-BR:
    panel.pending: Migrações pendentes
    panel.migrate: Migrar
`;

describe('plugin.yaml read with the yaml package of the daemon', () => {
  it('validates the postgres-db example', () => {
    const result = parsePluginManifestText(POSTGRES_DB, parseYaml);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.manifest.tools.map((tool) => tool.name)).toEqual([
        'query_sql',
        'migrate',
        'list_migrations',
      ]);
  });

  it('points to the field of a rule, and to the position of a YAML error', () => {
    const wrong = parsePluginManifestText(
      POSTGRES_DB.replace('source: list_migrations', 'source: migrate'),
      parseYaml,
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok)
      expect(wrong.problems.map((problem) => problem.path)).toEqual(['panel[0].source']);
    const broken = parsePluginManifestText('id: [unclosed', parseYaml);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.problems[0]?.message).toContain('not valid YAML');
  });
});
