// SPDX-License-Identifier: MPL-2.0
import {
  TOOL_KINDS,
  type ContentBlock,
  type NormalizedUpdate,
  type RawUpdate,
  type ToolCallStatus,
  type ToolKind,
} from '@otheater/core';

/**
 * The `session/update` payloads of `claude-agent-acp` 0.107.0, as Phase 0 saw them
 * (`spikes/acp-claude/README.md`, item 3, 9) [V], turned into `NormalizedUpdate`. The wire is ACP
 * v1 (`sessionUpdate` discriminator).
 *
 * What is swallowed (`null`): `user_message_chunk` (only the replay of `session/load`),
 * `session_info_update` (a title), and anything this version does not know.
 */

/** `usage_update._meta` key of the `rate_limit_event` of the Agent SDK. [V: Phase 0 item 9] */
export const RATE_LIMIT_META_KEY = '_claude/rateLimit';
/** `usage_update._meta` key with the model that answered. [V: the key; the value shape is [N]] */
export const MODEL_META_KEY = '_claude/model';

/**
 * What `utilization` of a rate-limit window means. The unit was not confirmed in Phase 0 [N]
 * (the stream gave 0.01 at 1%, a fraction, and was never measured high), so the default does not
 * guess: `ignore` leaves `usedPercent` out. `auto` (N123, 2026-11-18) takes 0..1 as a fraction and
 * more than 1 up to 100 as a percentage, and records which one it saw. In every mode a value
 * outside 0..100 is refused. [proposta] key `clients.claude-code.utilization_unit`.
 */
export const UTILIZATION_UNITS = ['ignore', 'fraction', 'percent', 'auto'] as const;
export type UtilizationUnit = (typeof UTILIZATION_UNITS)[number];

export interface ClaudeUpdateOptions {
  /** Default `ignore`. */
  readonly utilizationUnit?: UtilizationUnit;
}

const TOOL_KIND_SET: ReadonlySet<string> = new Set(TOOL_KINDS);
const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'failed']);

/**
 * `kind` of a tool call when the adapter did not send a valid one, from the tool name the adapter
 * puts in `_meta.claudeCode.toolName`. [N: the key comes from reading the adapter, not from a run]
 */
const KIND_OF_TOOL: Readonly<Record<string, ToolKind>> = {
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Glob: 'search',
  Grep: 'search',
  Bash: 'execute',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Task: 'think',
  ExitPlanMode: 'switch_mode',
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function toolKindOf(update: Record<string, unknown>): ToolKind | undefined {
  if (typeof update.kind === 'string' && TOOL_KIND_SET.has(update.kind)) {
    return update.kind as ToolKind;
  }
  const toolName = text(record(record(update._meta)?.claudeCode)?.toolName);
  return toolName === undefined ? undefined : KIND_OF_TOOL[toolName];
}

function statusOf(value: unknown): ToolCallStatus | undefined {
  return typeof value === 'string' && STATUSES.has(value) ? (value as ToolCallStatus) : undefined;
}

function locationsOf(value: unknown): { path: string; line?: number }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const found: { path: string; line?: number }[] = [];
  for (const entry of value as unknown[]) {
    const location = record(entry);
    const path = text(location?.path);
    if (path === undefined) continue;
    const line = count(location?.line);
    found.push(line === undefined ? { path } : { path, line });
  }
  return found.length === 0 ? undefined : found;
}

function contentOf(value: unknown): ContentBlock | undefined {
  const block = record(value);
  if (block?.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block?.type === 'image') {
    const data = text(block.data);
    const mimeType = text(block.mimeType);
    if (data === undefined || mimeType === undefined) return undefined;
    const uri = text(block.uri);
    return uri === undefined
      ? { type: 'image', data, mimeType }
      : { type: 'image', data, mimeType, uri };
  }
  return undefined;
}

function messageChunk(
  kind: 'agent_message_chunk' | 'agent_thought_chunk',
  update: Record<string, unknown>,
): NormalizedUpdate | null {
  const content = contentOf(update.content);
  if (content === undefined) return null;
  const messageId = text(update.messageId);
  return messageId === undefined ? { kind, content } : { kind, content, messageId };
}

