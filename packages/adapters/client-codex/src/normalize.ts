// SPDX-License-Identifier: MPL-2.0
import {
  TOOL_CALL_STATUSES,
  TOOL_KINDS,
  type ConfigValue,
  type ContentBlock,
  type NormalizedError,
  type NormalizedUpdate,
  type RawUpdate,
  type ToolCallStatus,
  type ToolKind,
} from '@otheater/core';

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

const TOOL_KIND_SET: ReadonlySet<string> = new Set(TOOL_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(TOOL_CALL_STATUSES);

function toolKindOf(value: unknown): ToolKind {
  return typeof value === 'string' && TOOL_KIND_SET.has(value) ? (value as ToolKind) : 'other';
}

function statusOf(value: unknown): ToolCallStatus | undefined {
  return typeof value === 'string' && STATUS_SET.has(value) ? (value as ToolCallStatus) : undefined;
}

/** An ACP `ContentBlock`, cut down to the fields the normalized schema has; `undefined` when it is not one. */
export function contentOf(value: unknown): ContentBlock | undefined {
  const block = record(value);
  if (block === undefined) return undefined;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : undefined;
    case 'image': {
      const data = typeof block.data === 'string' ? block.data : undefined;
      const mimeType = text(block.mimeType);
      if (data === undefined || mimeType === undefined) return undefined;
      const uri = text(block.uri);
      return { type: 'image', data, mimeType, ...(uri === undefined ? {} : { uri }) };
    }
    case 'audio': {
      const data = typeof block.data === 'string' ? block.data : undefined;
      const mimeType = text(block.mimeType);
      return data === undefined || mimeType === undefined
        ? undefined
        : { type: 'audio', data, mimeType };
    }
    case 'resource_link': {
      const uri = text(block.uri);
      const name = text(block.name);
      if (uri === undefined || name === undefined) return undefined;
      const mimeType = text(block.mimeType);
      return { type: 'resource_link', uri, name, ...(mimeType === undefined ? {} : { mimeType }) };
    }
    case 'resource': {
      const resource = record(block.resource);
      const uri = text(resource?.uri);
      if (resource === undefined || uri === undefined) return undefined;
      const mimeType = text(resource.mimeType);
      const extra = mimeType === undefined ? {} : { mimeType };
      if (typeof resource.text === 'string') {
        return { type: 'resource', resource: { uri, text: resource.text, ...extra } };
      }
      if (typeof resource.blob === 'string') {
        return { type: 'resource', resource: { uri, blob: resource.blob, ...extra } };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function locationsOf(value: unknown): { path: string; line?: number }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: { path: string; line?: number }[] = [];
  for (const item of value) {
    const location = record(item);
    const path = text(location?.path);
    if (location === undefined || path === undefined) continue;
    const line = count(location.line);
    out.push(line === undefined ? { path } : { path, line });
  }
  return out;
}

function chunkOf(
  kind: 'agent_message_chunk' | 'agent_thought_chunk',
  update: Record<string, unknown>,
): NormalizedUpdate | null {
  const content = contentOf(update.content);
  if (content === undefined) return null;
  const messageId = text(update.messageId);
  return {
    kind,
    content,
    ...(messageId === undefined || messageId.length > 256 ? {} : { messageId }),
  };
}

function planOf(update: Record<string, unknown>): NormalizedUpdate | null {
  if (!Array.isArray(update.entries)) return null;
  const entries: Extract<NormalizedUpdate, { kind: 'plan' }>['entries'] = [];
  for (const item of update.entries) {
    const entry = record(item);
    if (entry === undefined || typeof entry.content !== 'string') continue;
    const priority =
      entry.priority === 'high' || entry.priority === 'low' ? entry.priority : 'medium';
    const status =
      entry.status === 'in_progress' || entry.status === 'completed' ? entry.status : 'pending';
    entries.push({ content: entry.content, priority, status });
  }
  return { kind: 'plan', entries };
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
  return {
    kind: 'usage',
    ...(contextUsed === undefined ? {} : { contextUsed }),
    ...(contextSize === undefined ? {} : { contextSize }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function commandsOf(update: Record<string, unknown>): NormalizedUpdate | null {
  if (!Array.isArray(update.availableCommands)) return null;
  const commands: Extract<NormalizedUpdate, { kind: 'available_commands' }>['commands'] = [];
  for (const item of update.availableCommands) {
    const command = record(item);
    const name = text(command?.name);
    if (command === undefined || name === undefined) continue;
    const hint = text(record(command.input)?.hint);
    commands.push({
      name,
      description: typeof command.description === 'string' ? command.description : '',
      ...(hint === undefined ? {} : { inputHint: hint }),
    });
  }
  return { kind: 'available_commands', commands };
}

function configValueOf(value: unknown): ConfigValue | undefined {
  return typeof value === 'string' || typeof value === 'boolean' ? value : undefined;
}

function configOf(update: Record<string, unknown>): NormalizedUpdate | null {
  if (!Array.isArray(update.configOptions)) return null;
  const options: Extract<NormalizedUpdate, { kind: 'config_changed' }>['options'] = [];
  for (const item of update.configOptions) {
    const option = record(item);
    const id = text(option?.id);
    const value = configValueOf(option?.currentValue);
    if (option === undefined || id === undefined || value === undefined) continue;
    const category = text(option.category);
    options.push({ id, ...(category === undefined ? {} : { category }), value });
  }
  return options.length === 0 ? null : { kind: 'config_changed', options };
}

/**
 * Turns one ACP `session/update` of `codex-acp` into the normalized update, or `null` to swallow
 * it. The types are the ones Phase 0 saw (`spikes/acp-codex`, item 3) [V], plus the standard ACP
 * ones the client may send [S]:
 *
 * - `session_info_update` is swallowed. It carries the title and `_meta.codex.threadStatus` and,
 *   during retries, `_meta.codex.error`; the errors themselves arrive through `normalizeError`.
 * - `user_message_chunk` is swallowed: it only appears while `session/load` replays the history.
 * - `current_mode_update` and `config_option_update` become `config_changed`.
 */
export function normalizeCodexUpdate(raw: RawUpdate): NormalizedUpdate | null {
  const update = record(raw);
  if (update === undefined) return null;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return chunkOf(update.sessionUpdate, update);
    case 'tool_call': {
      const toolCallId = text(update.toolCallId);
      if (toolCallId === undefined || toolCallId.length > 256) return null;
      const locations = locationsOf(update.locations);
      return {
        kind: 'tool_call',
        toolCallId,
        title: typeof update.title === 'string' ? update.title : '',
        toolKind: toolKindOf(update.kind),
        status: statusOf(update.status) ?? 'pending',
        ...(locations === undefined ? {} : { locations }),
      };
    }
    case 'tool_call_update': {
      const toolCallId = text(update.toolCallId);
      if (toolCallId === undefined || toolCallId.length > 256) return null;
      const status = statusOf(update.status);
      const locations = locationsOf(update.locations);
      return {
        kind: 'tool_call_update',
        toolCallId,
        ...(typeof update.title === 'string' ? { title: update.title } : {}),
        ...(typeof update.kind === 'string' ? { toolKind: toolKindOf(update.kind) } : {}),
        ...(status === undefined ? {} : { status }),
        ...(locations === undefined ? {} : { locations }),
      };
    }
    case 'plan':
      return planOf(update);
    case 'usage_update':
      return usageOf(update);
    case 'available_commands_update':
      return commandsOf(update);
    case 'current_mode_update': {
      const value = text(update.currentModeId);
      return value === undefined
        ? null
        : { kind: 'config_changed', options: [{ id: 'mode', category: 'mode', value }] };
    }
    case 'config_option_update':
      return configOf(update);
    default:
      return null;
  }
}

/**
 * `data.codexErrorInfo` values of the app-server (`CodexErrorInfo`) and what they mean here.
 * Only `usageLimitExceeded` was seen in Phase 0 [V]; the rest is from the app-server schema [S].
 */
const CODEX_ERROR_KINDS: Readonly<Record<string, NormalizedError['kind']>> = {
  usageLimitExceeded: 'quota_exhausted',
  unauthorized: 'auth_required',
  httpConnectionFailed: 'transient',
  responseStreamConnectionFailed: 'transient',
  responseStreamDisconnected: 'transient',
  responseTooManyFailedAttempts: 'transient',
  internalServerError: 'transient',
  serverOverloaded: 'transient',
  sandboxError: 'permission',
};

/** JSON-RPC code `codex-acp` answers `session/new` with when the profile has no login (Phase 0, item 6) [V]. */
const AUTH_REQUIRED_CODE = -32000;

const AUTH_MESSAGE =
  /authentication required|not logged in|log ?in required|please (?:log ?in|sign in)/i;
const STUCK_MESSAGE = /\bstuck\b|unresponsive|no response|timed? ?out/i;
const CRASH_MESSAGE = /connection closed|exited|\bEPIPE\b|\bECONNRESET\b|process (?:died|crashed)/i;

/**
 * A reset time the error itself carries: `data.resetsAt` or `data.resets_at`, an ISO string, epoch
 * ms or epoch seconds. [N] No such field was seen: Phase 0 only saw "try again at 9:31 AM" in the
 * message, with no date and no zone, which is not parsed (N42). The real windows come from the
 * app-server's `account/rateLimits/read`, the quota probe of Phase 5.
 */
function resetsAtOf(data: Record<string, unknown> | undefined): number | undefined {
  const value = data?.resetsAt ?? data?.resets_at;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value < 1e11 ? value * 1000 : value);
  }
  return undefined;
}

/**
 * Normalizes an error of `codex-acp` or of its connection. The order is: the structured
 * `codexErrorInfo` first, then the JSON-RPC code of a missing login, then the message, and
 * `unknown` when none says anything.
 */
export function normalizeCodexError(raw: unknown): NormalizedError {
  const error = record(raw);
  const message =
    typeof error?.message === 'string' && error.message !== '' ? error.message : String(raw);
  const data = record(error?.data);
  const info = typeof data?.codexErrorInfo === 'string' ? data.codexErrorInfo : undefined;
  const byInfo = info === undefined ? undefined : CODEX_ERROR_KINDS[info];
  if (byInfo === 'quota_exhausted') {
    const resetsAt = resetsAtOf(data);
    return {
      kind: 'quota_exhausted',
      message,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      cause: raw,
    };
  }
  if (byInfo !== undefined) return { kind: byInfo, message, cause: raw };
  if (error?.code === AUTH_REQUIRED_CODE && AUTH_MESSAGE.test(message)) {
    return { kind: 'auth_required', message, cause: raw };
  }
  if (AUTH_MESSAGE.test(message)) return { kind: 'auth_required', message, cause: raw };
  if (STUCK_MESSAGE.test(message)) return { kind: 'stuck', message, cause: raw };
  if (typeof error?.code !== 'number' && CRASH_MESSAGE.test(message)) {
    return { kind: 'client_crash', message, cause: raw };
  }
  return { kind: 'unknown', message, cause: raw };
}
