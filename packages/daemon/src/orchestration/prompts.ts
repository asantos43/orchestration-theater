// SPDX-License-Identifier: MPL-2.0
import type { Demand } from '@otheater/core';

/**
 * The variable part of the prompts of the stages and of the notices to the Director (architecture
 * 5.10: the stable prefix comes first, `assemblePrefix`; what changes per call goes after it).
 *
 * [proposta] Every prompt starts with `#ot-` marker lines (`#ot-stage`, `#ot-play`, `#ot-role`,
 * `#ot-demand`, `#ot-attempt`). They tell a human reading the log, and the fake agent of the tests,
 * which step the prompt is for; a real client ignores them. The text of each stage is in English
 * (5.22) and says which tool to call and with what.
 */

/**
 * The work of an earlier attempt of the demand that this attempt takes over (N82, N84). [proposta]
 * The daemon builds it from the `carry:<demand>` note of the blackboard.
 */
export interface CarriedWork {
  /** Why the earlier work is here: its rebase conflicted, or the script was rewritten. */
  readonly kind: 'rebase_conflict' | 'rescript';
  /** The branch of the earlier attempt. */
  readonly branch: string;
  /** What the earlier attempt changed (a unified diff), when the daemon could read it. */
  readonly diff?: string | undefined;
  readonly truncated?: boolean | undefined;
  /** The attempt only resolves a conflict: the worktree starts on `branch`. */
  readonly resolve: boolean;
  /** With `resolve`: the branch to merge in. */
  readonly mergeIn: string | null;
  /** The conflicting files, for a rebase that conflicted. */
  readonly files: readonly string[];
  /** The worktree starts on the earlier branch (`resolve`, or `rescript.reuse: from_previous`). */
  readonly startsFromBranch: boolean;
}

export interface StagePromptInput {
  readonly stage: string;
  readonly role: string;
  readonly playId: string;
  readonly need: string;
  /** The reason of the last return, when the stage runs again. */
  readonly feedback: string | null;
  /** PLANNING only: the plan starts over. */
  readonly restart: boolean;
  /** The plan of the play, for the stages that read it. */
  readonly plan?: string | undefined;
  /** The script of the play, as JSON text. */
  readonly script?: string | undefined;
  readonly demand?: Demand | undefined;
  readonly attempt?: number | undefined;
  /** Where the integrated work is (CRITIQUING): the base to compare it with. */
  readonly baseRef?: string | undefined;
  /** EXECUTING: the earlier attempt this one takes over. */
  readonly carried?: CarriedWork | undefined;
  /** SCRIPTING: the script that is being rewritten, as JSON text, and the demands it kept. */
  readonly previousScript?: string | undefined;
}

const SCRIPT_SHAPE = [
  'The script is `{ "contracts": [...], "demands": [...] }`.',
  'A contract is `{ "id", "kind"?, "title", "description" }`.',
  'A demand is `{ "id", "title", "description", "dependsOn": [ids], "contract": { "inputs": [contract ids], "outputs": [contract ids] },',
  '"expectedFiles": [paths], "complexity": "low"|"medium"|"high", "timeoutMin"?, "acceptanceCriteria": [text],',
  '"verify": [{ "name", "command", "args": [...] }], "verifyWaiver"? }`.',
  'Ids use lowercase letters, digits and "-" only. Every demand needs acceptance criteria, at least one',
  'output contract, expected files and a verify step (or a verifyWaiver that says why there is none).',
].join(' ');

function instruction(input: StagePromptInput): string {
  switch (input.stage) {
    case 'PLANNING':
      return input.restart
        ? 'The plan starts over. Write a new plan for the need, taking the reason above into account. Send it with `submit_plan` as `{ "plan": "<the plan as text>", "openQuestions": ["<a question only the Producer can answer>"] }`; leave `openQuestions` empty when there is none.'
        : 'Write the plan for the need. Send it with `submit_plan` as `{ "plan": "<the plan as text>", "openQuestions": ["<a question only the Producer can answer>"] }`; leave `openQuestions` empty when there is none.';
    case 'REVIEWING_PLAN':
      return 'Check the plan against the need. Answer with `submit_plan_review` as `{ "approved": true|false, "reason": "<what is wrong, when not approved>" }`.';
    case 'SCRIPTING':
      return `Split the plan into ready demands. Send the script with \`submit_script\` as \`{ "script": <the script> }\`. ${SCRIPT_SHAPE}`;
    case 'REVIEWING_SCRIPT':
      return 'Check that the script covers the plan and that every demand is ready. Answer with `submit_script_review` as `{ "approved": true|false, "reason": "<what is wrong, when not approved>" }`.';
    case 'CRITIQUING':
      return `The integrated work is checked out in your worktree. Compare it with the plan and the script (the base of the play is \`${input.baseRef ?? 'the base branch'}\`). Answer with \`submit_critique\` as \`{ "approved": true|false, "reason": "<what is wrong, when not approved>" }\`.`;
    default:
      return 'Do the work of your role and call the tool of your role with the result.';
  }
}

