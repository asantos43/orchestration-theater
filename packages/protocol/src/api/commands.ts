// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { ScenarioIdSchema } from './ids.js';
import { IdempotencyHeadersSchema } from './page.js';
import { defineRoute, defineRoutes } from './route.js';
import { ScenarioParamsSchema } from './scenarios.js';

/**
 * The `/` commands of the chat (Phase 7, P3; architecture 5.13). [proposta] The daemon keeps a
 * registry of actions; a client (the TUI, the CLI, the web) reads the list that is valid for a
 * scenario and sends the line the Producer typed. Three origins:
 * - `daemon`: an action the daemon runs by itself, with no turn of the Director (`/status`,
 *   `/pause`...);
 * - `template`: a command whose text becomes a message to the Director (the ones that end in
 *   "..."); it is queued like any message of the Producer;
 * - `client`: a command the client of the Director announced (ACP `available_commands_update`),
 *   listed with the prefix of the client (`/claude:compact`) and allowed only outside a turn.
 */

/** Where a command comes from. */
export const SLASH_COMMAND_ORIGINS = ['daemon', 'template', 'client'] as const;
export type SlashCommandOrigin = (typeof SLASH_COMMAND_ORIGINS)[number];

/** How the commands are grouped in a menu. */
export const SLASH_COMMAND_GROUPS = [
  'query',
  'control',
  'session',
  'configure',
  'help',
  'client',
] as const;
export type SlashCommandGroup = (typeof SLASH_COMMAND_GROUPS)[number];

/** The languages of the descriptions. */
export const SLASH_COMMAND_LANGUAGES = ['en', 'pt-BR'] as const;
export type SlashCommandLanguage = (typeof SLASH_COMMAND_LANGUAGES)[number];

/** One command of the list. */
export const ApiSlashCommandSchema = z.strictObject({
  /** `status`; for a client command, `claude:compact`. */
  id: z.string().min(1),
  /** What the Producer types: `/status`, `/claude:compact`. */
  name: z.string().regex(/^\//),
  origin: z.enum(SLASH_COMMAND_ORIGINS),
  group: z.enum(SLASH_COMMAND_GROUPS),
  /** The key of the message catalog the description comes from; empty for a client command. */
  descriptionKey: z.string(),
  /** The description in the language asked for (the client's own text for a client command). */
  description: z.string(),
  /** How the arguments are written (`[n]`, `<text>`); empty when there are none. */
  args: z.string(),
  /** `true`: the command asks for a confirmation (`confirm: true` on the second send). */
  confirm: z.boolean(),
});
export type ApiSlashCommand = z.infer<typeof ApiSlashCommandSchema>;

export const ListSlashCommandsQuerySchema = z.strictObject({
  /** The scenario the list is for. Without it, only the commands that need no scenario. */
  scenario: ScenarioIdSchema.optional(),
  /** The language of the descriptions; absent: `ui.locale` of the daemon. */
  lang: z.enum(SLASH_COMMAND_LANGUAGES).optional(),
});
export type ListSlashCommandsQuery = z.input<typeof ListSlashCommandsQuerySchema>;

export const ListSlashCommandsResultSchema = z.strictObject({
  commands: z.array(ApiSlashCommandSchema),
});
export type ListSlashCommandsResult = z.infer<typeof ListSlashCommandsResultSchema>;

export const listCommands = defineRoute({
  id: 'listCommands',
  method: 'GET',
  path: '/v1/commands',
  summary:
    'The / commands valid for a scenario now, by its type and state, the commands of the client of the Director included',
  query: ListSlashCommandsQuerySchema,
  response: ListSlashCommandsResultSchema,
  errors: ['not_found', 'unavailable'],
});

/**
 * What a command answers:
 * - `done`: it ran; `text` says what happened and `data` carries the values;
 * - `confirm`: it did not run, because it asks for a confirmation; send the same line again with
 *   `confirm: true`;
 * - `forwarded`: the line went to the Director as a message (a template or a client command).
 */
export const SLASH_RESULT_STATUSES = ['done', 'confirm', 'forwarded'] as const;
export type SlashResultStatus = (typeof SLASH_RESULT_STATUSES)[number];

export const SlashCommandResultSchema = z.strictObject({
  status: z.enum(SLASH_RESULT_STATUSES),
  /** The `id` of the command that was run (or that is waiting for the confirmation). */
  command: z.string().min(1),
  /** What to show the Producer, in the language of the daemon. */
  text: z.string(),
  /** The values behind the text, for a client that draws them itself. */
  data: z.json().optional(),
});
export type SlashCommandResult = z.infer<typeof SlashCommandResultSchema>;

/** The line a Producer typed, as the WebSocket and the route carry it. */
export const SLASH_LINE_PATTERN = /^\/\S/;

export const RunSlashCommandBodySchema = z.strictObject({
  /** The whole line, with the slash: `/pause`, `/claude:compact keep the tests`. */
  text: z.string().regex(SLASH_LINE_PATTERN).max(8000),
  /** Confirms a command that asked for it. */
  confirm: z.boolean().optional(),
});
export type RunSlashCommandBody = z.input<typeof RunSlashCommandBodySchema>;

export const runScenarioCommand = defineRoute({
  id: 'runScenarioCommand',
  method: 'POST',
  path: '/v1/scenarios/:scenarioId/commands',
  summary: 'Runs a / command on a scenario; idempotent by Idempotency-Key',
  params: ScenarioParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: RunSlashCommandBodySchema,
  response: SlashCommandResultSchema,
  errors: ['not_found', 'conflict', 'invalid_input', 'forbidden', 'unavailable'],
});

export const SLASH_COMMAND_ROUTES = defineRoutes(listCommands, runScenarioCommand);
