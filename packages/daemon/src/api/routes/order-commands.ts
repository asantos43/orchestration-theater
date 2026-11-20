// SPDX-License-Identifier: MPL-2.0
import { NotFound, type DirectiveRecord } from '@otheater/core';
import type { OrderValidity } from '@otheater/protocol';
import type { DirectiveInput, ValidityText } from '../../directives/index.js';
import type { CommandRegistrar } from './command.js';
import type { CommandRouteDeps } from './deps.js';

/** The validity of the body as the service takes it (no key holds `undefined`). */
function validityOf(validity: OrderValidity | undefined): ValidityText | undefined {
  if (validity === undefined) return undefined;
  return {
    ...(validity.from === undefined ? {} : { from: validity.from }),
    ...(validity.until === undefined ? {} : { until: validity.until }),
    ...(validity.for === undefined ? {} : { for: validity.for }),
  };
}

/**
 * The commands on orders (P6 of docs/17). [proposta] The origin recorded is `tui`: a client of the
 * API stands where the terminal UI stands (the origins of the service are `chat`, `tui`, `terminal`
 * and `import`). The service writes the events of every change (`directive.*`).
 */
export function registerOrderCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  const { directives, store } = deps;
  // A local order or a suspension names a scenario; one that does not exist is a 404, not an order
  // left pointing at nothing.
  const scenarioExists = async (scenarioId: string | undefined): Promise<void> => {
    if (scenarioId === undefined) return;
    if ((await store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
  };
  const wrap = (order: DirectiveRecord): { order: DirectiveRecord } => ({ order });

  register('createOrder', async ({ body }) => {
    await scenarioExists(body.scenarioId);
    const input: DirectiveInput = {
      text: body.text,
      scope: body.scope,
      ...(body.scenarioId === undefined ? {} : { scenarioId: body.scenarioId }),
      ...(body.kind === undefined ? {} : { kind: body.kind }),
      ...(body.roles === undefined ? {} : { roles: body.roles }),
      ...(body.ruleKey === undefined ? {} : { ruleKey: body.ruleKey }),
      ...(body.ruleValue === undefined ? {} : { ruleValue: body.ruleValue }),
      ...(body.suspendsId === undefined ? {} : { suspendsId: body.suspendsId }),
      ...(body.replacesId === undefined ? {} : { replacesId: body.replacesId }),
      ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
      ...(body.validity === undefined ? {} : { validity: validityOf(body.validity) }),
    };
    return wrap(await directives.create(input, 'tui'));
  });

  register('extendOrder', async ({ params, body }) =>
    wrap(await directives.extend(params.orderId, validityOf(body.validity) ?? {})),
  );

  register('suspendOrder', async ({ params, body }) => {
    await scenarioExists(body.scenarioId);
    return wrap(
      await directives.create(
        {
          kind: 'suspension',
          scope: 'local',
          scenarioId: body.scenarioId,
          suspendsId: params.orderId,
          text: body.text ?? `Suspends the order ${params.orderId} in this scenario`,
          ...(body.validity === undefined ? {} : { validity: validityOf(body.validity) }),
        },
        'tui',
      ),
    );
  });

  register('revokeOrder', async ({ params, body }) =>
    wrap(await directives.revoke(params.orderId, body.reason)),
  );
}
