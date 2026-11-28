// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateFileAtomic } from '@otheater/client/node';
import { InvalidInput, WORKFLOW_HASH_PATTERN, WORKFLOW_ID_PATTERN } from '@otheater/core';
import { WorkflowPackageOriginSchema } from '@otheater/protocol';
import { z } from 'zod';
import { PACKAGE_SIGNATURE_STATES } from './sshsig.js';

/**
 * The registry of the installed workflow packages (N298; plan of Phase 11b, P9), in
 * `<data>/workflow-packages.json` [proposta] (plain JSON, written atomically, mode 0600).
 *
 * The workflow definitions themselves live in the library (`store.workflowDefinitions`, with
 * `source: package` and the `packageId`); this file is what the library does not keep: where the
 * package came from (for git, the commit it was pinned to), its hash, how its signature checked,
 * and the permissions the Producer approved, so that an update that asks for more asks again.
 */

export const WORKFLOW_PACKAGES_FILE_VERSION = 1;

/** The file and the staging folder of the packages inside the data directory. */
export function workflowPackagePaths(dataDir: string): {
  readonly file: string;
  /** Where a package is fetched and checked before it is saved; each install makes its own subfolder. */
  readonly staging: string;
} {
  return {
    file: join(dataDir, 'workflow-packages.json'),
    staging: join(dataDir, 'workflow-packages', '.staging'),
  };
}

const PackageEntrySchema = z.strictObject({
  id: z.string().regex(WORKFLOW_ID_PATTERN),
  version: z.string().min(1),
  hash: z.string().regex(WORKFLOW_HASH_PATTERN),
  origin: WorkflowPackageOriginSchema,
  /** `id@version` of the workflow versions this version of the package saved in the library. */
  workflows: z.array(z.string().min(1)),
  signature: z.enum(PACKAGE_SIGNATURE_STATES),
  signer: z.string().min(1).nullable(),
  confirmedUnsigned: z.boolean(),
  /** What the Producer approved for this version (the keys of `permissions.ts`); an update is compared with it. */
  permissions: z.array(z.string().min(1)),
  installedAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});
export type InstalledWorkflowPackage = z.infer<typeof PackageEntrySchema>;

const PackagesFileSchema = z.strictObject({
  version: z.literal(WORKFLOW_PACKAGES_FILE_VERSION),
  packages: z.record(z.string(), PackageEntrySchema),
});

export class WorkflowPackageRegistry {
  readonly #file: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async list(): Promise<readonly InstalledWorkflowPackage[]> {
    return Object.values(await this.#read()).sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<InstalledWorkflowPackage | undefined> {
    return (await this.#read())[id];
  }

  /** Saves (adds or replaces) the entry of a package. Writes are one after the other. */
  put(entry: InstalledWorkflowPackage): Promise<void> {
    const parsed = PackageEntrySchema.parse(entry);
    return this.#write((packages) => ({ ...packages, [parsed.id]: parsed }));
  }

  /** Forgets a package. Resolves without error when it is not there. */
  remove(id: string): Promise<void> {
    return this.#write((packages) =>
      Object.fromEntries(Object.entries(packages).filter(([key]) => key !== id)),
    );
  }

  async #read(): Promise<Record<string, InstalledWorkflowPackage>> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new InvalidInput(`${this.#file} is not valid JSON`, { cause: error });
    }
    const parsed = PackagesFileSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new InvalidInput(
        `${this.#file} is not a registry of workflow packages: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
      );
    }
    return parsed.data.packages;
  }

  #write(
    change: (
      packages: Record<string, InstalledWorkflowPackage>,
    ) => Record<string, InstalledWorkflowPackage>,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const next = change(await this.#read());
      const file = { version: WORKFLOW_PACKAGES_FILE_VERSION, packages: next };
      await writePrivateFileAtomic(this.#file, `${JSON.stringify(file, null, 2)}\n`);
    };
    const result = this.#chain.then(run, run);
    this.#chain = result.catch(() => undefined);
    return result;
  }
}
