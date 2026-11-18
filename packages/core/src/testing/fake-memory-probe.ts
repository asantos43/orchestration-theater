// SPDX-License-Identifier: MPL-2.0
import type { AdapterImplements } from '../ports/adapter.js';
import { MEMORY_PROBE_PORT_VERSION, type MemoryProbe } from '../ports/memory-probe.js';

/**
 * A `MemoryProbe` the test drives: `set(mb)` is the free RAM the next read sees, `undefined` is a
 * machine that cannot tell, and `setTree(pid, mb)` is what `treeMb` answers for a process.
 */
export class FakeMemoryProbe implements MemoryProbe {
  readonly id = 'fake';
  readonly implements: AdapterImplements = {
    port: 'MemoryProbe',
    range: `^${MEMORY_PROBE_PORT_VERSION}`,
  };
  #available: number | undefined;
  readonly #trees = new Map<number, number>();
  /** How many times `availableMb` was read. */
  reads = 0;

  constructor(availableMb?: number) {
    this.#available = availableMb;
  }

  set(availableMb: number | undefined): void {
    this.#available = availableMb;
  }

  setTree(pid: number, mb: number): void {
    this.#trees.set(pid, mb);
  }

  availableMb(): Promise<number | undefined> {
    this.reads += 1;
    return Promise.resolve(this.#available);
  }

  treeMb(pid: number): Promise<number | undefined> {
    return Promise.resolve(this.#trees.get(pid));
  }
}
