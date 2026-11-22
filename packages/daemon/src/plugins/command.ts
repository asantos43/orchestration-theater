// SPDX-License-Identifier: MPL-2.0
import { composeClock } from '../compose.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandContext } from '../commands.js';
import { loadConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths, ensureDataDir, type Env } from '../paths.js';
import { defaultRegistryEntries } from '../registries.js';
import { formatActivation, summarizeActivation } from './activation-text.js';
import { originTextOf, PluginInstaller, type InstallResult } from './install.js';
import { PluginRegistry, type PluginView } from './registry.js';
import type { CommandRunner } from './sources.js';

export const PLUGIN_ACTIONS = ['install', 'list', 'update', 'remove', 'enable', 'disable'] as const;
export type PluginAction = (typeof PLUGIN_ACTIONS)[number];

export function isPluginAction(name: string): name is PluginAction {
  return (PLUGIN_ACTIONS as readonly string[]).includes(name);
}

/** What `ot plugin` takes from the command line (parsed by `cli.ts`). */
export interface PluginOptions {
  /** `enable`, `disable`: the project; `list`: only the plugins on in that project. */
  readonly project?: string | undefined;
  /** `enable`: approve without asking (the activation text is printed all the same). */
  readonly yes: boolean;
  readonly json: boolean;
}

/** What the command needs from outside, so a test runs it without a process or a terminal. */
export interface PluginCommandDeps {
  readonly env: Env;
  /** What a relative folder of `install` is relative to. */
  readonly cwd: string;
  /** Asks a yes or no in the terminal; none without a terminal (`enable` then needs `--yes`). */
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  /** Runs `npm` and `git` (default: the real ones). Tests give the real ones with a local registry. */
  readonly runner?: CommandRunner | undefined;
}

/**
 * `ot plugin <install|list|update|remove|enable|disable>` (architecture 5.14; Phase 9, P4). Unlike
 * `ot profile` and `ot executor` it does not need the daemon stopped: the commands write
 * `<data>/plugins.json` atomically and under a lock, and a running daemon sees the file change and
 * swaps its snapshot of the registries (N235 (a)). Nothing here runs code of a plugin.
 *
 * `install` and `update` never turn a plugin on. `enable` shows what the plugin asks for (tools
 * with roles and effects, secrets, events, the server that will run) and approves the manifest
 * that was shown, by its hash.
 */
export async function runPluginCommand(
  context: CommandContext,
  deps: PluginCommandDeps,
  action: PluginAction,
  args: readonly string[],
  options: PluginOptions,
): Promise<number> {
  const { t } = context;
  const usage = (key: string): number => {
    context.err(t(key));
    context.err(t('usage.hint'));
    return EXIT_USAGE;
  };

  // The arguments are checked before the data directory is touched.
  switch (action) {
    case 'list':
      if (args.length > 0) return usage('usage.pluginTooMany');
      break;
    case 'install':
      if (args.length === 0) return usage('usage.pluginNeedsOrigin');
      if (args.length > 1) return usage('usage.pluginTooMany');
      break;
    case 'update':
      if (args.length === 0) return usage('usage.pluginNeedsId');
      if (args.length > 2) return usage('usage.pluginTooMany');
      break;
    case 'remove':
      if (args.length === 0) return usage('usage.pluginNeedsId');
      if (args.length > 1) return usage('usage.pluginTooMany');
      break;
    case 'enable':
    case 'disable':
      if (args.length === 0) return usage('usage.pluginNeedsId');
      if (args.length > 1) return usage('usage.pluginTooMany');
      if (options.project === undefined) return usage('usage.pluginNeedsProject');
      break;
  }

  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);
  const config = await loadConfig(paths.config);
  const clock = composeClock(context.overrides);
  const frameworkToolNames = defaultRegistryEntries().tools.map((tool) => tool.name);
  const registry = await PluginRegistry.open({
    dataDir: paths.dataDir,
    clock,
    logger: createSilentLogger(),
    frameworkToolNames,
  });
  try {
    const installer = new PluginInstaller({
      registry,
      dataDir: paths.dataDir,
      sources: config.plugins.install.sources,
      timeoutMs: config.plugins.install.timeout,
      env: deps.env,
      cwd: deps.cwd,
      runner: deps.runner,
      frameworkToolNames,
    });
    const [first = '', second] = args;
    switch (action) {
      case 'install':
        return reportInstall(context, options, await installer.install(first));
      case 'update':
        return reportInstall(context, options, await installer.update(first, second));
      case 'remove': {
        const { record, folderDeleted } = await installer.remove(first);
        if (options.json) printJson(context, { removed: record.id, folderDeleted });
        else context.out(t('plugin.removed', { id: record.id, version: record.version }));
        return EXIT_OK;
      }
      case 'list': {
        const views = registry
          .list()
          .filter(
            (view) =>
              options.project === undefined ||
              view.projects.some((entry) => entry.project === options.project),
          );
        if (options.json) {
          printJson(context, views.map(viewJson));
          return EXIT_OK;
        }
        if (views.length === 0) context.out(t('plugin.none'));
        for (const view of views) context.out(listLine(context, view));
        return EXIT_OK;
      }
      case 'enable':
        return await enable(context, deps, registry, first, options);
      case 'disable': {
        const changed = await registry.disable(first, options.project ?? '');
        if (options.json)
          printJson(context, { id: first, project: options.project, disabled: changed });
        else
          context.out(
            t(changed ? 'plugin.disabled' : 'plugin.alreadyOff', {
              id: first,
              project: options.project ?? '',
            }),
          );
        return EXIT_OK;
      }
    }
  } finally {
    registry.close();
  }
}

