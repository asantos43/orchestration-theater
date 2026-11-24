// SPDX-License-Identifier: MPL-2.0
import { CLOCK_PORT_VERSION } from '@otheater/core';
import { describeClockConformance } from '@otheater/sdk';
import { describe, expect, it } from 'vitest';
import { ExampleClock, ExampleClockConfigSchema, exampleClockAdapter } from './index.js';

// The suite of the port, the same one that `SystemClock` and `FakeClock` run. A real clock, so
// `advance` lets a little real time pass.
describeClockConformance('ExampleClock', () => ({
  clock: new ExampleClock(),
  advance: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms + 10);
    }),
}));

describe('the identity of the adapter', () => {
  it('declares the Clock port and a range that covers the version of the port', () => {
    expect(exampleClockAdapter.implements).toEqual({
      port: 'Clock',
      range: `^${CLOCK_PORT_VERSION}`,
    });
  });

  it('refuses an unknown option in its configuration', () => {
    expect(ExampleClockConfigSchema.safeParse({}).success).toBe(true);
    expect(ExampleClockConfigSchema.safeParse({ tick: 1 }).success).toBe(false);
  });
});
