// SPDX-License-Identifier: MPL-2.0
import { dirname, join } from 'node:path';
import { runApply } from './applier.js';
import { appendFileLogger } from './file-log.js';
import { readJournal } from './journal.js';
import { layoutOf } from './layout.js';
import { realApplyPorts } from './real-ports.js';
import { checkJournalTrust, ownTrust } from './trust.js';
import type { PublicKeyResult } from '../verify.js';

/** Exit codes of the applier. [proposta] 0: the new version holds; 1: it was taken back or left; 2: it could not start. */
export const APPLY_EXIT_APPLIED = 0;
export const APPLY_EXIT_NOT_APPLIED = 1;
export const APPLY_EXIT_USAGE = 2;

/**
 * The applier has no terminal: what ends it in a way `runApply` does not report (an error nothing
 * caught, the exit itself) is written to its log. Returns the function that takes the handlers off.
 */
function guardProcess(logger: ReturnType<typeof appendFileLogger>): () => void {
  const onCrash =
    (origin: string) =>
    (error: unknown): void => {
      logger.error({ err: error, origin }, 'apply-update: stopped by an error nothing caught');
      process.exitCode = APPLY_EXIT_NOT_APPLIED;
    };
  const onUncaught = onCrash('uncaughtException');
  const onRejected = onCrash('unhandledRejection');
  const onExit = (code: number): void => {
    logger.info({ code }, 'apply-update: exit');
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejected);
  process.on('exit', onExit);
  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejected);
    process.off('exit', onExit);
  };
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
  const logger = appendFileLogger(join(layout.folder, 'update-apply.log'));
  logger.info(
    {
      from: reading.journal.from,
      to: reading.journal.to,
      step: reading.journal.step,
      platform: process.platform,
      ppid: process.ppid,
    },
    'apply-update: started',
  );
  const unguard = guardProcess(logger);
  try {
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
    try {
      const outcome = await runApply(layout, ports, reading.journal);
      logger.info({ outcome }, 'apply-update: ended');
      process.exitCode = outcome.kind === 'committed' ? APPLY_EXIT_APPLIED : APPLY_EXIT_NOT_APPLIED;
    } catch (error) {
      // The journal stays at the step it reached: the next start of `ot` finishes or undoes the swap.
      logger.error({ err: error }, 'apply-update: the swap stopped on an error');
      process.exitCode = APPLY_EXIT_NOT_APPLIED;
    }
  } finally {
    unguard();
  }
}
