// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { InvalidInput } from './errors.js';
import { DEFAULT_SECRET_PATHS, isSecretPath, resolveSecretPaths } from './secret-paths.js';

const HOME = '/home/someone';
const DATA = '/srv/otheater-data';

describe('resolveSecretPaths', () => {
  it('expands ~ and <data> in the default list and keeps the bare names', () => {
    const list = resolveSecretPaths({ home: HOME, dataDir: DATA });
    expect(list).toContain('/home/someone/.ssh');
    expect(list).toContain('/home/someone/.claude.json');
    expect(list).toContain('/home/someone/.var/app/*/config');
    expect(list).toContain(DATA);
    expect(list).toContain('.env');
    expect(list).toContain('.env.*');
    expect(list).toHaveLength(DEFAULT_SECRET_PATHS.length);
  });

  it('drops <data> when there is no data directory', () => {
    const list = resolveSecretPaths({ home: HOME });
    expect(list).not.toContain(DATA);
    expect(list).toHaveLength(DEFAULT_SECRET_PATHS.length - 1);
  });

  it('adds entries, once each, and removes by the spelling of the list or the expanded path', () => {
    const list = resolveSecretPaths({
      home: HOME,
      dataDir: DATA,
      add: ['~/.pgpass', '/etc/ssl/private', '~/.ssh', '<data>/vault'],
      remove: ['~/.mozilla', '/home/someone/.kube', '.env.*'],
    });
    expect(list).toContain('/home/someone/.pgpass');
    expect(list).toContain('/etc/ssl/private');
    expect(list).toContain(`${DATA}/vault`);
    expect(list.filter((entry) => entry === '/home/someone/.ssh')).toHaveLength(1);
    expect(list).not.toContain('/home/someone/.mozilla');
    expect(list).not.toContain('/home/someone/.kube');
    expect(list).not.toContain('.env.*');
    expect(list).toContain('.env');
  });

  it('lets a removal win over an addition of the same path', () => {
    const list = resolveSecretPaths({ home: HOME, add: ['~/.pgpass'], remove: ['~/.pgpass'] });
    expect(list).not.toContain('/home/someone/.pgpass');
  });

  it('refuses entries that would deny everything or that cannot be placed', () => {
    expect(() => resolveSecretPaths({ home: HOME, add: ['~'] })).toThrow(InvalidInput);
    expect(() => resolveSecretPaths({ home: HOME, add: ['/'] })).toThrow(InvalidInput);
    expect(() => resolveSecretPaths({ home: HOME, add: [' '] })).toThrow(InvalidInput);
    expect(() => resolveSecretPaths({ home: HOME, add: ['relative/dir'] })).toThrow(InvalidInput);
    expect(() => resolveSecretPaths({ home: 'relative' })).toThrow(InvalidInput);
    expect(() => resolveSecretPaths({ home: '/' })).toThrow(InvalidInput);
  });
});

describe('isSecretPath', () => {
  const list = resolveSecretPaths({ home: HOME, dataDir: DATA });

  it('is true for an entry and for anything inside it', () => {
    expect(isSecretPath('/home/someone/.ssh', list)).toBe(true);
    expect(isSecretPath('/home/someone/.ssh/id_ed25519', list)).toBe(true);
    expect(isSecretPath('/home/someone/.codex/sessions/one', list)).toBe(true);
    expect(isSecretPath(`${DATA}/profiles/claude-code/a/x`, list)).toBe(true);
  });

  it('is false for a neighbour with the same prefix', () => {
    expect(isSecretPath('/home/someone/.sshd', list)).toBe(false);
    expect(isSecretPath('/home/someone/.claude.json.bak', list)).toBe(false);
    expect(isSecretPath('/home/someone/project/readme.md', list)).toBe(false);
    expect(isSecretPath('/srv/otheater-data-old/x', list)).toBe(false);
  });

  it('matches the glob segments (the Flatpak profiles)', () => {
    expect(isSecretPath('/home/someone/.var/app/com.opera.Opera/config/Opera/Cookies', list)).toBe(
      true,
    );
    expect(isSecretPath('/home/someone/.var/app/com.opera.Opera/data/x', list)).toBe(false);
  });

  it('matches .env and .env.* in any folder, and only those', () => {
    expect(isSecretPath('/work/project/.env', list)).toBe(true);
    expect(isSecretPath('/work/project/.env.local', list)).toBe(true);
    expect(isSecretPath('/work/project/sub/.env.production', list)).toBe(true);
    expect(isSecretPath('/work/project/.envrc', list)).toBe(false);
    expect(isSecretPath('/work/project/env', list)).toBe(false);
    expect(isSecretPath('/work/project/.environment/x', list)).toBe(false);
  });

  it('resolves . and .. before comparing, so a traversal does not hide a secret', () => {
    expect(isSecretPath('/work/../home/someone/.ssh/key', list)).toBe(true);
    expect(isSecretPath('/home/someone/./.ssh//key', list)).toBe(true);
    expect(isSecretPath('/home/someone/project/../.aws/credentials', list)).toBe(true);
    expect(isSecretPath('/home/someone/.ssh/../project/x', list)).toBe(false);
    expect(isSecretPath('/../../home/someone/.ssh', list)).toBe(true);
  });

  it('a relative path matches only the bare names', () => {
    expect(isSecretPath('.env', list)).toBe(true);
    expect(isSecretPath('config/.env.test', list)).toBe(true);
    expect(isSecretPath('.ssh/id', list)).toBe(false);
    expect(isSecretPath('', list)).toBe(false);
  });

  it('does not treat regex characters in an entry as a pattern', () => {
    const custom = resolveSecretPaths({ home: HOME, add: ['/srv/a.b+c', '/srv/(x)'] });
    expect(isSecretPath('/srv/a.b+c/f', custom)).toBe(true);
    expect(isSecretPath('/srv/aXb+c/f', custom)).toBe(false);
    expect(isSecretPath('/srv/(x)/f', custom)).toBe(true);
    expect(isSecretPath('/srv/x/f', custom)).toBe(false);
  });
});
