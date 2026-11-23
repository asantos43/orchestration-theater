// SPDX-License-Identifier: MPL-2.0
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../../logger.js';
import { runApply } from './applier.js';
import { readJournal } from './journal.js';
import { layoutOf } from './layout.js';
import { realApplyPorts } from './real-ports.js';
import { checkJournalTrust, ownTrust } from './trust.js';
import type { PublicKeyResult } from '../verify.js';

/** Exit codes of the applier. [proposta] 0: the new version holds; 1: it was taken back or left; 2: it could not start. */
export const APPLY_EXIT_APPLIED = 0;
export const APPLY_EXIT_NOT_APPLIED = 1;
export const APPLY_EXIT_USAGE = 2;

/** A logger that appends to a file beside the executable; the applier has no terminal to write to. */
function fileLogger(file: string): Pick<Logger, 'info' | 'warn' | 'error'> {
  const write =
    (level: string) =>
    (fields: unknown, message?: string): void => {
      const text = typeof fields === 'string' ? fields : (message ?? '');
      const extra = typeof fields === 'object' && fields !== null ? fields : {};
      try {
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
 * `--ot-internal=apply-update --journal <file>` (Phase 10, P8): the swap, run by the executable of
 * the new version while the old daemon is gone. The journal names the data folder and the steps;
 * the executable that is replaced is the one the journal names. It sets the exit code and never throws.
 */
export async function runApplyUpdate(
  argv: readonly string[],
  options: { readonly trust?: { readonly key: PublicKeyResult; readonly platform: string } } = {},
): Promise<void> {
  const at = argv.indexOf('--journal');
  const file = at < 0 ? undefined : argv[at + 1];
  if (file === undefined) {
    process.stderr.write('otheater: apply-update needs --journal <file>\n');
    process.exitCode = APPLY_EXIT_USAGE;
    return;
  }
  const reading = await readJournal(file);
  if (reading.kind !== 'ok') {
    process.stderr.write(`otheater: apply-update: the journal cannot be read (${reading.kind})\n`);
    process.exitCode = APPLY_EXIT_USAGE;
    return;
  }
  const layout = layoutOf(reading.journal.exe);
  if (dirname(layout.exe) !== dirname(file)) {
    process.stderr.write('otheater: apply-update: the journal is not of this installation\n');
    process.exitCode = APPLY_EXIT_USAGE;
    return;
  }
  const logger = fileLogger(join(layout.folder, 'update-apply.log'));
  // The journal is not followed unless a signed manifest backs it (P8a).
  const { key, platform } = options.trust ?? ownTrust();
  const trusted = await checkJournalTrust({ layout, journal: reading.journal, key, platform });
  if (!trusted.ok) {
    logger.error(
      { to: reading.journal.to, detail: trusted.detail },
      'update: the journal is not backed by a signed manifest; nothing was done',
    );
    process.stderr.write(
      `otheater: apply-update: the journal is not trusted (${trusted.detail})\n`,
    );
    process.exitCode = APPLY_EXIT_USAGE;
    return;
  }
  const ports = realApplyPorts({ layout, journal: reading.journal, logger });
  const outcome = await runApply(layout, ports, reading.journal);
  process.exitCode = outcome.kind === 'committed' ? APPLY_EXIT_APPLIED : APPLY_EXIT_NOT_APPLIED;
}
