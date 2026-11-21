// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  Conflict,
  InvalidInput,
  NotFound,
  PermissionDenied,
  type Clock,
  type LaunchOptions,
  type ProcessLauncher,
  type Store,
} from '@otheater/core';
import { buildDaemonEvent, type ShellCommandFinishedPayload } from '@otheater/protocol';
import { answersOf, type AskApproval } from '../browser/approval.js';
import type { Logger } from '../logger.js';
import type { ProducerChannel } from '../orchestration/channel.js';
import type { AttachmentService } from '../scenarios/attachments.js';
import type { AppTerminalMode, ShellCommandConfig, TerminalConfig } from '../shell-config.js';
import { startShell, type ShellRun } from './run.js';
import { cutSnippet, seemsToAskForInput } from './snippet.js';

/**
 * The `!` command of the Producer (N43, N187; architecture 5.13 and 5.19): a chat message that
 * starts with `!` runs as a command in the worktree of the scenario, through the `ProcessLauncher`
 * and, by default, inside the sandbox of layer 3. It never goes to the Director as a message: its
 * output does, as an attachment, when `chat.shell_command.context` says so.
 */

/** What the service reads on every command, so a change of the config applies to the next one. */
export interface ShellSettings {
  readonly shell: ShellCommandConfig;
  readonly terminalMode: AppTerminalMode;
  readonly terminal: TerminalConfig;
}

export interface ShellCommandServiceOptions {
  readonly store: Pick<Store, 'events' | 'scenarios' | 'scenarioRepos'>;
  readonly clock: Clock;
  /** `undefined` on a platform with no launcher: the command is refused. */
  readonly launcher: ProcessLauncher | undefined;
  /** The sandbox of layer 3; `undefined` when there is none (`app.terminal: sandbox` then refuses). */
  readonly confine: ((launch: LaunchOptions) => Promise<LaunchOptions>) | undefined;
  readonly attachments: Pick<AttachmentService, 'addText' | 'get' | 'read'>;
  readonly channel: Pick<ProducerChannel, 'send'>;
  /** The question of `chat.shell_command.context: ask`; `undefined` refuses that mode. */
  readonly ask?: AskApproval | undefined;
  /** The environment of the command: `tools.env_inherit` and `tools.env_allow` over the daemon's. */
  readonly env: () => Readonly<Record<string, string>>;
  /** `<data>/scenarios`: the log of a command is `<scenarios>/<scenario>/terminal/<id>.log`. */
  readonly scenariosDir: string;
  readonly settings: () => ShellSettings;
  readonly logger: Logger;
  readonly platform?: NodeJS.Platform;
}

export const SEND_LABEL = 'Send';
export const KEEP_LABEL = 'Keep';

/** The longest command the event carries (the schema's limit); the command itself runs whole. */
const EVENT_COMMAND_MAX = 2000;
/** The longest command the question to the Producer repeats. */
const QUESTION_COMMAND_MAX = 120;

/** The shell that runs a line: `/bin/sh -c` (a POSIX shell is on every Linux and macOS). */
export function shellArgv(line: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', line] : ['/bin/sh', '-c', line];
}

/** The command of a message that starts with `!`: what follows, with the edges trimmed. */
export function commandOf(text: string): string {
  return text.replace(/^\s*!/, '').trim();
}

/** Whether a chat message is a `!` command (the first non-blank character is `!`). */
export function isShellCommand(text: string): boolean {
  return text.trimStart().startsWith('!');
}

interface Running {
  readonly scenarioId: string;
  /** `undefined` while the process is being started. */
  readonly run: ShellRun | undefined;
  readonly finished: Promise<void>;
}

