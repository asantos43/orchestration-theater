// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { consultAnswer } from './consult-scripts.js';

const execFileAsync = promisify(execFile);

/**
 * [proposal] The `role-play` script: one fake agent for every role of a play (architecture 5.4).
 * It reads the marker lines the daemon puts at the head of its prompts and does what the role does
 * with the framework tools, so a whole play runs end to end without a real client.
 *
 * The outcome of the play comes from `#outcome:<name>` in the need (every stage prompt carries
 * it): `approved` (default), `execution_failure`, `script_failure`, `structural_failure`,
 * `exhausted` and `clarify`. The Critic rejects its first look at the work for the three failures
 * and says `[outcome:<name>]` in the reason; the Director reads that tag and classifies it.
 *
 * More cover the merge conflicts (N82 to N84): `base_drift`, `base_drift_conflict` and
 * `base_drift_verify` (the Critic moves `main` on its first look: with a new file, with a file the
 * play also writes, or with a file that makes the `verify` of the demands fail) and
 * `rescript` (the Critic rejects its first look as a script failure, and the second script keeps
 * alpha as it was, marked `unchanged`, and changes beta).
 *
 * `dependency_redone_rebase` and `dependency_redone_redo` (P15a) fail like `execution_failure`
 * (alpha is redone while beta, which depends on it, is approved) and the Director answers judgment
 * point 8 with the `rebase` or the `redo` that the outcome names. Every other outcome answers
 * point 8 with `rebase`.
 */

