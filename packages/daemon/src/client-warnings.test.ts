// SPDX-License-Identifier: MPL-2.0
import type { ClientAdapterWarning } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { clientWarningLog } from './client-warnings.js';
import { captureLogger, RecordingSituations } from './test-helpers.js';

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

  it('daemon.notice client_warning: what is logged is also an event, and what the log thins out is thinned out (P24, N146)', () => {
    const { logger } = captureLogger();
    const situations = new RecordingSituations();
    const log = clientWarningLog('once', logger, situations);
    log(EXEMPT, '0.1.0');
    log(EXEMPT, '0.1.0');
    log(UNENFORCED, '0.1.0');
    log(
      {
        kind: 'conformance_probe_threw',
        clientId: 'codex',
        probeId: 'p1',
        error: new Error('boom sk-ant-api03-secretsecretsecretsecret'),
      } as unknown as ClientAdapterWarning,
      '0.1.0',
    );
    log(
      {
        kind: 'client_version_corrected',
        clientId: 'codex',
        from: { version: '2.6.0', source: 'package_json' },
        to: { version: '2.7.0', source: 'initialize' },
        adapterVersion: '0.1.0+codex.2.7.0',
        agentName: 'codex-acp',
      },
      '0.1.0+codex.2.7.0',
    );
    const notices = situations.of('daemon.notice') as {
      kind: string;
      subject: string;
      detail: string;
    }[];
    expect(notices.map((notice) => notice.kind)).toEqual(Array<string>(4).fill('client_warning'));
    expect(notices.map((notice) => notice.subject)).toEqual(['codex', 'codex', 'codex', 'codex']);
    expect(notices.map((notice) => notice.detail)).toEqual([
      'catalog_probe_exempt: network',
      'unenforced: network',
      expect.stringContaining('conformance_probe_threw: p1: ') as string,
      'client_version_corrected: 2.6.0 -> 2.7.0 (codex-acp)',
    ]);
    expect(JSON.stringify(notices)).not.toContain('secretsecret');
    // `off` writes no catalog_probe_exempt, in the log or in the event.
    const quiet = new RecordingSituations();
    clientWarningLog('off', logger, quiet)(EXEMPT, '0.1.0');
    expect(quiet.recorded).toEqual([]);
  });

  it.each(['once', 'every', 'off'] as const)(
    '%s: client_version_corrected goes to the info level, every time, with no credential text',
    (mode) => {
      const { logger, lines } = captureLogger();
      const log = clientWarningLog(mode, logger);
      const corrected: ClientAdapterWarning = {
        kind: 'client_version_corrected',
        clientId: 'codex',
        from: { version: '2.6.0', source: 'package_json' },
        to: { version: '2.7.0', source: 'initialize' },
        adapterVersion: '0.1.0+codex.2.7.0',
        agentName: 'codex-acp',
      };
      log(corrected, '0.1.0+codex.2.7.0');
      log(corrected, '0.1.0+codex.2.7.0');
      expect(lines).toHaveLength(2);
      expect(lines[0]?.level).toBe('info');
      expect(lines[0]?.msg).toBe('client version corrected by the initialize');
      expect(lines[0]?.fields).toEqual({
        client: 'codex',
        from: { version: '2.6.0', source: 'package_json' },
        to: { version: '2.7.0', source: 'initialize' },
        adapterVersion: '0.1.0+codex.2.7.0',
        agentName: 'codex-acp',
      });
    },
  );
});
