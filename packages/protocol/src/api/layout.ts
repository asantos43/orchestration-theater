// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { defineRoute, defineRoutes } from './route.js';

/**
 * Layout preferences (architecture 5.13, decision N170, P12 of the plan docs/17): kept in the
 * daemon, one record per interface, read and written by REST. The record is versioned so an old
 * one is migrated or replaced by the default, never a reason to fail the start.
 */

/** The interfaces that have a layout. */
export const LAYOUT_INTERFACES = ['tui', 'web'] as const;
export type LayoutInterface = (typeof LAYOUT_INTERFACES)[number];
export const LayoutInterfaceSchema = z.enum(LAYOUT_INTERFACES);

/** Where a client keeps its layout (`ui.layout.store`, N170): in the daemon or in a local file. */
export const LAYOUT_STORES = ['daemon', 'local'] as const;
export type LayoutStore = (typeof LAYOUT_STORES)[number];

/**
 * How a client follows a layout another client changed (`ui.layout.sync`, N174, 2026-11-20): `live`
 * applies the `layout.changed` event as it arrives, `on_open` reads the record only when it opens.
 */
export const LAYOUT_SYNCS = ['live', 'on_open'] as const;
export type LayoutSync = (typeof LAYOUT_SYNCS)[number];

/** Version of the record written by this code. */
export const LAYOUT_VERSION = 1;

export const LayoutPreferencesSchema = z.strictObject({
  version: z.literal(LAYOUT_VERSION),
  /** The side bar is a rail with the scenarios. */
  sidebarCollapsed: z.boolean(),
  /** Width of the chat: columns in the `tui`, pixels in the `web`. */
  chatWidth: z.int().min(1).max(10_000),
  /** Ids of the tabs open in the work panel, in order. */
  openTabs: z.array(z.string().min(1).max(64)).max(32),
  /** Ids of the sections and cards that are collapsed. */
  collapsedSections: z.array(z.string().min(1).max(64)).max(128),
});
export type LayoutPreferences = z.infer<typeof LayoutPreferencesSchema>;

/** [proposta] What an interface starts with, when nothing was saved. The ids of the tabs are the client's. */
export function defaultLayout(layoutInterface: LayoutInterface): LayoutPreferences {
  return {
    version: LAYOUT_VERSION,
    sidebarCollapsed: false,
    chatWidth: layoutInterface === 'tui' ? 60 : 480,
    openTabs: ['overview'],
    collapsedSections: [],
  };
}

/**
 * What a record of any age becomes when read (P12 of docs/17). [proposta] The rules, the same in the
 * daemon (the record of the interface) and in the client (the file of the `local` mode):
 * - the current version, valid: kept as it is (`ok`);
 * - an older version: moved up one version at a time by {@link LAYOUT_MIGRATIONS}; if a step is
 *   missing, or the result is not a valid record, the default takes its place (`replaced`);
 * - a newer version (written by a newer program), text that is not JSON, or anything else that does
 *   not fit the schema: the default takes its place, whole. Fields are not salvaged one by one,
 *   because a half-kept record would be a layout nobody ever chose.
 * Nothing here throws: a layout is a preference, and no reason to stop a start.
 */
export const LAYOUT_REPLACE_REASONS = ['old_version', 'newer_version', 'invalid'] as const;
export type LayoutReplaceReason = (typeof LAYOUT_REPLACE_REASONS)[number];

/** One step: the record of version `n` as the record of version `n + 1`. The key is `n`. */
export type LayoutMigrations = Readonly<
  Record<number, (old: Readonly<Record<string, unknown>>) => Record<string, unknown>>
>;

/** The steps that exist. Empty: version 1 is the first, so no older record exists yet. */
export const LAYOUT_MIGRATIONS: LayoutMigrations = {};

