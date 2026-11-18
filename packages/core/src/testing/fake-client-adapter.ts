// SPDX-License-Identifier: MPL-2.0
import {
  ClientAdapter,
  type AcpExtensionHandler,
  type ClientAdapterOptions,
  type ConformanceProbe,
  type TransportId,
} from '../client-adapter-base.js';
import { AdapterUnavailable } from '../errors.js';
import type { NormalizedUpdate, ToolCallStatus, ToolKind } from '../normalized-update.js';
import { TOOL_KINDS } from '../normalized-update.js';
import type { AdapterImplements } from '../ports/adapter.js';
import type { NormalizedError, RawUpdate, SessionSetup } from '../ports/agent-session.js';
import {
  ROLE_POLICY_FIELDS,
  type ClientCapabilities,
  type Enforcement,
  type LoginFlow,
  type LoginProbeResult,
  type LoginState,
  type ProcessModel,
  type RolePolicy,
} from '../ports/client-adapter.js';
import type { Executor, ExecutorConfig, Profile } from '../ports/executor.js';
import {
  type ExecutorDraft,
  type ModelCatalog,
  type ModelInfo,
  type ValidationResult,
} from '../ports/model-catalog.js';
import {
  QUOTA_PROBE_PORT_VERSION,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '../ports/quota-probe.js';

/** A quota probe with no source: `read` rejects, as a client that has said nothing yet would. */
export class FakeQuotaProbe implements QuotaProbe {
  readonly id = 'fake';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };

  capabilities(): QuotaCapabilities {
    return { windows: [], delivery: 'poll', precision: 'approximate' };
  }

  read(): Promise<QuotaReading> {
    return Promise.reject(new AdapterUnavailable('the fake client reports no quota'));
  }
}

/** The two models of the fake client, `fake-model` and `fake-model-2`. */
export class FakeModelCatalog implements ModelCatalog {
  readonly discovery = 'automatic';
  readonly #models: readonly ModelInfo[] = ['fake-model', 'fake-model-2'].map((id) => ({
    id,
    efforts: [],
    local: false,
  }));

  list(): Promise<readonly ModelInfo[]> {
    return Promise.resolve(this.#models);
  }

  suggest(): Partial<ExecutorDraft> {
    return {};
  }

  validate(executor: Executor): Promise<ValidationResult> {
    const found = this.#models.some((model) => model.id === executor.model);
    return Promise.resolve({
      ok: found,
      issues: found
        ? []
        : [{ code: 'model_not_found', severity: 'error', message: `no model ${executor.model}` }],
    });
  }
}

export interface FakeClientAdapterOptions extends ClientAdapterOptions {
  /** What starts the client: for the end-to-end tests, `process.execPath` and the `cli.js` of the fake agent. */
  readonly command: { readonly cmd: string; readonly args: readonly string[] };
  /** Default `fake`. */
  readonly id?: string;
  /**
   * What `profileEnv` adds to the environment. Default: nothing. A function is asked on every
   * open, so a test can make the environment depend on something that changes (as OpenCode's
   * permission rules do).
   */
  readonly env?:
    Readonly<Record<string, string>> | ((profile: Profile) => Readonly<Record<string, string>>);
  /** What `extensions()` answers. Default: none. */
  readonly extensions?: readonly AcpExtensionHandler[];
  /** What the client guarantees by itself. Default: `client` for every field. */
  readonly enforcement?: Enforcement;
  /** Probes of this client, besides the common ones. Default: none. */
  readonly probes?: readonly ConformanceProbe[];
  /** Overrides of what the client announces. Default: it can load a session, nothing else. */
  readonly capabilities?: Partial<ClientCapabilities>;
  readonly processModel?: ProcessModel;
  /** What `models` is. Default: a {@link FakeModelCatalog} (`fake-model`, `fake-model-2`). */
  readonly models?: ModelCatalog;
  /** Called by `prepareProfile`, to see what the base asked for. */
  readonly onPrepareProfile?: (profile: Profile, policy: RolePolicy) => void;
  /** Modes `modeVeto` refuses, each with the reason (a bare list gives a default reason). Default none. */
  readonly vetoedModes?: readonly string[] | Readonly<Record<string, string>>;
  /** Only when this transport asks for it, the veto is on (`modeVeto` receives the transport). Default every transport. */
  readonly vetoVia?: TransportId;
  /**
   * What `probeLogin` answers, per profile id (`profile.id`), or one state for every profile.
   * Default `unknown`. A function is asked on every probe.
   */
  readonly loginState?: LoginState | ((profile: Profile) => LoginState);
  /** Called by `logout`, to see which profile the caller logged out. */
  readonly onLogout?: (profile: Profile) => void;
  /** The config options of the ACP setup of every session (`SessionSetup.configOptions`). Default none. */
  readonly setupConfig?: Readonly<Record<string, string>>;
}

