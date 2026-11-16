// SPDX-License-Identifier: MPL-2.0
import type { ClientAdapterWarning } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { clientWarningLog } from './client-warnings.js';
import { captureLogger } from './test-helpers.js';

const EXEMPT: ClientAdapterWarning = {
  kind: 'catalog_probe_exempt',
  clientId: 'codex',
  short: ['network'],
};
const UNENFORCED: ClientAdapterWarning = {
  kind: 'unenforced',
  clientId: 'codex',
  short: ['network'],
};

function kinds(lines: ReturnType<typeof captureLogger>['lines']): string[] {
  return lines.map((l) => (l.fields.warning as { kind: string }).kind);
}

describe('clientWarningLog', () => {
  it('once: logs catalog_probe_exempt the first time for each client and adapter version', () => {
    const { logger, lines } = captureLogger();
    const log = clientWarningLog('once', logger);
    log(EXEMPT, '0.1.0');
    log(EXEMPT, '0.1.0');
    log(EXEMPT, '0.1.0+codex.1');
    log({ ...EXEMPT, clientId: 'claude-code' }, '0.1.0');
    log({ ...EXEMPT, clientId: 'claude-code' }, '0.1.0');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.fields.client)).toEqual(['codex', 'codex', 'claude-code']);
  });

  it('once: the memory belongs to one log, so a new run logs again', () => {
    const { logger, lines } = captureLogger();
    clientWarningLog('once', logger)(EXEMPT, '0.1.0');
    clientWarningLog('once', logger)(EXEMPT, '0.1.0');
    expect(lines).toHaveLength(2);
  });

  it('every: logs every catalog_probe_exempt', () => {
    const { logger, lines } = captureLogger();
    const log = clientWarningLog('every', logger);
    for (let i = 0; i < 3; i += 1) log(EXEMPT, '0.1.0');
    expect(lines).toHaveLength(3);
  });

  it('off: logs no catalog_probe_exempt', () => {
    const { logger, lines } = captureLogger();
    const log = clientWarningLog('off', logger);
    for (let i = 0; i < 3; i += 1) log(EXEMPT, '0.1.0');
    expect(lines).toEqual([]);
  });

  it.each(['once', 'every', 'off'] as const)(
    '%s: the other warnings are always logged, every time',
    (mode) => {
      const { logger, lines } = captureLogger();
      const log = clientWarningLog(mode, logger);
      log(UNENFORCED, '0.1.0');
      log(UNENFORCED, '0.1.0');
      expect(kinds(lines)).toEqual(['unenforced', 'unenforced']);
    },
  );
});
