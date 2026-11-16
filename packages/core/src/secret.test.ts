// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { Secret, isSecret } from './secret.js';

const PLAIN = 'sk-test-plain-text-value';
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

describe('Secret', () => {
  it('reveal() is the only way to the plain text', () => {
    expect(new Secret(PLAIN).reveal()).toBe(PLAIN);
  });

  it('is redacted by String(), template literals, concatenation and JSON', () => {
    const secret = new Secret(PLAIN);
    const texts = [
      String(secret),
      secret.toString(),
      `key=${secret as unknown as string}`,
      'key=' + (secret as unknown as string),
      JSON.stringify(secret),
      JSON.stringify({ a: { secret }, list: [secret] }),
    ];
    for (const text of texts) {
      expect(text).toContain('[REDACTED]');
      expect(text).not.toContain(PLAIN);
    }
  });

  it('has no own property carrying the value, and spreading drops it', () => {
    const secret = new Secret(PLAIN);
    expect(Object.getOwnPropertyNames(secret)).toEqual([]);
    expect(Object.getOwnPropertySymbols(secret)).toEqual([]);
    expect(Object.assign({}, secret)).toEqual({});
    expect(JSON.stringify(structuredClone(Object.assign({}, secret)))).not.toContain(PLAIN);
  });

  it('is redacted by the Node inspect hook (console.log, util.inspect)', () => {
    const hook = (new Secret(PLAIN) as unknown as Record<symbol, () => string>)[INSPECT_CUSTOM];
    expect(hook?.call(new Secret(PLAIN))).toBe('Secret([REDACTED])');
  });

  it('isSecret tells a Secret from a plain string', () => {
    expect(isSecret(new Secret(''))).toBe(true);
    expect(isSecret(PLAIN)).toBe(false);
    expect(isSecret({ reveal: () => PLAIN })).toBe(false);
  });
});
