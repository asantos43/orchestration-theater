// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  InvalidInput,
  NotFound,
  PermissionDenied,
  type ScenarioRecord,
} from '@otheater/core';
import type { ApiSlashCommand, SlashCommandResult } from '@otheater/protocol';
import { BUILTIN_ACTIONS, isPausedPlay, templateAction } from './builtin.js';
import { bareCommandName, clientPrefixOf, parseSlashLine } from './parse.js';
import type { SlashAction, SlashDeps, SlashFacts, SlashRunContext } from './types.js';
import type { SlashTranslator } from './catalog.js';

type Language = 'en' | 'pt-BR';

/** One command the client of the Director announced, with the name the Producer types. */
interface ClientEntry {
  readonly id: string;
  /** The name the client knows it by (what goes to the Director). */
  readonly native: string;
  readonly description: string;
  readonly inputHint: string | undefined;
}

/**
 * The registry of the `/` commands (P3; architecture 5.13). It answers three questions for the
 * interfaces: which commands are valid for a scenario now ({@link list}), what a line does
 * ({@link execute}) and whether the commands are on at all ({@link enabled}). [proposta]
 */
export class SlashCommandService {
  readonly #deps: SlashDeps;
  readonly #builtin: readonly SlashAction[];

  constructor(deps: SlashDeps, builtin: readonly SlashAction[] = BUILTIN_ACTIONS) {
    this.#deps = deps;
    this.#builtin = builtin;
  }

  /** `chat.slash_commands`. When off, a line that starts with a slash is a plain message. */
  enabled(): boolean {
    return this.#deps.config.chat.slash_commands === 'on';
  }

  /** The commands of the daemon, then the templates (`chat.slash_templates`) the names of which are free. */
  #actions(): readonly SlashAction[] {
    const taken = new Set(this.#builtin.map((action) => action.id));
    const templates = Object.entries(this.#deps.config.chat.slash_templates)
      .filter(([name]) => !taken.has(name))
      .map(([name, text]) => templateAction(name, text));
    return [...this.#builtin, ...templates];
  }

  async #facts(scenarioId: string | undefined): Promise<SlashFacts> {
    if (scenarioId === undefined) return { scenario: undefined, plays: [] };
    const scenario = await this.#deps.store.scenarios.get(scenarioId);
    if (scenario === undefined) throw new NotFound(`There is no scenario "${scenarioId}"`);
    const plays = await this.#deps.store.plays.list({ scenarioId, open: true });
    return { scenario, plays };
  }

  /** Why the command is not valid for what the daemon knows now; `undefined` when it is. */
  #unavailable(action: SlashAction, facts: SlashFacts, t: SlashTranslator): string | undefined {
    const { scenario, plays } = facts;
    const { appliesTo } = action;
    if (scenario === undefined) {
      return appliesTo.scoped ? t('error.notAvailable.kind') : undefined;
    }
    if (appliesTo.kinds !== undefined && !appliesTo.kinds.includes(scenario.kind)) {
      return t('error.notAvailable.kind');
    }
    if (appliesTo.states !== undefined && !appliesTo.states.includes(scenario.state)) {
      return t('error.notAvailable.archived');
    }
    if (appliesTo.plays === 'open' && plays.length === 0) return t('error.notAvailable.noOpenPlay');
    if (appliesTo.plays === 'unpaused' && !plays.some((play) => !isPausedPlay(play))) {
      return t(
        plays.length === 0 ? 'error.notAvailable.noOpenPlay' : 'error.notAvailable.noUnpausedPlay',
      );
    }
    if (appliesTo.plays === 'paused' && !plays.some(isPausedPlay)) {
      return t('error.notAvailable.noPausedPlay');
    }
    return undefined;
  }

