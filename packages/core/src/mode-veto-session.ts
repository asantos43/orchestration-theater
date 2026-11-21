// SPDX-License-Identifier: MPL-2.0
import type { Disposable } from './disposable.js';
import type { ConfigValue, ContentBlock } from './normalized-update.js';
import type {
  AgentSession,
  PromptOutcome,
  SessionCommand,
  SessionConfigOption,
  UpdateListener,
} from './ports/agent-session.js';

/**
 * Decides whether a `setConfig(id, value)` may go to the client: the refusal to reject with
 * (a `PermissionDenied`), or `undefined` to let it through. It receives the options the session
 * announced, so it can tell which one is the mode.
 */
export type ConfigRefusal = (
  id: string,
  value: ConfigValue,
  options: readonly SessionConfigOption[],
) => Error | undefined;

/**
 * The session the {@link ClientAdapter} base hands out: the real session with `setConfig` put
 * behind the veto of the mode (architecture 5.8, `bypass`). [proposta] A refused change rejects
 * with the error the veto gave and sends nothing to the client; everything else, `setConfig` of
 * the model or the effort included, goes through as it is. It is a wrapper, not a transport:
 * every session of every client passes through the base, on a process of its own or a shared one.
 */
export class ModeVetoSession implements AgentSession {
  readonly #inner: AgentSession;
  readonly #refusal: ConfigRefusal;

  constructor(inner: AgentSession, refusal: ConfigRefusal) {
    this.#inner = inner;
    this.#refusal = refusal;
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

  get availableCommands(): readonly SessionCommand[] {
    return this.#inner.availableCommands ?? [];
  }

  prompt(blocks: readonly ContentBlock[]): Promise<PromptOutcome> {
    return this.#inner.prompt(blocks);
  }

  onUpdate(listener: UpdateListener): Disposable {
    return this.#inner.onUpdate(listener);
  }

  cancel(): Promise<void> {
    return this.#inner.cancel();
  }

  setConfig(id: string, value: ConfigValue): Promise<void> {
    const refusal = this.#refusal(id, value, this.#inner.configOptions);
    if (refusal !== undefined) return Promise.reject(refusal);
    return this.#inner.setConfig(id, value);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}
