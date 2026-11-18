// SPDX-License-Identifier: MPL-2.0
import type { JsonObject } from '@otheater/core';

/**
 * Serialises the choice of a step per attempt and tool, and remembers the steps a call of this
 * process is running. A "before" with no "after" is an interrupted run only when no call of this
 * process holds it: two identical calls in flight are two steps, not one step and its retry.
 */
export class StepGate {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #busy = new Map<string, Set<number>>();

  async #exclusive<T>(base: string, body: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(base) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(
      base,
      previous.then(() => mine),
    );
    await previous;
    try {
      return await body();
    } finally {
      release();
    }
  }

  /**
   * Picks the step of a call and holds it until `release`. `pick` receives a predicate telling
   * which steps are held by a running call and returns the step number it would take.
   */
  async reserve(
    base: string,
    pick: (busy: (step: number) => boolean) => Promise<number | { replay: JsonObject }>,
  ): Promise<{ readonly step: number; release(): void } | { readonly replay: JsonObject }> {
    return this.#exclusive(base, async () => {
      const held = this.#busy.get(base) ?? new Set<number>();
      this.#busy.set(base, held);
      const picked = await pick((step) => held.has(step));
      if (typeof picked !== 'number') return { replay: picked.replay };
      // A fresh number follows every step in flight: their records may not be written yet.
      const step = held.has(picked) ? Math.max(...held) + 1 : picked;
      held.add(step);
      return {
        step,
        release: () => {
          held.delete(step);
          if (held.size === 0) this.#busy.delete(base);
        },
      };
    });
  }
}
