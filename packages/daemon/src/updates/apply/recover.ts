// SPDX-License-Identifier: MPL-2.0
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../../logger.js';
import { recoverInterrupted, type ApplyPorts, type RecoveryResult } from './applier.js';
import { readJournal } from './journal.js';
import { layoutOf } from './layout.js';
import { realApplyPorts } from './real-ports.js';

export interface RecoverAtStartInput {
  /** The executable that is running (`process.execPath` in the single executable). */
  readonly execPath: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The ports of the applier; the default is the real ones. The tests give fakes. */
  readonly ports?: ((input: { journalDataDir: string }) => ApplyPorts) | undefined;
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
    if (dirname(layout.exe) !== dirname(journalFile)) return { kind: 'none' };
    const logger = appendLog(join(layout.folder, 'update-apply.log'));
    const ports =
      input.ports?.({ journalDataDir: reading.journal.dataDir }) ??
      realApplyPorts({ layout, journal: reading.journal, logger, env: input.env });
    return await recoverInterrupted(layout, ports, false);
  } catch {
    return { kind: 'none' };
  }
}
