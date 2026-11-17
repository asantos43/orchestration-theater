// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import type { JsonObject } from './store-schemas.js';

/**
 * Conventions of a project, the value of `scenarios.conventions` (architecture 5.20: "convenções
 * detectadas" of an imported repository, shown to the Producer to confirm or correct). [proposta]
 * The shape: the architecture names the field and what it holds, not the format.
 */

/** Format of the changelog a repository keeps. `none`: it has no changelog file. */
export const CHANGELOG_FORMATS = [
  'keep-a-changelog',
  'conventional-changelog',
  'other',
  'none',
] as const;
export type ChangelogFormat = (typeof CHANGELOG_FORMATS)[number];

/** Pattern of the commit subjects: Conventional Commits, or free text. */
export const COMMIT_STYLES = ['conventional', 'free'] as const;
export type CommitStyle = (typeof COMMIT_STYLES)[number];

export const CI_KINDS = ['github-actions', 'other', 'none'] as const;
export type CiKind = (typeof CI_KINDS)[number];

/** Where the values came from: read from the repository, from the profile, or set by the Producer. */
export const CONVENTION_SOURCES = ['detected', 'profile', 'producer'] as const;
export type ConventionSource = (typeof CONVENTION_SOURCES)[number];

/** Type of the change a delivery makes (Conventional Commits), used for the changelog section. */
export const COMMIT_TYPES = ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'chore'] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

const text = z.string().min(1);

/** Version of the format of the field, for a later change. */
export const CONVENTIONS_VERSION = 1;

export const ProjectConventionsSchema = z.strictObject({
  version: z.literal(CONVENTIONS_VERSION),
  source: z.enum(CONVENTION_SOURCES),
  /**
   * The Producer confirmed or corrected the values. `false` for what was only detected: the
   * daemon asks again until it is `true`.
   */
  confirmed: z.boolean(),
  /** The main branch the repository uses, when the detection could tell. */
  mainBranch: text.optional(),
  changelog: z.strictObject({
    format: z.enum(CHANGELOG_FORMATS),
    /** Path of the changelog inside the repository (`CHANGELOG.md`); absent for `none`. */
    file: text.optional(),
  }),
  commit: z.strictObject({
    style: z.enum(COMMIT_STYLES),
    /** Type a delivery gets in a `conventional` repository (a play has no type of its own). */
    defaultType: z.enum(COMMIT_TYPES).default('feat'),
  }),
  ci: z.enum(CI_KINDS),
  /** Commands P3 reads for `run_tests` and `install_deps`, when the repository tells them. */
  commands: z.strictObject({ test: text.optional(), install: text.optional() }).default({}),
});
export type ProjectConventions = z.infer<typeof ProjectConventionsSchema>;

/**
 * What a project the OTheater creates gets (architecture 5.20, profile `software`): Conventional
 * Commits, a Keep a Changelog file and GitHub Actions. Already confirmed: the Producer asked for
 * the project, there is nothing to correct.
 */
export function profileConventions(mainBranch: string): ProjectConventions {
  return {
    version: CONVENTIONS_VERSION,
    source: 'profile',
    confirmed: true,
    mainBranch,
    changelog: { format: 'keep-a-changelog', file: 'CHANGELOG.md' },
    commit: { style: 'conventional', defaultType: 'feat' },
    ci: 'github-actions',
    commands: { test: './scripts/test.sh' },
  };
}

/** The value as the store keeps it (`scenarios.conventions` is a JSON object): no `undefined`. */
export function conventionsToJson(conventions: ProjectConventions): JsonObject {
  return JSON.parse(JSON.stringify(conventions)) as JsonObject;
}

/** Parses the stored field; `undefined` when it is absent or in a shape this version does not know. */
export function parseConventions(value: unknown): ProjectConventions | undefined {
  const parsed = ProjectConventionsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
