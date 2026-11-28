// SPDX-License-Identifier: MPL-2.0

/**
 * The keys of `collab.ask_director` (N308, option 2; plan of Phase 11b, P15). Every name and
 * default is [proposta], except the three modes and the limits the plan lists (`timeout` 10m,
 * `max_per_demand` 3).
 */

/**
 * `collab.ask_director.mode`. `answer` (default): the Director answers from what it knows;
 * `relay`: the Director may also hand the question to the Actor that owns the information (through
 * the channel of the supervision) and give back that Actor's answer; `off`: the tool is not
 * offered (and a call that reaches the handler anyway is refused, `collab_off`).
 */
export const COLLAB_ASK_DIRECTOR_MODES = ['answer', 'relay', 'off'] as const;
export type CollabAskDirectorMode = (typeof COLLAB_ASK_DIRECTOR_MODES)[number];

/**
 * `collab.ask_director.on_timeout`. `blocked` (default): the deadline ends the attempt like the
 * `submit` of a `blocked` Actor (the demand goes back to the script); `continue`: the call returns
 * "no answer" and the Actor goes on.
 */
export const COLLAB_ASK_DIRECTOR_ON_TIMEOUT = ['blocked', 'continue'] as const;
export type CollabAskDirectorOnTimeout = (typeof COLLAB_ASK_DIRECTOR_ON_TIMEOUT)[number];

/** `collab.ask_director` as the handlers read it (the timeout in milliseconds). */
export interface CollabAskDirectorSettings {
  readonly mode: CollabAskDirectorMode;
  readonly timeout: number;
  readonly on_timeout: CollabAskDirectorOnTimeout;
  readonly max_per_demand: number;
}

/** The defaults of `collab.ask_director`, for a service built without a configuration. */
export const DEFAULT_COLLAB_ASK_DIRECTOR: CollabAskDirectorSettings = {
  mode: 'answer',
  timeout: 10 * 60_000,
  on_timeout: 'blocked',
  max_per_demand: 3,
};

/** The tools of `ask_director`, the Actor's and the Director's. */
export const ASK_DIRECTOR_TOOL_NAMES = ['ask_director', 'answer_actor', 'relay_question'] as const;

/**
 * The tools that are neither listed nor callable with these settings: all three when the mode is
 * `off`, and `relay_question` unless it is `relay`.
 */
export function hiddenAskDirectorTools(settings: CollabAskDirectorSettings): readonly string[] {
  if (settings.mode === 'off') return ASK_DIRECTOR_TOOL_NAMES;
  return settings.mode === 'relay' ? [] : ['relay_question'];
}
