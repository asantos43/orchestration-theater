// SPDX-License-Identifier: MPL-2.0
import type { ApiHandlers } from '../handlers.js';
import type { CommandRegistrar } from './command.js';
import type { CommandRouteDeps, ReadRouteDeps } from './deps.js';

/** `GET /v1/layout/:interface`: the saved layout of an interface, or its default (P12 of docs/17). */
export function registerLayoutRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  handlers.register('getLayout', ({ params }) => deps.layout.get(params.interface));
}

/**
 * `PUT /v1/layout/:interface`: replaces the layout of an interface with the body (already checked
 * against the schema, with the current version). [proposta] A write that changes the record
 * writes the event `layout.changed` (N174; the store decides, and an equal record writes none).
 * The `X-OT-Client-Id` header, when sent, is the `origin` of the event.
 */
export function registerLayoutCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  register('putLayout', ({ params, body, headers }) =>
    deps.layout.put(params.interface, body, headers['x-ot-client-id']),
  );
}
