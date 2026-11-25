#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runAcceptance } from './acceptance.js';
import {
  BUSY_MODES,
  BUSY_RESUME_FORMS,
  runBusyAcceptance,
  type BusyMode,
  type BusyResumeForm,
} from './acceptance-busy.js';
import { buildTarget } from './build.js';
import { loadReleaseConfig, parseReleaseConfig, ReleaseConfigError } from './config.js';
import {
  RELEASE_COMMANDS,
  RELEASE_USAGE,
  readOwnSchemas,
  runReleaseCommand,
} from './release-cli.js';
import { repoRoot } from './resolve.js';
import { runSmoke } from './smoke.js';
import { hostTarget, isTargetId, TARGET_IDS, type TargetId } from './targets.js';

const USAGE = `Usage: otheater-release <command> [options]

Commands:
  build [--target <id>] [--out <dir>] [--config <file>] [--node <binary>] [--minify] [--version <x.y.z>]
      [--public-key <file>]
      Builds the single executable (Node SEA) of the platform this machine is. --target names it
      (${TARGET_IDS.join(', ')}); a target other than the host's is refused. Without --target, the first
      target of the config that is the host's. --node is the Node binary to inject into (default:
      $OT_SEA_NODE, else the running one; it has to be a standalone build). --version bakes that
      version into the executable instead of the one of the package (the release sets it).
      --public-key is the file of the update public key to embed (default
      tools/release/keys/update-public-key.pem); a missing or invalid file stops the build.
  smoke <executable> [--version <x.y.z>]
      Runs the executable as the acceptance of the build does: --version, the daemon in a temporary
      folder and its API, the TUI without a terminal, the MCP shim and the modes not yet available.
  acceptance --exe-n <file> --version-n <x.y.z> --exe-n1 <file> --version-n1 <x.y.z> --key <private.pem>
      --install-script <install.sh> [--work-dir <dir>] [--keep]
      The acceptance of the distribution (Phase 10, P12): install, close and reopen the TUI, the four
      refusals, rollback, the update in idle and park, uninstall. Two executables built with the
      public half of --key, in a temporary HOME, against a release server on the loopback.
  acceptance-busy --exe-n <file> --version-n <x.y.z> --exe-n1 <file> --version-n1 <x.y.z> --key <private.pem>
      --install-script <install.sh> --model <id> --need <text> --play-timeout-ms <n> --max-wait <dur>
      --limits <preset> [--modes idle,park] [--profile-dir <dir>] [--client-mode <mode>]
      [--client-command <file>] [--daemon-path <PATH>] [--resume-form native|any (default native)] [--prefix <text>]
      [--work-dir <dir>] [--keep]
      The update with a piece in progress (Phase 10, N303 (2); level phase10-busy of
      tools/acceptance/real-acceptance.sh): a real piece starts, the next version is published while
      an attempt runs, and in each mode (idle: the swap waits for the attempt; park: the attempt is
      parked and comes back by session/load) the piece must end in DONE after the swap.
      --profile-dir is linked, never copied or read, as the profile claude-code/real of the run.
${RELEASE_USAGE}`;

