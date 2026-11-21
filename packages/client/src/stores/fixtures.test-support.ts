// SPDX-License-Identifier: MPL-2.0
import {
  apiError,
  sseMessageOf,
  type ApiDecision,
  type ApiEventEnvelope,
  type ApiOrder,
  type ApiPlay,
  type ApiPlayDetail,
  type ApiProfile,
  type ApiQuotaStatus,
  type ApiScenario,
} from '@otheater/protocol';
import type { FetchLike } from '../http.js';

/**
 * What the tests of the stores build on, with no network (N57): records and events as the
 * protocol schemas read them, and {@link FakeDaemon}, a `fetch` that answers the REST routes of
 * P5 from tables in memory and streams `GET /v1/events` from a controller the test drives. The
 * client's own schemas parse everything it sends, so a fixture that drifts from the contract
 * fails the test. It never imports the daemon.
 */

export const DAEMON_ID = '3f0c9b52-6d5e-4b8e-9d57-0a1b2c3d4e5f';
const T0 = 1_700_000_000_000;

export function scenario(id: string, extra: Partial<ApiScenario> = {}): ApiScenario {
  return {
    id,
    kind: 'project',
    flowId: 'default',
    name: `Scenario ${id}`,
    folder: `/work/${id}`,
    profile: 'software',
    baseBranch: 'main',
    originScenarioId: null,
    directorState: 'active',
    state: 'active',
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

export function play(id: string, scenarioId: string, extra: Partial<ApiPlay> = {}): ApiPlay {
  return {
    id,
    scenarioId,
    need: 'a need',
    flowId: 'software',
    flowVersion: 1,
    state: 'NEED',
    counters: {},
    parentPlayId: null,
    createdAt: T0,
    updatedAt: T0,
    finishedAt: null,
    ...extra,
  };
}

export function demand(
  playId: string,
  id: string,
  state: ApiPlayDetail['demands'][number]['state'] = 'pending',
): ApiPlayDetail['demands'][number] {
  return {
    playId,
    id,
    title: `Demand ${id}`,
    description: '',
    dependsOn: [],
    contract: { inputs: [], outputs: [] },
    expectedFiles: [],
    complexity: 'low',
    specialty: null,
    timeoutMin: 30,
    acceptanceCriteria: [],
    verify: [],
    verifyWaiver: null,
    state,
    createdAt: T0,
    updatedAt: T0,
  };
}

export function decision(id: string, scenarioId: string, createdAt = T0): ApiDecision {
  return {
    id,
    scenarioId,
    playId: null,
    kind: 'script_review',
    input: {},
    answer: null,
    decidedBy: null,
    state: 'pending',
    createdAt,
    updatedAt: createdAt,
    decidedAt: null,
  };
}

export function quota(profile: string, extra: Partial<ApiQuotaStatus> = {}): ApiQuotaStatus {
  return {
    profile,
    state: 'ok',
    cause: null,
    untilReset: null,
    windows: [],
    observedAt: null,
    nearLimitWindow: null,
    reason: 'ok',
    authorizes: true,
    ...extra,
  };
}

export function profileOf(
  status: ApiQuotaStatus | null,
  id = status?.profile ?? 'codex/main',
): ApiProfile {
  const [client = 'codex', name = 'main'] = id.split('/');
  return {
    profile: {
      id,
      client,
      name,
      kind: 'token_plan',
      provider: 'openai',
      state: 'active',
      dir: `/profiles/${id}`,
      secretRef: null,
      noticeAcceptedAt: null,
      createdAt: T0,
      updatedAt: T0,
      removedAt: null,
    },
    hasSecret: false,
    executors: { valid: 1, invalid: 0 },
    quota: status,
  };
}

/** An order (a directive) as the API lists it: a global instruction, in force. */
export function order(id: string, extra: Partial<ApiOrder> = {}): ApiOrder {
  return {
    id,
    seq: Number(id.slice(1)),
    scope: 'global',
    scenarioId: null,
    kind: 'instruction',
    text: `Order ${id}`,
    ruleKey: null,
    ruleValue: null,
    suspendsId: null,
    roles: [],
    startsAt: T0,
    endsAt: null,
    timezone: 'America/Sao_Paulo',
    state: 'active',
    origin: 'tui',
    replacesId: null,
    createdAt: T0,
    updatedAt: T0,
    revokedAt: null,
    revokeReason: null,
    ...extra,
  };
}

/** `directive.created` with the whole record (P15): the order the daemon wrote. */
export function directiveCreated(
  id: number,
  record: ApiOrder,
  withRecord = true,
): ApiEventEnvelope {
  return event(
    id,
    'directive.created',
    {
      directiveId: record.id,
      scope: record.scope,
      scenarioId: record.scenarioId,
      kind: record.kind,
      roles: record.roles,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
      timezone: record.timezone,
      state: record.state,
      origin: record.origin,
      ruleKey: record.ruleKey,
      suspendsId: record.suspendsId,
      replacesId: record.replacesId,
      ...(withRecord ? { order: record } : {}),
    },
    record.scenarioId === null ? {} : { scenarioId: record.scenarioId },
  );
}

/** An event of the log: the id says the order, the timestamp is `T0 + id`. */
export function event(
  id: number,
  type: string,
  payload: ApiEventEnvelope['payload'],
  where: { scenarioId?: string; playId?: string } = {},
): ApiEventEnvelope {
  return {
    id,
    timestamp: T0 + id,
    type,
    schemaVersion: 1,
    payload,
    ...(where.scenarioId === undefined ? {} : { scenarioId: where.scenarioId }),
    ...(where.playId === undefined ? {} : { playId: where.playId }),
    daemonId: DAEMON_ID,
  };
}

export function playCreated(id: number, scenarioId: string, playId: string): ApiEventEnvelope {
  return event(
    id,
    'play.created',
    { flowId: 'software', flowVersion: 1, need: 'a need', parentPlayId: null },
    { scenarioId, playId },
  );
}

export function playTransitioned(
  id: number,
  scenarioId: string,
  playId: string,
  to: string,
  counters: Record<string, number> = {},
): ApiEventEnvelope {
  return event(
    id,
    'play.transitioned',
    { event: 'START', from: 'NEED', to, counters, effects: [] },
    { scenarioId, playId },
  );
}

/** `decision.created` (N173): the whole record, in the log of its scenario. */
export function decisionCreated(id: number, record: ApiDecision): ApiEventEnvelope {
  return event(
    id,
    'decision.created',
    { decision: record },
    {
      scenarioId: record.scenarioId,
      ...(record.playId === null ? {} : { playId: record.playId }),
    },
  );
}

/** `decision.answered` (N173): the decision left `pending`. */
export function decisionAnswered(
  id: number,
  record: ApiDecision,
  state: 'decided' | 'cancelled' = 'decided',
): ApiEventEnvelope {
  return event(
    id,
    'decision.answered',
    {
      decisionId: record.id,
      kind: record.kind,
      state,
      decidedBy: state === 'decided' ? 'producer' : null,
    },
    {
      scenarioId: record.scenarioId,
      ...(record.playId === null ? {} : { playId: record.playId }),
    },
  );
}

/** `scenario.archived` (N173). */
export function scenarioArchived(id: number, scenarioId: string): ApiEventEnvelope {
  return event(id, 'scenario.archived', { scenarioId }, { scenarioId });
}

/** `demand.transitioned` (N173): the birth carries the record, a later move does not. */
export function demandTransitioned(
  id: number,
  scenarioId: string,
  playId: string,
  demandId: string,
  from: ApiPlayDetail['demands'][number]['state'] | null,
  to: ApiPlayDetail['demands'][number]['state'],
  record?: ApiPlayDetail['demands'][number],
): ApiEventEnvelope {
  return event(
    id,
    'demand.transitioned',
    { playId, demandId, from, to, ...(record === undefined ? {} : { demand: record }) },
    { scenarioId, playId },
  );
}

/** The frame of an event, as the daemon writes it. */
export function frame(envelope: ApiEventEnvelope): string {
  const message = sseMessageOf(envelope, DAEMON_ID);
  return `id: ${message.id}\nevent: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}

export interface FakeRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly lastEventId: string | undefined;
}

type Intercept = (request: FakeRequest) => Response | Promise<Response | undefined> | undefined;

/** A `fetch` that is a daemon: REST from tables, SSE from `push`. */
export class FakeDaemon {
  scenarios: ApiScenario[] = [];
  plays: ApiPlay[] = [];
  details = new Map<string, ApiPlayDetail>();
  decisions = new Map<string, ApiDecision[]>();
  profiles: ApiProfile[] = [];
  orders: ApiOrder[] = [];
  /** The newest id of the log, written as the first frame of a stream. `undefined`: no frame. */
  head: number | undefined = 0;
  /** Runs before the tables answer: return a response to take over the request. */
  intercept: Intercept | undefined;
  readonly requests: FakeRequest[] = [];
  readonly #streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  readonly #encoder = new TextEncoder();

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    const request: FakeRequest = {
      path: parsed.pathname,
      query: parsed.searchParams,
      lastEventId: headers.get('last-event-id') ?? undefined,
    };
    this.requests.push(request);
    const taken = await this.intercept?.(request);
    if (taken !== undefined) return taken;
    if (request.path === '/v1/events') {
      return this.#openStream(init.signal ?? undefined, request.lastEventId !== undefined);
    }
    return this.#answer(request);
  };

  /** Streams opened so far. */
  get streamCount(): number {
    return this.#streams.length;
  }

  /** Writes events to the open stream, in order. */
  push(...events: ApiEventEnvelope[]): void {
    this.write(events.map(frame).join(''));
  }

  /** Writes raw text to the open stream. */
  write(text: string): void {
    this.#streams.at(-1)?.enqueue(this.#encoder.encode(text));
  }

  /** Drops the open stream, as a lost connection does. */
  drop(): void {
    this.#streams.at(-1)?.error(new Error('connection lost'));
  }

  #openStream(signal: AbortSignal | undefined, resumed: boolean): Response {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#streams.push(controller);
        // A resumed stream has no head frame: `Last-Event-ID` already says where it is.
        if (this.head !== undefined && !resumed) {
          controller.enqueue(this.#encoder.encode(`retry: 1\nid: ${String(this.head)}\n\n`));
        }
        signal?.addEventListener('abort', () => {
          try {
            controller.close();
          } catch {
            // Already closed or errored.
          }
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  #page<Item>(
    items: readonly Item[],
    query: URLSearchParams,
    idOf: (item: Item) => string = (item) => (item as { id: string }).id,
  ): Response {
    const limit = Number(query.get('limit') ?? 50);
    const after = query.get('after');
    const start = after === null ? 0 : items.findIndex((item) => idOf(item) === after) + 1;
    const slice = items.slice(start, start + limit);
    const more = start + limit < items.length;
    return Response.json({
      items: slice,
      nextCursor: more && slice.length > 0 ? idOf(slice[slice.length - 1] as Item) : null,
    });
  }

  #notFound(): Response {
    return Response.json(apiError('not_found', 'not found'), { status: 404 });
  }

  #answer({ path, query }: FakeRequest): Response {
    if (path === '/v1/scenarios') {
      const state = query.get('state');
      return this.#page(
        this.scenarios.filter((item) => state === null || item.state === state),
        query,
      );
    }
    const scenarioPlays = /^\/v1\/scenarios\/([^/]+)\/plays$/.exec(path);
    if (scenarioPlays !== null) {
      const open = query.get('open');
      return this.#page(
        this.plays.filter(
          (item) =>
            item.scenarioId === scenarioPlays[1] &&
            (open === null || (open === 'true') === (item.finishedAt === null)),
        ),
        query,
      );
    }
    const scenarioDecisions = /^\/v1\/scenarios\/([^/]+)\/decisions$/.exec(path);
    if (scenarioDecisions !== null) {
      const state = query.get('state');
      return this.#page(
        (this.decisions.get(scenarioDecisions[1] ?? '') ?? []).filter(
          (item) => state === null || item.state === state,
        ),
        query,
      );
    }
    const scenarioOne = /^\/v1\/scenarios\/([^/]+)$/.exec(path);
    if (scenarioOne !== null) {
      const found = this.scenarios.find((item) => item.id === scenarioOne[1]);
      if (found === undefined) return this.#notFound();
      return Response.json({
        scenario: found,
        conventions: null,
        configOverride: {},
        repos: [],
        counts: { openPlays: 0, pendingDecisions: 0, attachments: 0 },
      });
    }
    const playOne = /^\/v1\/plays\/([^/]+)$/.exec(path);
    if (playOne !== null) {
      const found = this.details.get(playOne[1] ?? '');
      return found === undefined ? this.#notFound() : Response.json(found);
    }
    if (path === '/v1/orders') return this.#page(this.orders, query);
    const orderOne = /^\/v1\/orders\/([^/]+)$/.exec(path);
    if (orderOne !== null) {
      const found = this.orders.find((item) => item.id === orderOne[1]);
      return found === undefined ? this.#notFound() : Response.json(found);
    }
    if (path === '/v1/profiles') return this.#page(this.profiles, query, (item) => item.profile.id);
    const profileOne = /^\/v1\/profiles\/([^/]+)\/([^/]+)$/.exec(path);
    if (profileOne !== null) {
      const found = this.profiles.find(
        (item) => item.profile.id === [profileOne[1], profileOne[2]].join('/'),
      );
      return found === undefined ? this.#notFound() : Response.json(found);
    }
    return this.#notFound();
  }
}

/** Keeps the detail of a play in step with the play record, as the daemon's tables do. */
export function setPlay(
  daemon: FakeDaemon,
  record: ApiPlay,
  demands: ApiPlayDetail['demands'] = [],
): void {
  const at = daemon.plays.findIndex((item) => item.id === record.id);
  if (at < 0) daemon.plays.push(record);
  else daemon.plays[at] = record;
  daemon.details.set(record.id, { play: record, stages: [], demands });
}
