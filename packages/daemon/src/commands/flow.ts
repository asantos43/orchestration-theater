// SPDX-License-Identifier: MPL-2.0
import { readFile, stat } from 'node:fs/promises';
import { ApiRequestError, type ApiClient } from '@otheater/client';
import type { JsonObject } from '@otheater/core';
import type { TFunction } from 'i18next';
import { connectLocal } from '../chat-command.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandContext } from '../commands.js';

/**
 * `ot flow <action>` (Phase 11b, P10b): the workflows over the API of the running daemon, on the
 * methods of `@otheater/client`. Every action is [proposta] (the plan only says "the CLI `ot flow
 * validate|simulate|save|activate|deactivate|diff|list|install|bind|pause|resume|stop`"); so is
 * what each takes: a file for `validate`, `simulate` and `save`, `<id> <version>` (or `<id>@<version>`)
 * for `activate` and `deactivate`, `list [workflows|bindings|runs|packages]`, and `install` in two
 * calls (the preview, then `--approve <hash>`). The daemon must be running: the library is its own.
 */

export const FLOW_ACTIONS = [
  'validate',
  'simulate',
  'save',
  'activate',
  'deactivate',
  'diff',
  'list',
  'install',
  'bind',
  'pause',
  'resume',
  'stop',
] as const;
export type FlowAction = (typeof FLOW_ACTIONS)[number];

export function isFlowAction(name: string): name is FlowAction {
  return (FLOW_ACTIONS as readonly string[]).includes(name);
}

/** What `ot flow list` can list. */
export const FLOW_LISTS = ['workflows', 'bindings', 'runs', 'packages'] as const;
type FlowList = (typeof FLOW_LISTS)[number];

/** The values of `--state` each list takes (the packages have no state). */
const LIST_STATES = {
  workflows: ['active', 'inactive'],
  bindings: ['active', 'paused', 'stopped', 'expired'],
  runs: ['open', 'finished'],
} as const;

/** What `ot flow` takes from the command line (parsed by `cli.ts`). */
export interface FlowOptions {
  readonly json: boolean;
  /** `list`: only this workflow. */
  readonly workflow?: string | undefined;
  /** `list bindings|runs`: only this scenario. */
  readonly scenario?: string | undefined;
  /** `list`: the state (versions: active, inactive; bindings: active, paused, stopped, expired; runs: open, finished). */
  readonly state?: string | undefined;
  /** `simulate`: the values of the inputs, as a JSON object. */
  readonly input?: string | undefined;
  /** `simulate`: the output of nodes, as a JSON object by node. */
  readonly outputs?: string | undefined;
  /** `simulate`: nodes whose step fails. */
  readonly fail: readonly string[];
  /** `save`: also make it the active version. */
  readonly activate: boolean;
  /** `install`: the hash of the preview the Producer approved. */
  readonly approve?: string | undefined;
  /** `bind`: the range of versions (default: the one of `workflows.binding`). */
  readonly range?: string | undefined;
  /** `bind`: the values of the inputs the binding fixes, as a JSON object. */
  readonly params?: string | undefined;
  /** `bind`: the triggers, as a JSON array (absent: those of the definition; `[]`: none). */
  readonly triggers?: string | undefined;
  /** `bind`: a deadline, a duration (`7d`), `none` or epoch ms. */
  readonly until?: string | undefined;
  /** `bind`: the budget of a period, in USD. */
  readonly budget?: string | undefined;
  readonly period?: string | undefined;
  readonly concurrency?: string | undefined;
  readonly onBusy?: string | undefined;
}

/** What the command needs from the outside; tests give a client. */
export interface FlowDeps {
  /** The client of the daemon; without it the command connects to the daemon of the data folder. */
  readonly client?: ApiClient | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Reads a file as text (default: the file system). */
  readonly readText?: ((path: string) => Promise<string>) | undefined;
  /** Whether a path is a file (default: the file system); `simulate` takes a file or a workflow id. */
  readonly isFile?: ((path: string) => Promise<boolean>) | undefined;
}

/** A problem with an option, said to the Producer as wrong usage (`usage.flowReason.<reason>` says what). */
class FlowUsage extends Error {
  constructor(
    readonly option: string,
    readonly reason: 'present' | 'json' | 'object' | 'list' | 'positive' | 'integer' | 'choice',
    readonly detail = '',
  ) {
    super(`--${option}: ${reason}`);
  }
}

