// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import type {
  JsonValue,
  TelemetryAttributes,
  TelemetryBatch,
  TelemetryLogRecord,
  TelemetryMetricPoint,
  TelemetrySpan,
} from '@otheater/core';
import { REDACTED_VALUE } from '@otheater/protocol';
import { maskSecrets } from '../execution/continuation-package.js';

/**
 * What the receiver removes from a record before it reaches the telemetry base (Phase 8, P2, N212;
 * architecture 5.11). Three layers, all of them over the attributes of the record, its resource and
 * the text fields (log body, span status message):
 *
 * 1. **Always** (both modes): the identity of the account and the machine (`user.email`,
 *    `user.account_id`, ...: the key is deleted), the value of an attribute whose name says it is a
 *    secret, every value that has the shape of a credential (`maskSecrets`) and every value the
 *    SecretVault holds (a vault value shorter than {@link MIN_VAULT_SECRET} is not searched: it
 *    would tear ordinary text apart).
 * 2. **`default` only**: the content of the work (prompts, answers, tool arguments and output),
 *    replaced by `{ redacted: 'content', size, sha256 }`: what it was, how big, and a way to tell
 *    two equal ones apart, never the text.
 * 3. **`full`**: layer 2 is off, layer 1 stays.
 *
 * The names of what was removed are written to the record, in `otheater.redacted` (resource names
 * prefixed with `resource:`), and counted for the `telemetry.redacted` event. The values never are.
 * [N] The attribute names below come from the spikes of Phase 0 (`spikes/otel/README.md`, fake
 * values only here) and from the AI SDK conventions; a name a client adds later is not covered
 * until it is listed, which is why layer 1 also looks at the shape of every value.
 */

/** `telemetry.redaction`. */
export type TelemetryRedactionMode = 'default' | 'full';

/** Identity of the person, the account, the organization and the machine: deleted, in any mode. */
export const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'user.email',
  'user.id',
  'user.account_id',
  'user.account_uuid',
  'organization.id',
  'host.name',
]);

/** The attribute that lists, in each record, the names the redaction removed. */
export const REDACTED_ATTRIBUTE = 'otheater.redacted';

/** A secret of the vault shorter than this is not searched for in the text. */
export const MIN_VAULT_SECRET = 8;

const SECRET_KEY =
  /(^|[._-])(secret|secrets|token|password|passwd|passphrase|credential|credentials|api_?key|private_?key|bearer|authorization|cookie)($|[._-])/iu;
/** A name that says where a secret is, not the secret (`..._env`, `..._file`), and the token counters. */
const NOT_A_SECRET_KEY =
  /(_env|_file|_path|_store)$|(^|[._-])tokens?[._-](type|usage|count|limit|total|input|output|cache[a-z_]*)($|[._-])/iu;

/** Content of the work, by exact name. */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'user_prompt',
  'tool_parameters',
  'tool_input',
  'tool_output',
  'ai.prompt',
  'ai.toolCall.args',
  'ai.toolCall.result',
  'gen_ai.prompt',
  'gen_ai.completion',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
]);
/** Content by name pattern: `ai.prompt.*`, `ai.response.*`, `gen_ai.*.content`. */
const CONTENT_PATTERNS: readonly RegExp[] = [
  /^ai\.prompt\./u,
  /^ai\.response\./u,
  /^gen_ai\..*\.content$/u,
];
/** What `ai.response.*` carries that is not content (about the answer, not the answer). */
const NOT_CONTENT_RESPONSE: ReadonlySet<string> = new Set([
  'ai.response.finishReason',
  'ai.response.id',
  'ai.response.model',
  'ai.response.timestamp',
  'ai.response.msToFirstChunk',
  'ai.response.msToFinish',
  'ai.response.avgCompletionTokensPerSecond',
]);
/** The attributes of a tool result event that are content (`codex.tool_result`: `arguments`, `output`). */
const TOOL_RESULT_CONTENT: ReadonlySet<string> = new Set(['arguments', 'output']);
const TOOL_RESULT_EVENT = /(^|\.)tool_result$/u;

function isContentKey(key: string, eventName: string | null): boolean {
  if (CONTENT_KEYS.has(key)) return true;
  if (NOT_CONTENT_RESPONSE.has(key)) return false;
  if (CONTENT_PATTERNS.some((pattern) => pattern.test(key))) return true;
  return eventName !== null && TOOL_RESULT_EVENT.test(eventName) && TOOL_RESULT_CONTENT.has(key);
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !NOT_A_SECRET_KEY.test(key);
}

/** What was removed since the last {@link Redactor.drain}. */
export interface RedactionReport {
  readonly mode: TelemetryRedactionMode;
  /** Values removed or replaced. */
  readonly count: number;
  /** Records that had at least one. */
  readonly records: number;
  /** Attribute names, sorted (never values). */
  readonly names: readonly string[];
}

export interface RedactorOptions {
  readonly mode: TelemetryRedactionMode;
  /** The values of the SecretVault right now; read at each batch, so a new secret counts at once. */
  readonly secrets?: () => readonly string[];
}

