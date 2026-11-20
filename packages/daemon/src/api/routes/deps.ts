// SPDX-License-Identifier: MPL-2.0
import type { Store } from '@otheater/core';
import type { BudgetService } from '../../budget/index.js';
import type { DaemonConfig } from '../../config.js';
import type { ProfileService } from '../../profiles/service.js';
import type { QuotaService } from '../../quota/index.js';
import type { AttachmentService } from '../../scenarios/attachments.js';
import type { UsageService } from '../../usage/index.js';

/**
 * What the handlers of the REST routes read (P5 of docs/17). Each route file takes this and
 * registers its own routes; `registerReadRoutes` (index.ts) calls them all once the services
 * exist. [proposta] P6 (the commands) follows the same pattern: one `register<Resource>Commands`
 * per file, with the deps it needs added here.
 */
export interface ReadRouteDeps {
  readonly store: Store;
  /** The effective configuration the daemon started with. */
  readonly config: DaemonConfig;
  readonly quota: QuotaService;
  readonly usage: UsageService;
  readonly budget: BudgetService;
  readonly profiles: ProfileService;
  readonly attachments: AttachmentService;
}
