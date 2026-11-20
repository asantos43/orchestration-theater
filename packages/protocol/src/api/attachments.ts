// SPDX-License-Identifier: MPL-2.0
import { AttachmentRecordSchema } from '@otheater/core';
import { z } from 'zod';
import { PageQuerySchema, pageOf } from './page.js';
import { defineRoute, defineRoutes } from './route.js';
import { ScenarioParamsSchema } from './scenarios.js';

/**
 * The attachments of a scenario (P5 of docs/17). The metadata and the content are two routes: a
 * list never carries a file. [proposta] The content is the answer of `read_attachment` (text as
 * text, an image or a binary file as base64) cut at `scenarios.attachment_read_max`, so no new
 * key is needed; a file that does not fit is refused with `payload_too_large`.
 */

export const ApiAttachmentSchema = AttachmentRecordSchema;
export type ApiAttachment = z.infer<typeof ApiAttachmentSchema>;

const AttachmentParamsSchema = ScenarioParamsSchema.extend({
  attachmentId: z.string().min(1).max(64),
});

export const ApiAttachmentContentSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.int().min(0),
  kind: z.enum(['text', 'image', 'binary']),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
  /** The read stopped at `scenarios.attachment_read_max` bytes (text only). */
  truncated: z.boolean(),
});
export type ApiAttachmentContent = z.infer<typeof ApiAttachmentContentSchema>;

export const listAttachments = defineRoute({
  id: 'listAttachments',
  method: 'GET',
  path: '/v1/scenarios/:scenarioId/attachments',
  summary: 'Attachments of a scenario (metadata only), in the order they came, by cursor',
  params: ScenarioParamsSchema,
  query: PageQuerySchema,
  response: pageOf(ApiAttachmentSchema),
  errors: ['not_found'],
});

export const getAttachment = defineRoute({
  id: 'getAttachment',
  method: 'GET',
  path: '/v1/scenarios/:scenarioId/attachments/:attachmentId',
  summary: 'Metadata of one attachment',
  params: AttachmentParamsSchema,
  response: ApiAttachmentSchema,
  errors: ['not_found'],
});

export const getAttachmentContent = defineRoute({
  id: 'getAttachmentContent',
  method: 'GET',
  path: '/v1/scenarios/:scenarioId/attachments/:attachmentId/content',
  summary: 'The content of one attachment: text, or base64 for an image or a binary file',
  params: AttachmentParamsSchema,
  response: ApiAttachmentContentSchema,
  errors: ['not_found', 'payload_too_large'],
});

export const ATTACHMENT_ROUTES = defineRoutes(listAttachments, getAttachment, getAttachmentContent);
