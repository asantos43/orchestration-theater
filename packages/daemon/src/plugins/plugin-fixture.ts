// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the plugin steps only (excluded from the build of the package).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface FixtureManifest {
  readonly id?: string;
  readonly version?: string;
  /** `changed` adds a tool and a secret: another manifest, same id. */
  readonly variant?: 'base' | 'changed';
}

/** A valid `plugin.yaml` (P3 format). */
export function manifestText(options: FixtureManifest = {}): string {
  const { id = 'demo-db', version = '1.0.0', variant = 'base' } = options;
  const extraTool =
    variant === 'changed'
      ? `  - name: drop_table
    roles: [actor]
    effects: external_write
    requires_producer_approval: true
`
      : '';
  return `manifest_version: 1
id: ${id}
version: ${version}
description: A fixture plugin
server:
  type: stdio
  command: [node, server.js]
tools:
  - name: query_sql
    roles: [actor, critic]
    effects: read
${extraTool}secrets: [${variant === 'changed' ? 'PG_URL' : ''}]
events: [migration_applied]
`;
}

/** Writes `plugin.yaml` and a `server.js` in `dir`. */
export async function writePluginFolder(
  dir: string,
  options: FixtureManifest = {},
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.yaml'), manifestText(options));
  await writeFile(join(dir, 'server.js'), '// the fixture server never runs in these tests\n');
  return dir;
}

/**
 * An environment for `npm` and `git` that reads nothing of the user: home, caches and the three
 * npm configuration files are in `root`. `PATH` is kept to find the programs.
 */
export function isolatedEnv(
  root: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, 'npmrc-user'),
    npm_config_globalconfig: join(root, 'npmrc-global'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

export interface NpmFixture {
  readonly name: string;
  readonly version: string;
  readonly tarball: Buffer;
  /** `sha512-<base64>` of the tarball, as npm writes it in the lock file. */
  readonly integrity: string;
}

/**
 * Packs a folder with the real `npm pack` (no network, no script: `--ignore-scripts`) and reads
 * the tarball back. The package has a `postinstall` that writes `marker`, which the tests expect
 * NOT to exist after an install.
 */
export async function packNpmFixture(
  root: string,
  options: FixtureManifest & {
    readonly name: string;
    readonly marker: string;
    /** The version in `package.json`, when it should differ from the one in `plugin.yaml`. */
    readonly packageVersion?: string;
  },
): Promise<NpmFixture> {
  const { name, marker } = options;
  const manifestVersion = options.version ?? '1.0.0';
  const version = options.packageVersion ?? manifestVersion;
  const src = join(root, `pkg-${name}-${version}`);
  await writePluginFolder(src, { ...options, version: manifestVersion });
  // The scripts call a file of the package (no shell quoting): it writes the marker.
  await writeFile(
    join(src, 'mark.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv[2] ?? '');\n`,
  );
  await writeFile(
    join(src, 'package.json'),
    JSON.stringify({
      name,
      version,
      scripts: { preinstall: 'node mark.js pre', postinstall: 'node mark.js post' },
    }),
  );
  const dest = join(root, 'packed');
  await mkdir(dest, { recursive: true });
  const { stdout } = await run(
    'npm',
    ['pack', src, '--pack-destination', dest, '--ignore-scripts', '--silent'],
    {
      cwd: root,
      env: isolatedEnv(root),
    },
  );
  const file = stdout.trim().split('\n').pop() ?? '';
  const tarball = await readFile(join(dest, file));
  return {
    name,
    version,
    tarball,
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
  };
}

export interface FakeRegistry {
  readonly url: string;
  /** The paths asked for, to check that only the loopback registry was used. */
  readonly requests: readonly string[];
  close(): Promise<void>;
}

/** A tiny npm registry on a loopback port: the packument of each package and its tarball. */
export async function startFakeNpmRegistry(packages: readonly NpmFixture[]): Promise<FakeRegistry> {
  const requests: string[] = [];
  const fileOf = (pkg: NpmFixture): string =>
    `${pkg.name.split('/').pop() ?? pkg.name}-${pkg.version}.tgz`;
  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
    requests.push(path);
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const versions = packages.filter((pkg) => path === `/${pkg.name}`);
    const last = versions.at(-1);
    if (last !== undefined) {
      const body = {
        name: last.name,
        'dist-tags': { latest: last.version },
        versions: Object.fromEntries(
          versions.map((pkg) => [
            pkg.version,
            {
              name: pkg.name,
              version: pkg.version,
              // Like the real registry: npm only looks for lifecycle scripts of a registry package
              // when its metadata says it has some (the control test depends on it).
              hasInstallScript: true,
              dist: {
                tarball: `${base}/${pkg.name}/-/${fileOf(pkg)}`,
                integrity: pkg.integrity,
                shasum: createHash('sha1').update(pkg.tarball).digest('hex'),
              },
            },
          ]),
        ),
      };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
      return;
    }
    const tarball = packages.find((pkg) => path === `/${pkg.name}/-/${fileOf(pkg)}`);
    if (tarball !== undefined) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(tarball.tarball);
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface GitFixture {
  readonly dir: string;
  /** `file://` URL of the repository. */
  readonly url: string;
  readonly commit: string;
}

/** Runs git in the isolated environment (author set on the command line, no user configuration). */
export async function git(cwd: string, root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, env: isolatedEnv(root) },
  );
  return stdout.trim();
}

/**
 * A local repository with the plugin at its root. It also has hooks in `.git/hooks` (post-checkout
 * and post-commit) and a tracked `hooks/` folder that write `marker`: an install must not run them.
 */
export async function makeGitRepo(
  root: string,
  name: string,
  options: FixtureManifest & { readonly marker: string },
): Promise<GitFixture> {
  const dir = join(root, name);
  await writePluginFolder(dir, options);
  await git(root, root, ['init', '--quiet', '-b', 'main', dir]);
  const hook = `#!/bin/sh\necho hook > ${JSON.stringify(options.marker)}\n`;
  for (const hookName of ['post-checkout', 'post-merge', 'post-commit']) {
    const file = join(dir, '.git', 'hooks', hookName);
    await writeFile(file, hook);
    await chmod(file, 0o755);
  }
  await git(dir, root, ['add', '--', '.']);
  // The hook of post-commit is the one that would run here; the marker is cleared by the test.
  await git(dir, root, ['commit', '--quiet', '-m', 'fixture']);
  const commit = await git(dir, root, ['rev-parse', 'HEAD']);
  return { dir, url: pathToFileURL(dir).href, commit };
}

/** Commits the current files of the repository again and returns the new commit. */
export async function commitAll(repo: GitFixture, root: string, message: string): Promise<string> {
  await git(repo.dir, root, ['add', '--', '.']);
  await git(repo.dir, root, ['commit', '--quiet', '-m', message]);
  return await git(repo.dir, root, ['rev-parse', 'HEAD']);
}
