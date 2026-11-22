// SPDX-License-Identifier: MPL-2.0
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  Conflict,
  InvalidInput,
  NotFound,
  type JsonValue,
  type PluginManifest,
  type PluginToolManifest,
} from '@otheater/core';
import type {
  ApiPanelBlock,
  ApiPlugin,
  ApiPluginActivationSummary,
  ApiPluginDetail,
  ApiPluginPanel,
  PluginActionResult,
} from '@otheater/protocol';
import type { TFunction } from 'i18next';
import { ApiFailure } from '../api/handlers.js';
import type { AskApproval } from '../browser/approval.js';
import type { Logger } from '../logger.js';
import type { SituationSink } from '../situations.js';
import { formatActivation, summarizeActivation } from './activation-text.js';
import type { ActivePlugin } from './aggregate.js';
import { approvalDetailOf, askProducerToApprove, type ApprovalOutcome } from './approval.js';
import { originTextOf } from './install.js';
import { approvalOf, type PluginPermissionSettings } from './permissions.js';
import type { PluginRegistry, PluginView } from './registry.js';
import type { PluginNoticeSink, PluginRuntimeConfig } from './runtime-config.js';

/**
 * What the REST routes of `/v1/plugins` do (Phase 9, P10; architecture 5.14). The Producer sees what
 * is installed, turns a plugin on and off in a project, reads the panel the manifest declares and
 * runs its actions. Nothing here runs code of a plugin: the daemon calls the tools the manifest
 * declares, through the same door the agents' calls use (`PluginAggregator.callTool`), and hands
 * the data to the interface, which draws it.
 *
 * [proposta] The rules of the panel:
 * - a block that reads (`source`) calls a tool the manifest declares with `effects: read`; the
 *   validator of P3 checks that at install time, and it is checked again here, so a tool that
 *   changes something is never called as a read;
 * - the data of a block is the JSON the tool answers: an array for `table` and `list` (the rows of a
 *   table are objects), an object for `metrics`; anything else is `invalid_result` for that block
 *   alone (the other blocks are drawn);
 * - a block that cannot be filled says why with a code and a fixed text of the daemon, never the
 *   text the plugin answered (it could hold an argument, a path or a secret);
 * - what is too big is cut to `plugins.panel.max_rows` and `plugins.panel.max_bytes`, with a
 *   warning and the event `plugin.panel_truncated`; the answer is never an error for being big;
 * - an action is the tool an `action` block names, called for the Producer with no arguments.
 *   The roles do not apply to the Producer; the `deny` modes of `plugins.permissions` do. The
 *   approval is the one of the agents (`approvalOf`): the call waits until the Producer answers.
 */

/** The codes a block (or an action) gives when it has no data; the texts are `plugin.panel.error.*`. */
const SOURCE_FAILURES = new Set([
  'plugin_unavailable',
  'plugin_timeout',
  'plugin_failed',
  'tool_unavailable',
]);

type BlockErrorCode =
  | 'plugin_unavailable'
  | 'plugin_timeout'
  | 'plugin_failed'
  | 'tool_unavailable'
  | 'tool_error'
  | 'invalid_result'
  | 'not_readable';

/** What a limit of `plugins.panel` cut: in rows or in bytes, of what the plugin sent. */
interface Cut {
  readonly reason: 'rows' | 'bytes';
  readonly total: number;
  readonly kept: number;
  readonly limit: number;
}

/** Who the Producer's calls are, in the events and the notices. */
const PRODUCER = 'producer';

