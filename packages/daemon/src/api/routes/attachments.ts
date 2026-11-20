// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, NotFound } from '@otheater/core';
import { ApiFailure, type ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';
import { paginate } from './paging.js';

export function registerAttachmentRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { store, attachments } = deps;

  async function scenarioExists(scenarioId: string): Promise<void> {
    if ((await store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
  }

  handlers.register('listAttachments', async ({ params, query }) => {
    await scenarioExists(params.scenarioId);
    const rows = await store.attachments.list(params.scenarioId);
    return paginate(rows, (item) => [item.seq], query);
  });

  handlers.register('getAttachment', async ({ params }) => {
    await scenarioExists(params.scenarioId);
    return attachments.get(params.scenarioId, params.attachmentId);
  });

  handlers.register('getAttachmentContent', async ({ params }) => {
    await scenarioExists(params.scenarioId);
    const record = await attachments.get(params.scenarioId, params.attachmentId);
    try {
      return await attachments.read(record);
    } catch (error) {
      // An image or a binary file over `scenarios.attachment_read_max` is refused whole.
      if (error instanceof InvalidInput) {
        throw new ApiFailure('payload_too_large', error.message, {
          details: { attachmentId: record.id, size: record.size },
        });
      }
      throw error;
    }
  });
}
