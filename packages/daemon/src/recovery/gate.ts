// SPDX-License-Identifier: MPL-2.0

/**
 * The door the commands go through while the reconciliation of a start-up runs (architecture
 * 5.21: "os comandos que mudam estado esperam"). It starts closed; `open` lets every waiting call
 * through, and later calls pass at once. [proposta] The MCP server and the Producer channel both
 * wait on it for every call, reads included: the wait is a few seconds at most, and a read taken
 * halfway through the reconciliation would show a state that is about to change.
 */
export class RecoveryGate {
  readonly #opened: Promise<void>;
  #open: () => void = () => undefined;
  #isOpen = false;

  constructor(open = false) {
    this.#opened = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
    if (open) this.open();
  }

  get isOpen(): boolean {
    return this.#isOpen;
  }

  /** Lets the waiting calls through. Idempotent. */
  open(): void {
    this.#isOpen = true;
    this.#open();
  }

  /** Resolves once the gate is open (at once when it already is). */
  wait(): Promise<void> {
    return this.#opened;
  }
}
