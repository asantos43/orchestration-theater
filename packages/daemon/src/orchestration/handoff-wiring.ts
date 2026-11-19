// SPDX-License-Identifier: MPL-2.0
import {
  assemblePrefix,
  resolveSecretPaths,
  type ExecutorEntry,
  type PromptSource,
  type Registries,
  type ResolvedRole,
  type RoleId,
  type Store,
} from '@otheater/core';
import type { ScenarioHandoffNotice, ScenarioResetWaitNotice } from '@otheater/protocol';
import { secretPathEntries, type DaemonConfig } from '../config.js';
import type { PackageSummarizer } from '../execution/continuation-package.js';
import {
  createHandoffPort,
  type HandoffChoice,
  type HandoffPort,
  type HandoffRequest,
  type HandoffTarget,
} from '../execution/handoff.js';
import type { Execution } from '../execution/service.js';
import type { Logger } from '../logger.js';
import type { DataPaths } from '../paths.js';
import { resolveRolePolicy } from './role-policy.js';
import type { RoleSelection } from './role-selection.js';

/**
 * The baton of an attempt, wired in the daemon (architecture 5.16; Phase 5, P16b, N145): the
 * `HandoffPort` the runner of attempts calls when the policy of an interruption says `handoff`.
 *
 * The runner is built before the orchestration, and the port needs the selection that is built
 * with it, so the runner gets a {@link LateHandoff} first and the wiring binds the real port when
 * the orchestration exists. Until then (a handoff while the start-up resumes attempts) the answer
 * is `none` with the reason `not_ready`, and the attempt is parked as it was before the port.
 */

/** A port the runner holds from the start, bound to the real one later. */
export interface LateHandoff {
  readonly port: HandoffPort;
  /** Binds the real port; `undefined` unbinds it (the daemon is stopping). */
  bind(port: HandoffPort | undefined): void;
}

export function createLateHandoff(): LateHandoff {
  let bound: HandoffPort | undefined;
  const port: HandoffPort = {
    prefixOf: (role) => bound?.prefixOf(role) ?? '',
    choose: async (request) => bound?.choose(request) ?? { kind: 'none', reason: 'not_ready' },
    announce: (notice) => bound?.announce?.(notice),
    get summarizer() {
      return bound?.summarizer;
    },
    get secretPaths() {
      return bound?.secretPaths;
    },
    get home() {
      return bound?.home;
    },
  };
  return {
    port,
    bind: (next) => {
      bound = next;
    },
  };
}

export interface DaemonHandoffDeps {
  readonly config: DaemonConfig;
  readonly store: Store;
  readonly selection: RoleSelection;
  readonly execution: Pick<Execution, 'pool'>;
  readonly prompts: PromptSource;
  readonly registries: Registries;
  readonly paths: Pick<DataPaths, 'scenarios'>;
  readonly logger: Logger;
  /** Absolute home of the account and the data folder, for `security.secret_paths`. */
  readonly home: string;
  readonly dataDir: string;
  /** The message of the handoff for the chat of the scenario (the event is already written). */
  readonly announce?:
    ((notice: ScenarioHandoffNotice | ScenarioResetWaitNotice) => void) | undefined;
}

/**
 * The port of the daemon: the next Executor comes from the same selector and the same facts the
 * pipeline uses (P15, P16), the prefix is the stable prefix of the role (5.10), the secret list is
 * the one the Sandbox hides, and, with `resume.package.summarize: director_model`, the long summary
 * is written by the model of the Director.
 */