function fail(message: string): never {
  process.stderr.write(`otheater-release: ${message}\n`);
  process.exit(2);
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const root = repoRoot();
  if (command === 'build') {
    const { values } = parseArgs({
      args: [...rest],
      options: {
        target: { type: 'string' },
        out: { type: 'string' },
        config: { type: 'string' },
        node: { type: 'string' },
        minify: { type: 'boolean' },
        version: { type: 'string' },
        'public-key': { type: 'string' },
      },
      strict: true,
    });
    let config;
    try {
      config = loadReleaseConfig(
        values.config ?? path.join(root, 'tools', 'release', 'release.config.json'),
      );
    } catch (error) {
      if (error instanceof ReleaseConfigError) fail(error.message);
      throw error;
    }
    if (values.version !== undefined) {
      try {
        config = parseReleaseConfig({ ...config, versionOverride: values.version });
      } catch (error) {
        if (error instanceof ReleaseConfigError) fail(error.message);
        throw error;
      }
    }
    const host = hostTarget();
    let target: TargetId | undefined;
    if (values.target !== undefined) {
      if (!isTargetId(values.target))
        fail(`unknown target "${values.target}" (${TARGET_IDS.join(', ')})`);
      target = values.target;
    } else {
      target = config.targets.find((id) => id === host);
    }
    if (target === undefined) fail('no target to build on this machine');
    const record = await buildTarget({
      root,
      publicKeyFile:
        values['public-key'] === undefined ? undefined : path.resolve(values['public-key']),
      target,
      config,
      outDir: path.resolve(values.out ?? path.join(root, 'dist', 'sea')),
      nodeBinary: values.node,
      minify: values.minify,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  }
  if (command === 'smoke') {
    const { values, positionals } = parseArgs({
      args: [...rest],
      options: { version: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
    const executable = positionals[0];
    if (executable === undefined) fail('smoke needs the path of the executable');
    const result = await runSmoke({
      executable: path.resolve(executable),
      expectedVersion: values.version,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    return result.ok ? 0 : 1;
  }
  if (command === 'acceptance') {
    const { values } = parseArgs({
      args: [...rest],
      options: {
        'exe-n': { type: 'string' },
        'version-n': { type: 'string' },
        'exe-n1': { type: 'string' },
        'version-n1': { type: 'string' },
        key: { type: 'string' },
        'install-script': { type: 'string' },
        'work-dir': { type: 'string' },
        keep: { type: 'boolean' },
      },
      strict: true,
    });
    const exeN = values['exe-n'];
    const versionN = values['version-n'];
    const exeN1 = values['exe-n1'];
    const versionN1 = values['version-n1'];
    const key = values.key;
    const script = values['install-script'];
    if (
      exeN === undefined ||
      versionN === undefined ||
      exeN1 === undefined ||
      versionN1 === undefined ||
      key === undefined ||
      script === undefined
    ) {
      fail(
        'acceptance needs --exe-n, --version-n, --exe-n1, --version-n1, --key and --install-script',
      );
    }
    const result = await runAcceptance({
      exeN: path.resolve(exeN),
      versionN,
      exeN1: path.resolve(exeN1),
      versionN1,
      privateKeyFile: path.resolve(key),
      installScript: path.resolve(script),
      ownSchemas: await readOwnSchemas(root),
      workDir: values['work-dir'] === undefined ? undefined : path.resolve(values['work-dir']),
      keep: values.keep,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    return result.ok ? 0 : 1;
  }
  if (command === 'acceptance-busy') {
    const { values } = parseArgs({
      args: [...rest],
      options: {
        'exe-n': { type: 'string' },
        'version-n': { type: 'string' },
        'exe-n1': { type: 'string' },
        'version-n1': { type: 'string' },
        key: { type: 'string' },
        'install-script': { type: 'string' },
        'work-dir': { type: 'string' },
        keep: { type: 'boolean' },
        modes: { type: 'string' },
        'profile-dir': { type: 'string' },
        model: { type: 'string' },
        'client-mode': { type: 'string' },
        'client-command': { type: 'string' },
        'daemon-path': { type: 'string' },
        need: { type: 'string' },
        'play-timeout-ms': { type: 'string' },
        'max-wait': { type: 'string' },
        limits: { type: 'string' },
        'resume-form': { type: 'string' },
        prefix: { type: 'string' },
      },
      strict: true,
    });
    const exeN = values['exe-n'];
    const versionN = values['version-n'];
    const exeN1 = values['exe-n1'];
    const versionN1 = values['version-n1'];
    const key = values.key;
    const script = values['install-script'];
    const { model, need, limits } = values;
    const maxWait = values['max-wait'];
    const timeout = Number(values['play-timeout-ms']);
    if (
      exeN === undefined ||
      versionN === undefined ||
      exeN1 === undefined ||
      versionN1 === undefined ||
      key === undefined ||
      script === undefined ||
      model === undefined ||
      need === undefined ||
      limits === undefined ||
      maxWait === undefined ||
      !Number.isInteger(timeout) ||
      timeout < 1
    ) {
      fail(
        'acceptance-busy needs --exe-n, --version-n, --exe-n1, --version-n1, --key, --install-script, --model, --need, --limits, --max-wait and --play-timeout-ms',
      );
    }
    const modes = (values.modes ?? BUSY_MODES.join(',')).split(',').map((m) => m.trim());
    for (const mode of modes) {
      if (!(BUSY_MODES as readonly string[]).includes(mode)) fail(`unknown mode "${mode}"`);
    }
    const resumeForm = values['resume-form'] ?? 'native';
    if (!(BUSY_RESUME_FORMS as readonly string[]).includes(resumeForm)) {
      fail(`--resume-form is one of ${BUSY_RESUME_FORMS.join(', ')}`);
    }
    const result = await runBusyAcceptance({
      exeN: path.resolve(exeN),
      versionN,
      exeN1: path.resolve(exeN1),
      versionN1,
      privateKeyFile: path.resolve(key),
      installScript: path.resolve(script),
      ownSchemas: await readOwnSchemas(root),
      workDir: values['work-dir'] === undefined ? undefined : path.resolve(values['work-dir']),
      keep: values.keep,
      modes: modes as BusyMode[],
      profileDir: values['profile-dir'],
      model,
      clientMode: values['client-mode'],
      clientCommand: values['client-command'],
      daemonPath: values['daemon-path'],
      need,
      playTimeoutMs: timeout,
      maxWait,
      limitsPreset: limits,
      resumeForm: resumeForm as BusyResumeForm,
      prefix: values.prefix,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    return result.ok ? 0 : 1;
  }
  if (command !== undefined && (RELEASE_COMMANDS as readonly string[]).includes(command)) {
    return runReleaseCommand(command, rest, (line) => process.stdout.write(`${line}\n`), root);
  }
  process.stdout.write(USAGE);
  return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return pathToFileURL(realpathSync(invoked)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
