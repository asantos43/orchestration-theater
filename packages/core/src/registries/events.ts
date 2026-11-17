// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { InvalidInput } from '../errors.js';
import { EVENT_TYPE_PATTERN } from '../ports/event-log.js';
import {
  createRegistry,
  isZodSchema,
  reportDuplicates,
  type ProblemCollector,
  type Registry,
} from './problems.js';

/** Prefix of the event types a plugin owns: `plugin.<id>.<name>` (architecture 5.18). */
export const PLUGIN_EVENT_PREFIX = 'plugin.';

/**
 * An event type of the registry (architecture 5.18, "Registros"): the schema of its payload, per
 * `type` and `schemaVersion`. The `EventLog` port only checks the envelope; this entry checks the
 * payload.
 *
 * Every payload schema should be a strict object: an unknown field is an error, so a typo does
 * not slip into the log and a new field needs a new `schemaVersion`.
 */
export interface EventTypeDefinition<
  TType extends string = string,
  TPayload extends z.ZodType = z.ZodType,
> {
  readonly type: TType;
  /** The version of the payload schema the registry accepts for this type. */
  readonly schemaVersion: number;
  readonly payload: TPayload;
  /**
   * Id of the plugin that owns the type. A plugin type is `plugin.<id>.<name>`; an official type
   * (no `plugin`) never starts with `plugin.`.
   */
  readonly plugin?: string | undefined;
}

/** Identity helper that keeps the literal `type` and the payload schema type of an entry. */
export function defineEventType<TType extends string, TPayload extends z.ZodType>(
  definition: EventTypeDefinition<TType, TPayload>,
): EventTypeDefinition<TType, TPayload> {
  return definition;
}

/** True when `type` is in the namespace of a plugin. */
export function isPluginEventType(type: string): boolean {
  return type.startsWith(PLUGIN_EVENT_PREFIX);
}

/** Why an event did not pass the registry. */
export const EVENT_CHECK_FAILURES = [
  'unknown_type',
  'unsupported_version',
  'invalid_payload',
] as const;
export type EventCheckFailure = (typeof EVENT_CHECK_FAILURES)[number];

export type EventCheck =
  | { readonly ok: true; readonly payload: unknown }
  | {
      readonly ok: false;
      readonly reason: EventCheckFailure;
      readonly message: string;
      readonly cause?: unknown;
    };

/** The event-type registry: lookup plus the check every appended event goes through. */
export interface EventRegistry extends Registry<EventTypeDefinition> {
  /** Checks the version and the payload of an event; never throws. */
  checkEvent(type: string, schemaVersion: number, payload: unknown): EventCheck;
  /** Like {@link EventRegistry.checkEvent}, but throws `InvalidInput` and returns the parsed payload. */
  parseEvent(type: string, schemaVersion: number, payload: unknown): unknown;
}

export function createEventRegistry(definitions: readonly EventTypeDefinition[]): EventRegistry {
  const base = createRegistry(definitions, (definition) => definition.type);
  const checkEvent = (type: string, schemaVersion: number, payload: unknown): EventCheck => {
    const definition = base.get(type);
    if (definition === undefined) {
      return { ok: false, reason: 'unknown_type', message: `Unknown event type: ${type}` };
    }
    if (definition.schemaVersion !== schemaVersion) {
      return {
        ok: false,
        reason: 'unsupported_version',
        message: `Unsupported schemaVersion ${String(schemaVersion)} for ${type} (the registry has ${String(definition.schemaVersion)})`,
      };
    }
    const result = definition.payload.safeParse(payload);
    if (!result.success) {
      return {
        ok: false,
        reason: 'invalid_payload',
        message: `Invalid ${type} payload: ${z.prettifyError(result.error)}`,
        cause: result.error,
      };
    }
    return { ok: true, payload: result.data };
  };
  return Object.freeze({
    ...base,
    checkEvent,
    parseEvent: (type: string, schemaVersion: number, payload: unknown): unknown => {
      const check = checkEvent(type, schemaVersion, payload);
      if (!check.ok) {
        throw new InvalidInput(
          check.message,
          check.cause === undefined ? undefined : { cause: check.cause },
        );
      }
      return check.payload;
    },
  });
}

/** Pattern of a plugin event type: `plugin.<id>.<name>[.<more>]`. */
const PLUGIN_EVENT_PATTERN =
  /^plugin\.([a-z0-9][a-z0-9_-]*)\.[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;

export function validateEventTypes(
  definitions: readonly EventTypeDefinition[],
  collector: ProblemCollector,
): void {
  reportDuplicates(
    collector,
    definitions.map((definition) => definition.type),
    'Event type',
  );
  for (const definition of definitions) {
    const { type } = definition;
    if (!EVENT_TYPE_PATTERN.test(type) || type.length > 128) {
      collector.report(
        type,
        'invalid_name',
        `Event type "${type}" is not a lowercase dotted name with at least two segments`,
      );
    }
    if (definition.plugin === undefined) {
      if (isPluginEventType(type)) {
        collector.report(
          type,
          'plugin_prefix',
          `Event type "${type}" is in the plugin.* namespace but has no plugin owner`,
        );
      }
    } else {
      const match = PLUGIN_EVENT_PATTERN.exec(type);
      if (match?.[1] !== definition.plugin) {
        collector.report(
          type,
          'plugin_prefix',
          `Event type "${type}" of plugin "${definition.plugin}" must be plugin.${definition.plugin}.<name>`,
        );
      }
    }
    if (!Number.isInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
      collector.report(
        type,
        'invalid_version',
        `Event type "${type}" has schemaVersion ${String(definition.schemaVersion)}; it must be an integer >= 1`,
      );
    }
    if (!isZodSchema(definition.payload)) {
      collector.report(type, 'missing_schema', `Event type "${type}" has no payload schema`);
    }
  }
}
