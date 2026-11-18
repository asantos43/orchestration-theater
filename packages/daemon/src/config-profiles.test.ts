// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  DRAIN_ON_TIMEOUT_MODES,
  REMOVED_DIR_MODES,
  SAME_PROVIDER_NOTICE_MODES,
  parseConfig,
} from './config.js';

describe('profiles.* of the config (Phase 5, P2; N127 open)', () => {
  it('[proposta] has the provisional defaults', () => {
    expect(parseConfig('').profiles).toEqual({
      same_provider_notice: 'once',
      drain: { timeout: 600_000, on_timeout: 'handoff', removed_dir: 'delete' },
      api_key_env: {},
      entries: {},
    });
  });

  it('takes every mode of every key', () => {
    for (const mode of SAME_PROVIDER_NOTICE_MODES) {
      expect(
        parseConfig(`profiles:\n  same_provider_notice: ${mode}\n`).profiles.same_provider_notice,
      ).toBe(mode);
    }
    for (const mode of DRAIN_ON_TIMEOUT_MODES) {
      expect(
        parseConfig(`profiles:\n  drain:\n    on_timeout: ${mode}\n`).profiles.drain.on_timeout,
      ).toBe(mode);
    }
    for (const mode of REMOVED_DIR_MODES) {
      expect(
        parseConfig(`profiles:\n  drain:\n    removed_dir: ${mode}\n`).profiles.drain.removed_dir,
      ).toBe(mode);
    }
  });

  it('reads the drain timeout as a duration, and 0 as no wait', () => {
    expect(parseConfig('profiles:\n  drain:\n    timeout: 90s\n').profiles.drain.timeout).toBe(
      90_000,
    );
    expect(parseConfig('profiles:\n  drain:\n    timeout: 0\n').profiles.drain.timeout).toBe(0);
  });

  it('maps a provider to the variable that carries its key', () => {
    const { profiles } = parseConfig('profiles:\n  api_key_env:\n    minimax: MY_MINIMAX_KEY\n');
    expect(profiles.api_key_env).toEqual({ minimax: 'MY_MINIMAX_KEY' });
  });

  it('refuses a mode it does not know, a bad variable name and an unknown key', () => {
    expect(() => parseConfig('profiles:\n  same_provider_notice: sometimes\n')).toThrow(
      InvalidInput,
    );
    expect(() => parseConfig('profiles:\n  drain:\n    on_timeout: drop\n')).toThrow(InvalidInput);
    expect(() => parseConfig('profiles:\n  drain:\n    removed_dir: archive\n')).toThrow(
      InvalidInput,
    );
    expect(() => parseConfig('profiles:\n  api_key_env:\n    minimax: "not a name"\n')).toThrow(
      InvalidInput,
    );
    expect(() => parseConfig('profiles:\n  extra: 1\n')).toThrow(InvalidInput);
  });
});
