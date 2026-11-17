// SPDX-License-Identifier: MPL-2.0
import {
  assemblePrefix,
  type AttachmentRecord,
  type ClientAdapter,
  type EventEnvelope,
  type JsonObject,
  type PromptSource,
  type Registries,
  type Store,
  type Vcs,
} from '@otheater/core';
import type { DaemonConfig, PlayExecutor } from '../config.js';
import type { AttemptRunner } from '../execution/attempt-runner.js';
import type { Logger } from '../logger.js';
import { ToolFailure } from '../mcp/handlers.js';
import { resolveRolePolicy } from '../orchestration/role-policy.js';
import { executorOf, sessionSettingsOf } from '../orchestration/roles.js';
import type { DataPaths } from '../paths.js';
import { type AttachmentService, isImage } from './attachments.js';
import { CHAT_DECISION_KINDS, type ChatFlow } from './chat-flow.js';

export const CONSULTANT_ROLE = 'consultant';

/** What the consultation needs to know about the clients: which ones accept an image. */
export interface AdapterDirectory {
  adapterOf(client: string): ClientAdapter;
}

/** True when the client is known and declares that it accepts images (`capabilities.inputTypes`). */
export function acceptsImages(directory: AdapterDirectory, client: string): boolean {
  try {
    return directory.adapterOf(client).capabilities.inputTypes?.includes('image') ?? false;
  } catch {
    return false;
  }
}

export interface ConsultantChoice {
  readonly executor: PlayExecutor;
  /** Why this one, for the event and the Director. */
  readonly reason: string;
}

/**
 * [proposta] Which Executor answers a consultation. The candidates are the Executor of the role
 * (`orchestration.roles.consultant`, else `orchestration.executor`) and then
 * `scenarios.consultant_alternatives`, in that order. When an attachment is an image only a
 * candidate whose client accepts images qualifies (5.20: "uma imagem só vai a um Executor que
 * aceita imagem"); the first that qualifies wins. `undefined` when none does.
 */
export function chooseConsultant(
  candidates: readonly PlayExecutor[],
  needsImage: boolean,
  accepts: (client: string) => boolean,
): ConsultantChoice | undefined {
  for (const [index, executor] of candidates.entries()) {
    if (needsImage && !accepts(executor.client)) continue;
    const label =
      index === 0 ? 'the Executor of the role' : 'an alternative from the configuration';
    return {
      executor,
      reason: needsImage ? `${label}; it is the first that accepts images` : label,
    };
  }
  return undefined;
}

export interface ConsultServiceOptions {
  readonly store: Store;
  readonly vcs: Vcs;
  readonly runner: Pick<AttemptRunner, 'run'>;
  readonly adapters: AdapterDirectory;
  readonly registries: Registries;
  readonly prompts: PromptSource;
  readonly config: DaemonConfig;
  readonly paths: Pick<DataPaths, 'profiles'>;
  readonly attachments: AttachmentService;
  readonly chatFlow: ChatFlow;
  readonly logger: Logger;
}

export interface ConsultInput {
  readonly question: string;
  readonly attachments?: readonly string[] | undefined;
  readonly reason?: string | undefined;
}

function answerOf(output: unknown): string | undefined {
  const result =
    typeof output === 'object' && output !== null
      ? (output as { result?: unknown }).result
      : output;
  if (typeof result === 'string' && result.trim() !== '') return result;
  if (typeof result === 'object' && result !== null) {
    const { answer } = result as { answer?: unknown };
    if (typeof answer === 'string' && answer.trim() !== '') return answer;
    return JSON.stringify(result);
  }
  return undefined;
}

/**
 * The `consult` tool of the Director (architecture 5.20): opens a Consultant, a strong Actor of the
 * role `consultant`, on the question; the answer comes back as the result of the call. The
 * Director's call stays open until then, so the chat is CONSULTING: `chat.consult` is a pending
 * decision and `scenario.chat_transitioned` records IDLE -> CONSULTING -> IDLE. [proposta] The
 * Consultant runs the way any attempt does (its own worktree of the scenario folder, read-only
 * tools, `submit(result)` to finish), under the id `<scenario>/consult-<n>/1`; the worktree is
 * removed after the answer.
 */
export class ConsultService {
  readonly #options: ConsultServiceOptions;

  constructor(options: ConsultServiceOptions) {
    this.#options = options;
  }

