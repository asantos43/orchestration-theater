// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { RecoveryGate } from './gate.js';

describe('RecoveryGate', () => {
  it('holds the callers until it opens, then lets every one of them through', async () => {
    const gate = new RecoveryGate();
    expect(gate.isOpen).toBe(false);
    const order: string[] = [];
    const first = gate.wait().then(() => order.push('first'));
    const second = gate.wait().then(() => order.push('second'));
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.open();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(gate.isOpen).toBe(true);
  });

  it('lets later calls through at once and opening twice does no harm', async () => {
    const gate = new RecoveryGate();
    gate.open();
    gate.open();
    await expect(gate.wait()).resolves.toBeUndefined();
    expect(gate.isOpen).toBe(true);
  });

  it('can start open', async () => {
    const gate = new RecoveryGate(true);
    expect(gate.isOpen).toBe(true);
    await expect(gate.wait()).resolves.toBeUndefined();
  });
});
