// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTALL_SH,
  callInstallerFunction,
  fakeExe,
  hostPlatform,
  runInstaller,
  sha256,
  startReleaseServer,
  type ReleaseServer,
  type RunResult,
} from './install-sh-fixture.js';
import { buildRelease, makeKeys, type ReleaseSpec, type TestKeys } from './release-fixture.js';

/**
 * `installer/install.sh` (Phase 10, P5): the real script, run by `sh` with a temporary HOME, against
 * a release server on the loopback with files signed by a key made in the test. The logon service is
 * off (`OT_INSTALL_SERVICE=off`) or the `ot` is a fake that only logs its calls, so nothing here
 * touches a real service: that part is `install-sh-real.test.ts`, on the CI.
 */

const PLATFORM = hostPlatform();
const OPENSSL = process.env.OT_TEST_OPENSSL ?? 'openssl';
const opensslHelp = spawnSync(OPENSSL, ['pkeyutl', '-help'], { encoding: 'utf8' });
const opensslEd25519 = [opensslHelp.stdout, opensslHelp.stderr].join('').includes('rawin');

describe.skipIf(PLATFORM === undefined)('install.sh', () => {
  let home: string;
  let server: ReleaseServer;
  let keys: TestKeys;
  let keyFile: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'otheater-install-sh-'));
    keys = makeKeys();
    keyFile = join(home, 'test-public-key.pem');
    await writeFile(keyFile, keys.publicPem);
    server = await startReleaseServer();
  });

  afterEach(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  });

  const exeName = (): string => `otheater-${PLATFORM ?? 'none'}`;
  const bin = (): string => join(home, '.local', 'share', 'otheater', 'bin');
  const installed = (): string => join(bin(), 'otheater');
  const link = (): string => join(home, '.local', 'bin', 'ot');
  const calls = async (): Promise<string> =>
    readFile(join(home, 'fake-ot-calls.log'), 'utf8').catch(() => '');
  const exists = async (path: string): Promise<boolean> =>
    lstat(path).then(
      () => true,
      () => false,
    );

  /** Publishes a release signed by `signer` and returns the exe that was served. */
  function publish(
    options: {
      readonly signer?: TestKeys;
      readonly exe?: Buffer;
      readonly served?: Buffer;
      readonly spec?: Partial<ReleaseSpec>;
    } = {},
  ): Buffer {
    const exe = options.exe ?? fakeExe();
    const release = buildRelease(options.signer ?? keys, {
      version: '1.2.3',
      platform: PLATFORM ?? 'none',
      name: exeName(),
      exe,
      ...options.spec,
    });
    server.files.set('manifest.json', release.manifestBytes);
    server.files.set('manifest.json.sig', release.signature);
    server.files.set(exeName(), options.served ?? exe);
    return exe;
  }

  function install(
    extra: Record<string, string | undefined> = {},
    args: readonly string[] = [],
  ): Promise<RunResult> {
    return runInstaller(
      args,
      {
        HOME: home,
        OT_INSTALL_BASE_URL: server.base,
        OT_INSTALL_SERVICE: 'off',
        OT_INSTALL_PUBLIC_KEY_FILE: keyFile,
        OT_INSTALL_OPENSSL: OPENSSL,
        ...extra,
      },
      {},
    );
  }

  /** Nothing of the install is left: no executable, no link, no staging folder. */
  async function expectNothingInstalled(): Promise<void> {
    expect(await exists(installed())).toBe(false);
    expect(await exists(link())).toBe(false);
    const left = await readdir(join(home, '.local', 'share', 'otheater')).catch(() => []);
    expect(left).toEqual([]);
  }

  describe.skipIf(!opensslEd25519)('with an openssl that checks Ed25519', () => {
    it('installs the executable, links ot and asks for the three files only', async () => {
      const exe = publish();
      const result = await install();
      expect(result.stderr).toContain(
        'WARNING: checking with the public key of OT_INSTALL_PUBLIC_KEY_FILE',
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Signature of the manifest checked (Ed25519).');
      expect(result.stdout).toContain(`SHA-256 checked: ${sha256(exe)}`);
      expect(result.stdout).toContain('Logon service: not registered (OT_INSTALL_SERVICE=off).');
      expect(await readFile(installed())).toEqual(exe);
      expect((await stat(installed())).mode & 0o111).not.toBe(0);
      expect(await readlink(link())).toBe(installed());
      // No staging folder is left, and the executable is the only file.
      expect(await readdir(bin())).toEqual(['otheater']);
      // The files, in order, and nothing else (no list of releases on a base given by the variable).
      expect(server.requests).toEqual([
        '/releases/manifest.json',
        '/releases/manifest.json.sig',
        `/releases/${exeName()}`,
      ]);
      // It writes nothing outside the HOME folder: the test would not see it, so the script is also
      // checked for the places it names (no /etc, no sudo).
      const text = await readFile(INSTALL_SH, 'utf8');
      expect(text).not.toMatch(/\bsudo\b\s+\S/);
    });

    it('says what is left: the PATH and the ACP adapters', async () => {
      publish();
      const result = await install({ PATH: process.env.PATH });
      expect(result.stdout).toContain('Done. What is left:');
      expect(result.stdout).toContain('is not in the PATH');
      expect(result.stdout).toContain(`export PATH="${join(home, '.local', 'bin')}:$PATH"`);
      expect(result.stdout).toContain('ACP adapter not found in the PATH: claude-agent-acp');
      expect(result.stdout).toContain(`stays in ${join(home, '.local', 'share', 'otheater')}`);
    });

    it('speaks Portuguese when the locale is pt', async () => {
      publish();
      const result = await install({ LANG: 'pt_BR.UTF-8' });
      expect(result.stdout).toContain('Assinatura do manifesto conferida (Ed25519).');
      expect(result.stdout).toContain('Pronto. O que falta:');
    });

    it('registers the service by running `ot service install`', async () => {
      publish();
      const result = await install({ OT_INSTALL_SERVICE: 'auto' });
      expect(result.code).toBe(0);
      expect(await calls()).toBe('service install\n');
    });

    it('exits 4 and says so when the service step fails, with the files in place', async () => {
      const failing = Buffer.from(
        `#!/bin/sh\ncase "$1" in\n  --version) echo "otheater 1.2.3" ;;\n  service) echo "no bus" >&2; exit 1 ;;\nesac\n`,
      );
      publish({ exe: failing });
      const result = await install({ OT_INSTALL_SERVICE: 'auto' });
      expect(result.code).toBe(4);
      expect(result.stderr).toContain('the logon service was not registered');
      expect(await exists(installed())).toBe(true);
    });

    it('refuses a signature made by another key, and downloads no executable', async () => {
      publish({ signer: makeKeys() });
      const result = await install();
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('REFUSED: the signature of the manifest does not check');
      expect(server.requests).not.toContain(`/releases/${exeName()}`);
      await expectNothingInstalled();
    });

    it('refuses a manifest that was changed after it was signed', async () => {
      publish();
      const manifest = server.files.get('manifest.json') as Buffer;
      server.files.set(
        'manifest.json',
        Buffer.from(manifest.toString('utf8').replace('1.2.3', '9.9.9')),
      );
      const result = await install();
      expect(result.code).toBe(3);
      await expectNothingInstalled();
    });

    it.each([
      ['an empty signature', ''],
      ['a signature that is not base64', 'not a signature at all!'],
      ['a signature of the wrong size', Buffer.alloc(32, 1).toString('base64')],
    ])('refuses %s', async (_label, signature) => {
      publish();
      server.files.set('manifest.json.sig', signature);
      const result = await install();
      expect(result.code).toBe(3);
      await expectNothingInstalled();
    });

    it('refuses an executable whose bytes are not the ones of the manifest', async () => {
      publish({ served: fakeExe('accept', 'b') });
      const result = await install();
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('does not match the manifest');
      await expectNothingInstalled();
    });

    it('refuses an executable of another size', async () => {
      const exe = publish({ spec: { size: fakeExe().length + 1 } });
      expect(exe.length).toBeGreaterThan(0);
      const result = await install();
      expect(result.code).toBe(3);
      await expectNothingInstalled();
    });

    it('refuses an executable bigger than the manifest says, without keeping it', async () => {
      publish({ served: Buffer.concat([fakeExe(), Buffer.alloc(4096, 0x20)]) });
      const result = await install();
      expect(result.code).toBe(3);
      await expectNothingInstalled();
    });

    it('refuses a manifest of another channel, signed and all', async () => {
      publish({ spec: { channel: 'beta' } });
      const result = await install();
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('is of the beta channel, and stable was asked');
      await expectNothingInstalled();
    });

    it('installs from a beta manifest when the beta channel is asked', async () => {
      publish({ spec: { channel: 'beta', version: '1.3.0-beta.1' } });
      const result = await install({ OT_INSTALL_CHANNEL: 'beta' });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('(version 1.3.0-beta.1)');
    });

    it('refuses a manifest with no executable for this platform', async () => {
      publish({ spec: { platform: 'plan9-x64' } });
      const result = await install();
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('lacks what the installer needs');
      await expectNothingInstalled();
    });

    it('refuses an executable that does not run here', async () => {
      publish({ exe: Buffer.from('#!/bin/sh\nexit 1\n') });
      const result = await install();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('does not run on this system');
      await expectNothingInstalled();
    });

    it('installs the notices of the platform when the signed manifest lists them', async () => {
      const exe = fakeExe();
      const notices = Buffer.from('# Third-party notices of this platform\n');
      const name = `THIRD_PARTY_NOTICES-${PLATFORM ?? 'none'}.md`;
      publish({
        exe,
        spec: {
          manifest: {
            assets: [
              {
                platform: PLATFORM ?? 'none',
                kind: 'exe',
                name: exeName(),
                size: exe.length,
                sha256: sha256(exe),
              },
              {
                platform: PLATFORM ?? 'none',
                kind: 'notices',
                name,
                size: notices.length,
                sha256: sha256(notices),
              },
            ],
          },
        },
      });
      server.files.set(name, notices);
      const result = await install();
      expect(result.code).toBe(0);
      expect(
        await readFile(join(home, '.local', 'share', 'otheater', 'THIRD_PARTY_NOTICES.md')),
      ).toEqual(notices);
      // A notices file that does not match its hash is refused like the executable.
      server.files.set(name, Buffer.from('changed'));
      await rm(join(home, '.local'), { recursive: true });
      const bad = await install();
      expect(bad.code).toBe(3);
      await expectNothingInstalled();
    });

    it('reinstalls over a previous install and asks its daemon to stop first', async () => {
      publish({ exe: fakeExe('accept', 'one') });
      expect((await install({ OT_INSTALL_SERVICE: 'auto' })).code).toBe(0);
      const second = publish({ exe: fakeExe('accept', 'two') });
      const result = await install({ OT_INSTALL_SERVICE: 'auto' });
      expect(result.code).toBe(0);
      expect(await readFile(installed())).toEqual(second);
      expect(await calls()).toBe('service install\nservice stop\nservice install\n');
      expect(result.stdout).toContain('a version was already installed');
    });

    it('does not replace an `ot` that is not its own, and warns', async () => {
      publish();
      await mkdir(join(home, '.local', 'bin'), { recursive: true });
      await writeFile(link(), 'another program\n');
      const result = await install();
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('already exists and is not from this installer');
      expect(await readFile(link(), 'utf8')).toBe('another program\n');
      expect(result.stdout).not.toContain('is not in the PATH');
    });
  });

  describe('when openssl cannot check Ed25519, the executable does it (N253)', () => {
    // A path that is not a program: the script has no openssl to use.
    const noOpenssl = { OT_INSTALL_OPENSSL: join(tmpdir(), 'there-is-no-openssl-here') };

    it('installs, with the warning, when the downloaded executable accepts the manifest', async () => {
      publish({ exe: fakeExe('accept') });
      const result = await install(noOpenssl, []);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        'The signature was checked by the downloaded executable itself',
      );
      expect(result.stdout).not.toContain('Signature of the manifest checked (Ed25519).');
      expect(await calls()).toContain('verify-release ok');
    });

    it('works with no key in the script and none in the environment (the placeholder)', async () => {
      publish({ exe: fakeExe('accept') });
      const result = await install({ ...noOpenssl, OT_INSTALL_PUBLIC_KEY_FILE: undefined });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('checked by the downloaded executable itself');
    });

    it('refuses when the executable rejects the manifest', async () => {
      publish({ exe: fakeExe('reject') });
      const result = await install(noOpenssl);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('the signature could not be checked');
      await expectNothingInstalled();
    });

    it('refuses when the executable has no verify-release mode (a build before P7 and P9)', async () => {
      publish({ exe: fakeExe('absent') });
      const result = await install(noOpenssl);
      expect(result.code).toBe(3);
      await expectNothingInstalled();
    });

    it('still checks the SHA-256 before it runs the executable', async () => {
      publish({ exe: fakeExe('accept'), served: fakeExe('accept', 'b') });
      const result = await install(noOpenssl);
      expect(result.code).toBe(3);
      expect(await calls()).not.toContain('verify-release ok');
      await expectNothingInstalled();
    });
  });

  describe('what it refuses before it asks for anything', () => {
    it.each([
      ['http://example.com/releases', 'plain http outside the loopback'],
      ['ftp://127.0.0.1/releases', 'another scheme'],
      ['https://user:secret@example.com/releases', 'a user and a password'],
      ['http://127.0.0.1@example.com/releases', 'a user that looks like the loopback'],
      ['file:///tmp/releases', 'a file'],
    ])('the address %s (%s)', async (base) => {
      const result = await install({ OT_INSTALL_BASE_URL: base });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('OT_INSTALL_BASE_URL=');
      expect(server.requests).toEqual([]);
      await expectNothingInstalled();
    });

    it('a channel that is not stable or beta', async () => {
      const result = await install({ OT_INSTALL_CHANNEL: 'nightly' });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('use stable or beta');
    });

    it('a service mode that is not auto or off', async () => {
      const result = await install({ OT_INSTALL_SERVICE: 'maybe' });
      expect(result.code).toBe(2);
    });

    it('an argument it does not know, and --purge-data without --uninstall', async () => {
      expect((await install({}, ['--frobnicate'])).code).toBe(2);
      const purge = await install({}, ['--purge-data']);
      expect(purge.code).toBe(2);
      expect(purge.stderr).toContain('--purge-data only works with --uninstall');
    });

    it('a HOME that is not an absolute folder', async () => {
      const result = await install({ HOME: 'relative/home' });
      expect(result.code).toBe(2);
    });

    it('answers 404 as a failure and leaves nothing behind', async () => {
      const result = await install();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('could not download manifest.json');
      await expectNothingInstalled();
    });
  });

  describe('--uninstall', () => {
    async function withData(): Promise<string> {
      const data = join(home, '.local', 'share', 'otheater');
      await writeFile(join(data, 'config.yaml'), 'ui:\n  locale: en\n');
      return data;
    }

    it('removes the executable, the link and the service, and keeps the data', async () => {
      publish();
      expect((await install({ OT_INSTALL_SERVICE: 'auto' })).code).toBe(0);
      const data = await withData();
      const result = await runInstaller(['--uninstall'], {
        HOME: home,
        OT_INSTALL_SERVICE: 'auto',
      });
      expect(result.code).toBe(0);
      expect(await calls()).toBe('service install\nuninstall\n');
      expect(await exists(installed())).toBe(false);
      expect(await exists(link())).toBe(false);
      expect(await readFile(join(data, 'config.yaml'), 'utf8')).toContain('locale: en');
      expect(result.stdout).toContain(`Uninstalled. The data was kept in ${data}.`);
      // No request to the server, which is down for it: nothing is downloaded to uninstall.
      expect(server.requests.length).toBe(3);
    });

    it('with the service off it does not call the executable', async () => {
      publish();
      await install({ OT_INSTALL_SERVICE: 'off' });
      const result = await runInstaller(['--uninstall'], { HOME: home, OT_INSTALL_SERVICE: 'off' });
      expect(result.code).toBe(0);
      expect(await calls()).toBe('');
      expect(await exists(installed())).toBe(false);
    });

    it('leaves an `ot` that is not its own', async () => {
      await mkdir(join(home, '.local', 'bin'), { recursive: true });
      await writeFile(link(), 'another program\n');
      const result = await runInstaller(['--uninstall'], { HOME: home, OT_INSTALL_SERVICE: 'off' });
      expect(result.code).toBe(0);
      expect(await readFile(link(), 'utf8')).toBe('another program\n');
    });

    it('says so when there is nothing to remove', async () => {
      const result = await runInstaller(['--uninstall'], { HOME: home, OT_INSTALL_SERVICE: 'off' });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('There is no install in');
    });

    it('--purge-data deletes the data folder after --yes, and the install with it', async () => {
      publish();
      await install();
      const data = await withData();
      const result = await runInstaller(['--uninstall', '--purge-data', '--yes'], {
        HOME: home,
        OT_INSTALL_SERVICE: 'off',
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Data deleted: ${data}`);
      expect(await exists(data)).toBe(false);
      expect(result.stdout).toContain('keyring are not touched');
    });

    it('--purge-data with no terminal and no --yes asks nothing and deletes nothing', async () => {
      publish();
      await install();
      const data = await withData();
      const result = await runInstaller(['--uninstall', '--purge-data'], {
        HOME: home,
        OT_INSTALL_SERVICE: 'off',
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('confirm with --yes');
      expect(await exists(join(data, 'config.yaml'))).toBe(true);
      expect(await exists(installed())).toBe(true);
    });

    it('--purge-data refuses a folder that is not a data folder', async () => {
      const other = join(home, 'precious');
      await mkdir(other);
      await writeFile(join(other, 'notes.txt'), 'mine\n');
      const result = await runInstaller(['--uninstall', '--purge-data', '--yes'], {
        HOME: home,
        OT_INSTALL_SERVICE: 'off',
        OT_DATA_DIR: other,
      });
      expect(result.stderr).toContain('does not look like an OTheater data folder');
      expect(await readFile(join(other, 'notes.txt'), 'utf8')).toBe('mine\n');
    });

    it('--purge-data never deletes the HOME folder, even when it looks like a data folder', async () => {
      await writeFile(join(home, 'config.yaml'), 'x: 1\n');
      const result = await runInstaller(['--uninstall', '--purge-data', '--yes'], {
        HOME: home,
        OT_INSTALL_SERVICE: 'off',
        OT_DATA_DIR: home,
      });
      expect(result.stderr).toContain('I did not delete it');
      expect(await exists(join(home, 'config.yaml'))).toBe(true);
    });
  });

  describe('the functions of the script', () => {
    const fn = (name: string, ...args: string[]): string =>
      callInstallerFunction(name, args).stdout.trim();

    it('detect_platform: the systems of v1 only (N255)', () => {
      expect(fn('detect_platform', 'Linux', 'x86_64')).toBe('linux-x64');
      expect(fn('detect_platform', 'Linux', 'amd64')).toBe('linux-x64');
      expect(fn('detect_platform', 'Darwin', 'arm64')).toBe('darwin-arm64');
      expect(fn('detect_platform', 'Darwin', 'x86_64')).toBe('');
      expect(fn('detect_platform', 'Linux', 'aarch64')).toBe('');
      expect(fn('detect_platform', 'FreeBSD', 'amd64')).toBe('');
    });

    it('check_base: https, or http on the loopback, and no user', () => {
      const ok = (base: string): number | null => callInstallerFunction('check_base', [base]).code;
      expect(ok('https://github.com/x/y/releases/latest/download')).toBe(0);
      expect(ok('http://127.0.0.1:8080/releases')).toBe(0);
      expect(ok('http://localhost:8080')).toBe(0);
      expect(ok('http://[::1]:8080/r')).toBe(0);
      expect(ok('http://example.com')).not.toBe(0);
      expect(ok('http://localhost.example.com')).not.toBe(0);
      expect(ok('https://a:b@example.com')).not.toBe(0);
      expect(ok('')).not.toBe(0);
    });

    const pretty = JSON.stringify(
      {
        schema: 1,
        version: '2.0.1',
        channel: 'stable',
        publishedAt: '2026-11-22T12:00:00Z',
        assets: [
          {
            platform: 'win32-x64',
            kind: 'msi',
            name: 'OTheater-2.0.1-win32-x64.msi',
            size: 10,
            sha256: 'a'.repeat(64),
          },
          {
            platform: 'linux-x64',
            kind: 'exe',
            name: 'otheater-linux-x64',
            size: 123456,
            sha256: 'b'.repeat(64),
          },
          {
            platform: 'darwin-arm64',
            kind: 'exe',
            name: 'otheater-darwin-arm64',
            size: 654321,
            sha256: 'c'.repeat(64),
          },
        ],
        schemas: { store: 3, telemetry: 2 },
        minVersion: '1.0.0',
      },
      null,
      2,
    );

    it('reads the manifest as P7 writes it (pretty JSON) and as one line', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'otheater-manifest-'));
      try {
        const files = { pretty, compact: JSON.stringify(JSON.parse(pretty)) };
        for (const [label, text] of Object.entries(files)) {
          const file = join(dir, `${label}.json`);
          await writeFile(file, `${text}\n`);
          expect(fn('manifest_top', 'version', file)).toBe('2.0.1');
          expect(fn('manifest_top', 'channel', file)).toBe('stable');
          expect(fn('find_asset', file, 'linux-x64', 'exe', '')).toBe(
            `otheater-linux-x64 123456 ${'b'.repeat(64)}`,
          );
          expect(fn('find_asset', file, 'darwin-arm64', 'exe', '')).toBe(
            `otheater-darwin-arm64 654321 ${'c'.repeat(64)}`,
          );
          // The .msi of Windows is not an executable of an update, and an unknown platform is nothing.
          expect(fn('find_asset', file, 'win32-x64', 'exe', '')).toBe('');
          expect(fn('find_asset', file, 'linux-arm64', 'exe', '')).toBe('');
          expect(fn('find_asset', file, '', '', 'OTheater-2.0.1-win32-x64.msi')).toContain(
            'OTheater-2.0.1',
          );
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('valid_asset: the patterns of the schema of P7', () => {
      const good = ['otheater-linux-x64', '123', 'd'.repeat(64), '1073741824'];
      const run = (...values: string[]): number | null =>
        callInstallerFunction('valid_asset', values).code;
      expect(run(...good)).toBe(0);
      expect(run('../etc/passwd', '123', 'd'.repeat(64), '1073741824')).not.toBe(0);
      expect(run('a b', '123', 'd'.repeat(64), '1073741824')).not.toBe(0);
      expect(run('otheater', '0', 'd'.repeat(64), '1073741824')).not.toBe(0);
      expect(run('otheater', '2000000000', 'd'.repeat(64), '1073741824')).not.toBe(0);
      expect(run('otheater', '12', 'D'.repeat(64), '1073741824')).not.toBe(0);
      expect(run('otheater', '12', 'd'.repeat(63), '1073741824')).not.toBe(0);
    });

    it('latest_prerelease_tag: the first prerelease that is not a draft', () => {
      const list = JSON.stringify([
        { url: 'x', tag_name: 'v2.0.0', draft: false, prerelease: false, body: 'a, "b": {c}' },
        {
          url: 'x',
          tag_name: 'v2.1.0-beta.2',
          draft: true,
          prerelease: true,
          assets: [{ name: 'x' }],
        },
        {
          url: 'x',
          tag_name: 'v2.1.0-beta.1',
          draft: false,
          prerelease: true,
          assets: [{ name: 'y', draft: false }],
        },
        { url: 'x', tag_name: 'v2.1.0-beta.0', draft: false, prerelease: true },
      ]);
      expect(
        callInstallerFunction('latest_prerelease_tag', [], { input: list }).stdout.trim(),
      ).toBe('v2.1.0-beta.1');
      expect(
        callInstallerFunction('latest_prerelease_tag', [], {
          input: JSON.stringify([{ tag_name: 'v1', draft: false, prerelease: false }]),
        }).stdout.trim(),
      ).toBe('');
    });

    it('may_purge: never the root, the HOME, a folder above it, or a folder with no marker', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'otheater-purge-'));
      try {
        const data = join(dir, 'data');
        await mkdir(data);
        await writeFile(join(data, 'store.sqlite'), '');
        const plain = join(dir, 'plain');
        await mkdir(plain);
        const may = (target: string, homeDir: string): number | null =>
          callInstallerFunction('may_purge', [target], { env: { HOME: homeDir } }).code;
        expect(may(data, join(dir, 'home'))).toBe(0);
        expect(may(`${data}/`, join(dir, 'home'))).toBe(0);
        expect(may(plain, join(dir, 'home'))).not.toBe(0);
        expect(may('/', join(dir, 'home'))).not.toBe(0);
        expect(may(data, data)).not.toBe(0);
        expect(may(dir, join(dir, 'data', 'inside'))).not.toBe(0);
        expect(may(`${data}/../plain`, join(dir, 'home'))).not.toBe(0);
        expect(may('relative/data', join(dir, 'home'))).not.toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('the script itself', () => {
    it('has no syntax error for a POSIX shell', () => {
      for (const shell of ['sh', 'bash']) {
        const flags = shell === 'bash' ? ['--posix', '-n'] : ['-n'];
        const result = spawnSync(shell, [...flags, INSTALL_SH], { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
      }
    });

    it('uses no bashism the POSIX shells lack', async () => {
      const text = (await readFile(INSTALL_SH, 'utf8'))
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'));
      const code = text.join('\n');
      expect(code).not.toMatch(
        /\[\[(?![:^])|^\s*local\s|\becho -e\b|<<<|(?<=[\s=(])\$'\\|<\(|^\s*source\s|\$\{\w+\/|^\s*function\s/m,
      );
    });

    it('passes shellcheck, when there is one', () => {
      const probe = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
      if (probe.error !== undefined || probe.status !== 0) return;
      const result = spawnSync('shellcheck', ['--shell=sh', INSTALL_SH], { encoding: 'utf8' });
      expect(result.stdout, result.stdout).toBe('');
      expect(result.status).toBe(0);
    });

    it('carries the placeholder where the release job puts the public key (P9)', async () => {
      const text = await readFile(INSTALL_SH, 'utf8');
      expect(text).toMatch(
        /# BEGIN embedded public key\n(?:#.*\n)+EMBEDDED_PUBLIC_KEY='PLACEHOLDER'\n# END embedded public key/,
      );
    });
  });
});
