// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';

/** Name the fake agent reports as its `service.name` and instrumentation scope. */
export const FAKE_OTEL_SERVICE = 'otheater-fake-agent';

/** What a fake receiver (or the real one) is told, by signal. */
export type FakeOtelSignal = 'traces' | 'metrics' | 'logs';

type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface FakeOtelOptions {
  /** Test seam: replaces the global `fetch`. */
  fetch?: FetchLike;
  /** Called with the reason an export failed. Default: one line on stderr. Never fails the turn. */
  onError?: (reason: string) => void;
  /** Version reported by the instrumentation scope. */
  version?: string;
}

interface Attribute {
  key: string;
  value: { stringValue: string } | { intValue: string };
}

/** A comma-separated `k=v` list, as `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_EXPORTER_OTLP_HEADERS` carry it. */
function parsePairs(text: string | undefined): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const item of (text ?? '').split(',')) {
    const at = item.indexOf('=');
    if (at <= 0) continue;
    const key = item.slice(0, at).trim();
    if (key !== '') pairs.set(key, item.slice(at + 1).trim());
  }
  return pairs;
}

function text(key: string, value: string): Attribute {
  return { key, value: { stringValue: value } };
}

function int(key: string, value: number): Attribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');
const nano = (ms: number): string => (BigInt(Math.trunc(ms)) * 1_000_000n).toString();

/** Rough, deterministic token count of a text: four characters a token. */
export function approximateTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / 4);
}

/** What one prompt turn reported to the receiver. */
export interface OtelTurn {
  /** One log record per tool call (`tool_call`), reported while the turn runs. */
  toolCall(title: string, toolCallId: string): void;
  /** Counts the characters the turn sent as agent text (the output tokens, when `usage` is not set). */
  outputText(chars: number): void;
  /** Sets the token usage explicitly (the `usage-signal` script); otherwise it is derived from the text. */
  usage(usage: { model: string; inputTokens: number; outputTokens: number }): void;
  /** Sends the span, the token metrics and the logs of the turn. Resolves when the exports ended; never rejects. */
  end(stopReason: string): Promise<void>;
}

/**
 * The OTLP/HTTP exporter of the fake agent (Phase 8, P3; architecture 5.11): the double of what the
 * real clients do when the daemon starts them with `OTEL_*` variables. One span per prompt turn,
 * the token counter as a metric and one log record per tool call, as OTLP/JSON POSTs to
 * `<endpoint>/v1/<signal>` with the headers and the resource attributes of the environment. It
 * uses `fetch` only and never reads a file. A failed export is reported once on stderr and ignored.
 */
export class FakeOtel {
  readonly #base: string;
  readonly #headers: Record<string, string>;
  readonly #resource: Attribute[];
  readonly #disabled: ReadonlySet<FakeOtelSignal>;
  readonly #fetch: FetchLike;
  readonly #onError: (reason: string) => void;
  readonly #version: string;
  #reported = false;

  constructor(
    base: string,
    headers: Record<string, string>,
    resource: Attribute[],
    disabled: ReadonlySet<FakeOtelSignal>,
    options: FakeOtelOptions,
  ) {
    this.#base = base;
    this.#headers = headers;
    this.#resource = resource;
    this.#disabled = disabled;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#onError =
      options.onError ??
      ((reason) => {
        process.stderr.write(`fake-agent: otel export failed: ${reason}\n`);
      });
    this.#version = options.version ?? '0.0.0';
  }

  /**
   * Reads the standard variables: `OTEL_EXPORTER_OTLP_ENDPOINT` (without it there is no exporter),
   * `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`,
   * `OTEL_EXPORTER_OTLP_PROTOCOL` (only `http/json`: with another one it exports nothing and says
   * so) and `OTEL_{TRACES,METRICS,LOGS}_EXPORTER=none` to leave a signal out.
   */
  static fromEnv(
    env: Readonly<Record<string, string | undefined>>,
    options: FakeOtelOptions = {},
  ): FakeOtel | undefined {
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (endpoint === undefined || endpoint.trim() === '') return undefined;
    const protocol = env.OTEL_EXPORTER_OTLP_PROTOCOL;
    if (protocol !== undefined && protocol !== '' && protocol !== 'http/json') {
      (options.onError ?? ((reason) => process.stderr.write(`fake-agent: ${reason}\n`)))(
        `OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is not supported: only http/json`,
      );
      return undefined;
    }
    const resource = parsePairs(env.OTEL_RESOURCE_ATTRIBUTES);
    const service = env.OTEL_SERVICE_NAME;
    if (service !== undefined && service !== '') resource.set('service.name', service);
    if (!resource.has('service.name')) resource.set('service.name', FAKE_OTEL_SERVICE);
    const disabled = new Set<FakeOtelSignal>();
    if (env.OTEL_TRACES_EXPORTER === 'none') disabled.add('traces');
    if (env.OTEL_METRICS_EXPORTER === 'none') disabled.add('metrics');
    if (env.OTEL_LOGS_EXPORTER === 'none') disabled.add('logs');
    return new FakeOtel(
      endpoint.trim().replace(/\/+$/u, ''),
      Object.fromEntries(parsePairs(env.OTEL_EXPORTER_OTLP_HEADERS)),
      [...resource].map(([key, value]) => text(key, value)),
      disabled,
      options,
    );
  }

