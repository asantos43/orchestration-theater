// SPDX-License-Identifier: MPL-2.0
import { NotFound } from './errors.js';
import type { DirectiveKind, DirectiveScope } from './ports/directives.js';
import type { DecisionRecord, DemandState } from './ports/plays.js';
import type { PromptOrigin, PromptState } from './ports/prompt-queue.js';
import type { DirectorState, ScenarioRecordKind } from './ports/scenarios.js';
import type { Store } from './ports/store.js';

/**
 * [proposta] The state summary of a scenario (architecture 5.4, "Failover do Orquestrador", and
 * 5.21, "o Diretor volta adormecido e acorda pelo resumo"): what a new Director session (the
 * failover, or a sleeping Director waking up) needs to go on, built only from what is in the
 * store. It is deterministic: no clock, no randomness, every list in a fixed order, so the
 * summary of a restored store equals the one of the store it was copied from.
 *
 * It never carries the content of the blackboard (that is read on demand, `read_blackboard`):
 * only the keys and their latest versions.
 */
export interface StateSummary {
  readonly scenario: {
    readonly id: string;
    readonly kind: ScenarioRecordKind;
    readonly name: string;
    readonly directorState: DirectorState;
    readonly baseBranch: string | null;
  };
  /** The plays not finished yet, oldest first. */
  readonly plays: readonly PlaySummary[];
  /** Decisions waiting for an answer, oldest first. */
  readonly pendingDecisions: readonly {
    readonly id: string;
    readonly kind: string;
    readonly playId: string | null;
  }[];
  /** The directives in force for the scenario, in id order. */
  readonly directives: readonly {
    readonly id: string;
    readonly scope: DirectiveScope;
    readonly kind: DirectiveKind;
    readonly text: string;
    readonly roles: readonly string[];
  }[];
  /** What is still in the prompt queue, in delivery order. */
  readonly pendingPrompts: readonly MessageSummary[];
  /** The last messages of the queue, oldest first (the "últimas mensagens do chat"). */
  readonly recentMessages: readonly MessageSummary[];
}

export interface PlaySummary {
  readonly id: string;
  readonly need: string;
  readonly state: string;
  readonly counters: Readonly<Record<string, number>>;
  readonly parentPlayId: string | null;
  readonly demands: readonly {
    readonly id: string;
    readonly title: string;
    readonly state: DemandState;
    readonly dependsOn: readonly string[];
  }[];
  /** Latest version of each blackboard key of the play, by key. */
  readonly blackboard: readonly { readonly key: string; readonly version: number }[];
}

export interface MessageSummary {
  readonly seq: number;
  readonly source: PromptOrigin;
  readonly state: PromptState;
  readonly text: string;
}

/** Longest text a message keeps in the summary (the rest is cut with an ellipsis). */
export const SUMMARY_MESSAGE_CHARS = 500;

/** Default of how many recent messages the summary lists (`prompt_queue.summary_messages`). */
export const DEFAULT_SUMMARY_MESSAGES = 10;

/**
 * What is read from the store to build the summary: plain data, as recorded. `buildStateSummary`
 * is a pure function of this, so a test can hand it a snapshot without a store.
 */
export interface StateSnapshot {
  readonly scenario: StateSummary['scenario'];
  readonly plays: readonly (PlaySummary & { readonly createdAt: number })[];
  readonly pendingDecisions: readonly Pick<
    DecisionRecord,
    'id' | 'kind' | 'playId' | 'createdAt'
  >[];
  readonly directives: StateSummary['directives'];
  /** Every item of the queue of the scenario, whatever its state, with its text. */
  readonly queue: readonly (MessageSummary & { readonly priority: number })[];
}

export interface StateSummaryOptions {
  /** How many of the last messages to list. Default {@link DEFAULT_SUMMARY_MESSAGES}. */
  readonly recentMessages?: number;
}

function cut(text: string): string {
  return text.length <= SUMMARY_MESSAGE_CHARS
    ? text
    : `${text.slice(0, SUMMARY_MESSAGE_CHARS - 1)}…`;
}

