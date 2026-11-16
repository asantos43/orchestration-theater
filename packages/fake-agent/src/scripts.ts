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
  z.strictObject({
    name: z.literal('fail'),
    message: z.string().default('fake-agent scripted failure'),
  }),
  z.strictObject({ name: z.literal('hang') }),
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
  'fail',
  'hang',
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
