// SPDX-License-Identifier: MPL-2.0
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventLog, Vcs } from '@otheater/core';
import type { RecoveryNoticeKind } from '@otheater/protocol';
import type { Logger } from '../logger.js';
import { situationSubject, situationText, writeSituation } from '../situations.js';
import type { DirectOrphansMode, DirectOnCloseMode } from './direct-config.js';

/**
 * The sweep of the worktrees of direct sessions that no session owns (Phase 7, P27; N206, N190).
 * A session takes its worktree away when it closes, so one still on disk at start-up belongs to a
 * daemon that died before it could close it. [proposta] The sweep runs once, at start-up, before
 * the daemon takes any request, so no session is opening while it looks.
 *
 * Safety rules, because `discard` deletes a folder and a branch:
 * - only the folders `direct-<8 hex>` directly under `<worktrees>/direct` are looked at, and each
 *   must be a plain folder (never a link, whatever it points to);
 * - a folder is removed only if git lists it as a worktree of its own repository, on the branch
 *   `direct/<same name>`, and not as the main worktree;
 * - the removal goes through `Vcs.removeWorktree`, which resolves the repository from the folder.
 * Anything that fails one of the rules is left alone and told as `direct_orphan_failed`.
 *
 * Every outcome is a `recovery.notice` (no scenario: a worktree does not say which one it was of).
 */

/** The name of the folder (and of the session) of a direct session: `direct-` and eight hex digits. */
const SESSION_FOLDER = /^direct-[0-9a-f]{8}$/;

export interface OrphanSweepOptions {
  readonly vcs: Pick<Vcs, 'listWorktrees' | 'removeWorktree'>;
  readonly events: Pick<EventLog, 'append'>;
  readonly logger: Logger;
  /** `<data>/worktrees`. */
  readonly worktreeRoot: string;
  /** `direct_session.orphans`. */
  readonly mode: DirectOrphansMode;
  /** `direct_session.on_close`, which `mode: on_close` follows. */
  readonly onClose: DirectOnCloseMode;
  /** The ids of the sessions the daemon holds open: their folders are not orphans. */
  readonly live: ReadonlySet<string>;
}

export interface OrphanSweepResult {
  /** Left on disk and recorded. */
  readonly found: readonly string[];
  /** Removed with their branch. */
  readonly removed: readonly string[];
  /** Left alone because it was unsafe or the removal failed. */
  readonly failed: readonly string[];
}

/** The mode that applies: `on_close` hands the choice to `direct_session.on_close`. */
export function effectiveOrphansMode(
  mode: DirectOrphansMode,
  onClose: DirectOnCloseMode,
): 'keep' | 'discard' | 'off' {
  return mode === 'on_close' ? onClose : mode;
}

/** The short text of why something failed. */
function reasonOf(error: unknown): string {
  return situationText(error) ?? 'unknown error';
}

/** `refs/heads/x` and `x` are the same branch. */
function shortBranch(branch: string | undefined): string | undefined {
  return branch?.replace(/^refs\/heads\//, '');
}

/** Looks for the orphans and keeps or discards them by the mode. Never throws. */
export async function sweepDirectOrphans(options: OrphanSweepOptions): Promise<OrphanSweepResult> {
  const { vcs, events, logger, worktreeRoot, live } = options;
  const mode = effectiveOrphansMode(options.mode, options.onClose);
  const found: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];
  if (mode === 'off') return { found, removed, failed };

  const notice = (kind: RecoveryNoticeKind, branch: string, detail: string): Promise<void> =>
    writeSituation(events, logger, 'recovery.notice', {
      kind,
      subject: situationSubject(branch),
      detail: situationText(detail),
    });

  const base = join(worktreeRoot, 'direct');
  let names: string[];
  try {
    if ((await lstat(base)).isSymbolicLink()) {
      logger.warn({ folder: 'direct' }, 'the direct worktrees folder is a link: not swept');
      await notice(
        'direct_orphan_failed',
        'direct',
        'worktrees/direct is a link, so it was not swept',
      );
      return { found, removed, failed: ['direct'] };
    }
    names = (await readdir(base)).filter((name) => SESSION_FOLDER.test(name)).sort();
  } catch (error) {
    // No folder, nothing to sweep; anything else is told once.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err: error }, 'the direct worktrees folder could not be read');
      await notice(
        'direct_orphan_failed',
        'direct',
        `worktrees/direct could not be read: ${reasonOf(error)}`,
      );
      return { found, removed, failed: ['direct'] };
    }
    return { found, removed, failed };
  }

  for (const name of names) {
    if (live.has(name)) continue;
    const branch = `direct/${name}`;
    const where = `worktrees/direct/${name}`;
    const folder = join(base, name);
    const leave = async (why: string): Promise<void> => {
      failed.push(name);
      logger.warn({ folder: where, why }, 'a direct worktree was left alone');
      await notice('direct_orphan_failed', branch, `${where} was left alone: ${why}`);
    };
    try {
      if (!(await lstat(folder)).isDirectory()) {
        await leave('it is not a plain folder');
        continue;
      }
      const real = await realpath(folder);
      const listed = await vcs.listWorktrees(folder);
      const own = await Promise.all(
        listed.map(async (entry) => ({
          entry,
          real: await realpath(entry.path).catch(() => entry.path),
        })),
      );
      const match = own.find((candidate) => candidate.real === real)?.entry;
      if (match === undefined || match.main || shortBranch(match.branch) !== branch) {
        await leave('git does not list it as the worktree of its own branch');
        continue;
      }
      if (mode === 'keep') {
        found.push(name);
        logger.warn({ folder: where, branch }, 'a direct worktree has no live session: kept');
        await notice('direct_orphan_found', branch, `${where} has no live session and was kept`);
        continue;
      }
      await vcs.removeWorktree(folder, { force: true, deleteBranch: true });
      removed.push(name);
      logger.warn({ folder: where, branch }, 'a direct worktree has no live session: removed');
      await notice('direct_orphan_removed', branch, `${where} was removed with its branch`);
    } catch (error) {
      await leave(reasonOf(error));
    }
  }
  return { found, removed, failed };
}
