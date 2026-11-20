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
  body: LayoutPreferencesSchema,
  response: LayoutPreferencesSchema,
});

export const LAYOUT_ROUTES = defineRoutes(getLayout, putLayout);
