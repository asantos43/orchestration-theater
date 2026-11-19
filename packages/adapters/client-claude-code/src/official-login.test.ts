// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { commandOf, firstCode, firstUrl, isLoopbackUrl, signInUrl } from './official-login.js';

describe('firstUrl', () => {
  it('takes the first URL, without the colors and the full stop that ends the sentence', () => {
    expect(firstUrl('\u001b[1mOpen:\u001b[0m https://a.example.test/x?y=1. Then wait.')).toBe(
      'https://a.example.test/x?y=1',
    );
  });

  it('is undefined when there is none', () => {
    expect(firstUrl('Logged in')).toBeUndefined();
  });
});

describe('signInUrl', () => {
  it('skips the callback server on this machine and takes the sign-in URL (Codex)', () => {
    const text =
      'Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.example.test/oauth/authorize?state=x\n';
    expect(signInUrl(text)).toBe('https://auth.example.test/oauth/authorize?state=x');
  });

  it('falls back to the callback server when it is the only URL', () => {
    expect(signInUrl('Listening on http://127.0.0.1:8080/cb.')).toBe('http://127.0.0.1:8080/cb');
    expect(signInUrl('nothing here')).toBeUndefined();
  });

  it('tells a URL on this machine from one that only looks like it', () => {
    expect(isLoopbackUrl('http://localhost:1455')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:9/x')).toBe(true);
    expect(isLoopbackUrl('https://localhost.example.test/x')).toBe(false);
  });
});

describe('firstCode', () => {
  it('finds a device code, and not a piece of a URL', () => {
    expect(firstCode('Go to https://a.example.test/ABCD-12345 and enter WXYZ-9876')).toBe(
      'WXYZ-9876',
    );
    expect(firstCode('https://a.example.test/ABCD-1234')).toBeUndefined();
  });
});

describe('commandOf', () => {
  it('copies the fallback and fills in the arguments of a given command', () => {
    const fallback = { cmd: 'x', args: ['a'] };
    const copy = commandOf(undefined, fallback);
    expect(copy).toEqual(fallback);
    expect(copy.args).not.toBe(fallback.args);
    expect(commandOf({ cmd: 'y' }, fallback)).toEqual({ cmd: 'y', args: [] });
  });
});
