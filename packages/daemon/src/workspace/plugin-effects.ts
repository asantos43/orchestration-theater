// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  type JsonObject,
  type SideEffectRecord,
  type SideEffectRegistry,
} from '@otheater/core';
import { runEffect, type EffectOutcome, type EffectVerdict } from './effects.js';

/**
 * What a plugin gives the daemon to take part in the side-effect protocol (architecture 5.16 and
 * 5.21). [proposta] This is only the hook of P22: the rule for which plugin may declare which
 * effect belongs to Phase 9. The contract is the one the built-in tools follow: a `type`, and a
 * verifier that looks at the world and says whether the effect of an open record happened.
 */
export interface PluginEffect {
  /** The `type` of the records the plugin writes: `<plugin>.<effect>`, never a built-in name. */
  readonly type: string;
  /** Says `done`, `not_done` or `ambiguous` about a record with a "before" and no "after". */
  verify(record: SideEffectRecord): Promise<EffectVerdict>;
}

/** The verifiers the plugins registered, by the type of effect. */
export class PluginEffectRegistry {
  readonly #byType = new Map<string, { plugin: string; effect: PluginEffect }>();

  /**
   * `Conflict` for a type with no `<plugin>.<effect>` shape (the built-in types have no dot, so
   * a plugin cannot take one over), or one another plugin already owns.
   */
  register(plugin: string, effect: PluginEffect): void {
    if (!effect.type.startsWith(`${plugin}.`) || effect.type.length === plugin.length + 1) {
      throw new Conflict(`A side effect type of the plugin ${plugin} is "${plugin}.<effect>"`);
    }
    const owner = this.#byType.get(effect.type);
    if (owner !== undefined) {
      throw new Conflict(
        `The side effect type ${effect.type} is already declared by ${owner.plugin}`,
      );
    }
    this.#byType.set(effect.type, { plugin, effect });
  }

  has(type: string): boolean {
    return this.#byType.has(type);
  }

  /** `undefined` when no plugin owns the type; a verifier that throws is `ambiguous`. */
  async verify(record: SideEffectRecord): Promise<EffectVerdict | undefined> {
    const owner = this.#byType.get(record.type);
    if (owner === undefined) return undefined;
    try {
      return await owner.effect.verify(record);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return {
        verdict: 'ambiguous',
        reason: `The verifier of the plugin ${owner.plugin} failed: ${why}`,
      };
    }
  }
}

export interface PluginEffectSpec {
  readonly key: string;
  readonly type: string;
  readonly target: string;
  readonly params: JsonObject;
  readonly attemptId?: string;
  execute(key: string): Promise<JsonObject>;
}

/**
 * Runs an effect of a plugin under the protocol, with the verifier the plugin registered. A type no
 * plugin declared is refused: an effect nobody can verify would be repeated blindly.
 */
export function runPluginEffect(
  registry: SideEffectRegistry,
  plugins: PluginEffectRegistry,
  spec: PluginEffectSpec,
): Promise<EffectOutcome> {
  if (!plugins.has(spec.type)) {
    return Promise.reject(new Conflict(`No plugin declared the side effect type ${spec.type}`));
  }
  return runEffect(registry, {
    ...spec,
    verify: async (record) =>
      (await plugins.verify(record)) ?? {
        verdict: 'ambiguous',
        reason: `No plugin verifier for ${record.type}`,
      },
  });
}
