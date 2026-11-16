// SPDX-License-Identifier: MPL-2.0

/**
 * Something to release: a listener subscription, a watcher. `dispose()` is idempotent and never
 * throws. [proposta] This is a plain method, not the `[Symbol.dispose]` of the language's
 * `Disposable`: core does not depend on that lib typing, and the port contracts use it as a handle
 * (`const sub = session.onUpdate(fn); ...; sub.dispose()`).
 */
export interface Disposable {
  dispose(): void;
}
