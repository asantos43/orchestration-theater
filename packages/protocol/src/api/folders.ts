// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The folders a project can be opened on (N332). [proposta] Everything here is new in N332: the
 * architecture does not name the route, and the owner only decided that the Producer chooses what
 * happens to a folder with files and no repository (`projects.init.mode`).
 */

/**
 * What the Producer asks the daemon to do with the folder when a project is opened on it (the
 * `init` of `POST /v1/scenarios`). `commit_all`: `git init` and a first commit with every file
 * (`.gitignore` respected); `empty_commit`: `git init` and an empty first commit, the files stay
 * out of the index; `empty_repo`: for an empty or missing folder, create it if needed, `git init`
 * and an empty first commit (the alternative to `newProject`, which makes the structure of the
 * software profile).
 */
export const FOLDER_INIT_CHOICES = ['commit_all', 'empty_commit', 'empty_repo'] as const;
export const FolderInitChoiceSchema = z.enum(FOLDER_INIT_CHOICES);
export type FolderInitChoice = z.infer<typeof FolderInitChoiceSchema>;

/** The choices that make sense for a folder with files (the ones `details.choices` lists). */
export const FILES_INIT_CHOICES = ['commit_all', 'empty_commit'] as const;

/** `projects.init.mode` as the API tells it. */
export const FOLDER_INIT_MODES = ['ask', 'commit_all', 'empty_commit', 'refuse'] as const;
export const FolderInitModeSchema = z.enum(FOLDER_INIT_MODES);
export type FolderInitMode = z.infer<typeof FolderInitModeSchema>;

/**
 * Where a folder stands: `missing` (the path does not exist), `empty`, `files` (it has files and
 * no git repository), `repo` (it is the root of a git repository) or `inside_repo` (a subfolder of
 * one).
 */
export const FOLDER_STATES = ['missing', 'empty', 'files', 'repo', 'inside_repo'] as const;
export const FolderStateSchema = z.enum(FOLDER_STATES);
export type FolderState = z.infer<typeof FolderStateSchema>;

/** The `details` of the `invalid_input` an open answers when the folder needs the Producer's choice. */
export const NEEDS_INIT_REASON = 'needs_init';
export const NeedsInitDetailsSchema = z.strictObject({
  reason: z.literal(NEEDS_INIT_REASON),
  choices: z.array(z.enum(FILES_INIT_CHOICES)),
});
export type NeedsInitDetails = z.infer<typeof NeedsInitDetailsSchema>;

export const InspectFolderBodySchema = z.strictObject({
  path: z.string().min(1).max(4096),
});
export type InspectFolderBody = z.input<typeof InspectFolderBodySchema>;

export const InspectFolderResultSchema = z.strictObject({
  /** The absolute path the daemon resolved (the request's one, made absolute and normalized). */
  path: z.string().min(1),
  state: FolderStateSchema,
  /** The repository the folder is the root of, or is inside of; `null` for the other states. */
  git: z
    .strictObject({
      /** Absolute path of the root of the repository. */
      root: z.string().min(1),
      /** The branch checked out; `null` for a detached head. */
      branch: z.string().min(1).nullable(),
    })
    .nullable(),
  /** The `projects.init.mode` in force: what the daemon does with a folder with files. */
  initMode: FolderInitModeSchema,
});
export type InspectFolderResult = z.infer<typeof InspectFolderResultSchema>;

export const inspectFolder = defineRoute({
  id: 'inspectFolder',
  method: 'POST',
  path: '/v1/folders/inspect',
  summary:
    'Tells what a folder is (missing, empty, files, repo, inside_repo) before a project is opened on it; changes nothing',
  body: InspectFolderBodySchema,
  response: InspectFolderResultSchema,
  errors: ['unavailable'],
});

export const FOLDER_ROUTES = defineRoutes(inspectFolder);
