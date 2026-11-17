// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  type Registries,
  type ScenarioRecord,
  type Store,
  supportsHistory,
  supportsInit,
  type Vcs,
} from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';

export interface ScenarioServiceOptions {
  readonly store: Pick<Store, 'events' | 'scenarioRepos' | 'scenarios'>;
  readonly vcs: Vcs;
  readonly registries: Pick<Registries, 'scenarioTypes'>;
  /** `<dataDir>/scenarios`: the folder of a scenario that has no repository of its own. */
  readonly scenariosDir: string;
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
}

export interface CreatedScenario {
  readonly scenario: ScenarioRecord;
  /** False when the scenario already existed and was only reopened. */
  readonly created: boolean;
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

  constructor(options: ScenarioServiceOptions) {
    this.#options = options;
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
    const base = input.base ?? 'main';
    try {
      if (!supportsHistory(vcs)) throw new Error('the Vcs adapter cannot read refs');
      await vcs.resolveRef(path, base);
    } catch (error) {
      throw new InvalidInput(
        `"${path}" is not a git repository with a "${base}" branch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const id = projectScenarioId(path);
    const existing = await store.scenarios.get(id);
    const scenario =
      existing ??
      (await store.scenarios.create({
        id,
        kind: 'project',
        flowId: flow,
        name: input.name ?? basename(path),
        folder: path,
        profile: 'software',
        baseBranch: base,
      }));
    await store.scenarioRepos.put({ scenarioId: id, path, mainBranch: base });
    if (existing === undefined) await this.#announce(scenario, type);
    return { scenario, created: existing === undefined };
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
