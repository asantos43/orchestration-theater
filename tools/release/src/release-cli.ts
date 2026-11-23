// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadReleaseConfig, ReleaseConfigError } from './config.js';
import { embedPublicKeyInFile, InstallScriptError } from './install-script.js';
import {
  assembleFromDirectory,
  ManifestAssemblyError,
  RELEASE_CHANNELS,
  type AssembleOptions,
  type ReleaseChannel,
} from './manifest.js';
import { repoRoot } from './resolve.js';
import {
  checkProductionKey,
  generateEphemeralKey,
  signManifest,
  signManifestSshsig,
  SigningKeyError,
  SSHSIG_NAMESPACE,
} from './sign.js';
import { ReleaseVerifyError, verifyRelease } from './verify.js';

/**
 * The commands of the release job (Phase 10, P9) of `otheater-release`: `ephemeral-key`, `assemble`,
 * `sign`, `verify`, `check-key` and `embed-key`. Private keys come from a file or from an environment
 * variable, never from an argument (an argument is in the process list and in the log), and nothing
 * here prints one.
 */

export const RELEASE_USAGE = `  ephemeral-key --out <dir>
      Makes an Ed25519 pair for the rehearsal: ephemeral-private.pem (mode 0600) and ephemeral-public.pem.
  assemble --dir <dir> --version <x.y.z> --channel <stable|beta> [--out <file>] [--config <file>]
           [--schemas-from-build] [--min-version <x.y.z>] [--valid-days <n|none>]
      Writes manifest.json (default <dir>/manifest.json) from the files in <dir>: otheater-<platform>[.exe],
      THIRD_PARTY_NOTICES-<platform>.md and OTheater-<version>-win32-x64.msi. Every platform of the config
      needs its executable. --schemas-from-build reads the schema versions from the built daemon.
      --valid-days sets how long the manifest is valid ("expires"; default manifestValidityDays of the
      config, 365; "none" writes no expiry).
  sign --manifest <file> (--key-file <pem> | --key-env <NAME>) [--out <file>] [--sshsig-out <file>]
      Writes the Ed25519 signature (base64) of the exact bytes of the manifest (default <manifest>.sig)
      and the SSHSIG signature of the same bytes with the same key (default <manifest>.sshsig, namespace
      ${SSHSIG_NAMESPACE}), which \`ssh-keygen -Y verify\` reads (N288).
  verify --manifest <file> --public-key <pem> [--sig <file>] [--dir <dir>]
      Checks the signature and the manifest as the daemon does and, with --dir, every file it lists.
  check-key --key-env <NAME> --public-key <pem>
      The checks before a production signature: the secret exists, its public key is the one of the
      repository, and the file is not the PLACEHOLDER.
  embed-key --script <install.sh> --public-key <pem> --out <file> [--manifest <file>]
      Writes install.sh with the public key embedded (and its ssh-ed25519 line). With --manifest the
      SHA-256 of that manifest is pinned in the script too (the "pinned" verifier of N288).
`;

export const RELEASE_COMMANDS = [
  'ephemeral-key',
  'assemble',
  'sign',
  'verify',
  'check-key',
  'embed-key',
] as const;

type Log = (line: string) => void;

class UsageError extends Error {}

function need(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') throw new UsageError(`${flag} is required`);
  return value;
}

/** The schema versions of the store and telemetry bases of the built daemon (what the release needs). */
export async function readOwnSchemas(root: string): Promise<{ store: number; telemetry: number }> {
  const file = path.join(root, 'packages', 'daemon', 'dist', 'compose.js');
  const module = (await import(pathToFileURL(file).href)) as {
    composeOwnSchemas?: () => { store: number; telemetry: number };
  };
  if (module.composeOwnSchemas === undefined)
    throw new UsageError('compose.js has no composeOwnSchemas');
  const { store, telemetry } = module.composeOwnSchemas();
  return { store, telemetry };
}

function privateKeyFrom(values: {
  'key-file'?: string | undefined;
  'key-env'?: string | undefined;
}): Promise<string | undefined> | string | undefined {
  if (values['key-file'] !== undefined && values['key-env'] !== undefined) {
    throw new UsageError('give --key-file or --key-env, not both');
  }
  if (values['key-env'] !== undefined) return process.env[values['key-env']];
  if (values['key-file'] !== undefined) return readFile(values['key-file'], 'utf8');
  throw new UsageError('--key-file or --key-env is required');
}