export interface PluginPanelOptions {
  readonly registry: Pick<
    PluginRegistry,
    'list' | 'get' | 'readCurrent' | 'enable' | 'disable' | 'activeFor' | 'refresh'
  >;
  readonly aggregator: {
    callTool(
      plugin: ActivePlugin,
      project: string,
      toolName: string,
      args: Record<string, unknown> | undefined,
      signal?: AbortSignal,
    ): Promise<CallToolResult>;
  };
  /** `plugins.permissions`, read at each action (a getter: it follows the configuration). */
  readonly permissions: () => PluginPermissionSettings;
  /** `plugins.panel.*`, read at each panel. */
  readonly runtime: () => Pick<PluginRuntimeConfig, 'panelMaxRows' | 'panelMaxBytes'>;
  /** Asks the Producer through the prompt queue of the project; absent: nobody can be asked. */
  readonly askApproval?: AskApproval | undefined;
  readonly situations: SituationSink;
  readonly onNotice: PluginNoticeSink;
  readonly logger: Logger;
  /** The translator for a language tag (`en` or `pt-BR` of the daemon; others get `en`). */
  readonly translator: (language: string) => TFunction;
  /** The language when a request gives none: `ui.locale` of the daemon. */
  readonly language: () => string;
}

export class PluginPanelService {
  readonly #options: PluginPanelOptions;

  constructor(options: PluginPanelOptions) {
    this.#options = options;
  }

  /** The installed plugins; with `project`, only those that have a state there. */
  async list(project?: string): Promise<ApiPlugin[]> {
    // `ot plugin install` runs in another process: the file is read again, as the panel does.
    await this.#options.registry.refresh();
    return this.#options.registry
      .list()
      .filter(
        (view) => project === undefined || view.projects.some((entry) => entry.project === project),
      )
      .map(plainView);
  }

  /** One plugin: the manifest on disk now, and the text of what it asks for. */
  async detail(id: string, language?: string): Promise<ApiPluginDetail> {
    await this.#options.registry.refresh();
    const view = this.#installed(id);
    let current: Awaited<ReturnType<PluginRegistry['readCurrent']>>;
    try {
      current = await this.#options.registry.readCurrent(id);
    } catch (error) {
      if (!(error instanceof InvalidInput)) throw error;
      // The folder cannot be used (the manifest is invalid, or says another id): a state of the
      // plugin, not a mistake of the request. The reason is the one `ot plugin list` shows.
      throw new Conflict(
        `The plugin "${id}" cannot be used: ${view.problem ?? 'its plugin.yaml cannot be read'}`,
      );
    }
    const summary = summarizeActivation(current.manifest);
    const t = this.#options.translator(language ?? this.#options.language());
    return {
      ...plainView(view),
      currentManifestHash: current.hash,
      manifest: current.manifest,
      summary: summaryJson(summary),
      activation: formatActivation(summary, t),
    };
  }

  /**
   * Turns the plugin on in the project, approving the manifest on disk now. With `manifestHash`
   * (what the client showed), a file that changed meanwhile approves nothing (`Conflict`).
   */
  async enable(
    id: string,
    project: string,
    manifestHash: string | undefined,
  ): Promise<{ id: string; project: string; changed: boolean; manifestHash: string }> {
    const result = await this.#options.registry.enable(id, project, manifestHash);
    return { id, project, changed: result.changed, manifestHash: result.hash };
  }

