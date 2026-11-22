// SPDX-License-Identifier: MPL-2.0

/**
 * The events of a plugin (architecture 5.14; plan of Phase 9, P9 and P8).
 *
 * A plugin publishes only the event names its manifest declares. The helper sends the MCP
 * notification {@link PLUGIN_EVENT_METHOD} to the daemon, which turns it into the event
 * `plugin.<id>.<name>` of the log. The helper refuses, on the side of the plugin, an undeclared
 * name and a payload over the limit, so a faulty plugin fails where the author can see it; the
 * daemon (P8) checks the same two rules again, because it trusts no plugin.
 */

/** The MCP notification a plugin sends to publish an event [proposta]. */
export const PLUGIN_EVENT_METHOD = 'notifications/otheater/event';

/**
 * The biggest payload the helper sends, in bytes of its JSON text [proposta]. It is the default
 * of `plugins.event_max_bytes` (P8); a plugin cannot know the setting of the daemon, so the
 * helper keeps to the default and the daemon enforces the configured value.
 */
export const PLUGIN_EVENT_MAX_BYTES = 16 * 1024;

/** `params` of the notification: the declared name (no `plugin.<id>.` prefix) and the payload. */
export interface PluginEventParams {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

export type PluginEventErrorCode = 'undeclared' | 'invalid_payload' | 'too_large';

/** An event the helper refused to send. `code` says why; the message says what to change. */
export class PluginEventError extends Error {
  override readonly name = 'PluginEventError';
  constructor(
    readonly code: PluginEventErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PluginEventPublisherOptions {
  /** The event names of the manifest (`events`), with no prefix. */
  readonly declared: Iterable<string>;
  /** Sends the notification; the server of the plugin hands over its MCP connection. */
  readonly send: (params: PluginEventParams) => Promise<void>;
  /** Limit of the payload in bytes; {@link PLUGIN_EVENT_MAX_BYTES} when absent. */
  readonly maxBytes?: number | undefined;
}

export interface PluginEventPublisher {
  /**
   * Publishes the event `name` with `payload` (a JSON object). It throws a
   * {@link PluginEventError} when the name is not declared in the manifest, when the payload is
   * not a plain JSON object, or when its JSON text is over the limit.
   */
  publish(name: string, payload?: Record<string, unknown>): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function createEventPublisher(options: PluginEventPublisherOptions): PluginEventPublisher {
  const declared = new Set(options.declared);
  const maxBytes = options.maxBytes ?? PLUGIN_EVENT_MAX_BYTES;
  return {
    async publish(name, payload = {}) {
      if (!declared.has(name)) {
        const known = [...declared];
        throw new PluginEventError(
          'undeclared',
          `event "${name}" is not declared in the manifest (events: ${known.length === 0 ? 'none' : known.join(', ')}); declare it, with no "plugin.<id>." prefix`,
        );
      }
      if (!isPlainObject(payload)) {
        throw new PluginEventError('invalid_payload', `the payload of "${name}" must be an object`);
      }
      let text: string;
      try {
        text = JSON.stringify(payload);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new PluginEventError(
          'invalid_payload',
          `the payload of "${name}" is not JSON: ${reason}`,
        );
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > maxBytes) {
        throw new PluginEventError(
          'too_large',
          `the payload of "${name}" has ${String(bytes)} bytes, over the limit of ${String(maxBytes)}`,
        );
      }
      // Send the parsed copy, so what leaves is exactly the JSON that was measured.
      await options.send({ name, payload: JSON.parse(text) as Record<string, unknown> });
    },
  };
}
