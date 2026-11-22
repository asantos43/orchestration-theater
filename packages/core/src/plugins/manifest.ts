// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { PLUGIN_EVENT_PREFIX } from '../registries/events.js';
import { EXECUTOR_ROLE_IDS } from '../registries/roles.js';
import { OFFICIAL_TOOLS, TOOL_EFFECT_CLASSES, TOOL_NAME_PATTERN } from '../registries/tools.js';

/**
 * The manifest of a plugin, `plugin.yaml` (architecture 5.14; plan of Phase 9, P3). A plugin is an
 * MCP server plus this manifest, and optionally a declarative panel; no code of the plugin runs in
 * the daemon or in the interface. This module is pure (zod only): the YAML text is read by the
 * caller (the daemon has the `yaml` package, the core does not) and handed over as a value, or as
 * text together with the function that reads it ({@link parsePluginManifestText}).
 *
 * The validator is the one place that says what a valid manifest is, for the daemon (install and
 * activation, P4), the SDK of the plugins (P9) and the flows (P12). The JSON Schema in
 * `docs/reference/plugin-manifest.schema.json` is generated from {@link PluginManifestSchema}
 * (`manifest-schema.ts`) and carries only the structure: the rules that look across fields are the
 * ones of {@link PluginManifestSchema}'s refinement and of {@link parsePluginManifest}.
 */

/** The version of the manifest format (own version, [proposta]). A new shape is a new number. */
export const PLUGIN_MANIFEST_VERSION = 1;

/** The biggest manifest text read, in characters [proposta]: a manifest is a few hundred lines. */
export const PLUGIN_MANIFEST_MAX_CHARS = 256 * 1024;

/**
 * Pattern of a plugin id [proposta]: lowercase, with digits, `_` and `-` (`postgres-db`), no dot.
 * It is the `<id>` of `plugin.<id>.<name>` (events), so it has the shape the event registry
 * accepts there. It is the id pattern of the flows (`FLOW_ID_PATTERN`) widened by the hyphen the
 * example of architecture 5.14 uses, and with no dot, because a dot would blur the event prefix.
 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** Pattern of an event name of the manifest: segments of lowercase, digits, `_` and `-`. */
export const PLUGIN_EVENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;

/** Pattern of a secret: the name of the environment variable the server of the plugin gets. */
export const PLUGIN_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Pattern of an i18n key of the catalog of the plugin (dotted lowercase, `_` and digits). */
export const PLUGIN_I18N_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/** Pattern of a language tag of the catalog: `en`, `pt-BR` (architecture 5.22). */
export const PLUGIN_LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Semantic version 2.0.0, the pattern published on semver.org. */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const idToken = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'must be lowercase letters, digits, "_" or "-"');

// ---------------------------------------------------------------------------------------------
// The server

/** Hostnames the `http` server may use (loopback only; `new URL` has already normalised them). */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname);
}

/** A path inside the folder of the plugin: relative, with no `..` segment, no drive, no `~`. */
function isRelativeInside(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.startsWith('\\') || path.startsWith('~')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(path) || path.includes('\0')) return false;
  return !path.split(/[\\/]/).includes('..');
}

const stdioServer = z.strictObject({
  type: z.literal('stdio'),
  command: z
    .array(z.string().min(1).max(4096))
    .min(1)
    .max(64)
    .describe('The command as an argument list, run with no shell: ["node", "dist/server.js"].'),
  args: z
    .array(z.string().max(4096))
    .max(256)
    .optional()
    .describe('More arguments, appended to the command.'),
  cwd: z
    .string()
    .refine(isRelativeInside, 'must be a relative path inside the folder of the plugin')
    .optional()
    .describe('Working directory, relative to the folder of the plugin (the default).'),
});

const httpServer = z.strictObject({
  type: z.literal('http'),
  url: z
    .string()
    .max(2048)
    .superRefine((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'is not a valid URL' });
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', message: 'must be an http: or https: URL' });
      } else if (!isLoopbackHost(url.hostname)) {
        ctx.addIssue({
          code: 'custom',
          message: `must point to the loopback (localhost, 127.x.x.x or [::1]), not to "${url.hostname}"`,
        });
      }
      if (url.username !== '' || url.password !== '') {
        ctx.addIssue({ code: 'custom', message: 'must not carry a user name or a password' });
      }
    })
    .describe('The Streamable HTTP endpoint of the server, in the loopback only.'),
});

