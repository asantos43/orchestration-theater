// SPDX-License-Identifier: MPL-2.0
import { afterAll, describe, expect, it } from 'vitest';
import { FileOrigin } from './file-origin.js';
import { makeGuard, parseOpenUrl, type GuardRefusal, type GuardRules } from './guard.js';

const started: FileOrigin[] = [];
afterAll(async () => {
  await Promise.all(started.splice(0).map((origin) => origin.stop()));
});

async function origin(): Promise<FileOrigin> {
  const files = await FileOrigin.start();
  started.push(files);
  return files;
}

async function rules(
  over: Partial<GuardRules['config']> = {},
  networkAllow: string[] = [],
  files?: FileOrigin,
): Promise<GuardRules> {
  return {
    scenarioId: 's1',
    config: {
      domains: 'any',
      blocked_domains: [],
      local_urls: 'allow',
      file_urls: 'any',
      ...over,
    },
    networkAllow,
    files: files ?? (await origin()),
  };
}

describe('the guard of a scenario', () => {
  it('lets everything through by default (N40: no restrictions) but a scheme that is not http', async () => {
    const guard = makeGuard(await rules());
    expect(await guard({ url: 'https://example.com/', navigation: true })).toEqual({ allow: true });
    expect(await guard({ url: 'http://localhost:3000/', navigation: true })).toEqual({
      allow: true,
    });
    for (const url of [
      'file:///etc/hostname',
      'ftp://x/',
      'data:text/html,hi',
      'javascript:1',
      'nonsense',
    ]) {
      expect((await guard({ url, navigation: true })).allow).toBe(false);
    }
  });

  it('refuses a host of blocked_domains in every request, in the "any" mode too', async () => {
    const seen: GuardRefusal[] = [];
    const guard = makeGuard(await rules({ blocked_domains: ['*.evil.test', 'bad.test'] }), (r) => {
      seen.push(r);
    });
    expect((await guard({ url: 'https://a.evil.test/x.png', navigation: false })).allow).toBe(
      false,
    );
    expect((await guard({ url: 'http://bad.test/', navigation: true })).allow).toBe(false);
    expect((await guard({ url: 'http://good.test/', navigation: true })).allow).toBe(true);
    expect(seen.map((r) => r.code)).toEqual(['domain_blocked', 'domain_blocked']);
  });

  it('with local_urls "deny" refuses this machine and its network, with "allow" lets them through', async () => {
    const deny = makeGuard(await rules({ local_urls: 'deny' }));
    for (const url of [
      'http://localhost/',
      'http://127.0.0.1:8080/',
      'http://192.168.0.2/',
      'http://[::1]/',
    ]) {
      expect((await deny({ url, navigation: true })).allow).toBe(false);
    }
    expect((await deny({ url: 'https://example.com/', navigation: true })).allow).toBe(true);
    const allow = makeGuard(await rules({ local_urls: 'allow' }));
    expect((await allow({ url: 'http://localhost:1/', navigation: true })).allow).toBe(true);
  });

  it('with domains "allowlist" holds the NAVIGATIONS to the network.allow of the role', async () => {
    const guard = makeGuard(await rules({ domains: 'allowlist' }, ['example.com', '*.docs.test']));
    expect((await guard({ url: 'https://example.com/a', navigation: true })).allow).toBe(true);
    expect((await guard({ url: 'https://x.docs.test/', navigation: true })).allow).toBe(true);
    const out = await guard({ url: 'https://other.test/', navigation: true });
    expect(out).toMatchObject({ allow: false, code: 'domain_not_allowed' });
    // sub-resources are not held to the list ([proposta]): a page loads its own CDN
    expect((await guard({ url: 'https://cdn.other.test/a.png', navigation: false })).allow).toBe(
      true,
    );
  });

  it('with an empty role list the allowlist refuses even localhost; a listed localhost passes', async () => {
    const guard = makeGuard(await rules({ domains: 'allowlist' }, []));
    expect((await guard({ url: 'http://localhost:9/', navigation: true })).allow).toBe(false);
    const listed = makeGuard(await rules({ domains: 'allowlist' }, ['localhost']));
    expect((await listed({ url: 'http://localhost:9/', navigation: true })).allow).toBe(true);
  });

  it('does not let a throwing observer let a request through', async () => {
    const guard = makeGuard(await rules({ blocked_domains: ['bad.test'] }), () => {
      throw new Error('boom');
    });
    expect((await guard({ url: 'http://bad.test/', navigation: true })).allow).toBe(false);
  });

  it('judges the file origin of the scenario by its own rule, not by the domains', async () => {
    const files = await origin();
    files.grant('s1', { mode: 'any', roots: [] });
    const url = files.urlFor('s1', '/tmp/a.html');
    const open = makeGuard(
      await rules({ domains: 'allowlist', local_urls: 'deny', file_urls: 'any' }, [], files),
    );
    expect((await open({ url, navigation: true })).allow).toBe(true);
    const deny = makeGuard(await rules({ file_urls: 'deny' }, [], files));
    expect(await deny({ url, navigation: true })).toMatchObject({
      allow: false,
      code: 'file_urls_denied',
    });
    // another scenario's token is not a way in
    const other = makeGuard({ ...(await rules({}, [], files)), scenarioId: 's2' });
    expect(await other({ url, navigation: true })).toMatchObject({
      allow: false,
      code: 'file_origin_refused',
    });
  });
});

describe('parseOpenUrl', () => {
  it('takes http, https and file URLs and names the rest invalid', () => {
    expect(parseOpenUrl('https://example.com/a?b#c')).toEqual({
      kind: 'url',
      url: 'https://example.com/a?b#c',
    });
    expect(parseOpenUrl('file:///home/x/a%20b.html?q=1#h')).toEqual({
      kind: 'file',
      path: '/home/x/a b.html',
      suffix: '?q=1#h',
    });
    expect(parseOpenUrl('file://localhost/tmp/a.html')).toMatchObject({
      kind: 'file',
      path: '/tmp/a.html',
    });
    expect(parseOpenUrl('file://evil.test/tmp/a.html').kind).toBe('invalid');
    expect(parseOpenUrl('file:///C:/dir/a.html')).toMatchObject({
      kind: 'file',
      path: 'C:/dir/a.html',
    });
    expect(parseOpenUrl('relative/path').kind).toBe('invalid');
    expect(parseOpenUrl('ftp://x/').kind).toBe('invalid');
    expect(parseOpenUrl('javascript:alert(1)').kind).toBe('invalid');
  });
});
