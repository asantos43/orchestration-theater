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

// The shapes below follow the `llama-server` README (tools/server/README.md in ggml-org/llama.cpp,
// read on 2026-11-16) and `server-context.cpp`. They are loose on purpose: a newer server may add
// fields, and only the ones used here are required to have the right type.

/** `GET /health`, 200: `{"status": "ok"}`. Any JSON object counts; the status code is the signal. */
const HealthSchema = z.looseObject({ status: z.string().optional() });

/** `GET /health`, 503 while loading: `{"error": {"code": 503, "message": "Loading model", ...}}`. */
const LoadingSchema = z.looseObject({
  error: z.looseObject({ message: z.string().optional() }).optional(),
  status: z.string().optional(),
});

/** `GET /v1/models`: `{"object": "list", "data": [{"id": "...", ...}]}`. */
const ModelsSchema = z.looseObject({ data: z.array(z.looseObject({ id: z.string().min(1) })) });

/**
 * `GET /props`: `total_slots` is `--parallel`; `default_generation_settings.n_ctx` is the context
 * of ONE slot (`n_ctx_slot()` in the server source), so it needs no division.
 */
const PropsSchema = z.looseObject({
  total_slots: z.int().positive().optional(),
  default_generation_settings: z.looseObject({ n_ctx: z.int().positive().optional() }).optional(),
});

/** `GET /slots`: an array with one object per slot; `n_ctx` is the context of that slot. */
const SlotsSchema = z.array(z.looseObject({ n_ctx: z.int().positive().optional() }));

/** Statuses meaning "this server has no such endpoint" (disabled with `--no-slots`, or too old). */
const NOT_SUPPORTED = new Set([404, 501]);

export interface LlamaCppServerOptions {
  /** Wait for each HTTP call; a positive integer. Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
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

/**
 * `LocalModelServer` for the `llama-server` of llama.cpp, over HTTP (architecture 5.9, 5.18).
 * Stateless: the URL comes with each call, as in the port.
 */
export class LlamaCppServer implements LocalModelServer {
  readonly id = 'llama-cpp';
  readonly implements = {
    port: 'LocalModelServer',
    range: `^${LOCAL_MODEL_SERVER_PORT_VERSION}`,
  } as const;

  readonly #timeoutMs: number;

  constructor(options: LlamaCppServerOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new InvalidInput(`timeoutMs must be a positive integer, got ${String(timeoutMs)}`);
    }
    this.#timeoutMs = timeoutMs;
  }

  /**
   * `GET /health`: 200 is `ok`; 503 is `loading` (the model is being loaded); anything else, an
   * answer that is not from a llama-server, a refused connection or a timeout is `unreachable`
   * with the reason in `detail`. Never rejects because of the server. An unusable URL (not
   * http/https, with credentials) is a caller bug and rejects with `InvalidInput`.
   */
  async health(url: string): Promise<ServerHealth> {
    const target = endpointUrl(url, 'health');
    let answer: HttpAnswer;
    try {
      answer = await getText(target, this.#timeoutMs);
    } catch (error) {
      if (error instanceof AdapterUnavailable) {
        return { status: 'unreachable', detail: error.message };
      }
      throw error;
    }
    if (answer.status === 200) {
      try {
        parse(HealthSchema, answer, 'health');
      } catch (error) {
        return { status: 'unreachable', detail: (error as Error).message };
      }
      return { status: 'ok' };
    }
    if (answer.status === 503) {
      let detail = 'HTTP 503';
      try {
        const body = parse(LoadingSchema, answer, 'health');
        detail = body.error?.message ?? body.status ?? detail;
      } catch {
        // A 503 without the documented body (a proxy, an old server) still means "not ready".
      }
      return { status: 'loading', detail };
    }
    return { status: 'unreachable', detail: `HTTP ${String(answer.status)}` };
  }

  /**
   * `GET /v1/models`: the ids of the models the server lists. `contextWindow` is left out: the
   * only number this endpoint carries is `meta.n_ctx_train`, the context the model was trained
   * for, not the one the server loaded it with.
   */
  async models(url: string): Promise<readonly LocalModel[]> {
    const answer = await getText(endpointUrl(url, 'v1/models'), this.#timeoutMs);
    if (answer.status !== 200) {
      throw new AdapterUnavailable(`models: the server answered HTTP ${String(answer.status)}`);
    }
    const body = parse(ModelsSchema, answer, 'models');
    return body.data.map((model) => ({ id: model.id }));
  }

  /**
   * Slots of the instance. `GET /props` is read first (always on, and carries both numbers);
   * `GET /slots` completes what `/props` did not say. An endpoint the server does not have (404
   * for an old server, 501 with `--no-slots`) is "the server does not say": both fields stay
   * `undefined` and the setup falls back to 1 slot. Other failures reject.
   */
  async slots(url: string): Promise<SlotInfo> {
    const props = await this.#optional(url, 'props', PropsSchema);
    let count = props?.total_slots;
    let contextPerSlot = props?.default_generation_settings?.n_ctx;
    if (count === undefined || contextPerSlot === undefined) {
      const list = await this.#optional(url, 'slots', SlotsSchema);
      if (list !== undefined && list.length > 0) {
        count ??= list.length;
        const contexts = list.flatMap((slot) => (slot.n_ctx === undefined ? [] : [slot.n_ctx]));
        // Every slot has the same window in llama.cpp; the smallest is the safe reading.
        if (contextPerSlot === undefined && contexts.length > 0) {
          contextPerSlot = Math.min(...contexts);
        }
      }
    }
    return { count, contextPerSlot };
  }

  /** GET and parse one endpoint; `undefined` when the server says it does not have it. */
  async #optional<T>(url: string, path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const answer = await getText(endpointUrl(url, path), this.#timeoutMs);
    if (NOT_SUPPORTED.has(answer.status)) return undefined;
    if (answer.status !== 200) {
      throw new AdapterUnavailable(`slots: /${path} answered HTTP ${String(answer.status)}`);
    }
    return parse(schema, answer, `slots: /${path}`);
  }
}
