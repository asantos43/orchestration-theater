// SPDX-License-Identifier: MPL-2.0
import {
  isSecretPath,
  renderContinuationOrders,
  supportsDiff,
  type DecisionRecord,
  type DemandRecord,
  type DiffStat,
  type EventEnvelope,
  type EventLog,
  type Store,
  type Vcs,
} from '@otheater/core';
import {
  SessionUpdatePayloadSchema,
  ToolCalledPayloadSchema,
  ToolFinishedPayloadSchema,
  type ToolOutcome,
} from '@otheater/protocol';
import { effectsOf, openEffectsOf, type AttemptEffect } from '../workspace/effects-of.js';
import type { PackageSettings } from './settings.js';

/**
 * The continuation package (architecture 5.16, "Pacote de continuação"; Phase 5, P18): what a new
 * session gets when the work of an interrupted attempt passes to another Executor. It is built
 * from the records of the store (the demand, the orders in force now, the event log of the attempt,
 * the effects registry, the git state), never from what a model remembers, and it is deterministic:
 * the same records give the same text.
 *
 * Five parts, in this order (the text of `renderContinuationPackage`):
 *
 * 1. The stable prefix of the role, then the demand with its contract and acceptance criteria, and
 *    the orders in force at the moment of the resume (`## Orders in force now`), not the ones the
 *    first session started with.
 * 2. The worktree: the last checkpoint commit and the difference against the base.
 * 3. The summary of the trajectory (`summarizeTrajectory`): files read and edited, commands and
 *    tests with their result, the framework tools, the last message of the previous Executor and
 *    the decisions the Producer already answered.
 * 4. The effects already executed (P22, `side_effects`), and the ones started with no known end.
 * 5. The reason, and the instruction: continue from this state, do not redo what is concluded.
 *
 * The cheap model of N126 (`resume.package.summarize: director_model`) is a port
 * (`PackageSummarizer`): its text is added next to the deterministic summary, which always stays,
 * as the source of truth. Nothing in the package may hold a secret: `scrubPackageText` masks the
 * known shapes of keys and tokens and replaces every path of the secret list, and the lists of
 * files leave those paths out.
 */

const MASK = '[REDACTED]';
const SECRET_PATH_MARK = '[secret path]';

/** The shapes of a credential that is recognised by its form alone. */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** `NAME=value`, `NAME: value` and `"name": "value"` for a name that says it is a secret. */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|credential|private[_-]?key|authorization)[A-Za-z0-9_.-]*"?)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi;

/**
 * Masks what looks like a credential in `text`: keys and tokens by their form (OpenAI and Anthropic
 * `sk-`, GitHub, Slack, AWS, JWT, `Bearer`, PEM private keys) and the value of an assignment whose
 * name says secret (`API_KEY=...`). Pure and idempotent. It is a net, not a proof: the paths of
 * the secret list are the other half (`scrubPackageText`).
 */
export function maskSecrets(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, MASK);
  return out.replace(
    SECRET_ASSIGNMENT,
    (_all, name: string, sep: string) => `${name}${sep}${MASK}`,
  );
}

/** Where the secret paths come from (`security.secret_paths`, already resolved against the home). */
export interface SecretScope {
  /** `resolveSecretPaths(...)`; empty means the daemon was not told, and no path is judged secret. */
  readonly secretPaths: readonly string[];
  /** Absolute home, to read `~/x` in a command or a message. */
  readonly home?: string | undefined;
}

/** A token of `text` that is a path of the secret list (a `~/` is read against `scope.home`). */
function isSecretToken(token: string, scope: SecretScope): boolean {
  if (scope.secretPaths.length === 0) return false;
  const bare = token.replace(/[.:!?]+$/, '');
  if (bare.length === 0) return false;
  const expanded =
    scope.home !== undefined && (bare === '~' || bare.startsWith('~/'))
      ? `${scope.home}${bare.slice(1)}`
      : bare;
  return isSecretPath(expanded, scope.secretPaths);
}

/** Whether any token of `text` (a command line, a title) names a path of the secret list. */
export function touchesSecretPath(text: string, scope: SecretScope): boolean {
  return (text.match(PATH_TOKEN) ?? []).some((token) => isSecretToken(token, scope));
}