export const OUTCOMES = [
  'approved',
  'execution_failure',
  'script_failure',
  'structural_failure',
  'exhausted',
  'clarify',
  'base_drift',
  'base_drift_conflict',
  'base_drift_verify',
  'rescript',
  'dependency_redone_rebase',
  'dependency_redone_redo',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** What the script needs from the agent around it. */
export interface RolePlayHost {
  /** The whole prompt of the turn: the prefix of the role, when there is one, and the text. */
  readonly text: string;
  /** The working directory of the session (the worktree of an Actor). */
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** Says something to the client (a message chunk). */
  say(text: string): Promise<void>;
  /**
   * Ends the turn the way a client does when its plan runs out: the quota signals, then the quota
   * error, with `resetsAt` (an ISO time) when the limit says when it ends. It never returns.
   */
  exhaust(resetsAt?: string): Promise<never>;
  /** Calls a tool of the framework server and reports the call as a tool call of the turn. */
  call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{
    isError: boolean;
    text: string;
    structured: unknown;
    /** The image blocks the reply carried (a tool that hands the model a picture). */
    images?: readonly { readonly mimeType: string; readonly bytes: number }[];
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function markerOf(text: string, marker: string): string | undefined {
  const match = new RegExp(`^${marker}[ \\t]*(.*)$`, 'm').exec(text);
  return match?.[1]?.trim();
}

function outcomeOf(text: string): Outcome {
  const found = /#outcome:([a-z_]+)/.exec(text)?.[1];
  return OUTCOMES.find((outcome) => outcome === found) ?? 'approved';
}

/** The directory the agents of one test share, to count what a fresh process cannot remember. */
function stateDir(): string {
  return process.env.FAKE_AGENT_STATE_DIR ?? join(tmpdir(), 'fake-agent-role-play');
}

/** How many times `key` was asked for before this call (0 the first time). */
async function countOf(key: string): Promise<number> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${key.replaceAll(/[^A-Za-z0-9_-]/g, '_')}.count`);
  const before = Number(await readFile(file, 'utf8').catch(() => '0'));
  await writeFile(file, String(before + 1));
  return before;
}

/** The file that keeps what an armed failure of the Director is waiting for (P23). */
const ARMED_FILE = 'director-fail-armed.json';

/**
 * `#ot-director-fail:quota` on a line of the prompt of the Director makes its turn end with a quota
 * error (the quota signals of `quota-signal` and the `-32001` error) the first time; `#ot-director-fail-times:<n>`
 * makes it the first `n` times (P20, the failover of the Director). The count is kept in the state
 * directory of the test, so the prompt that goes back to the queue and reaches the next session
 * finds the failures already spent. `resetsAt` is the optional `#ot-director-fail-resets:<iso>`.
 *
 * [proposal] P23: `#ot-director-fail-on:judge` beside the marker arms the failure for later. The
 * turn that carries it goes on as usual (it opens the play), and the failure falls on the first
 * prompt of a judgment point (`#ot-judge`, which does not carry the text of the Producer), the
 * number of times asked.
 */
export async function directorQuotaFailure(
  text: string,
): Promise<{ readonly resetsAt?: string } | undefined> {
  if (markerOf(text, '#ot-director-fail:') === 'quota') {
    const times = Number(markerOf(text, '#ot-director-fail-times:')) || 1;
    const resetsAt = markerOf(text, '#ot-director-fail-resets:');
    const failure = resetsAt === undefined || resetsAt === '' ? {} : { resetsAt };
    if (markerOf(text, '#ot-director-fail-on:') === 'judge') {
      await mkdir(stateDir(), { recursive: true });
      await writeFile(join(stateDir(), ARMED_FILE), JSON.stringify({ times, failure }));
      return undefined;
    }
    return (await countOf('director-fail')) >= times ? undefined : failure;
  }
  if (!/^#ot-judge\b/m.test(text)) return undefined;
  const armed = await readFile(join(stateDir(), ARMED_FILE), 'utf8').catch(() => undefined);
  if (armed === undefined) return undefined;
  const { times, failure } = JSON.parse(armed) as {
    times: number;
    failure: { readonly resetsAt?: string };
  };
  return (await countOf('director-fail-judge')) >= times ? undefined : failure;
}

/**
 * `#ot-director-hang` on a line of the prompt of the Director makes its turn hang until the session
 * is cancelled or its process ends, the first time (P21b: the profile of the Director is removed
 * while it works). The count is kept like the one of `directorQuotaFailure`, so the prompt that
 * goes back to the queue is answered by the next session.
 */
export async function directorHangs(text: string): Promise<boolean> {
  if (!/^#ot-director-hang[ \t]*$/m.test(text)) return false;
  return (await countOf('director-hang')) === 0;
}

const VERIFY_OK = { name: 'check', command: 'node', args: ['-e', 'process.exit(0)'] };
/** Passes until the file `news.txt` is there: the file `main` gets in `base_drift_verify`. */
const VERIFY_NO_NEWS = {
  name: 'check',
  command: 'node',
  args: ['-e', "process.exit(require('fs').existsSync('news.txt') ? 1 : 0)"],
};
const VERIFY_FAIL = { name: 'check', command: 'node', args: ['-e', 'process.exit(1)'] };

function demandOf(
  id: string,
  dependsOn: string[],
  verify: typeof VERIFY_OK,
  revision = 1,
): Record<string, unknown> {
  return {
    id,
    title: `Write ${id}`,
    description: `Write the file ${id}.txt with a line that says what it is for.${revision > 1 ? ` (revision ${String(revision)})` : ''}`,
    dependsOn,
    contract: { inputs: [], outputs: [`file-${id}`] },
    expectedFiles: [`${id}.txt`],
    complexity: 'low',
    timeoutMin: 20,
    acceptanceCriteria: [`${id}.txt exists`],
    verify: [verify],
  };
}

/**
 * The script of the outcome. `rescript` writes a second one (`second`): alpha as it was, marked
 * `unchanged`, and beta with another description.
 */
function scriptFor(outcome: Outcome, second = false): Record<string, unknown> {
  const verify =
    outcome === 'exhausted'
      ? VERIFY_FAIL
      : outcome === 'base_drift_verify'
        ? VERIFY_NO_NEWS
        : VERIFY_OK;
  if (outcome === 'rescript' && second) {
    return {
      contracts: ['alpha', 'beta'].map((id) => ({
        id: `file-${id}`,
        kind: 'file',
        title: `File ${id}`,
        description: `The file ${id}.txt.`,
      })),
      demands: [
        { ...demandOf('alpha', [], verify), unchanged: true },
        demandOf('beta', ['alpha'], verify, 2),
      ],
    };
  }
  return {
    contracts: ['alpha', 'beta'].map((id) => ({
      id: `file-${id}`,
      kind: 'file',
      title: `File ${id}`,
      description: `The file ${id}.txt.`,
    })),
    demands: [demandOf('alpha', [], verify), demandOf('beta', ['alpha'], verify)],
  };
}

async function submit(
  host: RolePlayHost,
  tool: string,
  output: Record<string, unknown>,
): Promise<void> {
  const reply = await host.call(tool, output);
  await host.say(`${tool}: ${reply.isError ? 'refused' : 'accepted'} ${reply.text}`);
}

/**
 * [proposal] P23: tokens in the need steer one Actor, by demand id (the need is in every prompt of
 * the play, and the package of a baton pass carries it too):
 * - `#actor-effects:<id>`: after writing its file the Actor commits it (`git_commit`) and installs
 *   (`install_deps`), the two calls the effects registry of P22 replays;
 * - `#actor-quota:<id>=<iso>[@<attempt>]`: after its effects the Actor's first turn (of that
 *   attempt, when `@` is there) ends with a quota error that says the limit ends at `<iso>`;
 * - `#actor-hang:<id>@<attempt>`: the first turn of that attempt writes nothing and waits for the
 *   cancel, as a session that is still working when its profile is taken away.
 * What a token does once is counted in the state directory, so the next session of the attempt (a
 * baton pass or a native resume) goes on with the work.
 */
function actorToken(
  text: string,
  kind: string,
  demandId: string,
): { readonly value?: string; readonly attempt?: number } | undefined {
  const match = new RegExp(`#actor-${kind}:${demandId}(?:=([^\\s@]+))?(?:@(\\d+))?(?=\\s|$)`).exec(
    text,
  );
  if (match === null) return undefined;
  return {
    ...(match[1] === undefined ? {} : { value: match[1] }),
    ...(match[2] === undefined ? {} : { attempt: Number(match[2]) }),
  };
}

/** Where the prompt of an Actor is kept for a native resume (its prompt has no marker): per worktree. */
function memoryFile(cwd: string): string {
  return join(
    stateDir(),
    `resume-${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}.txt`,
  );
}

async function playActor(host: RolePlayHost, demandId: string): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(memoryFile(host.cwd), host.text);
  const attempt = Number(markerOf(host.text, '#ot-attempt:')) || 1;
  const hang = actorToken(host.text, 'hang', demandId);
  if (hang !== undefined && (hang.attempt ?? attempt) === attempt) {
    if ((await countOf(`actor-hang-${demandId}-${String(attempt)}`)) === 0) {
      await host.say(`fake agent: ${demandId} is working and does not end by itself`);
      await new Promise<void>((done) => {
        if (host.signal.aborted) done();
        else
          host.signal.addEventListener(
            'abort',
            () => {
              done();
            },
            { once: true },
          );
      });
      return;
    }
  }
  // An attempt that takes over earlier work (N82, N84) says what the prompt gave it.
  const carried = host.text.includes('## Work of the earlier attempt')
    ? `took over earlier work, diff ${host.text.includes('```diff') ? 'given' : 'not given'}\n`
    : '';
  await writeFile(
    join(host.cwd, `${demandId}.txt`),
    `${demandId}: written by the fake Actor\n${carried}`,
  );
  if (actorToken(host.text, 'effects', demandId) !== undefined) {
    const commit = await host.call('git_commit', { message: `${demandId}: write ${demandId}.txt` });
    await host.say(`git_commit: ${commit.isError ? 'refused' : 'done'} ${commit.text}`);
    const install = await host.call('install_deps', {});
    await host.say(`install_deps: ${install.isError ? 'refused' : 'done'} ${install.text}`);
  }
  const quota = actorToken(host.text, 'quota', demandId);
  if (quota !== undefined && (quota.attempt ?? attempt) === attempt) {
    if ((await countOf(`actor-quota-${demandId}-${String(attempt)}`)) === 0) {
      await host.exhaust(quota.value);
    }
  }
  await submit(host, 'submit', { result: { file: `${demandId}.txt` } });
}

/**
 * A turn with no marker is the native resume of an Actor ("carry on", `resume.continue_prompt`):
 * the session is the one that started the work, so the fake agent plays that prompt again, in the
 * worktree it ran in. The tokens that were spent stay spent. Returns false when there is none.
 */
async function resumeActor(host: RolePlayHost): Promise<boolean> {
  const before = await readFile(memoryFile(host.cwd), 'utf8').catch(() => undefined);
  if (before === undefined) return false;
  const demandId = markerOf(before, '#ot-demand:');
  if (demandId === undefined || demandId === '') return false;
  await host.say(`fake agent: resuming ${demandId} where it stopped`);
  await playActor({ ...host, text: before }, demandId);
  return true;
}

/**
 * Moves `main` of the project one commit on, with git plumbing so no worktree is touched: the
 * base of the play moves while the play runs (N83). `shared` also writes a file the play writes.
 */
async function advanceMain(host: RolePlayHost, file: string): Promise<void> {
  const git = async (args: string[], env: Record<string, string>, input?: string) => {
    const child = execFileAsync('git', args, { cwd: host.cwd, env: { ...process.env, ...env } });
    if (input !== undefined) child.child.stdin?.end(input);
    return (await child).stdout.trim();
  };
  const dir = resolve(host.cwd, await git(['rev-parse', '--git-common-dir'], {}));
  const index = join(stateDir(), `advance-${String(Date.now())}.index`);
  const env = {
    GIT_DIR: dir,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'Fake Agent',
    GIT_AUTHOR_EMAIL: 'fake-agent@example.invalid',
    GIT_COMMITTER_NAME: 'Fake Agent',
    GIT_COMMITTER_EMAIL: 'fake-agent@example.invalid',
  };
  await mkdir(stateDir(), { recursive: true });
  await git(['read-tree', 'main'], env);
  const blob = await git(['hash-object', '-w', '--stdin'], env, `${file}: written on main\n`);
  await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], env);
  const tree = await git(['write-tree'], env);
  const commit = await git(['commit-tree', tree, '-p', 'main', '-m', `main moves: ${file}`], env);
  await git(['update-ref', 'refs/heads/main', commit], env);
}

async function playCritic(host: RolePlayHost, playId: string, outcome: Outcome): Promise<void> {
  const look = await countOf(`${playId}-critic`);
  if (look === 0 && outcome.startsWith('base_drift')) {
    await advanceMain(host, outcome === 'base_drift_conflict' ? 'alpha.txt' : 'news.txt');
  }
  const fails =
    outcome === 'execution_failure' ||
    outcome === 'dependency_redone_rebase' ||
    outcome === 'dependency_redone_redo' ||
    outcome === 'script_failure' ||
    outcome === 'rescript' ||
    outcome === 'structural_failure';
  if (fails && look === 0) {
    await submit(host, 'submit_critique', {
      approved: false,
      reason: `The work does not match the plan. [outcome:${outcome}]`,
    });
    return;
  }
  await submit(host, 'submit_critique', { approved: true });
}

async function playStage(host: RolePlayHost, stage: string): Promise<void> {
  const playId = markerOf(host.text, '#ot-play:') ?? 'unknown';
  const outcome = outcomeOf(host.text);
  switch (stage) {
    case 'PLANNING':
      await submit(host, 'submit_plan', {
        plan: 'Write alpha.txt, then beta.txt after it.',
        openQuestions: outcome === 'clarify' ? ['What should the files say?'] : [],
      });
      return;
    case 'REVIEWING_PLAN':
      await submit(host, 'submit_plan_review', { approved: true });
      return;
    case 'SCRIPTING':
      await submit(host, 'submit_script', {
        script: scriptFor(outcome, (await countOf(`${playId}-script`)) > 0),
      });
      return;
    case 'REVIEWING_SCRIPT':
      await submit(host, 'submit_script_review', { approved: true });
      return;
    case 'CRITIQUING':
      await playCritic(host, playId, outcome);
      return;
    default:
      await host.say(`fake agent: no role for the stage ${stage}`);
  }
}

/** Asks the Producer one open question and says what came back. */
async function ask(host: RolePlayHost, question: string): Promise<unknown> {
  const reply = await host.call('ask_producer', { questions: [{ question, open: true }] });
  await host.say(`answer: ${reply.text}`);
  return reply.structured;
}

async function decisionsOf(host: RolePlayHost): Promise<Record<string, unknown>[]> {
  const reply = await host.call('next_action', {});
  const decisions = isRecord(reply.structured) ? reply.structured.decisions : undefined;
  return Array.isArray(decisions) ? decisions.filter(isRecord) : [];
}

async function playJudge(host: RolePlayHost): Promise<void> {
  for (const decision of await decisionsOf(host)) {
    const id = String(decision.id);
    const input = isRecord(decision.input) ? decision.input : {};
    if (decision.kind === 'judge.classify_critique') {
      const tag = /\[outcome:([a-z_]+)\]/.exec(
        typeof input.reason === 'string' ? input.reason : '',
      )?.[1];
      const demandIds = Array.isArray(input.demandIds) ? input.demandIds : [];
      const failure =
        tag === 'script_failure' || tag === 'rescript'
          ? { kind: 'script', note: 'the script does not fit the work' }
          : tag === 'structural_failure'
            ? { kind: 'structural', note: 'the plan has to start over' }
            : {
                kind: 'execution',
                demandIds: demandIds.slice(0, 1),
                // the note comes back as the `reason` of point 8: the answer it asks for
                note: `redo the first demand${tag === 'dependency_redone_redo' ? ' [answer:redo]' : ''}`,
              };
      const reply = await host.call('decide', { decisionId: id, payload: { failures: [failure] } });
      await host.say(`decided ${id}: ${reply.text}`);
    } else if (decision.kind === 'judge.dependency_redone') {
      const redo = typeof input.reason === 'string' && input.reason.includes('[answer:redo]');
      const reply = await host.call('decide', {
        decisionId: id,
        payload: { action: redo ? 'redo' : 'rebase' },
      });
      await host.say(`decided ${id}: ${reply.text}`);
    } else {
      await host.say(`fake agent: no answer for ${String(decision.kind)}`);
    }
  }
}

async function playClarify(host: RolePlayHost): Promise<void> {
  for (const decision of await decisionsOf(host)) {
    if (decision.kind !== 'clarify') continue;
    const answers = await ask(host, 'What should the files say?');
    const reply = await host.call('decide', {
      decisionId: String(decision.id),
      payload: { answers: isRecord(answers) ? (answers.answers ?? null) : null },
    });
    await host.say(`decided ${String(decision.id)}: ${reply.text}`);
  }
}

const ATTACHMENT_ID = /A[1-9][0-9]*/g;

function attachmentIdsOf(line: string | undefined): string[] {
  return line === undefined ? [] : (line.match(ATTACHMENT_ID) ?? []);
}

/**
 * The Author grouping the idea queue of a scenario (5.20): `#ot-group-ideas: <max>` is followed by
 * one line per queued idea, `- I3 [area: api] text`. It groups the first idea with the ones of its
 * area (an idea with no area goes alone), up to `<max>`, and leaves the others out with a reason.
 */
async function playIdeaGrouper(host: RolePlayHost, max: number): Promise<void> {
  const after = host.text.slice(host.text.indexOf('#ot-group-ideas:'));
  const ideas = [...after.matchAll(/^- (I[1-9][0-9]*) \[area: ([^\]]*)\] (.*)$/gm)].map(
    (match) => ({
      id: match[1] ?? '',
      area: match[2] ?? '-',
      text: match[3] ?? '',
    }),
  );
  const first = ideas[0];
  const members =
    first === undefined
      ? []
      : ideas
          .filter(
            (idea) => idea.id === first.id || (first.area !== '-' && idea.area === first.area),
          )
          .slice(0, max);
  const inGroup = new Set(members.map((idea) => idea.id));
  await submit(host, 'submit_idea_group', {
    group: {
      ideaIds: members.map((idea) => idea.id),
      need: members.map((idea) => idea.text).join('; '),
      rationale:
        first?.area === '-' ? 'it stands alone' : `they touch the same area (${first?.area ?? ''})`,
    },
    leftOut: ideas
      .filter((idea) => !inGroup.has(idea.id))
      .map((idea) => ({ ideaId: idea.id, reason: 'another area; it goes in a later group' })),
  });
}

/** The texts of the section "Directives in force:" of a state summary (P20: the failover carries them). */
function directivesOf(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf('Directives in force:');
  if (start === -1) return [];
  const texts: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const found = /^- \S+ \([^)]*\)(?: \[[^\]]*\])?: (.*)$/.exec(line)?.[1];
    if (found !== undefined) texts.push(found);
  }
  return texts;
}

