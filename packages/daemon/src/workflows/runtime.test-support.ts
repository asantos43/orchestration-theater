// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the workflow runtime only (excluded from the build of the package).
import type { JsonValue, SideEffectRecord } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import type { AskApproval } from '../browser/approval.js';
import { PluginEffectRegistry } from '../workspace/plugin-effects.js';
import { registerWorkflowEffects } from './effects.js';
import { WorkflowRuntime, type WorkflowRuntimeOptions } from './runtime.js';
import type { ToolCaller, ToolCallResult, ToolRef } from './steps/call-tool.js';

export const SCENARIO = 'scenario-1';

/**
 * The fake "plugin" of the tests: `demo__write` changes the world (a list of ids) and so goes through
 * the journal; `demo__status` only reads. The world outlives a runtime, as the world outlives a
 * daemon.
 */
export class FakeTools implements ToolCaller {
  /** What the writes changed: one entry per call that took effect. */
  readonly world: string[] = [];
  /** Every call that reached the tool, in order (`<tool>:<id>`). */
  readonly calls: string[] = [];
  /** What `demo__status` answers. */
  statusOk = true;

  readonly #tools = new Map<string, ToolRef>([
    ['demo__write', { plugin: 'demo', tool: 'write', effects: 'external_write' }],
    ['demo__status', { plugin: 'demo', tool: 'status', effects: 'read' }],
  ]);

  find(_project: string, name: string): ToolRef | undefined {
    return this.#tools.get(name);
  }

  call(_project: string, ref: ToolRef, args: Record<string, unknown>): Promise<ToolCallResult> {
    const id = typeof args.id === 'string' ? args.id : '';
    this.calls.push(`${ref.tool}:${id}`);
    if (ref.tool === 'write') {
      this.world.push(id);
      return Promise.resolve({ ok: true, result: { wrote: id } });
    }
    return Promise.resolve(
      this.statusOk
        ? { ok: true, result: { status: 'up' } }
        : { ok: false, result: { error: 'plugin_failed' }, code: 'plugin_failed' },
    );
  }

  /** The verifier `demo.write` registers: the effect happened if its id is in the world. */
  verifyWrite(
    record: SideEffectRecord,
  ): Promise<
    { verdict: 'done'; result: { ok: true; result: { wrote: string } } } | { verdict: 'not_done' }
  > {
    const args = (record.params?.args ?? {}) as { id?: unknown };
    const id = typeof args.id === 'string' ? args.id : '';
    return Promise.resolve(
      this.world.includes(id)
        ? { verdict: 'done', result: { ok: true, result: { wrote: id } } }
        : { verdict: 'not_done' },
    );
  }
}

/** The prompt queue of the tests: every question stays open until the test answers it. */
export class FakeAsk {
  readonly opened: { decisionId: string; question: string; answer: (value: JsonValue) => void }[] =
    [];

  readonly ask: AskApproval = (_scenario, input) => {
    const decisionId = `decision-${String(this.opened.length + 1)}`;
    let answer: (value: JsonValue) => void = () => undefined;
    const promise = new Promise<JsonValue>((resolve) => {
      answer = resolve;
    });
    this.opened.push({
      decisionId,
      question: input.questions[0]?.question ?? '',
      answer,
    });
    return Promise.resolve({ decisionId, answer: promise });
  };
}

/** What a restart keeps: the store, the clock, the tools and what they changed. */
export interface World {
  readonly clock: FakeClock;
  readonly store: InMemoryStore;
  readonly tools: FakeTools;
  readonly asks: FakeAsk;
  readonly pluginEffects: PluginEffectRegistry;
  /** The definitions the runtime can load, by `<id>@<version>`. */
  readonly definitions: Map<string, unknown>;
}

export function makeWorld(): World {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const tools = new FakeTools();
  const pluginEffects = new PluginEffectRegistry();
  pluginEffects.register('demo', {
    type: 'demo.write',
    verify: (record) => tools.verifyWrite(record),
  });
  registerWorkflowEffects(pluginEffects, store);
  return { clock, store, tools, asks: new FakeAsk(), pluginEffects, definitions: new Map() };
}

/** A runtime over the world; a second one over the same world is the daemon after a restart. */
export function makeRuntime(
  world: World,
  extra: Partial<WorkflowRuntimeOptions> = {},
): WorkflowRuntime {
  return new WorkflowRuntime({
    store: world.store,
    clock: world.clock,
    tools: world.tools,
    ask: world.asks.ask,
    pluginEffects: world.pluginEffects,
    source: {
      resolve: ({ id, version }) => world.definitions.get(`${id}@${version}`),
    },
    ...extra,
  });
}

/** Saves a definition where the runtime of the world finds it. */
export function publish(world: World, definition: { id: string; version: string }): void {
  world.definitions.set(`${definition.id}@${definition.version}`, definition);
}

/** A small workflow that uses the five generic step types. */
export function pipeline(): {
  id: string;
  version: string;
  engine: string;
  inputs: Record<string, unknown>;
  nodes: Record<string, unknown>;
  edges: string[];
} {
  return {
    id: 'pipeline',
    version: '1.0.0',
    engine: '>=1 <2',
    inputs: {
      who: { type: 'string', default: 'world' },
      doc: { type: 'string', default: 'doc-1' },
    },
    nodes: {
      announce: { step: 'notify', params: { message: 'starting' } },
      save: { step: 'call_tool', params: { tool: 'demo__write', args: { id: 'doc-1' } } },
      route: { step: 'branch' },
      ask: { step: 'approval', params: { prompt: 'Publish?' } },
      wait: { step: 'wait_event', params: { event: 'demo.ready', timeout: '1m' } },
    },
    edges: [
      'announce -> save',
      'save -> route when output.ok',
      'save -> failed',
      'route -> ask when inputs.who == "world"',
      'route -> done',
      'ask -> wait when output.approved',
      'ask -> cancelled',
      'wait -> done when not output.timed_out',
      'wait -> failed',
    ],
  };
}