const PATH_TOKEN = /[^\s"'`<>()[\]{},;|&=]+/g;

/** `maskSecrets`, and every path of the secret list written as `[secret path]`. */
export function scrubPackageText(text: string, scope: SecretScope): string {
  const masked = maskSecrets(text);
  if (scope.secretPaths.length === 0) return masked;
  return masked.replace(PATH_TOKEN, (token) =>
    isSecretToken(token, scope) ? SECRET_PATH_MARK : token,
  );
}

// ---------------------------------------------------------------------------------------------
// The log of the attempt.
// ---------------------------------------------------------------------------------------------

const PAGE = 500;

/** The events of one attempt, in log order (the log is read in pages and filtered by `attemptId`). */
export async function readAttemptEvents(
  events: Pick<EventLog, 'readFrom'>,
  attemptId: string,
): Promise<readonly EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  let after = 0;
  for (;;) {
    const page = await events.readFrom(after, PAGE);
    for (const envelope of page) if (envelope.attemptId === attemptId) out.push(envelope);
    const last = page.at(-1);
    if (last === undefined || page.length < PAGE) return out;
    after = last.id;
  }
}

/** A command the Executor ran through its own tool (`toolKind: execute`). */
export interface TrajectoryCommand {
  readonly command: string;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** The command looks like a test run (`vitest`, `pytest`, `cargo test`...). */
  readonly test: boolean;
}

/** A call of a framework tool (`run_tests`, `git_commit`...), from `tool.called` and `tool.finished`. */
export interface TrajectoryFrameworkCall {
  readonly tool: string;
  readonly summary: string;
  readonly outcome: ToolOutcome | 'unfinished';
}

/** The deterministic summary of what an attempt did so far. */
export interface TrajectorySummary {
  /** Paths the Executor read or searched, relative to the worktree, in order of first appearance. */
  readonly filesRead: readonly string[];
  /** Paths it edited, deleted or moved. */
  readonly filesEdited: readonly string[];
  /** Titles of edits whose client gave no path (a client that only says `Write <file>`). */
  readonly editTitles: readonly string[];
  readonly commands: readonly TrajectoryCommand[];
  readonly frameworkCalls: readonly TrajectoryFrameworkCall[];
  /** The last message the Executor wrote: the last run of text chunks, cut to its end. */
  readonly lastMessage: string;
  /** How many paths and commands were left out for touching the secret list. */
  readonly withheld: number;
  /** How many events of the attempt the summary read. */
  readonly events: number;
}

export interface TrajectoryOptions extends SecretScope {
  /** The worktree of the attempt, to show paths relative to it. */
  readonly worktree: string;
  /** Characters of the last message kept (its end). Default 1500. */
  readonly messageChars?: number;
}

const TEST_COMMAND =
  /\b(?:vitest|jest|mocha|ava|pytest|phpunit|ctest|cargo\s+test|go\s+test|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test)\b/i;

interface CallState {
  title: string;
  kind: string;
  status: TrajectoryCommand['status'];
  paths: string[];
}