function message(item: MessageSummary): MessageSummary {
  return { seq: item.seq, source: item.source, state: item.state, text: cut(item.text) };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: the same snapshot always gives the same summary. */
export function buildStateSummary(
  snapshot: StateSnapshot,
  options: StateSummaryOptions = {},
): StateSummary {
  const recent = Math.max(0, options.recentMessages ?? DEFAULT_SUMMARY_MESSAGES);
  const bySeq = [...snapshot.queue].sort((a, b) => a.seq - b.seq);
  // Delivery order, the one `PromptQueue.next` uses: priority first, then arrival.
  const pending = bySeq
    .filter((item) => item.state === 'pending')
    .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  return {
    scenario: snapshot.scenario,
    plays: [...snapshot.plays]
      .sort((a, b) => a.createdAt - b.createdAt || byText(a.id, b.id))
      .map((play) => ({
        id: play.id,
        need: play.need,
        state: play.state,
        counters: Object.fromEntries(
          Object.entries(play.counters).sort(([a], [b]) => byText(a, b)),
        ),
        parentPlayId: play.parentPlayId,
        demands: [...play.demands].sort((a, b) => byText(a.id, b.id)),
        blackboard: [...play.blackboard].sort((a, b) => byText(a.key, b.key)),
      })),
    pendingDecisions: [...snapshot.pendingDecisions]
      .sort((a, b) => a.createdAt - b.createdAt || byText(a.id, b.id))
      .map(({ id, kind, playId }) => ({ id, kind, playId })),
    directives: [...snapshot.directives].sort((a, b) => byText(a.id, b.id)),
    pendingPrompts: pending.map(message),
    recentMessages: recent === 0 ? [] : bySeq.slice(-recent).map(message),
  };
}

/** The part of the store the summary reads. */
export type StateSummaryStore = Pick<
  Store,
  'scenarios' | 'plays' | 'demands' | 'decisions' | 'blackboard' | 'directives' | 'promptQueue'
>;

/** Reads what the summary needs from the store (`NotFound` for an unknown scenario). */
export async function loadStateSnapshot(
  store: StateSummaryStore,
  scenarioId: string,
): Promise<StateSnapshot> {
  const scenario = await store.scenarios.get(scenarioId);
  if (scenario === undefined) throw new NotFound(`Scenario ${scenarioId} does not exist`);
  const [openPlays, pendingDecisions, directives, queue] = await Promise.all([
    store.plays.list({ scenarioId, open: true }),
    store.decisions.list({ scenarioId, states: ['pending'] }),
    store.directives.inForce({ scenarioId }),
    store.promptQueue.list({ scenarioId }),
  ]);
  const plays = await Promise.all(
    openPlays.map(async (play) => {
      const [demands, entries] = await Promise.all([
        store.demands.list({ playId: play.id }),
        store.blackboard.latest(play.id),
      ]);
      return {
        id: play.id,
        need: play.need,
        state: play.state,
        counters: play.counters,
        parentPlayId: play.parentPlayId,
        createdAt: play.createdAt,
        demands: demands.map((demand) => ({
          id: demand.id,
          title: demand.title,
          state: demand.state,
          dependsOn: demand.dependsOn,
        })),
        blackboard: entries.map((entry) => ({ key: entry.key, version: entry.version })),
      };
    }),
  );
  return {
    scenario: {
      id: scenario.id,
      kind: scenario.kind,
      name: scenario.name,
      directorState: scenario.directorState,
      baseBranch: scenario.baseBranch,
    },
    plays,
    pendingDecisions,
    directives: directives.map((directive) => ({
      id: directive.id,
      scope: directive.scope,
      kind: directive.kind,
      text: directive.text,
      roles: directive.roles,
    })),
    queue: queue.map((item) => ({
      seq: item.seq,
      source: item.source,
      state: item.state,
      priority: item.priority,
      text: typeof item.content.text === 'string' ? item.content.text : '',
    })),
  };
}

/** The summary of a scenario, read from the store and built. */
export async function stateSummaryOf(
  store: StateSummaryStore,
  scenarioId: string,
  options: StateSummaryOptions = {},
): Promise<StateSummary> {
  return buildStateSummary(await loadStateSnapshot(store, scenarioId), options);
}

/**
 * The summary as the text a new session receives as its first prompt. Pure, like the summary.
 * [proposta] English, as the other prompts; plain lines so a model reads it without a schema.
 */
export function renderStateSummary(summary: StateSummary): string {
  const lines: string[] = [];
  const { scenario } = summary;
  lines.push(`State of scenario "${scenario.name}" (${scenario.id}, ${scenario.kind}).`);
  lines.push(`Director: ${scenario.directorState}.`);
  if (scenario.baseBranch !== null) lines.push(`Base branch: ${scenario.baseBranch}.`);

  lines.push('', 'Open plays:');
  if (summary.plays.length === 0) lines.push('- none');
  for (const play of summary.plays) {
    lines.push(`- ${play.id} [${play.state}]: ${play.need}`);
    const counters = Object.entries(play.counters).map(
      ([name, value]) => `${name}=${String(value)}`,
    );
    if (counters.length > 0) lines.push(`  counters: ${counters.join(', ')}`);
    if (play.parentPlayId !== null) lines.push(`  follows play ${play.parentPlayId}`);
    for (const demand of play.demands) {
      const after = demand.dependsOn.length > 0 ? ` (after ${demand.dependsOn.join(', ')})` : '';
      lines.push(`  demand ${demand.id} [${demand.state}]: ${demand.title}${after}`);
    }
    if (play.blackboard.length > 0) {
      const keys = play.blackboard.map((entry) => `${entry.key}@v${String(entry.version)}`);
      lines.push(`  blackboard (read with read_blackboard): ${keys.join(', ')}`);
    }
  }

  lines.push('', 'Pending decisions:');
  if (summary.pendingDecisions.length === 0) lines.push('- none');
  for (const decision of summary.pendingDecisions) {
    const where = decision.playId === null ? '' : ` of play ${decision.playId}`;
    lines.push(`- ${decision.id} (${decision.kind})${where}`);
  }

  lines.push('', 'Directives in force:');
  if (summary.directives.length === 0) lines.push('- none');
  for (const directive of summary.directives) {
    const roles = directive.roles.length > 0 ? ` [${directive.roles.join(', ')}]` : '';
    lines.push(
      `- ${directive.id} (${directive.scope} ${directive.kind})${roles}: ${directive.text}`,
    );
  }

  lines.push('', 'Prompts still in the queue, in delivery order:');
  if (summary.pendingPrompts.length === 0) lines.push('- none');
  for (const prompt of summary.pendingPrompts) {
    lines.push(`- #${String(prompt.seq)} ${prompt.source}: ${prompt.text}`);
  }

  lines.push('', 'Recent messages, oldest first:');
  if (summary.recentMessages.length === 0) lines.push('- none');
  for (const item of summary.recentMessages) {
    lines.push(`- #${String(item.seq)} ${item.source} (${item.state}): ${item.text}`);
  }
  return lines.join('\n');
}
