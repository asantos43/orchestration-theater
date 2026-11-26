// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  AdapterUnavailable,
  conventionsToJson,
  InvalidInput,
  parseConventions,
  type ProjectConventions,
  type Registries,
  type ScenarioRecord,
  type Store,
  supportsHistory,
  supportsInit,
  supportsInspect,
  type Vcs,
} from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';
import type { ConventionsMode } from '../config.js';
import { createSoftwareProject } from '../project/create.js';
import { detectConventions } from '../project/detect.js';

export interface ScenarioServiceOptions {
  readonly store: Pick<Store, 'events' | 'scenarioRepos' | 'scenarios'>;
  readonly vcs: Vcs;
  readonly registries: Pick<Registries, 'scenarioTypes'>;
  /** `<dataDir>/scenarios`: the folder of a scenario that has no repository of its own. */
  readonly scenariosDir: string;
  /**
   * `project.conventions`, read at each creation. With `off` the daemon detects nothing; any
   * other value detects (the question to the Producer is the channel's). Default `ask`.
   */
  readonly conventionsMode?: () => ConventionsMode;
}

export interface CreateScenarioInput {
  /** A key of the scenario type registry. */
  readonly type: string;
  /** The repository of a `project`. */
  readonly repo?: string;
  /** The branch a project's plays start from and deliver to. Default `main`. */
  readonly base?: string;
  /** Shown name. Default: the folder name of a project, `chat` for a chat. */
  readonly name?: string;
  /**
   * Create the project (a `project` scenario only): `repo` is a folder that does not exist or is
   * empty, and it becomes a repository with the structure of the `software` profile. Without it
   * the repository must exist (an import).
   */
  readonly newProject?: boolean;
}

export interface CreatedScenario {
  readonly scenario: ScenarioRecord;
  /** False when the scenario already existed and was only reopened. */
  readonly created: boolean;
  /** The conventions of the project, as stored; none for a chat or with `project.conventions: off`. */
  readonly conventions?: ProjectConventions;
}

function slugOf(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug === '' ? fallback : slug;
}

/** The id of the scenario of a repository: stable, so `ot chat` in the same folder returns to it. */
export function projectScenarioId(repo: string): string {
  const path = resolve(repo);
  const digest = createHash('sha1').update(path).digest('hex').slice(0, 8);
  return `chat-${slugOf(basename(path), 'repo')}-${digest}`;
}

/** The id of a generic chat: stable per name, so the same name reopens the same chat. */
export function genericChatId(name: string): string {
  return `talk-${slugOf(name, 'chat')}`;
}

/**
 * The scenario types `ScenarioService.create` can open today (2026-11-26, N329). The task is in the
 * registry but waits for Phase 9b: `GET /v1/scenario-types` answers it with `creatable: false`, and
 * an interface turns it on by itself once its id is here.
 */
export const CREATABLE_SCENARIO_TYPES: readonly string[] = ['project', 'chat'];

/**
 * Creates the scenarios of the registered types (architecture 5.20): the type says the flow the
 * scenario starts with. [proposta]
 * - `project`: lives in the Producer's repository (the folder is the repository), flow `play`.
 * - `chat`: has no repository. Its folder is `<data>/scenarios/<id>`, a plain folder turned into a
 *   git repository with one empty commit, because the consultations of the Director run in a
 *   worktree of it; flow `chat`. Its id comes from the name, so a name is one chat.
 * - `task` (and any type added to the registry): known to the registry but with no way to be
 *   created yet; the request is refused with that said.
 * Creating twice returns the scenario that exists.
 */
export class ScenarioService {
  readonly #options: ScenarioServiceOptions;
  readonly #conventionsMode: () => ConventionsMode;

  constructor(options: ScenarioServiceOptions) {
    this.#options = options;
    this.#conventionsMode = options.conventionsMode ?? (() => 'ask');
  }

  async create(input: CreateScenarioInput): Promise<CreatedScenario> {
    const { registries } = this.#options;
    const type = registries.scenarioTypes.get(input.type);
    if (type === undefined) {
      throw new InvalidInput(
        `There is no scenario type "${input.type}" (known: ${registries.scenarioTypes.keys().join(', ')})`,
      );
    }
    switch (type.id) {
      case 'project':
        return this.#project(type.id, type.defaultFlow, input);
      case 'chat':
        return this.#chat(type.id, type.defaultFlow, input);
      default:
        throw new InvalidInput(`The scenario type "${type.id}" cannot be created yet`);
    }
  }