  async disable(
    id: string,
    project: string,
  ): Promise<{ id: string; project: string; disabled: boolean }> {
    return { id, project, disabled: await this.#options.registry.disable(id, project) };
  }

  /** The panel of the plugin in the project: each block with its data and its texts. */
  async panel(
    id: string,
    project: string,
    language: string | undefined,
    signal?: AbortSignal,
  ): Promise<ApiPluginPanel> {
    const plugin = await this.#active(id, project);
    const wanted = language ?? this.#options.language();
    const catalog = catalogOf(plugin.manifest, wanted);
    const t = this.#options.translator(wanted);
    const settings = this.#options.permissions();
    const blocks = await Promise.all(
      plugin.manifest.panel.map(async (block): Promise<ApiPanelBlock> => {
        if (block.type === 'action') {
          const tool = toolOf(plugin.manifest, block.tool);
          return {
            type: 'action',
            label: catalog.text(block.label),
            tool: block.tool,
            approval: tool === undefined ? 'manifest' : approvalOf(tool, settings),
          };
        }
        return await this.#dataBlock(plugin, project, block, catalog.text, t, signal);
      }),
    );
    return { plugin: id, project, language: catalog.language, blocks };
  }

  /**
   * An action of the panel, for the Producer. The tool must be named by an `action` block of the
   * manifest (the panel is where the Producer clicks; the other tools are for the agents).
   */
  async action(
    id: string,
    toolName: string,
    project: string,
    signal?: AbortSignal,
  ): Promise<PluginActionResult> {
    const plugin = await this.#active(id, project);
    const tool = toolOf(plugin.manifest, toolName);
    const named = plugin.manifest.panel.some(
      (block) => block.type === 'action' && block.tool === toolName,
    );
    if (tool === undefined || !named) {
      throw new NotFound(`The panel of the plugin "${id}" has no action "${toolName}"`);
    }
    const settings = this.#options.permissions();
    if (deniedByConfig(tool, settings)) {
      this.#refused(plugin, project, tool, 'not_allowed');
      throw new ApiFailure(
        'forbidden',
        `plugins.permissions does not allow the tool ${toolName} of the plugin "${id}"`,
      );
    }
    if (approvalOf(tool, settings) !== 'none') {
      const outcome = await this.#ask(plugin, project, tool, settings);
      if (outcome !== 'approved') {
        this.#refused(plugin, project, tool, outcome);
        throw refusalOf(outcome, id, toolName);
      }
      // The plugin may have been turned off, or its manifest changed, while the Producer decided.
      await this.#active(id, project);
    }
    const reply = await this.#options.aggregator.callTool(
      plugin,
      project,
      toolName,
      undefined,
      signal,
    );
    const failed = failureCodeOf(reply);
    if (failed !== undefined) {
      return {
        plugin: id,
        project,
        tool: toolName,
        ok: false,
        result: null,
        truncated: null,
        error: { code: failed, message: this.#errorText(failed, this.#options.language()) },
      };
    }
    const { value } = readJson(reply, true);
    const kept = this.#capText(plugin.id, project, toolName, value);
    return {
      plugin: id,
      project,
      tool: toolName,
      ok: true,
      result: kept.value,
      truncated: kept.truncated,
      error: null,
    };
  }

  // ---- internals ----

  #installed(id: string): PluginView {
    const view = this.#options.registry.get(id);
    if (view === undefined) throw new NotFound(`No plugin "${id}" is installed`);
    return view;
  }

