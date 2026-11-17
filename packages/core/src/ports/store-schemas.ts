// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { JsonValueSchema } from './event-log.js';

/** Id of a stored record (play, demand, directive...): opaque, non-empty text. */
export const RecordIdSchema = z.string().min(1).max(256);

/** Epoch milliseconds, as the `Clock` reports them. */
export const EpochMsSchema = z.int().min(0);

/** A JSON object (never a bare scalar or array), so fields can be added later. */
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