const defaultReadText = (path: string): Promise<string> => readFile(path, 'utf8');
const defaultIsFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** The words after `ot flow <action>`, checked before the daemon is called. */
function expectArgs(
  action: FlowAction,
  args: readonly string[],
): { min: number; max: number; shape: string } {
  switch (action) {
    case 'validate':
    case 'save':
      return { min: 1, max: 1, shape: '<file>' };
    case 'simulate':
      return { min: 1, max: 1, shape: '<file | id[@version]>' };
    case 'activate':
    case 'deactivate': {
      // `<id>@<version>` is one word, `<id> <version>` two.
      const joined = args.length === 1 && (args[0] ?? '').includes('@');
      return { min: joined ? 1 : 2, max: joined ? 1 : 2, shape: '<id> <version>' };
    }
    case 'diff':
      return { min: 3, max: 3, shape: '<id> <from> <to>' };
    case 'list':
      return { min: 0, max: 1, shape: `[${FLOW_LISTS.join(' | ')}]` };
    case 'install':
      return { min: 1, max: 1, shape: '<origin>' };
    case 'bind':
      return { min: 2, max: 2, shape: '<scenario> <workflow>' };
    case 'pause':
    case 'resume':
    case 'stop':
      return { min: 1, max: 1, shape: '<binding>' };
  }
}

function jsonOf(option: string, text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new FlowUsage(option, 'json', error instanceof Error ? error.message : String(error));
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectOption(option: string, text: string | undefined): JsonObject | undefined {
  const value = jsonOf(option, text);
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new FlowUsage(option, 'object');
  return value;
}

function numberOption(
  option: string,
  text: string | undefined,
  integer: boolean,
): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new FlowUsage(option, 'positive');
  if (integer && !Number.isInteger(value)) throw new FlowUsage(option, 'integer');
  return value;
}

function choiceOption<T extends string>(
  option: string,
  text: string | undefined,
  choices: readonly T[],
): T | undefined {
  if (text === undefined) return undefined;
  const found = choices.find((choice) => choice === text);
  if (found === undefined) throw new FlowUsage(option, 'choice', choices.join(', '));
  return found;
}

/** `id@version` or `id` as the target of a simulation. */
function targetOf(text: string): { workflowId: string; version?: string } {
  const at = text.indexOf('@');
  return at < 0
    ? { workflowId: text }
    : { workflowId: text.slice(0, at), version: text.slice(at + 1) };
}

/** The id and the version of `activate` and `deactivate`. */
function versionOf(args: readonly string[]): { workflowId: string; version: string } {
  const [first = '', second] = args;
  if (second !== undefined) return { workflowId: first, version: second };
  const target = targetOf(first);
  return { workflowId: target.workflowId, version: target.version ?? '' };
}

function issueText(
  t: TFunction,
  issue: { readonly path: string; readonly message: string; readonly line?: number | undefined },
): string {
  return t('flow.issue', {
    path: issue.path === '' ? '-' : issue.path,
    message: issue.message,
    at: issue.line === undefined ? '' : t('flow.atLine', { line: issue.line }),
  });
}

/** The issues the daemon lists in `details.issues` of an `invalid_input` (a save that did not validate). */
function issuesOf(
  error: ApiRequestError,
): { path: string; message: string; line?: number | undefined }[] {
  const issues = (error.details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue): issue is { path: string; message: string; line?: number | undefined } =>
      isPlainObject(issue) && typeof issue.path === 'string' && typeof issue.message === 'string',
  );
}

