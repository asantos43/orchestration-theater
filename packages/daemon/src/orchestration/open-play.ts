// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { hasErrorCode, type Store } from '@otheater/core';
import type { DaemonConfig, PlayLimits } from '../config.js';
import { selectFlow } from '../pipeline/flow-selection.js';
import type { PlayRunner } from '../pipeline/index.js';
import type { Workspace } from '../workspace/index.js';

/** The limits a new play starts with: `limits.*` of the configuration. */
export function limitsOf(config: DaemonConfig): PlayLimits {
  const { limits } = config;
  return {
    plan_reviews: limits.plan_reviews,
    critic_rejections: limits.critic_rejections,
    attempts_per_demand: limits.attempts_per_demand,
    script_validations: limits.script_validations,
    script_vetoes: limits.script_vetoes,
    script_returns: limits.script_returns,
    structural_restarts: limits.structural_restarts,
    submit_retries: limits.submit_retries,
    demand_timeout: limits.demand_timeout,
    demand_timeout_max: limits.demand_timeout_max,
  };
}

/** What opening a play needs: the part of the runtime the Director's `open_play` also uses. */
export interface PlayOpening {
  readonly store: Pick<Store, 'scenarios' | 'scenarioRepos'>;
  readonly runner: Pick<PlayRunner, 'create' | 'send'>;
  /** `undefined` while the daemon has no code host. */
  readonly workspace: Pick<Workspace, 'createPlayBase'> | undefined;
  readonly config: DaemonConfig;
  /**
   * The gate of the full disk (Phase 11, P5; `disk.on_full`): while it is closed no play opens,
   * and the refusal is `disk_full`. Absent: always open.
   */
  readonly disk?: { paused(): boolean } | undefined;
}

export type OpenedPlay =
  | { readonly ok: true; readonly playId: string }
  | {
      readonly ok: false;
      readonly code: 'no_code_host' | 'no_repository' | 'invalid_flow' | 'disk_full';
      readonly message: string;
    };

/**
 * Creates the play of a scenario from a need, its base branch, and starts it. The path the
 * Director's `open_play` takes (architecture 5.4) and the idea queue takes when a group becomes a
 * play (5.20): one function, so the two cannot drift apart.
 */
export async function openPlayFromNeed(
  opening: PlayOpening,
  scenarioId: string,
  need: string,
): Promise<OpenedPlay> {
  if (opening.disk?.paused() === true) return diskFullRefusal();
  if (opening.workspace === undefined) {
    return {
      ok: false,
      code: 'no_code_host',
      message:
        'This daemon has no code host, so a play cannot deliver its work: it cannot open plays.',
    };
  }
  const repo = (await opening.store.scenarioRepos.list(scenarioId))[0];
  if (repo === undefined) {
    return {
      ok: false,
      code: 'no_repository',
      message: 'The scenario has no repository to work on.',
    };
  }
  // [proposta] P12: the flow the play runs, fixed now; an unknown or invalid choice refuses the play
  const selection = await selectFlow(
    { config: opening.config, scenarios: opening.store.scenarios },
    scenarioId,
    limitsOf(opening.config),
  );
  if (!selection.ok) return { ok: false, code: 'invalid_flow', message: selection.message };
  // [proposta] ids of plays: a short random suffix (a valid branch name, unique enough).
  const playId = `play-${randomUUID().slice(0, 8)}`;
  try {
    await opening.runner.create({
      playId,
      scenarioId,
      need,
      limits: selection.limits,
      flow: selection.flow,
    });
    await opening.workspace.createPlayBase({ repo: repo.path, playId, base: repo.mainBranch });
    await opening.runner.send(playId, { type: 'START' });
  } catch (error) {
    // The write that found no room left nothing of itself; the disk guard has heard of it too.
    if (hasErrorCode(error, 'DISK_FULL')) return diskFullRefusal();
    throw error;
  }
  return { ok: true, playId };
}

function diskFullRefusal(): OpenedPlay {
  return {
    ok: false,
    code: 'disk_full',
    message:
      'The disk is full (disk.on_full), so no play opens now: try again when the space is back.',
  };
}
