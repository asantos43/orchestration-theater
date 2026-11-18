// SPDX-License-Identifier: MPL-2.0
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assemblePrefix,
  type AttachmentRecord,
  type ClientAdapter,
  confinePath,
  type EventEnvelope,
  type ExecutorConfig,
  type JsonObject,
  type PathHost,
  type Profile,
  type PromptSource,
  type Registries,
  ShellToolRefusal,
  type Store,
  supportsMerge,
  type Vcs,
} from '@otheater/core';
import type { DaemonConfig, PlayExecutor } from '../config.js';
import type { AttemptRunner } from '../execution/attempt-runner.js';
import type { Logger } from '../logger.js';
import { ToolFailure } from '../mcp/handlers.js';
import { resolveRolePolicy } from '../orchestration/role-policy.js';
import type { RoleSelection } from '../orchestration/role-selection.js';
import { sessionSettingsOf } from '../orchestration/roles.js';
import type { DataPaths } from '../paths.js';
import { nodePathHost } from '../tools/host.js';
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

/** What an Executor that is not accepted for an image says (the selector's `invalid` detail). */
const IMAGE_REFUSAL = 'attachment_image_not_accepted';

/** The Executor a consultation runs with and why it was chosen. */
interface ConsultantExecutor {
  readonly profile: Profile;
  readonly settings: ExecutorConfig;
  /** Why this one, for the event and the Director. */
  readonly reason: string;
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
  /** The choice of the Executor of the consultant (P16). */
  readonly selection: Pick<RoleSelection, 'once'>;
  readonly logger: Logger;
  /** The file system the confinement of the consultant's files asks about. Default: the machine's. */
  readonly host?: PathHost | undefined;
}

/**
 * What became of the files the consultant wrote in its worktree (`scenarios.consultant_writes`):
 * `none` it wrote nothing, `merged` they are in the chat folder now, `kept` they wait on `branch`,
 * `discarded` they were dropped on purpose, `conflict` the merge would conflict (they wait on
 * `branch`), `refused` a path left the folder or touched what is the daemon's (they wait on `branch`).
 */
export interface ConsultWork {
  readonly outcome: 'none' | 'merged' | 'kept' | 'discarded' | 'conflict' | 'refused';
  readonly files: readonly string[];
  readonly branch?: string;
  readonly reason?: string;
}

/** Paths of the chat folder the consultant never changes: the copies of the attachments and git's own. */
const RESERVED_ROOTS: readonly string[] = ['attachments', '.git'];

function isReserved(file: string): boolean {
  const first = file.split('/')[0] ?? '';
  return RESERVED_ROOTS.includes(first);
}

