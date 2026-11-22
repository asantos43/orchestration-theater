// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, readFileSync } from 'node:fs';
import { inject } from 'postject';
import type { TargetInfo } from './targets.js';

/** The fuse Node looks for in its own binary to know it carries a SEA blob. */
export const SEA_SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
/** The resource (ELF section, PE resource, Mach-O section) that holds the blob. */
export const SEA_RESOURCE = 'NODE_SEA_BLOB';
/** The Mach-O segment that holds it (macOS). */
export const SEA_MACHO_SEGMENT = 'NODE_SEA';

export type Run = (command: string, args: readonly string[]) => void;

const defaultRun: Run = (command, args) => {
  execFileSync(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
};

export interface InjectOptions {
  readonly nodeBinary: string;
  readonly blob: string;
  readonly output: string;
  readonly target: TargetInfo;
  /** Runs `codesign` (macOS). Default: really runs it. */
  readonly run?: Run | undefined;
}

/**
 * The commands that sign on macOS. Injecting into a Mach-O invalidates the signature of the Node
 * binary, and an arm64 executable that is not signed does not run at all, so the build drops the old
 * signature before and applies an ad hoc one (`-`, no identity, no certificate) after, always. This is
 * not the "code signing" of decision N247, which is a Developer ID signature; the ad hoc one is what
 * lets the binary start. [proposta]
 */
export function codesignSteps(file: string, phase: 'before' | 'after'): string[][] {
  return phase === 'before' ? [['--remove-signature', file]] : [['--force', '--sign', '-', file]];
}

/** Copies the Node binary to `output` and injects the blob into the copy. */
export async function createExecutable(options: InjectOptions): Promise<void> {
  const run = options.run ?? defaultRun;
  const darwin = options.target.platform === 'darwin';
  copyFileSync(options.nodeBinary, options.output);
  chmodSync(options.output, 0o755);
  if (darwin) {
    for (const args of codesignSteps(options.output, 'before')) run('codesign', args);
  }
  try {
    await inject(options.output, SEA_RESOURCE, readFileSync(options.blob), {
      sentinelFuse: SEA_SENTINEL_FUSE,
      ...(darwin ? { machoSegmentName: SEA_MACHO_SEGMENT } : {}),
    });
  } catch (cause) {
    const message = (cause as Error).message;
    throw new Error(
      `Cannot inject the blob into ${options.nodeBinary}: ${message}. The Node binary has to be a standalone build ` +
        '(the one of nodejs.org or actions/setup-node); a distribution package that loads a shared libnode cannot carry a SEA.',
      { cause },
    );
  }
  if (darwin) {
    for (const args of codesignSteps(options.output, 'after')) run('codesign', args);
  }
}
