// SPDX-License-Identifier: MPL-2.0
import {
  ATIF_EXPORT_CONTENTS,
  ATIF_EXPORT_TRIGGERS,
  ATIF_EXPORT_UNITS,
  type AtifExportContent,
  type AtifExportTrigger,
  type AtifExportUnit,
} from '@otheater/protocol';
import { z } from 'zod';

/**
 * The keys of the ATIF export (Phase 8, P5; architecture 5.11, N219). `atif.export.on` and its
 * modes come from N219; `unit`, `content` and `dir` are [proposta].
 *
 * - `atif.export.unit` (default `play`): what one file holds. `play`: one file per play, the
 *   Director as the root and each attempt embedded in `subagent_trajectories`; `attempt`: one file
 *   per attempt; `play_files`: the Director's file plus one file per attempt, the root pointing at
 *   them by `trajectory_path`.
 * - `atif.export.content` (default `full`): `full` keeps the text, with the values of the vault and
 *   the shapes of keys always masked; `redacted` writes the structure and the metrics, with no
 *   text of the conversation, the tools or their arguments.
 * - `atif.export.on` (default `play_end`): when the daemon writes the files by itself. `play_end`:
 *   the play reached DONE or CANCELLED; `attempt_end`: an attempt ended (only with the units
 *   `attempt` and `play_files`); `manual`: never by itself. `ot trajectory export` and the route
 *   work in every mode.
 * - `atif.export.dir` (default `trajectories`): where the files go, relative to the data folder or
 *   absolute.
 */
export {
  ATIF_EXPORT_CONTENTS,
  ATIF_EXPORT_TRIGGERS,
  ATIF_EXPORT_UNITS,
  type AtifExportContent,
  type AtifExportTrigger,
  type AtifExportUnit,
};

export const AtifConfigSchema = z
  .strictObject({
    export: z
      .strictObject({
        unit: z.enum(ATIF_EXPORT_UNITS).default('play'),
        content: z.enum(ATIF_EXPORT_CONTENTS).default('full'),
        on: z.enum(ATIF_EXPORT_TRIGGERS).default('play_end'),
        dir: z.string().min(1).default('trajectories'),
      })
      .prefault({})
      .superRefine((block, ctx) => {
        if (block.on === 'attempt_end' && block.unit === 'play') {
          ctx.addIssue({
            code: 'custom',
            path: ['on'],
            message:
              'attempt_end writes a file per attempt: use it with atif.export.unit attempt or play_files',
          });
        }
      }),
  })
  .prefault({});

export type AtifSettings = z.infer<typeof AtifConfigSchema>['export'];
