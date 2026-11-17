// SPDX-License-Identifier: MPL-2.0
import type { DirectiveRecord } from '../ports/directives.js';
import { renderOrders } from '../prompts/prefix.js';

/**
 * The orders a continuation package carries (architecture 5.17, 5.7): after a failover or a
 * resume, the new session gets the orders in force at that moment, not the ones the first
 * session was opened with. `directives` is what `DirectiveRegistry.inForce` returned at resume
 * time (the suspended globals are already out); only the `instruction` orders that reach `role`
 * are written. `undefined` when there is none, so the package has no empty section.
 *
 * [proposta] The heading is `## Orders in force now`; the body is the same text the prefix has.
 */
export function renderContinuationOrders(
  role: string,
  directives: readonly DirectiveRecord[],
): string | undefined {
  return renderOrders(role, directives, '## Orders in force now');
}