const server = z.discriminatedUnion('type', [stdioServer, httpServer], {
  error: 'server.type must be "stdio" or "http"',
});

// ---------------------------------------------------------------------------------------------
// Tools

const toolDefinition = z.strictObject({
  name: z
    .string()
    .max(64)
    .regex(TOOL_NAME_PATTERN, 'must be lowercase snake case (letters, digits and "_")'),
  roles: z
    .array(z.enum(EXECUTOR_ROLE_IDS))
    .describe('The roles that see the tool; empty when only the panel uses it.'),
  specialties: z.array(idToken).max(32).optional(),
  effects: z
    .enum(TOOL_EFFECT_CLASSES)
    .describe('What the tool changes: read, local_write, network or external_write.'),
  requires_producer_approval: z
    .boolean()
    .default(false)
    .describe('When true, every call waits for the approval of the Producer.'),
  description: z.string().min(1).max(1000).optional(),
});

// ---------------------------------------------------------------------------------------------
// Panel

const i18nKey = z
  .string()
  .max(128)
  .regex(
    PLUGIN_I18N_KEY_PATTERN,
    'screen text is a key of the i18n catalog of the plugin, such as "panel.pending" (lowercase, with "." and "_")',
  );

const panelColumn = z.strictObject({ key: idToken, label: i18nKey });

const blockSource = z
  .string()
  .describe('A tool of this plugin with effects: read; its result fills the block.');

const panelTable = z.strictObject({
  type: z.literal('table'),
  title: i18nKey,
  source: blockSource,
  columns: z.array(panelColumn).min(1).max(32).optional(),
});
const panelList = z.strictObject({ type: z.literal('list'), title: i18nKey, source: blockSource });
const panelMetrics = z.strictObject({
  type: z.literal('metrics'),
  title: i18nKey,
  source: blockSource,
});

const panelAction = z.strictObject({
  type: z.literal('action'),
  label: i18nKey,
  tool: z
    .string()
    .describe('A tool of this plugin; the call follows its requires_producer_approval.'),
});

const panelBlock = z.discriminatedUnion(
  'type',
  [panelTable, panelList, panelMetrics, panelAction],
  { error: 'panel block type must be "table", "list", "metrics" or "action"' },
);

// ---------------------------------------------------------------------------------------------
// Catalog

const catalog = z
  .record(i18nKey, z.string().min(1).max(500))
  .describe('Screen texts by key, with "{{name}}" placeholders where the text has variables.');

const i18n = z
  .object({ en: catalog })
  .catchall(catalog)
  .describe('One catalog per language; "en" is required, and what a language lacks shows in "en".');

// ---------------------------------------------------------------------------------------------
// The manifest

interface RuleIssue {
  readonly path: (string | number)[];
  readonly message: string;
}

const manifestObject = z.strictObject({
  manifest_version: z
    .literal(PLUGIN_MANIFEST_VERSION)
    .describe('The version of this format; the only one is 1.'),
  id: z
    .string()
    .regex(
      PLUGIN_ID_PATTERN,
      'must start with a lowercase letter and have only lowercase letters, digits, "_" or "-" (up to 64)',
    )
    .describe('Plugin id; the events are plugin.<id>.<name>.'),
  version: z
    .string()
    .regex(SEMVER_PATTERN, 'must be a semantic version such as "1.0.0" (write it as a string)'),
  description: z.string().min(1).max(1000).optional(),
  server,
  tools: z.array(toolDefinition).min(1).max(256),
  secrets: z
    .array(
      z
        .string()
        .regex(
          PLUGIN_SECRET_NAME_PATTERN,
          'must be an environment variable name: uppercase letters, digits and "_"',
        ),
    )
    .max(64)
    .default([])
    .describe('Names read from the vault and handed only to the server of the plugin.'),
  events: z
    .array(
      z
        .string()
        .max(64)
        .regex(
          PLUGIN_EVENT_NAME_PATTERN,
          'must be lowercase segments of letters, digits, "_" or "-" separated by "."',
        ),
    )
    .max(64)
    .default([])
    .describe('Event names, with no prefix: the daemon publishes them as plugin.<id>.<name>.'),
  panel: z.array(panelBlock).max(64).default([]),
  i18n: i18n.optional(),
});