/** Runs one of {@link RELEASE_COMMANDS}; returns the exit code. A usage error is `2`; a failed check is `1`. */
export async function runReleaseCommand(
  command: string,
  args: readonly string[],
  log: Log,
  root: string = repoRoot(),
): Promise<number> {
  try {
    return await run(command, args, log, root);
  } catch (error) {
    if (error instanceof UsageError) {
      log(`otheater-release ${command}: ${error.message}`);
      return 2;
    }
    // A release that is wrong or incomplete, a key that is not usable, a script without its markers:
    // the message says what, and the step fails without a stack trace.
    if (
      error instanceof ManifestAssemblyError ||
      error instanceof SigningKeyError ||
      error instanceof InstallScriptError ||
      error instanceof ReleaseConfigError
    ) {
      log(`otheater-release ${command}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function run(
  command: string,
  args: readonly string[],
  log: Log,
  root: string,
): Promise<number> {
  if (command === 'ephemeral-key') {
    const { values } = parseArgs({
      args: [...args],
      options: { out: { type: 'string' } },
      strict: true,
    });
    const out = path.resolve(need(values.out, '--out'));
    const pair = generateEphemeralKey();
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'ephemeral-private.pem'), pair.privatePem, { mode: 0o600 });
    await writeFile(path.join(out, 'ephemeral-public.pem'), pair.publicPem);
    log(`ephemeral key pair written to ${out} (the private half stays there)`);
    return 0;
  }
  if (command === 'assemble') {
    const { values } = parseArgs({
      args: [...args],
      options: {
        dir: { type: 'string' },
        version: { type: 'string' },
        channel: { type: 'string' },
        out: { type: 'string' },
        config: { type: 'string' },
        'schemas-from-build': { type: 'boolean' },
        'min-version': { type: 'string' },
        'valid-days': { type: 'string' },
      },
      strict: true,
    });
    const dir = path.resolve(need(values.dir, '--dir'));
    const channel = need(values.channel, '--channel');
    if (!(RELEASE_CHANNELS as readonly string[]).includes(channel)) {
      throw new UsageError(`--channel must be one of ${RELEASE_CHANNELS.join(', ')}`);
    }
    const config = loadReleaseConfig(
      values.config ?? path.join(root, 'tools', 'release', 'release.config.json'),
    );
    const schemas: AssembleOptions['schemas'] =
      values['schemas-from-build'] === true ? await readOwnSchemas(root) : undefined;
    const out = path.resolve(values.out ?? path.join(dir, 'manifest.json'));
    let validityDays: number | null = config.manifestValidityDays;
    if (values['valid-days'] !== undefined) {
      if (values['valid-days'] === 'none') {
        validityDays = null;
      } else if (/^[1-9][0-9]{0,3}$/u.test(values['valid-days'])) {
        validityDays = Number(values['valid-days']);
      } else {
        throw new UsageError('--valid-days must be a whole number of days or "none"');
      }
    }
    const { manifest } = await assembleFromDirectory({
      dir,
      out,
      version: need(values.version, '--version'),
      channel: channel as ReleaseChannel,
      requiredPlatforms: config.targets,
      schemas,
      minVersion: values['min-version'],
      validityDays,
    });
    log(
      `${out}: ${manifest.version} (${manifest.channel}), ${String(manifest.assets.length)} assets, ${manifest.expires === undefined ? 'no expiry' : `expires ${manifest.expires}`}`,
    );
    for (const asset of manifest.assets)
      log(`  ${asset.platform} ${asset.kind} ${asset.name} ${String(asset.size)} bytes`);
    return 0;
  }
  if (command === 'sign') {
    const { values } = parseArgs({
      args: [...args],
      options: {
        manifest: { type: 'string' },
        'key-file': { type: 'string' },
        'key-env': { type: 'string' },
        out: { type: 'string' },
        'sshsig-out': { type: 'string' },
      },
      strict: true,
    });
    const manifest = path.resolve(need(values.manifest, '--manifest'));
    const privatePem = await privateKeyFrom(values);
    if (privatePem === undefined || privatePem.trim() === '')
      throw new UsageError('the signing key is empty or missing');
    const out = path.resolve(values.out ?? `${manifest}.sig`);
    const sshsigOut = path.resolve(values['sshsig-out'] ?? `${manifest}.sshsig`);
    const bytes = await readFile(manifest);
    await writeFile(out, signManifest(bytes, privatePem));
    await writeFile(sshsigOut, signManifestSshsig(bytes, privatePem));
    log(`signed ${manifest} -> ${out} and ${sshsigOut}`);
    return 0;
  }
  if (command === 'verify') {
    const { values } = parseArgs({
      args: [...args],
      options: {
        manifest: { type: 'string' },
        sig: { type: 'string' },
        'public-key': { type: 'string' },
        dir: { type: 'string' },
      },
      strict: true,
    });
    const manifest = path.resolve(need(values.manifest, '--manifest'));
    try {
      const checked = await verifyRelease({
        manifestBytes: await readFile(manifest),
        signature: await readFile(path.resolve(values.sig ?? `${manifest}.sig`), 'utf8'),
        publicPem: await readFile(path.resolve(need(values['public-key'], '--public-key')), 'utf8'),
        assetsDir: values.dir === undefined ? undefined : path.resolve(values.dir),
      });
      log(
        `verified: ${checked.version} (${checked.channel}), ${String(checked.assets.length)} assets`,
      );
      return 0;
    } catch (error) {
      if (error instanceof ReleaseVerifyError) {
        log(`REFUSED: ${error.message}`);
        return 1;
      }
      throw error;
    }
  }
  if (command === 'check-key') {
    const { values } = parseArgs({
      args: [...args],
      options: { 'key-env': { type: 'string' }, 'public-key': { type: 'string' } },
      strict: true,
    });
    const envName = need(values['key-env'], '--key-env');
    const publicFile = path.resolve(need(values['public-key'], '--public-key'));
    const publicPem = await readFile(publicFile, 'utf8').catch(() => undefined);
    const result = checkProductionKey({ privatePem: process.env[envName], publicPem });
    if (result.ok) {
      log('production key: the secret exists and matches the public key of the repository');
      return 0;
    }
    log(`production key refused (${result.reason}): ${result.message}`);
    return 1;
  }
  if (command === 'embed-key') {
    const { values } = parseArgs({
      args: [...args],
      options: {
        script: { type: 'string' },
        'public-key': { type: 'string' },
        out: { type: 'string' },
        manifest: { type: 'string' },
      },
      strict: true,
    });
    const out = path.resolve(need(values.out, '--out'));
    await embedPublicKeyInFile({
      script: path.resolve(need(values.script, '--script')),
      publicKeyFile: path.resolve(need(values['public-key'], '--public-key')),
      manifestFile: values.manifest === undefined ? undefined : path.resolve(values.manifest),
      out,
    });
    log(
      `public key embedded in ${out}${values.manifest === undefined ? '' : ' (manifest hash pinned)'}`,
    );
    return 0;
  }
  throw new UsageError(`unknown command ${command}`);
}