  async #project(type: string, flow: string, input: CreateScenarioInput): Promise<CreatedScenario> {
    const { store, vcs } = this.#options;
    if (input.repo === undefined || input.repo === '') {
      throw new InvalidInput('A project scenario needs the repository it works on (repo)');
    }
    const path = resolve(input.repo);
    const id = projectScenarioId(path);
    const existing = await store.scenarios.get(id);
    // A new project is born with the structure of the profile; its conventions are the profile's.
    const born =
      input.newProject === true
        ? await createSoftwareProject({
            vcs,
            folder: path,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.base === undefined ? {} : { branch: input.base }),
          })
        : undefined;
    const base = born?.branch ?? (await this.#baseOf(path, input.base));
    let conventions = parseConventions(existing?.conventions);
    if (born !== undefined) {
      conventions = born.conventions;
    } else if (conventions === undefined && this.#conventionsMode() !== 'off') {
      conventions = await detectConventions({ vcs, repo: path, base });
    }
    const stored = conventions === undefined ? undefined : conventionsToJson(conventions);
    let scenario = existing;
    if (scenario === undefined) {
      scenario = await store.scenarios.create({
        id,
        kind: 'project',
        flowId: flow,
        name: input.name ?? basename(path),
        folder: path,
        profile: 'software',
        baseBranch: base,
        ...(stored === undefined ? {} : { conventions: stored }),
      });
    } else if (stored !== undefined && parseConventions(scenario.conventions) === undefined) {
      // Reopened without conventions (before P7, or a shape this version does not know).
      scenario = await store.scenarios.update(id, { conventions: stored });
    }
    await store.scenarioRepos.put({ scenarioId: id, path, mainBranch: base });
    if (existing === undefined) await this.#announce(scenario, type);
    return {
      scenario,
      created: existing === undefined,
      ...(conventions === undefined ? {} : { conventions }),
    };
  }

  /**
   * The branch plays start from: the one named, else `main`, else the branch the repository
   * itself calls its default (an imported repository may use `master` or `trunk`).
   */
  async #baseOf(path: string, named: string | undefined): Promise<string> {
    const { vcs } = this.#options;
    const wanted = named ?? 'main';
    try {
      if (!supportsHistory(vcs)) throw new Error('the Vcs adapter cannot read refs');
      await vcs.resolveRef(path, wanted);
      return wanted;
    } catch (error) {
      const fallback =
        named === undefined && supportsInspect(vcs)
          ? await vcs.defaultBranch(path).catch(() => undefined)
          : undefined;
      if (fallback !== undefined && supportsHistory(vcs)) {
        const found = await vcs.resolveRef(path, fallback).then(
          () => true,
          () => false,
        );
        if (found) return fallback;
      }
      throw new InvalidInput(
        `"${path}" is not a git repository with a "${wanted}" branch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #chat(type: string, flow: string, input: CreateScenarioInput): Promise<CreatedScenario> {
    const { store, vcs, scenariosDir } = this.#options;
    const name = input.name ?? 'chat';
    const id = genericChatId(name);
    const existing = await store.scenarios.get(id);
    if (existing !== undefined) return { scenario: existing, created: false };
    if (!supportsInit(vcs)) {
      throw new AdapterUnavailable('This Vcs adapter cannot create the folder of a chat');
    }
    const folder = join(scenariosDir, id);
    await mkdir(folder, { recursive: true });
    const { branch } = await vcs.init(folder, { branch: 'main' });
    const scenario = await store.scenarios.create({
      id,
      kind: 'chat',
      flowId: flow,
      name,
      folder,
      profile: null,
      baseBranch: branch,
    });
    await this.#announce(scenario, type);
    return { scenario, created: true };
  }

  async #announce(scenario: ScenarioRecord, type: string): Promise<void> {
    await this.#options.store.events.append({
      ...buildDaemonEvent('scenario.created', {
        scenarioId: scenario.id,
        type,
        flow: scenario.flowId,
        name: scenario.name,
        folder: scenario.folder,
      }),
      scenarioId: scenario.id,
    });
  }
}
