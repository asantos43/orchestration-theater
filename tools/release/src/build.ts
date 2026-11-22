// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256File, type NativeAsset } from './assets.js';
import { assetFiles, bundle, readBuildVersion } from './bundle.js';
import type { ReleaseConfig } from './config.js';
import { createExecutable } from './inject.js';
import { noticesFileName, writeNotices } from './notices.js';
import { generateBlob, seaConfig, writeAssetIndex } from './sea-config.js';
import { hostTarget, targetInfo, type TargetId } from './targets.js';

export interface BuildOptions {
  readonly root: string;
  readonly target: TargetId;
  readonly config: ReleaseConfig;
  /** The folder for the outputs; the files of the target go in `<outDir>/<target>/`. */
  readonly outDir: string;
  /** The Node binary to inject into. Default: `OT_SEA_NODE`, else the one running the build. */
  readonly nodeBinary?: string | undefined;
  readonly minify?: boolean | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/** What the build writes next to the executable (`build-record.json`), and returns. */
export interface BuildRecord {
  readonly target: TargetId;
  readonly version: string;
  readonly node: string;
  readonly executable: string;
  readonly executableBytes: number;
  readonly executableSha256: string;
  readonly bundleBytes: number;
  readonly blobBytes: number;
  readonly assetCount: number;
  /** The notices file next to the executable (`THIRD_PARTY_NOTICES-<target>.md`) and how it was made. */
  readonly notices: { readonly file: string; readonly mode: ReleaseConfig['notices'] };
  readonly natives: readonly { key: string; name: string; sha256: string; bytes: number }[];
  readonly inkPatchedVersion: string | null;
  readonly warnings: readonly string[];
}

/** The version of Ink the patches were made for, read from the TUI's source so there is one place for it. */
export function readSupportedInk(root: string): string {
  const text = readFileSync(path.join(root, 'packages', 'tui', 'src', 'ink-patch.ts'), 'utf8');
  const match = /SUPPORTED_INK_VERSION\s*=\s*'([^']+)'/.exec(text);
  if (match?.[1] === undefined)
    throw new Error('SUPPORTED_INK_VERSION not found in packages/tui/src/ink-patch.ts');
  return match[1];
}

export function nodeVersionOf(nodeBinary: string): string {
  return execFileSync(nodeBinary, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
}

/**
 * Builds the executable of `options.target`: the bundle, the blob and the injection. A target is
 * built on its own platform only (the addons that travel inside are the ones installed here, and the
 * Node binary is the one of the platform); the workflow has a runner for each.
 */
export async function buildTarget(options: BuildOptions): Promise<BuildRecord> {
  const log = options.log ?? (() => undefined);
  const info = targetInfo(options.target);
  const host = hostTarget();
  if (host !== options.target) {
    throw new Error(
      `${options.target} has to be built on its own platform (this machine is ${host ?? `${process.platform}-${process.arch}`})`,
    );
  }
  const nodeBinary = options.nodeBinary ?? process.env.OT_SEA_NODE ?? process.execPath;
  const node = nodeVersionOf(nodeBinary);
  const version = readBuildVersion(options.root, options.config.versionOverride);
  const work = path.join(options.outDir, options.target);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  log(`bundling (version ${version}, node ${node})`);
  const bundled = await bundle({
    root: options.root,
    target: info,
    outDir: work,
    version,
    supportedInk: readSupportedInk(options.root),
    minify: options.minify,
  });

  const assets = assetFiles(options.root, bundled.natives);
  const index = writeAssetIndex(path.join(work, 'ot-assets.json'), assets);
  const configFile = path.join(work, 'sea-config.json');
  const blob = path.join(work, 'sea-prep.blob');
  writeFileSync(
    configFile,
    JSON.stringify(seaConfig(bundled.file, blob, [...assets, index]), null, 2),
  );
  log(`blob (${String(assets.length + 1)} assets)`);
  generateBlob(nodeBinary, configFile);

  const executable = path.join(work, info.executable);
  log('injecting');
  await createExecutable({ nodeBinary, blob, output: executable, target: info });

  log(`notices (${options.config.notices})`);
  writeNotices({
    root: options.root,
    target: options.target,
    mode: options.config.notices,
    workDir: work,
  });

  const record: BuildRecord = {
    target: options.target,
    version,
    node,
    executable: info.executable,
    executableBytes: statSync(executable).size,
    executableSha256: sha256File(executable),
    bundleBytes: statSync(bundled.file).size,
    blobBytes: statSync(blob).size,
    assetCount: assets.length + 1,
    notices: { file: noticesFileName(options.target), mode: options.config.notices },
    natives: bundled.natives.map((native: NativeAsset) => ({
      key: native.key,
      name: native.name,
      sha256: native.sha256,
      bytes: statSync(native.file).size,
    })),
    inkPatchedVersion: bundled.inkPatchedVersion ?? null,
    warnings: bundled.warnings,
  };
  writeFileSync(path.join(work, 'build-record.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
