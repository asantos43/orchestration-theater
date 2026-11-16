// SPDX-License-Identifier: MPL-2.0
import type { Adapter } from './adapter.js';

/** Semver of the `LocalModelServer` port contract (architecture 5.18, "Versão dos contratos"). */
export const LOCAL_MODEL_SERVER_PORT_VERSION = '0.1.0';

export const SERVER_HEALTH_STATUSES = ['ok', 'loading', 'unreachable'] as const;

/** State of the server: serving, starting up/loading a model, or not answering. */
export type ServerHealthStatus = (typeof SERVER_HEALTH_STATUSES)[number];

export interface ServerHealth {
  readonly status: ServerHealthStatus;
  /** What the server said, when it said something useful (for the Settings screen). */
  readonly detail?: string;
}

/** A model the instance has loaded or can serve. */
export interface LocalModel {
  readonly id: string;
  /** Context window of the model as loaded (total, not per slot), when the server says it. */
  readonly contextWindow?: number;
}

/**
 * Slots of the instance (architecture 5.9). Both fields are `undefined` when the server does not
 * say: `slots: auto` then falls back to 1 and the setup assistant asks the Producer.
 */
export interface SlotInfo {
  readonly count: number | undefined;
  /** Context window of ONE slot: the total `-c` divided among `--parallel` slots in llama.cpp. */
  readonly contextPerSlot: number | undefined;
}

/**
 * A local model server such as llama.cpp or Ollama (architecture 5.9, 5.18). Not a client of
 * agents: it is where the model runs. The `local` block of a profile (schema in
 * `@otheater/protocol`) picks the adapter by `server` and gives the `url`.
 *
 * Contract:
 * - `health` never rejects because the server is down: it resolves `unreachable`.
 * - `models` and `slots` reject with `AdapterUnavailable` when the server cannot be reached or
 *   answers something that is not understood.
 * - `url` is the base URL of the server (`http://127.0.0.1:8080`), as in the configuration.
 */
export interface LocalModelServer extends Adapter {
  health(url: string): Promise<ServerHealth>;
  models(url: string): Promise<readonly LocalModel[]>;
  slots(url: string): Promise<SlotInfo>;
}
