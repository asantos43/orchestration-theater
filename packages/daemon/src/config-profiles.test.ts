// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  DRAIN_DIRECTOR_MODES,
  DRAIN_ON_TIMEOUT_MODES,
  REMOVED_DIR_MODES,
  SAME_PROVIDER_NOTICE_MODES,
  parseConfig,
} from './config.js';

describe('profiles.* of the config (Phase 5, P2; N127 open)', () => {
  it('[proposta] has the provisional defaults', () => {
    expect(parseConfig('').profiles).toEqual({
      same_provider_notice: 'once',
      drain: {
        timeout: 600_000,
        on_timeout: 'handoff',
        removed_dir: 'delete',
        director: 'failover',
      },
      api_key_env: {},
      rotate_on_exhaustion: { openai: 'off' },
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
    for (const mode of DRAIN_DIRECTOR_MODES) {
      expect(
        parseConfig(`profiles:\n  drain:\n    director: ${mode}\n`).profiles.drain.director,
      ).toBe(mode);
    }
    expect(() => parseConfig('profiles:\n  drain:\n    director: sometimes\n')).toThrow(/director/);
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

describe('profiles.<client>/<profile> of the config (Phase 5, P14)', () => {
  it('reads the local block of a profile, with the defaults of the local model server', () => {
    const { profiles } = parseConfig(
      'profiles:\n  opencode/local:\n    local:\n      server: llama-cpp\n      url: http://127.0.0.1:8080/v1\n',
    );
    expect(profiles.entries['opencode/local']?.local).toMatchObject({
      server: 'llama-cpp',
      url: 'http://127.0.0.1:8080/v1',
    });
    // The keys of profiles.* keep working beside the profile blocks.
    expect(profiles.same_provider_notice).toBe('once');
  });

  it('takes a profile with no local block', () => {
    expect(parseConfig('profiles:\n  codex/main: {}\n').profiles.entries['codex/main']).toEqual({});
  });

  it('refuses a key that is neither a key of profiles nor a profile, naming it', () => {
    expect(() => parseConfig('profiles:\n  banana:\n    local: {}\n')).toThrow(/banana/u);
  });

  it('takes codex_link on an OpenCode profile (P25, N156)', () => {
    const { profiles } = parseConfig('profiles:\n  opencode/oai:\n    codex_link: chatgpt\n');
    expect(profiles.entries['opencode/oai']).toEqual({ codex_link: 'chatgpt' });
  });

  it('refuses codex_link outside an OpenCode profile, and a name that is not a profile name', () => {
    expect(() => parseConfig('profiles:\n  codex/main:\n    codex_link: other\n')).toThrow(
      /only for an opencode/u,
    );
    expect(() => parseConfig('profiles:\n  opencode/oai:\n    codex_link: codex/main\n')).toThrow(
      /name of a Codex profile/u,
    );
    expect(() => parseConfig('profiles:\n  opencode/oai:\n    codex_link: ""\n')).toThrow(
      InvalidInput,
    );
  });

  it('refuses an unknown key inside a profile and a bad local block', () => {
    expect(() => parseConfig('profiles:\n  opencode/local:\n    dir: /x\n')).toThrow(InvalidInput);
    expect(() =>
      parseConfig('profiles:\n  opencode/local:\n    local:\n      server: vllm\n'),
    ).toThrow(InvalidInput);
  });
});