export function createDaemonHandoff(deps: DaemonHandoffDeps): HandoffPort {
  const { config, store, selection, registries, prompts } = deps;
  const entries = secretPathEntries(config);
  const secretPaths = resolveSecretPaths({
    home: deps.home,
    dataDir: deps.dataDir,
    add: entries.add,
    remove: entries.remove,
  });
  const summarizer =
    config.resume.package.summarize === 'director_model' ? directorSummarizer(deps) : undefined;
  const prefixOf = async (role: string | undefined): Promise<string> =>
    role === undefined
      ? ''
      : assemblePrefix({
          role,
          rolePrompt: await prompts.get(role),
          tools: registries.tools.list(),
        });

  return {
    prefixOf,
    async choose(request: HandoffRequest): Promise<HandoffChoice> {
      // The facts are read now, for every choice: a quota that came back a minute ago counts.
      const play = await store.plays.get(request.playId);
      const scenarioId = play?.scenarioId;
      const inputs = await selection.selectorInputs(scenarioId);
      const roles = inputs.roles as Readonly<Record<string, ResolvedRole | undefined>>;
      const port = createHandoffPort({
        selection: inputs.ports,
        settings: inputs.settings,
        roleOf: (role) => {
          const resolved = roles[role];
          return resolved === undefined
            ? Promise.reject(new Error(`The role "${role}" has no list.`))
            : Promise.resolve(resolved);
        },
        launch: (entry, role) => launchOf(entry, role, roles, scenarioId),
        prefixOf,
      });
      const choice = await port.choose(request);
      // P26 (N157): a baton that passed to another account of the provider that ran out says so.
      if (choice.kind === 'selected' && choice.selection !== undefined && request.role !== undefined) {
        selection.noteRotation(request.role, choice.selection, {
          ...(scenarioId === undefined ? {} : { scenarioId }),
          playId: request.playId,
          attemptId: request.attemptId,
        });
      }
      return choice;
    },
    ...(deps.announce === undefined ? {} : { announce: deps.announce }),
    summarizer,
    secretPaths,
    home: deps.home,
  };

  async function launchOf(
    entry: ExecutorEntry,
    role: RoleId,
    roles: Readonly<Record<string, ResolvedRole | undefined>>,
    scenarioId: string | undefined,
  ): Promise<HandoffTarget> {
    const resolved = roles[role]?.executors.find((item) => item.entry.id === entry.id);
    if (resolved === undefined) throw new Error(`The Executor "${entry.id}" is not in "${role}".`);
    const { profile, settings } = selection.sessionOf(role, resolved);
    const policy = await resolveRolePolicy(
      { config, scenarios: store.scenarios, tools: () => registries.tools.list() },
      role,
      scenarioId,
    );
    // `whenExhausted` and `inFlight` stay as the attempt has them: the pipeline sets neither.
    return { executorId: entry.id, profile, executor: settings, policy };
  }
}

/**
 * [proposta] The cheap model of N126: a short session with the Executor the selection gives the
 * Director, one prompt, no tools asked for, closed at once. It rides the lease the pool keeps for
 * "short judgements of the Director" (`director: true`), and any failure (no Executor, a timeout,
 * the session) rejects, so the package keeps the deterministic summary alone.
 * [N] Not tried against a real client.
 */
function directorSummarizer(deps: DaemonHandoffDeps): PackageSummarizer {
  const { config, store, selection, registries, execution, logger } = deps;
  return {
    async summarize({ role, demand, deterministic }) {
      const picked = await selection.once({ role: 'director' });
      if (picked.kind !== 'selected') throw new Error(picked.reason);
      const policy = await resolveRolePolicy(
        { config, scenarios: store.scenarios, tools: () => registries.tools.list() },
        'director',
      );
      const limit = config.limits.demand_timeout;
      const signal = AbortSignal.timeout(limit);
      const lease = await execution.pool.acquire({
        client: picked.profile.client,
        profile: picked.profile,
        policy,
        cwd: deps.paths.scenarios,
        director: true,
        signal,
      });
      try {
        let reply = '';
        const subscription = lease.session.onUpdate((update) => {
          if (update.kind === 'agent_message_chunk' && update.content.type === 'text') {
            reply += update.content.text;
          }
        });
        try {
          await Promise.race([
            lease.session.prompt([
              { type: 'text', text: summaryPrompt(role, demand, deterministic) },
            ]),
            new Promise<never>((_, reject) => {
              signal.addEventListener('abort', () => {
                reject(new Error(`The summary took longer than ${String(limit)} ms.`));
              });
            }),
          ]);
        } finally {
          subscription.dispose();
        }
        const text = reply.trim();
        if (text === '') throw new Error('The Director model answered with nothing.');
        return text;
      } finally {
        await lease.release().catch((error: unknown) => {
          logger.error({ err: error }, 'the summary session did not close');
        });
      }
    },
  };
}

function summaryPrompt(role: string | undefined, demand: string, deterministic: string): string {
  return [
    'Write a short summary of the work below for the next Executor of this task.',
    'Say what is done, what is left, and what to watch out for. Do not use tools. Answer with the summary only.',
    '',
    `Role: ${role ?? 'unknown'}`,
    `Demand: ${demand}`,
    '',
    'What the daemon recorded:',
    deterministic,
  ].join('\n');
}
