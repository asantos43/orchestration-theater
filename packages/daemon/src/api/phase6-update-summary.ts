// SPDX-License-Identifier: MPL-2.0

/**
 * The diagnosis of the `session.update` events for the real acceptance of Phase 6 (`phase6-
 * acceptance.real.test.ts`): which session streamed how much, of which kinds of update, calling
 * which tools, and how the stream ended. The run of 2026-11-20 with OpenCode had a reviewer turn
 * that emitted 2133 updates in ~25 minutes, and the summary did not say what they were.
 *
 * Privacy and size of the log: the lines carry only the kind of each update, the name of a tool
 * and its status. They never carry the text of a message or a thought, the plan, the arguments of
 * a tool or its output. The name of a tool is the first word of its title (the title of some
 * clients is `Read /path/to/file`), and a title that looks like a path or a command line falls back
 * to the `toolKind`.
 *
 * A pure function over the events of the log, so it is tested with made-up events.
 */

/** The part of an `EventEnvelope` the summary reads (the envelope of the log fits it). */
export interface SummarizableEvent {
  readonly id: number;
  readonly type: string;
  readonly timestamp: number;
  readonly playId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly payload: unknown;
}

export interface UpdateSummaryOptions {
  /** Prefix of every line. */
  readonly prefix?: string;
  /** How many sessions get lines, the ones with most updates first. */
  readonly maxSessions?: number;
  /** How many tools per session. */
  readonly topTools?: number;
  /** How many of the last updates of the busiest session. */
  readonly lastUpdates?: number;
}

const SHORT_ID_CHARS = 8;
const TOOL_NAME_CHARS = 32;

