// SPDX-License-Identifier: MPL-2.0
import type { Disposable } from './disposable.js';
import { PermissionDenied } from './errors.js';
import type {
  AgentSession,
  PromptOutcome,
  SessionConfigOption,
  UpdateListener,
} from './ports/agent-session.js';

/**
 * The session a catalog read gets (`SessionStartOptions.purpose: 'catalog-probe'`): the real
 * session with the ways to make the client work taken away. [proposta] It is what makes the
 * exemption from `security.unenforced` safe: a session that may skip the guarantee-layer check can
 * never run a turn.
 *
 * Exported for client adapters that do not extend the `ClientAdapter` base: wrap the session of a
 * `purpose: 'catalog-probe'` call in it to meet the contract of `SessionStartOptions.purpose`.
 *
 * - `prompt` rejects with `PermissionDenied` and sends nothing to the client.
 * - `setConfig` rejects with `PermissionDenied` too: it changes how the client will behave on a
 *   turn that never comes, and the reader has no need of it (the options it reads are the ones
 *   the client announced, `configOptions`, plus the ones the setup of the policy already applied).
 * - `configOptions`, `sessionId`, `canLoad`, `onUpdate`, `cancel` and `close` go through: none of
 *   them makes the client act on the worktree, and the reader must be able to read and let go.
 */
export class CatalogProbeSession implements AgentSession {
  readonly #inner: AgentSession;

  constructor(inner: AgentSession) {
    this.#inner = inner;
  }

  get sessionId(): string {
    return this.#inner.sessionId;
  }

  get canLoad(): boolean {
    return this.#inner.canLoad;
  }

  get configOptions(): readonly SessionConfigOption[] {
    return this.#inner.configOptions;
  }

  prompt(): Promise<PromptOutcome> {
    return Promise.reject(
      new PermissionDenied('this session was opened to read the catalog and never runs a prompt'),
    );
  }

  setConfig(): Promise<void> {
    return Promise.reject(
      new PermissionDenied(
        'this session was opened to read the catalog and takes no config change',
      ),
    );
  }

  onUpdate(listener: UpdateListener): Disposable {
    return this.#inner.onUpdate(listener);
  }

  cancel(): Promise<void> {
    return this.#inner.cancel();
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}
