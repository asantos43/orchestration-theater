// SPDX-License-Identifier: MPL-2.0
import type { TrajectoryService } from '../trajectory/service.js';
import type {
  Clock,
  JsonValue,
  PlayRecord,
  ScenarioRecord,
  ScenarioRecordKind,
  ScenarioState,
  Store,
} from '@otheater/core';
import type { ApiSlashCommand, SlashCommandGroup } from '@otheater/protocol';
import type { z } from 'zod';
import type { BudgetService } from '../budget/index.js';
import type { DaemonConfig, PauseMode } from '../config.js';
import type { DirectSessionService } from '../direct/service.js';
import type { DirectiveService } from '../directives/index.js';
import type { Logger } from '../logger.js';
import type { ProducerChannel } from '../orchestration/channel.js';
import type { DirectorSessions } from '../orchestration/director.js';
import type { PlayRunner } from '../pipeline/runner.js';
import type { ProfileService } from '../profiles/service.js';
import type { QuotaService } from '../quota/index.js';
import type { UsageService } from '../usage/index.js';
import type { SlashCatalog, SlashTranslator } from './catalog.js';

/**
 * The registry of the `/` commands of the daemon (Phase 7, P3; architecture 5.13, N44). Each
 * command is one {@link SlashAction}: an id, the key of its description in the catalog, its
 * arguments (a zod schema over the text after the name), where it applies, what it may do and
 * whether it asks for a confirmation. The same registry serves every interface: the list is
 * `GET /v1/commands`, a line is run by `POST /v1/scenarios/:scenarioId/commands` or by a `command`
 * message of the chat socket. [proposta]
 */

/** What a command may do: `read` only looks, `write` changes something (`chat.slash_access`). */
export type SlashPermission = 'read' | 'write';

/** What the command needs of the open plays of the scenario to be valid now. */
export type SlashPlayNeed = 'open' | 'unpaused' | 'paused';

/** Where a command applies. Every field that is absent means "anywhere". */
export interface SlashApplicability {
  /**
   * `true`: the command is about the scenario and is listed only when the list is asked for one.
   * `false`: it is listed with no scenario too (`/help`, `/quota`).
   */
  readonly scoped: boolean;
  /** The types of scenario the command applies to. */
  readonly kinds?: readonly ScenarioRecordKind[];
  /** The states of the scenario it applies to. */
  readonly states?: readonly ScenarioState[];
  /** What it needs of the open plays. */
  readonly plays?: SlashPlayNeed;
}

/** What the daemon knows of a scenario when it decides what is valid. */
export interface SlashFacts {
  readonly scenario: ScenarioRecord | undefined;
  /** The open plays of the scenario (none without a scenario). */
  readonly plays: readonly PlayRecord[];
}

/** What a command answers. `status` is `done` unless it says otherwise. */
export interface SlashOutcome {
  readonly status?: 'done' | 'forwarded';
  readonly text: string;
  readonly data?: JsonValue;
}

/** What a command gets when it runs. */
export interface SlashRunContext<Args> {
  readonly scenario: ScenarioRecord;
  readonly facts: SlashFacts;
  readonly args: Args;
  /** The text of the arguments as typed (trimmed). */
  readonly text: string;
  readonly t: SlashTranslator;
  readonly deps: SlashDeps;
  /** The language of the answer. */
  readonly locale: 'en' | 'pt-BR';
  /** The list of commands valid for this scenario now (for `/help`). */
  readonly commands: () => Promise<readonly ApiSlashCommand[]>;
}

/** One command of the registry. */
export interface SlashAction<Args = unknown> {
  /** `status`. The name the Producer types is `/status`. */
  readonly id: string;
  readonly origin: 'daemon' | 'template';
  readonly group: SlashCommandGroup;
  /** The catalog key of the description, and of the hint of the arguments when there is one. */
  readonly descriptionKey: string;
  /** The values the description takes (`{{text}}` of a template). */
  readonly descriptionVars?: Readonly<Record<string, string>>;
  readonly argsKey: string | undefined;
  readonly permission: SlashPermission;
  /** Asks for a confirmation before it runs (`chat.slash_confirm: always`). */
  readonly confirm: boolean;
  readonly appliesTo: SlashApplicability;
  /** The arguments: the schema takes the text after the name and gives what `run` reads. */
  readonly args: z.ZodType<Args, string>;
  run(context: SlashRunContext<Args>): Promise<SlashOutcome>;
}

/** What the registry needs of the daemon. The services that exist only with plays are optional. */
export interface SlashDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: DaemonConfig;
  readonly quota: QuotaService;
  readonly usage: UsageService;
  readonly budget: BudgetService;
  readonly profiles: ProfileService;
  readonly directives: DirectiveService;
  readonly catalog: SlashCatalog;
  /** The language of the answers when the caller names none (`ui.locale`, resolved). */
  readonly locale: 'en' | 'pt-BR';
  readonly channel?: ProducerChannel | undefined;
  readonly runner?: PlayRunner | undefined;
  readonly directors?: DirectorSessions | undefined;
  /** The direct sessions with an Actor (P19); absent: `/direct` answers 503. */
  readonly direct?: Pick<DirectSessionService, 'open'> | undefined;
  /** `pause.mode`, read at each pause. */
  readonly pauseMode?: (() => PauseMode) | undefined;
  /** The trajectory of a play (P14): `/trajectory` reads it. */
  readonly trajectory?: TrajectoryService | undefined;
}
