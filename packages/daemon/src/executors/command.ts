// SPDX-License-Identifier: MPL-2.0
import { hasErrorCode, ROLE_IDS, type ClientAdapter, type RoleId } from '@otheater/core';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandContext } from '../commands.js';
import { compose, productionClients } from '../compose.js';
import { loadConfig } from '../config.js';
import type { ClientFactory } from '../clients.js';
import { InstanceLock, releaseOnFailure } from '../instance-lock.js';
import { dataPaths, ensureDataDir, type Env } from '../paths.js';
import { buildDaemonRegistries } from '../registries.js';
import {
  ExecutorService,
  type AddExecutorResult,
  type CheckedExecutor,
  type ExecutorDraftView,
  type ExecutorView,
  type RegisterIssue,
  type RemoveExecutorResult,
  type RolePlacementInput,
} from './service.js';
import type { TestSession } from './test-session.js';

export const EXECUTOR_ACTIONS = ['models', 'add', 'list', 'check', 'remove'] as const;
export type ExecutorAction = (typeof EXECUTOR_ACTIONS)[number];

export function isExecutorAction(name: string): name is ExecutorAction {
  return (EXECUTOR_ACTIONS as readonly string[]).includes(name);
}

/** What `ot executor` takes from the command line (parsed by `cli.ts`). */
export interface ExecutorOptions {
  /** `add`: the effort (`low`, `medium`, `high`); default: the one the catalog suggests. */
  readonly effort?: string | undefined;
  /** `add`: the family of the model (the provider of the Executor), when the catalog gives none. */
  readonly family?: string | undefined;
  /** `add`: the name of the model inside the Executor id (default: derived from the model id). */
  readonly as?: string | undefined;
  /** `add`: URL of the local model server, when the catalog gives none. */
  readonly localUrl?: string | undefined;
  /** `add`: `llama-cpp` (default) or `ollama`. */
  readonly localServer?: string | undefined;
  /** `add`: `<role>` or `<role>:<position>`, to put the Executor in that role (repeatable). */
  readonly roles: readonly string[];
  /** `add`: `--test-session` runs the short test session, `--no-test-session` skips it. */
  readonly testSession?: boolean | undefined;
  /** `add`: report everything, write nothing. */
  readonly dryRun: boolean;
  /** `list`: only the Executors of this profile. */
  readonly profile?: string | undefined;
  /** `list`: also the removed ones. */
  readonly all: boolean;
  readonly json: boolean;
}

/** What the command needs from outside, so a test runs it without a process or a terminal. */
export interface ExecutorCommandDeps {
  /** Builds the adapters (default: the real clients found in `PATH`). Tests pass the fake. */
  readonly clients?: ClientFactory | undefined;
  readonly env: Env;
  /**
   * Runs the short test session. Not given in the terminal: an `ot` command has no execution (the
   * daemon is stopped), so `executors.test_session: run` only warns. Tests give a fake one.
   */
  readonly testSession?: TestSession | undefined;
}

/** `<role>` or `<role>:<position>`; a string is the reason it is wrong. */
export function parseRoleOption(text: string): RolePlacementInput | string {
  const [role, position, ...extra] = text.split(':');
  if (role === undefined || !(ROLE_IDS as readonly string[]).includes(role) || extra.length > 0) {
    return `--role ${JSON.stringify(text)}: use <role> or <role>:<position>; roles: ${ROLE_IDS.join(', ')}`;
  }
  if (position === undefined) return { role: role as RoleId };
  if (!/^\d+$/.test(position)) {
    return `--role ${JSON.stringify(text)}: the position is a number from 0 (0 is the first)`;
  }
  return { role: role as RoleId, position: Number(position) };
}

/**
 * `ot executor <models|add|list|check|remove>` (architecture 5.7, "Cadastro"; Phase 5, P14). No
 * screen (N121): text, or JSON with `--json`. Like `ot profile`, the terminal works on the data
 * directory by itself, so with a daemon running it refuses. Nothing here spends tokens unless the
 * Producer asks for the test session (and this command has no execution to run it: see
 * {@link ExecutorCommandDeps.testSession}).
 */