/** `{ redacted: 'content', size, sha256 }` for a content value. */
function summarize(value: JsonValue): JsonValue {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    redacted: 'content',
    size: text.length,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

const MASK_CHUNK = 32_768;

/**
 * `maskSecrets` on a long text, a chunk at a time (its assignment pattern backtracks on a long run
 * of name characters). The chunks end at a line break or a space when there is one, so a secret
 * that crosses a cut is the rare case, not the common one.
 */
function maskLong(text: string): string {
  if (text.length <= MASK_CHUNK) return maskSecrets(text);
  const parts: string[] = [];
  let from = 0;
  while (from < text.length) {
    let to = Math.min(from + MASK_CHUNK, text.length);
    if (to < text.length) {
      const cut = Math.max(text.lastIndexOf('\n', to), text.lastIndexOf(' ', to));
      if (cut > from) to = cut + 1;
    }
    parts.push(maskSecrets(text.slice(from, to)));
    from = to;
  }
  return parts.join('');
}

export class Redactor {
  readonly #mode: TelemetryRedactionMode;
  readonly #secrets: () => readonly string[];
  #count = 0;
  #records = 0;
  readonly #names = new Set<string>();

  constructor(options: RedactorOptions) {
    this.#mode = options.mode;
    this.#secrets = options.secrets ?? (() => []);
  }

  get mode(): TelemetryRedactionMode {
    return this.#mode;
  }

  /** A copy of `batch` with every record redacted. The input is not changed. */
  redact(batch: TelemetryBatch): TelemetryBatch {
    const secrets = this.#secrets()
      .filter((secret) => secret.length >= MIN_VAULT_SECRET)
      .sort((a, b) => b.length - a.length);
    const text = (value: string): string => this.#maskText(value, secrets);
    const out: {
      spans?: TelemetrySpan[];
      metrics?: TelemetryMetricPoint[];
      logs?: TelemetryLogRecord[];
    } = {};
    if (batch.spans !== undefined) {
      out.spans = batch.spans.map((span) => {
        const found = new Set<string>();
        const attributes = this.#attributes(span.attributes, null, secrets, found, '');
        const resource = this.#attributes(span.resource, null, secrets, found, 'resource:');
        const statusMessage = this.#field(span.statusMessage, text, found, 'status.message');
        return this.#close(
          { ...span, attributes, resource, statusMessage, name: text(span.name) },
          found,
        );
      });
    }
    if (batch.metrics !== undefined) {
      out.metrics = batch.metrics.map((point) => {
        const found = new Set<string>();
        const attributes = this.#attributes(point.attributes, null, secrets, found, '');
        const resource = this.#attributes(point.resource, null, secrets, found, 'resource:');
        return this.#close({ ...point, attributes, resource }, found);
      });
    }
    if (batch.logs !== undefined) {
      out.logs = batch.logs.map((record) => {
        const found = new Set<string>();
        const named = record.attributes['event.name'];
        const eventName = typeof named === 'string' ? named : record.body;
        const attributes = this.#attributes(record.attributes, eventName, secrets, found, '');
        const resource = this.#attributes(record.resource, null, secrets, found, 'resource:');
        const body = this.#field(record.body, text, found, 'body');
        return this.#close({ ...record, attributes, resource, body }, found);
      });
    }
    return out;
  }

  /** What was removed since the last call, or `undefined` when nothing was. Resets the counters. */
  drain(): RedactionReport | undefined {
    if (this.#count === 0) return undefined;
    const report: RedactionReport = {
      mode: this.#mode,
      count: this.#count,
      records: this.#records,
      names: [...this.#names].sort(),
    };
    this.#count = 0;
    this.#records = 0;
    this.#names.clear();
    return report;
  }

  /** Writes the list of names into the record and adds it to the report. */
  #close<Record extends { readonly attributes: TelemetryAttributes }>(
    record: Record,
    found: ReadonlySet<string>,
  ): Record {
    if (found.size === 0) return record;
    this.#records += 1;
    for (const name of found) this.#names.add(name);
    return {
      ...record,
      attributes: { ...record.attributes, [REDACTED_ATTRIBUTE]: [...found].sort() },
    };
  }

  #field(
    value: string | null,
    text: (value: string) => string,
    found: Set<string>,
    name: string,
  ): string | null {
    if (value === null) return null;
    const masked = text(value);
    if (masked !== value) this.#note(found, name);
    return masked;
  }

  #note(found: Set<string>, name: string): void {
    found.add(name);
    this.#count += 1;
  }

  #maskText(value: string, secrets: readonly string[]): string {
    let out = value;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED_VALUE);
    }
    return maskLong(out);
  }

  #maskValue(value: JsonValue, secrets: readonly string[]): JsonValue {
    if (typeof value === 'string') return this.#maskText(value, secrets);
    if (Array.isArray(value)) return value.map((item) => this.#maskValue(item, secrets));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(value)) {
        out[key] =
          isSecretKey(key) && typeof child === 'string'
            ? REDACTED_VALUE
            : this.#maskValue(child, secrets);
      }
      return out;
    }
    return value;
  }

  #attributes(
    attributes: TelemetryAttributes,
    eventName: string | null,
    secrets: readonly string[],
    found: Set<string>,
    prefix: string,
  ): TelemetryAttributes {
    const out: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith('otheater.')) {
        out[key] = value;
        continue;
      }
      if (IDENTITY_KEYS.has(key)) {
        this.#note(found, `${prefix}${key}`);
        continue;
      }
      if (
        value !== null &&
        typeof value !== 'number' &&
        typeof value !== 'boolean' &&
        isSecretKey(key)
      ) {
        out[key] = REDACTED_VALUE;
        this.#note(found, `${prefix}${key}`);
        continue;
      }
      if (
        this.#mode === 'default' &&
        value !== null &&
        value !== '' &&
        isContentKey(key, eventName)
      ) {
        out[key] = summarize(value);
        this.#note(found, `${prefix}${key}`);
        continue;
      }
      const masked = this.#maskValue(value, secrets);
      const changed =
        typeof value === 'string'
          ? masked !== value
          : JSON.stringify(masked) !== JSON.stringify(value);
      if (changed) this.#note(found, `${prefix}${key}`);
      out[key] = masked;
    }
    return out;
  }
}
