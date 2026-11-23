// SPDX-License-Identifier: MPL-2.0
import { appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Logger } from '../../logger.js';
import { recoverInterrupted, type ApplyPorts, type RecoveryResult } from './applier.js';
import { FINAL_STEPS, readJournal, type UpdateJournal } from './journal.js';
import { layoutOf } from './layout.js';
import { realApplyPorts } from './real-ports.js';
import { checkJournalTrust, ownTrust, type JournalTrust } from './trust.js';
import type { PublicKeyResult } from '../verify.js';

export interface RecoverAtStartInput {
  /** The executable that is running (`process.execPath` in the single executable). */
  readonly execPath: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The ports of the applier; the default is the real ones. The tests give fakes. */
  readonly ports?: ((input: { journalDataDir: string }) => ApplyPorts) | undefined;
  /** The key and the platform the journal is checked with; the default is the key of this build. */
  readonly trust?: { readonly key: PublicKeyResult; readonly platform: string } | undefined;
}

function appendLog(file: string): Pick<Logger, 'info' | 'warn' | 'error'> {
  const write =
    (level: string) =>
    (fields: unknown, message?: string): void => {
      try {
        const extra = typeof fields === 'object' && fields !== null ? fields : {};
        const text = typeof fields === 'string' ? fields : (message ?? '');
        appendFileSync(
          file,
          `${JSON.stringify({ time: new Date().toISOString(), level, msg: text, ...extra })}\n`,
        );
      } catch {
        // Nothing to tell it to.
      }
    };
  return { info: write('info'), warn: write('warn'), error: write('error') } as Pick<
    Logger,
    'info' | 'warn' | 'error'
  >;
}

/**
 * What every start of `ot` does first in the single executable (Phase 10, P8; architecture 5.21):
 * if the journal of a swap is there and its applier is dead, finish or undo the swap. It never
 * throws and never starts the old daemon (the command that is running does that when it needs it).
 * With no journal it reads one small file and returns.
 */
export async function recoverAtStart(input: RecoverAtStartInput): Promise<RecoveryResult> {
  try {
    const journalFile = join(dirname(input.execPath), 'update-state.json');
    const reading = await readJournal(journalFile);
    if (reading.kind !== 'ok')
      return reading.kind === 'corrupt' ? { kind: 'corrupt' } : { kind: 'none' };
    const layout = layoutOf(reading.journal.exe);
    // The journal is of this installation: its executable is the one that is running.
    if (layout.exe !== join(dirname(input.execPath), basename(input.execPath))) {
      return { kind: 'none' };
    }
    const { key, platform } = input.trust ?? ownTrust();
    const trust = (journal: UpdateJournal): Promise<JournalTrust> =>
      checkJournalTrust({ layout, journal, key, platform });
    // Before the ports are built: a journal that no signed manifest backs reaches nothing.
    if (!FINAL_STEPS.includes(reading.journal.step)) {
      const trusted = await trust(reading.journal);
      if (!trusted.ok) {
        appendLog(join(layout.folder, 'update-apply.log')).error(
          { step: reading.journal.step, to: reading.journal.to, detail: trusted.detail },
          'update: the journal is not backed by a signed manifest; ignored',
        );
        return { kind: 'untrusted', detail: trusted.detail };
      }
    }
    const logger = appendLog(join(layout.folder, 'update-apply.log'));
    const ports =
      input.ports?.({ journalDataDir: reading.journal.dataDir }) ??
      realApplyPorts({ layout, journal: reading.journal, logger, env: input.env });
    return await recoverInterrupted(layout, ports, false, trust);
  } catch {
    return { kind: 'none' };
  }
}
