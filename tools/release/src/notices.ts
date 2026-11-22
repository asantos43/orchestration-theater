// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { NoticesMode } from './config.js';
import type { TargetId } from './targets.js';

/**
 * The third-party notices of the executable (Phase 10, P10; decision N72). The build of each platform
 * leaves `THIRD_PARTY_NOTICES-<platform>.md` next to the executable (`<out>/<target>/`), and the
 * installers (the `.msi`, `install.sh`) take it from there. The file is made by `tools/verify`, which
 * knows the production graph, the licenses and the texts; this module only says where it goes and
 * what it is called, and runs it.
 */
export function noticesFileName(target: TargetId): string {
  return `THIRD_PARTY_NOTICES-${target}.md`;
}

/** The arguments of `tools/verify`'s `notices` for the file of `target`, from the metafile of the bundle. */
export function noticesArgs(options: {
  readonly target: TargetId;
  readonly metafile: string;
  readonly out: string;
}): string[] {
  return [
    'notices',
    '--platform',
    options.target,
    '--metafile',
    options.metafile,
    '--out',
    options.out,
  ];
}

export type RunNode = (args: readonly string[], cwd: string) => void;

const runNode: RunNode = (args, cwd) => {
  execFileSync(process.execPath, [...args], { cwd, stdio: 'inherit', timeout: 600_000 });
};

export interface NoticesOptions {
  readonly root: string;
  readonly target: TargetId;
  readonly mode: NoticesMode;
  /** The folder of the build of the target: it holds `metafile.json` and receives the notices. */
  readonly workDir: string;
  /** Test seam: how `node` is run. */
  readonly run?: RunNode | undefined;
}

/**
 * Leaves the notices file of `target` in `workDir` and returns its path. `per_platform` generates it
 * (and checks it against the graph, so a build with a package missing fails here); `root_only` copies
 * the root file under the same name.
 */
export function writeNotices(options: NoticesOptions): string {
  const { root, target, workDir } = options;
  const out = path.join(workDir, noticesFileName(target));
  const verify = path.join(root, 'tools', 'verify', 'dist', 'cli.js');
  const run = options.run ?? runNode;
  if (options.mode === 'root_only') {
    const rootFile = path.join(root, 'THIRD_PARTY_NOTICES.md');
    if (!existsSync(rootFile))
      throw new Error('THIRD_PARTY_NOTICES.md not found at the repository root');
    copyFileSync(rootFile, out);
    return out;
  }
  if (!existsSync(verify) && options.run === undefined) {
    throw new Error('tools/verify is not built (run "pnpm -s build" first)');
  }
  const args = noticesArgs({ target, metafile: path.join(workDir, 'metafile.json'), out });
  run([verify, ...args, '--root', root], root);
  run([verify, ...args, '--root', root, '--check'], root);
  return out;
}