const DEFAULT_ENFORCEMENT = Object.fromEntries(
  ROLE_POLICY_FIELDS.map((field) => [field, ['client']]),
) as unknown as Enforcement;

const TOOL_KIND_SET: ReadonlySet<string> = new Set(TOOL_KINDS);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolKindOf(value: unknown): ToolKind {
  return typeof value === 'string' && TOOL_KIND_SET.has(value) ? (value as ToolKind) : 'other';
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'failed']);

function statusOf(value: unknown): ToolCallStatus | undefined {
  return typeof value === 'string' && STATUSES.has(value) ? (value as ToolCallStatus) : undefined;
}

/**
 * Normalizes the ACP `session/update` payloads the fake agent sends: message and thought chunks,
 * tool calls and their updates, and the list of commands. Anything else is swallowed (`null`). A real client writes its own,
 * with its own quirks; this one is only as much as the fakes and the suites need.
 */
export function normalizeFakeUpdate(raw: RawUpdate): NormalizedUpdate | null {
  const update = record(raw);
  if (update === undefined) return null;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const content = record(update.content);
      if (content?.type !== 'text' || typeof content.text !== 'string') return null;
      return {
        kind: update.sessionUpdate,
        content: { type: 'text', text: content.text },
      };
    }
    case 'tool_call': {
      if (typeof update.toolCallId !== 'string' || typeof update.title !== 'string') return null;
      return {
        kind: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title,
        toolKind: toolKindOf(update.kind),
        status: statusOf(update.status) ?? 'pending',
      };
    }
    case 'tool_call_update': {
      if (typeof update.toolCallId !== 'string') return null;
      const status = statusOf(update.status);
      return {
        kind: 'tool_call_update',
        toolCallId: update.toolCallId,
        ...(status === undefined ? {} : { status }),
      };
    }
    case 'available_commands_update': {
      if (!Array.isArray(update.availableCommands)) return null;
      const commands = (update.availableCommands as unknown[]).flatMap((candidate) => {
        const command = record(candidate);
        if (typeof command?.name !== 'string' || command.name === '') return [];
        return [
          {
            name: command.name,
            description: typeof command.description === 'string' ? command.description : '',
          },
        ];
      });
      return { kind: 'available_commands', commands };
    }
    default:
      return null;
  }
}

/** The code of the JSON-RPC error the fake agent (and `@otheater/protocol`) uses for an exhausted quota. */
const FAKE_QUOTA_CODE = -32001;

/**
 * Normalizes an error of the fake client. The quota is recognised by shape (the code, or
 * `data.type`), because core cannot import `@otheater/protocol`, where `QUOTA_EXHAUSTED_CODE` lives.
 */
export function normalizeFakeError(raw: unknown): NormalizedError {
  const error = record(raw);
  const message = typeof error?.message === 'string' ? error.message : String(raw);
  const data = record(error?.data);
  if (error?.code === FAKE_QUOTA_CODE || data?.type === 'QuotaExhausted') {
    const parsed = typeof data?.resetsAt === 'string' ? Date.parse(data.resetsAt) : Number.NaN;
    return {
      kind: 'quota_exhausted',
      message,
      ...(Number.isNaN(parsed) ? {} : { resetsAt: parsed }),
      limitSource: 'structured',
      cause: raw,
    };
  }
  return { kind: 'unknown', message, cause: raw };
}

