// SPDX-License-Identifier: MPL-2.0

const REDACTED = '[REDACTED]';

/**
 * Node's `util.inspect` hook. `Symbol.for` gives the same symbol without importing `node:util`
 * (core imports no Node module).
 */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/**
 * An opaque secret value. The only way to the plain text is the explicit {@link Secret.reveal}.
 *
 * `String(secret)`, template literals, `JSON.stringify`, `util.inspect`/`console.log` and spreading
 * all yield `[REDACTED]`, so a secret that ends up in a log line, an event payload or an error
 * message by accident does not leak (architecture 5.11: masking, any mode). The value lives in a
 * `#private` field: it is not an own property and is invisible to reflection and structured clone.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The plain text. Call it only at the point of use (e.g. building the child's environment). */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [INSPECT_CUSTOM](): string {
    return `Secret(${REDACTED})`;
  }
}

export function isSecret(value: unknown): value is Secret {
  return value instanceof Secret;
}
