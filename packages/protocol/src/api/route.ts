// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { apiErrorStatus, type ApiErrorCode } from './errors.js';

/**
 * Typed definition of an API route (plan docs/17 P1). A route is data: method, path, and one zod
 * schema for each part of the exchange. The daemon validates with it, `packages/client` types
 * with it, and the catalog (`catalog.ts`) is generated from it. The route of a resource lives in
 * its own file of this folder and enters the registry (`registry.ts`).
 */

/** The API version of the URL prefix and of `apiVersion` in `GET /v1/status`. [proposta] Integer, starts at 1. */
export const API_VERSION = 1;

/** Every route lives under this prefix. */
export const API_PREFIX = `/v${String(API_VERSION)}`;

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * How a route answers. `json`: one JSON body. `sse`: a stream of `text/event-stream` messages;
 * `response` is the schema of one message. `websocket`: an upgrade; `response` is the message the
 * daemon sends and `clientMessage` the one the client sends. [proposta]
 */
export const ROUTE_KINDS = ['json', 'sse', 'websocket'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

type ObjectSchema = z.ZodObject;

/** What the author of a route writes. */
export interface RouteSpec<
  Id extends string,
  Method extends HttpMethod,
  Params extends ObjectSchema | undefined,
  Query extends ObjectSchema | undefined,
  Headers extends ObjectSchema | undefined,
  Body extends z.ZodType | undefined,
  Response extends z.ZodType,
  ClientMessage extends z.ZodType | undefined,
> {
  /** Unique name of the route, also its key in the registry (`getStatus`, `putLayout`). */
  readonly id: Id;
  readonly method: Method;
  /** `/v1/...` with `:name` for each path parameter (`/v1/layout/:interface`). */
  readonly path: `${typeof API_PREFIX}/${string}`;
  readonly kind?: RouteKind;
  /** One line for the catalog. */
  readonly summary: string;
  readonly params?: Params;
  readonly query?: Query;
  /** Request headers, keyed by the lower-case name. A loose object: other headers may come. */
  readonly headers?: Headers;
  readonly body?: Body;
  readonly response: Response;
  readonly clientMessage?: ClientMessage;
  /**
   * The codes this route can answer with besides the ones every route has (`unauthorized`,
   * `forbidden`, `internal`, and `invalid_input` when the route reads any input).
   */
  readonly errors?: readonly ApiErrorCode[];
}

/** The error answers of a route, by HTTP status: every code that status carries in this route. */
export type RouteErrors = Readonly<Partial<Record<number, z.ZodType>>>;

/** A defined route. */
export interface ApiRoute<
  Id extends string = string,
  Method extends HttpMethod = HttpMethod,
  Params extends ObjectSchema | undefined = ObjectSchema | undefined,
  Query extends ObjectSchema | undefined = ObjectSchema | undefined,
  Headers extends ObjectSchema | undefined = ObjectSchema | undefined,
  Body extends z.ZodType | undefined = z.ZodType | undefined,
  Response extends z.ZodType = z.ZodType,
  ClientMessage extends z.ZodType | undefined = z.ZodType | undefined,
> {
  readonly id: Id;
  readonly method: Method;
  readonly path: `${typeof API_PREFIX}/${string}`;
  readonly kind: RouteKind;
  readonly summary: string;
  readonly params: Params;
  readonly query: Query;
  readonly headers: Headers;
  readonly body: Body;
  readonly response: Response;
  readonly clientMessage: ClientMessage;
  /** Error codes of the route, sorted: the common ones plus the declared ones. */
  readonly errorCodes: readonly ApiErrorCode[];
  /** One schema per HTTP status, built from {@link errorCodes}. */
  readonly errors: RouteErrors;
}

export type AnyApiRoute = ApiRoute;

const COMMON_ERRORS: readonly ApiErrorCode[] = ['unauthorized', 'forbidden', 'internal'];

/** `:name` segments of a path, in order. */
export function pathParamNames(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => /^:[A-Za-z][A-Za-z0-9_]*$/.test(segment))
    .map((segment) => segment.slice(1));
}

/** The schema of the error answers of one status: the codes of `codes` that map to it. */
function errorSchemaForStatus(codes: readonly ApiErrorCode[]): z.ZodType {
  return z.strictObject({
    error: z.strictObject({
      code: z.enum(codes as [ApiErrorCode, ...ApiErrorCode[]]),
      message: z.string(),
      details: z.record(z.string(), z.json()).optional(),
    }),
  });
}

/**
 * Defines a route and checks what can be checked at once: the path is under `/v1`, and the
 * `params` schema has exactly the keys of the `:name` segments of the path (a throw at module
 * load, so a typo never reaches a release).
 */
export function defineRoute<
  const Id extends string,
  const Method extends HttpMethod,
  Response extends z.ZodType,
  Params extends ObjectSchema | undefined = undefined,
  Query extends ObjectSchema | undefined = undefined,
  Headers extends ObjectSchema | undefined = undefined,
  Body extends z.ZodType | undefined = undefined,
  ClientMessage extends z.ZodType | undefined = undefined,
