// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { UPDATE_CHANNELS, UPDATE_EVENT_MODES, UPDATE_REASONS } from '../update-events.js';
import { IdempotencyHeadersSchema } from './page.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The search for a new version of OTheater over REST (Phase 10, P7; architecture 5.21). [proposta]
 * `GET /v1/updates` says what the daemon knows (the mode in the file and the one it acts in, the
 * channel, the origin, the version found and whether it is stored and ready); `POST
 * /v1/updates/check` makes a search now instead of waiting for the interval. Applying a version is
 * the next step (P8); nothing here replaces an executable file.
 */

/** `off` is a value of `updates.mode`; it is not an event mode (it never searches). */
export const UPDATE_MODES = ['auto', 'notify', 'check', 'off'] as const;
export const UPDATE_SOURCES = ['github', 'url'] as const;
/** `own`: the executable of OTheater itself (SEA); `checkout`: a source tree run by Node. */
export const UPDATE_INSTALL_KINDS = ['own', 'checkout'] as const;
/** The platforms of the executables of a release (docs/21, "Formato dos artefatos"). */
export const UPDATE_PLATFORMS = ['linux-x64', 'win32-x64', 'darwin-arm64'] as const;
/** Whether the daemon has a public key it can check a manifest with. */
export const UPDATE_KEY_STATES = ['valid', 'placeholder', 'invalid'] as const;
/**
 * What the daemon says about its own state besides the numbers:
 * - `auto_acts_as_notify`: `auto` downloads and checks but does not apply until P8 exists;
 * - `checkout_install`: this is not the daemon's own executable, so it only announces;
 * - `no_public_key`: no valid public key is embedded, so nothing is checked and nothing is searched.
 */
export const UPDATE_NOTES = ['auto_acts_as_notify', 'checkout_install', 'no_public_key'] as const;
/** What the last search ended in. */
export const UPDATE_RESULTS = [
  'up_to_date',
  'found',
  'ready',
  'rejected',
  'skipped',
  'failed',
] as const;

const UpdateVersionSchema = z.string().min(1).max(64);
const TimestampSchema = z.iso.datetime({ offset: true });

export const ApiUpdateStatusSchema = z.strictObject({
  /** `updates.mode`, as written in the configuration. */
  mode: z.enum(UPDATE_MODES),
  /** The mode the daemon acts in (see `notes`); `off` stays `off`. */
  effectiveMode: z.enum([...UPDATE_EVENT_MODES, 'off']),
  channel: z.enum(UPDATE_CHANNELS),
  source: z.enum(UPDATE_SOURCES),
  installKind: z.enum(UPDATE_INSTALL_KINDS),
  currentVersion: UpdateVersionSchema,
  platform: z.string().min(1).max(32),
  keyState: z.enum(UPDATE_KEY_STATES),
  notes: z.array(z.enum(UPDATE_NOTES)),
  /** The last search that ended (any result), or `null` before the first. */
  checkedAt: TimestampSchema.nullable(),
  /** When the next periodic search happens, or `null` (`updates.check_interval: off`, mode `off`). */
  nextCheckAt: TimestampSchema.nullable(),
  lastResult: z.enum(UPDATE_RESULTS).nullable(),
  /** The newest version found whose signature checked, or `null`. */
  found: UpdateVersionSchema.nullable(),
  /** The version stored (size and SHA-256 checked), ready for the apply step, or `null`. */
  ready: UpdateVersionSchema.nullable(),
  /** Why the last search was refused, skipped or failed, or `null`. */
  lastReason: z.enum(UPDATE_REASONS).nullable(),
});
export type ApiUpdateStatus = z.infer<typeof ApiUpdateStatusSchema>;

export const getUpdateStatus = defineRoute({
  id: 'getUpdateStatus',
  method: 'GET',
  path: '/v1/updates',
  summary:
    'What the daemon knows about new versions: the mode, the version found and whether it is ready',
  response: ApiUpdateStatusSchema,
  errors: ['unavailable'],
});

export const checkUpdates = defineRoute({
  id: 'checkUpdates',
  method: 'POST',
  path: '/v1/updates/check',
  summary:
    'Searches for a new version now (the mode `off` answers 409 `conflict`); returns the status after the search',
  headers: IdempotencyHeadersSchema,
  response: ApiUpdateStatusSchema,
  errors: ['conflict', 'unavailable'],
});

export const UPDATE_ROUTES = defineRoutes(getUpdateStatus, checkUpdates);
