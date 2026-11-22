// SPDX-License-Identifier: MPL-2.0
import {
  defineEventType,
  type EventCheck,
  type EventRegistry,
  type EventTypeDefinition,
} from '@otheater/core';
import type {
  PluginEventRejectedPayload,
  PluginEventRejectedReason,
  PluginServerFailedPayload,
} from '@otheater/protocol';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { RegistryContributor } from '../registries.js';
import { situationText, type SituationLog, type SituationSink } from '../situations.js';
import type { ActivePluginSource } from './aggregate.js';
import type { PluginNotice as RegistryNotice } from './registry.js';
import type {
  PluginEventNotification,
  PluginEventSink,
  PluginNotice,
  PluginRuntimeConfig,
} from './runtime-config.js';

/**
 * The events about the plugins (Phase 9, P8; architecture 5.14 and 5.18; the owner's rule
 * "situations become events", 2026-11-18). Three jobs, each a pure function of its input or a small
 * object, so the daemon only wires them:
 *
 * 1. {@link recordPluginNotice} and {@link recordRegistryNotice} turn what the pool, the aggregator
 *    and the registry already tell the log (`PluginNotice`) into the `plugin.<name>` events of the
 *    protocol. The log line stays; the event is written at the same point. No payload carries what a
 *    plugin says or does, only ids, names, counts and a masked, cut reason. [proposta]
 * 2. {@link createPluginEventHandler} receives the event notifications of the servers
 *    (`notifications/otheater/event`, `{ name, payload }`), checks them (the plugin is active in the
 *    project, the name is in its manifest, the payload is a JSON object within
 *    `plugins.event_max_bytes`) and writes `plugin.<id>.<name>`; what fails any check is refused
 *    with a warning and `plugin.event_rejected`. The daemon trusts no plugin.
 * 3. {@link pluginEventContributor} and {@link LiveEventRegistry} make the types `plugin.<id>.<name>`
 *    of the active plugins part of the registry the event log validates against. The log is
 *    composed before the plugins are known, so it holds a live registry that reads the snapshot in
 *    force (it changes when a plugin is turned on or off).
 */

// ---------------------------------------------------------------------------------------------
// 1. Notices to events

/** Does not compile when a kind of notice has no `case`. */
function exhaustive(notice: never): never {
  throw new Error(`a notice of a plugin has no event: ${JSON.stringify(notice)}`);
}

/** The reason of a `plugin.server_failed`, which must not be empty. */
function reasonText(value: string): string {
  return situationText(value) ?? 'unknown';
}

/**
 * Records the event of a notice of the pool or of the aggregator. Exhaustive: a new kind of notice
 * does not compile until it has an event (or is left out here on purpose).
 */
export function recordPluginNotice(situations: SituationSink, notice: PluginNotice): void {
  const { plugin, project } = notice;
  const correlation = { scenarioId: project };
  switch (notice.kind) {
    case 'tool_not_declared':
      situations.record(
        'plugin.tool_rejected',
        { plugin, project, tool: notice.tool, reason: 'not_declared' },
        correlation,
      );
      return;
    case 'tool_not_exposed':
      situations.record(
        'plugin.tool_rejected',
        { plugin, project, tool: notice.tool, reason: 'not_exposed' },
        correlation,
      );
      return;
    case 'tool_name_rejected':
      situations.record(
        'plugin.tool_rejected',
        {
          plugin,
          project,
          tool: notice.tool,
          reason: notice.reason === 'too_long' ? 'name_too_long' : 'name_taken',
        },
        correlation,
      );
      return;
    case 'process_started':
      situations.record(
        'plugin.server_started',
        { plugin, project, ...(notice.pid === undefined ? {} : { pid: notice.pid }) },
        correlation,
      );
      return;
    case 'process_stopped':
      situations.record(
        'plugin.server_stopped',
        { plugin, project, reason: notice.reason },
        correlation,
      );
      return;
    case 'process_failed': {
      const payload: PluginServerFailedPayload = {
        plugin,
        project,
        failures: notice.failures,
        givenUp: false,
        retryInMs: notice.retryInMs,
        reason: reasonText(notice.reason),
      };
      situations.record('plugin.server_failed', payload, correlation);
      return;
    }
    case 'process_given_up': {
      const payload: PluginServerFailedPayload = {
        plugin,
        project,
        failures: notice.failures,
        givenUp: true,
        reason: reasonText(notice.reason),
      };
      situations.record('plugin.server_failed', payload, correlation);
      return;
    }
    case 'tool_refused':
      situations.record(
        'plugin.tool_rejected',
        { plugin, project, tool: notice.tool, reason: notice.reason, role: notice.role },
        correlation,
      );
      return;
    default:
      return exhaustive(notice);
  }
}