export type LayoutReading =
  | { readonly outcome: 'ok'; readonly layout: LayoutPreferences }
  | {
      readonly outcome: 'migrated';
      readonly layout: LayoutPreferences;
      readonly fromVersion: number;
    }
  | {
      readonly outcome: 'replaced';
      /** The default of the interface. */
      readonly layout: LayoutPreferences;
      readonly reason: LayoutReplaceReason;
      /** The version the record had, or `null` when it had none that could be read. */
      readonly fromVersion: number | null;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What {@link moveRecordUp} found. */
export type RecordMove =
  | {
      readonly ok: true;
      readonly record: Record<string, unknown>;
      /** The version the record had. */
      readonly fromVersion: number;
    }
  | {
      readonly ok: false;
      readonly reason: LayoutReplaceReason;
      readonly fromVersion: number | null;
    };

/**
 * Moves a versioned record up to `currentVersion`, one step at a time. The record must be an object
 * with an integer `version` of at least 1; a newer one, or an older one with a missing or failing
 * step, is not moved. The result is not checked against a schema: the caller does that. Separate
 * from {@link readLayout} so the steps can be tested with versions that do not exist yet.
 */
export function moveRecordUp(
  raw: unknown,
  currentVersion: number,
  migrations: LayoutMigrations,
): RecordMove {
  if (!isPlainRecord(raw)) return { ok: false, reason: 'invalid', fromVersion: null };
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'invalid', fromVersion: null };
  }
  if (version > currentVersion) return { ok: false, reason: 'newer_version', fromVersion: version };
  let record: Record<string, unknown> = raw;
  for (let step = version; step < currentVersion; step += 1) {
    const migrate = migrations[step];
    if (migrate === undefined) return { ok: false, reason: 'old_version', fromVersion: version };
    try {
      record = { ...migrate(record), version: step + 1 };
    } catch {
      return { ok: false, reason: 'old_version', fromVersion: version };
    }
  }
  return { ok: true, record, fromVersion: version };
}

/** Reads a parsed record (what `JSON.parse` gave) of an interface. Never throws. */
export function readLayout(
  layoutInterface: LayoutInterface,
  raw: unknown,
  migrations: LayoutMigrations = LAYOUT_MIGRATIONS,
): LayoutReading {
  const replaced = (reason: LayoutReplaceReason, fromVersion: number | null): LayoutReading => ({
    outcome: 'replaced',
    layout: defaultLayout(layoutInterface),
    reason,
    fromVersion,
  });
  const moved = moveRecordUp(raw, LAYOUT_VERSION, migrations);
  if (!moved.ok) return replaced(moved.reason, moved.fromVersion);
  const parsed = LayoutPreferencesSchema.safeParse(moved.record);
  if (!parsed.success) {
    return replaced(
      moved.fromVersion < LAYOUT_VERSION ? 'old_version' : 'invalid',
      moved.fromVersion,
    );
  }
  return moved.fromVersion === LAYOUT_VERSION
    ? { outcome: 'ok', layout: parsed.data }
    : { outcome: 'migrated', layout: parsed.data, fromVersion: moved.fromVersion };
}

/** Like {@link readLayout}, for the text of the record: text that is not JSON is `invalid`. */
export function readLayoutText(
  layoutInterface: LayoutInterface,
  text: string,
  migrations: LayoutMigrations = LAYOUT_MIGRATIONS,
): LayoutReading {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      outcome: 'replaced',
      layout: defaultLayout(layoutInterface),
      reason: 'invalid',
      fromVersion: null,
    };
  }
  return readLayout(layoutInterface, raw, migrations);
}

/**
 * Header of `putLayout` that names the client that writes (N174). [proposta] The daemon copies it
 * into the `origin` of the `layout.changed` event, so a client knows its own echo and ignores it.
 * A header and not a field of the body, because the body is the record and nothing else; printable
 * ASCII with no spaces, 1 to 64 characters, so a random UUID fits.
 */
export const LAYOUT_ORIGIN_HEADER = 'X-OT-Client-Id';
export const LayoutOriginSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x21-\x7e]+$/);

const LayoutParamsSchema = z.strictObject({ interface: LayoutInterfaceSchema });

export const getLayout = defineRoute({
  id: 'getLayout',
  method: 'GET',
  path: '/v1/layout/:interface',
  summary: 'Layout preferences of an interface (the default when none was saved)',
  params: LayoutParamsSchema,
  response: LayoutPreferencesSchema,
});

export const putLayout = defineRoute({
  id: 'putLayout',
  method: 'PUT',
  path: '/v1/layout/:interface',
  summary: 'Replaces the layout preferences of an interface',
  params: LayoutParamsSchema,
  headers: z.looseObject({ 'x-ot-client-id': LayoutOriginSchema.optional() }),
  body: LayoutPreferencesSchema,
  response: LayoutPreferencesSchema,
});

export const LAYOUT_ROUTES = defineRoutes(getLayout, putLayout);