async function enable(
  context: CommandContext,
  deps: PluginCommandDeps,
  registry: PluginRegistry,
  id: string,
  options: PluginOptions,
): Promise<number> {
  const { t } = context;
  const project = options.project ?? '';
  const { manifest, hash } = await registry.readCurrent(id);
  const state = registry.get(id)?.projects.find((entry) => entry.project === project)?.state;
  if (state === 'active') {
    if (options.json) printJson(context, { id, project, enabled: false, alreadyOn: true });
    else context.out(t('plugin.alreadyOn', { id, project }));
    return EXIT_OK;
  }
  const summary = summarizeActivation(manifest);
  if (!options.json) {
    if (state === 'needs_approval') context.out(t('plugin.manifestChanged', { id, project }));
    for (const line of formatActivation(summary, t)) context.out(line);
  }
  if (!options.yes) {
    if (deps.confirm === undefined) {
      context.err(t('plugin.needsYes', { id }));
      return EXIT_USAGE;
    }
    if (!(await deps.confirm(t('plugin.confirm', { id, project })))) {
      context.err(t('plugin.declined', { id, project }));
      return EXIT_FAILED;
    }
  }
  // The hash is the one that was shown: if the file changed meanwhile, nothing is approved.
  await registry.enable(id, project, hash);
  if (options.json) printJson(context, { id, project, enabled: true, manifestHash: hash, summary });
  else context.out(t('plugin.enabled', { id, project }));
  return EXIT_OK;
}

function reportInstall(
  context: CommandContext,
  options: PluginOptions,
  result: InstallResult,
): number {
  const { t } = context;
  if (options.json) {
    printJson(context, {
      id: result.id,
      version: result.version,
      kind: result.outcome.kind,
      origin: result.origin,
      dir: result.dir,
      manifestHash: result.manifestHash,
      needsApproval: result.outcome.needsApproval,
    });
    return EXIT_OK;
  }
  const origin = originTextOf(result.origin);
  context.out(
    t(result.outcome.kind === 'installed' ? 'plugin.installed' : 'plugin.updated', {
      id: result.id,
      version: result.version,
      origin,
    }),
  );
  if (result.outcome.kind === 'installed') {
    context.out(t('plugin.installedHint', { id: result.id }));
  } else if (result.outcome.needsApproval.length > 0) {
    context.out(
      t('plugin.needsApproval', {
        id: result.id,
        projects: result.outcome.needsApproval.join(', '),
      }),
    );
  }
  return EXIT_OK;
}

function listLine(context: CommandContext, view: PluginView): string {
  const { t } = context;
  const projects =
    view.projects.length === 0
      ? t('plugin.projectsNone')
      : view.projects
          .map((entry) => `${entry.project} (${t(`plugin.state.${entry.state}`)})`)
          .join(', ');
  const line = t('plugin.line', {
    id: view.id,
    version: view.version,
    origin: originTextOf(view.origin),
    projects,
  });
  return view.problem === undefined
    ? line
    : `${line}\n  ${t('plugin.problem', { problem: view.problem.split('\n').join('\n  ') })}`;
}

/** The JSON of a plugin in the list: what the file keeps, with the state of each project. */
function viewJson(view: PluginView): unknown {
  return {
    id: view.id,
    version: view.version,
    origin: view.origin,
    dir: view.dir,
    manifestHash: view.manifestHash,
    currentManifestHash: view.currentManifestHash ?? null,
    problem: view.problem ?? null,
    projects: view.projects,
  };
}

function printJson(context: CommandContext, value: unknown): void {
  context.out(JSON.stringify(value, null, 2));
}
