// SPDX-License-Identifier: MPL-2.0
import type { JsonValue } from '@otheater/core';
import type { API_ROUTES, ApiRouteId } from '@otheater/protocol';
import type { Logger } from '../../logger.js';
import { ToolFailure } from '../../mcp/handlers.js';
import { NeedsInit } from '../../project/init.js';
import { ApiFailure, type ApiHandler, type ApiHandlers } from '../handlers.js';
import { IDEMPOTENCY_REPLAYED_HEADER, type IdempotencyCache } from './idempotency.js';

/**
 * How the commands of the REST API (P6 of docs/17) are registered. A `register<Resource>Commands`
 * gets a {@link CommandRegistrar} instead of the table of handlers: what it registers goes through
 * the same three steps, so no command repeats them.
 * 1. the failures of the services become the codes of the API (a `ToolFailure` of the orders has
 *    `code` and `details`, which the table of `apiErrorCodeOf` does not know);
 * 2. with an `Idempotency-Key`, the command runs once for the key and a repeat gets the first answer;
 * 3. a command answers a value of its schema, never a `Response` of its own (a replay needs a value
 *    to keep).
 */
export type CommandRegistrar = <Id extends ApiRouteId>(
  id: Id,
  handler: ApiHandler<(typeof API_ROUTES)[Id]>,
) => void;

/**
 * The failure of a service as the API answers it. The services of the Producer's commands raise the
 * errors of the core (mapped by the server) and, the orders, a `ToolFailure`: `not_found`,
 * `conflict` and every `invalid_*` map to the same code of the API, with their details. Anything
 * else is left as it is, so an unexpected failure stays a 500 with a hidden message.
 */
export function asApiFailure(error: unknown): unknown {
  // N332: the folder needs the Producer's choice; `details` tell a client which ones, in a form it reads.
  if (error instanceof NeedsInit) {
    return new ApiFailure('invalid_input', error.message, {
      details: { reason: error.details.reason, choices: [...error.details.choices] },
    });
  }
  if (!(error instanceof ToolFailure)) return error;
  const code =
    error.code === 'not_found' || error.code === 'conflict'
      ? error.code
      : error.code.startsWith('invalid_')
        ? 'invalid_input'
        : undefined;
  if (code === undefined) return error;
  const entries = Object.entries(error.details);
  return new ApiFailure(code, error.message, {
    ...(entries.length === 0
      ? {}
      : { details: JSON.parse(JSON.stringify(error.details)) as Record<string, JsonValue> }),
  });
}

/** The service a command needs, or 503 `unavailable` when this daemon runs without it. */
export function available<Service>(service: Service | undefined, what: string): Service {
  if (service === undefined) {
    throw new ApiFailure('unavailable', `This daemon cannot ${what}: it runs no plays`);
  }
  return service;
}

export function commandRegistrar(
  handlers: ApiHandlers,
  cache: IdempotencyCache,
  logger: Logger,
): CommandRegistrar {
  return (id, handler) => {
    handlers.register(id, async (call) => {
      try {
        const execute = async (): Promise<JsonValue> => {
          const result = await handler(call);
          if (result instanceof Response) {
            throw new Error(`The command ${id} must answer a value, not a Response`);
          }
          return result as JsonValue;
        };
        const headers = call.headers as { readonly 'idempotency-key'?: string } | undefined;
        const key = headers?.['idempotency-key'];
        if (key === undefined) return (await execute()) as never;
        const { replayed, value } = await cache.run(
          { key, routeId: id, params: call.params, query: call.query, body: call.body },
          execute,
        );
        // A repeat is no new command: it runs nothing and writes no event, so the log is its only trace.
        if (replayed) logger.debug({ route: id }, 'command answered from its Idempotency-Key');
        return replayed
          ? Response.json(value, { headers: { [IDEMPOTENCY_REPLAYED_HEADER]: 'true' } })
          : (value as never);
      } catch (error) {
        throw asApiFailure(error);
      }
    });
  };
}
