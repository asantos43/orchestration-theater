// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { request, type RequestOptions } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/**
 * [proposal] The escape script (P5, architecture 5.8): an Executor that tries to leave its
 * confinement, one step per attempt, and says what the system answered. It does NOT guard
 * anything on its side (unlike `edit-file`, which refuses a path outside the cwd before it asks):
 * the point is to see which layer of the daemon stops each attempt, so the steps ask for what a
 * hostile client would ask for.
 *
 * The test never trusts the text the steps report. The ground truth is the disk, the requests a
 * local server received and the events of the daemon; the chunks (`escape <label>: <outcome>`) only
 * make a failure easy to read.
 */
const stepShape = { label: z.string().min(1).optional() };

export const escapeStepSchema = z.discriminatedUnion('kind', [
  /**
   * A native write. `ask` sends `session/request_permission` with kind `edit` and the path as
   * given (not normalised: `<cwd>/../x` stays so, the daemon must resolve it) and writes only if
   * it is allowed. `direct` writes without asking, as a client already in `acceptEdits` does.
   */
  z.strictObject({
    ...stepShape,
    kind: z.literal('write'),
    path: z.string().min(1),
    via: z.enum(['ask', 'direct']).default('ask'),
    content: z.string().default('written by the escape script\n'),
  }),
  /** A direct read (no question asked). */
  z.strictObject({ ...stepShape, kind: z.literal('read'), path: z.string().min(1) }),
  /** Creates a symlink (the agent has the right to, inside its worktree). */
  z.strictObject({
    ...stepShape,
    kind: z.literal('symlink'),
    link: z.string().min(1),
    target: z.string().min(1),
  }),
  /**
   * The native shell of the client: asks permission with kind `execute` and the command, and runs
   * it with `sh -c` only if it is allowed.
   */
  z.strictObject({ ...stepShape, kind: z.literal('native_shell'), command: z.string().min(1) }),
  /** The native web fetch: asks with kind `fetch` and the URL, and fetches only if allowed. */
  z.strictObject({ ...stepShape, kind: z.literal('native_fetch'), url: z.string().min(1) }),
  /** Asks to switch the mode of the session (kind `switch_mode`), the way out of a restricted mode. */
  z.strictObject({
    ...stepShape,
    kind: z.literal('switch_mode'),
    mode: z.string().min(1).default('bypassPermissions'),
  }),
  /**
   * A program the client runs by itself, with nothing asked (the way a client runs its own
   * subprocess): `["sh","-c","touch /x"]`, `["/bin/touch","/x"]`, a chain, a script by path.
   */
  z.strictObject({
    ...stepShape,
    kind: z.literal('spawn'),
    argv: z.array(z.string()).min(1),
  }),
  /** A call of a framework MCP tool, with the arguments given (`restricted_shell`, ...). */
  z.strictObject({
    ...stepShape,
    kind: z.literal('mcp'),
    server: z.string().min(1).default('otheater'),
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.json()).default({}),
  }),
  /** A raw TCP connection to `host:port`, the way a client that ignores the proxy does it. */
  z.strictObject({ ...stepShape, kind: z.literal('connect'), target: z.string().min(1) }),
  /** A GET through the proxy of the environment (`HTTP_PROXY`), which the sandbox sets. */
  z.strictObject({ ...stepShape, kind: z.literal('proxy_get'), url: z.string().min(1) }),
  /** A GET straight to the URL, with no proxy. */
  z.strictObject({ ...stepShape, kind: z.literal('direct_get'), url: z.string().min(1) }),
]);
export type EscapeStep = z.infer<typeof escapeStepSchema>;

export const escapeScriptSchema = z.strictObject({
  name: z.literal('escape'),
  steps: z.array(escapeStepSchema).min(1),
});
export type EscapeScript = z.infer<typeof escapeScriptSchema>;

/** What the escape script needs from the fake agent: the ACP side stays in `agent.ts`. */
export interface EscapeHost {
  readonly cwd: string;
  readonly signal: AbortSignal;
  say(text: string): Promise<void>;
  /** Asks permission for a tool call; says what the client answered. */
  ask(request: {
    readonly kind: 'edit' | 'execute' | 'fetch' | 'switch_mode';
    readonly title: string;
    readonly locations?: readonly string[];
    readonly rawInput?: Readonly<Record<string, unknown>>;
  }): Promise<'allowed' | 'rejected' | 'cancelled'>;
  /** A tool of an MCP server of the session, reported as a tool call. */
  callTool(
    server: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly isError: boolean; readonly text: string } | undefined>;
  /** One raw TCP connection: `ok` or `failed <code>`. */
  tryConnect(target: string): Promise<string>;
}

const errorCode = (error: unknown): string =>
  `failed ${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))}`;

const oneLine = (text: string, max = 240): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