/**
 * A turn of the Director of a generic chat: `#ot-chat <text>` is a simple question it answers
 * itself; `#ot-consult <question>` (with `#ot-attach A1 A2`) is a hard one it hands to the
 * Consultant with `consult`; `#ot-read A1 A2` reads attachments itself. A prompt that carries the
 * state summary (a Director that woke up) says so.
 */
async function playChat(host: RolePlayHost): Promise<boolean> {
  const { text } = host;
  const woke = /^State of scenario "[^"]*" \(([^,)]*),/m.exec(text)?.[1];
  const wake = woke === undefined ? [] : [`woke with the state of ${woke}`];
  const directives = directivesOf(text);
  if (woke !== undefined && directives.length > 0) {
    wake.push(`directives in force: ${directives.join(' | ')}`);
  }
  const consult = markerOf(text, '#ot-consult(?![-\\w])');
  if (consult !== undefined && consult !== '') {
    const attachments = attachmentIdsOf(markerOf(text, '#ot-attach(?![-\\w])'));
    const reply = await host.call('consult', {
      question: consult,
      ...(attachments.length === 0 ? {} : { attachments }),
    });
    for (const line of wake) await host.say(line);
    await host.say(`${reply.isError ? 'consult refused' : 'consulted'}: ${reply.text}`);
    return true;
  }
  const read = markerOf(text, '#ot-read(?![-\\w])');
  if (read !== undefined && read !== '') {
    for (const id of attachmentIdsOf(read)) {
      const reply = await host.call('read_attachment', { id });
      await host.say(`read ${id}: ${reply.isError ? 'refused' : 'ok'} ${reply.text.slice(0, 200)}`);
    }
    return true;
  }
  const chat = markerOf(text, '#ot-chat(?![-\\w])');
  if (chat !== undefined && chat !== '') {
    for (const line of wake) await host.say(line);
    await host.say(`answer: ${chat}`);
    return true;
  }
  return false;
}