interface SessionStats {
  readonly sessionId: string;
  count: number;
  firstAt: number;
  lastAt: number;
  firstEventId: number;
  openedEventId: number | undefined;
  attemptId: string | undefined;
  playId: string | undefined;
  readonly kinds: Map<string, number>;
  readonly tools: Map<string, number>;
  /** `toolCallId` to the name the call got when it started, for the updates that carry no title. */
  readonly names: Map<string, string>;
  /** The last updates, as text without content (kind, tool name, status). */
  readonly recent: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The name of a tool, with no argument in it: the first word of the title without a trailing
 * colon, when it is a plain identifier; otherwise the `toolKind`; otherwise `?`.
 */
export function toolNameOf(title: unknown, toolKind: unknown): string {
  const first = typeof title === 'string' ? (title.trim().split(/\s+/)[0] ?? '') : '';
  const word = first.replace(/[:;,]+$/, '');
  if (/^[A-Za-z_][\w.-]*$/.test(word)) return word.slice(0, TOOL_NAME_CHARS);
  return asString(toolKind)?.slice(0, TOOL_NAME_CHARS) ?? '?';
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function ranked(map: ReadonlyMap<string, number>, limit?: number): string[] {
  const sorted = [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return (limit === undefined ? sorted : sorted.slice(0, limit)).map(
    ([key, count]) => `${key} ${String(count)}`,
  );
}

/**
 * The diagnostic lines for the `session.update` events of `events`. Empty when there is none.
 * The role of a session is read from the events that name it with an `attemptId` (a `submit*`, a
 * tool call, a handoff); failing that, from the latest `executor.selected` of the same play before
 * the session opened, marked with `?` because it is an inference; a session with no play and no
 * attempt is `chat` (the Director); otherwise `unknown`.
 */
export function summarizeSessionUpdates(
  events: readonly SummarizableEvent[],
  options: UpdateSummaryOptions = {},
): string[] {
  const { prefix = '', maxSessions = 8, topTools = 5, lastUpdates = 5 } = options;
  const sessions = new Map<string, SessionStats>();
  const attemptRoles = new Map<string, string>();
  const selections: { id: number; playId: string | undefined; role: string }[] = [];

  const statsOf = (sessionId: string, event: SummarizableEvent): SessionStats => {
    let stats = sessions.get(sessionId);
    if (stats === undefined) {
      stats = {
        sessionId,
        count: 0,
        firstAt: event.timestamp,
        lastAt: event.timestamp,
        firstEventId: event.id,
        openedEventId: undefined,
        attemptId: undefined,
        playId: undefined,
        kinds: new Map(),
        tools: new Map(),
        names: new Map(),
        recent: [],
      };
      sessions.set(sessionId, stats);
    }
    return stats;
  };

  for (const event of events) {
    const payload = asRecord(event.payload);
    if (payload === undefined) continue;
    const attemptId = asString(payload.attemptId) ?? event.attemptId;
    const playId = asString(payload.playId) ?? event.playId;

    if (event.type === 'executor.selected') {
      const role = asString(payload.role);
      if (role !== undefined && payload.outcome === 'selected') {
        selections.push({ id: event.id, playId, role });
      }
      continue;
    }

    if (event.type === 'session.opened') {
      const sessionId = asString(payload.sessionId);
      if (sessionId === undefined) continue;
      const stats = statsOf(sessionId, event);
      stats.openedEventId ??= event.id;
      stats.attemptId ??= attemptId;
      stats.playId ??= playId;
      // The session opened with no update yet counts for the time only once it has updates.
      continue;
    }

    if (event.type !== 'session.update') {
      const role = asString(payload.role);
      if (role !== undefined && attemptId !== undefined && !attemptRoles.has(attemptId)) {
        attemptRoles.set(attemptId, role);
      }
      continue;
    }

    const sessionId = asString(payload.sessionId);
    const update = asRecord(payload.update);
    const kind = update === undefined ? undefined : asString(update.kind);
    if (sessionId === undefined || update === undefined || kind === undefined) continue;
    const stats = statsOf(sessionId, event);
    stats.attemptId ??= attemptId;
    stats.playId ??= playId;
    if (stats.count === 0) stats.firstAt = event.timestamp;
    stats.count += 1;
    stats.lastAt = event.timestamp;
    bump(stats.kinds, kind);

    let label = kind;
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const callId = asString(update.toolCallId);
      // An update with no title of its own is named by the call it belongs to.
      const known = callId === undefined ? undefined : stats.names.get(callId);
      const name =
        kind === 'tool_call_update' && update.title === undefined && known !== undefined
          ? known
          : toolNameOf(update.title, update.toolKind);
      if (callId !== undefined && (kind === 'tool_call' || known === undefined)) {
        stats.names.set(callId, name);
      }
      if (kind === 'tool_call') bump(stats.tools, name);
      const status = asString(update.status);
      label = `${kind}(${name}${status === undefined ? '' : `, ${status}`})`;
    }
    stats.recent.push(label);
    if (stats.recent.length > lastUpdates) stats.recent.shift();
  }

  const withUpdates = [...sessions.values()].filter((stats) => stats.count > 0);
  if (withUpdates.length === 0) return [];
  withUpdates.sort((a, b) => b.count - a.count || a.firstAt - b.firstAt);

  const roleOf = (stats: SessionStats): string => {
    if (stats.attemptId !== undefined) {
      const known = attemptRoles.get(stats.attemptId);
      if (known !== undefined) return known;
    }
    if (stats.playId !== undefined) {
      const before = stats.openedEventId ?? stats.firstEventId;
      let found: string | undefined;
      for (const selection of selections) {
        if (selection.playId === stats.playId && selection.id < before) found = selection.role;
      }
      if (found !== undefined) return `${found}?`;
    }
    return stats.attemptId === undefined && stats.playId === undefined ? 'chat' : 'unknown';
  };

  const lines: string[] = [];
  for (const stats of withUpdates.slice(0, maxSessions)) {
    const id = stats.sessionId.slice(0, SHORT_ID_CHARS);
    lines.push(
      `${prefix}updates ${id} (${roleOf(stats)}): ${String(stats.count)} (${ranked(stats.kinds).join(', ')}) over ${((stats.lastAt - stats.firstAt) / 1000).toFixed(1)}s`,
    );
    if (stats.tools.size > 0) {
      lines.push(`${prefix}tools ${id}: ${ranked(stats.tools, topTools).join(', ')}`);
    }
  }
  const busiest = withUpdates[0];
  if (busiest !== undefined) {
    lines.push(
      `${prefix}last updates ${busiest.sessionId.slice(0, SHORT_ID_CHARS)}: ${busiest.recent.join(', ')}`,
    );
  }
  if (withUpdates.length > maxSessions) {
    lines.push(
      `${prefix}updates: ${String(withUpdates.length - maxSessions)} more sessions not shown`,
    );
  }
  return lines;
}