export async function runExecutorCommand(
  context: CommandContext,
  deps: ExecutorCommandDeps,
  action: ExecutorAction,
  args: readonly string[],
  options: ExecutorOptions,
): Promise<number> {
  const { t } = context;
  const usage = (key: string, vars: Record<string, string> = {}): number => {
    context.err(t(key, vars));
    context.err(t('usage.hint'));
    return EXIT_USAGE;
  };

  // The arguments are checked before the store is touched.
  const placements: RolePlacementInput[] = [];
  switch (action) {
    case 'list':
      if (args.length > 0) return usage('usage.executorTooMany');
      break;
    case 'models': {
      const [profile, ...extra] = args;
      if (profile === undefined) return usage('usage.executorNeedsProfile');
      if (extra.length > 0) return usage('usage.executorTooMany');
      break;
    }
    case 'add': {
      const [profile, model, ...extra] = args;
      if (profile === undefined || model === undefined) return usage('usage.executorNeedsModel');
      if (extra.length > 0) return usage('usage.executorTooMany');
      for (const text of options.roles) {
        const parsed = parseRoleOption(text);
        if (typeof parsed === 'string') return usage('usage.executorRole', { reason: parsed });
        placements.push(parsed);
      }
      if (
        options.localServer !== undefined &&
        options.localServer !== 'llama-cpp' &&
        options.localServer !== 'ollama'
      ) {
        return usage('usage.executorLocalServer');
      }
      break;
    }
    case 'check': {
      const [, ...extra] = args;
      if (extra.length > 0) return usage('usage.executorTooMany');
      break;
    }
    case 'remove': {
      const [id, ...extra] = args;
      if (id === undefined) return usage('usage.executorNeedsId');
      if (extra.length > 0) return usage('usage.executorTooMany');
      break;
    }
  }

  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);
  const config = await loadConfig(paths.config);
  let lock: InstanceLock;
  try {
    lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
  } catch (error) {
    if (hasErrorCode(error, 'CONFLICT')) {
      context.err(t('executor.daemonRunning'));
      return EXIT_FAILED;
    }
    throw error;
  }
  const registries = buildDaemonRegistries();
  const composition = await releaseOnFailure(lock, () =>
    compose(config, {
      dataDir: paths.dataDir,
      events: { registry: registries.events, unknownType: config.events.unknown_type },
      ...(context.overrides === undefined ? {} : { overrides: context.overrides }),
    }),
  );
  try {
    const adapters = new Map<string, ClientAdapter>();
    if (composition.launcher !== undefined) {
      const factory = deps.clients ?? productionClients(config, { env: deps.env });
      for (const adapter of factory({
        launcher: composition.launcher,
        clock: composition.clock,
        transport: composition.transport,
        paths,
        logger: composition.logger,
      })) {
        adapters.set(adapter.id, adapter);
      }
    }
    const service = new ExecutorService({
      store: composition.store,
      clock: composition.clock,
      logger: composition.logger,
      configPath: paths.config,
      catalogs: (client) => adapters.get(client)?.models,
      testSession: deps.testSession,
    });
    const first = args[0] ?? '';
    switch (action) {
      case 'models': {
        const list = await service.models(first);
        if (options.json) {
          printJson(context, list);
          return EXIT_OK;
        }
        if (list.length === 0) context.out(t('executor.noModels', { profile: first }));
        for (const { draft } of list) context.out(modelLine(context, draft));
        return EXIT_OK;
      }
      case 'add': {
        const result = await service.add({
          profileId: first,
          model: args[1] ?? '',
          effort: options.effort,
          family: options.family,
          alias: options.as,
          localUrl: options.localUrl,
          localServer: options.localServer as 'llama-cpp' | 'ollama' | undefined,
          roles: placements,
          testSession:
            options.testSession === undefined ? undefined : options.testSession ? 'run' : 'off',
          dryRun: options.dryRun,
        });
        return reportAdd(context, options, result);
      }
      case 'list': {
        const list = await service.list({ profileId: options.profile, all: options.all });
        if (options.json) {
          printJson(context, list);
          return EXIT_OK;
        }
        if (list.length === 0) context.out(t('executor.none'));
        for (const view of list) context.out(lineOf(context, view));
        return EXIT_OK;
      }
      case 'check': {
        const list = await service.check(args[0]);
        const failed = list.some((item) => item.validity === 'invalid');
        if (options.json) printJson(context, list);
        else {
          if (list.length === 0) context.out(t('executor.none'));
          for (const item of list) reportChecked(context, item);
        }
        return failed ? EXIT_FAILED : EXIT_OK;
      }
      case 'remove': {
        const result = await service.remove(first);
        return reportRemove(context, options, result);
      }
    }
  } finally {
    await composition.close().catch(() => undefined);
    await lock.release();
  }
}

function printJson(context: CommandContext, value: unknown): void {
  context.out(JSON.stringify(value, null, 2));
}

