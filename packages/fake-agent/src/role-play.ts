// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * [proposal] The `role-play` script: one fake agent for every role of a play (architecture 5.4).
 * It reads the marker lines the daemon puts at the head of its prompts and does what the role does
 * with the framework tools, so a whole play runs end to end without a real client.
 *
 * The outcome of the play comes from `#outcome:<name>` in the need (every stage prompt carries
 * it): `approved` (default), `execution_failure`, `script_failure`, `structural_failure`,
 * `exhausted` and `clarify`. The Critic rejects its first look at the work for the three failures
 * and says `[outcome:<name>]` in the reason; the Director reads that tag and classifies it.
 */

export const OUTCOMES = [
  'approved',
  'execution_failure',
  'script_failure',
  'structural_failure',
  'exhausted',
  'clarify',
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
  /** Calls a tool of the framework server and reports the call as a tool call of the turn. */
  call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string; structured: unknown }>;
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

const VERIFY_OK = { name: 'check', command: 'node', args: ['-e', 'process.exit(0)'] };
const VERIFY_FAIL = { name: 'check', command: 'node', args: ['-e', 'process.exit(1)'] };

function demandOf(
  id: string,
  dependsOn: string[],
  verify: typeof VERIFY_OK,
): Record<string, unknown> {
  return {
    id,
    title: `Write ${id}`,
    description: `Write the file ${id}.txt with a line that says what it is for.`,
    dependsOn,
    contract: { inputs: [], outputs: [`file-${id}`] },
    expectedFiles: [`${id}.txt`],
    complexity: 'low',
    timeoutMin: 20,
    acceptanceCriteria: [`${id}.txt exists`],
    verify: [verify],
  };
}

function scriptFor(outcome: Outcome): Record<string, unknown> {
  const verify = outcome === 'exhausted' ? VERIFY_FAIL : VERIFY_OK;
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

async function playActor(host: RolePlayHost, demandId: string): Promise<void> {
  await writeFile(join(host.cwd, `${demandId}.txt`), `${demandId}: written by the fake Actor\n`);
  await submit(host, 'submit', { result: { file: `${demandId}.txt` } });
}

async function playCritic(host: RolePlayHost, playId: string, outcome: Outcome): Promise<void> {
  const look = await countOf(`${playId}-critic`);
  const fails =
    outcome === 'execution_failure' ||
    outcome === 'script_failure' ||
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
      await submit(host, 'submit_script', { script: scriptFor(outcome) });
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
        tag === 'script_failure'
          ? { kind: 'script', note: 'the script does not fit the work' }
          : tag === 'structural_failure'
            ? { kind: 'structural', note: 'the plan has to start over' }
            : {
                kind: 'execution',
                demandIds: demandIds.slice(0, 1),
                note: 'redo the first demand',
              };
      const reply = await host.call('decide', { decisionId: id, payload: { failures: [failure] } });
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
 * The Consultant of the chat (5.20): reads the attachments the prompt lists (`#ot-attachments:`)
 * and answers the question (`#ot-consult-ask:`) with what it found, through `submit`.
 */
async function playConsultant(host: RolePlayHost, question: string): Promise<void> {
  const found: string[] = [];
  for (const id of attachmentIdsOf(markerOf(host.text, '#ot-attachments:'))) {
    const reply = await host.call('read_attachment', { id });
    if (reply.isError || !isRecord(reply.structured)) {
      found.push(`${id} refused`);
      continue;
    }
    const { mime, kind, content } = reply.structured;
    found.push(
      kind === 'text' && typeof content === 'string'
        ? `${id} says ${content.trim()}`
        : `${id} is ${String(mime)}`,
    );
  }
  const seen = found.length === 0 ? '' : ` [${found.join('; ')}]`;
  await submit(host, 'submit', { result: { answer: `consulted on "${question}"${seen}` } });
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
    await playConsultant(host, consulted);
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
  if (/^#ot-judge\b/m.test(text)) {
    await playJudge(host);
    return;
  }
  if (/^#ot-clarify\b/m.test(text)) {
    await playClarify(host);
    return;
  }
  await host.say('fake agent: nothing to do');
}
