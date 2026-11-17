// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, InvalidInput, NotFound } from '../errors.js';
import { ManagedAgentSession, type SessionDriver } from '../managed-agent-session.js';
import type { ConfigValue, ContentBlock, StopReason } from '../normalized-update.js';
import type {
  AgentInfo,
  AgentSession,
  PermissionAnswer,
  PermissionRequest,
  SessionConfigOption,
  SessionLoadParams,
  SessionOpenParams,
  SessionTransport,
} from '../ports/agent-session.js';

/** What the fake client announces for each config option (the same ones as `@otheater/fake-agent`). */
const FAKE_CONFIG_SPEC = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    values: ['fake-model', 'fake-model-2'],
    initial: 'fake-model',
  },
  { id: 'mode', name: 'Mode', category: 'mode', values: ['default', 'plan'], initial: 'default' },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    values: ['low', 'medium', 'high'],
    initial: 'medium',
  },
] as const;

/** Config options the fake client offers and the values each accepts. */
export const FAKE_CONFIG_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  FAKE_CONFIG_SPEC.map((option) => [option.id, option.values]),
);

/** The options the fake client announces for a session whose chosen values are `chosen`. */
function fakeConfigOptions(chosen: ReadonlyMap<string, string>): SessionConfigOption[] {
  return FAKE_CONFIG_SPEC.map((option) => ({
    id: option.id,
    name: option.name,
    category: option.category,
    type: 'select' as const,
    currentValue: chosen.get(option.id) ?? option.initial,
    options: option.values.map((value) => ({ value, name: value })),
  }));
}

export interface FakeSessionTransportOptions {
  /** Default `fake`. */
  readonly id?: string;
  /** The sessions it opens can be reloaded. Default true. */
  readonly canLoad?: boolean;
  /** What the fake client says about itself at `open` and `load` (the `agentInfo` of an ACP `initialize`). Default: nothing. */
  readonly agentInfo?: AgentInfo;
  /**
   * Each `setConfig` makes the client send an `available_commands_update`, the way the fake agent
   * does with `updatesOnConfig` (`@otheater/fake-agent`). Default false: nothing outside a turn.
   */
  readonly updatesOnConfig?: boolean;
}

/** The directive of a prompt: `#script:<name>[ <json>]` on the first line, as in `@otheater/fake-agent`. */
interface Directive {
  readonly name: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly text: string;
}

function parseDirective(blocks: readonly ContentBlock[]): Directive {
  const raw = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
  const match = /^#script:(\S+)[ \t]*(.*)(?:\r?\n|$)/.exec(raw);
  if (match?.[1] === undefined) return { name: 'echo', options: {}, text: raw };
  let options: Record<string, unknown> = {};
  if ((match[2] ?? '') !== '') {
    try {
      options = JSON.parse(match[2] ?? '') as Record<string, unknown>;
    } catch {
      throw new InvalidInput('the script options are not valid JSON');
    }
  }
  return { name: match[1], options, text: raw.slice(match[0].length) };
}

/** An in-memory client turn: what the scripts of `@otheater/fake-agent` do, without a process. */
class FakeDriver implements SessionDriver {
  readonly #transport: FakeSessionTransport;
  readonly #params: SessionOpenParams;
  readonly #config = new Map<string, string>();
  #deliver: (raw: unknown) => void = () => undefined;
  #cancel: AbortController | undefined;
  #disconnected = new AbortController();
  #toolCalls = 0;

  constructor(transport: FakeSessionTransport, params: SessionOpenParams) {
    this.#transport = transport;
    this.#params = params;
  }

  bind(deliver: (raw: unknown) => void): void {
    this.#deliver = deliver;
  }

