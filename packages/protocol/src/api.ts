// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * First schemas of the daemon API (architecture 5.12). They live here, shared by the daemon and
 * every shell or interface, so both sides parse the same shape. There is no HTTP server yet: the
 * `ot` commands use these types directly, and `GET /status` will return them later.
 */

/** Lifecycle of the daemon (architecture 5.21, "Reconciliação na subida"). */
export const DAEMON_STATES = ['starting', 'recovering', 'running', 'stopping'] as const;
export type DaemonState = (typeof DAEMON_STATES)[number];

/** What `ot daemon` shows and `GET /status` will return. */
export const DaemonStatusSchema = z.strictObject({
  pid: z.int().min(1),
  /** Epoch milliseconds (the `Clock` of the daemon). */
  startedAt: z.int().min(0),
  version: z.string().min(1),
  dataDir: z.string().min(1),
  state: z.enum(DAEMON_STATES),
});
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;

/** How much of the daemon data goes into a backup (key `backup.content`, architecture 5.21). */
export const BACKUP_CONTENTS = ['store_only', 'without_runs', 'all'] as const;
export type BackupContent = (typeof BACKUP_CONTENTS)[number];

/** What started a backup. */
export const BACKUP_TRIGGERS = ['schedule', 'manual'] as const;
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];

/** `manifest.json` format version written by this code. */
export const BACKUP_MANIFEST_FORMAT_VERSION = 1;

/**
 * `manifest.json` of a backup folder. [proposta] A folder without a valid manifest is not ours and
 * is never touched by the rotation or by `ot restore`. The manifest is written only after the
 * store copy passed `PRAGMA integrity_check`, so `integrity` is always `'ok'` in a finished copy.
 */
export const BackupManifestSchema = z.strictObject({
  formatVersion: z.literal(BACKUP_MANIFEST_FORMAT_VERSION),
  /** Epoch milliseconds of the moment the copy was made. Retention counts age from here. */
  createdAt: z.int().min(0),
  trigger: z.enum(BACKUP_TRIGGERS),
  /** Method name as the store adapter reports it (`online_api`, `vacuum_into`). */
  method: z.string().min(1),
  content: z.enum(BACKUP_CONTENTS),
  integrity: z.literal('ok'),
  storeBytes: z.int().min(0),
  otheaterVersion: z.string().min(1),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
