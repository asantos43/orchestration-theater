// SPDX-License-Identifier: MPL-2.0

/**
 * The keys of `supervision` (N309, D8; plan of Phase 11b, P14). Every name and default is
 * [proposta], except the default mode `warn` and the default channel `tool_reply`, which the
 * owner decided (N309, N317).
 */

/**
 * `supervision.mode`: how far the Director may go. `warn` (default): a signal calls the Director,
 * who may warn; `log`: only the `supervision.signal` event, the Director is not called; `redirect`:
 * as `warn`, and the Director may also cancel the attempt to relaunch it with the warning; `off`:
 * no watching and no supervision tools. The cancel with no warning stays with `cancel_actor`.
 */
export const SUPERVISION_MODES = ['warn', 'off', 'log', 'redirect'] as const;
export type SupervisionMode = (typeof SUPERVISION_MODES)[number];

/**
 * `supervision.delivery`: how the message reaches the Actor. `tool_reply` (default): it goes in
 * the reply of the next MCP tool the Actor calls; `next_turn`: the same, but only from the next
 * turn of the Actor on (a tool called in the turn that was running when the warning came is not
 * touched); `relaunch`: the attempt is cancelled and relaunched with the message in its prompt.
 */
export const SUPERVISION_DELIVERIES = ['tool_reply', 'next_turn', 'relaunch'] as const;
export type SupervisionDelivery = (typeof SUPERVISION_DELIVERIES)[number];

/** A switch of a trigger or an extra. */
export const SUPERVISION_SWITCHES = ['on', 'off'] as const;
export type SupervisionSwitch = (typeof SUPERVISION_SWITCHES)[number];

/** `supervision` as the daemon reads it. */
export interface SupervisionSettings {
  readonly mode: SupervisionMode;
  readonly delivery: SupervisionDelivery;
  readonly triggers: {
    /** A file edited that is not in the `expectedFiles` of the demand. */
    readonly outside_demand: SupervisionSwitch;
    /** A contract the demand cites changed in the script. */
    readonly contract_changed: SupervisionSwitch;
    /** This many failures in a row of the same test run; `off` turns it off. */
    readonly test_loop: number | 'off';
    /** The fraction of the time of the demand spent (0 to 1); `off` turns it off. */
    readonly budget_fraction: number | 'off';
  };
  /** The Director's calls for one demand (and so the warnings it can get from signals). */
  readonly max_warnings_per_demand: number;
  /** The share of the steps of the play the Director's supervision turns may cost (0 to 1). */
  readonly director_budget: number;
  /** The tool `broadcast`. */
  readonly broadcast: SupervisionSwitch;
  /** The tool `request_status`. */
  readonly status_request: SupervisionSwitch;
}

/** The defaults of `supervision`, for a service built without a configuration. */
export const DEFAULT_SUPERVISION: SupervisionSettings = {
  mode: 'warn',
  delivery: 'tool_reply',
  triggers: {
    outside_demand: 'on',
    contract_changed: 'on',
    test_loop: 3,
    budget_fraction: 0.8,
  },
  max_warnings_per_demand: 3,
  director_budget: 0.1,
  broadcast: 'on',
  status_request: 'on',
};

/** The Director's tools of the supervision (the four of this step). */
export const SUPERVISION_TOOL_NAMES = [
  'warn_actor',
  'redirect_actor',
  'broadcast',
  'request_status',
] as const;
export type SupervisionToolName = (typeof SUPERVISION_TOOL_NAMES)[number];

/**
 * The tools that are neither listed nor callable with these settings. `off` and `log` take all
 * four (the Director is never called, so it has nothing to send); `redirect_actor` needs the
 * mode `redirect`; `broadcast` and `request_status` follow their own switch.
 */
export function hiddenSupervisionTools(settings: SupervisionSettings): readonly string[] {
  if (settings.mode === 'off' || settings.mode === 'log') return SUPERVISION_TOOL_NAMES;
  const hidden: string[] = [];
  if (settings.mode !== 'redirect') hidden.push('redirect_actor');
  if (settings.broadcast === 'off') hidden.push('broadcast');
  if (settings.status_request === 'off') hidden.push('request_status');
  return hidden;
}
