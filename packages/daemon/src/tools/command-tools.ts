// SPDX-License-Identifier: MPL-2.0
import {
  assertNoForbiddenFlags,
  confineArgv,
  confinePath,
  matchAllowlist,
  matchCommandPrefixes,
  ShellToolRefusal,
  validateArgv,
} from '@otheater/core';
import { ToolFailure, type ToolCall, type ToolHandler } from '../mcp/handlers.js';
import { runRecordedCommand } from './command-effects.js';
import type { ToolDone, ToolsContext } from './context.js';
import { runCommand } from './run-command.js';
import { configuredCommand, profileCommands, type ToolSettings } from './settings.js';

/** What the three command tools answer. Matches `commandOutput` in the tool registry. */
interface CommandReply {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

function worktreeOf(call: ToolCall): string {
  const { worktree } = call.caller;
  if (worktree === undefined) {
    throw new ToolFailure(
      'no_worktree',
      `${call.tool.name} runs in the worktree of an attempt, and this session has none.`,
    );
  }
  return worktree;
}

/** What `restricted_shell` may run: the mode of the allowlist (N97) decides the first check. */
function checkAllowed(argv: readonly string[], settings: ToolSettings): void {
  const { mode, list } = settings.config.shell_allowlist;
  if (mode === 'any') return;
  const allowed =
    mode === 'list'
      ? matchAllowlist(argv, list)
      : matchCommandPrefixes(argv, profileCommands(settings));
  if (!allowed) {
    const hint =
      mode === 'list'
        ? 'It is not in tools.shell_allowlist.list.'
        : 'It is not one of the commands of the project conventions (tools.shell_allowlist.mode is "profile").';
    throw new ShellToolRefusal(
      'program_not_allowed',
      `The command ${JSON.stringify(argv.join(' '))} is not allowed. ${hint}`,
    );
  }
}

/** The argv of the call, after every rule of N97 and of the confinement. */
async function argvOf(
  context: ToolsContext,
  call: ToolCall,
  settings: ToolSettings,
  worktree: string,
): Promise<string[]> {
  const { host } = context.deps;
  const name = call.tool.name;
  if (name === 'restricted_shell') {
    const { argv } = call.input as { argv: string[] };
    validateArgv(argv);
    checkAllowed(argv, settings);
    assertNoForbiddenFlags(argv);
    await confineArgv(host, worktree, argv);
    return argv;
  }
  const key = name === 'run_tests' ? 'test' : 'install';
  const argv = configuredCommand(settings, key);
  if (argv === undefined) {
    throw new ToolFailure(
      'no_command',
      `${name} has no command: the conventions of the project name no "${key}" command and ` +
        `tools.commands.${key} is not set.`,
    );
  }
  try {
    validateArgv(argv);
  } catch (error) {
    if (error instanceof ShellToolRefusal) {
      throw new ToolFailure(
        'invalid_command',
        `The configured ${key} command is not a plain argv (${error.message}).`,
      );
    }
    throw error;
  }
  if (name === 'run_tests') {
    const { target } = call.input as { target?: string };
    if (target !== undefined) {
      if (target.startsWith('-')) {
        throw new ShellToolRefusal(
          'forbidden_flag',
          'The target of run_tests is a path, not an option.',
        );
      }
      await confinePath(host, worktree, target);
      return [...argv, target];
    }
  }
  return argv;
}

async function execute(
  context: ToolsContext,
  call: ToolCall,
  settings: ToolSettings,
): Promise<ToolDone> {
  const worktree = worktreeOf(call);
  const { launcher, clock, confine } = context.deps;
  if (launcher === undefined) {
    throw new ToolFailure(
      'unavailable',
      'This platform has no process launcher: no command can run.',
    );
  }
  const argv = await argvOf(context, call, settings, worktree);
  const { timeout_ms, output_max_bytes, truncate } = settings.config;
  const run = async (): Promise<ToolDone> => {
    const result = await runCommand(
      launcher,
      clock,
      {
        argv,
        cwd: worktree,
        env: context.commandEnv(),
        timeoutMs: timeout_ms,
        outputMaxBytes: output_max_bytes,
        truncate,
      },
      confine === undefined ? undefined : (launch) => confine(launch, worktree),
    );
    const reply: CommandReply = {
      exitCode: result.exitCode,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      truncated: result.stdout.truncated || result.stderr.truncated,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdoutBytes: result.stdout.originalBytes,
      stderrBytes: result.stderr.originalBytes,
    };
    return {
      reply,
      outcome: result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'ok' : 'failed',
      exitCode: result.exitCode,
      outputBytes: result.stdout.originalBytes + result.stderr.originalBytes,
      truncated: reply.truncated,
    };
  };
  return runRecordedCommand(context, call, settings, {
    tool: call.tool.name as 'install_deps' | 'run_tests' | 'restricted_shell',
    worktree,
    argv,
    run,
  });
}

/** One line for `tool.called`: what the call is about to run. */
function summaryOf(call: ToolCall): string {
  if (call.tool.name === 'restricted_shell') {
    const { argv } = call.input as { argv: string[] };
    return argv.join(' ');
  }
  const { target } = call.input as { target?: string };
  return target === undefined ? call.tool.name : `${call.tool.name} ${target}`;
}

/**
 * `restricted_shell {argv}`, `run_tests {target?}` and `install_deps` (architecture 5.8, N97 and
 * N98). The three run a process in the worktree of the attempt, without a shell, under the
 * `ProcessLauncher`, with the timeout, the output limit and (when heavy) the semaphore.
 *
 * - `restricted_shell` takes an argv from the model: the shape rules, the allowlist of the mode
 *   in force, the forbidden flags and the confinement of every path argument all apply.
 * - `run_tests` and `install_deps` take NO command from the model: it comes from the project
 *   (`scenarios.conventions`, `tools.commands`). `run_tests` accepts one `target`, a path inside
 *   the worktree, appended as a single argument.
 * - A command that fails or times out is a normal reply (`exitCode`, `timedOut`); a refusal
 *   (rules, path, no command, no worktree) is an error result with a stable code.
 *
 * All three go through the effect protocol of 5.16 and 5.21 (P22, `./command-effects.ts`): the
 * "before" and the "after" are written under `<play>:<tool>:<attempt>:<step>`, `install_deps` over
 * the same inputs returns the recorded reply, and a run the daemon lost in the middle is settled by
 * the verifier or asked to the Producer, never repeated blindly. `tools.effects` tunes it.
 */
export function commandToolHandlers(context: ToolsContext): Record<string, ToolHandler> {
  const handler: ToolHandler = (call) =>
    context.track(call, summaryOf(call), (settings) => execute(context, call, settings));
  return { restricted_shell: handler, run_tests: handler, install_deps: handler };
}