/** What the rules that look across fields found, as zod issues at the path of the field. */
function crossRules(manifest: z.output<typeof manifestObject>): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const add = (path: (string | number)[], message: string): void => {
    issues.push({ path, message });
  };

  const tools = new Map<string, { effects: string; index: number }>();
  manifest.tools.forEach((tool, index) => {
    if (tools.has(tool.name)) {
      add(['tools', index, 'name'], `tool "${tool.name}" is declared twice`);
    } else {
      tools.set(tool.name, { effects: tool.effects, index });
    }
    if (new Set(tool.roles).size !== tool.roles.length) {
      add(['tools', index, 'roles'], 'a role is listed twice');
    }
    if (
      tool.specialties !== undefined &&
      new Set(tool.specialties).size !== tool.specialties.length
    ) {
      add(['tools', index, 'specialties'], 'a specialty is listed twice');
    }
  });

  manifest.secrets.forEach((name, index) => {
    if (manifest.secrets.indexOf(name) !== index) {
      add(['secrets', index], `secret "${name}" is declared twice`);
    }
  });

  manifest.events.forEach((name, index) => {
    if (manifest.events.indexOf(name) !== index) {
      add(['events', index], `event "${name}" is declared twice`);
    }
    if (name.startsWith(PLUGIN_EVENT_PREFIX)) {
      add(
        ['events', index],
        `event "${name}" carries the prefix "${PLUGIN_EVENT_PREFIX}": write only the name, the daemon publishes it as ${PLUGIN_EVENT_PREFIX}${manifest.id}.<name>`,
      );
    } else if (`${PLUGIN_EVENT_PREFIX}${manifest.id}.${name}`.length > 128) {
      add(['events', index], `event "${name}" makes a type longer than 128 characters`);
    }
  });

  // The catalogs: "en" is required when the plugin has any screen text; another language only
  // translates keys that "en" has.
  const english = manifest.i18n?.en;
  if (manifest.panel.length > 0 && english === undefined) {
    add(['i18n'], 'a plugin with a panel needs the "en" catalog in "i18n"');
  }
  for (const language of Object.keys(manifest.i18n ?? {})) {
    if (!PLUGIN_LANGUAGE_PATTERN.test(language)) {
      add(['i18n', language], `"${language}" is not a language tag such as "en" or "pt-BR"`);
      continue;
    }
    if (language === 'en' || english === undefined) continue;
    for (const key of Object.keys(manifest.i18n?.[language] ?? {})) {
      if (!(key in english)) {
        add(['i18n', language, key], `key "${key}" is not in the "en" catalog`);
      }
    }
  }

  const screenText = (path: (string | number)[], key: string): void => {
    if (english === undefined || !PLUGIN_I18N_KEY_PATTERN.test(key)) return;
    if (!(key in english)) {
      add(path, `"${key}" is not a key of the "en" catalog (i18n.en)`);
    }
  };

  manifest.panel.forEach((block, index) => {
    if (block.type === 'action') {
      screenText(['panel', index, 'label'], block.label);
      if (!tools.has(block.tool)) {
        add(
          ['panel', index, 'tool'],
          `the action calls "${block.tool}", which is not a tool of this plugin`,
        );
      }
      return;
    }
    screenText(['panel', index, 'title'], block.title);
    if (block.type === 'table') {
      block.columns?.forEach((column, columnIndex) => {
        screenText(['panel', index, 'columns', columnIndex, 'label'], column.label);
      });
    }
    const source = tools.get(block.source);
    if (source === undefined) {
      add(['panel', index, 'source'], `the source "${block.source}" is not a tool of this plugin`);
    } else if (source.effects !== 'read') {
      add(
        ['panel', index, 'source'],
        `the source "${block.source}" must have effects: read, and it has effects: ${source.effects}`,
      );
    }
  });

  return issues;
}

