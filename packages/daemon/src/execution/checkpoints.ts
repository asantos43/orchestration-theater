// SPDX-License-Identifier: MPL-2.0
import type { Clock, NormalizedUpdate, ToolKind, Vcs } from '@otheater/core';
import { buildDaemonEvent, type CheckpointReason } from '@otheater/protocol';
import type { AttemptJournal } from './journal.js';

/** Tool kinds that change files: the ones an edit batch counts. */
const EDIT_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(['edit', 'delete', 'move']);

export interface CheckpointOptions {
  readonly vcs: Vcs;
  readonly clock: Clock;
  readonly journal: AttemptJournal;
  readonly worktree: string;
  readonly branch: string;
  /** Correlation of the events (`playId`, `demandId`, `attemptId`). */
  readonly correlation: { playId: string; demandId: string; attemptId: string };
  /** `resume.checkpoint_edit_batch`: completed edit tool calls per checkpoint (0 turns it off). */
  readonly editBatch: number;
  /** `resume.checkpoint_every` in ms (0 turns it off). */
  readonly everyMs: number;
  /** Called when a checkpoint that nobody waits for fails (a batch or interval one). */
  readonly onError: (error: unknown) => void;
}

/**
 * The automatic checkpoints of one attempt (architecture 5.16, "Checkpoints"): a WIP commit on
 * the attempt branch after every batch of edits, every `everyMs`, and on every interruption. Each
 * one is a commit through the `Vcs` port, an `attempt.checkpoint` event and the `lastCheckpoint`
 * fields of the registry, in that order. Commits of one attempt never overlap (one lock), and a
 * worktree with nothing new makes no commit, so the interval is cheap on an idle attempt.
 */
export class CheckpointTracker {
  readonly #options: CheckpointOptions;
  readonly #kinds = new Map<string, ToolKind>();
  readonly #counted = new Set<string>();
  #edits = 0;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(options: CheckpointOptions) {
    this.#options = options;
  }

  /** Feeds one update of the session; takes a checkpoint when an edit batch is complete. */
  observe(update: NormalizedUpdate): void {
    if (update.kind !== 'tool_call' && update.kind !== 'tool_call_update') return;
    if (update.toolKind !== undefined) this.#kinds.set(update.toolCallId, update.toolKind);
    if (update.status !== 'completed' || this.#counted.has(update.toolCallId)) return;
    const kind = this.#kinds.get(update.toolCallId);
    if (kind === undefined || !EDIT_KINDS.has(kind)) return;
    this.#counted.add(update.toolCallId);
    this.#edits += 1;
    const batch = this.#options.editBatch;
    if (batch > 0 && this.#edits >= batch) {
      this.#edits = 0;
      this.take('edit_batch').catch(this.#options.onError);
    }
  }

  /** Takes a checkpoint every `everyMs` until `signal` aborts. */
  startInterval(signal: AbortSignal): void {
    const { everyMs, clock } = this.#options;
    if (everyMs <= 0) return;
    void (async () => {
      for (;;) {
        try {
          await clock.sleep(everyMs, signal);
        } catch {
          return;
        }
        await this.take('interval').catch(this.#options.onError);
      }
    })();
  }

  /** Resolves when no checkpoint is in flight (what `observe` and the interval started). */
  async settled(): Promise<void> {
    for (;;) {
      const lock = this.#lock;
      await lock;
      if (lock === this.#lock) return;
    }
  }

  /**
   * Commits whatever the worktree holds. Returns the sha of the new commit or, when there was
   * nothing to commit, the last checkpoint of the attempt (`undefined` if it never had one).
   */
  take(reason: CheckpointReason, detail?: string): Promise<string | undefined> {
    const run = this.#lock.then(() => this.#take(reason, detail));
    this.#lock = run.catch(() => undefined);
    return run;
  }

  async #take(reason: CheckpointReason, detail: string | undefined): Promise<string | undefined> {
    const { vcs, journal, worktree, branch, correlation, clock } = this.#options;
    const label = detail === undefined ? reason : `${reason}: ${detail}`;
    const sha = await vcs.checkpoint(worktree, label);
    if (sha === undefined) return journal.record.lastCheckpoint ?? undefined;
    await journal.write(
      buildDaemonEvent('attempt.checkpoint', { sha, label, reason, branch, ...correlation }),
      { lastCheckpoint: sha, lastCheckpointAt: clock.now() },
    );
    return sha;
  }
}