/**
 * Records the event of a notice of the registry (`ot plugin ...`). `broken` (a folder that cannot be
 * read) stays a log line: it is not a change the plugins or the hooks react to, and the
 * `needs_approval` that follows an update is the event of what changed for a project. [proposta]
 */
export function recordRegistryNotice(situations: SituationSink, notice: RegistryNotice): void {
  switch (notice.kind) {
    case 'installed':
    case 'updated':
      situations.record('plugin.installed', {
        plugin: notice.id,
        version: notice.version,
        update: notice.kind === 'updated',
      });
      return;
    case 'removed':
      situations.record('plugin.removed', { plugin: notice.id, version: notice.version });
      return;
    case 'enabled':
      situations.record(
        'plugin.enabled',
        { plugin: notice.id, project: notice.project },
        { scenarioId: notice.project },
      );
      return;
    case 'disabled':
      situations.record(
        'plugin.disabled',
        { plugin: notice.id, project: notice.project, reason: 'producer' },
        { scenarioId: notice.project },
      );
      return;
    case 'needs_approval':
      for (const project of notice.projects) {
        situations.record(
          'plugin.disabled',
          { plugin: notice.id, project, reason: 'needs_approval' },
          { scenarioId: project },
        );
      }
      return;
    case 'broken':
      return;
    default:
      return exhaustive(notice);
  }
}

// ---------------------------------------------------------------------------------------------
// 2. The events of the plugin

/** The type of the event `name` of the plugin `id`. */
export function pluginEventType(id: string, name: string): string {
  return `plugin.${id}.${name}`;
}

/** `params` of the notification: the declared name (no prefix) and the payload (a JSON object). */
const eventParamsSchema = z.object({
  name: z.string().min(1),
  payload: z.record(z.string(), z.json()).optional(),
});

export interface PluginEventHandlerOptions {
  /** The plugins active in each project (the registry of P4 or what a test hands in). */
  readonly source: Pick<ActivePluginSource, 'activeFor'>;
  /** A getter, so `plugins.events` and `plugins.event_max_bytes` are read when an event arrives. */
  readonly runtime: () => Pick<PluginRuntimeConfig, 'events' | 'eventMaxBytes'>;
  /** Where the events go: the log of the daemon, in order, after `daemon.started`. */
  readonly situations: Pick<SituationLog, 'recordEvent'> & SituationSink;
  readonly logger: Pick<Logger, 'warn'>;
}

/** The longest `name` a `plugin.event_rejected` carries (the field of the schema). */
const REJECTED_NAME_MAX = 128;

/**
 * The sink the pool calls with each event notification a server sent. It never throws: whatever is
 * wrong with a notification is a refusal (a warning and `plugin.event_rejected`), not an error.
 */
