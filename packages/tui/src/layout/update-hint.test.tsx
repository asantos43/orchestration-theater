// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp } from '../ink.test-support.js';
import { fakeOnline, seedStores } from '../layout.test-support.js';
import { hintOf } from './use-update-status.js';

/** The note in the top row about a new version (Phase 10, P7). [proposta] */

afterEach(cleanupApps);

const base = { mode: 'notify', effectiveMode: 'notify', found: null, ready: null };

describe('hintOf', () => {
  it('says nothing without a version, without an answer, or with the mode off', () => {
    expect(hintOf(undefined)).toBeUndefined();
    expect(hintOf(base)).toBeUndefined();
    expect(hintOf({ ...base, mode: 'off', effectiveMode: 'off', found: '1.0.0' })).toBeUndefined();
  });

  it('a version found is a note; a version ready is the one to apply, in notify only', () => {
    expect(hintOf({ ...base, found: '1.0.0' })).toEqual({
      version: '1.0.0',
      ready: false,
      apply: false,
    });
    expect(hintOf({ ...base, found: '1.0.0', ready: '1.0.0' })).toEqual({
      version: '1.0.0',
      ready: true,
      apply: true,
    });
    expect(hintOf({ ...base, effectiveMode: 'check', found: '1.0.0', ready: '1.0.0' })?.apply).toBe(
      false,
    );
  });
});

async function open(update: Record<string, unknown> | 'error', locale?: string) {
  const online = fakeOnline();
  seedStores(online.stores);
  const fake = online.client as unknown as {
    call: (route: { path: string }, ...rest: unknown[]) => unknown;
  };
  const original = fake.call.bind(online.client);
  fake.call = (route, ...rest) =>
    route.path === '/v1/updates'
      ? update === 'error'
        ? Promise.reject(new Error('no service'))
        : Promise.resolve(update)
      : original(route, ...rest);
  const app = await renderApp({
    connector: online.connector,
    size: { columns: 140, rows: 42 },
    ...(locale === undefined ? {} : { systemLocale: locale }),
  });
  await app.waitForText(locale === undefined ? 'SCENARIOS' : 'CENÁRIOS');
  return app;
}

describe('the top row', () => {
  it('shows the version the daemon has ready, with the label of the action', async () => {
    const app = await open({ ...base, found: '0.6.0', ready: '0.6.0' });
    expect(await app.waitForText('↑ 0.6.0 ready')).toContain('[apply]');
  });

  it('shows a version that was only found, with no action', async () => {
    const app = await open({ ...base, found: '0.6.0' });
    const frame = await app.waitForText('↑ 0.6.0 found');
    expect(frame).not.toContain('[apply]');
  });

  it('speaks the language of the interface', async () => {
    const app = await open({ ...base, found: '0.6.0', ready: '0.6.0' }, 'pt_BR.UTF-8');
    expect(await app.waitForText('↑ 0.6.0 pronta')).toContain('[aplicar]');
  });

  it('leaves the row as it was when the daemon has no service', async () => {
    const app = await open('error');
    const frame = await app.settle();
    expect(frame).not.toContain('↑');
  });
});