function relativeTo(worktree: string, path: string): string {
  const root = worktree.endsWith('/') ? worktree : `${worktree}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * The summary of the trajectory of an attempt from its events (`session.update`, `tool.called`,
 * `tool.finished`), in order. Pure: the same events give the same summary. A tool call is told
 * apart by session and `toolCallId` (the ids restart in a new session), and its updates are merged
 * into it. What touches the secret list (a path, or a command line that names one) is left out and
 * counted in `withheld`; the free text that stays is masked.
 */
export function summarizeTrajectory(
  events: readonly EventEnvelope[],
  options: TrajectoryOptions,
): TrajectorySummary {
  const calls = new Map<string, CallState>();
  const framework = new Map<
    string,
    { tool: string; summary: string; outcome: ToolOutcome | 'unfinished' }
  >();
  let run = '';
  let lastMessage = '';
  const endRun = (): void => {
    if (run.trim().length > 0) lastMessage = run;
    run = '';
  };

  for (const envelope of events) {
    switch (envelope.type) {
      case 'session.update': {
        const parsed = SessionUpdatePayloadSchema.safeParse(envelope.payload);
        if (!parsed.success) break;
        const { sessionId, update } = parsed.data;
        if (update.kind === 'agent_message_chunk') {
          if (update.content.type === 'text') run += update.content.text;
        } else if (update.kind === 'tool_call') {
          endRun();
          calls.set(`${sessionId}:${update.toolCallId}`, {
            title: update.title,
            kind: update.toolKind,
            status: update.status,
            paths: (update.locations ?? []).map((location) => location.path),
          });
        } else if (update.kind === 'tool_call_update') {
          const call = calls.get(`${sessionId}:${update.toolCallId}`);
          if (call === undefined) break;
          if (update.title !== undefined) call.title = update.title;
          if (update.toolKind !== undefined) call.kind = update.toolKind;
          if (update.status !== undefined) call.status = update.status;
          for (const location of update.locations ?? []) pushUnique(call.paths, location.path);
        } else if (update.kind === 'plan') {
          endRun();
        }
        break;
      }
      case 'session.opened':
      case 'session.closed':
      case 'session.interrupted':
      case 'session.resumed':
        endRun();
        break;
      case 'tool.called': {
        const parsed = ToolCalledPayloadSchema.safeParse(envelope.payload);
        if (parsed.success) {
          framework.set(parsed.data.callId, {
            tool: parsed.data.tool,
            summary: parsed.data.summary,
            outcome: 'unfinished',
          });
        }
        break;
      }
      case 'tool.finished': {
        const parsed = ToolFinishedPayloadSchema.safeParse(envelope.payload);
        const call = parsed.success ? framework.get(parsed.data.callId) : undefined;
        if (parsed.success && call !== undefined) call.outcome = parsed.data.outcome;
        break;
      }
      default:
        break;
    }
  }
  endRun();

  const filesRead: string[] = [];
  const filesEdited: string[] = [];
  const editTitles: string[] = [];
  const commands: TrajectoryCommand[] = [];
  let withheld = 0;
  const scope: SecretScope = { secretPaths: options.secretPaths, home: options.home };
  for (const call of calls.values()) {
    const paths = call.paths.map((path) => relativeTo(options.worktree, path));
    const kept = paths.filter((path) => !isSecretToken(path, scope));
    withheld += paths.length - kept.length;
    if (call.kind === 'read' || call.kind === 'search') {
      for (const path of kept) pushUnique(filesRead, path);
    } else if (call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move') {
      for (const path of kept) pushUnique(filesEdited, path);
      if (paths.length === 0) {
        if (touchesSecretPath(call.title, scope)) withheld += 1;
        else pushUnique(editTitles, maskSecrets(call.title));
      }
    } else if (call.kind === 'execute') {
      if (touchesSecretPath(call.title, scope)) {
        withheld += 1;
        continue;
      }
      commands.push({
        command: maskSecrets(call.title),
        status: call.status,
        test: TEST_COMMAND.test(call.title),
      });
    }
  }

  const frameworkCalls: TrajectoryFrameworkCall[] = [];
  for (const call of framework.values()) {
    if (touchesSecretPath(call.summary, scope)) {
      withheld += 1;
      continue;
    }
    frameworkCalls.push({
      tool: call.tool,
      summary: maskSecrets(call.summary),
      outcome: call.outcome,
    });
  }

  const limit = options.messageChars ?? 1500;
  const message = scrubPackageText(lastMessage.trim(), scope);
  return {
    filesRead,
    filesEdited,
    editTitles,
    commands,
    frameworkCalls,
    lastMessage: message.length > limit ? `...${message.slice(message.length - limit)}` : message,
    withheld,
    events: events.length,
  };
}

// ---------------------------------------------------------------------------------------------
// The package.
// ---------------------------------------------------------------------------------------------

/** A decision the Producer already answered, so the new session does not ask it again. */
export interface AnsweredDecision {
  readonly id: string;
  readonly kind: string;
  /** The question's input, as compact JSON, cut. */
  readonly input: string;
  /** The answer, as compact JSON, cut. */
  readonly answer: string;
}

/** The state of the worktree of the attempt. */
export interface PackageWorktree {
  readonly branch: string;
  /** The base the attempt branch was cut from; absent when the runner does not know it. */
  readonly base: string | undefined;
  /** The last checkpoint commit. */
  readonly checkpoint: string | null;
  /** The difference against the base (`diff: stat` and `full`); absent when there is no base. */
  readonly stat: DiffStat | undefined;
  /** The text of the difference (`diff: full`); `truncated` says it was cut. */
  readonly diff: { readonly text: string; readonly truncated: boolean } | undefined;
}

/** Why the work changes hands. */
export interface PackageReason {
  readonly cause: string;
  /** The text the policy gave (`InterruptionDecision.reason`). */
  readonly policy: string;
  readonly detail: string;
  readonly from: string;
  readonly to: string;
}

/** What the package says to do: `continue` (the default) or `redo` (a role with a short output). */
export type PackageInstruction = 'continue' | 'redo';

export interface ContinuationPackage {
  readonly attemptId: string;
  readonly role: string | undefined;
  /** The stable prefix of the role (5.10), as it is now. */
  readonly prefix: string;
  /** The first prompt of the attempt with the prefix taken out; empty when it is not known. */
  readonly task: string;
  readonly demand: DemandRecord | undefined;
  /** `## Orders in force now`, from the directives in force at this moment; absent when none. */
  readonly orders: string | undefined;
  readonly worktree: PackageWorktree;
  readonly trajectory: TrajectorySummary;
  readonly decisions: readonly AnsweredDecision[];
  /** Effects executed (`done`): what a new session must not do again. */
  readonly effects: readonly AttemptEffect[];
  /** Effects started with no known end (`pending` or `ambiguous`). */
  readonly openEffects: readonly AttemptEffect[];
  readonly reason: PackageReason;
  readonly instruction: PackageInstruction;
  /** What the cheap model wrote (`summarize: director_model`); the deterministic summary stays. */
  readonly modelSummary: string | undefined;
}

