// SPDX-License-Identifier: MPL-2.0
import type { Clock, Store } from '@otheater/core';
import type { BudgetService } from '../../budget/index.js';
import type { DaemonConfig } from '../../config.js';
import type { DirectiveService } from '../../directives/index.js';
import type { IdeaQueueService } from '../../ideas/index.js';
import type { LayoutPreferencesStore } from '../../layout/preferences.js';
import type { Logger } from '../../logger.js';
import type { ProducerChannel } from '../../orchestration/channel.js';
import type { PlayRunner } from '../../pipeline/runner.js';
import type { ProfileService } from '../../profiles/service.js';
import type { QuotaService } from '../../quota/index.js';
import type { AttachmentService } from '../../scenarios/attachments.js';
import type { SetupService } from '../../setup/index.js';
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
  /** The layout preferences of the interfaces (P12). */
  readonly layout: LayoutPreferencesStore;
  /** The setup assistant (P4 of docs/18); absent: its routes answer 503 `unavailable`. */
  readonly setup?: SetupService | undefined;
}

/**
 * What the handlers of the REST commands act on (P6 of docs/17). [proposta] Same pattern as
 * {@link ReadRouteDeps}: one `register<Resource>Commands` per file. The services that exist only
 * when the daemon runs plays (`channel`, `runner`, `ideas`) are optional: a command that needs one
 * answers 503 `unavailable` when the daemon has none.
 */
export interface CommandRouteDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly directives: DirectiveService;
  readonly profiles: ProfileService;
  /** `<data>/config.yaml`, the file `PUT /v1/config` edits. */
  readonly configPath: string;
  /** `api.idempotency_ttl`, read at each command. */
  readonly idempotencyTtlMs: () => number;
  /** The Producer's channel: opens scenarios, attaches files and answers decisions. */
  readonly channel?: ProducerChannel | undefined;
  readonly runner?: PlayRunner | undefined;
  readonly ideas?: IdeaQueueService | undefined;
  /** The layout preferences of the interfaces (P12). */
  readonly layout: LayoutPreferencesStore;
  /** The setup assistant (P4 of docs/18); absent: its routes answer 503 `unavailable`. */
  readonly setup?: SetupService | undefined;
}
