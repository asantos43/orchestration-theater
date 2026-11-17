// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import {
  commandLine,
  type ProjectCommand,
  conventionsToJson,
  parseConventions,
  type ChangelogFormat,
  type CommitStyle,
  type JsonObject,
  type JsonValue,
  type ProjectConventions,
  type Store,
} from '@otheater/core';
import type { Logger } from '../logger.js';
import type { QuestionBoard } from '../orchestration/handlers.js';
import { DECISION_KINDS } from '../orchestration/play-effects.js';

/** Longest text of a question (the schema of `ask_producer`). */
const QUESTION_MAX = 500;
/** Longest custom command the Producer can type. */
const COMMAND_MAX = 500;
/** What the Producer types to say a repository has no such command. */
const NO_COMMAND = 'No command';

interface Option {
  readonly label: string;
  readonly description: string;
}

interface Question {
  readonly question: string;
  readonly options?: readonly Option[];
  readonly recommended?: string;
  readonly open?: boolean;
}

const CHANGELOG_OPTIONS: readonly { readonly format: ChangelogFormat; readonly option: Option }[] =
  [
    {
      format: 'keep-a-changelog',
      option: {
        label: 'Keep a Changelog',
        description: 'Sections [Unreleased], Added, Changed, Fixed (keepachangelog.com).',
      },
    },
    {
      format: 'conventional-changelog',
      option: {
        label: 'conventional-changelog',
        description: 'The file the conventional-changelog tools write: Features, Bug Fixes.',
      },
    },
    {
      format: 'other',
      option: {
        label: 'Another format',
        description: 'The file keeps its own layout; a delivery adds one bullet to it.',
      },
    },
    {
      format: 'none',
      option: {
        label: 'No changelog',
        description:
          'The repository has none; a delivery creates CHANGELOG.md (delivery.changelog).',
      },
    },
  ];

const COMMIT_OPTIONS: readonly { readonly style: CommitStyle; readonly option: Option }[] = [
  {
    style: 'conventional',
    option: {
      label: 'Conventional Commits',
      description: 'Subjects like "feat: add the export command" (conventionalcommits.org).',
    },
  },
  {
    style: 'free',
    option: { label: 'Free text', description: 'Plain subjects, with no required prefix.' },
  },
];

const USE_DETECTED = 'Use the detected command';

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function commandText(command: ProjectCommand | undefined): string {
  return command === undefined ? 'none' : commandLine(command);
}

/** What the detection found, in one paragraph for the Producer. */
export function describeConventions(conventions: ProjectConventions): string {
  const changelog =
    conventions.changelog.format === 'none'
      ? 'no changelog'
      : `changelog ${conventions.changelog.format} (${conventions.changelog.file ?? '?'})`;
  return cut(
    [
      `Imported repository${conventions.mainBranch === undefined ? '' : `, main branch ${conventions.mainBranch}`}:`,
      `${changelog}; commits ${conventions.commit.style}; CI ${conventions.ci};`,
      `test ${commandText(conventions.commands.test)}; install ${commandText(conventions.commands.install)}.`,
    ].join(' '),
    QUESTION_MAX - 60,
  );
}

function commandQuestion(what: string, command: ProjectCommand | undefined): Question {
  if (command === undefined) {
    return {
      question: `No ${what} command was detected. Type it, or "${NO_COMMAND}" if the repository has none.`,
      open: true,
    };
  }
  const detected = commandLine(command);
  return {
    question: cut(
      `Is the ${what} command right: ${detected}? Choose, or type the right one.`,
      QUESTION_MAX,
    ),
    options: [
      { label: USE_DETECTED, description: cut(detected, 500) },
      { label: NO_COMMAND, description: `The repository has no ${what} command.` },
    ],
    recommended: USE_DETECTED,
  };
}

/**
 * The questions the Producer answers to confirm or correct what was detected, in the order the
 * answers are read back: changelog format, commit pattern, test command, install command. [proposta]
 * CI and main branch are only told; nothing in the delivery depends on the Producer's word for them.
 */
export function conventionQuestions(detected: ProjectConventions): readonly Question[] {
  const summary = describeConventions(detected);
  const changelog = CHANGELOG_OPTIONS.find((entry) => entry.format === detected.changelog.format);
  const commit = COMMIT_OPTIONS.find((entry) => entry.style === detected.commit.style);
  return [
    {
      question: `${summary} Which changelog format does the project use?`,
      options: CHANGELOG_OPTIONS.map((entry) => entry.option),
      ...(changelog === undefined ? {} : { recommended: changelog.option.label }),
    },
    {
      question: 'Which pattern do the commit subjects follow?',
      options: COMMIT_OPTIONS.map((entry) => entry.option),
      ...(commit === undefined ? {} : { recommended: commit.option.label }),
    },
    commandQuestion('test', detected.commands.test),
    commandQuestion('install', detected.commands.install),
  ];
}

/** The option an answer picks: its label, its position (1, 2, ...) or its value, in any case. */
function pick<T>(
  answer: string | undefined,
  entries: readonly { readonly value: T; readonly label: string }[],
): T | undefined {
  const text = answer?.trim().toLowerCase();
  if (text === undefined || text === '') return undefined;
  const position = /^[1-9]$/.test(text) ? Number(text) - 1 : -1;
  return (
    entries[position]?.value ??
    entries.find(
      (entry) => entry.label.toLowerCase() === text || String(entry.value).toLowerCase() === text,
    )?.value
  );
}