/** What the package needs besides the store: the repository, and the secret list. */
export interface PackageDeps extends SecretScope {
  readonly store: Store;
  readonly vcs: Vcs;
}

/** What `gatherContinuationPackage` is asked for. */
export interface PackageRequest {
  readonly attemptId: string;
  readonly playId: string;
  readonly demandId: string;
  readonly role: string | undefined;
  readonly worktree: string;
  readonly branch: string;
  readonly base: string | undefined;
  readonly checkpoint: string | null;
  /** The prompt the attempt started with (prefix and task); empty when it is not known. */
  readonly firstPrompt: string;
  /** The stable prefix of the role, now (`HandoffPort.prefixOf`). */
  readonly prefix: string;
  readonly reason: PackageReason;
  readonly settings: PackageSettings;
}

/** The port of the cheap model of N126; the daemon wires it to the model of the Director. */
export interface PackageSummarizer {
  /**
   * Writes a short summary of `deterministic` (the summary of the trajectory, already masked).
   * Rejecting is fine: the package keeps the deterministic summary alone.
   */
  summarize(input: {
    readonly role: string | undefined;
    readonly demand: string;
    readonly deterministic: string;
  }): Promise<string>;
}

const CUT = 300;

function compact(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > CUT ? `${text.slice(0, CUT)}...` : text;
}

function answeredBy(records: readonly DecisionRecord[]): AnsweredDecision[] {
  return records
    .filter((record) => record.decidedBy === 'producer' && record.answer !== null)
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      input: compact(record.input),
      answer: compact(record.answer),
    }));
}

/** The task of the attempt: the first prompt without the stable prefix it started with. */
function taskOf(firstPrompt: string, prefix: string): string {
  if (prefix.length > 0 && firstPrompt.startsWith(prefix))
    return firstPrompt.slice(prefix.length).trim();
  return firstPrompt.trim();
}

/**
 * Builds the package from the store. Reads, in this order and each once: the play (for the
 * scenario), the demand, the orders in force now, the git state, the log of the attempt, the
 * decisions the Producer answered, and the effects registry. The orders are the ones in force at
 * this moment, which is what the resume needs (an order revoked after the attempt began is gone,
 * one given since is there).
 */
