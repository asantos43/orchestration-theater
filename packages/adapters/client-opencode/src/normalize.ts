// SPDX-License-Identifier: MPL-2.0
import {
  NormalizedUpdateSchema,
  TOOL_KINDS,
  type ContentBlock,
  type NormalizedError,
  type NormalizedUpdate,
  type RawUpdate,
  type ToolCallStatus,
  type ToolKind,
} from '@otheater/core';

/**
 * The agent shell of OpenCode: what `opencode acp` sends, in the normalized terms of the daemon
 * (architecture 5.2, "Casca de agente"). The raw shapes are the ACP `session/update` payloads
 * Phase 0 recorded for 1.19.5 (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
 * `tool_call_update`, `usage_update` with `cost`, `available_commands_update`, and
 * `user_message_chunk` in the `session/load` replay) [V]; the fixtures of this package are
 * hand-made from those shapes, not captured output.
 */

/** Name of the extension notification that carries quota signals (architecture 5.6, [proposta]). */
export const QUOTA_SIGNAL_METHOD = '_otheater/quota/signal';

const TOOL_KIND_SET: ReadonlySet<string> = new Set(TOOL_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'failed']);
const PRIORITY_SET: ReadonlySet<string> = new Set(['high', 'medium', 'low']);
const PLAN_STATUS_SET: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function contentOf(value: unknown): ContentBlock | undefined {
  const content = record(value);
  switch (content?.type) {
    case 'text':
      return typeof content.text === 'string' ? { type: 'text', text: content.text } : undefined;
    case 'image': {
      const data = text(content.data);
      const mimeType = nonEmpty(content.mimeType);
      if (data === undefined || mimeType === undefined) return undefined;
      const uri = nonEmpty(content.uri);
      return { type: 'image', data, mimeType, ...(uri === undefined ? {} : { uri }) };
    }
    case 'resource_link': {
      const uri = nonEmpty(content.uri);
      const name = nonEmpty(content.name);
      if (uri === undefined || name === undefined) return undefined;
      const mimeType = nonEmpty(content.mimeType);
      return {
        type: 'resource_link',
        uri,
        name,
        ...(mimeType === undefined ? {} : { mimeType }),
      };
    }
    default:
      return undefined;
  }
}

function toolKindOf(value: unknown): ToolKind {
  return typeof value === 'string' && TOOL_KIND_SET.has(value) ? (value as ToolKind) : 'other';
}

function statusOf(value: unknown): ToolCallStatus | undefined {
  return typeof value === 'string' && STATUS_SET.has(value) ? (value as ToolCallStatus) : undefined;
}

function locationsOf(value: unknown): { path: string; line?: number }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations: { path: string; line?: number }[] = [];
  for (const item of value as unknown[]) {
    const location = record(item);
    const path = nonEmpty(location?.path);
    if (path === undefined) continue;
    const line = count(location?.line);
    locations.push({ path, ...(line === undefined ? {} : { line }) });
  }
  return locations;
}

function messageId(update: Record<string, unknown>): { messageId?: string } {
  const id = nonEmpty(update.messageId);
  return id === undefined || id.length > 256 ? {} : { messageId: id };
}

/** Epoch ms of a reset time: an ISO date string, or a number in seconds or milliseconds. */
function epochMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value < 1e12 ? value * 1000 : value);
  }
  return undefined;
}

/**
 * A quota signal as the shells send it (`QuotaSignal` of architecture 5.6, [proposta]): carried as
 * `{ method: '_otheater/quota/signal', params: { signal } }` or with the signal at the top.
 */
function quotaSignalUpdate(update: Record<string, unknown>): NormalizedUpdate | null {
  const signal = record(update.signal) ?? record(record(update.params)?.signal);
  if (signal === undefined) return null;
  switch (signal.kind) {
    case 'window': {
      const window = nonEmpty(signal.window);
      const usedPercent = typeof signal.usedPercent === 'number' ? signal.usedPercent : undefined;
      if (window === undefined || usedPercent === undefined || usedPercent < 0) return null;
      const resetsAt = epochMs(signal.resetsAt);
      return {
        kind: 'rate_limit',
        status: usedPercent >= 100 ? 'rejected' : 'allowed',
        window,
        usedPercent,
        ...(resetsAt === undefined ? {} : { resetsAt }),
      };
    }
    case 'usage': {
      const model = nonEmpty(signal.model);
      const inputTokens = count(signal.inputTokens);
      const outputTokens = count(signal.outputTokens);
      const costUsd =
        typeof signal.costUsd === 'number' && signal.costUsd >= 0 ? signal.costUsd : undefined;
      return {
        kind: 'usage',
        ...(model === undefined ? {} : { model }),
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(costUsd === undefined ? {} : { costUsd }),
      };
    }
    case 'limit_hit': {
      const resetsAt = epochMs(signal.resetsAt);
      return {
        kind: 'rate_limit',
        status: 'rejected',
        ...(resetsAt === undefined ? {} : { resetsAt }),
      };
    }
    default:
      return null;
  }
}

