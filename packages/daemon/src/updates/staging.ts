// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UPDATE_CHANNELS } from '@otheater/protocol';
import semver from 'semver';
import { z } from 'zod';
import { UpdateStop } from './errors.js';
import type { ManifestAsset } from './manifest.js';

/**
 * Where a version that passed every check waits (Phase 10, P7). [proposta] `<dataDir>/updates/staging`
 * by default (the checker is given the folder; the step that applies a version may point it at the
 * install folder, `<folder>/staging/`, docs/21 P8). One version at a time:
 *
 * - a download is written to `.partial-<id>`, which no one reads; it is the only name an unchecked
 *   file ever has, and it is deleted when the check fails;
 * - only after the size and the SHA-256 match the (signed) manifest does the version move, as one
 *   folder, to `<version>/`, with the executable, the manifest, its signature and `ready.json`;
 * - a stored version is re-read from disk, never kept in memory, and the next step checks the hash
 *   again before it uses the file.
 *
 * Nothing here replaces or touches an executable that runs: the staging folder is not on any path.
 */

const READY_FILE = 'ready.json';

const ReadySchema = z.strictObject({
  version: z.string().min(1).max(64),
  channel: z.enum(UPDATE_CHANNELS),
  platform: z.string().min(1).max(32),
  asset: z.strictObject({
    name: z.string().min(1).max(128),
    size: z.int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  storedAt: z.int().min(0),
});

export interface StagedUpdate {
  readonly version: string;
  readonly channel: (typeof UPDATE_CHANNELS)[number];
  readonly platform: string;
  readonly asset: { readonly name: string; readonly size: number; readonly sha256: string };
  readonly storedAt: number;
  /** The absolute path of the stored executable. */
  readonly file: string;
}

export interface CommitInput {
  readonly version: string;
  readonly channel: StagedUpdate['channel'];
  readonly platform: string;
  readonly asset: ManifestAsset;
  /** The checked download, as {@link UpdateStaging.partialPath} gave it. */
  readonly partial: string;
  readonly manifest: Uint8Array;
  readonly signature: string;
  readonly storedAt: number;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
}

export class UpdateStaging {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** A new name for a download, in a folder only the owner can read. */
  async partialPath(): Promise<string> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new UpdateStop('storage', `the staging folder could not be made (${codeOf(error)})`);
    }
    return join(this.dir, `.partial-${randomBytes(8).toString('hex')}`);
  }

  /** Deletes a download that did not pass. It never throws. */
  async discard(partial: string): Promise<void> {
    await rm(partial, { force: true }).catch(() => undefined);
  }

  /** Removes a stored version (one that was applied, or that could not be trusted). It never throws. */
  async drop(version: string): Promise<void> {
    if (semver.valid(version) !== version) return;
    await rm(join(this.dir, version), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Deletes what an earlier run left unfinished (a download cut by a stop, a half-stored version). */
  async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.partial-') || name.startsWith('.incoming-')) {
        await rm(join(this.dir, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /** Stores a checked download: one folder, moved into place at the end. Older versions are removed. */
  async commit(input: CommitInput): Promise<StagedUpdate> {
    const incoming = join(this.dir, `.incoming-${randomBytes(8).toString('hex')}`);
    const target = join(this.dir, input.version);
    try {
      await mkdir(incoming, { recursive: true, mode: 0o700 });
      const file = join(incoming, input.asset.name);
      await rename(input.partial, file);
      await chmod(file, 0o700);
      await writeFile(join(incoming, 'manifest.json'), input.manifest, { mode: 0o600 });
      await writeFile(join(incoming, 'manifest.json.sig'), input.signature, { mode: 0o600 });
      const ready = {
        version: input.version,
        channel: input.channel,
        platform: input.platform,
        asset: { name: input.asset.name, size: input.asset.size, sha256: input.asset.sha256 },
        storedAt: input.storedAt,
      };
      await writeFile(join(incoming, READY_FILE), `${JSON.stringify(ready, null, 2)}\n`, {
        mode: 0o600,
      });
      for (const name of await readdir(this.dir)) {
        if (!name.startsWith('.')) await rm(join(this.dir, name), { recursive: true, force: true });
      }
      await rename(incoming, target);
      return { ...ready, file: join(target, input.asset.name) };
    } catch (error) {
      await rm(incoming, { recursive: true, force: true }).catch(() => undefined);
      throw new UpdateStop('storage', `the version could not be stored (${codeOf(error)})`);
    }
  }

  /** The newest version that is stored and whole (the file is there with the size that was checked). */
  async ready(): Promise<StagedUpdate | undefined> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return undefined;
    }
    let best: StagedUpdate | undefined;
    for (const name of names) {
      if (name.startsWith('.') || semver.valid(name) !== name) continue;
      try {
        const text = await readFile(join(this.dir, name, READY_FILE), 'utf8');
        const ready = ReadySchema.parse(JSON.parse(text));
        if (ready.version !== name) continue;
        const file = join(this.dir, name, ready.asset.name);
        if ((await stat(file)).size !== ready.asset.size) continue;
        if (best === undefined || semver.gt(ready.version, best.version)) {
          best = { ...ready, file };
        }
      } catch {
        // Not a stored version (or a damaged one): it is not offered.
      }
    }
    return best;
  }
}
