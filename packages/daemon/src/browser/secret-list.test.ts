// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseConfig, secretPathEntries } from '../config.js';
import { secretPathCheck } from './secret-list.js';

const HOME = '/home/fake-user';
const DATA = '/var/fake-data/otheater';

describe('secretPathCheck: the one list of secret paths, seen by browser_open', () => {
  it('uses the defaults of security.secret_paths, with the fake home and data directory', async () => {
    const check = secretPathCheck(parseConfig(''), HOME, DATA);
    expect(await check(`${HOME}/.ssh/id_ed25519`)).toBe(true);
    expect(await check(`${DATA}/profiles/x/credentials`)).toBe(true);
    expect(await check('/srv/project/.env')).toBe(true);
    expect(await check('/srv/project/src/index.ts')).toBe(false);
  });

  it('adds and removes the entries of security.secret_paths', async () => {
    const config = parseConfig(
      'security:\n  secret_paths:\n    add: [/srv/private]\n    remove: ["~/.mozilla"]\n',
    );
    const check = secretPathCheck(config, HOME, DATA);
    expect(await check('/srv/private/notes.txt')).toBe(true);
    expect(await check(`${HOME}/.mozilla/firefox/x`)).toBe(false);
  });

  it('reads the alias browser.secret_paths the same way', async () => {
    const config = parseConfig(
      'browser:\n  secret_paths:\n    add: [/srv/private]\n    remove: ["~/.mozilla"]\n',
    );
    expect(secretPathEntries(config)).toEqual({ add: ['/srv/private'], remove: ['~/.mozilla'] });
    const check = secretPathCheck(config, HOME, DATA);
    expect(await check('/srv/private/notes.txt')).toBe(true);
    expect(await check(`${HOME}/.mozilla/firefox/x`)).toBe(false);
  });

  it('refuses a config that writes the list in both places', () => {
    expect(() =>
      parseConfig(
        'security:\n  secret_paths:\n    add: [/srv/a]\nbrowser:\n  secret_paths:\n    add: [/srv/b]\n',
      ),
    ).toThrow(/browser\.secret_paths.*alias.*not in both/s);
  });

  it('throws for an entry the list refuses, so the daemon does not start the tools on a broken list', () => {
    const config = parseConfig('browser:\n  secret_paths:\n    add: ["~"]\n');
    expect(() => secretPathCheck(config, HOME, DATA)).toThrow(/whole home directory/);
  });
});
