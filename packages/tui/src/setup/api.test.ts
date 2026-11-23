// SPDX-License-Identifier: MPL-2.0
import type { ApiClient } from '@otheater/client';
import { API_ROUTES } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { setupApiOf } from './api.js';

interface Call {
  readonly route: unknown;
  readonly options:
    { params?: unknown; body?: unknown; headers?: Record<string, string> } | undefined;
}

function recorder(): { readonly api: ReturnType<typeof setupApiOf>; readonly calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    call: (route: unknown, options?: Call['options']) => {
      calls.push({ route, options });
      return Promise.resolve({ ok: true });
    },
  } as unknown as ApiClient;
  return { api: setupApiOf(client), calls };
}

describe('setupApiOf', () => {
  it('calls the six routes of the assistant with the params and the body of each', async () => {
    const { api, calls } = recorder();
    await api.overview();
    await api.start('add_account');
    await api.submit('run1', { step: 'preset', input: { preset: 'balanced' } });
    await api.back('run1');
    await api.confirm('run1');
    await api.cancel('run1');
    expect(calls.map((call) => call.route)).toEqual([
      API_ROUTES.getSetup,
      API_ROUTES.startSetup,
      API_ROUTES.submitSetupStep,
      API_ROUTES.backSetup,
      API_ROUTES.confirmSetup,
      API_ROUTES.cancelSetup,
    ]);
    expect(calls[1]?.options?.params).toEqual({ flow: 'add_account' });
    expect(calls[2]?.options?.params).toEqual({ runId: 'run1' });
    expect(calls[2]?.options?.body).toEqual({ step: 'preset', input: { preset: 'balanced' } });
    expect(calls[3]?.options?.params).toEqual({ runId: 'run1' });
  });

  it('gives every command its own Idempotency-Key and the read none', async () => {
    const { api, calls } = recorder();
    await api.overview();
    await api.back('run1');
    await api.back('run1');
    expect(calls[0]?.options?.headers).toBeUndefined();
    const keys = calls.slice(1).map((call) => call.options?.headers?.['idempotency-key']);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('gives the step that adds an account the routes the tab Settings uses', async () => {
    const { api, calls } = recorder();
    const accounts = api.accounts;
    if (accounts === undefined) throw new Error('no accounts');
    await accounts.addProfile({
      client: 'claude-code',
      name: 'work',
      kind: 'token_plan',
      provider: 'anthropic',
    });
    await accounts.startLogin('claude-code/work');
    await accounts.cancelLogin('claude-code/work');
    expect(calls.map((call) => call.route)).toEqual([
      API_ROUTES.addProfile,
      API_ROUTES.startProfileLogin,
      API_ROUTES.cancelProfileLogin,
    ]);
    expect(calls[1]?.options?.params).toEqual({ client: 'claude-code', name: 'work' });
  });
});