/** One turn of the script: the Director when no stage marker is there, a role of the play when it is. */
export async function playRolePlay(host: RolePlayHost): Promise<void> {
  const { text } = host;
  const consulted = markerOf(text, '#ot-consult-ask:');
  if (consulted !== undefined && consulted !== '') {
    const attachments = attachmentIdsOf(markerOf(text, '#ot-attachments:'));
    await submit(host, 'submit', {
      result: { answer: await consultAnswer(host, consulted, attachments) },
    });
    return;
  }
  const grouping = markerOf(text, '#ot-group-ideas:');
  if (grouping !== undefined && grouping !== '') {
    await playIdeaGrouper(host, Number(grouping) || 5);
    return;
  }
  const demandId = markerOf(text, '#ot-demand:');
  if (demandId !== undefined && demandId !== '' && !demandId.startsWith('stage-')) {
    await playActor(host, demandId);
    return;
  }
  const stage = markerOf(text, '#ot-stage:');
  if (stage !== undefined && stage !== '') {
    await playStage(host, stage);
    return;
  }
  if (await playChat(host)) return;
  // The package of a baton pass carries the first prompt of the session (`## Task`): a judgment
  // that is handed to another Director must not open the play again (P23).
  if (/^#ot-judge\b/m.test(text)) {
    await playJudge(host);
    return;
  }
  const need = markerOf(text, '#ot-play(?!:)');
  if (need !== undefined && need !== '') {
    const reply = await host.call('open_play', { need });
    await host.say(`opened: ${reply.text}`);
    return;
  }
  const question = markerOf(text, '#ot-ask');
  if (question !== undefined && question !== '') {
    await ask(host, question);
    return;
  }
  if (/^#ot-clarify\b/m.test(text)) {
    await playClarify(host);
    return;
  }
  if (await resumeActor(host)) return;
  await host.say('fake agent: nothing to do');
}
