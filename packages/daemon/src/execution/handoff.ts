// SPDX-License-Identifier: MPL-2.0
import {
  ROLE_IDS,
  selectExecutorFromPorts,
  type ExecutorConfig,
  type ExecutorEntry,
  type Profile,
  type ResolvedRole,
  type RoleId,
  type RolePolicy,
  type SelectionPorts,
  type SelectionResult,
  type SelectionSettings,
  type WhenExhausted,
} from '@otheater/core';
import type { ScenarioHandoffNotice } from '@otheater/protocol';
import type { PackageSummarizer } from './continuation-package.js';
import type { InFlightMode } from './interruption-policy.js';

/**
 * The handoff, from the side of the runner (architecture 5.16, "Passagem de bastão"; Phase 5, P18):
 * when the policy of an interruption says `handoff`, the runner asks this port for the next
 * Executor of the role, builds the continuation package from the store and opens a new session
 * with it. The port holds what the runner must not know: the lists of the roles (P13), the
 * selector (P15) and the facts it reads, the prefix of the role, and the secret list.
 *
 * Without a port the runner keeps its old behaviour: the attempt is parked with the decision
 * (`handoff`) and the caller does the rest. The real wiring of the port into the pipeline is P16's
 * (it swaps the fixed Executor for the selection); `createHandoffPort` is the piece it plugs in.
 */

/** What a session needs to run the Executor the selection chose. */
export interface HandoffTarget {
  /** `<model>[-<effort>]@<client>/<profile>`. */
  readonly executorId: string;
  readonly profile: Profile;
  readonly executor: ExecutorConfig;
  /** The policy of the role for this Executor (tools, network, MCP servers). */
  readonly policy: RolePolicy;
  readonly whenExhausted?: WhenExhausted | undefined;
  readonly inFlight?: InFlightMode | undefined;
}

/** What the port is asked when the work of an attempt has to change hands. */
export interface HandoffRequest {
  readonly attemptId: string;
  readonly playId: string;
  readonly demandId: string;
  readonly role: string | undefined;
  /** The cause of the interruption (`quota_exhausted`, `stuck`...). */
  readonly cause: string;
  /** The Executor that is giving the baton. */
  readonly from: string;
  /** Every Executor that already worked on this attempt, `from` included: none of them is chosen. */
  readonly used: readonly string[];
}

/** The answer: an Executor, or the reason there is none now. */
export type HandoffChoice =
  | {
      readonly kind: 'selected';
      readonly target: HandoffTarget;
      /** The selection behind it, for the `executor.selected` event; absent when nothing selected. */
      readonly selection?: SelectionResult | undefined;
    }
  | {
      readonly kind: 'none';
      /** `no_role`, `no_other_executor`, `waiting`... */
      readonly reason: string;
      readonly selection?: SelectionResult | undefined;
    };

/** The port the runner calls. Every field but `choose` and `prefixOf` is optional help. */
export interface HandoffPort {
  /** The stable prefix of the role (5.10), as it is now; empty when the role has none. */
  prefixOf(role: string | undefined): string | Promise<string>;
  /** The next Executor of the role, never one of `request.used`. */
  choose(request: HandoffRequest): Promise<HandoffChoice>;
  /** The system message of the handoff for the chat of the scenario (also in the event log). */
  announce?(notice: ScenarioHandoffNotice): void;
  /** The cheap model of `resume.package.summarize: director_model` (N126). */
  readonly summarizer?: PackageSummarizer | undefined;
  /** `security.secret_paths` resolved; the package leaves these paths out. */
  readonly secretPaths?: readonly string[] | undefined;
  /** The absolute home, to read `~/x` in a command. */
  readonly home?: string | undefined;
}

export interface HandoffPortDeps {
  /** The ports the selector reads (P2, P4, P5). */
  readonly selection: SelectionPorts;
  readonly settings: SelectionSettings;
  /** The resolved list of the role now (`resolveScenarioRoleExecutors`, P13). */
  roleOf(
    role: RoleId,
    request: HandoffRequest,
  ): Promise<Pick<ResolvedRole, 'role' | 'executors' | 'whenExhausted'>>;
  /** Turns the entry the selection chose into the profile, configuration and policy of a session. */
  launch(entry: ExecutorEntry, role: RoleId, request: HandoffRequest): Promise<HandoffTarget>;
  prefixOf(role: string | undefined): string | Promise<string>;
  announce?(notice: ScenarioHandoffNotice): void;
  readonly summarizer?: PackageSummarizer | undefined;
  readonly secretPaths?: readonly string[] | undefined;
  readonly home?: string | undefined;
}

function roleIdOf(role: string | undefined): RoleId | undefined {
  return ROLE_IDS.find((id) => id === role);
}

/**
 * The port over the selector of P15. The list of the role is cut to the Executors that did not
 * work on the attempt yet (the attempt that passed the baton never gets it back, even when its
 * quota comes back first), and the selector orders the rest by the strategy of the configuration.
 * The previous Executor is no longer in the list, so `retry_diversity` has nothing to rotate past.
 */
export function createHandoffPort(deps: HandoffPortDeps): HandoffPort {
  return {
    prefixOf: (role) => deps.prefixOf(role),
    async choose(request) {
      const role = roleIdOf(request.role);
      if (role === undefined) return { kind: 'none', reason: 'no_role' };
      const resolved = await deps.roleOf(role, request);
      const executors = resolved.executors.filter((item) => !request.used.includes(item.id));
      if (executors.length === 0) return { kind: 'none', reason: 'no_other_executor' };
      const selection = await selectExecutorFromPorts(deps.selection, {
        role: { role: resolved.role, executors, whenExhausted: resolved.whenExhausted },
        settings: deps.settings,
        previousExecutor: request.from,
      });
      if (selection.selected === null) return { kind: 'none', reason: 'waiting', selection };
      const target = await deps.launch(selection.selected.entry, role, request);
      return { kind: 'selected', target, selection };
    },
    ...(deps.announce === undefined
      ? {}
      : { announce: (notice: ScenarioHandoffNotice) => deps.announce?.(notice) }),
    summarizer: deps.summarizer,
    secretPaths: deps.secretPaths,
    home: deps.home,
  };
}
