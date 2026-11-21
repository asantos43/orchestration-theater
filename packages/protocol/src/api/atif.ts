// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { AtifTrajectorySchema } from '../atif/schema.js';
import { ATIF_EXPORT_CONTENTS } from '../atif-events.js';
import { PlayParamsSchema } from './plays.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The ATIF export of a play (Phase 8, P5; architecture 5.11, N219). [proposta] One read: the play
 * folded into an ATIF v1.8 trajectory, built when asked and written nowhere (the files and the
 * `atif.exported` event are the business of `atif.export.*` and of `ot trajectory export`). The
 * play is the unit: the root is the Director's trajectory and each attempt is embedded in
 * `subagent_trajectories`; `attemptId` asks for the trajectory of that one attempt instead.
 */

export const GetPlayAtifQuerySchema = z.strictObject({
  /** `full` (the default is `atif.export.content`): the text, with the secrets masked all the same; `redacted`: no text. */
  content: z.enum(ATIF_EXPORT_CONTENTS).optional(),
  /** Only this attempt of the play (its own trajectory, not embedded in the Director's). */
  attemptId: z.string().min(1).max(256).optional(),
});
export type GetPlayAtifQuery = z.input<typeof GetPlayAtifQuerySchema>;

export const getPlayAtif = defineRoute({
  id: 'getPlayAtif',
  method: 'GET',
  path: '/v1/plays/:playId/atif',
  summary:
    'The play as an ATIF v1.8 trajectory (the Director as the root, each attempt embedded); with attemptId, that attempt alone',
  params: PlayParamsSchema,
  query: GetPlayAtifQuerySchema,
  response: AtifTrajectorySchema,
  errors: ['not_found', 'unavailable'],
});

export const ATIF_ROUTES = defineRoutes(getPlayAtif);