  async consult(scenarioId: string, input: ConsultInput): Promise<JsonObject | ToolFailure> {
    const { store, config, adapters, chatFlow, logger } = this.#options;
    const scenario = await store.scenarios.get(scenarioId);
    if (scenario === undefined) return new ToolFailure('no_scenario', 'The scenario is gone.');
    const records: AttachmentRecord[] = [];
    for (const id of input.attachments ?? []) {
      const record = await store.attachments.get(scenarioId, id);
      if (record === undefined) {
        return new ToolFailure('unknown_attachment', `The scenario has no attachment "${id}".`);
      }
      records.push(record);
    }
    const candidates = [
      executorOf(config, CONSULTANT_ROLE),
      ...config.scenarios.consultant_alternatives,
    ].filter((executor): executor is PlayExecutor => executor !== undefined);
    if (candidates.length === 0) {
      return new ToolFailure(
        'no_consultant',
        'No Executor is configured for the consultant: set orchestration.executor or orchestration.roles.consultant.',
      );
    }
    const needsImage = records.some((record) => isImage(record.mime));
    const choice = chooseConsultant(candidates, needsImage, (client) =>
      acceptsImages(adapters, client),
    );
    if (choice === undefined) {
      return new ToolFailure(
        'no_executor_for_attachments',
        'An attachment is an image and no Executor configured for the consultant accepts images. Add one to scenarios.consultant_alternatives, or answer without the image.',
      );
    }

    const number =
      (await store.decisions.list({ scenarioId, kinds: [CHAT_DECISION_KINDS.consult] })).length + 1;
    const decisionId = `${scenarioId}:consult:${String(number)}`;
    const executorName = `${choice.executor.client}/${choice.executor.profile}`;
    await store.decisions.create({
      id: decisionId,
      scenarioId,
      kind: CHAT_DECISION_KINDS.consult,
      input: {
        question: input.question,
        attachments: records.map((record) => record.id),
        executor: executorName,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    });
    await chatFlow.sync(scenarioId, 'consult', {
      decisionId,
      executor: executorName,
      reason: choice.reason,
    });
    try {
      const answer = await this.#run(
        scenarioId,
        scenario.folder,
        number,
        choice.executor,
        input,
        records,
      );
      if (typeof answer === 'string') {
        await store.decisions.decide(decisionId, { answer: { answer }, decidedBy: 'daemon' });
        await chatFlow.sync(scenarioId, 'consult_answered', { decisionId });
        return { answer };
      }
      await store.decisions.cancel(decisionId).catch(() => undefined);
      await chatFlow.sync(scenarioId, 'consult_failed', { decisionId, reason: answer.reason });
      return new ToolFailure('consult_failed', answer.reason);
    } catch (error) {
      logger.error({ err: error, scenarioId, decisionId }, 'the consultation failed');
      await store.decisions.cancel(decisionId).catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      await chatFlow.sync(scenarioId, 'consult_failed', { decisionId, reason });
      return new ToolFailure('consult_failed', `The consultation could not run: ${reason}`);
    }
  }

  /** Runs the Consultant; the answer, or the reason there is none. */
  async #run(
    scenarioId: string,
    folder: string,
    number: number,
    executor: PlayExecutor,
    input: ConsultInput,
    records: readonly AttachmentRecord[],
  ): Promise<string | { readonly reason: string }> {
    const { store, vcs, runner, registries, prompts, paths, config } = this.#options;
    const repos = await store.scenarioRepos.list(scenarioId);
    const scenario = await store.scenarios.get(scenarioId);
    const prefix = assemblePrefix({
      role: CONSULTANT_ROLE,
      rolePrompt: await prompts.get(CONSULTANT_ROLE),
      tools: registries.tools.list(),
    });
    const attachmentLine = records.map((record) => record.id).join(',');
    const body = [
      `#ot-role: ${CONSULTANT_ROLE}`,
      `#ot-consult-ask: ${input.question}`,
      ...(records.length === 0 ? [] : [`#ot-attachments: ${attachmentLine}`]),
      '',
      'The Director asks you a question from the chat with the Producer.',
      '',
      `Question: ${input.question}`,
      ...(input.reason === undefined ? [] : ['', `Why the Director asks: ${input.reason}`]),
      ...(records.length === 0
        ? []
        : [
            '',
            'Attachments (read each one with `read_attachment`):',
            ...records.map(
              (record) =>
                `- ${record.id}: ${record.name} (${record.mime}, ${String(record.size)} bytes)`,
            ),
          ]),
      '',
      'Answer with `submit` as `{ "result": { "answer": "<your answer>" } }`.',
    ].join('\n');
    const { profile, executor: settings } = sessionSettingsOf(paths, executor);
    const mark = await store.events.lastId();
    const outcome = await runner.run({
      playId: scenarioId,
      demandId: `consult-${String(number)}`,
      attempt: 1,
      repo: repos[0]?.path ?? folder,
      base: repos[0]?.mainBranch ?? scenario?.baseBranch ?? 'main',
      profile,
      executor: settings,
      policy: await resolveRolePolicy(
        { config, scenarios: store.scenarios, tools: () => registries.tools.list() },
        CONSULTANT_ROLE,
        scenarioId,
      ),
      prompt: `${prefix}\n${body}`,
      role: CONSULTANT_ROLE,
    });
    await vcs.removeWorktree(outcome.worktree, { force: true }).catch(() => undefined);
    if (outcome.state !== 'completed') {
      return {
        reason: `The consultant session ${outcome.state}${outcome.cause === undefined ? '' : `: ${outcome.cause}`}.`,
      };
    }
    const submission = await this.#submissionOf(outcome.attemptId, mark);
    if (submission === undefined) {
      return { reason: 'The consultant ended its turn without calling `submit`.' };
    }
    if (submission.kind === 'failed') return { reason: submission.errors };
    return answerOf(submission.output) ?? { reason: 'The consultant submitted an empty answer.' };
  }

  async #submissionOf(
    attemptId: string,
    mark: number,
  ): Promise<
    { kind: 'submitted'; output: unknown } | { kind: 'failed'; errors: string } | undefined
  > {
    const { events } = this.#options.store;
    let after = mark;
    let found:
      { kind: 'submitted'; output: unknown } | { kind: 'failed'; errors: string } | undefined;
    for (;;) {
      const page: readonly EventEnvelope[] = await events.readFrom(after, 500);
      if (page.length === 0) return found;
      for (const event of page) {
        after = event.id;
        const payload = event.payload as Record<string, unknown>;
        if (payload.attemptId !== attemptId) continue;
        if (event.type === 'attempt.submitted')
          found = { kind: 'submitted', output: payload.output };
        else if (event.type === 'attempt.submit_failed') {
          found = { kind: 'failed', errors: String(payload.errors) };
        }
      }
    }
  }
}
