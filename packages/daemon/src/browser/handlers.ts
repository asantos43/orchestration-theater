// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  NotFound,
  PermissionDenied,
  Transient,
  type BrowserPageState,
  type BrowserScope,
  type BrowserSession,
  type JsonObject,
  type SideEffectRecord,
} from '@otheater/core';
import { buildDaemonEvent, type BrowserAction } from '@otheater/protocol';
import type { BrowserConfig } from '../config.js';
import {
  ToolFailure,
  ToolWithImage,
  type ToolCall,
  type ToolHandler,
  type ToolHandlers,
} from '../mcp/handlers.js';
import { ToolRefusal, ToolsContext, ToolTimeout, type ToolsDeps } from '../tools/index.js';
import type { ToolDone } from '../tools/context.js';
import { runEffect, type EffectVerdict } from '../workspace/effects.js';
import { stepFor, stepsOf } from '../workspace/steps.js';
import { WriteApprovals, type AskApproval } from './approval.js';
import { FileOrigin, type FileRefusal, type IsSecretPath } from './file-origin.js';
import { makeGuard, parseOpenUrl, type GuardRefusal } from './guard.js';
import { effectiveProfile, resolveBrowserSettings, type BrowserSettings } from './settings.js';

/** What the browser tools need of the daemon, over the work tools' own (`ToolsDeps`). */
export interface BrowserToolsDeps extends ToolsDeps {
  /** The global `browser` block; a project and a scenario override part of it per call. */
  readonly browser: BrowserConfig;
  readonly session: BrowserSession;
  /** Screenshots go under `<dataDir>/browser/<scenario>/`. */
  readonly dataDir: string;
  /** The chat prompt queue of the Producer; `undefined`: no approval can be asked (it is refused). */
  readonly askApproval?: AskApproval | undefined;
  /**
   * Says whether a path is on `security.secret_paths` (P4). `undefined` until that module lands:
   * `file_urls: except_secrets` then opens no file at all (fail closed).
   */
  readonly isSecret?: IsSecretPath | undefined;
}

export const BROWSER_TOOL_NAMES = [
  'browser_open',
  'browser_read',
  'browser_screenshot',
  'browser_click',
  'browser_fill',
  'browser_press_key',
] as const;

/** The tools by their name: the action each one is. */
const ACTION_OF: Readonly<Record<(typeof BROWSER_TOOL_NAMES)[number], BrowserAction>> = {
  browser_open: 'open',
  browser_read: 'read',
  browser_screenshot: 'screenshot',
  browser_click: 'click',
  browser_fill: 'fill',
  browser_press_key: 'press_key',
};

interface CallState {
  readonly call: ToolCall;
  readonly callId: string;
  readonly action: BrowserAction;
  readonly scenarioId: string;
  /** The URL the daemon asked the browser to open (`open` only): its refusal is the call's. */
  openingUrl?: string;
  /** The last request the guard refused during the call: why a page did not load. */
  lastRefusal?: GuardRefusal;
  url: string;
  title?: string;
  screenshot?: string;
  idempotencyKey?: string;
  reused?: boolean;
}

interface ScenarioState {
  chain: Promise<unknown>;
  busy: number;
  lastUsed: number;
  last?: CallState;
}

type Event = ReturnType<typeof buildDaemonEvent>;

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}

function domainOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? 'file' : parsed.hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * The six browser tools (architecture 5.19): `browser_open`, `browser_read`, `browser_screenshot`,
 * `browser_click`, `browser_fill`, `browser_press_key`. Each call:
 *
 * 1. is tracked like a work tool (`tool.called` and `tool.finished`, through `ToolsContext.track`);
 * 2. resolves the `browser` settings of its scenario (global, then the origin scenario, then its own);
 * 3. builds the guard of the moment and hands it to the session with every call, so the rule of
 *    now is the rule of the next request, whatever the page was opened under;
 * 4. for a write (`click`, `fill`, `press_key`), asks the Producer when `write_approval` says so,
 *    then runs it as a side effect under the key `<play>:browser_<action>:<attempt>:<step>`;
 * 5. ends with a `browser.action` event (the URL and, when taken, the screenshot), and a
 *    `browser.refused` event when a rule said no.
 *
 * Everything a page said comes out under `untrusted: true`. The page, its cookies and the value
 * of a password field never come out (the adapter drops them).
 */
