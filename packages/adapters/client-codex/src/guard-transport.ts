// SPDX-License-Identifier: MPL-2.0
import {
  PermissionDenied,
  type AgentSession,
  type ConfigValue,
  type ContentBlock,
  type Disposable,
  type PromptOutcome,
  type SessionLoadParams,
  type SessionOpenParams,
  type SessionTransport,
  type UpdateListener,
} from '@otheater/core';
import { CODEX_CONFIG_IDS, assertModeAllowed, type ModePolicy } from './modes.js';

/** An `AgentSession` whose `setConfig('mode', ...)` goes through the veto before it reaches the client. */
class ModeGuardedSession implements AgentSession {
  readonly #inner: AgentSession;
  readonly #modes: ModePolicy;

  constructor(inner: AgentSession, modes: ModePolicy) {
    this.#inner = inner;
    this.#modes = modes;
  }

  get sessionId(): string {
    return this.#inner.sessionId;
  }

  get canLoad(): boolean {
    return this.#inner.canLoad;
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
    if (id === CODEX_CONFIG_IDS.mode) {
      if (typeof value !== 'string') {
        return Promise.reject(
          new PermissionDenied('codex: the mode has to be one of the allowed mode ids'),
        );
      }
      const refusal = refusalOf(this.#modes, value);
      if (refusal !== undefined) return Promise.reject(refusal);
    }
    return this.#inner.setConfig(id, value);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

/**
 * Wraps a transport so that every session it opens refuses `setConfig('mode', <vetoed or not
 * allowed>)` with `PermissionDenied`, before anything reaches the client. The base has no hook
 * between the daemon and `session/set_config_option`, and `agent-full-access` cannot be removed
 * from the client's catalog (Phase 0, item 8) [V], so the composition root passes the transport
 * through here (`CodexAdapter.guardTransport`).
 */
export function guardModes(transport: SessionTransport, modes: ModePolicy): SessionTransport {
  return {
    id: transport.id,
    open: async (params: SessionOpenParams) =>
      new ModeGuardedSession(await transport.open(params), modes),
    load: async (params: SessionLoadParams) =>
      new ModeGuardedSession(await transport.load(params), modes),
  };
}

function refusalOf(modes: ModePolicy, mode: string): PermissionDenied | undefined {
  try {
    assertModeAllowed(modes, mode);
    return undefined;
  } catch (error) {
    if (error instanceof PermissionDenied) return error;
    throw error;
  }
}
