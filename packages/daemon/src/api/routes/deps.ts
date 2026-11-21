// SPDX-License-Identifier: MPL-2.0
import type { Clock, Store } from '@otheater/core';
import type { BudgetService } from '../../budget/index.js';
import type { DaemonConfig, PauseMode } from '../../config.js';
import type { DirectiveService } from '../../directives/index.js';
import type { AttemptRunner } from '../../execution/attempt-runner.js';
import type { IdeaQueueService } from '../../ideas/index.js';
import type { LayoutPreferencesStore } from '../../layout/preferences.js';
import type { Logger } from '../../logger.js';
import type { ProducerChannel } from '../../orchestration/channel.js';
import type { PlayRunner } from '../../pipeline/runner.js';
import type { ProfileLoginService } from '../../profiles/login.js';
import type { ProfileService } from '../../profiles/service.js';
import type { QuotaService } from '../../quota/index.js';
import type { AttachmentService } from '../../scenarios/attachments.js';
import type { SlashCommandService } from '../../slash/index.js';
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
  /** The registry of the `/` commands (P3 of Phase 7); absent: the routes answer 503. */
  readonly slash?: SlashCommandService | undefined;
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
  /** The official login of a subscription account (P5 of Phase 7). */
  readonly logins: ProfileLoginService;
  /** `<data>/config.yaml`, the file `PUT /v1/config` edits. */
  readonly configPath: string;
  /**
   * The configuration the daemon runs with. `PUT /v1/config` reloads `ui`, `chat`, `limits` and
   * `roles` into it in place (N188); absent, every edit applies on restart.
   */
  readonly config?: DaemonConfig | undefined;
  /** `api.idempotency_ttl`, read at each command. */
  readonly idempotencyTtlMs: () => number;
  /** The Producer's channel: opens scenarios, attaches files and answers decisions. */
  readonly channel?: ProducerChannel | undefined;
  readonly runner?: PlayRunner | undefined;
  /** N176: the runner of the attempts, for pausing, resuming and cancelling one Actor. */
  readonly attempts?: AttemptRunner | undefined;
  /** N176: `pause.mode`, read at each pause that does not name its own mode. */
  readonly pauseMode?: (() => PauseMode) | undefined;
  readonly ideas?: IdeaQueueService | undefined;
  /** The layout preferences of the interfaces (P12). */
  readonly layout: LayoutPreferencesStore;
  /** The registry of the `/` commands (P3 of Phase 7); absent: the route answers 503. */
  readonly slash?: SlashCommandService | undefined;
  /** The setup assistant (P4 of docs/18); absent: its routes answer 503 `unavailable`. */
  readonly setup?: SetupService | undefined;
}
