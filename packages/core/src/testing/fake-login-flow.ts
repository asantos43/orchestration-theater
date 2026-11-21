// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, Cancelled, InvalidInput } from '../errors.js';
import type { LoginFlow } from '../ports/client-adapter.js';

export interface FakeLoginFlowOptions {
  readonly mode: LoginFlow['mode'];
  readonly url?: string;
  readonly code?: string;
  /** Whether the flow takes the code the browser shows (`submitCode`). Default `true`. */
  readonly acceptsCode?: boolean;
  /** The code `submitCode` waits for before the login ends by itself; none: only `finish()` ends it. */
  readonly expectCode?: string;
}

/**
 * A `LoginFlow` that runs nothing, for the tests of whoever opens a login (P5 of Phase 7, N186). It
 * stands for the process of the official login: `cancelled` is "the process was killed", `submitted`
 * is what was written to its standard input, and `finish()` / `fail()` are the process ending. The
 * three modes differ only in what the flow shows (`url`, `code`) and whether it takes a code.
 */
export class FakeLoginFlow implements LoginFlow {
  readonly mode: LoginFlow['mode'];
  readonly url?: string;
  readonly code?: string;
  readonly submitCode?: (code: string) => Promise<void>;
  /** The lines `submitCode` was given, in order. */
  readonly submitted: string[] = [];
  /** `cancel()` was called while the login was running: the process was killed. */
  cancelled = false;
  readonly #done: Promise<void>;
  #resolve: () => void = () => undefined;
  #reject: (error: unknown) => void = () => undefined;
  #ended = false;

  constructor(options: FakeLoginFlowOptions) {
    this.mode = options.mode;
    if (options.url !== undefined) this.url = options.url;
    if (options.code !== undefined) this.code = options.code;
    this.#done = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // The login may end with nobody awaiting `complete()`.
    this.#done.catch(() => undefined);
    if (options.acceptsCode !== false) {
      this.submitCode = (given) => {
        const line = given.trim();
        if (line === '' || /[\r\n]/u.test(line)) {
          return Promise.reject(new InvalidInput('the login code must be one non-empty line'));
        }
        if (this.#ended) return Promise.reject(new AdapterUnavailable('the login already ended'));
        this.submitted.push(line);
        if (options.expectCode !== undefined && line === options.expectCode) this.finish();
        return Promise.resolve();
      };
    }
  }

  /** The login ended well (exit code 0). */
  finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#resolve();
  }

  /** The login ended badly: `error` is what `complete()` rejects with. */
  fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#reject(error);
  }

  get ended(): boolean {
    return this.#ended;
  }

  complete(): Promise<void> {
    return this.#done;
  }

  cancel(): Promise<void> {
    if (this.#ended) return Promise.resolve();
    this.cancelled = true;
    this.fail(new Cancelled('the login was cancelled'));
    return Promise.resolve();
  }
}
