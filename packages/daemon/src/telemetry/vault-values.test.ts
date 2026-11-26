// SPDX-License-Identifier: MPL-2.0
import { Secret, VaultLocked, type SecretVault } from '@otheater/core';
import { InMemorySecretVault } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import type { DaemonEventPayloads, DaemonEventType } from '@otheater/protocol';
import type { SituationSink } from '../situations.js';
import { captureLogger } from '../test-helpers.js';
import { VaultValues, type VaultValuesOptions } from './vault-values.js';

const MESSAGE =
  'the vault values for the telemetry redaction could not be read; the last ones stand';

/** A vault that fails while `failure` holds an error, and reads the inner one otherwise. */
class FlakyVault {
  failure: Error | undefined;
  readonly inner = new InMemorySecretVault();

  list: SecretVault['list'] = async (...args) => {
    if (this.failure !== undefined) throw this.failure;
    return this.inner.list(...args);
  };
  get: SecretVault['get'] = async (...args) => {
    if (this.failure !== undefined) throw this.failure;
    return this.inner.get(...args);
  };
}

function setup(options: Omit<VaultValuesOptions, 'situations'> = {}) {
  const vault = new FlakyVault();
  const { logger, lines } = captureLogger();
  const notices: DaemonEventPayloads['daemon.notice'][] = [];
  const situations: SituationSink = {
    record<T extends DaemonEventType>(type: T, payload: DaemonEventPayloads[T]) {
      if (type === 'daemon.notice') notices.push(payload as DaemonEventPayloads['daemon.notice']);
    },
  };
  const values = new VaultValues(vault as unknown as SecretVault, logger, {
    ...options,
    situations,
  });
  const said = (level: string) => lines.filter((line) => line.level === level);
  return { vault, values, lines, notices, said };
}

describe('VaultValues: a vault that cannot be read (N331)', () => {
  it('warns once with on_change, again when the reason changes, and says when it reads again', async () => {
    const { vault, values, notices, said } = setup();
    await vault.inner.set('k', new Secret('s3cret-value'));
    await values.refresh();
    expect(values.values()).toEqual(['s3cret-value']);

    vault.failure = new VaultLocked('The vault is locked.');
    await values.refresh();
    await values.refresh();
    await values.refresh();
    // The last values stand while the vault cannot be read.
    expect(values.values()).toEqual(['s3cret-value']);
    expect(said('warn').map((line) => line.msg)).toEqual([MESSAGE]);
    expect(said('debug')).toHaveLength(2);
    expect(notices).toEqual([
      { kind: 'telemetry_vault_unreadable', subject: 'vault', detail: 'The vault is locked.' },
    ]);

    vault.failure = new Error('the keyring went away');
    await values.refresh();
    expect(said('warn')).toHaveLength(2);
    expect(notices.map((notice) => notice.detail)).toEqual([
      'The vault is locked.',
      'the keyring went away',
    ]);

    vault.failure = undefined;
    await values.refresh();
    expect(said('info').map((line) => line.msg)).toEqual([
      'the vault values for the telemetry redaction can be read again',
    ]);
    // A new failure after a good read is told again, even with the same reason.
    vault.failure = new Error('the keyring went away');
    await values.refresh();
    expect(said('warn')).toHaveLength(3);
    expect(notices).toHaveLength(3);
  });

  it('warns at each refresh with every', async () => {
    const { vault, values, notices, said } = setup({ warning: 'every' });
    vault.failure = new VaultLocked('The vault is locked.');
    await values.refresh();
    await values.refresh();
    await values.refresh();
    expect(said('warn')).toHaveLength(3);
    expect(notices).toHaveLength(3);
    vault.failure = undefined;
    await values.refresh();
    expect(said('info')).toHaveLength(0);
  });

  it('keeps it to the debug log with off: no warning, no notice', async () => {
    const { vault, values, notices, said } = setup({ warning: 'off' });
    vault.failure = new VaultLocked('The vault is locked.');
    await values.refresh();
    await values.refresh();
    expect(said('warn')).toHaveLength(0);
    expect(said('debug')).toHaveLength(2);
    expect(notices).toHaveLength(0);
  });

  it('puts no vault value in the log or in the notice', async () => {
    const { vault, values, lines, notices } = setup({ warning: 'every' });
    await vault.inner.set('k', new Secret('s3cret-value'));
    await values.refresh();
    vault.failure = new VaultLocked('The vault is locked.');
    await values.refresh();
    expect(JSON.stringify(lines)).not.toContain('s3cret-value');
    expect(JSON.stringify(notices)).not.toContain('s3cret-value');
  });
});