/** What the Director is told when the consultant's files did not reach the folder; `undefined` when nothing is amiss. */
function noticeOf(work: ConsultWork): string | undefined {
  const where = work.branch === undefined ? '' : ` They are on the branch ${work.branch}.`;
  switch (work.outcome) {
    case 'kept':
      return `The files the consultant wrote were not put in the chat folder (scenarios.consultant_writes is "keep").${where}`;
    case 'conflict':
      return `The files the consultant wrote conflict with the chat folder and were not merged (${work.reason ?? 'conflict'}).${where}`;
    case 'refused':
      return `The files the consultant wrote were refused (${work.reason ?? 'a path is not allowed'}).${where}`;
    default:
      return undefined;
  }
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
 * Consultant runs the way any attempt does (its own worktree of the scenario folder, `submit(result)`
 * to finish), under the id `<scenario>/consult-<n>/1`. It writes only there; after the answer the
 * worktree is removed and what it wrote goes where `scenarios.consultant_writes` says (P10, N86):
 * `merge` (default) into the chat folder, only after each changed path is confined to the folder
 * (`confinePath` of the shell tools) and none is reserved (`attachments/`, `.git`).
 */
export class ConsultService {
  readonly #options: ConsultServiceOptions;
  readonly #host: PathHost;
  /** One merge into a chat folder at a time (a folder is one git working tree). */
  #merges: Promise<unknown> = Promise.resolve();

  constructor(options: ConsultServiceOptions) {
    this.#options = options;
    this.#host = options.host ?? nodePathHost();
  }

  async consult(scenarioId: string, input: ConsultInput): Promise<JsonObject | ToolFailure> {
    const { store, chatFlow, logger } = this.#options;
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
    const needsImage = records.some((record) => isImage(record.mime));
    const choice = await this.#choose(scenarioId, needsImage);
    if (choice instanceof ToolFailure) return choice;

    const number =
      (await store.decisions.list({ scenarioId, kinds: [CHAT_DECISION_KINDS.consult] })).length + 1;
    const decisionId = `${scenarioId}:consult:${String(number)}`;
    const executorName = choice.profile.id;
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
      const answer = await this.#run(scenarioId, scenario.folder, number, choice, input, records);
      if ('answer' in answer) {
        const { work } = answer;
        const record: JsonObject = {
          answer: answer.answer,
          work: { ...work, files: [...work.files] },
        };
        await store.decisions.decide(decisionId, { answer: record, decidedBy: 'daemon' });
        await chatFlow.sync(scenarioId, 'consult_answered', { decisionId });
        const merged = work.outcome === 'merged' && work.files.length > 0;
        const notice = noticeOf(work);
        return {
          answer: answer.answer,
          ...(merged ? { files: [...work.files] } : {}),
          ...(notice === undefined ? {} : { notice }),
        };
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

  /**
   * The Executor of a consultation (P16): the selector with the role `consultant` (the list of the
   * role, the override of the scenario, quota and slots) and, when it finds nobody, the
   * alternatives of `scenarios.consultant_alternatives`. An image only goes to an Executor whose
   * client accepts images (5.20). A consultation does not wait for quota: the Director is told
   * who it waits for and can ask again, or go on without.
   */
  async #choose(
    scenarioId: string,
    needsImage: boolean,
  ): Promise<ConsultantExecutor | ToolFailure> {
    const { selection, adapters, config, paths } = this.#options;
    const once = await selection.once({
      role: CONSULTANT_ROLE,
      scenarioId,
      refuse: needsImage
        ? (item) => (acceptsImages(adapters, item.entry.client) ? null : IMAGE_REFUSAL)
        : undefined,
    });
    if (once.kind === 'selected') {
      return {
        profile: once.profile,
        settings: once.settings,
        reason: needsImage
          ? 'chosen by the selector; it is the first that accepts images'
          : 'chosen by the selector for the role',
      };
    }
    const alternative = chooseConsultant(
      config.scenarios.consultant_alternatives,
      needsImage,
      (client) => acceptsImages(adapters, client),
    );
    if (alternative !== undefined) {
      const { profile, executor: settings } = sessionSettingsOf(paths, alternative.executor);
      return { profile, settings, reason: alternative.reason };
    }
    if (once.kind === 'waiting')
      return new ToolFailure('executor_waiting', `The consultant is ${once.reason}.`);
    const imageOnly = once.result.skipped.some((item) => item.detail === IMAGE_REFUSAL);
    if (needsImage && imageOnly) {
      return new ToolFailure(
        'no_executor_for_attachments',
        'An attachment is an image and no Executor configured for the consultant accepts images. Add one to scenarios.consultant_alternatives, or answer without the image.',
      );
    }
    return new ToolFailure('no_consultant', once.reason);
  }

  /** Runs the Consultant; the answer, or the reason there is none. */
  async #run(
    scenarioId: string,
    folder: string,
    number: number,
    executor: ConsultantExecutor,
    input: ConsultInput,
    records: readonly AttachmentRecord[],
  ): Promise<
    { readonly answer: string; readonly work: ConsultWork } | { readonly reason: string }
  > {
    const { store, vcs, runner, registries, prompts, config } = this.#options;
    const repos = await store.scenarioRepos.list(scenarioId);
    const scenario = await store.scenarios.get(scenarioId);
    const base = repos[0]?.mainBranch ?? scenario?.baseBranch ?? 'main';
    // The commit the consultant starts from: what its changes are measured against, even when
    // another consultation merges into the folder in the meantime.
    const baseSha = repos[0] === undefined ? await vcs.headOf(folder) : undefined;
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
    const { profile, settings } = executor;
    const mark = await store.events.lastId();
    const outcome = await runner.run({
      playId: scenarioId,
      demandId: `consult-${String(number)}`,
      attempt: 1,
      repo: repos[0]?.path ?? folder,
      base: baseSha ?? base,
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
    const submission =
      outcome.state === 'completed' ? await this.#submissionOf(outcome.attemptId, mark) : undefined;
    const answer = submission?.kind === 'submitted' ? answerOf(submission.output) : undefined;
    // The work is taken only from a consultation that answered; any other leaves nothing behind.
    const work = await this.#takeWork(
      scenarioId,
      folder,
      outcome,
      answer === undefined ? 'discard' : config.scenarios.consultant_writes,
      baseSha ?? base,
    );
    if (outcome.state !== 'completed') {
      return {
        reason: `The consultant session ${outcome.state}${outcome.cause === undefined ? '' : `: ${outcome.cause}`}.`,
      };
    }
    if (submission === undefined) {
      return { reason: 'The consultant ended its turn without calling `submit`.' };
    }
    if (submission.kind === 'failed') return { reason: submission.errors };
    return answer === undefined
      ? { reason: 'The consultant submitted an empty answer.' }
      : { answer, work };
  }

  /**
   * Puts the worktree of the consultant to rest and moves what it wrote where `mode` says. The
   * worktree is always removed; the branch stays only when the work waits on it (`keep`, a
   * conflict, a refusal). Never throws: a failure here must not lose the answer.
   */
  async #takeWork(
    scenarioId: string,
    folder: string,
    outcome: { readonly worktree: string; readonly branch: string; readonly attemptId: string },
    mode: 'merge' | 'keep' | 'discard',
    base: string,
  ): Promise<ConsultWork> {
    const { vcs, logger } = this.#options;
    const { worktree, branch } = outcome;
    const drop = async (deleteBranch: boolean): Promise<void> => {
      await vcs.removeWorktree(worktree, { force: true, deleteBranch }).catch((error: unknown) => {
        logger.warn({ err: error, scenarioId, worktree }, 'the consultant worktree stayed');
      });
    };
    try {
      if (mode === 'discard') {
        await drop(true);
        return { outcome: 'discarded', files: [] };
      }
      await vcs.commitAll(worktree, `consult: ${outcome.attemptId}`);
      const stat = await vcs.diffStat(worktree, base);
      const files = stat.files.map((file) => file.path);
      if (files.length === 0) {
        await drop(true);
        return { outcome: 'none', files: [] };
      }
      if (mode === 'keep') {
        await drop(false);
        return { outcome: 'kept', files, branch };
      }
      const refusal = await this.#refusalOf(worktree, files);
      if (refusal !== undefined) {
        await drop(false);
        logger.warn({ scenarioId, branch, reason: refusal }, 'the consultant files were refused');
        return { outcome: 'refused', files, branch, reason: refusal };
      }
      if (!supportsMerge(vcs)) {
        await drop(false);
        return { outcome: 'kept', files, branch, reason: 'the Vcs adapter cannot merge' };
      }
      const merged = await this.#serialized(async () => {
        await excludeAttachments(folder);
        await vcs.commitAll(folder, `chat: state of the folder before ${outcome.attemptId}`);
        return vcs.merge(folder, branch, { message: `consult: ${outcome.attemptId}` });
      });
      if (merged.kind === 'conflict') {
        await drop(false);
        return { outcome: 'conflict', files, branch, reason: merged.files.join(', ') };
      }
      await drop(true);
      return { outcome: 'merged', files };
    } catch (error) {
      logger.error({ err: error, scenarioId, branch }, 'the consultant work could not be taken');
      await drop(false);
      return {
        outcome: 'refused',
        files: [],
        branch,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Why the changed paths cannot reach the folder, or `undefined` when each is allowed. */
  async #refusalOf(worktree: string, files: readonly string[]): Promise<string | undefined> {
    for (const file of files) {
      if (isReserved(file)) return `"${file}" is reserved (${RESERVED_ROOTS.join(', ')})`;
      try {
        await confinePath(this.#host, worktree, join(worktree, file));
      } catch (error) {
        if (error instanceof ShellToolRefusal) return `"${file}": ${error.message}`;
        throw error;
      }
    }
    return undefined;
  }

  #serialized<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#merges.then(step, step);
    this.#merges = run.catch(() => undefined);
    return run;
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

/**
 * Keeps `attachments/` out of git in the chat folder (`.git/info/exclude`), so the copies the
 * daemon makes never make the folder dirty for a merge nor end up in the history. Idempotent.
 */
async function excludeAttachments(folder: string): Promise<void> {
  const info = join(folder, '.git', 'info');
  const file = join(info, 'exclude');
  const line = '/attachments/';
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split('\n').includes(line)) return;
  await mkdir(info, { recursive: true });
  await appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${line}\n`);
}
