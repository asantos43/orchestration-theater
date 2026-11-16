// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  InvalidInput,
  LOCAL_MODEL_SERVER_PORT_VERSION,
  type LocalModel,
  type LocalModelServer,
  type ServerHealth,
  type SlotInfo,
} from '@otheater/core';
import { z } from 'zod';
import { endpointUrl, getText, type HttpAnswer } from './http.js';

/** Default wait for each HTTP call, in ms [proposta]: local calls answer in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 5000;

// Facts about the Ollama API are marked [S] (documentation read on 2026-11-16: `docs/api.md` in
// ollama/ollama and https://docs.ollama.com/api/ps, /faq) or [N] (not confirmed). Nothing here was
// checked against a running server by this package: the tests use a fake one.
//
// The shapes are loose on purpose: a newer server may add fields, and only the ones used here are
// required to have the right type.

/** `GET /api/version`: `{"version": "0.5.1"}` [S]. */
const VersionSchema = z.looseObject({ version: z.string().min(1) });

/** `GET /api/tags`: `{"models": [{"name": "...", "model": "...", ...}]}` [S]. */
const TagsSchema = z.looseObject({
  models: z.array(z.looseObject({ name: z.string().min(1), model: z.string().min(1).optional() })),
});

/**
 * `GET /api/ps`: loaded models, each with `name`, `model`, `expires_at`, `size_vram` and
 * `context_length` [S: docs.ollama.com/api/ps lists the last one; the older `docs/api.md` example
 * does not, so it is optional here, and 0 or a negative number is "unknown"].
 */
const PsSchema = z.looseObject({
  models: z.array(
    z.looseObject({
      name: z.string().min(1),
      model: z.string().min(1).optional(),
      context_length: z.number().optional(),
    }),
  ),
});

/** Statuses meaning "this server has no such endpoint" (a server older than the endpoint). */
const NOT_SUPPORTED = new Set([404, 501]);

/** `GET /` answers this plain text [S: Ollama README and FAQ; [N] not in `docs/api.md`]. */
const ROOT_BANNER = 'Ollama is running';

export const HEALTH_PROBES = ['version', 'root', 'tags'] as const;
/** The endpoint `health` reads: `/api/version`, `/` (the banner) or `/api/tags`. */
export type HealthProbe = (typeof HEALTH_PROBES)[number];

export const MODELS_SOURCES = ['installed', 'loaded'] as const;
/** Where `models` reads from: `/api/tags` (installed) or `/api/ps` (loaded in memory now). */
export type ModelsSource = (typeof MODELS_SOURCES)[number];

export const CONTEXT_WINDOWS = ['loaded', 'none'] as const;
/** Whether `contextWindow` is filled from `context_length` of `/api/ps` or left out. */
export type ContextWindowMode = (typeof CONTEXT_WINDOWS)[number];

export const CONTEXT_MODES = ['total', 'per_slot'] as const;
/**
 * What `context_length` of `/api/ps` is. `total`: the context allocated for the instance, which
 * Ollama grows with the number of parallel requests (the FAQ: "increasing the context size by the
 * number of parallel requests"), so the context of one slot is `context_length / parallel`.
 * `per_slot`: it already is the context of one request. Which one the server reports is [N].
 */
export type ContextMode = (typeof CONTEXT_MODES)[number];

/** Number of parallel requests (`OLLAMA_NUM_PARALLEL`) of the instance behind a URL, or unknown. */
export type ParallelResolver = (url: string) => number | undefined;

export interface OllamaServerOptions {
  /** Wait for each HTTP call; a positive integer. Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Endpoint read by `health`. Default `version`. */
  readonly healthProbe?: HealthProbe;
  /** Where `models` reads from. Default `installed`. */
  readonly modelsSource?: ModelsSource;
  /** Whether `models` fills `contextWindow` from `/api/ps`. Default `loaded`. */
  readonly contextWindow?: ContextWindowMode;
  /** How `/api/ps` `context_length` is read to get the context of one slot. Default `total`. */
  readonly contextMode?: ContextMode;
  /**
   * `OLLAMA_NUM_PARALLEL` of the instance(s): a number for every URL, or a function of the URL (one
   * adapter serves every profile, and each may point at an instance started with another value).
   * The variable belongs to the server and is not exposed by the API [N], so Ollama only has a
   * `slots` count when the user (or the setup assistant) says it. Without it, `count` is
   * `undefined` and `slots: auto` falls back to 1 (architecture 5.9).
   */
  readonly parallel?: number | ParallelResolver;
}

