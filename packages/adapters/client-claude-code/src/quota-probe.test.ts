// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, type QuotaProbe } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { ClaudeQuotaProbe } from './quota-probe.js';

describe('ClaudeQuotaProbe', () => {
  const probe = new ClaudeQuotaProbe();

  it('implements the QuotaProbe port and names the client', () => {
    expect(probe.id).toBe('claude-code');
    expect(probe.implements.port).toBe('QuotaProbe');
  });

  it('says it reads no window until Phase 5', () => {
    expect(probe.capabilities().windows).toEqual([]);
  });

  it('rejects a read with AdapterUnavailable', async () => {
    await expect(
      (probe as QuotaProbe).read({ client: 'claude-code', profile: 'p' }),
    ).rejects.toBeInstanceOf(AdapterUnavailable);
  });
});