/**
 * The manifest of a plugin, as a zod schema: the structure and every rule that does not depend on
 * what is outside the manifest. [proposta] The rules, each with its test:
 * - the `source` of a block is a tool of the plugin with `effects: read`;
 * - the `tool` of an `action` is a tool of the plugin;
 * - an event name has no `plugin.` prefix, which the daemon adds;
 * - every screen text (`title`, `label`) is a key of the `en` catalog, and another language has
 *   no key that `en` lacks;
 * - names (tools, events, secrets) are not repeated.
 * The one rule that needs the framework's list, no tool named like a framework tool, is applied by
 * {@link parsePluginManifest}.
 */
export const PluginManifestSchema = manifestObject.superRefine((manifest, ctx) => {
  for (const issue of crossRules(manifest)) {
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
});

export type PluginManifest = z.output<typeof PluginManifestSchema>;
export type PluginManifestInput = z.input<typeof PluginManifestSchema>;
export type PluginToolManifest = PluginManifest['tools'][number];
export type PluginPanelBlock = PluginManifest['panel'][number];

/** One thing wrong in a manifest, with the path of the field (`tools[1].effects`). */
export interface PluginManifestProblem {
  /** The path of the field, `tools[1].effects`; empty for the manifest as a whole. */
  readonly path: string;
  readonly message: string;
}

export type PluginManifestResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly problems: readonly PluginManifestProblem[] };

export interface PluginManifestOptions {
  /**
   * The tool names of the framework a plugin tool may not take. Defaults to the names of
   * {@link OFFICIAL_TOOLS}; the daemon passes the names of its frozen registry.
   */
  readonly frameworkToolNames?: Iterable<string> | undefined;
}

/** `tools[1].effects`, `panel[0].columns[2].label`, `i18n.pt-BR.panel.title`. */
export function formatManifestPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${String(part)}]`;
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out;
}

function problemsOf(error: z.ZodError): PluginManifestProblem[] {
  const problems: PluginManifestProblem[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        problems.push({
          path: formatManifestPath([...issue.path, key]),
          message: 'is not a field of the manifest',
        });
      }
    } else {
      problems.push({ path: formatManifestPath(issue.path), message: issue.message });
    }
  }
  return problems;
}

/**
 * Validates a manifest already read from YAML (or built in code). Returns the manifest with the
 * defaults applied, or every problem found, each with the path of its field. Nothing throws.
 */
export function parsePluginManifest(
  input: unknown,
  options: PluginManifestOptions = {},
): PluginManifestResult {
  const parsed = PluginManifestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, problems: problemsOf(parsed.error) };
  const framework = new Set(options.frameworkToolNames ?? OFFICIAL_TOOLS.map((tool) => tool.name));
  const problems: PluginManifestProblem[] = [];
  parsed.data.tools.forEach((tool, index) => {
    if (framework.has(tool.name)) {
      problems.push({
        path: formatManifestPath(['tools', index, 'name']),
        message: `"${tool.name}" is the name of a tool of the framework: choose another name`,
      });
    }
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, manifest: parsed.data };
}

/**
 * Validates the text of a `plugin.yaml`. `parseYaml` is the YAML reader of the caller (the
 * `parse` of the `yaml` package): the core does not carry it. A reader that throws, or text that
 * is too big, comes back as a problem of the manifest as a whole.
 */
export function parsePluginManifestText(
  text: string,
  parseYaml: (text: string) => unknown,
  options: PluginManifestOptions = {},
): PluginManifestResult {
  if (text.length > PLUGIN_MANIFEST_MAX_CHARS) {
    return {
      ok: false,
      problems: [
        {
          path: '',
          message: `the manifest has more than ${String(PLUGIN_MANIFEST_MAX_CHARS)} characters`,
        },
      ],
    };
  }
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [{ path: '', message: `it is not valid YAML: ${reason}` }] };
  }
  return parsePluginManifest(value, options);
}

/** The problems as lines, `tools[1].effects: message`, for an error message or a log. */
export function describeManifestProblems(problems: readonly PluginManifestProblem[]): string {
  return problems
    .map((problem) =>
      problem.path === '' ? problem.message : `${problem.path}: ${problem.message}`,
    )
    .join('\n');
}
