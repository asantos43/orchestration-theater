// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the setup assistant only (excluded from the build of the package).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ExecutorDraft,
  type ModelCatalog,
  type ModelInfo,
  type Clock,
  type Store,
  type ValidationResult,
} from '@otheater/core';
import { loadConfig } from '../config.js';
import { ExecutorService } from '../executors/service.js';
import { fixtureOpenCodeCatalog } from '../executors/opencode-catalog-fixture.js';
import { createSilentLogger } from '../logger.js';
import type { ProfileService, ProfileSummary } from '../profiles/service.js';
import { makeTempDataDir } from '../test-helpers.js';
import { SetupService, type SetupServiceOptions } from './service.js';

export const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

/** A catalog that lists the ids it is given, like the one of Claude Code or Codex does. */
export class ListCatalog implements ModelCatalog {
  readonly discovery = 'automatic';
  readonly #models: readonly ModelInfo[];
  readonly #fail: boolean;

  constructor(
    ids: readonly string[],
    options: { fail?: boolean; efforts?: readonly string[] } = {},
  ) {
    this.#fail = options.fail === true;
    this.#models = ids.map((id) => ({ id, efforts: options.efforts ?? [], local: false }));
  }

  list(): Promise<readonly ModelInfo[]> {
    return this.#fail
      ? Promise.reject(new Error('the catalog is down'))
      : Promise.resolve(this.#models);
  }

  suggest(): Partial<ExecutorDraft> {
    return {};
  }

  validate(): Promise<ValidationResult> {
    return Promise.resolve({ ok: true, issues: [] });
  }
}

export const CLAUDE = 'claude-code/main';
export const CODEX = 'codex/main';
export const MINIMAX = 'opencode/minimax';
/** The model of the OpenCode fixture catalog the API account registers. */
export const MINIMAX_MODEL = 'minimax/MiniMax-M2';
export const MINIMAX_EXECUTOR = 'minimax-m2-medium@opencode/minimax';

export interface FakeProfile {
  readonly client: string;
  readonly name: string;
  readonly kind: 'token_plan' | 'api';
  readonly provider: string;
  /** What the daemon says about the login of a subscription account. */
  readonly login?: 'logged_in' | 'logged_out' | 'unknown';
}

export const DEFAULT_PROFILES: readonly FakeProfile[] = [
  {
    client: 'claude-code',
    name: 'main',
    kind: 'token_plan',
    provider: 'anthropic',
    login: 'logged_in',
  },
  { client: 'codex', name: 'main', kind: 'token_plan', provider: 'openai', login: 'logged_in' },
  { client: 'opencode', name: 'minimax', kind: 'api', provider: 'minimax' },
];

export interface SetupRig {
  readonly store: Store;
  readonly dir: string;
  readonly configPath: string;
  readonly logins: Map<string, 'logged_in' | 'logged_out' | 'unknown'>;
  readonly catalogs: Record<string, ModelCatalog>;
  /** A service over the store of the rig: calling it again is what a restart of the daemon is. */
  service(extra?: Pick<SetupServiceOptions, 'redetect' | 'clientReasons'>): SetupService;
  config(): ReturnType<typeof loadConfig>;
  text(): Promise<string>;
  dispose(): Promise<void>;
}

export interface RigOptions {
  readonly configYaml?: string;
  readonly profiles?: readonly FakeProfile[];
  /** The store and the clock come from the test file (rule testing-only-from-tests). */
  readonly store: Store;
  readonly clock: Clock;
  readonly catalogs?: Partial<Record<string, ModelCatalog>>;
  readonly installed?: readonly string[];
}

/**
 * Fake profiles over the store (no vault, no probe, no client): the key of an API account is a
 * reference name in the row, never a secret.
 */
export async function makeSetupRig(options: RigOptions): Promise<SetupRig> {
  const data = await makeTempDataDir();
  const configPath = join(data.dir, 'config.yaml');
  if (options.configYaml !== undefined) await writeFile(configPath, options.configYaml);
  const { store, clock } = options;
  const logins = new Map<string, 'logged_in' | 'logged_out' | 'unknown'>();
  for (const profile of options.profiles ?? DEFAULT_PROFILES) {
    const created = await store.profiles.create({
      client: profile.client,
      name: profile.name,
      kind: profile.kind,
      provider: profile.provider,
      dir: `/profiles/${profile.client}/${profile.name}`,
      secretRef: profile.kind === 'api' ? `vault:${profile.client}-${profile.name}` : null,
    });
    logins.set(created.id, profile.login ?? 'unknown');
  }
  const opencode = fixtureOpenCodeCatalog({ profileRoot: join(data.dir, 'profiles') });
  const catalogs: Record<string, ModelCatalog> = {
    'claude-code': new ListCatalog(['opus', 'sonnet', 'haiku']),
    codex: new ListCatalog(['sol', 'luna']),
    opencode: opencode.catalog,
    ...Object.fromEntries(
      Object.entries(options.catalogs ?? {}).filter(
        (entry): entry is [string, ModelCatalog] => entry[1] !== undefined,
      ),
    ),
  };
  const profiles: Pick<ProfileService, 'list'> = {
    async list(listOptions = {}): Promise<readonly ProfileSummary[]> {
      const records = await store.profiles.list({ states: ['active', 'draining'] });
      const out: ProfileSummary[] = [];
      for (const record of records) {
        const base: ProfileSummary = {
          profile: record,
          hasSecret: record.secretRef !== null,
          executors: { valid: 0, invalid: 0 },
        };
        out.push(
          listOptions.checkLogin === true
            ? {
                ...base,
                login: record.kind === 'api' ? null : (logins.get(record.id) ?? 'unknown'),
              }
            : base,
        );
      }
      return out;
    },
  };
  const installed = new Set(options.installed ?? ['claude-code', 'codex', 'opencode']);
  /** `extra`: the search for the clients again and its reasons (P18), absent by default. */
  const service = (
    extra: Pick<SetupServiceOptions, 'redetect' | 'clientReasons'> = {},
  ): SetupService => {
    const lookup = (client: string): ModelCatalog | undefined => catalogs[client];
    return new SetupService({
      store,
      clock,
      logger: createSilentLogger(),
      configPath,
      profiles,
      executors: new ExecutorService({
        store,
        clock,
        logger: createSilentLogger(),
        configPath,
        catalogs: lookup,
      }),
      catalogs: lookup,
      installedClients: () => installed,
      ...extra,
    });
  };
  return {
    store,
    dir: data.dir,
    configPath,
    logins,
    catalogs,
    service,
    config: () => loadConfig(configPath),
    text: () => readFile(configPath, 'utf8').catch(() => ''),
    dispose: data.dispose,
  };
}