export class BrowserTools {
  readonly #deps: BrowserToolsDeps;
  readonly #context: ToolsContext;
  readonly #approvals: WriteApprovals;
  readonly #states = new Map<string, ScenarioState>();
  #files: Promise<FileOrigin> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(deps: BrowserToolsDeps) {
    this.#deps = deps;
    this.#context = new ToolsContext(deps);
    this.#approvals = new WriteApprovals(deps.askApproval);
  }

  /** The handlers of the six tools. */
  handlers(): Record<string, ToolHandler> {
    const out: Record<string, ToolHandler> = {};
    for (const name of BROWSER_TOOL_NAMES) {
      out[name] = (call) => this.#handle(name, call);
    }
    return out;
  }

  /** Registers the six tools on `handlers`, skipping a name that already has one. */
  register(handlers: ToolHandlers): this {
    for (const [name, handler] of Object.entries(this.handlers())) {
      if (!handlers.has(name)) handlers.register(name, handler);
    }
    return this;
  }

  /**
   * Closes the page (and, in `per_scenario`, the browser) of every scenario that has not made a
   * call for `browser.idle_close_ms`; 0 never closes. Returns the scenarios it closed.
   */
  async sweep(): Promise<string[]> {
    const idle = this.#deps.browser.idle_close_ms;
    if (idle <= 0) return [];
    const now = this.#deps.clock.now();
    const closed: string[] = [];
    for (const [scenarioId, state] of [...this.#states]) {
      if (state.busy === 0 && now - state.lastUsed >= idle) {
        await this.endScenario(scenarioId);
        closed.push(scenarioId);
      }
    }
    return closed;
  }

  /** Runs {@link sweep} every so often until {@link close}. The timer does not keep the process alive. */
  startIdleLoop(): void {
    const idle = this.#deps.browser.idle_close_ms;
    if (idle <= 0 || this.#timer !== undefined || this.#closed) return;
    const every = Math.max(1000, Math.min(60_000, Math.floor(idle / 4)));
    this.#timer = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.#deps.logger?.warn({ err: error }, 'the browser idle sweep failed');
      });
    }, every);
    this.#timer.unref();
  }

  /** Ends the page of a scenario and takes back what it was allowed (its files, its approvals). */
  async endScenario(scenarioId: string): Promise<void> {
    this.#states.delete(scenarioId);
    this.#approvals.forget(scenarioId);
    const files = await this.#files?.catch(() => undefined);
    files?.revoke(scenarioId);
    await this.#deps.session.closeScenario(scenarioId).catch((error: unknown) => {
      this.#deps.logger?.warn({ err: error, scenarioId }, 'could not close the page of a scenario');
    });
  }

  /**
   * Stops the idle loop and the file origin. The session is the composition's: it closes it.
   * Idempotent; never rejects.
   */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    const files = await this.#files?.catch(() => undefined);
    await files?.stop().catch(() => undefined);
    this.#files = undefined;
  }

  // ---------------------------------------------------------------------------------------------

  #handle(tool: (typeof BROWSER_TOOL_NAMES)[number], call: ToolCall): Promise<unknown> {
    const action = ACTION_OF[tool];
    return this.#context.track(call, this.#summary(action, call.input), (_settings, callId) =>
      this.#run(action, call, callId),
    );
  }

  #summary(action: BrowserAction, input: unknown): string {
    const { url, ref, key } = (input ?? {}) as { url?: string; ref?: string; key?: string };
    switch (action) {
      case 'open':
        return `browser_open ${url ?? ''}`;
      case 'press_key':
        return `browser_press_key ${key ?? ''}`;
      default:
        return ref === undefined ? `browser_${action}` : `browser_${action} ${ref}`;
    }
  }

  #state(scenarioId: string): ScenarioState {
    let state = this.#states.get(scenarioId);
    if (state === undefined) {
      state = { chain: Promise.resolve(), busy: 0, lastUsed: this.#deps.clock.now() };
      this.#states.set(scenarioId, state);
    }
    return state;
  }

  /** One call at a time for a scenario: its page is one, and so are its steps. */
  async #serial<T>(scenarioId: string, work: () => Promise<T>): Promise<T> {
    const state = this.#state(scenarioId);
    state.busy += 1;
    const run = state.chain.then(work, work);
    state.chain = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      state.busy -= 1;
      state.lastUsed = this.#deps.clock.now();
    }
  }

  #fileOrigin(): Promise<FileOrigin> {
    if (this.#closed) {
      return Promise.reject(new ToolFailure('unavailable', 'The browser tools are stopped.'));
    }
    this.#files ??= FileOrigin.start({
      isSecret: this.#deps.isSecret,
      logger: this.#deps.logger,
      onRefused: (refusal) => {
        this.#fileRefused(refusal);
      },
    });
    return this.#files.catch((error: unknown) => {
      this.#files = undefined;
      throw new ToolFailure(
        'unavailable',
        error instanceof Error ? error.message : 'The file origin did not start.',
      );
    });
  }

  async #emit(call: ToolCall, event: Event): Promise<void> {
    try {
      await call.caller.record(event);
    } catch (error) {
      this.#deps.logger?.warn(
        { err: error, tool: call.tool.name },
        'could not record a browser event',
      );
    }
  }

  #fileRefused(refusal: FileRefusal): void {
    const last = this.#states.get(refusal.scenarioId)?.last;
    if (last === undefined) return;
    void this.#emit(
      last.call,
      buildDaemonEvent('browser.refused', {
        kind: 'request',
        scenarioId: refusal.scenarioId,
        url: `file://${refusal.path}`.slice(0, 4096),
        code: refusal.code,
        reason: refusal.reason.slice(0, 1000),
        callId: last.callId,
        ...last.call.caller.correlation,
      }),
    );
  }

  async #run(action: BrowserAction, call: ToolCall, callId: string): Promise<ToolDone> {
    const { clock, store, browser } = this.#deps;
    const { caller } = call;
    const settings = await resolveBrowserSettings(
      browser,
      store,
      caller.attemptId,
      caller.correlation.playId,
    );
    const scenarioId = settings.scenario.id;
    const startedAt = clock.now();
    const ctx: CallState = { call, callId, action, scenarioId, url: '' };
    this.#state(scenarioId).last = ctx;

    let failure: Error | undefined;
    let done: ToolDone | undefined;
    try {
      done = await this.#serial(scenarioId, () => this.#perform(ctx, settings));
    } catch (error) {
      failure = this.#mapError(error, ctx);
    }
    if (failure instanceof ToolRefusal) {
      await this.#emit(
        call,
        buildDaemonEvent('browser.refused', {
          kind: 'call',
          scenarioId,
          url: ctx.url.slice(0, 4096),
          code: failure.code,
          reason: failure.message.slice(0, 1000),
          callId,
          ...caller.correlation,
        }),
      );
    }
    await this.#emit(call, this.#actionEvent(ctx, settings, failure, clock.now() - startedAt));
    if (failure !== undefined) throw failure;
    if (done === undefined)
      throw new ToolFailure('internal_error', 'The browser call gave no result.');
    return done;
  }

  #actionEvent(
    ctx: CallState,
    settings: BrowserSettings,
    failure: unknown,
    durationMs: number,
  ): Event {
    const { call } = ctx;
    const input = (call.input ?? {}) as { ref?: string; key?: string; value?: string };
    return buildDaemonEvent('browser.action', {
      action: ctx.action,
      role: call.caller.role,
      callId: ctx.callId,
      scenarioId: settings.scenario.id,
      url: ctx.url.slice(0, 4096),
      ...(ctx.title === undefined ? {} : { title: ctx.title.slice(0, 500) }),
      outcome: failure === undefined ? 'ok' : failure instanceof ToolRefusal ? 'refused' : 'error',
      ...(failure instanceof ToolFailure ? { errorCode: failure.code } : {}),
      ...(failure !== undefined && !(failure instanceof ToolFailure)
        ? { errorCode: 'internal_error' }
        : {}),
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ...(ctx.action === 'press_key' && input.key !== undefined ? { key: input.key } : {}),
      ...(ctx.action === 'fill' && input.value !== undefined
        ? { valueChars: input.value.length }
        : {}),
      ...(ctx.screenshot === undefined ? {} : { screenshot: ctx.screenshot }),
      ...(ctx.idempotencyKey === undefined ? {} : { idempotencyKey: ctx.idempotencyKey }),
      ...(ctx.reused === undefined ? {} : { reused: ctx.reused }),
      durationMs: Math.max(0, durationMs),
      ...call.caller.correlation,
    });
  }

  /** What the adapter and the rules throw, as the tools' own failures (the stable codes of the agent). */
  #mapError(error: unknown, ctx: CallState): Error {
    if (error instanceof ToolFailure) return error;
    if (error instanceof PermissionDenied) {
      const refusal = ctx.lastRefusal;
      return new ToolRefusal(refusal?.code ?? 'blocked', refusal?.reason ?? error.message);
    }
    if (error instanceof AdapterUnavailable) return new ToolFailure('unavailable', error.message);
    if (error instanceof NotFound) {
      return new ToolFailure(
        'not_found',
        `${error.message} Read the page again (browser_read) and use a ref from that reading.`,
      );
    }
    if (error instanceof Transient) return new ToolTimeout('timeout', error.message);
    if (error instanceof InvalidInput) return new ToolFailure('invalid_input', error.message);
    return error instanceof Error ? error : new Error(String(error));
  }

  async #perform(ctx: CallState, settings: BrowserSettings): Promise<ToolDone> {
    const { session } = this.#deps;
    const { call, action, scenarioId } = ctx;
    const { config, scenario } = settings;

    const profile = effectiveProfile(config);
    const files = await this.#fileOrigin();
    const roots = [scenario.folder, call.caller.worktree].filter(
      (root): root is string => typeof root === 'string' && root !== '',
    );
    files.grant(scenarioId, { mode: config.file_urls, roots });
    const guard = makeGuard(
      { scenarioId, config, networkAllow: call.caller.networkAllow ?? [], files },
      (refusal) => {
        this.#requestRefused(ctx, files, refusal);
      },
    );
    const scope: BrowserScope = { scenarioId, profile, guard };
    const present = (page: BrowserPageState): { url: string; title: string } => ({
      url: files.presentUrl(page.url),
      title: page.title,
    });
    const settle = (page: BrowserPageState): { url: string; title: string } => {
      const shown = present(page);
      ctx.url = shown.url;
      ctx.title = shown.title;
      return shown;
    };

    switch (action) {
      case 'open': {
        const { url: typed } = call.input as { url: string };
        ctx.url = typed;
        const target = parseOpenUrl(typed);
        if (target.kind === 'invalid') throw new ToolRefusal('invalid_url', target.reason);
        let url: string;
        if (target.kind === 'file') {
          if (config.file_urls === 'deny') {
            throw new ToolRefusal(
              'file_urls_denied',
              'browser.file_urls is "deny": no file is opened.',
            );
          }
          const checked = await files.check(scenarioId, target.path);
          if (!checked.ok) {
            if (checked.kind === 'not_found')
              throw new ToolFailure('file_not_found', checked.reason);
            throw new ToolRefusal(checked.code, checked.reason);
          }
          url = files.urlFor(scenarioId, target.path, target.suffix);
        } else {
          url = target.url;
        }
        ctx.openingUrl = url;
        const page = settle(await session.open(scope, url));
        await this.#autoShot(ctx, scope, config.action_screenshots === 'all');
        return { reply: { ...page, untrusted: true }, outcome: 'ok' };
      }
      case 'read': {
        const { ref } = call.input as { ref?: string };
        const read = await session.read(scope, {
          ...(ref === undefined ? {} : { ref }),
          maxChars: config.read_max_chars,
        });
        const page = settle(read);
        const text = files.scrub(read.text);
        const tree = files.scrub(read.tree);
        await this.#autoShot(ctx, scope, config.action_screenshots === 'all');
        return {
          reply: { ...page, text, tree, truncated: read.truncated, untrusted: true },
          outcome: 'ok',
          outputBytes: Buffer.byteLength(text) + Buffer.byteLength(tree),
          truncated: read.truncated,
        };
      }
      case 'screenshot': {
        const { ref } = call.input as { ref?: string };
        const shot = await session.screenshot(scope, ref);
        const page = settle(shot);
        ctx.screenshot = await this.#save(ctx, shot.data);
        const reply = {
          ...page,
          mimeType: shot.mimeType,
          bytes: shot.data.byteLength,
          untrusted: true,
        };
        return {
          reply: new ToolWithImage(reply, {
            mimeType: shot.mimeType,
            data: Buffer.from(shot.data).toString('base64'),
          }),
          outcome: 'ok',
          outputBytes: shot.data.byteLength,
        };
      }
      case 'click':
      case 'fill':
      case 'press_key':
        return await this.#write(ctx, settings, scope, present, settle);
    }
  }

  async #write(
    ctx: CallState,
    settings: BrowserSettings,
    scope: BrowserScope,
    present: (page: BrowserPageState) => { url: string; title: string },
    settle: (page: BrowserPageState) => { url: string; title: string },
  ): Promise<ToolDone> {
    const { session, store } = this.#deps;
    const { call, action, scenarioId, callId } = ctx;
    const { config } = settings;
    const input = call.input as { ref?: string; value?: string; key?: string };

    const before = await session.state(scenarioId).catch(() => undefined);
    if (before === undefined) {
      throw new ToolFailure('no_page', 'No page is open: call browser_open first.');
    }
    const where = present(before);
    ctx.url = where.url;
    ctx.title = where.title;
    const domain = domainOf(where.url);

    const what =
      action === 'click'
        ? `click the element ${input.ref ?? ''}`
        : action === 'fill'
          ? `type ${String(input.value?.length ?? 0)} characters into the element ${input.ref ?? ''}`
          : `press the key ${input.key ?? ''}`;
    if (config.write_approval !== 'never') {
      await this.#approvals.require({
        mode: config.write_approval,
        action,
        scenarioId,
        domain,
        url: where.url,
        what,
        callId,
        correlation: call.caller.correlation,
        emit: (event) => this.#emit(call, event),
      });
    }

    const type = `browser_${action}`;
    const { attemptId } = call.caller;
    const base = `${settings.playId}:${type}:${attemptId}`;
    // What identifies the call across a retry: the action and its target, never what was typed.
    const callHash = sha(
      JSON.stringify([action, input.ref ?? null, input.key ?? null, input.value?.length ?? null]),
    );
    const steps = stepsOf(await store.sideEffects.list({ types: [type], attemptId }), base);
    const step = stepFor(steps, callHash);
    const params: JsonObject = {
      scenarioId,
      domain,
      callHash,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ...(input.key === undefined ? {} : { key: input.key }),
      ...(action === 'fill' ? { valueChars: input.value?.length ?? 0 } : {}),
    };
    const outcome = await runEffect(store.sideEffects, {
      key: `${base}:${String(step)}`,
      type,
      target: domain,
      attemptId,
      params,
      execute: async (key): Promise<JsonObject> => {
        ctx.idempotencyKey = key;
        const page =
          action === 'click'
            ? await session.click(scope, input.ref ?? '')
            : action === 'fill'
              ? await session.fill(scope, input.ref ?? '', input.value ?? '')
              : await session.pressKey(scope, input.key ?? '');
        const shown = settle(page);
        return { url: shown.url, title: shown.title };
      },
      verify: (record: SideEffectRecord): Promise<EffectVerdict> => verifyWrite(record),
    });
    ctx.idempotencyKey = outcome.key;
    if (outcome.kind === 'ambiguous') {
      throw new ToolFailure(
        'ambiguous',
        `An earlier browser_${action} like this one may or may not have happened: ${outcome.reason} ` +
          'Read the page (browser_read) to see where it stands, then call again if it is still needed.',
      );
    }
    ctx.reused = outcome.origin !== 'executed';
    const result = outcome.result;
    const shown = {
      url: typeof result.url === 'string' ? result.url : where.url,
      title: typeof result.title === 'string' ? result.title : where.title,
    };
    ctx.url = shown.url;
    ctx.title = shown.title;
    await this.#autoShot(ctx, scope, config.action_screenshots !== 'none');
    return {
      reply: { ...shown, reused: ctx.reused, untrusted: true },
      outcome: 'ok',
    };
  }

  /** A request of the page the guard refused, as a `browser.refused` event of the call it came in. */
  #requestRefused(ctx: CallState, files: FileOrigin, refusal: GuardRefusal): void {
    ctx.lastRefusal = refusal;
    // The page the agent asked `open` for is refused as the call itself, once.
    if (ctx.action === 'open' && refusal.url === ctx.openingUrl) return;
    void this.#emit(
      ctx.call,
      buildDaemonEvent('browser.refused', {
        kind: 'request',
        scenarioId: ctx.scenarioId,
        url: files.presentUrl(refusal.url).slice(0, 4096),
        code: refusal.code,
        reason: refusal.reason.slice(0, 1000),
        callId: ctx.callId,
        ...ctx.call.caller.correlation,
      }),
    );
  }

  /** A screenshot after the action, best effort: a call is not failed for a picture. */
  async #autoShot(ctx: CallState, scope: BrowserScope, wanted: boolean): Promise<void> {
    if (!wanted) return;
    try {
      const shot = await this.#deps.session.screenshot(scope);
      ctx.screenshot = await this.#save(ctx, shot.data);
    } catch (error) {
      this.#deps.logger?.warn(
        { err: error, tool: ctx.call.tool.name },
        'no screenshot after a browser action',
      );
    }
  }

  /** Writes a screenshot under the data directory; returns its path relative to it. */
  async #save(ctx: CallState, data: Uint8Array): Promise<string> {
    const relative = join(
      'browser',
      safeName(ctx.scenarioId),
      `${String(this.#deps.clock.now())}-${ctx.callId.slice(0, 8)}-${ctx.action}.png`,
    );
    const path = join(this.#deps.dataDir, relative);
    await mkdir(join(this.#deps.dataDir, 'browser', safeName(ctx.scenarioId)), { recursive: true });
    await writeFile(path, data);
    return relative;
  }
}

/**
 * What a write of the browser leaves to a verifier: nothing it can read back (a click has no
 * trace of its own). [proposta] The first time a step is met open (`pending`: the daemon stopped
 * in the middle of it) it says `ambiguous`, so the agent is told and looks at the page; the next
 * call of the same step (`ambiguous`) says `not_done`, so the agent is not stuck for good. The
 * action is then done again under the next key.
 */
function verifyWrite(record: SideEffectRecord): Promise<EffectVerdict> {
  if (record.state === 'pending') {
    return Promise.resolve({
      verdict: 'ambiguous',
      reason: 'the daemon does not know whether it reached the page.',
    });
  }
  return Promise.resolve({ verdict: 'not_done' });
}
