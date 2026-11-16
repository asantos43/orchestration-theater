// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  InvalidInput,
  isOTheaterError,
  Transient,
  type Executor,
  type ExecutorDraft,
  type ModelCatalog,
  type ModelCost,
  type ModelInfo,
  type ProcessLauncher,
  type ProfileRef,
  type ValidationIssue,
  type ValidationResult,
} from '@otheater/core';
import {
  DEFAULT_ISOLATION,
  ensureProfileFiles,
  isolationEnv,
  type ProfileFilesOptions,
} from './profile.js';

/**
 * Effort the client offers in addition to the `variants` of the model: the ACP `effort` option of
 * Phase 0 listed `default` next to the variants for every model measured [V]. It means "no variant".
 */
export const DEFAULT_EFFORT = 'default';

/** [proposta] key `clients.opencode.suggest.effort_preference`: first one the model offers wins. */
export const DEFAULT_EFFORT_PREFERENCE: readonly string[] = ['medium', 'low', 'high'];

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function price(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** True for an `api.url` on this machine (architecture 5.7, step 2): `localhost` or a loopback address. */
export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function costOf(value: unknown): ModelCost | undefined {
  const cost = record(value);
  const input = price(cost?.input);
  const output = price(cost?.output);
  if (input === undefined || output === undefined) return undefined;
  const cache = record(cost?.cache);
  const cacheRead = price(cache?.read);
  const cacheWrite = price(cache?.write);
  return {
    inputPerMTokUsd: input,
    outputPerMTokUsd: output,
    ...(cacheRead === undefined ? {} : { cacheReadPerMTokUsd: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWritePerMTokUsd: cacheWrite }),
  };
}

function modelOf(id: string, details: unknown): ModelInfo {
  const model = record(details);
  const name = nonEmpty(model?.name);
  // The family comes from the registry of the client, never from the prefix of the id: the prefix
  // is the account or gateway the model is called through (architecture 5.7) [V]. It is empty in
  // 42 of 532 models of 1.19.5 [V], and then it stays empty.
  const family = nonEmpty(model?.family);
  const variants = record(model?.variants);
  const apiUrl = nonEmpty(record(model?.api)?.url);
  const toolcall = record(model?.capabilities)?.toolcall;
  const contextWindow = positive(record(model?.limit)?.context);
  const cost = costOf(model?.cost);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(family === undefined ? {} : { family }),
    efforts: variants === undefined ? [] : Object.keys(variants),
    local: apiUrl !== undefined && isLocalUrl(apiUrl),
    ...(typeof toolcall === 'boolean' ? { toolCalls: toolcall } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(cost === undefined ? {} : { cost }),
  };
}

/** What {@link parseModelsVerbose} found. */
export interface ParsedModels {
  readonly models: readonly ModelInfo[];
  /** Blocks whose JSON could not be read: they are left out, never guessed. */
  readonly skipped: number;
}

const MODEL_HEADER = /^[^\s{}"[\]]+\/\S+$/;

/**
 * Parses the output of `opencode models --verbose`: for each model a line `providerID/modelID`
 * followed by the model as indented JSON, the closing brace at column 0 (the shape the `models`
 * command prints [S: the command source, not the 1.19.5 binary]; the content of the JSON is what
 * Phase 0, item 9, measured on 1.19.5 [V]). Lines that are neither a header nor part of a block
 * are ignored, so a notice in front of the list does not break it. A header with no JSON after it
 * (plain `opencode models`) is kept with what the id alone says. Pure.
 */
export function parseModelsVerbose(output: string): ParsedModels {
  const lines = output.split(/\r?\n/);
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const add = (info: ModelInfo): void => {
    if (seen.has(info.id)) return;
    seen.add(info.id);
    models.push(info);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const header = (lines[index] ?? '').trim();
    if (!MODEL_HEADER.test(header)) continue;
    if ((lines[index + 1] ?? '').trimEnd() !== '{') {
      add(modelOf(header, undefined));
      continue;
    }
    let end = index + 2;
    while (end < lines.length && (lines[end] ?? '').trimEnd() !== '}') end += 1;
    if (end >= lines.length) {
      skipped += 1;
      break;
    }
    try {
      add(modelOf(header, JSON.parse(lines.slice(index + 1, end + 1).join('\n')) as unknown));
    } catch {
      skipped += 1;
    }
    index = end;
  }
  return { models, skipped };
}

/** What the effort of an Executor may be for this model: its variants, and `default`. */
export function acceptsEffort(model: ModelInfo, effort: string): boolean {
  return effort === DEFAULT_EFFORT || model.efforts.includes(effort);
}

export interface OpenCodeModelCatalogOptions {
  readonly launcher: ProcessLauncher;
  /** Environment `opencode models` starts from (the base never reads `process.env`; the caller does). */
  readonly baseEnv: Readonly<Record<string, string>>;
  /** Absolute directory of a profile; the daemon knows where the profiles live. */
  readonly profileDir: (profile: ProfileRef) => string;
  /** [proposta] key `clients.opencode.command`: the executable. Default `opencode`. */
  readonly cmd?: string;
  /** Must be the settings the adapter writes with, so the catalog reads the same profile. */
  readonly files?: ProfileFilesOptions;
  /** Wait for `opencode models`. Default 60 s [proposta]. */
  readonly timeoutMs?: number;
  /** Largest output taken in. Default 32 MiB; the list of 1.19.5 has 532 models [V]. */
  readonly maxOutputBytes?: number;
  /** [proposta] key `clients.opencode.models_cache_ms`: how long a list is reused. Default 60 s; 0 reads every time. */
  readonly cacheMs?: number;
  /** Clock for the cache, epoch ms. Default `Date.now`. */
  readonly now?: () => number;
  /** [proposta] key `clients.opencode.suggest.effort_preference`. Default {@link DEFAULT_EFFORT_PREFERENCE}. */
  readonly effortPreference?: readonly string[];
  /** `validate` reports a context window below this. Unset: not checked (the roles decide, 5.7). */
  readonly minContextWindow?: number;
  /** Severity of a window below the minimum, to follow `roles.capability_check`: `warning` (default) or `error`. */
  readonly contextSeverity?: 'warning' | 'error';
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_CACHE_MS = 60_000;
const STDERR_LIMIT = 16 * 1024;

async function readText(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  what: string,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        throw new AdapterUnavailable(
          `the ${what} of opencode is larger than ${String(limit)} bytes`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 300 ? `...${trimmed.slice(-300)}` : trimmed;
}

function pending<T>(promise: Promise<T>): Promise<T> {
  // A stream that fails after the timeout already won the race must not become an unhandled rejection.
  promise.catch(() => undefined);
  return promise;
}

/**
 * The `ModelCatalog` of OpenCode (architecture 5.2, 5.7): `assisted`. It reads the catalog with
 * `opencode models --verbose` in the profile directory, through the injected `ProcessLauncher`,
 * with the same isolation variables as the sessions (so a profile lists the models of its own
 * logins). It never calls a model.
 */
export class OpenCodeModelCatalog implements ModelCatalog {
  readonly discovery = 'assisted';
  readonly #options: OpenCodeModelCatalogOptions;
  readonly #cache = new Map<string, { at: number; models: readonly ModelInfo[] }>();
  readonly #inflight = new Map<string, Promise<readonly ModelInfo[]>>();

  constructor(options: OpenCodeModelCatalogOptions) {
    this.#options = options;
  }

  list(profile: ProfileRef): Promise<readonly ModelInfo[]> {
    const key = `${profile.client}/${profile.profile}`;
    const cacheMs = this.#options.cacheMs ?? DEFAULT_CACHE_MS;
    const now = (this.#options.now ?? Date.now)();
    const cached = this.#cache.get(key);
    if (cached !== undefined && cacheMs > 0 && now - cached.at < cacheMs) {
      return Promise.resolve(cached.models);
    }
    const running = this.#inflight.get(key);
    if (running !== undefined) return running;
    const started = this.#read(profile).then((models) => {
      this.#cache.set(key, { at: (this.#options.now ?? Date.now)(), models });
      return models;
    });
    const tracked = started.finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, tracked);
    return tracked;
  }

  /**
   * Fills in what the Producer starts from (architecture 5.7, "Cadastro"): the effort among the
   * variants of the model, the family the client's registry gives (nothing when it is empty), whether
   * the model is local, the window and the price. The Producer confirms or corrects each field.
   */
  suggest(model: ModelInfo): Partial<ExecutorDraft> {
    const preference = this.#options.effortPreference ?? DEFAULT_EFFORT_PREFERENCE;
    const effort = preference.find((level) => model.efforts.includes(level)) ?? model.efforts[0];
    return {
      ...(effort === undefined ? {} : { effort }),
      ...(model.family === undefined ? {} : { family: model.family }),
      local: model.local,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.cost === undefined ? {} : { cost: model.cost }),
    };
  }

  /**
   * The model exists in the list, the effort is one of its variants (or `default`) and it calls
   * tools (architecture 5.7, step 4). A catalog that does not say whether it calls tools is a
   * warning, not a failure. A profile the list cannot be read for is `profile_invalid`; a
   * `Transient` failure is rethrown, so a busy machine does not mark an Executor invalid.
   */
  async validate(executor: Executor): Promise<ValidationResult> {
    const issues: ValidationIssue[] = [];
    let models: readonly ModelInfo[];
    try {
      models = await this.list(executor.profile);
    } catch (error) {
      if (error instanceof Transient || !isOTheaterError(error)) throw error;
      issues.push({
        code: 'profile_invalid',
        severity: 'error',
        message: `the models of ${executor.profile.client}/${executor.profile.profile} cannot be listed: ${error.message}`,
      });
      return { ok: false, issues };
    }
    const model = models.find((candidate) => candidate.id === executor.model);
    if (model === undefined) {
      issues.push({
        code: 'model_not_found',
        severity: 'error',
        message: `the model ${executor.model} is not in the catalog of ${executor.profile.profile}`,
      });
      return { ok: false, issues };
    }
    if (executor.effort !== undefined && !acceptsEffort(model, executor.effort)) {
      issues.push({
        code: 'effort_not_accepted',
        severity: 'error',
        message: `the model ${model.id} does not accept the effort ${executor.effort} (it offers: ${[DEFAULT_EFFORT, ...model.efforts].join(', ')})`,
      });
    }
    if (model.toolCalls === false) {
      issues.push({
        code: 'no_tool_calls',
        severity: 'error',
        message: `the model ${model.id} does not call tools`,
      });
    } else if (model.toolCalls === undefined) {
      issues.push({
        code: 'no_tool_calls',
        severity: 'warning',
        message: `the catalog does not say whether ${model.id} calls tools`,
      });
    }
    const minimum = this.#options.minContextWindow;
    if (minimum !== undefined && (model.contextWindow ?? 0) < minimum) {
      issues.push({
        code: 'context_too_small',
        severity: this.#options.contextSeverity ?? 'warning',
        message: `the context window of ${model.id} (${String(model.contextWindow ?? 'unknown')}) is below ${String(minimum)}`,
      });
    }
    return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
  }

  async #read(profile: ProfileRef): Promise<readonly ModelInfo[]> {
    const options = this.#options;
    const dir = options.profileDir(profile);
    await ensureProfileFiles(dir, options.files);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_BYTES;
    const process = await options.launcher.launch({
      cmd: options.cmd ?? 'opencode',
      args: ['models', '--verbose'],
      cwd: dir,
      env: {
        ...options.baseEnv,
        ...isolationEnv(dir, options.files?.isolation ?? DEFAULT_ISOLATION),
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      void process.stdin
        .getWriter()
        .close()
        .catch(() => undefined);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Transient(`opencode models did not finish within ${String(timeoutMs)} ms`));
        }, timeoutMs);
      });
      const finished = pending(
        Promise.all([
          readText(process.stdout, limit, 'model list'),
          readText(process.stderr, STDERR_LIMIT, 'error output').catch(() => ''),
          process.exited,
        ]),
      );
      const [stdout, stderr, exit] = await Promise.race([finished, timeout]);
      if (exit.code !== 0) {
        const why =
          exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `code ${String(exit.code)}`;
        throw new AdapterUnavailable(`opencode models ended with ${why}: ${tail(stderr)}`);
      }
      const parsed = parseModelsVerbose(stdout);
      if (parsed.models.length === 0) {
        throw new AdapterUnavailable(
          `opencode models printed no model that could be read (${String(parsed.skipped)} blocks skipped): ${tail(stdout)}`,
        );
      }
      return parsed.models;
    } catch (error) {
      if (isOTheaterError(error)) throw error;
      throw new AdapterUnavailable(
        `opencode models failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      await process.killTree().catch(() => undefined);
    }
  }
}

/** The directory resolver of the catalog, or one that refuses: a catalog with no way to find the profile fails when it is used, not when it is built. */
export function requireProfileDir(
  resolver: ((profile: ProfileRef) => string) | undefined,
): (profile: ProfileRef) => string {
  if (resolver === undefined) {
    return () => {
      throw new InvalidInput('the model catalog needs a profileDir resolver to list the models');
    };
  }
  return resolver;
}
