// SPDX-License-Identifier: MPL-2.0
import type { DirectiveRecord } from '../ports/directives.js';

/**
 * The value of a configuration key for a scenario, with the `rule` directives in force applied
 * (architecture 5.17): the daemon reads the override instead of the configuration while the rule
 * is `active`, and goes back to `fallback` (the configuration value) when it expires or is
 * revoked. Pure: `inForce` is what `DirectiveRegistry.inForce` returned for the scenario.
 *
 * A local rule beats a global one; among rules of the same scope the newest (`seq`) wins, which
 * can only matter for rules whose validities do not overlap (the daemon refuses two that do).
 * A rule restricted to some roles applies only when `role` is one of them; with no `role` given,
 * only the rules for every role apply.
 */
export function resolveRule<T>(
  inForce: readonly DirectiveRecord[],
  key: string,
  fallback: T,
  role?: string,
): T {
  const rules = inForce
    .filter(
      (directive) =>
        directive.kind === 'rule' &&
        directive.ruleKey === key &&
        (directive.roles.length === 0 || (role !== undefined && directive.roles.includes(role))),
    )
    .sort((a, b) => (a.scope === b.scope ? b.seq - a.seq : a.scope === 'local' ? -1 : 1));
  const [winner] = rules;
  return winner === undefined ? fallback : (winner.ruleValue as T);
}
