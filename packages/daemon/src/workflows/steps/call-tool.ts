// SPDX-License-Identifier: MPL-2.0
import type { JsonObject, JsonValue } from '@otheater/core';
import { durationMs } from '@otheater/workflows';
import { EffectFailed, runEffect, type EffectVerdict } from '../../workspace/effects.js';
import { toJsonValue, withDeadline } from './support.js';
import type {
  StepContext,
  StepResult,
  StepRunner,
  ToolCaller,
  ToolCallResult,
  ToolRef,
} from './types.js';

export type { ToolCaller, ToolCallResult, ToolEffectClass, ToolRef } from './types.js';

/** The type of the effect of a tool of a plugin: `<plugin>.<tool>`, the shape `PluginEffectRegistry` takes. */
export function toolEffectType(ref: ToolRef): string {
  return `${ref.plugin}.${ref.tool}`;
}

/**
 * `call_tool` (docs/24 §4; N292): calls a tool of a plugin out of the process. Output
 * `{ok, result}`: `ok` is false when the tool answered an error or did not answer; `result` is what
 * it gave (the structured content, else its text) or the error.
 *
 * [proposta]
 * - The name in `params.tool` is the public name `<plugin>__<tool>` (the one of the aggregator).
 * - A tool that only reads (`effects: read`) is called directly: nothing to protect. Any other
 *   goes through the journal (`runEffect`), as a `<plugin>.<tool>` effect with the key
 *   `<run>:<node>:<ordinal>`: after a restart in the middle of the call, the verifier the plugin
 *   registered says whether it happened, and it is not called again when it did. With no verifier
 *   the effect is `ambiguous` and the step fails with `effect_ambiguous`: it is never repeated blindly.
 * - The args go as they are in the node: there is no interpolation yet (a later step of the plan),
 *   and the key is not handed to the plugin (the MCP call has no field for it).
 * - A tool error is not a failure of the step: the output is `{ok: false, result}` and the edges
 *   decide. The step fails only when it cannot try (`tool_unavailable`, `no_tool_caller`) or cannot
 *   tell what happened (`effect_ambiguous`).
 * - The deadline is the `timeout` of the node, else `workflows.runtime.call_tool.timeout`, else the
 *   one of the plugins (`plugins.call_timeout`).
 */
export const callToolStep: StepRunner = {
  type: 'call_tool',
  async run(ctx: StepContext): Promise<StepResult> {
    const { store, tools, pluginEffects, settings, clock } = ctx.deps;
    if (tools === undefined) return { kind: 'failed', reason: 'no_tool_caller' };
    const name = String(ctx.params.tool);
    const ref = tools.find(ctx.scenarioId, name);
    if (ref === undefined) {
      return {
        kind: 'failed',
        reason: 'tool_unavailable',
        detail: `The tool ${name} is not active`,
      };
    }
    const args = (ctx.params.args ?? {}) as Record<string, unknown>;
    const timeoutText = ctx.params.timeout;
    const timeoutMs =
      typeof timeoutText === 'string' ? durationMs(timeoutText) : settings.callToolTimeoutMs;

    const call = async (): Promise<ToolCallResult> => {
      const deadline = withDeadline(clock, timeoutMs, ctx.signal);
      try {
        const answer = await tools.call(ctx.scenarioId, ref, args, deadline.signal);
        return deadline.expired()
          ? { ok: false, result: { error: 'timeout' }, code: 'timeout' }
          : answer;
      } finally {
        deadline.dispose();
      }
    };

    if (ref.effects === 'read') {
      const answer = await call();
      if (ctx.signal.aborted) return { kind: 'cancelled', reason: 'aborted' };
      return { kind: 'done', output: { ok: answer.ok, result: answer.result } };
    }

    const verify = async (record: Parameters<NonNullable<typeof pluginEffects>['verify']>[0]) =>
      (await pluginEffects?.verify(record)) ??
      ({
        verdict: 'ambiguous',
        reason: `No plugin verifier for ${record.type}`,
      } satisfies EffectVerdict);

    try {
      const outcome = await runEffect(store.sideEffects, {
        key: ctx.key,
        type: toolEffectType(ref),
        target: name,
        params: { run: ctx.runId, node: ctx.node, args: toJsonValue(args) },
        execute: async () => {
          const answer = await call();
          if (!answer.ok) {
            const failed: JsonObject = {
              ok: false,
              result: answer.result,
              ...(answer.code === undefined ? {} : { code: answer.code }),
            };
            throw new EffectFailed(`The tool ${name} failed`, failed);
          }
          return { ok: true, result: answer.result };
        },
        verify,
      });
      if (outcome.kind === 'ambiguous') {
        return { kind: 'failed', reason: 'effect_ambiguous', detail: outcome.reason };
      }
      return {
        kind: 'done',
        output: { ok: outcome.result.ok !== false, result: outcome.result.result ?? null },
        effect: outcome.origin,
      };
    } catch (error) {
      if (error instanceof EffectFailed) {
        if (ctx.signal.aborted) return { kind: 'cancelled', reason: 'aborted' };
        return {
          kind: 'done',
          output: { ok: false, result: error.result.result ?? null },
        };
      }
      throw error;
    }
  },
};