function usageUpdate(update: Record<string, unknown>): NormalizedUpdate | null {
  const contextUsed = count(update.used);
  const contextSize = count(update.size);
  const cost = record(update.cost);
  const amount = typeof cost?.amount === 'number' && cost.amount >= 0 ? cost.amount : undefined;
  const costUsd = cost?.currency === 'USD' ? amount : undefined;
  return {
    kind: 'usage',
    ...(contextUsed === undefined ? {} : { contextUsed }),
    ...(contextSize === undefined ? {} : { contextSize }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function convert(update: Record<string, unknown>): NormalizedUpdate | null {
  if (update.method === QUOTA_SIGNAL_METHOD || update.sessionUpdate === QUOTA_SIGNAL_METHOD) {
    return quotaSignalUpdate(update);
  }
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const content = contentOf(update.content);
      return content === undefined
        ? null
        : { kind: update.sessionUpdate, content, ...messageId(update) };
    }
    case 'tool_call': {
      const toolCallId = nonEmpty(update.toolCallId);
      const title = text(update.title);
      if (toolCallId === undefined || title === undefined) return null;
      const locations = locationsOf(update.locations);
      return {
        kind: 'tool_call',
        toolCallId,
        title,
        toolKind: toolKindOf(update.kind),
        status: statusOf(update.status) ?? 'pending',
        ...(locations === undefined ? {} : { locations }),
      };
    }
    case 'tool_call_update': {
      const toolCallId = nonEmpty(update.toolCallId);
      if (toolCallId === undefined) return null;
      const title = text(update.title);
      const status = statusOf(update.status);
      const locations = locationsOf(update.locations);
      return {
        kind: 'tool_call_update',
        toolCallId,
        ...(title === undefined ? {} : { title }),
        ...(update.kind === undefined || update.kind === null
          ? {}
          : { toolKind: toolKindOf(update.kind) }),
        ...(status === undefined ? {} : { status }),
        ...(locations === undefined ? {} : { locations }),
      };
    }
    case 'plan': {
      if (!Array.isArray(update.entries)) return null;
      const entries = (update.entries as unknown[]).flatMap((item) => {
        const entry = record(item);
        const content = text(entry?.content);
        if (content === undefined) return [];
        const priority = text(entry?.priority);
        const status = text(entry?.status);
        return [
          {
            content,
            priority: (priority !== undefined && PRIORITY_SET.has(priority)
              ? priority
              : 'medium') as 'high' | 'medium' | 'low',
            status: (status !== undefined && PLAN_STATUS_SET.has(status) ? status : 'pending') as
              'pending' | 'in_progress' | 'completed',
          },
        ];
      });
      return { kind: 'plan', entries };
    }
    case 'usage_update':
      return usageUpdate(update);
    case 'available_commands_update': {
      if (!Array.isArray(update.availableCommands)) return null;
      const commands = (update.availableCommands as unknown[]).flatMap((item) => {
        const command = record(item);
        const name = nonEmpty(command?.name);
        if (name === undefined) return [];
        const hint = nonEmpty(record(command?.input)?.hint);
        return [
          {
            name,
            description: text(command?.description) ?? '',
            ...(hint === undefined ? {} : { inputHint: hint }),
          },
        ];
      });
      return { kind: 'available_commands', commands };
    }
    case 'config_option_update': {
      if (!Array.isArray(update.configOptions)) return null;
      const options = (update.configOptions as unknown[]).flatMap((item) => {
        const option = record(item);
        const id = nonEmpty(option?.id);
        const value = option?.currentValue;
        if (id === undefined || (typeof value !== 'string' && typeof value !== 'boolean')) {
          return [];
        }
        const category = nonEmpty(option?.category);
        return [{ id, ...(category === undefined ? {} : { category }), value }];
      });
      return options.length === 0 ? null : { kind: 'config_changed', options };
    }
    case 'current_mode_update': {
      const mode = nonEmpty(update.currentModeId);
      return mode === undefined
        ? null
        : { kind: 'config_changed', options: [{ id: 'mode', category: 'mode', value: mode }] };
    }
    default:
      // `user_message_chunk` (the replay of `session/load`), `session_info_update`, notices.
      return null;
  }
}

/**
 * `normalizeUpdate` of the OpenCode adapter. Anything that does not become a valid
 * {@link NormalizedUpdate} is swallowed (`null`), never forwarded half-built. Every transport but
 * `headless` speaks ACP (the id of a transport is not always `acp`); the stream of
 * `opencode run --format json` was not measured [N], so it is swallowed.
 */
export function normalizeOpenCodeUpdate(raw: RawUpdate, via: string): NormalizedUpdate | null {
  if (via === 'headless') return null;
  const update = record(raw);
  if (update === undefined) return null;
  const converted = convert(update);
  if (converted === null) return null;
  const parsed = NormalizedUpdateSchema.safeParse(converted);
  return parsed.success ? parsed.data : null;
}

/** JSON-RPC code ACP gives to `auth_required`. */
const ACP_AUTH_REQUIRED_CODE = -32000;
/** Code of the quota error of the shells (`QUOTA_EXHAUSTED_CODE` of `@otheater/protocol`, which core cannot import). */
const QUOTA_EXHAUSTED_CODE = -32001;

const QUOTA_PATTERN =
  /\b429\b|rate[ _-]?limit|too many requests|quota|usage limit|insufficient[ _](credits?|balance|funds)|credit balance|exceeded (your|the) (current )?(limit|quota)/i;
const HTTP_429 = /\b429\b|too many requests/i;
const AUTH_PATTERN =
  /\b401\b|unauthori[sz]ed|not logged in|login required|authentication (required|failed)|no (api )?(key|credentials?)\b|api key|invalid (token|key|credentials?)|please (log ?in|authenticate)|auth login/i;
const PERMISSION_PATTERN =
  /permission|prevents you from using|rule which prevents|rejected by the user|denied/i;
const CRASH_PATTERN =
  /connection (to the client )?closed|process (exited|died|terminated)|broken pipe|\bEPIPE\b|\bSIGKILL\b|exited with code/i;
const STUCK_PATTERN = /did not finish|stalled|unresponsive|no output|hung\b/i;
const TRANSIENT_PATTERN =
  /timed? ?out|\bETIMEDOUT\b|\bECONN(RESET|REFUSED)\b|\bENOTFOUND\b|\b5\d\d\b|overloaded|temporar|unavailable|try again|fetch failed|network|service failure/i;

function describe(raw: unknown): { message: string; code: unknown; data: unknown } {
  if (raw instanceof Error) {
    const error = raw as Error & { code?: unknown; data?: unknown };
    return { message: error.message, code: error.code, data: error.data };
  }
  const error = record(raw);
  const message = text(error?.message);
  return {
    message: message ?? (typeof raw === 'string' ? raw : 'unknown OpenCode error'),
    code: error?.code,
    data: error?.data,
  };
}

function dataText(data: unknown): string {
  if (typeof data === 'string') return data.slice(0, 2000);
  const fields = record(data);
  if (fields === undefined) return '';
  return Object.values(fields)
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .slice(0, 2000);
}

/**
 * `normalizeError` of the OpenCode adapter (architecture 5.2, N42). What is verified [V]: a killed
 * process ends a pending prompt with "ACP connection closed", and `session/load` of a missing id
 * answers `-32603 "OpenCode service failure"` (this adapter cannot tell that from any other
 * `-32603`; see the README). The wording of a quota or login failure was not measured [N]: it is
 * matched by patterns, and nothing in the client says when the quota comes back (N42), so
 * `resetsAt` only comes from a field the error itself carries.
 */
export function normalizeOpenCodeError(raw: unknown): NormalizedError {
  const { message, code, data } = describe(raw);
  const fields = record(data);
  const haystack = `${message} ${dataText(data)}`;
  if (
    code === QUOTA_EXHAUSTED_CODE ||
    fields?.type === 'QuotaExhausted' ||
    QUOTA_PATTERN.test(haystack)
  ) {
    const resetsAt = epochMs(fields?.resetsAt);
    const structured = code === QUOTA_EXHAUSTED_CODE || fields?.type === 'QuotaExhausted';
    return {
      kind: 'quota_exhausted',
      message,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      limitSource: structured ? 'structured' : HTTP_429.test(haystack) ? '429' : 'message',
      cause: raw,
    };
  }
  if (code === ACP_AUTH_REQUIRED_CODE || AUTH_PATTERN.test(haystack)) {
    return { kind: 'auth_required', message, cause: raw };
  }
  if (PERMISSION_PATTERN.test(haystack)) return { kind: 'permission', message, cause: raw };
  if (CRASH_PATTERN.test(haystack)) return { kind: 'client_crash', message, cause: raw };
  if (STUCK_PATTERN.test(haystack)) return { kind: 'stuck', message, cause: raw };
  if (TRANSIENT_PATTERN.test(haystack)) return { kind: 'transient', message, cause: raw };
  return { kind: 'unknown', message, cause: raw };
}
