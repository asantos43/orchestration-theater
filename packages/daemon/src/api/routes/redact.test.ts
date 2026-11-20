// SPDX-License-Identifier: MPL-2.0
import { REDACTED_VALUE } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { redactConfig, redactTree } from './redact.js';

describe('redactTree', () => {
  it('holds back every value under an env key, at any depth', () => {
    const { value, paths } = redactTree({
      clients: { codex: { env: { A: 'one', B: 'two' }, model: 'm' } },
    });
    expect(value).toEqual({
      clients: { codex: { env: { A: REDACTED_VALUE, B: REDACTED_VALUE }, model: 'm' } },
    });
    expect(paths).toEqual(['clients.codex.env.A', 'clients.codex.env.B']);
  });

  it('holds back a string whose key names a secret', () => {
    const { value, paths } = redactTree({
      api_key: 'abc',
      db: { password: 'p', passphrase: 'q', private_key: 'k', bearer: 'b' },
      list: [{ client_secret: 's' }],
    });
    expect(JSON.stringify(value)).not.toMatch(/"(abc|p|q|k|b|s)"/);
    expect(paths).toEqual([
      'api_key',
      'db.password',
      'db.passphrase',
      'db.private_key',
      'db.bearer',
      'list[0].client_secret',
    ]);
  });

  it('keeps a key that only says where a secret is (a variable, a file, a path)', () => {
    const tree = {
      api_key_env: 'ANTHROPIC_API_KEY',
      token_file: '/run/token',
      credentials_path: '/home/x/creds.json',
      api: { token: 'auto' },
    };
    expect(redactTree(tree)).toEqual({ value: tree, paths: [] });
  });

  it('holds back a URL with a password and the shape of a well known key', () => {
    const { value, paths } = redactTree({
      proxy: 'http://user:hunter2@proxy.local:8080',
      note: 'see sk-abcdefghijklmnopqrstuvwxyz0123',
      gh: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      aws: 'AKIAABCDEFGHIJKLMNOP',
      fine: 'http://proxy.local:8080',
    });
    expect(paths).toEqual(['proxy', 'note', 'gh', 'aws']);
    expect(value.fine).toBe('http://proxy.local:8080');
  });

  it('leaves empty strings, numbers, booleans and nulls alone, and does not change its input', () => {
    const tree = { password: '', n: 1, ok: true, none: null, nested: { token: 'x' } };
    const copy = JSON.parse(JSON.stringify(tree)) as typeof tree;
    const { value } = redactTree(tree);
    expect(value).toEqual({
      password: '',
      n: 1,
      ok: true,
      none: null,
      nested: { token: REDACTED_VALUE },
    });
    expect(tree).toEqual(copy);
  });
});

describe('redactConfig', () => {
  it('holds back nothing of the default configuration', () => {
    const { paths } = redactConfig(parseConfig(''));
    expect(paths).toEqual([]);
  });

  it('holds back a literal that was written where a secret should not be', () => {
    const config = parseConfig(
      [
        'clients:',
        '  codex:',
        '    env:',
        '      OPENAI_API_KEY: sk-abcdefghijklmnopqrstuvwxyz0123',
        '',
      ].join('\n'),
    );
    const { value, paths } = redactConfig(config);
    expect(JSON.stringify(value)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(paths).toContain('clients.codex.env.OPENAI_API_KEY');
  });
});