/** Parses a JSON body against a schema; the reason of a failure goes in the error message. */
function parse<T>(schema: z.ZodType<T>, answer: HttpAnswer, what: string): T {
  let json: unknown;
  try {
    json = JSON.parse(answer.body);
  } catch (error) {
    throw new AdapterUnavailable(`${what}: the answer is not JSON`, { cause: error });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new AdapterUnavailable(`${what}: unexpected format (${z.prettifyError(result.error)})`, {
      cause: result.error,
    });
  }
  return result.data;
}

function checkPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidInput(`${name} must be a positive integer, got ${String(value)}`);
  }
}

/** A usable context length: a positive integer; anything else means the server did not say. */
function usableContext(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * `LocalModelServer` for Ollama, over HTTP (architecture 5.9, 5.18; decision N71). Stateless: the
 * URL comes with each call, as in the port. Only `GET`s are sent, and no text is generated.
 */
export class OllamaServer implements LocalModelServer {
  readonly id = 'ollama';
  readonly implements = {
    port: 'LocalModelServer',
    range: `^${LOCAL_MODEL_SERVER_PORT_VERSION}`,
  } as const;

  readonly #timeoutMs: number;
  readonly #healthProbe: HealthProbe;
  readonly #modelsSource: ModelsSource;
  readonly #contextWindow: ContextWindowMode;
  readonly #contextMode: ContextMode;
  readonly #parallel: number | ParallelResolver | undefined;

  constructor(options: OllamaServerOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    checkPositiveInteger('timeoutMs', timeoutMs);
    if (typeof options.parallel === 'number') checkPositiveInteger('parallel', options.parallel);
    this.#timeoutMs = timeoutMs;
    this.#healthProbe = options.healthProbe ?? 'version';
    this.#modelsSource = options.modelsSource ?? 'installed';
    this.#contextWindow = options.contextWindow ?? 'loaded';
    this.#contextMode = options.contextMode ?? 'total';
    this.#parallel = options.parallel;
  }

  /**
   * Reads the probe endpoint ({@link HealthProbe}, default `GET /api/version`): 200 with the
   * expected body is `ok`; 503 is `loading` (the only "not ready" signal known, from a proxy or
   * a server that answers while it starts; Ollama has no model-loading state in its API, and
   * the port is closed until it is up [N]); anything else, an answer that is not from Ollama, a
   * refused connection or a timeout is `unreachable` with the reason in `detail`. Never rejects
   * because of the server. An unusable URL (not http/https, with credentials) is a caller bug
   * and rejects with `InvalidInput`.
   */
  async health(url: string): Promise<ServerHealth> {
    const path = { version: 'api/version', root: '', tags: 'api/tags' }[this.#healthProbe];
    const target = endpointUrl(url, path);
    let answer: HttpAnswer;
    try {
      answer = await getText(target, this.#timeoutMs);
    } catch (error) {
      if (error instanceof AdapterUnavailable) {
        return { status: 'unreachable', detail: error.message };
      }
      throw error;
    }
    if (answer.status === 503) return { status: 'loading', detail: 'HTTP 503' };
    if (answer.status !== 200) {
      return { status: 'unreachable', detail: `HTTP ${String(answer.status)}` };
    }
    try {
      this.#checkProbeBody(answer);
    } catch (error) {
      return { status: 'unreachable', detail: (error as Error).message };
    }
    return { status: 'ok' };
  }

  #checkProbeBody(answer: HttpAnswer): void {
    switch (this.#healthProbe) {
      case 'version':
        parse(VersionSchema, answer, 'health');
        return;
      case 'tags':
        parse(TagsSchema, answer, 'health');
        return;
      case 'root':
        if (!answer.body.trim().startsWith(ROOT_BANNER)) {
          throw new AdapterUnavailable('health: the answer is not the Ollama banner');
        }
    }
  }

  /**
   * The models of the server: the installed ones (`GET /api/tags`, default: Ollama loads a model
   * on the first request, so every installed model can be used) or the ones loaded now
   * (`GET /api/ps`). `contextWindow` is the `context_length` of `/api/ps` for a model that is
   * loaded, and left out for one that is not: an unloaded model has no loaded context, and the
   * training context in `/api/show` is not the one the server uses.
   */
  async models(url: string): Promise<readonly LocalModel[]> {
    const loaded = this.#modelsSource === 'loaded' || this.#contextWindow === 'loaded';
    const installed =
      this.#modelsSource === 'installed'
        ? (await this.#required(url, 'api/tags', TagsSchema, 'models')).models
        : [];
    const running = loaded
      ? ((await this.#optional(url, 'api/ps', PsSchema, 'models'))?.models ?? [])
      : [];
    const contextOf = new Map<string, number | undefined>();
    for (const model of running) {
      const context = usableContext(model.context_length);
      contextOf.set(model.model ?? model.name, context);
      contextOf.set(model.name, context);
    }
    const listed = this.#modelsSource === 'installed' ? installed : running;
    return listed.map((entry) => {
      const id = entry.model ?? entry.name;
      const contextWindow =
        this.#contextWindow === 'loaded'
          ? (contextOf.get(id) ?? contextOf.get(entry.name))
          : undefined;
      return contextWindow === undefined ? { id } : { id, contextWindow };
    });
  }

  /**
   * Slots of the instance. `count` is the configured `parallel` (the API does not say it [N]) and
   * `undefined` without it. `contextPerSlot` comes from `context_length` of `/api/ps`: the
   * smallest among the loaded models (the safe reading), divided by `count` when
   * `contextMode` is `total`. With no model loaded, or a server without `/api/ps` or without
   * the field, it is `undefined`.
   */
  async slots(url: string): Promise<SlotInfo> {
    const parallel = this.#resolveParallel(url);
    const ps = await this.#optional(url, 'api/ps', PsSchema, 'slots');
    const contexts = (ps?.models ?? []).flatMap((model) => {
      const context = usableContext(model.context_length);
      return context === undefined ? [] : [context];
    });
    let contextPerSlot: number | undefined;
    if (contexts.length > 0) {
      const smallest = Math.min(...contexts);
      const perSlot =
        this.#contextMode === 'total' ? Math.floor(smallest / (parallel ?? 1)) : smallest;
      contextPerSlot = perSlot > 0 ? perSlot : undefined;
    }
    return { count: parallel, contextPerSlot };
  }

  #resolveParallel(url: string): number | undefined {
    const value = typeof this.#parallel === 'function' ? this.#parallel(url) : this.#parallel;
    if (value === undefined) return undefined;
    checkPositiveInteger('parallel', value);
    return value;
  }

  /** GET and parse one endpoint; any answer but 200 rejects. */
  async #required<T>(url: string, path: string, schema: z.ZodType<T>, what: string): Promise<T> {
    const answer = await getText(endpointUrl(url, path), this.#timeoutMs);
    if (answer.status !== 200) {
      throw new AdapterUnavailable(`${what}: /${path} answered HTTP ${String(answer.status)}`);
    }
    return parse(schema, answer, `${what}: /${path}`);
  }

  /** GET and parse one endpoint; `undefined` when the server says it does not have it. */
  async #optional<T>(
    url: string,
    path: string,
    schema: z.ZodType<T>,
    what: string,
  ): Promise<T | undefined> {
    const answer = await getText(endpointUrl(url, path), this.#timeoutMs);
    if (NOT_SUPPORTED.has(answer.status)) return undefined;
    if (answer.status !== 200) {
      throw new AdapterUnavailable(`${what}: /${path} answered HTTP ${String(answer.status)}`);
    }
    return parse(schema, answer, `${what}: /${path}`);
  }
}