/**
 * The `ClientAdapter` of the tests: it speaks to whatever command it is given (the fake agent over
 * ACP, or nothing with a `FakeSessionTransport`), with trivial normalizers. It is a class of
 * `@otheater/core/testing`, not an adapter package: the `adapter-isolation` rule forbids one
 * adapter from importing another, and the `session-acp` tests need this one.
 */
export class FakeClientAdapter extends ClientAdapter {
  readonly id: string;
  readonly processModel: ProcessModel;
  readonly quota: QuotaProbe = new FakeQuotaProbe();
  readonly models: ModelCatalog;
  readonly capabilities: ClientCapabilities;
  /** Profiles the base asked to prepare, in order. */
  readonly prepared: Profile[] = [];
  /** Profiles `logout` was called for, in order. */
  readonly loggedOut: Profile[] = [];
  /** The transport the base asked `command` for, in order. */
  readonly commandVia: TransportId[] = [];
  readonly #options: FakeClientAdapterOptions;

  constructor(options: FakeClientAdapterOptions) {
    super(options);
    this.#options = options;
    this.id = options.id ?? 'fake';
    this.processModel = options.processModel ?? 'process-per-session';
    this.models = options.models ?? new FakeModelCatalog();
    this.capabilities = {
      loadSession: true,
      mcpHttp: false,
      configOptions: ['model', 'mode'],
      headless: false,
      extensions: [],
      ...options.capabilities,
    };
  }

  protected command(_profile: Profile, via: TransportId): { cmd: string; args: string[] } {
    this.commandVia.push(via);
    return { cmd: this.#options.command.cmd, args: [...this.#options.command.args] };
  }

  protected profileEnv(profile: Profile): Record<string, string> {
    const env = this.#options.env;
    return { ...(typeof env === 'function' ? env(profile) : env) };
  }

  protected prepareProfile(profile: Profile, policy: RolePolicy): Promise<void> {
    this.prepared.push(profile);
    this.#options.onPrepareProfile?.(profile, policy);
    return Promise.resolve();
  }

  protected sessionSetup(_policy: RolePolicy, via: TransportId): SessionSetup {
    return via === 'headless'
      ? { via: 'headless', args: [], env: {} }
      : { via: 'acp', configOptions: { ...this.#options.setupConfig } };
  }

  protected modeVeto(mode: string, via: TransportId): string | null {
    const vetoed = this.#options.vetoedModes;
    if (vetoed === undefined) return null;
    if (this.#options.vetoVia !== undefined && this.#options.vetoVia !== via) return null;
    if (Array.isArray(vetoed)) return vetoed.includes(mode) ? 'the fake client refuses it' : null;
    const reasons = vetoed as Readonly<Record<string, string>>;
    return Object.hasOwn(reasons, mode) ? (reasons[mode] ?? null) : null;
  }

  protected enforcement(): Enforcement {
    return this.#options.enforcement ?? DEFAULT_ENFORCEMENT;
  }

  protected normalizeUpdate(raw: RawUpdate): NormalizedUpdate | null {
    return normalizeFakeUpdate(raw);
  }

  protected normalizeError(raw: unknown): NormalizedError {
    return normalizeFakeError(raw);
  }

  protected mapConfig(want: ExecutorConfig): Record<string, string> {
    return {
      model: want.model,
      ...(want.mode === undefined ? {} : { mode: want.mode }),
    };
  }

  protected extensions(): AcpExtensionHandler[] {
    return [...(this.#options.extensions ?? [])];
  }

  protected probes(): ConformanceProbe[] {
    return [...(this.#options.probes ?? [])];
  }

  login(): Promise<LoginFlow> {
    return Promise.reject(new AdapterUnavailable('the fake client has no login'));
  }

  logout(profile?: Profile): Promise<void> {
    if (profile !== undefined) {
      this.loggedOut.push(profile);
      this.#options.onLogout?.(profile);
    }
    return Promise.resolve();
  }

  probeLogin(profile: Profile): Promise<LoginProbeResult> {
    const state = this.#options.loginState;
    return Promise.resolve({
      state: typeof state === 'function' ? state(profile) : (state ?? 'unknown'),
      via: 'fake',
    });
  }
}