  #describe(action: SlashAction, t: SlashTranslator): ApiSlashCommand {
    return {
      id: action.id,
      name: `/${action.id}`,
      origin: action.origin,
      group: action.group,
      descriptionKey: action.descriptionKey,
      description: t(action.descriptionKey, action.descriptionVars),
      args: action.argsKey === undefined ? '' : t(action.argsKey),
      confirm: action.confirm && this.#deps.config.chat.slash_confirm === 'always',
    };
  }

  /** What the client of the Director announced, filtered by `chat.client_commands`. */
  async #clientEntries(scenario: ScenarioRecord | undefined): Promise<{
    readonly entries: readonly ClientEntry[];
    readonly inTurn: boolean;
    readonly started: boolean;
    readonly prefix: string;
  }> {
    const none = { entries: [], inTurn: false, started: false, prefix: '' } as const;
    const { config, directors } = this.#deps;
    const mode = config.chat.client_commands;
    if (mode === 'off' || scenario === undefined || directors === undefined) return none;
    if (scenario.state !== 'active') return none;
    const open = await directors.clientCommands(scenario.id);
    if (open === undefined) return none;
    const prefix = clientPrefixOf(open.client);
    const allowed = new Set(config.chat.client_commands_allow.map(bareCommandName));
    const entries = open.commands
      .map((command) => {
        const native = bareCommandName(command.name);
        return {
          id: `${prefix}:${native}`,
          native,
          description: command.description,
          inputHint: command.inputHint,
        };
      })
      .filter((entry) => mode === 'on' || allowed.has(entry.id));
    return { entries, inTurn: open.inTurn, started: open.started, prefix };
  }

  /** The commands valid for `scenarioId` now (none: the ones that need no scenario). */
  async list(
    options: {
      readonly scenarioId?: string | undefined;
      readonly lang?: Language | undefined;
    } = {},
  ): Promise<ApiSlashCommand[]> {
    const t = this.#deps.catalog.translator(options.lang ?? this.#deps.locale);
    const facts = await this.#facts(options.scenarioId);
    const found = this.#actions()
      .filter((action) => this.#unavailable(action, facts, t) === undefined)
      .map((action) => this.#describe(action, t));
    const client = await this.#clientEntries(facts.scenario);
    for (const entry of client.entries) {
      found.push({
        id: entry.id,
        name: `/${entry.id}`,
        origin: 'client',
        group: 'client',
        descriptionKey: '',
        description: entry.description,
        args: entry.inputHint ?? '',
        confirm: false,
      });
    }
    return found;
  }

  /** Runs the line of the Producer on a scenario. Throws the errors of the core; the route maps them. */
  async execute(
    scenarioId: string,
    input: {
      readonly text: string;
      readonly confirm?: boolean | undefined;
      readonly lang?: Language | undefined;
    },
  ): Promise<SlashCommandResult> {
    const t = this.#deps.catalog.translator(input.lang ?? this.#deps.locale);
    if (!this.enabled()) throw new PermissionDenied(t('error.off'));
    const line = parseSlashLine(input.text);
    if (line === undefined) throw new InvalidInput(t('error.unknown', { name: input.text.trim() }));
    const facts = await this.#facts(scenarioId);
    const { scenario } = facts;
    if (scenario === undefined) throw new NotFound(`There is no scenario "${scenarioId}"`);
    const wanted = line.name.toLowerCase();

    const action = this.#actions().find((candidate) => candidate.id === wanted);
    if (action !== undefined) {
      return this.#runAction(action, scenario, facts, line.text, input, t);
    }
    const client = await this.#clientEntries(scenario);
    const entry = client.entries.find((candidate) => candidate.id.toLowerCase() === wanted);
    if (entry !== undefined) return this.#runClient(scenario, entry, client, line.text, t);
    // A name the Producer typed with a client prefix, when the client commands are off or not allowed.
    if (line.name.includes(':')) {
      const mode = this.#deps.config.chat.client_commands;
      if (mode === 'off') throw new PermissionDenied(t('error.clientOff'));
      if (mode === 'allowlist') {
        throw new PermissionDenied(t('error.clientNotAllowed', { name: line.name }));
      }
      if (scenario.state === 'active' && this.#deps.directors !== undefined) {
        throw new Conflict(t('error.clientNoSession'));
      }
    }
    throw new InvalidInput(t('error.unknown', { name: line.name }));
  }

  async #runAction(
    action: SlashAction,
    scenario: ScenarioRecord,
    facts: SlashFacts,
    text: string,
    input: { readonly confirm?: boolean | undefined; readonly lang?: Language | undefined },
    t: SlashTranslator,
  ): Promise<SlashCommandResult> {
    const { config, locale } = this.#deps;
    const reason = this.#unavailable(action, facts, t);
    if (reason !== undefined) throw new Conflict(t('error.notNow', { name: action.id, reason }));
    if (
      (action.permission === 'write' || action.writes?.(text) === true) &&
      config.chat.slash_access === 'read_only'
    ) {
      throw new PermissionDenied(t('error.forbidden', { name: action.id }));
    }
    const parsed = action.args.safeParse(text);
    if (!parsed.success) {
      throw new InvalidInput(
        action.argsKey === undefined
          ? t('error.noArgs', { name: action.id })
          : t('error.usage', { usage: `/${action.id} ${t(action.argsKey)}` }),
        { cause: parsed.error },
      );
    }
    if (action.confirm && config.chat.slash_confirm === 'always' && input.confirm !== true) {
      return {
        status: 'confirm',
        command: action.id,
        text: t('confirm.ask', { command: action.id }),
      };
    }
    const context: SlashRunContext<unknown> = {
      scenario,
      facts,
      args: parsed.data,
      text,
      t,
      deps: this.#deps,
      locale: input.lang ?? locale,
      commands: () => this.list({ scenarioId: scenario.id, lang: input.lang ?? locale }),
    };
    const outcome = await action.run(context);
    return {
      status: outcome.status ?? 'done',
      command: action.id,
      text: outcome.text,
      ...(outcome.data === undefined ? {} : { data: outcome.data }),
    };
  }

  async #runClient(
    scenario: ScenarioRecord,
    entry: ClientEntry,
    state: { readonly inTurn: boolean; readonly started: boolean },
    text: string,
    t: SlashTranslator,
  ): Promise<SlashCommandResult> {
    const { channel, config } = this.#deps;
    if (config.chat.slash_access === 'read_only') {
      throw new PermissionDenied(t('error.forbidden', { name: entry.id }));
    }
    if (channel === undefined) throw new Conflict(t('error.noChannel'));
    if (state.inTurn) throw new Conflict(t('error.clientInTurn'));
    if (!state.started) throw new Conflict(t('error.clientNotStarted'));
    await channel.send(scenario.id, text === '' ? `/${entry.native}` : `/${entry.native} ${text}`);
    return { status: 'forwarded', command: entry.id, text: t('out.forwarded.client') };
  }
}
