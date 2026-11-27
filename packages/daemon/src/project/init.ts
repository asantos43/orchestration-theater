// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, supportsInit, supportsLocate, type Vcs } from '@otheater/core';
import {
  FILES_INIT_CHOICES,
  NEEDS_INIT_REASON,
  type FolderInitChoice,
  type NeedsInitDetails,
} from '@otheater/protocol';
import type { InitMode } from '../config.js';
import { inspectFolder } from './inspect.js';

/** `projects.init.*` as the service reads it (N332). [proposta] */
export interface InitSettings {
  readonly mode: InitMode;
  /** The subject of the first commit. */
  readonly message: string;
}

/**
 * The folder has files and no repository, and `projects.init.mode` is `ask`: the open cannot go on
 * until the Producer chooses (`init`). It is an `invalid_input` for the API, whose `details` say so
 * in a form a client reads without parsing the message. [proposta]
 */
export class NeedsInit extends InvalidInput {
  readonly details: NeedsInitDetails;

  constructor(folder: string) {
    super(
      `"${folder}" has files and is not a git repository: choose ${FILES_INIT_CHOICES.join(' or ')} (init), or set projects.init.mode`,
    );
    this.details = { reason: NEEDS_INIT_REASON, choices: [...FILES_INIT_CHOICES] };
  }
}

export interface InitProjectFolderInput {
  readonly vcs: Vcs;
  /** Absolute path of the folder. */
  readonly folder: string;
  /** What the Producer asked for; absent: `projects.init.mode` decides. */
  readonly choice?: FolderInitChoice | undefined;
  /** The branch of the first commit. Default `main`. */
  readonly branch?: string | undefined;
  readonly settings: InitSettings;
  /** What the open would have said without any initialization: thrown when there is nothing to initialize. */
  readonly refusal: InvalidInput;
}

export interface InitOutcome {
  readonly choice: FolderInitChoice;
  readonly branch: string;
  /** The sha of the first commit. */
  readonly head: string;
}

/**
 * Turns the folder of a project that is not a repository into one (N332), when the Producer asked
 * (`choice`) or `projects.init.mode` says so:
 * - a folder with files and `commit_all`: `git init` and a first commit with every file, the
 *   `.gitignore` respected; with `empty_commit`: `git init` and an empty first commit;
 * - an empty or missing folder with a `choice`: it is created if needed, `git init` and an empty
 *   first commit (`commit_all` has nothing to add there and does the same);
 * - a folder with files and no `choice`: the mode picks `commit_all` or `empty_commit`; `ask` is
 *   {@link NeedsInit}; `refuse` is `InvalidInput`, and it also refuses an explicit `choice`;
 * - a repository (or a folder inside one), or an empty folder with no `choice`: `refusal` is
 *   thrown, so the caller says what it would have said before.
 */
export async function initProjectFolder(input: InitProjectFolderInput): Promise<InitOutcome> {
  const { vcs, folder, settings } = input;
  if (!supportsInit(vcs) || !supportsLocate(vcs)) throw input.refusal;
  const found = await inspectFolder(vcs, folder);
  if (found.state === 'repo' || found.state === 'inside_repo') throw input.refusal;
  let choice = input.choice;
  if (found.state === 'files') {
    if (settings.mode === 'refuse') {
      throw new InvalidInput(
        `"${folder}" has files and is not a git repository, and projects.init.mode is "refuse": the daemon does not initialize it`,
      );
    }
    if (choice === 'empty_repo') {
      throw new InvalidInput(
        `"${folder}" has files: init "empty_repo" is for an empty or missing folder (use commit_all or empty_commit)`,
      );
    }
    if (choice === undefined) {
      if (settings.mode === 'ask') throw new NeedsInit(folder);
      choice = settings.mode;
    }
  } else if (choice === undefined) {
    throw input.refusal;
  }
  const branch = input.branch ?? 'main';
  const made = await vcs.init(folder, {
    branch,
    message: settings.message,
    ...(choice === 'commit_all' ? { commitAll: true } : {}),
  });
  return { choice, branch: made.branch, head: made.head };
}
