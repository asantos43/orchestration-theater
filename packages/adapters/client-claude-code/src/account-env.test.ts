// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { ACCOUNT_ENV_MODES, ACCOUNT_ENV_NAMES, applyAccountEnv } from './account-env.js';

const env = {
  PATH: '/usr/bin',
  ANTHROPIC_API_KEY: 'placeholder',
  ANTHROPIC_AUTH_TOKEN: 'placeholder',
  CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
  anthropic_api_key: 'placeholder',
};

describe('applyAccountEnv', () => {
  it('strips the account variables by default, whatever the case', () => {
    expect(applyAccountEnv(env)).toEqual({ PATH: '/usr/bin' });
    expect(applyAccountEnv(env, 'strip')).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps them when asked to', () => {
    expect(applyAccountEnv(env, 'keep')).toEqual(env);
  });

  it('returns a copy and never changes the input', () => {
    const input = { ANTHROPIC_API_KEY: 'placeholder', A: '1' };
    const out = applyAccountEnv(input, 'keep');
    out.B = '2';
    expect(input).toEqual({ ANTHROPIC_API_KEY: 'placeholder', A: '1' });
    expect(Object.keys(applyAccountEnv(input))).toEqual(['A']);
  });

  it('lists the names and the modes', () => {
    expect(ACCOUNT_ENV_NAMES).toContain('ANTHROPIC_API_KEY');
    expect([...ACCOUNT_ENV_MODES]).toEqual(['strip', 'keep']);
  });
});