  /** The plugin when it is on in the project with the manifest approved; else 404 or 409. */
  async #active(id: string, project: string): Promise<ActivePlugin> {
    this.#installed(id);
    // As the MCP server does before a session takes its snapshot: a plugin.yaml edited on disk is
    // not seen by the watch of plugins.json.
    await this.#options.registry.refresh();
    const plugin = this.#options.registry.activeFor(project).find((entry) => entry.id === id);
    if (plugin !== undefined) return plugin;
    const state = this.#installed(id).projects.find((entry) => entry.project === project)?.state;
    throw new Conflict(
      state === undefined
        ? `The plugin "${id}" is not turned on in the project "${project}"`
        : `The plugin "${id}" is not active in the project "${project}" (${state})`,
    );
  }

  async #dataBlock(
    plugin: ActivePlugin,
    project: string,
    block: Exclude<PluginManifest['panel'][number], { type: 'action' }>,
    text: (key: string) => string,
    t: TFunction,
    signal: AbortSignal | undefined,
  ): Promise<ApiPanelBlock> {
    const title = text(block.title);
    const base = { title, source: block.source };
    const fail = (code: BlockErrorCode): ApiPanelBlock =>
      emptyBlock(block, text, base, {
        code,
        message: t(`plugin.panel.error.${code}`),
      });
    const source = toolOf(plugin.manifest, block.source);
    if (source?.effects !== 'read') return fail('not_readable');
    const reply = await this.#options.aggregator.callTool(
      plugin,
      project,
      block.source,
      undefined,
      signal,
    );
    const failed = failureCodeOf(reply);
    if (failed !== undefined) return fail(failed);
    const { value, valid } = readJson(reply, false);
    if (!valid) return fail('invalid_result');

    if (block.type === 'metrics') {
      if (!isPlainObject(value)) return fail('invalid_result');
      const cut = this.#cut(plugin.id, project, block.source, Object.entries(value));
      return {
        type: 'metrics',
        ...base,
        error: null,
        truncated: cut.truncated,
        metrics: cut.kept.map(([key, entry]) => ({ key, value: entry })),
      };
    }
    if (!Array.isArray(value)) return fail('invalid_result');
    const cut = this.#cut(plugin.id, project, block.source, value);
    if (block.type === 'list') {
      return { type: 'list', ...base, error: null, truncated: cut.truncated, items: cut.kept };
    }
    const rows: Record<string, JsonValue>[] = [];
    for (const row of cut.kept) {
      if (!isPlainObject(row)) return fail('invalid_result');
      rows.push(row);
    }
    return {
      type: 'table',
      ...base,
      error: null,
      truncated: cut.truncated,
      columns:
        block.columns?.map((column) => ({ key: column.key, label: text(column.label) })) ??
        columnsOf(rows),
      rows,
    };
  }

  /**
   * The rows of a block within `max_rows` and then within `max_bytes`. Cutting is never an error:
   * the warning and the event say what was left out. [proposta] When both limits cut, the answer
   * carries the second (bytes, of what the first left), and the log has an event for each.
   */
  #cut<T>(
    plugin: string,
    project: string,
    source: string,
    items: readonly T[],
  ): { kept: T[]; truncated: Cut | null } {
    const { panelMaxRows, panelMaxBytes } = this.#options.runtime();
    let kept = [...items];
    let truncated: Cut | null = null;
    if (kept.length > panelMaxRows) {
      truncated = { reason: 'rows', total: kept.length, kept: panelMaxRows, limit: panelMaxRows };
      this.#truncated(plugin, project, source, truncated);
      kept = kept.slice(0, panelMaxRows);
    }
    if (panelMaxBytes !== null) {
      const sizes = kept.map((item) => Buffer.byteLength(JSON.stringify(item)));
      const total = sizes.reduce((sum, size) => sum + size, 0) + 2 + Math.max(0, sizes.length - 1);
      if (total > panelMaxBytes) {
        let used = 2;
        let count = 0;
        for (const size of sizes) {
          const next = used + size + (count === 0 ? 0 : 1);
          if (next > panelMaxBytes) break;
          used = next;
          count += 1;
        }
        truncated = { reason: 'bytes', total, kept: used, limit: panelMaxBytes };
        this.#truncated(plugin, project, source, truncated);
        kept = kept.slice(0, count);
      }
    }
    return { kept, truncated };
  }

  /** The result of an action within `max_bytes`: a result that is too big is not sent (`null`). */
  #capText(
    plugin: string,
    project: string,
    source: string,
    value: JsonValue,
  ): { value: JsonValue; truncated: PluginActionResult['truncated'] } {
    const { panelMaxBytes } = this.#options.runtime();
    if (panelMaxBytes === null) return { value, truncated: null };
    const total = Buffer.byteLength(JSON.stringify(value));
    if (total <= panelMaxBytes) return { value, truncated: null };
    const truncated = { reason: 'bytes' as const, total, kept: 0, limit: panelMaxBytes };
    this.#truncated(plugin, project, source, truncated);
    return { value: null, truncated };
  }

  #truncated(plugin: string, project: string, source: string, cut: Cut): void {
    this.#options.logger.warn(
      { plugin, project, source, ...cut },
      'plugin panel data cut to the limit of plugins.panel',
    );
    try {
      this.#options.onNotice({ kind: 'panel_truncated', plugin, project, source, ...cut });
    } catch (error) {
      this.#options.logger.warn({ err: error }, 'plugin notice sink failed');
    }
  }

  #errorText(code: BlockErrorCode, language: string): string {
    return this.#options.translator(language)(`plugin.panel.error.${code}`);
  }

  /** `permission.asked`, the question, `permission.answered`: the same events as an agent's call. */
  async #ask(
    plugin: ActivePlugin,
    project: string,
    tool: PluginToolManifest,
    settings: PluginPermissionSettings,
  ): Promise<ApprovalOutcome> {
    const name = `${plugin.id}__${tool.name}`;
    const common = {
      sessionId: PRODUCER,
      tool: name.slice(0, 256),
      paths: [],
      pathCount: 0,
    };
    const correlation = { scenarioId: project };
    this.#options.situations.record('permission.asked', common, correlation);
    const outcome = await askProducerToApprove(
      this.#options.askApproval,
      project,
      `Run the action ${name} (${tool.effects}) from the panel? ` +
        approvalDetailOf(undefined, settings.approvalDetail),
    );
    this.#options.situations.record(
      'permission.answered',
      {
        ...common,
        answer: outcome === 'approved' ? 'allow' : 'reject',
        rule: `plugin:${plugin.id}`.slice(0, 256),
        reason: outcome === 'approved' ? 'plugin_tool_approved' : 'plugin_tool_refused',
      },
      correlation,
    );
    return outcome;
  }

  #refused(
    plugin: ActivePlugin,
    project: string,
    tool: PluginToolManifest,
    reason: 'not_allowed' | Exclude<ApprovalOutcome, 'approved'>,
  ): void {
    this.#options.logger.warn(
      { plugin: plugin.id, tool: tool.name, role: PRODUCER, reason },
      'plugin action refused: it did not reach the plugin',
    );
    try {
      this.#options.onNotice({
        kind: 'tool_refused',
        plugin: plugin.id,
        project,
        tool: tool.name,
        role: PRODUCER,
        reason,
      });
    } catch (error) {
      this.#options.logger.warn({ err: error }, 'plugin notice sink failed');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

/** The data of a plugin in the list, with the origin as text. */
function plainView(view: PluginView): ApiPlugin {
  return {
    id: view.id,
    version: view.version,
    origin: originTextOf(view.origin),
    description: view.manifest?.description ?? null,
    manifestHash: view.manifestHash,
    problem: view.problem ?? null,
    projects: view.projects.map((entry) => ({ project: entry.project, state: entry.state })),
  };
}

function summaryJson(summary: ReturnType<typeof summarizeActivation>): ApiPluginActivationSummary {
  return {
    id: summary.id,
    version: summary.version,
    description: summary.description ?? null,
    server:
      summary.server.type === 'stdio'
        ? {
            type: 'stdio',
            command: [...summary.server.command],
            cwd: summary.server.cwd ?? null,
          }
        : { type: 'http', url: summary.server.url },
    tools: summary.tools.map((tool) => ({
      name: tool.name,
      roles: [...tool.roles],
      specialties: [...tool.specialties],
      effects: tool.effects,
      requiresProducerApproval: tool.requiresProducerApproval,
    })),
    secrets: [...summary.secrets],
    events: [...summary.events],
    panelBlocks: summary.panelBlocks,
  };
}

function toolOf(manifest: PluginManifest, name: string): PluginToolManifest | undefined {
  return manifest.tools.find((tool) => tool.name === name);
}

/**
 * The `deny` modes of `plugins.permissions` also bind the Producer's action: they are how an owner
 * says "no plugin tool of this kind runs here". The roles and their policies do not (the Producer
 * has no role). [proposta]
 */
function deniedByConfig(
  tool: Pick<PluginToolManifest, 'effects'>,
  settings: PluginPermissionSettings,
): boolean {
  switch (tool.effects) {
    case 'read':
      return false;
    case 'local_write':
      return settings.localWrite === 'deny';
    case 'network':
      return settings.network === 'deny';
    case 'external_write':
      return settings.externalWrite === 'deny';
  }
}

function refusalOf(
  outcome: Exclude<ApprovalOutcome, 'approved'>,
  id: string,
  tool: string,
): ApiFailure {
  switch (outcome) {
    case 'approval_unavailable':
      return new ApiFailure(
        'unavailable',
        `The action ${tool} of the plugin "${id}" needs the Producer's approval and nobody can be asked right now`,
      );
    case 'approval_cancelled':
      return new ApiFailure(
        'conflict',
        `The question about the action ${tool} of the plugin "${id}" ended without an answer`,
      );
    case 'approval_denied':
      return new ApiFailure(
        'conflict',
        `The Producer did not approve the action ${tool} of the plugin "${id}"`,
      );
  }
}

/** The failure a result is, as a code, or `undefined` when the tool answered. */
function failureCodeOf(reply: CallToolResult): BlockErrorCode | undefined {
  if (reply.isError !== true) return undefined;
  const code = (reply.structuredContent as { error?: unknown } | undefined)?.error;
  return typeof code === 'string' && SOURCE_FAILURES.has(code)
    ? (code as BlockErrorCode)
    : 'tool_error';
}

/**
 * The JSON a tool answered, from the first text of its content. With `lenient`, a text that is not
 * JSON is the value itself (an action may answer "done"); otherwise it is not valid.
 */
function readJson(reply: CallToolResult, lenient: boolean): { value: JsonValue; valid: boolean } {
  const first = (reply.content as { type: string; text?: string }[]).find(
    (part) => part.type === 'text' && typeof part.text === 'string',
  );
  const text = first?.text;
  if (text === undefined) return { value: null, valid: lenient };
  try {
    return { value: JSON.parse(text) as JsonValue, valid: true };
  } catch {
    return { value: lenient ? text : null, valid: lenient };
  }
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The columns of a table the manifest did not describe: the keys of its rows, label = key. */
function columnsOf(rows: readonly Record<string, JsonValue>[]): { key: string; label: string }[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (keys.size < 32) keys.add(key);
    }
  }
  return [...keys].map((key) => ({ key, label: key }));
}