function short(value: unknown): string {
  const text = value === undefined ? 'null' : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Every item of a paginated list, page after page (at most 100 pages). */
async function everyItem<T>(
  page: (after: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < 100; pages += 1) {
    const answer = await page(after);
    items.push(...answer.items);
    if (answer.nextCursor === null) break;
    after = answer.nextCursor;
  }
  return items;
}

export async function runFlowCommand(
  context: CommandContext,
  deps: FlowDeps,
  action: FlowAction,
  args: readonly string[],
  options: FlowOptions,
): Promise<number> {
  const { t, err } = context;
  const usage = (key: string, params: Record<string, string | number>): number => {
    err(t(key, params));
    err(t('usage.hint'));
    return EXIT_USAGE;
  };

  const expected = expectArgs(action, args);
  if (args.length < expected.min || args.length > expected.max)
    return usage('usage.flowArguments', { action, shape: expected.shape });

  // The arguments and the options are checked before the daemon is called.
  let call: (client: ApiClient) => Promise<number>;
  try {
    call = await prepare(context, deps, action, args, options);
  } catch (error) {
    if (error instanceof FlowUsage) {
      return usage('usage.flowBadOption', {
        option: error.option,
        reason: t(`usage.flowReason.${error.reason}`, { detail: error.detail }),
      });
    }
    if (error instanceof FlowFileError) {
      err(t('flow.readFailed', { path: error.path, reason: error.reason }));
      return EXIT_FAILED;
    }
    throw error;
  }

  const client = deps.client ?? (await connectLocal(context, deps.signal))?.client;
  if (client === undefined) return EXIT_FAILED;
  try {
    return await call(client);
  } catch (error) {
    if (!(error instanceof ApiRequestError)) throw error;
    err(
      t('flow.refused', {
        code: error.code,
        message: error.message.replace(/^[^:]*: \w+ \(HTTP \d+\): /, ''),
      }),
    );
    for (const issue of issuesOf(error)) err(`  ${issueText(t, issue)}`);
    return EXIT_FAILED;
  }
}

class FlowFileError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** Reads the file of a definition; a failure is a {@link FlowFileError}. */
async function readDefinition(deps: FlowDeps, path: string): Promise<string> {
  try {
    return await (deps.readText ?? defaultReadText)(path);
  } catch (error) {
    throw new FlowFileError(path, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Checks the arguments and the options of an action and gives the call to make once there is a
 * client. Everything that can be wrong with the command line is thrown here.
 */
async function prepare(
  context: CommandContext,
  deps: FlowDeps,
  action: FlowAction,
  args: readonly string[],
  options: FlowOptions,
): Promise<(client: ApiClient) => Promise<number>> {
  const { t, out, err } = context;
  const show = (value: unknown): void => {
    out(JSON.stringify(value, null, 2));
  };
  const [first = '', second = '', third = ''] = args;

  switch (action) {
    case 'validate': {
      const yaml = await readDefinition(deps, first);
      return async (client) => {
        const result = await client.validateWorkflow({ yaml });
        if (options.json) show(result);
        else {
          if (result.ok && result.workflow !== null) {
            out(
              t('flow.validate.ok', {
                id: result.workflow.id,
                version: result.workflow.version,
                hash: result.workflow.hash,
              }),
            );
          } else err(t('flow.validate.invalid', { count: result.errors.length }));
          for (const issue of result.errors) err(`  ${issueText(t, issue)}`);
          for (const issue of result.warnings)
            out(t('flow.warning', { text: issueText(t, issue) }));
        }
        return result.ok ? EXIT_OK : EXIT_FAILED;
      };
    }

    case 'simulate': {
      const input = objectOption('input', options.input);
      const outputs = objectOption('outputs', options.outputs);
      const isFile = await (deps.isFile ?? defaultIsFile)(first);
      const source = isFile ? { yaml: await readDefinition(deps, first) } : targetOf(first);
      return async (client) => {
        const result = await client.simulateWorkflow({
          ...source,
          ...(input === undefined ? {} : { inputs: input }),
          ...(outputs === undefined
            ? {}
            : { outputs: outputs as Record<string, JsonObject | JsonObject[]> }),
          ...(options.fail.length === 0 ? {} : { fail: [...options.fail] }),
        });
        if (options.json) show(result);
        else if (!result.ok) {
          err(t('flow.simulate.refused', { reason: result.reason, detail: result.detail }));
          for (const issue of result.errors) err(`  ${issueText(t, issue)}`);
        } else {
          out(
            t('flow.simulate.head', {
              id: result.workflow.id,
              version: result.workflow.version,
              status: result.status,
              ended: result.ended,
            }),
          );
          result.path.forEach((step, index) => {
            out(
              t('flow.simulate.step', {
                n: index + 1,
                node: step.node,
                step: step.step,
                to: step.to,
                via: step.via,
              }),
            );
            if (step.effects.length > 0)
              out(t('flow.simulate.effects', { effects: step.effects.join(', ') }));
          });
          if (result.status === 'truncated') out(t('flow.simulate.truncated'));
          for (const issue of result.warnings)
            out(t('flow.warning', { text: issueText(t, issue) }));
        }
        return result.ok ? EXIT_OK : EXIT_FAILED;
      };
    }

    case 'save': {
      const yaml = await readDefinition(deps, first);
      return async (client) => {
        const result = await client.saveWorkflow({
          yaml,
          ...(options.activate ? { activate: true } : {}),
        });
        if (options.json) show(result);
        else
          out(
            t('flow.saved', {
              id: result.version.workflowId,
              version: result.version.version,
              state: result.version.state,
            }),
          );
        return EXIT_OK;
      };
    }

    case 'activate':
    case 'deactivate': {
      const target = versionOf(args);
      if (target.version === '') throw new FlowUsage('version', 'present');
      return async (client) => {
        if (action === 'activate') {
          const result = await client.activateWorkflow(target.workflowId, target.version);
          if (options.json) show(result);
          else
            out(
              t('flow.activated', {
                id: target.workflowId,
                version: target.version,
                mode: t(`flow.mode.${result.runningOnChange}`),
              }),
            );
        } else {
          const result = await client.deactivateWorkflow(target.workflowId, target.version);
          if (options.json) show(result);
          else out(t('flow.deactivated', { id: target.workflowId, version: target.version }));
        }
        return EXIT_OK;
      };
    }

    case 'diff':
      return async (client) => {
        const result = await client.diffWorkflow(first, second, third);
        if (options.json) show(result);
        else if (result.same) out(t('flow.diff.same', { id: first, from: second, to: third }));
        else {
          out(
            t('flow.diff.head', {
              id: first,
              from: second,
              to: third,
              count: result.changes.length,
            }),
          );
          for (const change of result.changes) {
            out(
              t('flow.diff.change', { change: change.change, area: change.area, key: change.key }),
            );
            if (change.before !== null) out(t('flow.diff.before', { value: short(change.before) }));
            if (change.after !== null) out(t('flow.diff.after', { value: short(change.after) }));
          }
        }
        return EXIT_OK;
      };

    case 'list': {
      const what =
        choiceOption<FlowList>('list', args[0] ?? 'workflows', FLOW_LISTS) ?? 'workflows';
      // The state is checked here, before the daemon is called.
      if (what !== 'packages') choiceOption('state', options.state, LIST_STATES[what]);
      return async (client) => listWhat(context, client, what, options);
    }

    case 'install':
      return async (client) => {
        const result = await client.installWorkflowPackage({
          origin: first,
          ...(options.approve === undefined ? {} : { approvedHash: options.approve }),
        });
        if (options.json) show(result);
        else if (result.status === 'preview') {
          const preview = result.preview;
          out(
            t('flow.install.package', {
              id: preview.packageId,
              version: preview.version,
              count: preview.workflows.length,
              hash: preview.hash,
            }),
          );
          const permissions = [
            ...preview.permissions.tools,
            ...preview.permissions.plugins,
            ...preview.permissions.effects,
            ...preview.permissions.publicWrites,
          ];
          out(
            t('flow.install.permissions', {
              list: permissions.length === 0 ? t('flow.none') : permissions.join(', '),
            }),
          );
          if (preview.newPermissions.length > 0)
            out(t('flow.install.newPermissions', { list: preview.newPermissions.join(', ') }));
          out(
            t('flow.install.signature', {
              state: preview.signature.state,
              detail: preview.signature.detail,
            }),
          );
          if (preview.outcome.kind === 'refused') {
            err(
              t('flow.install.refused', {
                reason: preview.outcome.reason,
                detail: preview.outcome.detail,
              }),
            );
          } else {
            if (preview.outcome.confirm.length > 0)
              out(t('flow.install.confirm', { list: preview.outcome.confirm.join(', ') }));
            out(t('flow.install.approve', { hash: preview.hash }));
          }
        } else {
          out(
            t('flow.install.done', {
              id: result.preview.packageId,
              version: result.preview.version,
              status: result.status,
            }),
          );
          for (const workflow of result.workflows) {
            out(
              t('flow.install.workflow', {
                id: workflow.id,
                version: workflow.version,
                state: workflow.active ? 'active' : 'inactive',
              }),
            );
          }
        }
        const refused = result.preview.outcome.kind === 'refused';
        return refused && result.status === 'preview' ? EXIT_FAILED : EXIT_OK;
      };

    case 'bind': {
      const params = objectOption('params', options.params);
      const triggers = jsonOf('triggers', options.triggers);
      if (triggers !== undefined && !(Array.isArray(triggers) && triggers.every(isPlainObject)))
        throw new FlowUsage('triggers', 'list');
      const budget = numberOption('budget', options.budget, false);
      const concurrency = numberOption('concurrency', options.concurrency, true);
      const period = choiceOption('period', options.period, ['day', 'week', 'month'] as const);
      const onBusy = choiceOption('on-busy', options.onBusy, ['queue', 'skip', 'replace'] as const);
      const until =
        options.until === undefined
          ? undefined
          : /^\d+$/u.test(options.until)
            ? Number(options.until)
            : options.until;
      return async (client) => {
        const result = await client.bindWorkflow({
          scenarioId: first,
          workflowId: second,
          ...(options.range === undefined ? {} : { versionRange: options.range }),
          ...(params === undefined ? {} : { params }),
          ...(triggers === undefined ? {} : { triggers }),
          ...(until === undefined ? {} : { until }),
          ...(budget === undefined ? {} : { budgetUsd: budget }),
          ...(period === undefined ? {} : { budgetPeriod: period }),
          ...(concurrency === undefined ? {} : { concurrency }),
          ...(onBusy === undefined ? {} : { onBusy }),
        });
        if (options.json) show(result);
        else
          out(
            t('flow.bound', {
              id: result.id,
              scenarioId: result.scenarioId,
              workflowId: result.workflowId,
              range: result.versionRange,
              count: result.triggers.length,
              state: result.state,
            }),
          );
        return EXIT_OK;
      };
    }

    case 'pause':
    case 'resume':
    case 'stop':
      return async (client) => {
        const result =
          action === 'pause'
            ? await client.pauseWorkflowBinding(first)
            : action === 'resume'
              ? await client.resumeWorkflowBinding(first)
              : await client.stopWorkflowBinding(first);
        if (options.json) show(result);
        else out(t('flow.bindingNow', { id: result.id, state: result.state }));
        return EXIT_OK;
      };
  }
}

/** `ot flow list [workflows|bindings|runs|packages]`: one line per item. */
async function listWhat(
  context: CommandContext,
  client: ApiClient,
  what: FlowList,
  options: FlowOptions,
): Promise<number> {
  const { t, out } = context;
  const lines: string[] = [];
  let all: unknown[];
  switch (what) {
    case 'workflows': {
      const items = await everyItem((after) =>
        client.listWorkflows({
          ...(after === undefined ? {} : { after }),
          ...(options.workflow === undefined ? {} : { workflowId: options.workflow }),
          ...(options.state === undefined
            ? {}
            : { state: choiceOption('state', options.state, ['active', 'inactive'] as const) }),
        }),
      );
      all = items;
      for (const item of items)
        lines.push(
          t('flow.list.version', {
            id: item.workflowId,
            version: item.version,
            state: item.state,
            source: item.source,
          }),
        );
      break;
    }
    case 'bindings': {
      const items = await everyItem((after) =>
        client.listWorkflowBindings({
          ...(after === undefined ? {} : { after }),
          ...(options.workflow === undefined ? {} : { workflowId: options.workflow }),
          ...(options.scenario === undefined ? {} : { scenarioId: options.scenario }),
          ...(options.state === undefined
            ? {}
            : {
                state: choiceOption('state', options.state, [
                  'active',
                  'paused',
                  'stopped',
                  'expired',
                ] as const),
              }),
        }),
      );
      all = items;
      for (const item of items) {
        lines.push(
          t('flow.list.binding', {
            id: item.id,
            scenarioId: item.scenarioId,
            workflowId: item.workflowId,
            range: item.versionRange,
            state: item.state,
            budget:
              item.budgetUsd === null
                ? t('flow.noBudget')
                : t('flow.budget', {
                    budget: item.budgetUsd.toFixed(2),
                    period: item.budgetPeriod,
                    spent: item.spentUsd.toFixed(2),
                  }),
          }),
        );
      }
      break;
    }
    case 'runs': {
      const items = await everyItem((after) =>
        client.listWorkflowRuns({
          ...(after === undefined ? {} : { after }),
          ...(options.workflow === undefined ? {} : { workflowId: options.workflow }),
          ...(options.scenario === undefined ? {} : { scenarioId: options.scenario }),
          ...(options.state === undefined
            ? {}
            : { status: choiceOption('state', options.state, ['open', 'finished'] as const) }),
        }),
      );
      all = items;
      for (const item of items) {
        lines.push(
          t('flow.list.run', {
            runId: item.runId,
            scenarioId: item.scenarioId,
            workflowId: item.workflow.id,
            version: item.workflow.version,
            state: item.state,
            steps: item.steps,
            status: item.finishedAt === null ? 'open' : 'finished',
          }),
        );
      }
      break;
    }
    case 'packages': {
      const { items } = await client.listWorkflowPackages();
      all = items;
      for (const item of items) {
        lines.push(
          t('flow.list.package', {
            id: item.id,
            version: item.version,
            workflows: item.workflows.join(', '),
            signature: item.signature,
          }),
        );
      }
      break;
    }
  }
  if (options.json) out(JSON.stringify(all, null, 2));
  else if (lines.length === 0) out(t('flow.list.none'));
  else for (const line of lines) out(line);
  return EXIT_OK;
}
