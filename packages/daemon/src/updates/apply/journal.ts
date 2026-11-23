// SPDX-License-Identifier: MPL-2.0
import { open, readFile, rename, rm } from 'node:fs/promises';
import { UPDATE_REASONS, UPDATE_ROLLBACK_MODES } from '@otheater/protocol';
import { z } from 'zod';

/**
 * The journal of a swap (Phase 10, P8): `update-state.json`, written before each step so that an
 * applier that dies half way (power cut, kill) leaves a file that says where it stopped. The next
 * `ot` that starts reads it and finishes or undoes the swap ({@link recoverInterrupted}). It is
 * the only thing the applier and the recovery share. [proposta]
 *
 * Steps, in order of a good swap: `waiting` (the old daemon is going away), `linked` (the old
 * executable is also at `previous/`), `placed` (the new one is the executable), `starting` (the
 * daemon is being started), `checking` (waiting for `/v1/health`), `committed` (done). The others
 * end a swap that went back (`rolling_back`, `rolled_back`) or stopped with `rollback: off`
 * (`failed`). `committed`, `rolled_back` and `failed` are final: they stay in the file until the
 * daemon reports them (`reported`) and the next swap writes over them.
 */
export const JOURNAL_STEPS = [
  'waiting',
  'linked',
  'placed',
  'starting',
  'checking',
  'committed',
  'rolling_back',
  'rolled_back',
  'failed',
] as const;
export type JournalStep = (typeof JOURNAL_STEPS)[number];

export const FINAL_STEPS: readonly JournalStep[] = ['committed', 'rolled_back', 'failed'];

const version = z.string().min(1).max(64);

export const JournalSchema = z.strictObject({
  v: z.literal(1),
  from: version,
  to: version,
  /** SHA-256 of the new executable (the one the manifest signs). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * SHA-256 of the signed manifest the daemon copied into `staging/` with its signature: the proof
   * that this journal asks for what the owner signed ({@link checkJournalTrust}, Phase 11 P8a).
   */
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  step: z.enum(JOURNAL_STEPS),
  /** The daemon that went away (0: none was running). */
  oldPid: z.int().min(0),
  /** The pid of the applier; a swap whose applier is gone was interrupted. */
  applierPid: z.int().min(0),
  dataDir: z.string().min(1),
  /** The installed executable that is replaced (its folder holds this journal). */
  exe: z.string().min(1),
  rollback: z.enum(UPDATE_ROLLBACK_MODES),
  healthTimeoutMs: z.int().min(1),
  /** How long the new daemon must answer without a drop after its first good answer. */
  stableMs: z.int().min(0),
  /** The backup made before a migration (its folder), or `null` when none was made. */
  backup: z.string().min(1).nullable(),
  reason: z.enum(UPDATE_REASONS).nullable(),
  /** Whether the daemon already wrote the final state as `daemon.update` and told the chat. */
  reported: z.boolean(),
  startedAt: z.int().min(0),
  updatedAt: z.int().min(0),
});
export type UpdateJournal = z.infer<typeof JournalSchema>;

export type JournalReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'ok'; readonly journal: UpdateJournal };

export async function readJournal(file: string): Promise<JournalReading> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'corrupt' };
  }
  try {
    return { kind: 'ok', journal: JournalSchema.parse(JSON.parse(text)) };
  } catch {
    return { kind: 'corrupt' };
  }
}

/** Writes the journal whole and to the disk before the next step; a reader never sees half of it. */
export async function writeJournal(file: string, journal: UpdateJournal): Promise<void> {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(JournalSchema.parse(journal), null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
