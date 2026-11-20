// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_CATALOG_FILE, buildApiCatalog, renderApiCatalog } from './catalog.js';
import { API_ROUTE_LIST } from './registry.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const file = path.join(root, API_CATALOG_FILE);

describe('the catalog of the routes', () => {
  it('has one entry per route, ordered by path and method', () => {
    const catalog = buildApiCatalog();
    expect(catalog.apiVersion).toBe(1);
    expect(catalog.prefix).toBe('/v1');
    expect(catalog.routes.map((route) => route.id).sort()).toEqual(
      API_ROUTE_LIST.map((route) => route.id).sort(),
    );
    const keys = catalog.routes.map((route) => `${route.path} ${route.method}`);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('writes the schemas as JSON Schema, with constraints and with no `$schema` repeated', () => {
    const catalog = buildApiCatalog();
    const events = catalog.routes.find((route) => route.id === 'streamEvents');
    expect(events?.kind).toBe('sse');
    expect(events?.query).toMatchObject({ type: 'object', additionalProperties: false });
    expect(JSON.stringify(catalog)).not.toContain('$schema');
    const list = catalog.routes.find((route) => route.id === 'putLayout');
    expect(list?.pathParams).toEqual(['interface']);
    expect(list?.body).toMatchObject({ properties: { chatWidth: { minimum: 1 } } });
    const socket = catalog.routes.find((route) => route.id === 'openChatSocket');
    expect(socket?.clientMessage).toBeDefined();
    expect(socket?.errors['404']).toEqual(['not_found']);
    expect(socket?.errors['500']).toEqual(['internal']);
    expect(catalog.errorSchema).toMatchObject({ type: 'object', required: ['error'] });
  });

  it('is the same on every run', () => {
    expect(renderApiCatalog()).toBe(renderApiCatalog(buildApiCatalog()));
    expect(renderApiCatalog().endsWith('}\n')).toBe(true);
  });

  // The file is versioned. If this test fails, a route or a schema changed: regenerate it with
  // `pnpm api:catalog` (vitest `-u` on this file) and commit it.
  it('matches the versioned file', async () => {
    // Outside the CI a missing file would be written as a new snapshot: fail first.
    expect(existsSync(file), `${API_CATALOG_FILE} is missing: run pnpm api:catalog`).toBe(true);
    await expect(renderApiCatalog()).toMatchFileSnapshot(file);
  });
});