  async runTurn(blocks: readonly ContentBlock[]): Promise<StopReason> {
    const directive = parseDirective(blocks);
    const cancel = new AbortController();
    this.#cancel = cancel;
    const signal = AbortSignal.any([cancel.signal, this.#disconnected.signal]);
    try {
      return await this.#play(directive, signal);
    } finally {
      this.#cancel = undefined;
    }
  }

  requestCancel(): Promise<void> {
    this.#cancel?.abort();
    return Promise.resolve();
  }

  applyConfig(id: string, value: ConfigValue): Promise<SessionConfigOption[]> {
    const values = FAKE_CONFIG_OPTIONS[id];
    if (values === undefined)
      return Promise.reject(new InvalidInput(`unknown config option: ${id}`));
    if (typeof value !== 'string' || !values.includes(value)) {
      return Promise.reject(new InvalidInput(`invalid value for ${id}: ${String(value)}`));
    }
    this.#config.set(id, value);
    this.#transport.configApplied.push({ id, value });
    if (this.#transport.updatesOnConfig) {
      this.#deliver({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'fake-command', description: 'Announced during the setup' }],
      });
    }
    return Promise.resolve(fakeConfigOptions(this.#config));
  }

  disconnect(): void {
    this.#disconnected.abort();
  }

  #message(text: string): void {
    this.#deliver({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  }

  #nextToolCallId(): string {
    this.#toolCalls += 1;
    return `call-${String(this.#toolCalls)}`;
  }

  async #play(directive: Directive, signal: AbortSignal): Promise<StopReason> {
    switch (directive.name) {
      case 'echo':
        for (const word of directive.text.match(/\S+\s*|\s+/g) ?? []) {
          if (signal.aborted) return 'cancelled';
          this.#message(word);
        }
        return signal.aborted ? 'cancelled' : 'end_turn';
      case 'tool-call': {
        const toolCallId = this.#nextToolCallId();
        this.#deliver({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Fake tool call',
          kind: 'other',
          status: 'in_progress',
        });
        this.#deliver({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
        return 'end_turn';
      }
      case 'edit-file': {
        const toolCallId = this.#nextToolCallId();
        const path =
          typeof directive.options.path === 'string'
            ? directive.options.path
            : 'fake-agent-output.txt';
        const title = `Write ${path}`;
        this.#deliver({
          sessionUpdate: 'tool_call',
          toolCallId,
          title,
          kind: 'edit',
          status: 'pending',
        });
        const request: PermissionRequest = {
          toolCallId,
          title,
          toolKind: 'edit',
          toolName: 'Write',
          locations: [path],
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        };
        const answer: PermissionAnswer = this.#params.onPermission(request);
        this.#transport.permissionRequests.push(request);
        this.#transport.permissionAnswers.push(answer);
        if (answer.outcome === 'cancelled') {
          this.#deliver({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
          return 'cancelled';
        }
        const allowed =
          request.options
            .find((option) => option.optionId === answer.optionId)
            ?.kind.startsWith('allow') === true;
        if (allowed) this.#transport.edits.push(path);
        this.#deliver({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: allowed ? 'completed' : 'failed',
        });
        return 'end_turn';
      }
      case 'write-file': {
        // As `edit-file`, but no permission request: the client's mode already allows the edit.
        const toolCallId = this.#nextToolCallId();
        const path =
          typeof directive.options.path === 'string'
            ? directive.options.path
            : 'fake-agent-output.txt';
        this.#deliver({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: `Write ${path}`,
          kind: 'edit',
          status: 'in_progress',
        });
        if (signal.aborted) {
          this.#deliver({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
          return 'cancelled';
        }
        this.#transport.edits.push(path);
        this.#deliver({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
        return 'end_turn';
      }
      case 'fail':
        throw new Error('fake-agent scripted failure');
      case 'hang':
        this.#message('hanging until session/cancel');
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
        });
        if (this.#disconnected.signal.aborted)
          throw new AdapterUnavailable('the connection to the client closed');
        return 'cancelled';
      case 'deaf':
        // A client that ignores `session/cancel`: only the end of the connection ends the turn.
        this.#message('ignoring session/cancel');
        await new Promise<void>((resolve) => {
          if (this.#disconnected.signal.aborted) resolve();
          else
            this.#disconnected.signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
        });
        throw new AdapterUnavailable('the connection to the client closed');
      case 'quota-signal':
        throw Object.assign(new Error('quota exhausted'), {
          code: -32001,
          data: { type: 'QuotaExhausted' },
        });
      default:
        throw new InvalidInput(`unknown script: ${directive.name}`);
    }
  }
}

/**
 * A `SessionTransport` with no wire and no process: the session it returns plays the same scripts
 * as `@otheater/fake-agent` (`#script:echo|tool-call|edit-file|write-file|fail|hang|deaf|quota-signal`; `deaf` ignores `session/cancel`) in memory,
 * on the common `ManagedAgentSession`. It records what the `ClientAdapter` handed it, so a test of
 * the adapter (or of a session pool, P8) sees the process, the setup and the permission answers.
 */
export class FakeSessionTransport implements SessionTransport {
  readonly id: string;
  /** Each `setConfig` is followed by an `available_commands_update` of the client. */
  readonly updatesOnConfig: boolean;
  /** What `openSession` handed over, in order. */
  readonly opened: SessionOpenParams[] = [];
  /** What `loadSession` handed over, in order. */
  readonly loaded: SessionLoadParams[] = [];
  /** Every permission request the scripts made, and the answer the adapter gave. */
  readonly permissionRequests: PermissionRequest[] = [];
  readonly permissionAnswers: PermissionAnswer[] = [];
  /** Paths the `edit-file` and `write-file` scripts would have written (they write nothing): for `edit-file` only when the permission was granted. */
  readonly edits: string[] = [];
  /** Config options applied with `setConfig`. */
  readonly configApplied: { id: string; value: ConfigValue }[] = [];
  /** When set, `open` and `load` reject with it. */
  failWith: Error | undefined;
  /** What `open` and `load` report through `onAgentInfo`; a test may change it between sessions. `undefined` says nothing. */
  agentInfo: AgentInfo | undefined;
  readonly #canLoad: boolean;
  #created = 0;

  constructor(options: FakeSessionTransportOptions = {}) {
    this.id = options.id ?? 'fake';
    this.updatesOnConfig = options.updatesOnConfig ?? false;
    this.#canLoad = options.canLoad ?? true;
    this.agentInfo = options.agentInfo;
  }

  open(params: SessionOpenParams): Promise<AgentSession> {
    this.opened.push(params);
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    if (this.agentInfo !== undefined) params.onAgentInfo?.(this.agentInfo);
    this.#created += 1;
    return Promise.resolve(this.#session(params, `fake-session-${String(this.#created)}`));
  }

  load(params: SessionLoadParams): Promise<AgentSession> {
    this.loaded.push(params);
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    if (!this.#canLoad) {
      return Promise.reject(new AdapterUnavailable('this transport cannot load a session'));
    }
    if (!params.sessionId.startsWith('fake-session-')) {
      return Promise.reject(new NotFound(`the client has no conversation ${params.sessionId}`));
    }
    if (this.agentInfo !== undefined) params.onAgentInfo?.(this.agentInfo);
    return Promise.resolve(this.#session(params, params.sessionId));
  }

  #session(params: SessionOpenParams, sessionId: string): AgentSession {
    const driver = new FakeDriver(this, params);
    const session = new ManagedAgentSession({
      sessionId,
      canLoad: this.#canLoad,
      configOptions: fakeConfigOptions(new Map()),
      driver,
      process: params.process,
      normalizer: params.normalizer,
      cancelGraceMs: 50,
    });
    driver.bind((raw) => {
      session.deliver(raw);
    });
    return session;
  }
}