/** A path as a client would send it: absolute, but not normalised (`..` stays for the daemon). */
const asSent = (cwd: string, path: string): string =>
  isAbsolute(path) ? path : `${cwd.replace(/\/+$/, '')}/${path}`;

/** Runs a program with no shell and says how it ended and what it wrote on stderr. */
function runProgram(argv: readonly string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((done) => {
    const [program, ...args] = argv;
    if (program === undefined) {
      done('failed EMPTY');
      return;
    }
    let output = '';
    let child;
    try {
      child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
    } catch (error) {
      done(errorCode(error));
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('error', (error) => {
      clearTimeout(timer);
      done(errorCode(error));
    });
    child.once('close', (code, killed) => {
      clearTimeout(timer);
      done(`exit ${String(code ?? killed)} ${oneLine(output)}`.trimEnd());
    });
  });
}

/** A GET with `node:http`, optionally through the proxy of the environment. */
function httpGet(url: string, viaProxy: boolean): Promise<string> {
  return new Promise((done) => {
    const target = new URL(url);
    const proxyUrl = process.env.HTTP_PROXY ?? process.env.http_proxy;
    let options: RequestOptions;
    if (viaProxy) {
      if (proxyUrl === undefined || proxyUrl === '') {
        done('failed NO_PROXY_IN_ENV');
        return;
      }
      const proxy = new URL(proxyUrl);
      options = {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        path: url,
        headers: { host: target.host },
        timeout: 8000,
      };
    } else {
      options = {
        host: target.hostname,
        port: Number(target.port || 80),
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        timeout: 8000,
      };
    }
    const req = request(options, (response) => {
      response.resume();
      response.once('end', () => {
        const status = response.statusCode ?? 0;
        done(status >= 200 && status < 400 ? `ok ${String(status)}` : `denied ${String(status)}`);
      });
    });
    req.once('timeout', () => {
      req.destroy();
      done('failed ETIMEDOUT');
    });
    req.once('error', (error) => {
      done(errorCode(error));
    });
    req.end();
  });
}

async function runStep(host: EscapeHost, step: EscapeStep): Promise<string> {
  switch (step.kind) {
    case 'write': {
      const path = asSent(host.cwd, step.path);
      if (step.via === 'ask') {
        const answer = await host.ask({
          kind: 'edit',
          title: `Write ${step.path}`,
          locations: [path],
        });
        if (answer !== 'allowed') return `asked ${answer}`;
      }
      return writeFile(path, step.content).then(() => 'ok', errorCode);
    }
    case 'read':
      return readFile(asSent(host.cwd, step.path)).then(
        (bytes) => `ok ${String(bytes.length)} bytes`,
        errorCode,
      );
    case 'symlink':
      return symlink(step.target, resolve(host.cwd, step.link)).then(() => 'ok', errorCode);
    case 'native_shell': {
      const answer = await host.ask({
        kind: 'execute',
        title: step.command,
        rawInput: { command: step.command },
      });
      if (answer !== 'allowed') return `asked ${answer}`;
      return runProgram(['sh', '-c', step.command], host.cwd, host.signal);
    }
    case 'native_fetch': {
      const answer = await host.ask({
        kind: 'fetch',
        title: `Fetch ${step.url}`,
        rawInput: { url: step.url },
      });
      if (answer !== 'allowed') return `asked ${answer}`;
      return httpGet(step.url, false);
    }
    case 'switch_mode': {
      const answer = await host.ask({
        kind: 'switch_mode',
        title: `Switch to ${step.mode}`,
        rawInput: { mode: step.mode },
      });
      return `asked ${answer}`;
    }
    case 'spawn':
      return runProgram(step.argv, host.cwd, host.signal);
    case 'mcp': {
      const outcome = await host.callTool(step.server, step.tool, step.arguments);
      if (outcome === undefined) return 'failed NO_SERVER';
      return `${outcome.isError ? 'error' : 'ok'} ${oneLine(outcome.text)}`;
    }
    case 'connect':
      return host.tryConnect(step.target);
    case 'proxy_get':
      return httpGet(step.url, true);
    case 'direct_get':
      return httpGet(step.url, false);
  }
}

function describe(step: EscapeStep, index: number): string {
  if (step.label !== undefined) return step.label;
  return `${String(index + 1)} ${step.kind}`;
}

/**
 * Plays the steps in order, whatever one of them gives: an attempt that fails does not end the
 * script, because the test wants the answer to each. One chunk per step: `escape <label>: <outcome>`.
 */
export async function playEscape(host: EscapeHost, script: EscapeScript): Promise<void> {
  for (const [index, step] of script.steps.entries()) {
    if (host.signal.aborted) return;
    let outcome: string;
    try {
      outcome = await runStep(host, step);
    } catch (error) {
      outcome = errorCode(error);
    }
    await host.say(`escape ${describe(step, index)}: ${outcome}`);
  }
}