  /** Starts a turn: the span begins now, the tool calls and the tokens are collected until `end`. */
  beginTurn(info: {
    sessionId: string;
    script: string;
    model: string;
    promptChars: number;
  }): OtelTurn {
    const startedAt = Date.now();
    const traceId = hex(16);
    const spanId = hex(8);
    const tools: { title: string; toolCallId: string; at: number }[] = [];
    let outputChars = 0;
    let explicit: { model: string; inputTokens: number; outputTokens: number } | undefined;
    return {
      toolCall: (title, toolCallId) => {
        tools.push({ title, toolCallId, at: Date.now() });
      },
      outputText: (chars) => {
        outputChars += chars;
      },
      usage: (usage) => {
        explicit = usage;
      },
      end: async (stopReason) => {
        const endedAt = Date.now();
        const usage = explicit ?? {
          model: info.model,
          inputTokens: approximateTokens(info.promptChars),
          outputTokens: approximateTokens(outputChars),
        };
        const common = [text('session.id', info.sessionId), text('model', usage.model)];
        const failed = stopReason === 'error';
        await Promise.all([
          this.#send('traces', {
            resourceSpans: [
              {
                resource: { attributes: this.#resource },
                scopeSpans: [
                  {
                    scope: this.#scope(),
                    spans: [
                      {
                        traceId,
                        spanId,
                        name: 'fake_agent.turn',
                        kind: 1,
                        startTimeUnixNano: nano(startedAt),
                        endTimeUnixNano: nano(endedAt),
                        attributes: [
                          ...common,
                          text('script', info.script),
                          text('stop_reason', stopReason),
                          int('tool_calls', tools.length),
                        ],
                        status: { code: failed ? 2 : 1 },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          this.#send('metrics', {
            resourceMetrics: [
              {
                resource: { attributes: this.#resource },
                scopeMetrics: [
                  {
                    scope: this.#scope(),
                    metrics: [
                      {
                        name: 'fake_agent.token.usage',
                        unit: '{token}',
                        sum: {
                          aggregationTemporality: 1,
                          isMonotonic: true,
                          dataPoints: [
                            ['input', usage.inputTokens],
                            ['output', usage.outputTokens],
                          ].map(([type, value]) => ({
                            attributes: [...common, text('type', String(type))],
                            startTimeUnixNano: nano(startedAt),
                            timeUnixNano: nano(endedAt),
                            asInt: String(value),
                          })),
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          this.#send('logs', {
            resourceLogs: [
              {
                resource: { attributes: this.#resource },
                scopeLogs: [
                  {
                    scope: this.#scope(),
                    logRecords: tools.map((tool) => ({
                      timeUnixNano: nano(tool.at),
                      severityNumber: 9,
                      severityText: 'INFO',
                      body: { stringValue: 'tool_call' },
                      attributes: [
                        ...common,
                        text('tool.name', tool.title),
                        text('tool.call_id', tool.toolCallId),
                      ],
                      traceId,
                      spanId,
                    })),
                  },
                ],
              },
            ],
          }),
        ]);
      },
    };
  }

  #scope(): { name: string; version: string } {
    return { name: FAKE_OTEL_SERVICE, version: this.#version };
  }

  async #send(signal: FakeOtelSignal, body: unknown): Promise<void> {
    if (this.#disabled.has(signal)) return;
    // A turn without tool calls has no log to send.
    if (signal === 'logs' && JSON.stringify(body).includes('"logRecords":[]')) return;
    try {
      const response = await this.#fetch(`${this.#base}/v1/${signal}`, {
        method: 'POST',
        headers: { ...this.#headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) this.#fail(`${signal} answered ${String(response.status)}`);
    } catch (error) {
      this.#fail(`${signal}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Once per process: a receiver that is down must not fill the diagnostics of every turn. */
  #fail(reason: string): void {
    if (this.#reported) return;
    this.#reported = true;
    this.#onError(reason);
  }
}