export async function gatherContinuationPackage(
  deps: PackageDeps,
  request: PackageRequest,
  summarizer?: PackageSummarizer,
): Promise<ContinuationPackage> {
  const { store, vcs } = deps;
  const { settings } = request;
  const play = await store.plays.get(request.playId);
  const demand = await store.demands.get(request.playId, request.demandId);

  let orders: string | undefined;
  if (play !== undefined) {
    const directives = await store.directives.inForce({
      scenarioId: play.scenarioId,
      ...(request.role === undefined ? {} : { role: request.role }),
    });
    orders = renderContinuationOrders(request.role ?? '', directives);
  }

  const stat =
    request.base === undefined ? undefined : await vcs.diffStat(request.worktree, request.base);
  let diff: PackageWorktree['diff'];
  if (settings.diff === 'full' && request.base !== undefined && supportsDiff(vcs)) {
    diff = await vcs.diffBetween(request.worktree, request.base, 'HEAD', settings.diffMaxChars);
  }

  const events = await readAttemptEvents(store.events, request.attemptId);
  const trajectory = summarizeTrajectory(events, {
    worktree: request.worktree,
    secretPaths: deps.secretPaths,
    home: deps.home,
  });
  const decisions =
    play === undefined
      ? []
      : answeredBy(await store.decisions.list({ playId: request.playId, states: ['decided'] }));
  const effects = await effectsOf(store.sideEffects, request.attemptId);
  const openEffects = await openEffectsOf(store.sideEffects, request.attemptId);

  const instruction: PackageInstruction =
    settings.shortOutput === 'redo' &&
    request.role !== undefined &&
    settings.shortOutputRoles.includes(request.role)
      ? 'redo'
      : 'continue';
  const base: ContinuationPackage = {
    attemptId: request.attemptId,
    role: request.role,
    prefix: request.prefix,
    task: taskOf(request.firstPrompt, request.prefix),
    demand,
    orders,
    worktree: {
      branch: request.branch,
      base: request.base,
      checkpoint: request.checkpoint,
      stat,
      diff,
    },
    trajectory,
    decisions,
    effects,
    openEffects,
    reason: request.reason,
    instruction,
    modelSummary: undefined,
  };
  if (settings.summarize !== 'director_model' || summarizer === undefined) return base;
  try {
    const written = await summarizer.summarize({
      role: request.role,
      demand: demand?.title ?? request.demandId,
      deterministic: renderSummary(trajectory, base.decisions, LEVELS[0]),
    });
    const text = scrubPackageText(written.trim(), {
      secretPaths: deps.secretPaths,
      home: deps.home,
    });
    return text.length === 0 ? base : { ...base, modelSummary: text.slice(0, MODEL_SUMMARY_CHARS) };
  } catch {
    // The cheap model is optional help: the deterministic summary is the source of truth.
    return base;
  }
}

const MODEL_SUMMARY_CHARS = 3000;

// ---------------------------------------------------------------------------------------------
// The text.
// ---------------------------------------------------------------------------------------------

/** How much each level of the text shows; level 0 is everything, the last one only counts. */
interface Level {
  readonly files: number;
  readonly commands: number;
  readonly effects: number;
  readonly diff: boolean;
  readonly message: number;
}

const LEVELS: readonly [Level, Level, Level, Level] = [
  { files: 200, commands: 80, effects: 200, diff: true, message: 1500 },
  { files: 200, commands: 80, effects: 200, diff: false, message: 1500 },
  { files: 20, commands: 20, effects: 100, diff: false, message: 800 },
  { files: 0, commands: 0, effects: 50, diff: false, message: 400 },
];

function bullets(items: readonly string[], cap: number): string[] {
  const shown = items.slice(0, cap).map((item) => `- ${item}`);
  if (items.length > cap) shown.push(`- ... and ${String(items.length - cap)} more`);
  return shown;
}

function names(label: string, items: readonly string[], cap: number): string[] {
  if (items.length === 0) return [`${label}: none`];
  if (cap === 0) return [`${label}: ${String(items.length)}`];
  return [`${label} (${String(items.length)}):`, ...bullets(items, cap)];
}

function effectLine(effect: AttemptEffect): string {
  const step = effect.step === undefined ? '' : `, step ${String(effect.step)}`;
  const target = effect.target.length === 0 ? '' : ` ${effect.target}`;
  return `${effect.type}${target} (${effect.state}${step}; key ${effect.key})`;
}

