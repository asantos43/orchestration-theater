// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { ApiErrorSchema, apiErrorStatus } from './errors.js';
import { API_ROUTE_LIST } from './registry.js';
import { API_PREFIX, API_VERSION, pathParamNames, type AnyApiRoute } from './route.js';

/**
 * The catalog of the routes (plan docs/17 P1, the equivalent of the `endpoints.json` of
 * Claudexor): a stable JSON built from the registry, kept in `docs/reference/api-routes.json`
 * and checked by `catalog.test.ts`. After a change of a route, regenerate it with
 * `pnpm api:catalog` and commit the file. [proposta]
 */

/** Path of the catalog in the repository, relative to its root. */
export const API_CATALOG_FILE = 'docs/reference/api-routes.json';

type JsonSchema = Record<string, unknown>;

export interface ApiCatalogRoute {
  id: string;
  method: string;
  path: string;
  kind: string;
  summary: string;
  pathParams: string[];
  /** JSON Schemas of what the client sends (`io: 'input'`): absent when the route has none. */
  params?: JsonSchema;
  query?: JsonSchema;
  headers?: JsonSchema;
  body?: JsonSchema;
  /** `websocket` routes: what the client sends over the socket. */
  clientMessage?: JsonSchema;
  /** What the daemon answers: the body, one message of the stream, or one message of the socket. */
  response: JsonSchema;
  /** The codes of the error answers by HTTP status; the body of all of them is `errorSchema`. */
  errors: Record<string, string[]>;
}

export interface ApiCatalog {
  apiVersion: number;
  prefix: string;
  /** The body of every error answer ({@link ApiErrorSchema}). */
  errorSchema: JsonSchema;
  routes: ApiCatalogRoute[];
}

function jsonSchemaOf(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  // `$schema` repeats on every entry: it is kept off, the catalog is draft 2020-12 as a whole.
  const json = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    unrepresentable: 'any',
    reused: 'ref',
  }) as JsonSchema;
  delete json.$schema;
  return json;
}

function entryOf(route: AnyApiRoute): ApiCatalogRoute {
  const entry: ApiCatalogRoute = {
    id: route.id,
    method: route.method,
    path: route.path,
    kind: route.kind,
    summary: route.summary,
    pathParams: pathParamNames(route.path),
    response: jsonSchemaOf(route.response, 'output'),
    errors: {},
  };
  if (route.params !== undefined) entry.params = jsonSchemaOf(route.params, 'input');
  if (route.query !== undefined) entry.query = jsonSchemaOf(route.query, 'input');
  if (route.headers !== undefined) entry.headers = jsonSchemaOf(route.headers, 'input');
  if (route.body !== undefined) entry.body = jsonSchemaOf(route.body, 'input');
  if (route.clientMessage !== undefined) {
    entry.clientMessage = jsonSchemaOf(route.clientMessage, 'input');
  }
  for (const code of route.errorCodes) {
    const status = String(apiErrorStatus(code));
    entry.errors[status] = [...(entry.errors[status] ?? []), code];
  }
  return entry;
}

/** The catalog of `routes` (default: the whole registry), ordered by path, then method, then id. */
export function buildApiCatalog(routes: readonly AnyApiRoute[] = API_ROUTE_LIST): ApiCatalog {
  const ordered = [...routes].sort(
    (a, b) =>
      a.path.localeCompare(b.path, 'en') ||
      a.method.localeCompare(b.method, 'en') ||
      a.id.localeCompare(b.id, 'en'),
  );
  return {
    apiVersion: API_VERSION,
    prefix: API_PREFIX,
    errorSchema: jsonSchemaOf(ApiErrorSchema, 'output'),
    routes: ordered.map(entryOf),
  };
}

/** The text of the catalog file: indented JSON with a final newline, so a diff reads well. */
export function renderApiCatalog(catalog: ApiCatalog = buildApiCatalog()): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
