// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { isLocalName, isPrivateAddress } from './private-address.js';

describe('isPrivateAddress', () => {
  it.each([
    '0.0.0.0',
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '192.0.0.8',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fe80::abcd%eth0',
    'fc00::1',
    'fd12:3456::1',
    'fec0::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::1',
    '2002:a9fe:a9fe::',
    '0:0:0:0:0:0:0:1',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '169.253.1.1',
    '192.0.2.1',
    '198.17.0.1',
    '198.20.0.1',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
    'example.com',
  ])('lets %s through', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it('knows the names that are this machine', () => {
    expect(isLocalName('localhost')).toBe(true);
    expect(isLocalName('LOCALHOST.')).toBe(true);
    expect(isLocalName('app.localhost')).toBe(true);
    expect(isLocalName('notlocalhost.com')).toBe(false);
    expect(isLocalName('example.com')).toBe(false);
  });
});
