// SPDX-License-Identifier: MPL-2.0
import type { DirectiveState, Store } from '@otheater/core';
import { ToolFailure, type ToolCall, type ToolHandlers } from '../mcp/handlers.js';
import { summarizeDirective, type DirectiveService, type DraftContext } from './service.js';

/** The orders the Director sees by default: the ones that are, or will be, in force. [proposta] */
const DEFAULT_LIST_STATES: readonly DirectiveState[] = ['scheduled', 'active'];

interface ProposeInput {
  readonly text: string;
  readonly scope: 'global' | 'local';
  readonly scenarioId?: string;
  readonly kind?: 'instruction' | 'rule' | 'suspension';
  readonly roles?: readonly string[];
  readonly ruleKey?: string;
  readonly ruleValue?: unknown;
  readonly suspends?: string;
  readonly replaces?: string;
  readonly from?: string;
  readonly until?: string;
  readonly for?: string;
}

interface ExtendInput {
  readonly directiveId: string;
  readonly scenarioId?: string;
  readonly from?: string;
  readonly until?: string | null;
  readonly for?: string;
}

interface RevokeInput {
  readonly directiveId: string;
  readonly scenarioId?: string;
  readonly reason: string;
}

interface ListInput {
  readonly scenarioId?: string;
  readonly states?: readonly DirectiveState[];
}

/** Drops the keys whose value is `undefined`, so an optional field stays absent. */
function validityOf(input: {
  from?: string | undefined;
  until?: string | null | undefined;
  for?: string | undefined;
}): { from?: string; until?: string | null; for?: string } {
  return {
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.until === undefined ? {} : { until: input.until }),
    ...(input.for === undefined ? {} : { for: input.for }),
  };
}

/**
 * Registers the handlers of the four tools of the orders (architecture 5.17). None of them
 * writes an order: `propose_directive`, `extend_directive` and `revoke_directive` leave a draft
 * the Producer confirms, edits or cancels; `list_directives` only reads. Only the Director has
 * these tools (the tool registry), so an Executor never proposes an order.
 */
export function registerDirectiveTools(
  handlers: ToolHandlers,
  service: DirectiveService,
  store: Pick<Store, 'plays'>,
): void {
  /** The scenario of a call: the one it names, or the one of the play it belongs to. */
  const contextOf = async (call: ToolCall, named?: string): Promise<DraftContext> => {
    const { playId } = call.caller.correlation;
    const play = playId === undefined ? undefined : await store.plays.get(playId);
    const scenarioId = named ?? play?.scenarioId;
    if (scenarioId === undefined) {
      throw new ToolFailure(
        'scenario_required',
        'Say which scenario the order is for ("scenarioId"); this session is not in a play.',
      );
    }
    return { scenarioId, ...(play === undefined ? {} : { playId: play.id }) };
  };

  handlers.register('list_directives', async (call) => {
    const input = call.input as ListInput;
    const { playId } = call.caller.correlation;
    const play = playId === undefined ? undefined : await store.plays.get(playId);
    const scenarioId = input.scenarioId ?? play?.scenarioId;
    const list = await service.list({
      ...(scenarioId === undefined ? {} : { scenarioId }),
      states: input.states ?? DEFAULT_LIST_STATES,
    });
    return list.map(summarizeDirective);
  });

  handlers.register('propose_directive', async (call) => {
    const input = call.input as ProposeInput;
    const context = await contextOf(call, input.scenarioId);
    const draft = await service.proposeCreate(
      {
        text: input.text,
        scope: input.scope,
        scenarioId: input.scope === 'local' ? context.scenarioId : null,
        kind: input.kind,
        roles: input.roles,
        ruleKey: input.ruleKey,
        ruleValue: input.ruleValue,
        suspendsId: input.suspends,
        replacesId: input.replaces,
        validity: validityOf(input),
      },
      context,
    );
    return { draftId: draft.draftId, preview: draft.preview, conflicts: draft.conflicts };
  });

  handlers.register('extend_directive', async (call) => {
    const input = call.input as ExtendInput;
    const draft = await service.proposeExtend(
      input.directiveId,
      validityOf(input),
      await contextOf(call, input.scenarioId),
    );
    return { draftId: draft.draftId, preview: draft.preview, conflicts: draft.conflicts };
  });

  handlers.register('revoke_directive', async (call) => {
    const input = call.input as RevokeInput;
    const draft = await service.proposeRevoke(
      input.directiveId,
      input.reason,
      await contextOf(call, input.scenarioId),
    );
    return { draftId: draft.draftId, preview: draft.preview, conflicts: draft.conflicts };
  });
}