function renderSummary(
  trajectory: TrajectorySummary,
  decisions: readonly AnsweredDecision[],
  level: Level,
): string {
  const lines: string[] = [];
  lines.push(...names('Files read', trajectory.filesRead, level.files));
  lines.push(...names('Files edited', trajectory.filesEdited, level.files));
  if (trajectory.editTitles.length > 0) {
    lines.push(...names('Edits with no path', trajectory.editTitles, level.files));
  }
  const tests = trajectory.commands.filter((command) => command.test);
  const others = trajectory.commands.filter((command) => !command.test);
  const commandLine = (command: TrajectoryCommand): string =>
    `\`${command.command}\` -> ${command.status}`;
  lines.push(...names('Tests run', tests.map(commandLine), level.commands));
  lines.push(...names('Other commands', others.map(commandLine), level.commands));
  lines.push(
    ...names(
      'Framework tools',
      trajectory.frameworkCalls.map(
        (call) =>
          `${call.tool}${call.summary.length === 0 ? '' : ` \`${call.summary}\``} -> ${call.outcome}`,
      ),
      level.commands,
    ),
  );
  if (decisions.length > 0) {
    lines.push(
      'Decisions the Producer already answered (do not ask them again):',
      ...bullets(
        decisions.map(
          (decision) => `${decision.kind} ${decision.id}: ${decision.input} -> ${decision.answer}`,
        ),
        level.files === 0 ? 20 : 200,
      ),
    );
  }
  if (trajectory.lastMessage.length > 0) {
    const message = trajectory.lastMessage;
    const shown =
      message.length > level.message
        ? `...${message.slice(message.length - level.message)}`
        : message;
    lines.push(
      'Last message of the previous Executor:',
      ...shown.split('\n').map((line) => `> ${line}`),
    );
  }
  if (trajectory.withheld > 0) {
    lines.push(
      `(${String(trajectory.withheld)} paths or commands left out: they touch the secret list)`,
    );
  }
  return lines.join('\n');
}

function demandSection(demand: DemandRecord | undefined): string | undefined {
  if (demand === undefined) return undefined;
  const lines = ['## Demand', `${demand.id}: ${demand.title}`];
  if (demand.description.trim().length > 0) lines.push('', demand.description.trim());
  const contract = demand.contract;
  if (contract.inputs.length > 0 || contract.outputs.length > 0) {
    lines.push(
      '',
      'Contract:',
      `- inputs: ${compact(contract.inputs)}`,
      `- outputs: ${compact(contract.outputs)}`,
    );
  }
  if (demand.expectedFiles.length > 0) {
    lines.push('', 'Expected files:', ...bullets(demand.expectedFiles, 100));
  }
  if (demand.acceptanceCriteria.length > 0) {
    lines.push('', 'Acceptance criteria:', ...bullets(demand.acceptanceCriteria, 100));
  }
  return lines.join('\n');
}

function worktreeSection(worktree: PackageWorktree, level: Level): string {
  const lines = ['## Worktree'];
  lines.push(`Branch: ${worktree.branch}`);
  if (worktree.base !== undefined) lines.push(`Base: ${worktree.base}`);
  lines.push(`Last checkpoint commit: ${worktree.checkpoint ?? 'none yet'}`);
  const { stat } = worktree;
  if (stat === undefined) {
    lines.push('Difference against the base: not known');
  } else {
    lines.push(
      `Difference against the base: ${String(stat.filesChanged)} files, +${String(stat.insertions)} -${String(stat.deletions)}`,
    );
    if (level.files > 0) {
      lines.push(
        ...bullets(
          stat.files.map((file) =>
            file.insertions === undefined
              ? `${file.path} (binary)`
              : `${file.path} (+${String(file.insertions)} -${String(file.deletions ?? 0)})`,
          ),
          level.files,
        ),
      );
    }
  }
  if (level.diff && worktree.diff !== undefined && worktree.diff.text.length > 0) {
    lines.push('', '```diff', worktree.diff.text.trimEnd(), '```');
    if (worktree.diff.truncated) lines.push('(the diff was cut at the limit)');
  }
  return lines.join('\n');
}

function effectsSection(pkg: ContinuationPackage, level: Level): string {
  const lines = ['## Effects already executed'];
  if (pkg.effects.length === 0) {
    lines.push('None recorded: nothing with a lasting effect (a commit, an install) was done yet.');
  } else {
    lines.push(
      'These ran and are recorded; asking for the same call again returns the recorded result, so do not plan them again:',
      ...bullets(pkg.effects.map(effectLine), level.effects),
    );
  }
  if (pkg.openEffects.length > 0) {
    lines.push(
      '',
      'Started with no known end (check the state before you repeat them):',
      ...bullets(pkg.openEffects.map(effectLine), level.effects),
    );
  }
  return lines.join('\n');
}

const CONTINUE_INSTRUCTION =
  'Continue from this state; do not redo what is concluded. The files, commits and installs above already exist in your worktree: check what is there with your tools and go on with what is left of the demand.';

const REDO_INSTRUCTION =
  'The previous Executor stopped before it delivered, and the output of your role is short, so do the work again from the start of the task above. The last message and the files read above are partial notes to start from, not a finished result. Do not repeat the effects already executed.';

function reasonSection(pkg: ContinuationPackage): string {
  const { reason } = pkg;
  const lines = [
    '## Why you are resuming',
    `The work of this attempt passes from ${reason.from} to ${reason.to}.`,
    `Cause: ${reason.cause}. ${reason.policy}`,
  ];
  if (reason.detail.length > 0) lines.push(`Detail: ${reason.detail}`);
  lines.push('', pkg.instruction === 'redo' ? REDO_INSTRUCTION : CONTINUE_INSTRUCTION);
  return lines.join('\n');
}

/** The text of the package at one level of detail, with the five parts in their order. */
function renderAt(pkg: ContinuationPackage, level: Level, scope: SecretScope): string {
  const middle: string[] = [];
  const intro = `## Continuation of attempt ${pkg.attemptId}`;
  middle.push(
    `${intro}\nYou take over an attempt that was interrupted. What follows was read from the records of the daemon, not from memory.`,
  );
  if (pkg.task.length > 0) middle.push(`## Task\n${pkg.task}`);
  const demand = demandSection(pkg.demand);
  if (demand !== undefined) middle.push(demand);
  if (pkg.orders !== undefined) middle.push(pkg.orders);
  middle.push(worktreeSection(pkg.worktree, level));
  const summary = ['## What happened so far', renderSummary(pkg.trajectory, pkg.decisions, level)];
  if (pkg.modelSummary !== undefined) {
    summary.push(
      '',
      'Short summary by the cheap model (the list above is what the records say; trust it over this text):',
      pkg.modelSummary,
    );
  }
  middle.push(summary.join('\n'));
  middle.push(effectsSection(pkg, level));
  // The reason closes the package (part 5): it is the one thing that is never cut.
  const tail = reasonSection(pkg);
  const body = scrubPackageText([...middle, tail].join('\n\n'), scope);
  return pkg.prefix.length > 0 ? `${pkg.prefix}\n\n${body}` : body;
}

/** What `renderContinuationPackage` returns. */
export interface RenderedPackage {
  readonly text: string;
  /** The level of detail that fit `maxChars`: 0 is everything, 4 is a hard cut. */
  readonly level: number;
}

const CUT_MARK = '\n\n[... cut: the package reached resume.package.max_chars ...]\n\n';

/**
 * The package as the first prompt of the new session. The prefix stays as it is (the cache of the
 * client keeps the beginning), the rest goes through `scrubPackageText`, and when the text is over
 * `maxChars` it is written again with less detail (the diff text first, then the lists, then only
 * counts); past that the middle is cut and the last part, the reason and the instruction, stays.
 */
export function renderContinuationPackage(
  pkg: ContinuationPackage,
  options: { readonly maxChars: number } & SecretScope,
): RenderedPackage {
  for (const [index, level] of LEVELS.entries()) {
    const text = renderAt(pkg, level, options);
    if (text.length <= options.maxChars) return { text, level: index };
  }
  const full = renderAt(pkg, LEVELS[3], options);
  const tailStart = full.lastIndexOf('## Why you are resuming');
  const tail = tailStart === -1 ? '' : full.slice(tailStart);
  const room = Math.max(0, options.maxChars - tail.length - CUT_MARK.length);
  const head = full.slice(0, tailStart === -1 ? options.maxChars : tailStart);
  return { text: `${head.slice(0, room)}${CUT_MARK}${tail}`, level: LEVELS.length };
}
