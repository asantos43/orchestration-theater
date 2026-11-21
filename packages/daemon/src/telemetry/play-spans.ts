// SPDX-License-Identifier: MPL-2.0
import {
  NotFound,
  type PlayRegistry,
  type TelemetrySpan,
  type TelemetryStore,
} from '@otheater/core';
import type { PlaySpan, PlaySpanKind, PlaySpans } from '@otheater/protocol';
import { GEN_AI, GEN_AI_OPERATION, OT, SPAN_NAME } from './span-conventions.js';

/** The most spans one read takes when the caller does not say. */
export const PLAY_SPANS_DEFAULT_LIMIT = 2000;

export interface PlaySpansDeps {
  readonly telemetry: Pick<TelemetryStore, 'readSpans'>;
  readonly plays: Pick<PlayRegistry, 'get'>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isDaemonSpan(span: TelemetrySpan): boolean {
  return span.resource['otheater.component'] === 'daemon';
}

/** What a span of the daemon is, from its name and attributes (the conventions of `span-conventions.ts`). */
export function playSpanKind(span: TelemetrySpan): PlaySpanKind {
  if (span.name === SPAN_NAME.play) return 'play';
  if (span.name === SPAN_NAME.stage) return 'stage';
  if (span.name === SPAN_NAME.wait) return 'wait';
  const operation = span.attributes[GEN_AI.operationName];
  if (operation === GEN_AI_OPERATION.executeTool) return 'tool';
  if (operation === GEN_AI_OPERATION.invokeAgent) {
    // The span of a session carries the id of its conversation; the one of an attempt does not.
    return text(span.attributes[GEN_AI.conversationId]) === undefined ? 'attempt' : 'session';
  }
  return 'other';
}

/** The label and the detail of a span, only from what the daemon put in its attributes. */
function describe(
  span: TelemetrySpan,
  kind: PlaySpanKind,
): { readonly label: string; readonly detail: string | null } {
  const a = span.attributes;
  switch (kind) {
    case 'play':
      return { label: text(a[OT.playFinalState]) ?? '', detail: null };
    case 'stage':
      return { label: text(a[OT.stage]) ?? '', detail: null };
    case 'attempt':
    case 'session': {
      const client = text(a[OT.client]);
      const profile = text(a[OT.profile]);
      return {
        label: text(a[OT.role]) ?? text(a[GEN_AI.agentName]) ?? '',
        detail:
          client === undefined ? null : profile === undefined ? client : `${client}/${profile}`,
      };
    }
    case 'tool':
      return {
        label: text(a[GEN_AI.toolName]) ?? '',
        detail: text(a[OT.toolOutcome]) ?? null,
      };
    case 'wait':
      return { label: text(a[OT.waitKind]) ?? '', detail: text(a[OT.waitOutcome]) ?? null };
    case 'other':
      return { label: span.name, detail: null };
  }
}

function toMs(nanos: bigint): number {
  return Number(nanos / 1_000_000n);
}

/**
 * The spans of one play as the tree the interfaces draw (Phase 8, P10; [proposta]). It reads only
 * the spans the daemon itself made (`resource.otheater.component = daemon`): the spans a client
 * exported have their own trees and parents, and they are not a part of this one. The tree is built
 * by the parent ids; a span whose parent is not in the base (the daemon writes a span when it closes,
 * so the play and whatever is still open are missing while the play runs) becomes a root. Children
 * come ordered by start. Reads, records no event.
 */
export class PlaySpansService {
  readonly #deps: PlaySpansDeps;

  constructor(deps: PlaySpansDeps) {
    this.#deps = deps;
  }

  /** `NotFound` for a play the registry does not know. */
  async read(
    playId: string,
    options: { readonly limit?: number | undefined } = {},
  ): Promise<PlaySpans> {
    if ((await this.#deps.plays.get(playId)) === undefined) {
      throw new NotFound(`There is no play "${playId}"`);
    }
    const limit = options.limit ?? PLAY_SPANS_DEFAULT_LIMIT;
    // One more than asked, to know whether there was more.
    const read = await this.#deps.telemetry.readSpans({ playId, limit: limit + 1 });
    const truncated = read.length > limit;
    const spans = read.slice(0, limit).filter(isDaemonSpan);
    return {
      playId,
      spans: orderAsTree(spans),
      playClosed: spans.some((span) => span.name === SPAN_NAME.play),
      truncated,
    };
  }
}

/** The spans in depth-first order with their depth. A span never appears twice. */
export function orderAsTree(spans: readonly TelemetrySpan[]): PlaySpan[] {
  const byId = new Map<string, TelemetrySpan>();
  for (const span of spans) byId.set(span.spanId, span);
  const children = new Map<string, TelemetrySpan[]>();
  const roots: TelemetrySpan[] = [];
  for (const span of byId.values()) {
    const parent = span.parentSpanId;
    if (parent !== null && parent !== span.spanId && byId.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(span);
      children.set(parent, list);
    } else {
      roots.push(span);
    }
  }
  const byStart = (a: TelemetrySpan, b: TelemetrySpan): number =>
    a.startTimeUnixNano < b.startTimeUnixNano
      ? -1
      : a.startTimeUnixNano > b.startTimeUnixNano
        ? 1
        : a.spanId < b.spanId
          ? -1
          : 1;
  roots.sort(byStart);
  for (const list of children.values()) list.sort(byStart);
  const out: PlaySpan[] = [];
  const seen = new Set<string>();
  const stack: { readonly span: TelemetrySpan; readonly depth: number }[] = [];
  for (const root of [...roots].reverse()) stack.push({ span: root, depth: 0 });
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { span, depth } = top;
    if (seen.has(span.spanId)) continue;
    seen.add(span.spanId);
    const kind = playSpanKind(span);
    const { label, detail } = describe(span, kind);
    out.push({
      spanId: span.spanId,
      parentSpanId: depth === 0 ? null : span.parentSpanId,
      kind,
      depth,
      label,
      detail,
      startMs: toMs(span.startTimeUnixNano),
      durationMs: Number(span.endTimeUnixNano - span.startTimeUnixNano) / 1_000_000,
      status: span.status,
      attemptId: span.attemptId,
    });
    for (const kid of [...(children.get(span.spanId) ?? [])].reverse()) {
      stack.push({ span: kid, depth: depth + 1 });
    }
  }
  return out;
}
