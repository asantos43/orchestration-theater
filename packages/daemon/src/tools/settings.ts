// SPDX-License-Identifier: MPL-2.0
import { splitCommandLine, TRUNCATE_MODES, type JsonObject, type Store } from '@otheater/core';
import { z } from 'zod';
import {
  AllowlistEntrySchema,
  EFFECT_OPEN_COMMAND_MODES,
  EFFECT_RECORD_MODES,
  EFFECT_REPLAY_MODES,
  HEAVY_TOOL_NAMES,
  HTTP_REDIRECT_MODES,
  SHELL_ALLOWLIST_MODES,
  ToolCommandSchema,
  ToolsConfigSchema,
  type ToolCommand,
  type ToolsConfig,
} from '../config.js';
import { ToolFailure } from '../mcp/handlers.js';

/**
 * What a project or a scenario may override of `tools` (architecture 5.8, N97 and N98). Every key
 * of the block but the environment: what a command inherits from the daemon is the owner's call
 * (`tools.env_inherit`, `tools.env_allow`), and a scenario must not widen it. An unknown key is
 * refused, as in the global config.
 */
export const ToolsOverrideSchema = z.strictObject({
  shell_allowlist: z
    .strictObject({
      mode: z.enum(SHELL_ALLOWLIST_MODES).optional(),
      list: z.array(AllowlistEntrySchema).optional(),
    })
    .optional(),
  timeout_ms: z.int().min(1).optional(),
  output_max_bytes: z.int().min(1).optional(),
  truncate: z.enum(TRUNCATE_MODES).optional(),
  heavy_concurrency: z.int().min(1).optional(),
  heavy_commands: z.array(z.enum(HEAVY_TOOL_NAMES)).optional(),
  commands: z
    .strictObject({
      test: ToolCommandSchema.optional(),
      install: ToolCommandSchema.optional(),
    })
    .optional(),
  effects: z
    .strictObject({
      mode: z.enum(EFFECT_RECORD_MODES).optional(),
      replay: z.enum(EFFECT_REPLAY_MODES).optional(),
      open_command: z.enum(EFFECT_OPEN_COMMAND_MODES).optional(),
      fingerprint_files: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  http: z
    .strictObject({
      timeout_ms: z.int().min(1).optional(),
      redirects: z.enum(HTTP_REDIRECT_MODES).optional(),
    })
    .optional(),
});
export type ToolsOverride = z.infer<typeof ToolsOverrideSchema>;

export type Plain = Record<string, unknown>;

export function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Objects merge key by key; arrays and scalars of `over` replace those of `base`. */
export function mergeDeep(base: Plain, over: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isPlain(current) && isPlain(value) ? mergeDeep(current, value) : value;
  }
  return out;
}

/**
 * The part of a `configOverride` ({@link ScenarioRecord}) that belongs to one block of the
 * configuration: either a nested object (`tools: {...}`) or dotted keys (`tools.timeout_ms`,
 * `tools.shell_allowlist.mode`), or both (the dotted key wins). Keys that do not start with
 * `block` belong to other blocks and are left alone. [proposta] The two spellings; the scenario
 * record only says "keys overridden for this scenario".
 */
export function blockOverrideOf(configOverride: JsonObject, block: string): Plain {
  let collected: Plain = {};
  const nested = configOverride[block];
  if (nested !== undefined) {
    if (!isPlain(nested)) {
      throw new ToolFailure(
        'invalid_config',
        `The "${block}" override of the scenario is not an object.`,
      );
    }
    collected = nested;
  }
  for (const [key, value] of Object.entries(configOverride)) {
    if (!key.startsWith(`${block}.`)) continue;
    const path = key.slice(block.length + 1).split('.');
    const tree: Plain = {};
    let cursor = tree;
    path.slice(0, -1).forEach((segment) => {
      const next: Plain = {};
      cursor[segment] = next;
      cursor = next;
    });
    cursor[path[path.length - 1] ?? ''] = value;
    collected = mergeDeep(collected, tree);
  }
  return collected;
}

/** The `tools` part of a `configOverride`, validated: see {@link blockOverrideOf}. */
export function toolsOverrideOf(configOverride: JsonObject): ToolsOverride {
  const collected = blockOverrideOf(configOverride, 'tools');
  const parsed = ToolsOverrideSchema.safeParse(collected);
  if (!parsed.success) {
    throw new ToolFailure(
      'invalid_config',
      `The "tools" override of the scenario is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * The commands the conventions of a project name (`scenarios.conventions.commands`): `test`,
 * `install`, `build`, `lint`... each one a line or an argv. [proposta] The shape: P7 fills the
 * conventions when it imports a repository; an entry that is not a command is ignored.
 */
export function conventionCommandsOf(
  conventions: JsonObject | null,
): Readonly<Record<string, ToolCommand>> {
  const commands = conventions?.commands;
  if (!isPlain(commands)) return {};
  const out: Record<string, ToolCommand> = {};
  for (const [name, value] of Object.entries(commands)) {
    const parsed = ToolCommandSchema.safeParse(value);
    if (parsed.success) out[name] = parsed.data;
  }
  return out;
}

/** A command of the project as an argv: a line is split without a shell, an argv is as it is. */
export function commandArgv(command: ToolCommand): string[] {
  return typeof command === 'string' ? splitCommandLine(command) : [...command];
}

/** The settings of one call: the global block with the project and the scenario on top. */
export interface ToolSettings {
  readonly config: ToolsConfig;
  /** `tools.commands` as a project or a scenario wrote it: it beats the conventions. */
  readonly overriddenCommands: Readonly<Partial<Record<'test' | 'install', ToolCommand>>>;
  readonly conventionCommands: Readonly<Record<string, ToolCommand>>;
  /** The scenario of the call, when it has one (the key of its own semaphore). */
  readonly scenarioId: string | undefined;
}

export type ToolSettingsStore = Pick<Store, 'plays' | 'scenarios' | 'attempts'>;

/**
 * The settings in force for one call (N97, N98). Layers, the last one winning: the global block
 * `tools`; the `configOverride` of the scenario the call's scenario was promoted from (the
 * project of a chat); the `configOverride` of the call's own scenario. A call without a play, or a
 * play whose scenario is gone, gets the global block. An override that does not validate refuses
 * the call (`invalid_config`): a broken limit never falls back to a wider one.
 */
export async function resolveToolSettings(
  base: ToolsConfig,
  store: ToolSettingsStore,
  attemptId: string,
  playId: string | undefined,
): Promise<ToolSettings> {
  const effectivePlayId = playId ?? (await store.attempts.get(attemptId))?.playId;
  const play = effectivePlayId === undefined ? undefined : await store.plays.get(effectivePlayId);
  const own = play === undefined ? undefined : await store.scenarios.get(play.scenarioId);
  const origin =
    own?.originScenarioId === null || own === undefined
      ? undefined
      : await store.scenarios.get(own.originScenarioId);

  let merged: Plain = base;
  let overridden: Plain = {};
  for (const scenario of [origin, own]) {
    if (scenario === undefined) continue;
    const override = toolsOverrideOf(scenario.configOverride);
    merged = mergeDeep(merged, override);
    overridden = mergeDeep(overridden, override);
  }
  const checked = ToolsConfigSchema.safeParse(merged);
  if (!checked.success) {
    throw new ToolFailure(
      'invalid_config',
      `The "tools" settings of this scenario are invalid: ${z.prettifyError(checked.error)}`,
    );
  }
  const commands = overridden.commands;
  return {
    config: checked.data,
    overriddenCommands: isPlain(commands) ? commands : {},
    conventionCommands: {
      ...conventionCommandsOf(origin?.conventions ?? null),
      ...conventionCommandsOf(own?.conventions ?? null),
    },
    scenarioId: own?.id,
  };
}

/**
 * The command `run_tests` (`test`) or `install_deps` (`install`) runs, as an argv: the override
 * of the project or of the scenario, then the conventions of the project, then the global
 * `tools.commands`. Never the model: the tools take no command. `undefined` when none is set.
 */
export function configuredCommand(
  settings: ToolSettings,
  name: 'test' | 'install',
): string[] | undefined {
  const chosen =
    settings.overriddenCommands[name] ??
    settings.conventionCommands[name] ??
    settings.config.commands[name];
  return chosen === undefined ? undefined : commandArgv(chosen);
}

/** Every command the project names, as argvs: what the mode `profile` of the allowlist lets run. */
export function profileCommands(settings: ToolSettings): string[][] {
  const all = [
    ...Object.values(settings.conventionCommands),
    ...Object.values(settings.overriddenCommands),
    ...Object.values(settings.config.commands),
  ].filter((command): command is ToolCommand => command !== undefined);
  const out: string[][] = [];
  for (const command of all) {
    try {
      const argv = commandArgv(command);
      if (argv.length > 0) out.push(argv);
    } catch {
      // A line the splitter refuses (an unbalanced quote) is not a command anyone can run.
    }
  }
  return out;
}