function oneLine(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function seconds(ms: number): string {
  return `${String(Math.round(ms / 100) / 10)}s`;
}

export class ShellCommandService {
  readonly #o: ShellCommandServiceOptions;
  readonly #running = new Map<string, Running>();
  #closing = false;

  constructor(options: ShellCommandServiceOptions) {
    this.#o = options;
  }

  /** How many commands of the scenario are running. */
  runningIn(scenarioId: string): number {
    let count = 0;
    for (const entry of this.#running.values()) if (entry.scenarioId === scenarioId) count += 1;
    return count;
  }

  /**
   * Starts the command of a `!` message and returns its id; the command runs on and its end is
   * told by the events. Refuses (a core error, which the chat socket maps) when `chat.shell_command`
   * or `app.terminal` is `off`, when the command is empty, when `app.terminal: sandbox` has no
   * sandbox (it never runs unconfined by accident), when `context: ask` has nobody to ask, and when
   * `chat.shell_command.max_running` commands are already running in the scenario.
   */
  async start(scenarioId: string, text: string): Promise<{ commandId: string }> {
    const o = this.#o;
    const { shell, terminalMode, terminal } = o.settings();
    if (shell.mode === 'off') {
      throw new PermissionDenied('The ! command is off (chat.shell_command: off)');
    }
    if (terminalMode === 'off') {
      throw new PermissionDenied('The ! command is off (app.terminal: off)');
    }
    const command = commandOf(text);
    if (command === '') throw new InvalidInput('The ! command is empty');
    if (this.#closing) throw new AdapterUnavailable('The daemon is stopping');
    const scenario = await o.store.scenarios.get(scenarioId);
    if (scenario === undefined) throw new NotFound(`There is no scenario "${scenarioId}"`);
    if (o.launcher === undefined) {
      throw new AdapterUnavailable('This platform has no process launcher, so ! cannot run');
    }
    if (terminalMode === 'sandbox' && o.confine === undefined) {
      throw new AdapterUnavailable(
        'app.terminal is sandbox but no sandbox is available; the ! command does not run unconfined (set app.terminal: host to run it on the host)',
      );
    }
    if (shell.context === 'ask' && o.ask === undefined) {
      throw new AdapterUnavailable('chat.shell_command.context is ask but nobody can be asked now');
    }
    if (this.runningIn(scenarioId) >= shell.max_running) {
      throw new Conflict(
        `${String(shell.max_running)} ! commands are already running in this scenario (chat.shell_command.max_running)`,
      );
    }
    const repos = await o.store.scenarioRepos.list(scenarioId);
    const cwd = repos[0]?.path ?? scenario.folder;
    const commandId = `sh_${randomUUID().slice(0, 8)}`;
    const logPath = join(o.scenariosDir, scenarioId, 'terminal', `${commandId}.log`);
    // Reserved before the first wait, so a burst of commands cannot go past `max_running`.
    const slot = Promise.withResolvers<undefined>();
    this.#running.set(commandId, {
      scenarioId,
      run: undefined,
      finished: slot.promise,
    });
    let run: ShellRun;
    try {
      run = await startShell(
        o.launcher,
        o.clock,
        {
          argv: shellArgv(command, o.platform),
          cwd,
          env: { TERM: 'dumb', NO_COLOR: '1', ...o.env() },
          timeoutMs: shell.timeout,
          logPath,
          logMaxBytes: terminal.log_max_size,
        },
        terminalMode === 'sandbox' ? o.confine : undefined,
      );
    } catch (error) {
      this.#running.delete(commandId);
      slot.resolve(undefined);
      throw error;
    }
    // The daemon began to stop while the process was starting: it does not outlive it.
    if (this.#stopping()) await run.kill();
    const finished = this.#finish(scenarioId, commandId, command, run, logPath, slot);
    this.#running.set(commandId, { scenarioId, run, finished });
    await this.#append(scenarioId, 'chat.shell_command.started', {
      commandId,
      command: oneLine(command, EVENT_COMMAND_MAX),
      place: terminalMode === 'host' ? 'host' : 'sandbox',
    });
    return { commandId };
  }

  /** The text of the snippet attachment of a finished command; empty when it had no output. */
  async snippetOf(scenarioId: string, attachmentId: string | null): Promise<string> {
    if (attachmentId === null) return '';
    const record = await this.#o.attachments.get(scenarioId, attachmentId);
    const content = await this.#o.attachments.read(record);
    return content.encoding === 'utf8' ? content.content : '';
  }

  /** Ends the commands still running (the daemon is stopping) and waits for their last events. */
  async close(): Promise<void> {
    this.#closing = true;
    const entries = [...this.#running.values()];
    await Promise.all(
      entries.map(async (entry) => {
        await entry.run?.kill();
      }),
    );
    await Promise.allSettled(entries.map((entry) => entry.finished));
  }

  /** A method so the compiler does not narrow the flag across the awaits of `start`. */
  #stopping(): boolean {
    return this.#closing;
  }

  async #append<T extends 'chat.shell_command.started' | 'chat.shell_command.finished'>(
    scenarioId: string,
    type: T,
    payload: Parameters<typeof buildDaemonEvent<T>>[1],
  ): Promise<void> {
    try {
      await this.#o.store.events.append({ ...buildDaemonEvent(type, payload), scenarioId });
    } catch (error) {
      this.#o.logger.warn({ err: error, scenarioId, type }, 'a ! command event was not written');
    }
  }

  async #finish(
    scenarioId: string,
    commandId: string,
    command: string,
    run: ShellRun,
    logPath: string,
    slot: PromiseWithResolvers<undefined>,
  ): Promise<void> {
    const o = this.#o;
    try {
      const { shell, terminal } = o.settings();
      let outcome: ShellCommandFinishedPayload['outcome'] = 'exited';
      let exitCode: number | null = null;
      let durationMs = 0;
      let logTruncated = false;
      let error: string | undefined;
      try {
        const result = await run.done;
        exitCode = result.exitCode;
        durationMs = result.durationMs;
        logTruncated = result.logTruncated;
        if (result.timedOut) outcome = 'timeout';
        else if (this.#stopping()) {
          outcome = 'failed';
          error = 'The daemon stopped while the command was running';
        }
      } catch (failure) {
        outcome = 'failed';
        error = failure instanceof Error ? failure.message : String(failure);
      }
      const raw = await readFile(logPath, 'utf8').catch(() => '');
      const snippet = cutSnippet(raw, terminal.snippet.max_lines, terminal.snippet.keep);
      const askedInput = seemsToAskForInput(raw, exitCode);
      let attachmentId: string | null = null;
      if (snippet.text !== '') {
        try {
          const record = await o.attachments.addText(scenarioId, {
            text: snippet.text,
            name: `terminal_snippet-${commandId}.txt`,
          });
          attachmentId = record.id;
        } catch (failure) {
          o.logger.warn(
            { err: failure, scenarioId, commandId },
            'the snippet of a ! command could not be attached',
          );
        }
      }
      const nothingToTell = outcome === 'exited' && exitCode === 0 && attachmentId === null;
      const context: ShellCommandFinishedPayload['context'] = nothingToTell
        ? 'none'
        : this.#stopping() || shell.context === 'never'
          ? 'never'
          : shell.context === 'auto'
            ? 'sent'
            : 'asked';
      await this.#append(scenarioId, 'chat.shell_command.finished', {
        commandId,
        outcome,
        exitCode,
        durationMs,
        totalLines: snippet.totalLines,
        shownLines: snippet.shownLines,
        keep: snippet.keep,
        logTruncated,
        attachmentId,
        askedInput,
        context,
        logPath,
        ...(error === undefined ? {} : { error }),
      });
      if (context !== 'sent' && context !== 'asked') return;
      const message = this.#messageFor({
        command,
        outcome,
        exitCode,
        timeoutMs: shell.timeout,
        durationMs,
        askedInput,
        snippet,
        attachmentId,
        error,
      });
      if (context === 'sent') await this.#sendToDirector(scenarioId, message, attachmentId);
      else {
        await this.#askAboutIt(scenarioId, message, attachmentId, {
          command,
          exitCode,
          lines: snippet.totalLines,
        });
      }
    } catch (failure) {
      o.logger.error({ err: failure, scenarioId, commandId }, 'the end of a ! command failed');
    } finally {
      this.#running.delete(commandId);
      slot.resolve(undefined);
    }
  }

  /** What the Director reads: the command, how it ended and where its output is. */
  #messageFor(input: {
    command: string;
    outcome: ShellCommandFinishedPayload['outcome'];
    exitCode: number | null;
    timeoutMs: number | null;
    durationMs: number;
    askedInput: boolean;
    snippet: ReturnType<typeof cutSnippet>;
    attachmentId: string | null;
    error: string | undefined;
  }): string {
    const lines = [
      `The Producer ran a shell command in the worktree of this scenario with the ! prefix: ${oneLine(input.command, 500)}`,
    ];
    if (input.outcome === 'timeout') {
      lines.push(
        `It was stopped after ${seconds(input.timeoutMs ?? input.durationMs)} (chat.shell_command.timeout) and its processes were ended.`,
      );
    } else if (input.outcome === 'failed') {
      lines.push(`It did not finish: ${input.error ?? 'unknown error'}.`);
    } else if (input.exitCode === null) {
      lines.push('It was ended by a signal.');
    } else {
      lines.push(`It exited with code ${String(input.exitCode)}.`);
    }
    if (input.askedInput) {
      lines.push(
        'It asked for input. The ! command gives no input (stdin is closed), so it got the end of the file.',
      );
    }
    if (input.attachmentId === null) {
      lines.push('It printed no output.');
    } else {
      const { totalLines, shownLines, keep } = input.snippet;
      const cut =
        shownLines < totalLines
          ? `the ${keep === 'tail' ? 'last' : 'first'} ${String(shownLines)} of ${String(totalLines)} lines`
          : `all ${String(totalLines)} lines`;
      lines.push(
        `Its output (${cut}) is attachment ${input.attachmentId}; read it with read_attachment.`,
      );
    }
    return lines.join('\n');
  }

  async #sendToDirector(
    scenarioId: string,
    message: string,
    attachmentId: string | null,
  ): Promise<void> {
    try {
      await this.#o.channel.send(scenarioId, message, attachmentId === null ? [] : [attachmentId]);
    } catch (failure) {
      this.#o.logger.warn(
        { err: failure, scenarioId },
        'the output of a ! command did not reach the Director',
      );
    }
  }

  /** `context: ask`: the Producer chooses; the answer, when it comes, sends or not. */
  async #askAboutIt(
    scenarioId: string,
    message: string,
    attachmentId: string | null,
    about: { command: string; exitCode: number | null; lines: number },
  ): Promise<void> {
    const { ask } = this.#o;
    const opened = await ask?.(scenarioId, {
      questions: [
        {
          question: `Send the result of "${oneLine(about.command, QUESTION_COMMAND_MAX)}" (${
            about.exitCode === null ? 'no exit code' : `exit code ${String(about.exitCode)}`
          }, ${String(about.lines)} lines) to the Director?`,
          options: [
            { label: SEND_LABEL, description: 'The Director reads the result and the output.' },
            { label: KEEP_LABEL, description: 'The output stays in the chat and the log only.' },
          ],
          multi_select: false,
          open: false,
          recommended: SEND_LABEL,
        },
      ],
    });
    if (opened === undefined) {
      this.#o.logger.warn({ scenarioId }, 'nobody could be asked about the output of a ! command');
      return;
    }
    // The answer is waited for in the background: the command is over, and a person decides.
    void opened.answer.then(
      async (answer) => {
        const given = answersOf(answer).map((text) => text.trim().toLowerCase());
        if (given.includes(SEND_LABEL.toLowerCase()) && !given.includes(KEEP_LABEL.toLowerCase())) {
          await this.#sendToDirector(scenarioId, message, attachmentId);
        }
      },
      () => undefined,
    );
  }
}