const show = (value: string | number | boolean | null | undefined): string =>
  value === null || value === undefined ? '-' : String(value);

function modelLine(context: CommandContext, draft: ExecutorDraftView): string {
  return context.t('executor.modelLine', {
    model: draft.model,
    effort: show(draft.effort),
    efforts: draft.efforts.length === 0 ? '-' : draft.efforts.join('/'),
    provider: draft.provider ?? context.t('executor.blank'),
    context: show(draft.contextWindow),
    tools: show(draft.toolCalls),
    local: draft.local ? ' local' : '',
  });
}

function issueLine(context: CommandContext, issue: RegisterIssue): string {
  return context.t('executor.issue', {
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
  });
}

function reportDraft(context: CommandContext, draft: ExecutorDraftView): void {
  const { t, out } = context;
  out(
    t('executor.draft', {
      model: draft.model,
      id: draft.id ?? t('executor.blank'),
      effort: show(draft.effort),
      efforts: draft.efforts.length === 0 ? '-' : draft.efforts.join('/'),
      provider: draft.provider ?? t('executor.blank'),
      context: show(draft.contextWindow),
      reasoning: show(draft.reasoning),
      tools: show(draft.toolCalls),
    }),
  );
}

function reportAdd(
  context: CommandContext,
  options: ExecutorOptions,
  result: AddExecutorResult,
): number {
  const { t, out } = context;
  if (options.json) {
    printJson(context, result);
    return result.status === 'registered' || result.status === 'dry_run' ? EXIT_OK : EXIT_FAILED;
  }
  if (result.status === 'refused') {
    if (result.draft !== null) reportDraft(context, result.draft);
    for (const issue of result.issues) out(issueLine(context, issue));
    out(t('executor.refused'));
    return EXIT_FAILED;
  }
  if (result.status === 'needs_input') {
    reportDraft(context, result.draft);
    for (const issue of result.issues) out(issueLine(context, issue));
    out(t('executor.needsInput', { fields: result.missing.join(', ') }));
    return EXIT_FAILED;
  }
  reportDraft(context, result.draft);
  out(
    t(result.status === 'dry_run' ? 'executor.dryRun' : 'executor.registered', {
      id: result.executor.id,
      provider: result.executor.provider,
    }),
  );
  if (result.localBlock !== 'none') {
    out(t(`executor.local_${result.localBlock}`, { profile: result.executor.profileId }));
  }
  if (result.cost !== null) {
    out(
      t('executor.cost', {
        input: result.cost.inputPerMTokUsd,
        output: result.cost.outputPerMTokUsd,
      }),
    );
  }
  for (const placement of result.placements) {
    out(
      t(`executor.placed_${placement.via}`, { role: placement.role, position: placement.position }),
    );
  }
  if (result.onRegister === 'ask' && result.placements.every((p) => p.via !== 'list')) {
    out(t('executor.askRoles', { roles: result.options.map((option) => option.role).join(', ') }));
  }
  for (const issue of result.issues) out(issueLine(context, issue));
  if (result.testSession !== 'skipped') out(t(`executor.session_${result.testSession}`));
  return EXIT_OK;
}

function lineOf(context: CommandContext, view: ExecutorView): string {
  return context.t('executor.line', {
    id: view.id,
    validity: view.validity,
    reason: view.invalidReason === null ? '' : ` (${view.invalidReason})`,
    model: view.model,
    provider: view.provider,
    roles: view.roles.length === 0 ? '-' : view.roles.join(','),
    configured: view.configured ? '' : ' not-in-config',
  });
}

function reportChecked(context: CommandContext, item: CheckedExecutor): void {
  context.out(
    context.t('executor.checked', {
      id: item.id,
      validity: item.validity,
      reason: item.reason === null ? '' : ` (${item.reason})`,
      changed: item.changed ? ' updated' : '',
    }),
  );
  for (const issue of item.issues) context.out(`  ${issueLine(context, issue)}`);
}

function reportRemove(
  context: CommandContext,
  options: ExecutorOptions,
  result: RemoveExecutorResult,
): number {
  if (options.json) {
    printJson(context, result);
    return EXIT_OK;
  }
  const { t, out } = context;
  out(t('executor.removed', { id: result.id }));
  if (result.rolesChanged.length > 0) {
    out(t('executor.removedFromRoles', { roles: result.rolesChanged.join(', ') }));
  }
  if (result.rolesEmptied.length > 0) {
    out(t('executor.rolesEmptied', { roles: result.rolesEmptied.join(', ') }));
  }
  return EXIT_OK;
}
