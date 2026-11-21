// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { FakeSetupApi, requestError } from './fake-api.test-support.js';
import { firstRunNeeded } from './first-run.js';

describe('firstRunNeeded', () => {
  it('is what the daemon says', async () => {
    expect(await firstRunNeeded(new FakeSetupApi({ firstRunNeeded: true }), 1000)).toBe(true);
    expect(await firstRunNeeded(new FakeSetupApi({ firstRunNeeded: false }), 1000)).toBe(false);
  });

  it('gives up when the daemon does not answer in time', async () => {
    const api = new FakeSetupApi();
    api.hang = true;
    await expect(firstRunNeeded(api, 30)).rejects.toThrow('no answer in 30 ms');
  });

  it('passes on the error of the daemon', async () => {
    const api = new FakeSetupApi();
    api.failNext = requestError('unavailable', 503, 'The daemon is starting.');
    await expect(firstRunNeeded(api, 1000)).rejects.toThrow('The daemon is starting.');
  });
});