function commandOf(
  answer: string | undefined,
  detected: ProjectCommand | undefined,
): ProjectCommand | undefined {
  const text = answer?.trim();
  if (text === undefined || text === '') return detected;
  if (text.toLowerCase() === USE_DETECTED.toLowerCase() || /^1$/.test(text)) return detected;
  if (text.toLowerCase() === NO_COMMAND.toLowerCase() || /^2$/.test(text)) {
    return undefined;
  }
  return cut(text, COMMAND_MAX);
}

/**
 * The conventions after the Producer's answers: what was answered replaces what was detected, what
 * was not answered (or not understood) stays. The result is `source: producer`, `confirmed: true`.
 * `answers` follow {@link conventionQuestions}.
 */
export function applyConventionAnswers(
  detected: ProjectConventions,
  answers: readonly string[],
): ProjectConventions {
  const format =
    pick(
      answers[0],
      CHANGELOG_OPTIONS.map((entry) => ({ value: entry.format, label: entry.option.label })),
    ) ?? detected.changelog.format;
  const style =
    pick(
      answers[1],
      COMMIT_OPTIONS.map((entry) => ({ value: entry.style, label: entry.option.label })),
    ) ?? detected.commit.style;
  const test = commandOf(answers[2], detected.commands.test);
  const install = commandOf(answers[3], detected.commands.install);
  return {
    ...detected,
    source: 'producer',
    confirmed: true,
    changelog:
      format === 'none'
        ? { format }
        : {
            format,
            ...(detected.changelog.file === undefined ? {} : { file: detected.changelog.file }),
          },
    commit: { ...detected.commit, style },
    commands: {
      ...(test === undefined ? {} : { test }),
      ...(install === undefined ? {} : { install }),
    },
  };
}

export interface ConventionConfirmerOptions {
  readonly store: Pick<Store, 'decisions' | 'scenarios'>;
  readonly board: QuestionBoard;
  readonly logger: Logger;
}

/**
 * Asks the Producer to confirm or correct the conventions detected in an imported repository, with
 * the question mechanism of the Director (a `producer_question` decision, shown by the chat and
 * answered with `answers`). The question does not hold anything up: a play that starts
 * before the answer uses what was detected, and the answer, when it comes, replaces it in
 * `scenarios.conventions`. A question nobody answered before the daemon stopped is asked again the
 * next time the chat opens, until the Producer has answered once.
 */
export class ConventionConfirmer {
  readonly #options: ConventionConfirmerOptions;
  readonly #open = new Map<string, Promise<void>>();

  constructor(options: ConventionConfirmerOptions) {
    this.#options = options;
  }

  /**
   * Opens the question for the scenario when its conventions are still unconfirmed, and returns
   * once it is there to be shown. Does nothing for a scenario that has none, one that is already
   * confirmed, and one that is already being asked.
   */
  async ask(scenarioId: string): Promise<boolean> {
    const { store, board } = this.#options;
    if (this.#open.has(scenarioId)) return false;
    const scenario = await store.scenarios.get(scenarioId);
    const detected = parseConventions(scenario?.conventions);
    if (detected === undefined || detected.confirmed) return false;

    const prefix = `${scenarioId}:conventions:`;
    for (const stale of await store.decisions.list({ scenarioId, states: ['pending'] })) {
      if (stale.id.startsWith(prefix) && !board.has(stale.id))
        await store.decisions.cancel(stale.id);
    }
    const id = `${prefix}${randomUUID().slice(0, 8)}`;
    await store.decisions.create({
      id,
      scenarioId,
      kind: DECISION_KINDS.question,
      input: { questions: JSON.parse(JSON.stringify(conventionQuestions(detected))) as JsonValue },
    });
    const waiting = board.wait(id);
    this.#open.set(scenarioId, this.#finish(scenarioId, id, detected, waiting));
    return true;
  }

  /** Resolves when the question of the scenario ended (answered or cancelled); for the tests. */
  settled(scenarioId: string): Promise<void> {
    return this.#open.get(scenarioId) ?? Promise.resolve();
  }

  async #finish(
    scenarioId: string,
    decisionId: string,
    detected: ProjectConventions,
    waiting: Promise<JsonValue>,
  ): Promise<void> {
    const { store, logger } = this.#options;
    try {
      const answer = await waiting;
      const raw =
        typeof answer === 'object' && answer !== null && !Array.isArray(answer)
          ? answer.answers
          : undefined;
      const answers = Array.isArray(raw)
        ? raw.map((item) => (typeof item === 'string' ? item : ''))
        : [];
      const confirmed = applyConventionAnswers(detected, answers);
      const patch: JsonObject = conventionsToJson(confirmed);
      await store.scenarios.update(scenarioId, { conventions: patch });
    } catch (error) {
      await store.decisions.cancel(decisionId).catch(() => undefined);
      logger.warn(
        { scenarioId, err: error instanceof Error ? error.message : String(error) },
        'The conventions of the project were not confirmed',
      );
    } finally {
      this.#open.delete(scenarioId);
    }
  }
}
