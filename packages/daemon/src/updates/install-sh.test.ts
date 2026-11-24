// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  lstat,
  symlink,
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
import { delimiter, join } from 'node:path';
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
// `ssh-keygen -Y verify` exists from OpenSSH 8.0; an older one answers that the option is invalid.
const sshProbe = spawnSync('ssh-keygen', ['-Y', 'verify'], { encoding: 'utf8', input: '' });
const sshKeygenVerify =
  sshProbe.error === undefined &&
  !/invalid option|illegal option|unknown option/iu.test(`${sshProbe.stdout}${sshProbe.stderr}`);
const wget = spawnSync('wget', ['--version'], { encoding: 'utf8' });
const hasWget = wget.error === undefined && wget.status === 0;

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
  // Where the daemon keeps its data: the app folder on Linux, `Library/Application Support/OTheater`
  // on macOS (the script follows paths.ts).
  const dataDir = (): string =>
    PLATFORM === 'darwin-arm64'
      ? join(home, 'Library', 'Application Support', 'OTheater')
      : join(home, '.local', 'share', 'otheater');
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
    server.files.set('manifest.json.sshsig', release.sshsig);
    server.files.set(exeName(), options.served ?? exe);
    return exe;
  }

  /** A copy of install.sh with a key and/or a pinned manifest hash in it, as the release job makes it. */
  async function scriptWith(embedded: {
    readonly keys?: TestKeys;
    readonly pinned?: Buffer | string;
  }): Promise<string> {
    let text = await readFile(INSTALL_SH, 'utf8');
    if (embedded.keys !== undefined) {
      text = text
        .replace(
          "EMBEDDED_PUBLIC_KEY='PLACEHOLDER'",
          () => `EMBEDDED_PUBLIC_KEY='${embedded.keys?.publicPem.trim() ?? ''}'`,
        )
        .replace(
          "EMBEDDED_SSH_KEY='PLACEHOLDER'",
          () => `EMBEDDED_SSH_KEY='${embedded.keys?.sshLine ?? ''}'`,
        );
    }
    if (embedded.pinned !== undefined) {
      const hash = typeof embedded.pinned === 'string' ? embedded.pinned : sha256(embedded.pinned);
      text = text.replace(
        "EMBEDDED_MANIFEST_SHA256=''",
        () => `EMBEDDED_MANIFEST_SHA256='${hash}'`,
      );
    }
    const file = join(home, 'install-with-embedded.sh');
    await writeFile(file, text);
    return file;
  }

  /** Never ran: the executable that was served did not run (even for `--version`). */
  const exeNeverRan = async (): Promise<boolean> => !(await exists(join(home, 'fake-ot-runs.log')));

  function install(
    extra: Record<string, string | undefined> = {},
    args: readonly string[] = [],
    script?: string,
  ): Promise<RunResult> {
    return runInstaller(
      args,
      {
        HOME: home,
        OT_INSTALL_BASE_URL: server.base,
        OT_INSTALL_SERVICE: 'off',
        OT_INSTALL_PUBLIC_KEY_FILE: keyFile,
        OT_INSTALL_OPENSSL: OPENSSL,
        OT_INSTALL_ALLOW_KEY_OVERRIDE: '1',
        ...extra,
      },
      script === undefined ? {} : { script },
    );
  }

  /** The environment of an install that carries its own keys (no override): the script is a copy with them. */
  const NO_OVERRIDE = {
    OT_INSTALL_PUBLIC_KEY_FILE: undefined,
    OT_INSTALL_OPENSSL: undefined,
    OT_INSTALL_ALLOW_KEY_OVERRIDE: undefined,
  } as const;

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
      expect(result.stdout).toContain('Signature of the manifest checked (openssl).');
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
      expect(result.stdout).toContain(`stays in ${dataDir()}`);
    });

    it('speaks Portuguese when the locale is pt', async () => {
      publish();
      const result = await install({ LANG: 'pt_BR.UTF-8' });
      expect(result.stdout).toContain('Assinatura do manifesto conferida (openssl).');
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
      expect(await exeNeverRan()).toBe(true);
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
      publish({ served: fakeExe('b') });
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
      publish({ exe: fakeExe('one') });
      expect((await install({ OT_INSTALL_SERVICE: 'auto' })).code).toBe(0);
      const second = publish({ exe: fakeExe('two') });
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

  describe.skipIf(!sshKeygenVerify)('with ssh-keygen -Y verify (the SSHSIG of N288)', () => {
    let sshKeyFile: string;
    const bySsh = (): Record<string, string | undefined> => ({
      OT_INSTALL_VERIFIER: 'ssh-keygen',
      OT_INSTALL_PUBLIC_KEY_FILE: sshKeyFile,
    });

    beforeEach(async () => {
      sshKeyFile = join(home, 'test-ssh-key.pub');
      await writeFile(sshKeyFile, `${keys.sshLine} a comment that is dropped\n`);
    });

    it('installs, and asks for the manifest, its SSHSIG and the executable only', async () => {
      publish();
      const result = await install(bySsh());
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('Signature of the manifest checked (ssh-keygen).');
      expect(server.requests).toEqual([
        '/releases/manifest.json',
        '/releases/manifest.json.sshsig',
        `/releases/${exeName()}`,
      ]);
      expect(await exists(installed())).toBe(true);
    });

    it('refuses a signature made by another key, and downloads no executable', async () => {
      publish({ signer: makeKeys() });
      const result = await install(bySsh());
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('does not check (ssh-keygen)');
      expect(server.requests).not.toContain(`/releases/${exeName()}`);
      expect(await exeNeverRan()).toBe(true);
      await expectNothingInstalled();
    });

    it('refuses a manifest that was changed after it was signed', async () => {
      publish();
      const manifest = server.files.get('manifest.json') as Buffer;
      server.files.set(
        'manifest.json',
        Buffer.from(manifest.toString('utf8').replace('1.2.3', '9.9.9')),
      );
      const result = await install(bySsh());
      expect(result.code).toBe(3);
      expect(await exeNeverRan()).toBe(true);
      await expectNothingInstalled();
    });

    it('refuses a signature made for another namespace', async () => {
      publish();
      const manifest = server.files.get('manifest.json') as Buffer;
      server.files.set('manifest.json.sshsig', keys.sshsig(manifest, 'something-else'));
      const result = await install(bySsh());
      expect(result.code).toBe(3);
      await expectNothingInstalled();
    });

    it.each([
      ['an empty file', ''],
      ['text that is not an SSHSIG', 'hello'],
    ])('refuses %s as the signature', async (_label, text) => {
      publish();
      server.files.set('manifest.json.sshsig', text);
      const result = await install(bySsh());
      expect(result.code).toBe(3);
      await expectNothingInstalled();
    });

    it('cannot be used without the .sshsig: nothing is installed, and it says why', async () => {
      publish();
      server.files.delete('manifest.json.sshsig');
      const result = await install(bySsh());
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('could not download manifest.json.sshsig');
      expect(result.stderr).toContain('no verifier could check the manifest');
      expect(await exeNeverRan()).toBe(true);
      await expectNothingInstalled();
    });

    it('is what auto uses when this openssl cannot check Ed25519, with the keys of the script', async () => {
      publish();
      const script = await scriptWith({ keys });
      const result = await install(
        { ...NO_OVERRIDE, OT_INSTALL_OPENSSL: join(tmpdir(), 'there-is-no-openssl-here') },
        [],
        script,
      );
      // An OT_INSTALL_OPENSSL needs the second variable, so this one runs with it.
      expect(result.code).toBe(2);
      const allowed = await install(
        {
          ...NO_OVERRIDE,
          OT_INSTALL_OPENSSL: join(tmpdir(), 'there-is-no-openssl-here'),
          OT_INSTALL_ALLOW_KEY_OVERRIDE: '1',
        },
        [],
        script,
      );
      expect(allowed.code, allowed.stderr).toBe(0);
      expect(allowed.stdout).toContain('Signature of the manifest checked (ssh-keygen).');
      expect(allowed.stderr).toContain('WARNING: checking with the openssl of OT_INSTALL_OPENSSL');
      expect(await calls()).not.toContain('verify-release');
    });
  });

  describe('the pinned hash of the manifest (N288)', () => {
    const noOpenssl = {
      ...NO_OVERRIDE,
      OT_INSTALL_OPENSSL: join(tmpdir(), 'there-is-no-openssl-here'),
      OT_INSTALL_ALLOW_KEY_OVERRIDE: '1',
      OT_INSTALL_VERIFIER: 'pinned',
    };

    it('installs when the manifest is the one the script pins, and asks for no signature file', async () => {
      publish();
      const script = await scriptWith({ pinned: server.files.get('manifest.json') as Buffer });
      const result = await install(noOpenssl, [], script);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('Manifest checked by the SHA-256 pinned in this script.');
      expect(server.requests).toEqual(['/releases/manifest.json', `/releases/${exeName()}`]);
    });

    it('refuses a manifest that is not the pinned one, even a signed one', async () => {
      publish();
      const script = await scriptWith({ pinned: 'a'.repeat(64) });
      const result = await install(noOpenssl, [], script);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('not the one this script pinned');
      expect(await exeNeverRan()).toBe(true);
      await expectNothingInstalled();
    });

    it('is not available when the script pins nothing', async () => {
      publish();
      const result = await install(noOpenssl);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('no verifier could check the manifest');
      await expectNothingInstalled();
    });

    it('is the last of auto: with no openssl and no ssh-keygen key, it decides', async () => {
      publish();
      const script = await scriptWith({ pinned: server.files.get('manifest.json') as Buffer });
      const result = await install({ ...noOpenssl, OT_INSTALL_VERIFIER: 'auto' }, [], script);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('Manifest checked by the SHA-256 pinned in this script.');
    });
  });

  describe('when nothing can check the manifest (N288)', () => {
    it('refuses with exit 3, runs nothing it downloaded and installs nothing', async () => {
      publish();
      // The script of the repository carries no key and pins nothing; the openssl is not there.
      const result = await install({
        ...NO_OVERRIDE,
        OT_INSTALL_OPENSSL: join(tmpdir(), 'there-is-no-openssl-here'),
        OT_INSTALL_ALLOW_KEY_OVERRIDE: '1',
      });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('REFUSED: no verifier could check the manifest');
      expect(server.requests).not.toContain(`/releases/${exeName()}`);
      expect(await exeNeverRan()).toBe(true);
      expect(await calls()).toBe('');
      await expectNothingInstalled();
    });

    it('does not take a signature the executable would say it accepts (the old N253 path is gone)', async () => {
      const text = await readFile(INSTALL_SH, 'utf8');
      expect(text).not.toContain('verify-release');
    });

    it('says it in Portuguese when the locale is pt', async () => {
      publish();
      const result = await install({
        ...NO_OVERRIDE,
        OT_INSTALL_OPENSSL: join(tmpdir(), 'there-is-no-openssl-here'),
        OT_INSTALL_ALLOW_KEY_OVERRIDE: '1',
        LANG: 'pt_BR.UTF-8',
      });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain(
        'RECUSADO: nenhum verificador conseguiu conferir o manifesto',
      );
    });
  });

  describe('the key and the openssl of the environment (N288)', () => {
    it('are refused without OT_INSTALL_ALLOW_KEY_OVERRIDE=1, before any download', async () => {
      publish();
      const result = await install({ OT_INSTALL_ALLOW_KEY_OVERRIDE: undefined });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('OT_INSTALL_ALLOW_KEY_OVERRIDE=1');
      expect(server.requests).toEqual([]);
      await expectNothingInstalled();
      const onlyOpenssl = await install({
        OT_INSTALL_PUBLIC_KEY_FILE: undefined,
        OT_INSTALL_ALLOW_KEY_OVERRIDE: undefined,
      });
      expect(onlyOpenssl.code).toBe(2);
    });

    it('warn when they are used', async () => {
      publish();
      const result = await install({ OT_INSTALL_VERIFIER: 'pinned' });
      expect(result.stderr).toContain(
        'WARNING: checking with the public key of OT_INSTALL_PUBLIC_KEY_FILE',
      );
      expect(result.stderr).toContain('WARNING: checking with the openssl of OT_INSTALL_OPENSSL');
    });

    it('do not matter to the uninstall', async () => {
      const result = await install({ OT_INSTALL_ALLOW_KEY_OVERRIDE: undefined }, ['--uninstall']);
      expect(result.code).toBe(0);
    });

    it('OT_INSTALL_VERIFIER takes auto, openssl, ssh-keygen or pinned only', async () => {
      const result = await install({ OT_INSTALL_VERIFIER: 'gpg' });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        'OT_INSTALL_VERIFIER=gpg: use auto, openssl, ssh-keygen or pinned',
      );
    });

    it.skipIf(!opensslEd25519)('a named verifier uses only that one', async () => {
      publish();
      // openssl would accept this, but ssh-keygen was asked for and the key is a PEM it cannot use.
      const result = await install({ OT_INSTALL_VERIFIER: 'ssh-keygen' });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('no verifier could check the manifest');
    });
  });

  describe.skipIf(!opensslEd25519)('the validity of the manifest (N288)', () => {
    const NOW = Date.now();
    const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

    it('refuses a manifest that has expired, signed and all, and runs nothing', async () => {
      publish({ spec: { expires: iso(-60_000) } });
      const result = await install();
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('REFUSED: the manifest expired on');
      expect(server.requests).not.toContain(`/releases/${exeName()}`);
      expect(await exeNeverRan()).toBe(true);
      await expectNothingInstalled();
    });

    it('installs a manifest that has not expired, with no warning about it', async () => {
      publish({ spec: { expires: iso(86_400_000) } });
      const result = await install();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('validity limit');
    });

    it('accepts a manifest with no expires (an old release) and warns', async () => {
      publish();
      const result = await install();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('WARNING: the manifest has no validity limit (expires)');
    });

    it('accepts a time with a fraction, and refuses one that is not in UTC or is not a time', async () => {
      publish({ spec: { expires: '2999-01-01T00:00:00.123Z' } });
      expect((await install()).code).toBe(0);
      await rm(join(home, '.local'), { recursive: true });
      publish({ spec: { expires: '2999-01-01T00:00:00+02:00' } });
      const offset = await install();
      expect(offset.code).toBe(3);
      expect(offset.stderr).toContain('lacks what the installer needs (expires)');
      publish({ spec: { expires: 'tomorrow' } });
      expect((await install()).code).toBe(3);
    });
  });

  describe.skipIf(!opensslEd25519 || !hasWget)('with wget and no curl', () => {
    // A PATH with the tools the script uses and no curl, so it takes the wget branch.
    let toolDir: string;
    beforeEach(async () => {
      toolDir = join(home, 'tools');
      await mkdir(toolDir);
      const names = [
        'sh',
        'wget',
        'openssl',
        'ssh-keygen',
        'tr',
        'sed',
        'awk',
        'grep',
        'head',
        'wc',
        'cat',
        'date',
        'printf',
        'mktemp',
        'mkdir',
        'chmod',
        'rm',
        'rmdir',
        'mv',
        'ln',
        'readlink',
        'uname',
        'id',
        'sha256sum',
        'shasum',
        'dirname',
        'basename',
        'env',
        'cut',
        'sort',
        'expr',
        'echo',
        'true',
        'false',
        'test',
        'tail',
        'tee',
      ];
      for (const name of names) {
        for (const dir of (process.env.PATH ?? '').split(delimiter)) {
          // access(X_OK) instead of spawning `test -x` once per PATH entry: on a slow
          // macOS runner with a long PATH the spawns alone passed the 10 s hook timeout.
          const found = await access(join(dir, name), fsConstants.X_OK).then(
            () => true,
            () => false,
          );
          if (found) {
            await symlink(join(dir, name), join(toolDir, name));
            break;
          }
        }
      }
    });

    it('installs through wget, and refuses an executable bigger than the manifest says', async () => {
      publish();
      const result = await install({ PATH: toolDir });
      expect(result.code, result.stderr).toBe(0);
      expect(await exists(installed())).toBe(true);
      await rm(join(home, '.local'), { recursive: true });
      publish({ served: Buffer.concat([fakeExe(), Buffer.alloc(4096, 0x20)]) });
      const big = await install({ PATH: toolDir });
      expect(big.code).toBe(3);
      expect(big.stderr).toContain('is bigger than allowed');
      await expectNothingInstalled();
    });

    it('does not read a wgetrc', async () => {
      publish();
      // A wgetrc that points the downloads at a closed port: if it were read, the install would fail.
      await writeFile(
        join(home, '.wgetrc'),
        'http_proxy = http://127.0.0.1:9/\\nuse_proxy = on\\n',
      );
      const result = await install({ PATH: toolDir });
      expect(result.code, result.stderr).toBe(0);
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
      const data = dataDir();
      await mkdir(data, { recursive: true });
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

    /** What the applier leaves beside the executable after an update (layout.ts, journal.ts, trust.ts, main.ts). */
    async function leaveUpdateFiles(): Promise<string[]> {
      await mkdir(join(bin(), 'previous'), { recursive: true });
      await mkdir(join(bin(), 'staging'), { recursive: true });
      const files = [
        'update-state.json',
        'update-state.json.4242.tmp',
        'update-apply.log',
        join('previous', 'otheater'),
        join('staging', 'otheater'),
        join('staging', 'manifest.json'),
        join('staging', 'manifest.json.sig'),
      ].map((name) => join(bin(), name));
      for (const file of files) await writeFile(file, 'left by an update\n');
      return files;
    }

    it('removes what the updates left in bin/, and the folders that get empty (N303)', async () => {
      await mkdir(bin(), { recursive: true });
      await writeFile(installed(), '#!/bin/sh\n', { mode: 0o755 });
      const left = await leaveUpdateFiles();
      const data = await withData();
      await writeFile(join(data, 'store.sqlite'), 'data\n');
      const result = await runInstaller(['--uninstall'], { HOME: home, OT_INSTALL_SERVICE: 'off' });
      expect(result.code).toBe(0);
      for (const file of [installed(), ...left]) expect(await exists(file)).toBe(false);
      expect(await exists(bin())).toBe(false);
      expect(result.stdout).toContain(`Removed: ${join(bin(), 'update-apply.log')}`);
      expect(result.stderr).not.toContain('WARNING');
      // The data stays, and so does the folder that holds it (on Linux the app folder is the data folder).
      expect(await readFile(join(data, 'config.yaml'), 'utf8')).toContain('locale: en');
      expect(await readFile(join(data, 'store.sqlite'), 'utf8')).toBe('data\n');
    });

    it('keeps a file that is not its own in bin/, and the folder with it, and says so', async () => {
      await mkdir(bin(), { recursive: true });
      await writeFile(installed(), '#!/bin/sh\n', { mode: 0o755 });
      const left = await leaveUpdateFiles();
      await writeFile(join(bin(), 'my-notes.txt'), 'mine\n');
      await writeFile(join(bin(), 'previous', 'extra.bin'), 'mine too\n');
      await writeFile(join(bin(), 'update-state.json.abc.tmp'), 'not a pid\n');
      const result = await runInstaller(['--uninstall'], { HOME: home, OT_INSTALL_SERVICE: 'off' });
      expect(result.code).toBe(0);
      for (const file of [installed(), ...left]) expect(await exists(file)).toBe(false);
      expect(await readFile(join(bin(), 'my-notes.txt'), 'utf8')).toBe('mine\n');
      expect(await readFile(join(bin(), 'previous', 'extra.bin'), 'utf8')).toBe('mine too\n');
      expect(await exists(join(bin(), 'update-state.json.abc.tmp'))).toBe(true);
      expect(await exists(join(bin(), 'staging'))).toBe(false);
      expect(result.stderr).toContain('is not the OTheater');
      expect(result.stderr).toContain('my-notes.txt');
    });

    it('says the same in Portuguese when the language is Portuguese', async () => {
      await mkdir(bin(), { recursive: true });
      await writeFile(join(bin(), 'my-notes.txt'), 'mine\n');
      const result = await runInstaller(['--uninstall'], {
        HOME: home,
        OT_INSTALL_SERVICE: 'off',
        LANG: 'pt_BR.UTF-8',
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('não é do OTheater');
      expect(await exists(join(bin(), 'my-notes.txt'))).toBe(true);
    });

    it('does not follow a previous/ or staging/ that is a link', async () => {
      await mkdir(bin(), { recursive: true });
      const outside = join(home, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'otheater'), 'not ours\n');
      await writeFile(join(outside, 'manifest.json'), 'not ours\n');
      await symlink(outside, join(bin(), 'previous'));
      await symlink(outside, join(bin(), 'staging'));
      const result = await runInstaller(['--uninstall'], { HOME: home, OT_INSTALL_SERVICE: 'off' });
      expect(result.code).toBe(0);
      expect(await readFile(join(outside, 'otheater'), 'utf8')).toBe('not ours\n');
      expect(await readFile(join(outside, 'manifest.json'), 'utf8')).toBe('not ours\n');
    });

    it('--purge-data still deletes everything, the leftovers of the updates with it', async () => {
      await mkdir(bin(), { recursive: true });
      await writeFile(installed(), '#!/bin/sh\n', { mode: 0o755 });
      await leaveUpdateFiles();
      const data = await withData();
      const result = await runInstaller(['--uninstall', '--purge-data', '--yes'], {
        HOME: home,
        OT_INSTALL_SERVICE: 'off',
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Data deleted: ${data}`);
      expect(await exists(data)).toBe(false);
      expect(await exists(bin())).toBe(false);
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
        /# BEGIN embedded public key\n(?:#.*\n)+EMBEDDED_PUBLIC_KEY='PLACEHOLDER'\nEMBEDDED_SSH_KEY='PLACEHOLDER'\n# END embedded public key/,
      );
      expect(text).toMatch(
        /# BEGIN embedded manifest hash\n(?:#.*\n)+EMBEDDED_MANIFEST_SHA256=''\n# END embedded manifest hash/,
      );
    });
  });
});