function planOf(update: Record<string, unknown>): NormalizedUpdate | null {
  if (!Array.isArray(update.entries)) return null;
  const entries: { content: string; priority: 'high' | 'medium' | 'low'; status: ToolStatus }[] =
    [];
  for (const raw of update.entries as unknown[]) {
    const entry = record(raw);
    const priority = entry?.priority;
    const status = entry?.status;
    if (
      typeof entry?.content !== 'string' ||
      (priority !== 'high' && priority !== 'medium' && priority !== 'low') ||
      (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
    ) {
      return null;
    }
    entries.push({ content: entry.content, priority, status });
  }
  return { kind: 'plan', entries };
}

type ToolStatus = 'pending' | 'in_progress' | 'completed';

function commandsOf(update: Record<string, unknown>): NormalizedUpdate | null {
  if (!Array.isArray(update.availableCommands)) return null;
  const commands: { name: string; description: string; inputHint?: string }[] = [];
  for (const raw of update.availableCommands as unknown[]) {
    const command = record(raw);
    const name = text(command?.name);
    if (name === undefined) continue;
    const hint = text(record(command?.input)?.hint);
    const description = typeof command?.description === 'string' ? command.description : '';
    commands.push(
      hint === undefined ? { name, description } : { name, description, inputHint: hint },
    );
  }
  return { kind: 'available_commands', commands };
}

function configChangedOf(update: Record<string, unknown>): NormalizedUpdate | null {
  if (update.sessionUpdate === 'current_mode_update') {
    const mode = text(update.currentModeId);
    return mode === undefined
      ? null
      : { kind: 'config_changed', options: [{ id: 'mode', category: 'mode', value: mode }] };
  }
  if (!Array.isArray(update.configOptions)) return null;
  const options: { id: string; category?: string; value: string | boolean }[] = [];
  for (const raw of update.configOptions as unknown[]) {
    const option = record(raw);
    const id = text(option?.id);
    const value = option?.currentValue;
    if (id === undefined || (typeof value !== 'string' && typeof value !== 'boolean')) continue;
    const category = text(option?.category);
    options.push(category === undefined ? { id, value } : { id, category, value });
  }
  return options.length === 0 ? null : { kind: 'config_changed', options };
}

function rateLimitStatus(value: unknown): 'allowed' | 'warning' | 'rejected' | undefined {
  const status = text(value);
  if (status === undefined) return undefined;
  if (status === 'allowed') return 'allowed';
  if (status === 'rejected') return 'rejected';
  // `allowed_warning` in the SDK [S]. Anything else that is not plainly `allowed` is a warning:
  // a status this version does not know must not read as "all clear".
  return 'warning';
}

function epochMs(seconds: unknown): number | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds * 1000)
    : undefined;
}

/** The unit a utilization was read as. */
export type SeenUnit = 'fraction' | 'percent';

export type UtilizationRead =
  | { readonly ok: true; readonly percent: number; readonly seen: SeenUnit }
  | { readonly ok: false; readonly reason: string };

/**
 * Turns a utilization into a percentage, 0..100, and says the unit it took it for (N123). A value
 * that is not a finite number, or that falls outside 0..100 once converted, is refused with the
 * reason; it is never clamped, because a clamped number reads as a measurement that was not made.
 * `auto`: 0..1 is a fraction (so exactly 1 is 100%, the cautious side of the one ambiguous value)
 * and above 1 is a percentage. With `ignore` there is no reading.
 */
export function readUtilization(value: unknown, unit: UtilizationUnit): UtilizationRead {
  if (unit === 'ignore') return { ok: false, reason: 'the utilization unit is set to ignore' };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: 'the utilization is not a finite number' };
  }
  if (value < 0) return { ok: false, reason: `the utilization ${String(value)} is below 0` };
  const seen: SeenUnit = unit === 'auto' ? (value <= 1 ? 'fraction' : 'percent') : unit;
  const percent = seen === 'fraction' ? value * 100 : value;
  if (percent > 100) {
    return {
      ok: false,
      reason: `the utilization ${String(value)} is above 100% read as a ${seen}`,
    };
  }
  return { ok: true, percent, seen };
}

function percentOf(utilization: unknown, unit: UtilizationUnit): number | undefined {
  const read = readUtilization(utilization, unit);
  return read.ok ? read.percent : undefined;
}

/**
 * The `rate_limit_event` the adapter forwards in `usage_update._meta["_claude/rateLimit"]`:
 * `status`, `resetsAt` (epoch seconds), `rateLimitType` (the window that triggered it) and
 * `unifiedWindows.five_hour|seven_day` with `utilization`. [V: fields; N: the unit of `utilization`]
 */
