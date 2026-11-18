// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { confinePath, type JsonObject, type SideEffectRecord } from '@otheater/core';
import { ToolFailure, type ToolCall } from '../mcp/handlers.js';
import { EffectFailed, runEffect } from '../workspace/effects.js';
import { callHashOfStep, doneRecordOf, stepFor, stepsOf, type Step } from '../workspace/steps.js';
import {
  INSTALL_DEPS_EFFECT,
  RESTRICTED_SHELL_EFFECT,
  verifyCommand,
} from '../workspace/verifiers.js';
import type { ToolDone, ToolsContext } from './context.js';
import type { ToolSettings } from './settings.js';

function sha(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * What the dependency files of the worktree say now: the digest of their contents (a missing
 * file counts as missing). A call of `install_deps` with the same command and the same
 * fingerprint is the same call. Reading goes through the confinement of the worktree, so a link
 * that leaves it is read as absent.
 */
async function fingerprintOf(
  context: ToolsContext,
  worktree: string,
  files: readonly string[],
): Promise<string> {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    let digest = 'absent';
    try {
      digest = sha(await readFile(await confinePath(context.deps.host, worktree, file)));
    } catch {
      // Not there, a folder, or out of the worktree: all of them are "no such dependency file".
    }
    hash.update(`${file}\0${digest}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** What a finished command left in the record is a reply of the tool; anything else is not one. */
function isReply(result: JsonObject | null): result is JsonObject {
  return (
    result !== null &&
    typeof result.stdout === 'string' &&
    typeof result.stderr === 'string' &&
    typeof result.exitCode === 'number'
  );
}

/** The last step of the attempt, if it finished: a later failed or open run voids the replay. */
function lastDoneStep(
  steps: readonly Step[],
): { step: Step; record: SideEffectRecord } | undefined {
  const step = steps[steps.length - 1];
  const record = step === undefined ? undefined : doneRecordOf(step);
  return step === undefined || record === undefined ? undefined : { step, record };
}

export interface CommandRun {
  readonly tool: 'install_deps' | 'run_tests' | 'restricted_shell';
  readonly worktree: string;
  /** The command, after every check: the program is `argv[0]`. */
  readonly argv: readonly string[];
  /** Runs it. A command that fails or times out is a normal `ToolDone` (outcome not `ok`). */
  readonly run: () => Promise<ToolDone>;
}

function replyOf(done: ToolDone): JsonObject {
  return done.reply as JsonObject;
}

/**
 * Runs a command of the worktree under the side-effect protocol (architecture 5.16 and 5.21, P22):
 * the "before" is written, the command runs, the "after" is written, under the key
 * `<play>:<tool>:<attempt>:<step>`.
 *
 * - `install_deps` over the same command and the same dependency files as the last install that
 *   finished returns the recorded reply with `reused: true` and runs nothing
 *   (`tools.effects.replay: same_inputs`);
 * - a call that finds a run of itself with a "before" and no "after" (the daemon died in the
 *   middle) goes to the verifier of the record: `install_deps` and `run_tests` are safe to run
 *   again (`tools.effects.open_command: rerun_safe`), `restricted_shell` is `ambiguous` and answers
 *   `ambiguous` until the Producer says what happened (the reconciliation asks);
 * - a command that fails or times out is recorded `failed`, with its reply, and answered as a
 *   normal result. A `failed` step is never replayed.
 *
 * `tools.effects.mode: off`, or a session tied to no attempt, runs the command as before.
 */
export async function runRecordedCommand(
  context: ToolsContext,
  call: ToolCall,
  settings: ToolSettings,
  input: CommandRun,
): Promise<ToolDone> {
  const effects = settings.config.effects;
  const { store } = context.deps;
  const { attemptId } = call.caller;
  const attempt = effects.mode === 'off' ? undefined : await store.attempts.get(attemptId);
  if (attempt === undefined) return input.run();

  const tool = input.tool;
  const isInstall = tool === INSTALL_DEPS_EFFECT;
  const fingerprint = isInstall
    ? await fingerprintOf(context, input.worktree, effects.fingerprint_files)
    : undefined;
  const callHash = sha(JSON.stringify([input.argv, fingerprint ?? null]));
  const base = `${attempt.playId}:${tool}:${attemptId}`;
  const openPolicy = tool !== RESTRICTED_SHELL_EFFECT && effects.open_command === 'rerun_safe';

  const reserved = await context.effectGate.reserve(base, async (busy) => {
    const steps = stepsOf(await store.sideEffects.list({ types: [tool], attemptId }), base);
    if (isInstall && effects.replay === 'same_inputs') {
      const last = lastDoneStep(steps);
      if (
        last !== undefined &&
        callHashOfStep(last.step) === callHash &&
        isReply(last.record.result)
      ) {
        return { replay: last.record.result };
      }
    }
    return stepFor(steps, callHash, busy);
  });
  if ('replay' in reserved) {
    const reply = { ...reserved.replay, reused: true };
    return {
      reply,
      outcome: 'ok',
      exitCode: typeof reserved.replay.exitCode === 'number' ? reserved.replay.exitCode : 0,
      outputBytes: 0,
      truncated: reserved.replay.truncated === true,
    };
  }

  const key = `${base}:${String(reserved.step)}`;
  let executed: ToolDone | undefined;
  try {
    const outcome = await runEffect(store.sideEffects, {
      key,
      type: tool,
      target: input.worktree,
      attemptId,
      params: {
        callHash,
        program: input.argv[0] ?? '',
        // The command of the project is its own to show; what the model typed into the shell is not.
        ...(tool === RESTRICTED_SHELL_EFFECT
          ? {}
          : { command: input.argv.join(' ').slice(0, 500) }),
        ...(fingerprint === undefined ? {} : { fingerprint }),
        openPolicy: openPolicy ? 'rerun' : 'ask',
      },
      execute: async (): Promise<JsonObject> => {
        const done = await input.run();
        executed = done;
        if (done.outcome === 'ok') return replyOf(done);
        throw new EffectFailed(`${tool} did not finish well (${done.outcome})`, replyOf(done));
      },
      verify: (record) => Promise.resolve(verifyCommand(record)),
    });
    if (outcome.kind === 'ambiguous') {
      throw new ToolFailure(
        'ambiguous',
        `An earlier ${tool} of this attempt started and nothing says whether it finished: ${outcome.reason}. ` +
          'Look at the worktree (restricted_shell with git status or ls); the Producer was asked what to do about it.',
      );
    }
    if (outcome.origin === 'executed' && executed !== undefined) {
      return isInstall ? { ...executed, reply: { ...replyOf(executed), reused: false } } : executed;
    }
    // The verifier found it done (a Producer answer settled it): its result is the reply.
    return {
      reply: isInstall ? { ...outcome.result, reused: true } : outcome.result,
      outcome: 'ok',
      exitCode: typeof outcome.result.exitCode === 'number' ? outcome.result.exitCode : 0,
      outputBytes: 0,
      truncated: outcome.result.truncated === true,
    };
  } catch (error) {
    // The command ran and failed: the record says so, and the failure is the answer.
    if (error instanceof EffectFailed && executed !== undefined) {
      return isInstall ? { ...executed, reply: { ...replyOf(executed), reused: false } } : executed;
    }
    throw error;
  } finally {
    reserved.release();
  }
}
