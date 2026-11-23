// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { UPDATE_CHANNELS, UPDATE_EVENT_MODES, UPDATE_REASONS } from '../update-events.js';
import { IdempotencyHeadersSchema } from './page.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The search for a new version of OTheater over REST (Phase 10, P7; architecture 5.21). [proposta]
 * `GET /v1/updates` says what the daemon knows (the mode in the file and the one it acts in, the
 * channel, the origin, the version found and whether it is stored and ready); `POST
 * /v1/updates/check` makes a search now instead of waiting for the interval. P8 adds how a version
 * is applied: `apply` in the status says where the daemon is (waiting for a quiet moment, asking the
 * Producer, applying) and `POST /v1/updates/apply` is the Producer's word ("apply now", "park and
 * apply", "wait longer").
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
 * - `checkout_install`: this is not the daemon's own executable, so it only announces;
 * - `no_public_key`: no valid public key is embedded, so nothing is checked and nothing is searched.
 */
export const UPDATE_NOTES = ['checkout_install', 'no_public_key'] as const;
/** What the last search ended in. */
export const UPDATE_RESULTS = [
  'up_to_date',
  'found',
  'ready',
  'rejected',
  'skipped',
  'failed',
] as const;

/** `updates.apply_when` (P8): the moment a version that is ready is put in place. */
export const UPDATE_APPLY_WHEN = ['idle', 'park', 'next_start'] as const;
/** `updates.rollback` (P8): whether a version that does not come up is taken back by the applier. */
export const UPDATE_ROLLBACK_MODES = ['auto', 'off'] as const;
/**
 * `updates.manifest_expiry` (Phase 11, P8a; [proposta]): what the daemon does with the optional
 * `expires` of the signed manifest. `enforce`: an expired manifest is refused, one with no `expires`
 * is accepted with a notice; `require`: one with no `expires` is refused too; `off`: `expires` is
 * ignored.
 */
export const UPDATE_MANIFEST_EXPIRY_MODES = ['enforce', 'require', 'off'] as const;
/**
 * Where the apply step is:
 * - `none`: nothing is waiting to be applied;
 * - `waiting`: `idle`, waiting for the attempts to end (no new work starts meanwhile);
 * - `asked`: the `max_wait` ended and the Producer was asked (park and apply, or wait longer);
 * - `scheduled`: `next_start`, the version waits for the next start of the daemon;
 * - `applying`: the applier took over and the daemon is stopping or already gone.
 */
export const UPDATE_APPLY_STATES = ['none', 'waiting', 'asked', 'scheduled', 'applying'] as const;
/** What the last apply ended in. */
export const UPDATE_APPLY_OUTCOMES = ['applied', 'rolled_back', 'failed'] as const;
/** The answers of `POST /v1/updates/apply`: follow `updates.apply_when`, park and apply, or wait longer. */
export const UPDATE_APPLY_HOWS = ['default', 'park', 'wait'] as const;

const UpdateVersionSchema = z.string().min(1).max(64);
const TimestampSchema = z.iso.datetime({ offset: true });

export const ApiUpdateApplySchema = z.strictObject({
  /** `updates.apply_when`, as written. */
  when: z.enum(UPDATE_APPLY_WHEN),
  rollback: z.enum(UPDATE_ROLLBACK_MODES),
  state: z.enum(UPDATE_APPLY_STATES),
  /** The version that waits or is being applied, or `null`. */
  version: UpdateVersionSchema.nullable(),
  /** Since when `state` is what it is, or `null` for `none`. */
  since: TimestampSchema.nullable(),
  /** When the `max_wait` ends and the Producer is asked (state `waiting`), or `null`. */
  askAt: TimestampSchema.nullable(),
  /** The last apply that ended (read from the journal), or `null`. */
  last: z
    .strictObject({
      outcome: z.enum(UPDATE_APPLY_OUTCOMES),
      version: UpdateVersionSchema,
      reason: z.enum(UPDATE_REASONS).nullable(),
      at: TimestampSchema,
    })
    .nullable(),
});
export type ApiUpdateApply = z.infer<typeof ApiUpdateApplySchema>;

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
  /** P8: the application of the version that is ready. */
  apply: ApiUpdateApplySchema,
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

export const ApplyUpdateBodySchema = z.strictObject({
  /**
   * `default` (or nothing) follows `updates.apply_when`; `park` stops the daemon the clean way
   * (the sessions go `awaiting_resume`) and applies now; `wait` answers "wait longer" to the
   * question the daemon asked when the `max_wait` ended.
   */
  how: z.enum(UPDATE_APPLY_HOWS).default('default'),
});
export type ApplyUpdateBody = z.infer<typeof ApplyUpdateBodySchema>;

export const applyUpdate = defineRoute({
  id: 'applyUpdate',
  method: 'POST',
  path: '/v1/updates/apply',
  summary:
    'Applies the version that is ready, at the moment `updates.apply_when` says (or `park` or `wait` as the answer to the question of the max_wait); 409 `conflict` when there is none, the mode is `off` or `check`, or this is not the own executable',
  headers: IdempotencyHeadersSchema,
  body: ApplyUpdateBodySchema,
  response: ApiUpdateStatusSchema,
  errors: ['conflict', 'unavailable'],
});

export const UPDATE_ROUTES = defineRoutes(getUpdateStatus, checkUpdates, applyUpdate);
