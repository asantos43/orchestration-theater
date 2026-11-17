// SPDX-License-Identifier: MPL-2.0

/**
 * A first-in, first-out counting semaphore: the heavy commands (`tools.heavy_concurrency`, N98)
 * take a permit and the others wait their turn. The limit can change (a reloaded config); a
 * smaller limit never takes a permit from a command that already runs.
 */
export class Semaphore {
  #limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = Semaphore.#checked(limit);
  }

  static #checked(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(
        `the limit of a semaphore must be an integer >= 1, got ${String(limit)}`,
      );
    }
    return limit;
  }

  get limit(): number {
    return this.#limit;
  }

  /** Commands running now. */
  get active(): number {
    return this.#active;
  }

  /** Commands waiting for a permit. */
  get waiting(): number {
    return this.#waiting.length;
  }

  setLimit(limit: number): void {
    this.#limit = Semaphore.#checked(limit);
    this.#drain();
  }

  /** Resolves with a `release` function once a permit is free. `release` is idempotent. */
  async acquire(): Promise<() => void> {
    if (this.#active >= this.#limit || this.#waiting.length > 0) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.#limit) {
      const next = this.#waiting.shift();
      if (next === undefined) return;
      this.#active += 1;
      next();
    }
  }
}
