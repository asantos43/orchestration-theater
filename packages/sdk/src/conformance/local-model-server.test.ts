// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  LOCAL_MODEL_SERVER_PORT_VERSION,
  type LocalModel,
  type LocalModelServer,
  type ServerHealth,
  type SlotInfo,
} from '@otheater/core';
import { describeLocalModelServerConformance, type LocalServerBehavior } from '../index.js';

/**
 * A `LocalModelServer` with no network, driven by a table of URL -> behavior. It exists to prove
 * that the suite is written against the port and not against one adapter (the real HTTP adapter
 * runs the same suite in `@otheater/adapter-local-llama-cpp`).
 */
class ScriptedServer implements LocalModelServer {
  readonly id = 'scripted';
  readonly implements = {
    port: 'LocalModelServer',
    range: `^${LOCAL_MODEL_SERVER_PORT_VERSION}`,
  } as const;

  readonly behaviors = new Map<string, LocalServerBehavior>();

  constructor(private readonly timeoutMs: number) {}

  async health(url: string): Promise<ServerHealth> {
    try {
      const b = await this.#behavior(url);
      if (b.kind === 'serving') return { status: b.health, detail: `scripted ${b.health}` };
      return { status: 'unreachable', detail: 'not understood' };
    } catch (error) {
      return { status: 'unreachable', detail: (error as Error).message };
    }
  }

  async models(url: string): Promise<readonly LocalModel[]> {
    const b = await this.#serving(url);
    return b.models.map((id) => ({ id }));
  }

  async slots(url: string): Promise<SlotInfo> {
    const { slots } = await this.#serving(url);
    if (slots === 'unreported') return { count: undefined, contextPerSlot: undefined };
    return { count: slots.count, contextPerSlot: slots.contextPerSlot };
  }

  async #behavior(url: string): Promise<LocalServerBehavior> {
    const b = this.behaviors.get(url);
    if (b === undefined) throw new AdapterUnavailable('connection refused');
    if (b.kind === 'hung') {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.timeoutMs);
      });
      throw new AdapterUnavailable(`no answer within ${String(this.timeoutMs)} ms`);
    }
    return b;
  }

  async #serving(url: string): Promise<Extract<LocalServerBehavior, { kind: 'serving' }>> {
    const b = await this.#behavior(url);
    if (b.kind !== 'serving') throw new AdapterUnavailable('answer not understood');
    return b;
  }
}

describeLocalModelServerConformance('ScriptedServer (test-only)', () => {
  const timeoutMs = 50;
  const server = new ScriptedServer(timeoutMs);
  let next = 0;
  return {
    server,
    timeoutMs,
    serve: (behavior) => {
      next += 1;
      const url = `scripted://${String(next)}`;
      server.behaviors.set(url, behavior);
      return Promise.resolve(url);
    },
    unreachableUrl: () => Promise.resolve('scripted://down'),
  };
});
