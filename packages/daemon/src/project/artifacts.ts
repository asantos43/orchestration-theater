// SPDX-License-Identifier: MPL-2.0
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  COMMIT_TYPES,
  type ChangelogFormat,
  type CommitType,
  type ProjectConventions,
} from '@otheater/core';
import { CHANGELOG_MODES, type ChangelogMode } from '../config.js';
import {
  DEFAULT_CHANGELOG_FILE,
  insertEntry,
  newChangelog,
  type ChangelogEntry,
} from './changelog.js';
import { detectChangelogFormat, findChangelog } from './detect.js';

/** Key of the scenario override (`scenarios.config_override`) of the mode. */
export const CHANGELOG_OVERRIDE_KEY = 'delivery.changelog';

/** Longest line of the title of a PR and of the subject of a commit, like the one before P7. */
const TITLE_MAX = 72;
/** Changelog files bigger than this are left alone (the daemon would read all of them). */
const CHANGELOG_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The mode of a scenario: its own override of `delivery.changelog` when it has a valid one, else
 * the global value. A value that is not one of the modes is ignored, not trusted.
 */
export function changelogModeOf(
  global: ChangelogMode,
  override: Readonly<Record<string, unknown>> | undefined,
): ChangelogMode {
  const value = override?.[CHANGELOG_OVERRIDE_KEY];
  return CHANGELOG_MODES.find((mode) => mode === value) ?? global;
}

/** What the store knows about a delivery; the only source of the structural text. */
export interface DeliveryFacts {
  readonly playId: string;
  /** The Producer's need. */
  readonly need: string;
  /** The demands of the delivery (the approved ones), in the order of the script. */
  readonly demands: readonly { readonly id: string; readonly title: string }[];
  /** Only the approved demands are in the delivery. */
  readonly partial?: boolean;
  /** The Critic was waived for the play. */
  readonly criticWaived?: boolean;
  /** [proposta] The id of the flow of the configuration that has no Critic stage (P12). */
  readonly criticSkippedBy?: string;
}

export interface DeliveryArtifacts {
  /** Title of the PR and subject of the merge commit. */
  readonly title: string;
  /** Text of the PR (the delivery mode and the warnings are added after it). */
  readonly body: string;
  /** Message of the merge commit of `direct_merge`. */
  readonly mergeMessage: string;
  /** The entry of the changelog. */
  readonly entry: ChangelogEntry;
  /** Subject of the commit that carries the changelog. */
  readonly changelogMessage: string;
}

const CONVENTIONAL_PREFIX = /^([a-z]+)(\([^)\r\n]+\))?(!)?: (\S.*)$/;

/** Type and subject of a need that may already start like a Conventional Commit. */
function splitNeed(line: string, fallback: CommitType): { type: CommitType; subject: string } {
  const match = CONVENTIONAL_PREFIX.exec(line);
  const type = COMMIT_TYPES.find((candidate) => candidate === match?.[1]);
  if (match?.[4] !== undefined && type !== undefined) return { type, subject: match[4] };
  return { type: fallback, subject: line };
}

/**
 * The text a delivery writes, from the store only: the need, the demands, the state of the play.
 * No model writes any of it, so it is complete by itself. `conventions` (`undefined` for a
 * project that has none yet) sets the pattern of the title: `feat: ...` in a repository of
 * Conventional Commits, the plain first line of the need otherwise.
 */
export function buildDeliveryArtifacts(
  facts: DeliveryFacts,
  conventions?: Pick<ProjectConventions, 'commit'>,
): DeliveryArtifacts {
  const firstLine = (facts.need.split('\n')[0] ?? facts.need).trim();
  const fallbackTitle = `Play ${facts.playId}`;
  const conventional = conventions?.commit.style === 'conventional';
  const { type, subject } = splitNeed(
    firstLine === '' ? fallbackTitle : firstLine,
    conventions?.commit.defaultType ?? 'feat',
  );
  const prefix = conventional ? `${type}: ` : '';
  const title = `${prefix}${subject.slice(0, TITLE_MAX - prefix.length).trimEnd()}`;

  const demandLines = facts.demands.map((demand) => `- \`${demand.id}\`: ${demand.title}`);
  const body = [
    `Delivered by OTheater (play ${facts.playId}).`,
    facts.partial === true ? 'Only the approved demands are included.' : undefined,
    facts.criticWaived === true ? 'The Critic was waived for this play.' : undefined,
    facts.criticSkippedBy === undefined
      ? undefined
      : `The flow "${facts.criticSkippedBy}" has no Critic stage.`,
    `## Need\n\n${facts.need}`,
    demandLines.length === 0 ? undefined : `## Demands\n\n${demandLines.join('\n')}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n\n');

  const mergeMessage = [
    title,
    demandLines.length === 0
      ? undefined
      : `Demands:\n${facts.demands.map((demand) => `- ${demand.title} (${demand.id})`).join('\n')}`,
    `Delivered by OTheater (play ${facts.playId}).`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n\n');

  const details = facts.demands.length > 1 ? facts.demands.map((demand) => demand.title) : [];
  const entry: ChangelogEntry = { summary: subject.trimEnd(), details, type };
  const changelogMessage = conventional
    ? `docs(changelog): add the entry of play ${facts.playId}`
    : `Add the changelog entry of play ${facts.playId}`;
  return { title, body, mergeMessage, entry, changelogMessage };
}

/** The change the delivery commits to the changelog: the file and its whole new text. */
export interface ChangelogChange {
  readonly file: string;
  readonly content: string;
  readonly format: Exclude<ChangelogFormat, 'none'>;
  /** The file did not exist. */
  readonly created: boolean;
}

/**
 * What to write in the changelog of `worktree` (the integration branch, at the moment of the
 * delivery), or `undefined` for nothing:
 * - `never`: nothing;
 * - a changelog exists: the entry goes in the format the Producer confirmed for it, else the one
 *   detected in the file, so the repository keeps its own format;
 * - none exists: `always` creates `CHANGELOG.md` in Keep a Changelog format; `auto` creates it only
 *   for a project the OTheater made (`source: profile`), and leaves the repository alone otherwise.
 * It can run again: an entry that is already in the file changes nothing.
 */
export async function planChangelog(input: {
  readonly mode: ChangelogMode;
  readonly worktree: string;
  readonly entry: ChangelogEntry;
  readonly conventions?: Pick<ProjectConventions, 'source' | 'changelog'> | undefined;
}): Promise<ChangelogChange | undefined> {
  const { mode, worktree, entry, conventions } = input;
  if (mode === 'never') return undefined;
  const found = await findChangelog(worktree);
  if (found === undefined) {
    const isNew = conventions?.source === 'profile';
    if (mode === 'auto' && !isNew) return undefined;
    return {
      file: DEFAULT_CHANGELOG_FILE,
      content: newChangelog(entry),
      format: 'keep-a-changelog',
      created: true,
    };
  }
  const path = join(worktree, found.file);
  if ((await stat(path)).size > CHANGELOG_MAX_BYTES) return undefined;
  const text = await readFile(path, 'utf8');
  const confirmed = conventions?.changelog;
  const format =
    confirmed !== undefined && confirmed.format !== 'none' && confirmed.file === found.file
      ? confirmed.format
      : detectChangelogFormat(text);
  const content = insertEntry(format, text, entry);
  if (content === text) return undefined;
  return { file: found.file, content, format, created: false };
}
