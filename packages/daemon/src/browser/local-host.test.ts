// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { isLocalHost } from './local-host.js';

describe('isLocalHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'app.localhost',
    '127.0.0.1',
    '127.8.9.10',
    '[::1]',
    '::1',
    '10.0.0.5',
    '192.168.1.20',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '100.64.0.1',
    'printer.local',
    'host.internal',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    'localhost.',
  ])('takes %s for this machine or its network', (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each([
    'example.com',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    'localhost.example.com',
    '2001:db8::1',
  ])('does not take %s for it', (host) => {
    expect(isLocalHost(host)).toBe(false);
  });
});