const UNCHANGED_NOTE =
  'Mark `"unchanged": true` on every demand you keep exactly as it is in this script (same description, contract, expected files, dependencies and verify). The daemon keeps the approved work of those demands and runs only the others. Change a demand and leave the mark off when it has to be redone.';

function carriedSection(work: CarriedWork): string {
  const lines: string[] = ['## Work of the earlier attempt'];
  if (work.kind === 'rebase_conflict') {
    lines.push(
      `The earlier attempt of this demand was moved onto the new work it depends on and conflicts in: ${work.files.join(', ') || 'some files'}.`,
    );
  } else {
    lines.push('The script was rewritten and this demand has to be done again.');
  }
  lines.push(`The earlier work is on the branch \`${work.branch}\`.`);
  if (work.resolve && work.mergeIn !== null) {
    lines.push(
      `This worktree starts from that branch. Only resolve the conflict: merge \`${work.mergeIn}\` into it, fix the conflicting files, and call \`submit\`. Change nothing else.`,
    );
  } else if (work.startsFromBranch) {
    lines.push('This worktree starts from that branch: change what the demand now asks for.');
  } else {
    lines.push(
      'Redo the demand on this worktree. What the earlier attempt changed, for reference:',
    );
  }
  if (work.diff !== undefined && work.diff !== '') {
    lines.push('```diff', work.diff, '```');
    if (work.truncated === true) lines.push('(the diff was cut; read the branch for the rest)');
  }
  return lines.join('\n');
}

/** The prompt of one stage or one Actor attempt, to follow the prefix of the role. */
export function stagePrompt(input: StagePromptInput): string {
  const lines = [
    `#ot-stage: ${input.stage}`,
    `#ot-play: ${input.playId}`,
    `#ot-role: ${input.role}`,
  ];
  if (input.demand !== undefined) lines.push(`#ot-demand: ${input.demand.id}`);
  if (input.attempt !== undefined) lines.push(`#ot-attempt: ${String(input.attempt)}`);
  const sections = [lines.join('\n'), `## Need\n\n${input.need}`];
  if (input.feedback !== null) sections.push(`## Why this runs again\n\n${input.feedback}`);
  if (input.plan !== undefined) sections.push(`## Plan\n\n${input.plan}`);
  if (input.script !== undefined) sections.push(`## Script\n\n${input.script}`);
  if (input.previousScript !== undefined) {
    sections.push(`## Previous script\n\n${input.previousScript}\n\n${UNCHANGED_NOTE}`);
  }
  if (input.carried !== undefined) sections.push(carriedSection(input.carried));
  if (input.demand !== undefined) {
    sections.push(
      `## Your demand\n\n${JSON.stringify(input.demand, null, 2)}\n\nWork only inside this worktree. When the demand is done, call \`submit\` with \`{ "result": "<what you did>" }\`. Read the contracts you depend on with \`read_contract\`.`,
    );
  } else {
    sections.push(`## What to do\n\n${instruction(input)}`);
  }
  return `${sections.join('\n\n')}\n`;
}

/** What the daemon tells the Director when a judgment point is waiting (kind `judge.*`). */
export function judgePrompt(playId: string, point: string): string {
  return [
    '#ot-judge',
    `#ot-play: ${playId}`,
    `#ot-point: ${point}`,
    `The play ${playId} needs your judgment (${point}). Call \`next_action\` to see what is pending and the input of each decision, then answer it with \`decide\`.`,
  ].join('\n');
}

/** What the daemon tells the Director when the plan has open questions (decision `clarify`). */
export function clarifyPrompt(playId: string): string {
  return [
    '#ot-clarify',
    `#ot-play: ${playId}`,
    `The plan of the play ${playId} has open questions. Call \`next_action\` to read them, ask the Producer with \`ask_producer\` what only the Producer can answer, then answer the decision with \`decide\`.`,
  ].join('\n');
}