function rateLimitOf(raw: unknown, unit: UtilizationUnit): NormalizedUpdate | undefined {
  const event = record(raw);
  const status = rateLimitStatus(event?.status);
  if (event === undefined || status === undefined) return undefined;
  const window = text(event.rateLimitType);
  const windowData =
    window === undefined ? undefined : record(record(event.unifiedWindows)?.[window]);
  const resetsAt = epochMs(event.resetsAt) ?? epochMs(windowData?.resetsAt);
  const usedPercent = percentOf(windowData?.utilization, unit);
  return {
    kind: 'rate_limit',
    status,
    ...(window === undefined ? {} : { window }),
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** One window of a `rate_limit_event`, read with the unit rule of N123. */
export interface RateLimitEventWindow {
  /** As the client names it: `five_hour`, `seven_day`. */
  readonly name: string;
  /** Percentage, 0..100; absent when the unit is `ignore` or the value was refused. */
  readonly percent?: number;
  /** The unit the utilization was taken for. */
  readonly seen?: SeenUnit;
  /** Why the utilization was refused (outside 0..100, not a number). */
  readonly refused?: string;
  /** Epoch ms. */
  readonly resetsAt?: number;
}

/** What a `rate_limit_event` says, window by window. */
export interface RateLimitEvent {
  readonly status: 'allowed' | 'warning' | 'rejected';
  /** The window that triggered the event (`rateLimitType`), when it says. */
  readonly dominant?: string;
  /** Epoch ms of the event's own `resetsAt`. */
  readonly resetsAt?: number;
  /** The dominant window and every one of `unifiedWindows`, each once. */
  readonly windows: readonly RateLimitEventWindow[];
}

/**
 * The `rate_limit_event` of a `usage_update` (`_meta["_claude/rateLimit"]`), or `undefined` when
 * the update has none (or one with no status). Unlike the `rate_limit` update, which keeps only
 * the dominant window, this reads every window the event measured. [V: fields, Phase 0 item 9;
 * N: the unit of `utilization` with a high value]
 */
export function readRateLimitEvent(
  raw: unknown,
  unit: UtilizationUnit = 'ignore',
): RateLimitEvent | undefined {
  const event = record(record(record(raw)?._meta)?.[RATE_LIMIT_META_KEY]);
  const status = rateLimitStatus(event?.status);
  if (event === undefined || status === undefined) return undefined;
  const dominant = text(event.rateLimitType);
  const unified = record(event.unifiedWindows) ?? {};
  const eventReset = epochMs(event.resetsAt);
  const names = [...(dominant === undefined ? [] : [dominant]), ...Object.keys(unified)];
  const windows: RateLimitEventWindow[] = [];
  for (const name of new Set(names)) {
    const data = record(unified[name]);
    const resetsAt = epochMs(data?.resetsAt) ?? (name === dominant ? eventReset : undefined);
    const read =
      data?.utilization === undefined ? undefined : readUtilization(data.utilization, unit);
    windows.push({
      name,
      ...(read?.ok === true ? { percent: read.percent, seen: read.seen } : {}),
      ...(read?.ok === false && unit !== 'ignore' ? { refused: read.reason } : {}),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  return {
    status,
    ...(dominant === undefined ? {} : { dominant }),
    ...(eventReset === undefined ? {} : { resetsAt: eventReset }),
    windows,
  };
}

function usageOf(update: Record<string, unknown>): NormalizedUpdate | null {
  const contextUsed = count(update.used);
  const contextSize = count(update.size);
  const cost = record(update.cost);
  const costUsd =
    cost?.currency === 'USD' && typeof cost.amount === 'number' && cost.amount >= 0
      ? cost.amount
      : undefined;
  if (contextUsed === undefined && contextSize === undefined && costUsd === undefined) return null;
  const model = text(record(update._meta)?.[MODEL_META_KEY]);
  return {
    kind: 'usage',
    ...(model === undefined ? {} : { model }),
    ...(contextUsed === undefined ? {} : { contextUsed }),
    ...(contextSize === undefined ? {} : { contextSize }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/**
 * Normalizes one `session/update` of `claude-agent-acp`. [proposta] A `usage_update` that carries
 * a rate-limit event becomes the `rate_limit` update and the context counters of that message are
 * lost: `normalizeUpdate` returns one update, and the quota signal is the one the daemon cannot
 * get any other way (N42). The next plain `usage_update` brings the counters back.
 */
export function normalizeClaudeUpdate(
  raw: RawUpdate,
  options: ClaudeUpdateOptions = {},
): NormalizedUpdate | null {
  const update = record(raw);
  if (update === undefined) return null;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return messageChunk(update.sessionUpdate, update);
    case 'tool_call': {
      const toolCallId = text(update.toolCallId);
      if (toolCallId === undefined) return null;
      const locations = locationsOf(update.locations);
      return {
        kind: 'tool_call',
        toolCallId,
        title: typeof update.title === 'string' ? update.title : '',
        toolKind: toolKindOf(update) ?? 'other',
        status: statusOf(update.status) ?? 'pending',
        ...(locations === undefined ? {} : { locations }),
      };
    }
    case 'tool_call_update': {
      const toolCallId = text(update.toolCallId);
      if (toolCallId === undefined) return null;
      const title = typeof update.title === 'string' ? update.title : undefined;
      const toolKind = toolKindOf(update);
      const status = statusOf(update.status);
      const locations = locationsOf(update.locations);
      return {
        kind: 'tool_call_update',
        toolCallId,
        ...(title === undefined ? {} : { title }),
        ...(toolKind === undefined ? {} : { toolKind }),
        ...(status === undefined ? {} : { status }),
        ...(locations === undefined ? {} : { locations }),
      };
    }
    case 'plan':
      return planOf(update);
    case 'available_commands_update':
      return commandsOf(update);
    case 'current_mode_update':
    case 'config_option_update':
      return configChangedOf(update);
    case 'usage_update': {
      const limit = rateLimitOf(
        record(update._meta)?.[RATE_LIMIT_META_KEY],
        options.utilizationUnit ?? 'ignore',
      );
      return limit ?? usageOf(update);
    }
    default:
      return null;
  }
}