export function createPluginEventHandler(options: PluginEventHandlerOptions): PluginEventSink {
  const { source, runtime, situations, logger } = options;
  return (notification: PluginEventNotification): void => {
    const { plugin, project, params } = notification;
    const parsed = eventParamsSchema.safeParse(params);
    const name = nameOf(params);

    const refuse = (
      reason: PluginEventRejectedReason,
      extra: { bytes?: number; limit?: number } = {},
    ): void => {
      logger.warn(
        { plugin, project, ...(name === undefined ? {} : { name }), reason, ...extra },
        'an event of a plugin was refused',
      );
      const payload: PluginEventRejectedPayload = {
        plugin,
        project,
        ...(name === undefined ? {} : { name }),
        reason,
        ...extra,
      };
      situations.record('plugin.event_rejected', payload, { scenarioId: project });
    };

    const config = runtime();
    if (config.events === 'off') {
      refuse('off');
      return;
    }
    if (!parsed.success) {
      refuse('invalid');
      return;
    }
    const active = source.activeFor(project).find((candidate) => candidate.id === plugin);
    if (active === undefined) {
      refuse('inactive');
      return;
    }
    if (!active.manifest.events.includes(parsed.data.name)) {
      refuse('not_declared');
      return;
    }
    const payload = parsed.data.payload ?? {};
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bytes > config.eventMaxBytes) {
      refuse('too_large', { bytes, limit: config.eventMaxBytes });
      return;
    }
    situations.recordEvent(
      { type: pluginEventType(plugin, parsed.data.name), schemaVersion: 1, payload },
      { scenarioId: project },
    );
  };
}

/** What the plugin sent as `name`, masked and cut for the log and for `plugin.event_rejected`. */
function nameOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const value: unknown = (params as { name?: unknown }).name;
  if (typeof value !== 'string') return undefined;
  return situationText(value, REJECTED_NAME_MAX) ?? undefined;
}

// ---------------------------------------------------------------------------------------------
// 3. The types in the registry

/** The payload of an event of a plugin: any JSON object (the size is the handler's to limit). */
const pluginEventPayload = z.record(z.string(), z.json());

/**
 * The `plugin.<id>.<name>` types of the plugins that are active in some project, for the registry
 * snapshot (`RegistryHolder.contribute`). Pure: the same plugins, the same entries. A type is
 * listed once however many projects have the plugin on.
 */
export const pluginEventContributor: RegistryContributor = (plugins) => {
  const seen = new Set<string>();
  const events: EventTypeDefinition[] = [];
  for (const list of plugins.values()) {
    for (const plugin of list) {
      for (const name of plugin.manifest.events) {
        const type = pluginEventType(plugin.id, name);
        if (seen.has(type)) continue;
        seen.add(type);
        events.push(
          defineEventType({
            type,
            schemaVersion: 1,
            payload: pluginEventPayload,
            plugin: plugin.id,
          }),
        );
      }
    }
  }
  return { events };
};

/**
 * An {@link EventRegistry} that answers from whichever registry `current` returns. The event log is
 * composed before the plugins are known and keeps this object; the daemon binds it to the snapshot
 * of the `RegistryHolder`, so a plugin turned on can write its events and one turned off cannot.
 */
export class LiveEventRegistry implements EventRegistry {
  #current: () => EventRegistry;

  constructor(initial: EventRegistry) {
    this.#current = () => initial;
  }

  /** From now on this registry is whatever `current` returns. */
  bind(current: () => EventRegistry): void {
    this.#current = current;
  }

  get size(): number {
    return this.#current().size;
  }

  has(key: string): boolean {
    return this.#current().has(key);
  }

  get(key: string): EventTypeDefinition | undefined {
    return this.#current().get(key);
  }

  list(): readonly EventTypeDefinition[] {
    return this.#current().list();
  }

  keys(): readonly string[] {
    return this.#current().keys();
  }

  checkEvent(type: string, schemaVersion: number, payload: unknown): EventCheck {
    return this.#current().checkEvent(type, schemaVersion, payload);
  }

  parseEvent(type: string, schemaVersion: number, payload: unknown): unknown {
    return this.#current().parseEvent(type, schemaVersion, payload);
  }
}
