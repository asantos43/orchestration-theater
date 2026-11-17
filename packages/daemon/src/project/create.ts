// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  profileConventions,
  supportsInit,
  type ProjectConventions,
  type Vcs,
} from '@otheater/core';
import { SOFTWARE_TEMPLATE_VERSION, softwareTemplate } from './template.js';

export interface CreateSoftwareProjectInput {
  readonly vcs: Vcs;
  /** Absolute path of the folder of the project: it does not exist yet or it is empty. */
  readonly folder: string;
  /** Name for the README. Default: the name of the folder. */
  readonly name?: string;
  /** The main branch. Default `main`. */
  readonly branch?: string;
}

export interface CreatedProject {
  readonly folder: string;
  readonly branch: string;
  /** The commit with the structure of the profile. */
  readonly head: string;
  readonly conventions: ProjectConventions;
}

/**
 * Makes a project with the `software` profile: the folder becomes a git repository whose first
 * commit has the structure of the template (README, `.gitignore`, a changelog in Keep a Changelog
 * format, the test script and the GitHub Actions CI). Nothing is downloaded. A folder that has
 * something in it is refused: a project that already exists is imported, not created.
 */
export async function createSoftwareProject(
  input: CreateSoftwareProjectInput,
): Promise<CreatedProject> {
  const { vcs, folder } = input;
  if (!supportsInit(vcs)) {
    throw new AdapterUnavailable('This Vcs adapter cannot create the repository of a project');
  }
  const entries = await readdir(folder).catch(() => []);
  if (entries.length > 0) {
    throw new InvalidInput(
      `"${folder}" is not empty: a project that exists is imported (without newProject), not created`,
    );
  }
  const requested = input.branch ?? 'main';
  const { branch } = await vcs.init(folder, {
    branch: requested,
    message: 'chore: initial commit',
  });
  for (const file of softwareTemplate({
    name: input.name ?? basename(folder),
    mainBranch: branch,
  })) {
    const path = join(folder, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
    if (file.executable === true) await chmod(path, 0o755);
  }
  const head = await vcs.commitAll(
    folder,
    `chore: scaffold the project from the software profile\n\nProfile: software (template ${String(SOFTWARE_TEMPLATE_VERSION)})`,
  );
  if (head === undefined) throw new Error(`The template left nothing to commit in "${folder}"`);
  return { folder, branch, head, conventions: profileConventions(branch) };
}
