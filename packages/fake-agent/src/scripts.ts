// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Deterministic scripts the fake agent can play. Each script is a plain object validated by zod:
 * `{ name, ...options }`.
 */
export const scriptSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('echo') }),
  z.strictObject({
    name: z.literal('tool-call'),
    title: z.string().default('Fake tool call'),
    output: z.string().default('fake tool output'),
  }),
  z.strictObject({
    name: z.literal('edit-file'),
    path: z.string().min(1).default('fake-agent-output.txt'),
    content: z.string().default('written by fake-agent\n'),
  }),
  /**
   * Like `edit-file`, but writes without asking for permission: what a real client does when its
   * mode already allows the edit (e.g. Claude Code in `acceptEdits`). A policy that rejects asks
   * cannot stop it, so a test that needs a file to land in the worktree uses this one.
   */
  z.strictObject({
    name: z.literal('write-file'),
    path: z.string().min(1).default('fake-agent-output.txt'),
    content: z.string().default('written by fake-agent\n'),
  }),
  z.strictObject({
    name: z.literal('fail'),
    message: z.string().default('fake-agent scripted failure'),
  }),
  /**
   * [proposal] Plays an Executor that uses a framework MCP tool: `initialize`, `tools/list` and,
   * when `tool` is given, `tools/call`, over Streamable HTTP with the URL and the headers the
   * session received in `mcpServers` (`fetch` only, no client package). The names of the listed
   * tools and the reply of the call come back as message chunks (`tools: a, b` and `reply: {...}`).
   */
  z.strictObject({
    name: z.literal('mcp-call'),
    /** Name of the server in the `mcpServers` of the session. */
    server: z.string().min(1).default('otheater'),
    tool: z.string().min(1).optional(),
    arguments: z.record(z.string(), z.json()).default({}),
    /** Skips `tools/list` when false. */
    list: z.boolean().default(true),
  }),
  /**
   * [proposal] Delivers the output of the role: calls a `submit*` tool of the framework server
   * with `output` as the arguments, up to `repeat` times and until a call is accepted (so an
   * invalid `output` plays the retry loop of `limits.submit_retries`). Each reply comes back as a
   * message chunk (`submit 1: {...}`).
   */
  z.strictObject({
    name: z.literal('submit'),
    server: z.string().min(1).default('otheater'),
    tool: z.string().min(1).default('submit'),
    output: z.record(z.string(), z.json()).default({ result: 'done' }),
    repeat: z.int().min(1).max(10).default(1),
  }),
  /**
   * [proposal] Plays every role of a play (architecture 5.4) from the marker lines the daemon puts
   * in its prompts (`#ot-stage:`, `#ot-demand:`, `#ot-judge`, ...) and from `#outcome:<name>` in the
   * need of the play: `approved` (default), `execution_failure`, `script_failure`,
   * `structural_failure`, `exhausted` or `clarify`. No marker means the Director, who reacts to
   * `#ot-play <need>`, `#ot-ask <question>`, `#ot-judge` and `#ot-clarify`. Uses the framework MCP
   * server of the session, so it needs a daemon behind it.
   */
  z.strictObject({
    name: z.literal('role-play'),
    server: z.string().min(1).default('otheater'),
  }),
  /**
   * [proposal] Tries what the sandbox (layer 3) must forbid, and says what the operating system
   * answered, one message chunk per attempt: `probe write <path>: ok | failed <code>`, the same for
   * `read <path>` (`ok <bytes> bytes`) and `connect <host>:<port>` (a raw TCP connection, the way
   * a client that ignores the proxy does it). Nothing is asked of the client: the files and the
   * ports are the test's own.
   */
  z.strictObject({
    name: z.literal('probe'),
    write: z.array(z.string().min(1)).default([]),
    read: z.array(z.string().min(1)).default([]),
    connect: z.array(z.string().min(1)).default([]),
  }),
  z.strictObject({ name: z.literal('hang') }),
  z.strictObject({
    name: z.literal('deaf'),
    /** Also starts a child process (a tool of the turn) and says its pid in a message chunk. */
    child: z.boolean().default(false),
  }),
  z.strictObject({
    name: z.literal('quota-signal'),
    usedPercent: z.number().min(0).max(100).default(100),
    resetsAt: z.string().optional(),
  }),
]);

export type Script = z.infer<typeof scriptSchema>;
export type ScriptName = Script['name'];

export const SCRIPT_NAMES: readonly ScriptName[] = [
  'echo',
  'tool-call',
  'edit-file',
  'write-file',
  'mcp-call',
  'submit',
  'role-play',
  'probe',
  'fail',
  'hang',
  'deaf',
  'quota-signal',
];

/** Thrown when a script spec cannot be parsed or fails validation. */
export class ScriptError extends Error {
  override name = 'ScriptError';
}

function validate(candidate: unknown): Script {
  const result = scriptSchema.safeParse(candidate);
  if (!result.success) {
    throw new ScriptError(`invalid script: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function parseOptions(raw: string): Record<string, unknown> {
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScriptError('invalid script: options must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ScriptError('invalid script: options must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parses a script spec: either a bare name (`edit-file`), a name followed by a JSON object with the
 * options (`edit-file {"path":"a.txt"}`) or a full JSON script (`{"name":"fail"}`).
 */
export function parseScriptSpec(spec: string): Script {
  const trimmed = spec.trim();
  if (trimmed.startsWith('{')) return validate(parseOptions(trimmed));
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (match?.[1] === undefined) throw new ScriptError('invalid script: empty spec');
  return validate({ name: match[1], ...parseOptions(match[2] ?? '') });
}

const DIRECTIVE = /^#script:(.*)(?:\r?\n|$)/;

export interface ParsedPrompt {
  /** The script named by a leading `#script:` directive, if any. */
  script: Script | undefined;
  /** The prompt text without the directive line. */
  text: string;
}

/**
 * [proposal] A prompt selects its script with a first line `#script:<name>[ <json options>]`. The
 * rest of the prompt is the text the script works with (the `echo` script repeats it).
 */
export function parsePrompt(prompt: string): ParsedPrompt {
  const match = DIRECTIVE.exec(prompt);
  if (match?.[1] === undefined) return { script: undefined, text: prompt };
  return { script: parseScriptSpec(match[1]), text: prompt.slice(match[0].length) };
}