>(
  spec: RouteSpec<Id, Method, Params, Query, Headers, Body, Response, ClientMessage>,
): ApiRoute<Id, Method, Params, Query, Headers, Body, Response, ClientMessage> {
  if (!spec.path.startsWith(`${API_PREFIX}/`)) {
    throw new Error(`Route ${spec.id}: the path must start with ${API_PREFIX}/`);
  }
  const names = pathParamNames(spec.path);
  const declared = spec.params === undefined ? [] : Object.keys(spec.params.shape);
  if (names.length !== declared.length || names.some((name) => !declared.includes(name))) {
    throw new Error(
      `Route ${spec.id}: params [${declared.join(', ')}] do not match the path parameters [${names.join(', ')}]`,
    );
  }
  const kind = spec.kind ?? 'json';
  if ((kind === 'websocket') !== (spec.clientMessage !== undefined)) {
    throw new Error(`Route ${spec.id}: only a websocket route has (and needs) a clientMessage`);
  }
  const readsInput =
    spec.params !== undefined ||
    spec.query !== undefined ||
    spec.headers !== undefined ||
    spec.body !== undefined;
  const codes = [
    ...new Set<ApiErrorCode>([
      ...COMMON_ERRORS,
      ...(readsInput ? (['invalid_input'] as const) : []),
      ...(spec.errors ?? []),
    ]),
  ].sort();
  const byStatus = new Map<number, ApiErrorCode[]>();
  for (const code of codes) {
    const status = apiErrorStatus(code);
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const errors: Record<number, z.ZodType> = {};
  for (const [status, group] of [...byStatus].sort(([a], [b]) => a - b)) {
    errors[status] = errorSchemaForStatus(group);
  }
  return {
    id: spec.id,
    method: spec.method,
    path: spec.path,
    kind,
    summary: spec.summary,
    params: spec.params as Params,
    query: spec.query as Query,
    headers: spec.headers as Headers,
    body: spec.body as Body,
    response: spec.response,
    clientMessage: spec.clientMessage as ClientMessage,
    errorCodes: codes,
    errors,
  };
}

/** The path parameters of a route, as the type of its `params` schema. */
export type RouteParams<R extends AnyApiRoute> = R['params'] extends z.ZodType
  ? z.infer<R['params']>
  : undefined;
export type RouteQuery<R extends AnyApiRoute> = R['query'] extends z.ZodType
  ? z.input<R['query']>
  : undefined;
export type RouteBody<R extends AnyApiRoute> = R['body'] extends z.ZodType
  ? z.input<R['body']>
  : undefined;
export type RouteResponse<R extends AnyApiRoute> = z.infer<R['response']>;

/**
 * The URL path of a route with its parameters filled in and percent-encoded
 * (`/v1/layout/:interface` + `{ interface: 'tui' }` → `/v1/layout/tui`). A missing or extra
 * parameter is an error.
 */
export function routePath(
  route: Pick<AnyApiRoute, 'id' | 'path'>,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const names = pathParamNames(route.path);
  const given = Object.keys(params);
  if (names.length !== given.length || names.some((name) => !(name in params))) {
    throw new Error(
      `Route ${route.id}: expected the parameters [${names.join(', ')}], got [${given.join(', ')}]`,
    );
  }
  return route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, name: string) =>
    encodeURIComponent(String(params[name])),
  );
}

/**
 * A table of routes keyed by `id`, from the routes of one resource file. The registry merges the
 * tables of all files.
 */
export function defineRoutes<const Routes extends readonly AnyApiRoute[]>(
  ...routes: Routes
): { readonly [R in Routes[number] as R['id']]: R } {
  const table: Record<string, AnyApiRoute> = {};
  for (const route of routes) {
    if (route.id in table) throw new Error(`Two routes share the id ${route.id}`);
    table[route.id] = route;
  }
  return table as { readonly [R in Routes[number] as R['id']]: R };
}

/**
 * Checks a list of routes: no id twice, and no (method, path) twice. A `:name` is the same
 * segment whatever its name, so `/v1/a/:x` and `/v1/a/:y` clash. Throws with every clash named.
 */
export function assertUniqueRoutes(routes: readonly AnyApiRoute[]): void {
  const ids = new Set<string>();
  const shapes = new Map<string, string>();
  const clashes: string[] = [];
  for (const route of routes) {
    if (ids.has(route.id)) clashes.push(`id ${route.id} is used twice`);
    ids.add(route.id);
    const shape = `${route.method} ${route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, ':_')}`;
    const other = shapes.get(shape);
    if (other !== undefined) clashes.push(`${route.id} and ${other} are both ${shape}`);
    shapes.set(shape, route.id);
  }
  if (clashes.length > 0) throw new Error(`Routes clash: ${clashes.join('; ')}`);
}