/** A block with no data, for the code that says why. */
function emptyBlock(
  block: Exclude<PluginManifest['panel'][number], { type: 'action' }>,
  text: (key: string) => string,
  base: { title: string; source: string },
  error: { code: BlockErrorCode; message: string },
): ApiPanelBlock {
  const common = { ...base, error, truncated: null };
  switch (block.type) {
    case 'table':
      return {
        type: 'table',
        ...common,
        columns:
          block.columns?.map((column) => ({ key: column.key, label: text(column.label) })) ?? [],
        rows: [],
      };
    case 'list':
      return { type: 'list', ...common, items: [] };
    case 'metrics':
      return { type: 'metrics', ...common, metrics: [] };
  }
}

/**
 * The catalog of the screen texts of a plugin for a language: the exact tag, then the same primary
 * language (`pt` for `pt-BR`, or `pt-BR` for `pt`), then `en`. A key the chosen catalog lacks is
 * read from `en`, then shown as the key itself, so a missing text never breaks the panel.
 */
export function catalogOf(
  manifest: PluginManifest,
  language: string,
): { language: string; text: (key: string) => string } {
  const catalogs: Record<string, Record<string, string> | undefined> = manifest.i18n ?? {};
  const tags = Object.keys(catalogs);
  const lower = language.toLowerCase();
  const primary = lower.split('-')[0] ?? lower;
  const chosen =
    tags.find((tag) => tag.toLowerCase() === lower) ??
    tags.find((tag) => (tag.toLowerCase().split('-')[0] ?? '') === primary) ??
    'en';
  const own = catalogs[chosen] ?? {};
  const english = catalogs.en ?? {};
  return {
    language: chosen in catalogs ? chosen : 'en',
    text: (key) => own[key] ?? english[key] ?? key,
  };
}
