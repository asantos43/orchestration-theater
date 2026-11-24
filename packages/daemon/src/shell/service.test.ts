// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  Conflict,
  InvalidInput,
  PermissionDenied,
  type JsonValue,
  type ProcessLauncher,
} from '@otheater/core';
import { InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { compose, defaultLauncher, probeSandbox } from '../compose.js';
import { parseConfig } from '../config.js';
import { describeWithLauncher, itWithLauncher } from '../launcher-fixture.js';
import type { CommandConfiner } from '../sandbox-wiring.js';
import { AttachmentService } from '../scenarios/attachments.js';
import { makeTempDataDir } from '../test-helpers.js';
import { realClock } from '../tools/tools-fixture.js';
import {
  commandOf,
  isShellCommand,
  KEEP_LABEL,
  SEND_LABEL,
  shellArgv,
  ShellCommandService,
  type ShellSettings,
} from './service.js';
import { ANY_ATTACHMENT_ROOT } from '../scenarios/attachment-roots.js';

afterAll(disposeTestGitIsolation);

const BASE: ShellSettings = {
  shell: { mode: 'on', timeout: 20_000, context: 'auto', max_running: 4 },
  // `host`: the tests that are not about the sandbox need no sandbox on the machine.
  terminalMode: 'host',
  terminal: { snippet: { max_lines: 200, keep: 'tail' }, log_max_size: 1024 * 1024 },
};

interface Rig {
  readonly root: string;
  readonly worktree: string;
  readonly store: InMemoryStore;
  readonly service: ShellCommandService;
  readonly sent: { text: string; attachments: readonly string[] }[];
  readonly asked: unknown[];
  set(
    patch: { shell?: Partial<ShellSettings['shell']> } & Partial<Omit<ShellSettings, 'shell'>>,
  ): void;
  events(type: string): Promise<{ payload: Record<string, unknown> }[]>;
  finished(): Promise<Record<string, unknown>>;
  attachmentText(id: string): Promise<string>;
}

interface RigOptions {
  readonly launcher?: ProcessLauncher | undefined;
  readonly confine?: CommandConfiner | undefined;
  /** The answer to the question of `context: ask`; without it nobody can be asked. */
  readonly answer?: JsonValue;
  readonly env?: Record<string, string>;
  readonly settings?: ShellSettings;
}

const roots: string[] = [];
const services: ShellCommandService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rigOf(options: RigOptions = {}): Promise<Rig> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-shell-')));
  roots.push(root);
  const worktree = join(root, 'wt');
  await mkdir(worktree);
  const store = new InMemoryStore({ clock: realClock });
  await store.scenarios.create({
    id: 's1',
    kind: 'chat',
    flowId: 'chat',
    name: 's1',
    folder: worktree,
  });
  let settings = options.settings ?? BASE;
  const answer = options.answer;
  const sent: Rig['sent'][number][] = [];
  const asked: unknown[] = [];
  const attachments = new AttachmentService({
    store,
    roots: ANY_ATTACHMENT_ROOT,
    clock: realClock,
    scenariosDir: join(root, 'scenarios'),
    limits: () => ({ maxSize: 1024 * 1024, readMax: 1024 * 1024 }),
  });
  const service = new ShellCommandService({
    store,
    clock: realClock,
    launcher: 'launcher' in options ? options.launcher : defaultLauncher(),
    confine: options.confine,
    attachments,
    channel: {
      send: (_scenarioId, text, ids) => {
        sent.push({ text, attachments: ids ?? [] });
        return Promise.resolve();
      },
    },
    ...(answer === undefined
      ? {}
      : {
          ask: (_scenarioId, input) => {
            asked.push(input);
            return Promise.resolve({ decisionId: 'd1', answer: Promise.resolve(answer) });
          },
        }),
    env: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', ...options.env }),
    scenariosDir: join(root, 'scenarios'),
    settings: () => settings,
    logger: { warn: vi.fn(), error: vi.fn() } as never,
  });
  services.push(service);
  const events: Rig['events'] = async (type) =>
    (await store.events.readFrom(0, 10_000)).filter((event) => event.type === type);
  return {
    root,
    worktree,
    store,
    service,
    sent,
    asked,
    set: (patch) => {
      settings = {
        ...settings,
        ...patch,
        shell: { ...settings.shell, ...patch.shell },
      };
    },
    events,
    finished: () =>
      vi.waitFor(
        async () => {
          const [event] = await events('chat.shell_command.finished');
          if (event === undefined) throw new Error('the command has not finished');
          return event.payload;
        },
        { timeout: 20_000, interval: 25 },
      ),
    attachmentText: async (id) => {
      const record = await store.attachments.get('s1', id);
      if (record === undefined) throw new Error(`no attachment ${id}`);
      return readFile(record.path, 'utf8');
    },
  };
}

describe('the line of a ! message', () => {
  it('is a command when the first character that is not a blank is !', () => {
    expect(isShellCommand('!ls')).toBe(true);
    expect(isShellCommand('  ! ls -la ')).toBe(true);
    expect(isShellCommand('ls !')).toBe(false);
    expect(isShellCommand('/help')).toBe(false);
    expect(commandOf('  ! ls -la ')).toBe('ls -la');
    expect(commandOf('!')).toBe('');
  });

  it('runs through sh -c (cmd.exe on Windows)', () => {
    expect(shellArgv('echo hi', 'linux')).toEqual(['/bin/sh', '-c', 'echo hi']);
    expect(shellArgv('echo hi', 'darwin')).toEqual(['/bin/sh', '-c', 'echo hi']);
    expect(shellArgv('echo hi', 'win32')).toEqual(['cmd.exe', '/d', '/s', '/c', 'echo hi']);
  });
});

describeWithLauncher('the ! command: run, events and snippet', () => {
  it('runs in the worktree, writes started and finished with no output, and attaches the snippet', async () => {
    const rig = await rigOf();
    await writeFile(join(rig.worktree, 'marker.txt'), 'x');
    const { commandId } = await rig.service.start('s1', '! ls; echo oops 1>&2; exit 3');
    const done = await rig.finished();

    const [started] = await rig.events('chat.shell_command.started');
    expect(started?.payload).toEqual({
      commandId,
      command: 'ls; echo oops 1>&2; exit 3',
      place: 'host',
    });
    expect(done).toMatchObject({
      commandId,
      outcome: 'exited',
      exitCode: 3,
      totalLines: 2,
      shownLines: 2,
      keep: 'tail',
      logTruncated: false,
      askedInput: false,
      context: 'sent',
    });
    // The events say how it ended, never what it printed.
    expect(JSON.stringify([started, done])).not.toContain('marker.txt');
    expect(JSON.stringify(done)).not.toContain('oops');

    const attachmentId = done.attachmentId as string;
    expect(attachmentId).toMatch(/^A\d+$/);
    const record = await rig.store.attachments.get('s1', attachmentId);
    expect(record?.name).toBe(`terminal_snippet-${commandId}.txt`);
    expect(await rig.attachmentText(attachmentId)).toBe('marker.txt\noops');
    // The whole output stays in the log of the command (owner only).
    expect(await readFile(done.logPath as string, 'utf8')).toBe('marker.txt\noops\n');
    // The Director is told, with the attachment, and only that.
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0]?.attachments).toEqual([attachmentId]);
    expect(rig.sent[0]?.text).toContain('exited with code 3');
    expect(rig.sent[0]?.text).toContain(`attachment ${attachmentId}`);
    expect(await rig.service.snippetOf('s1', attachmentId)).toBe('marker.txt\noops');
    expect(await rig.service.snippetOf('s1', null)).toBe('');
  });

  it('cuts a long output at terminal.snippet.max_lines and keeps all of it in the log', async () => {
    const rig = await rigOf();
    rig.set({ terminal: { snippet: { max_lines: 5, keep: 'tail' }, log_max_size: 1024 * 1024 } });
    await rig.service.start('s1', '!seq 1 300');
    const done = await rig.finished();
    expect(done).toMatchObject({ totalLines: 300, shownLines: 5, keep: 'tail' });
    expect(await rig.attachmentText(done.attachmentId as string)).toBe('296\n297\n298\n299\n300');
    expect((await readFile(done.logPath as string, 'utf8')).split('\n')).toHaveLength(301);
    expect(rig.sent[0]?.text).toContain('the last 5 of 300 lines');
  });

  it('keeps the first lines with terminal.snippet.keep: head', async () => {
    const rig = await rigOf();
    rig.set({ terminal: { snippet: { max_lines: 3, keep: 'head' }, log_max_size: 1024 * 1024 } });
    await rig.service.start('s1', '!seq 1 50');
    const done = await rig.finished();
    expect(await rig.attachmentText(done.attachmentId as string)).toBe('1\n2\n3');
    expect(rig.sent[0]?.text).toContain('the first 3 of 50 lines');
  });

  it('stops the log at terminal.log_max_size and says so', async () => {
    const rig = await rigOf();
    rig.set({ terminal: { snippet: { max_lines: 200, keep: 'tail' }, log_max_size: 100 } });
    await rig.service.start('s1', '!seq 1 1000');
    const done = await rig.finished();
    expect(done.logTruncated).toBe(true);
    expect((await readFile(done.logPath as string)).length).toBe(100);
  });

  it('ends a command that reads, with the end of the file, and records that it asked for input', async () => {
    const rig = await rigOf();
    const started = Date.now();
    await rig.service.start('s1', "!printf 'Continue? '; read answer");
    const done = await rig.finished();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(done).toMatchObject({ outcome: 'exited', askedInput: true });
    expect(done.exitCode).not.toBe(0);
    expect(rig.sent[0]?.text).toContain('It asked for input');
    expect(rig.sent[0]?.text).toContain('stdin is closed');
  });

  it('ends a command that only waits on its stdin (cat) too, though nothing says it asked', async () => {
    const rig = await rigOf();
    await rig.service.start('s1', '!cat');
    const done = await rig.finished();
    expect(done).toMatchObject({
      outcome: 'exited',
      exitCode: 0,
      attachmentId: null,
      context: 'none',
    });
    // Known limit: the daemon cannot see a process read its stdin, only what the output shows.
    expect(done.askedInput).toBe(false);
    expect(rig.sent).toHaveLength(0);
  });

  it("gives the command the minimal environment of the tools, not the daemon's", async () => {
    process.env.OT_SHELL_TEST_SECRET = 'leaked';
    try {
      const rig = await rigOf({ env: { ONLY_THIS: 'yes' } });
      await rig.service.start('s1', '!echo "[$ONLY_THIS][$OT_SHELL_TEST_SECRET][$TERM]"');
      const done = await rig.finished();
      expect(await rig.attachmentText(done.attachmentId as string)).toBe('[yes][][dumb]');
    } finally {
      delete process.env.OT_SHELL_TEST_SECRET;
    }
  });

  it('runs in the folder of the repository of a project, not in the scenario folder', async () => {
    const rig = await rigOf();
    const repo = join(rig.root, 'repo');
    await mkdir(repo);
    await rig.store.scenarioRepos.put({
      scenarioId: 's1',
      path: repo,
      remote: null,
      mainBranch: 'main',
    });
    await rig.service.start('s1', '!pwd');
    const done = await rig.finished();
    expect(await rig.attachmentText(done.attachmentId as string)).toBe(repo);
  });
});

describeWithLauncher('the ! command: the timeout ends the whole tree', () => {
  it('kills the command and the process it started when chat.shell_command.timeout passes', async () => {
    const rig = await rigOf();
    rig.set({ shell: { timeout: 400 } });
    const pidFile = join(rig.root, 'child.pid');
    await rig.service.start('s1', `!sleep 60 & echo $! > '${pidFile}'; wait`);
    const done = await rig.finished();
    expect(done).toMatchObject({ outcome: 'timeout', exitCode: null });
    const child = Number((await readFile(pidFile, 'utf8')).trim());
    expect(child).toBeGreaterThan(1);
    try {
      await vi.waitFor(
        () => {
          // Signal 0 only asks whether the process is there: ESRCH is "gone".
          expect(() => process.kill(child, 0)).toThrow(/ESRCH/);
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      try {
        process.kill(child, 'SIGKILL');
      } catch {
        // already gone: what the test wants
      }
    }
    expect(rig.sent[0]?.text).toContain('stopped after 0.4s');
    expect(rig.sent[0]?.text).toContain('processes were ended');
  });

  it('has no deadline with timeout: off (null)', async () => {
    const rig = await rigOf();
    rig.set({ shell: { timeout: null } });
    await rig.service.start('s1', '!sleep 0.3; echo late');
    const done = await rig.finished();
    expect(done).toMatchObject({ outcome: 'exited', exitCode: 0 });
  });

  it('ends the running commands when the daemon stops, and tells nobody else', async () => {
    const rig = await rigOf();
    rig.set({ shell: { timeout: null } });
    const pidFile = join(rig.root, 'child.pid');
    await rig.service.start('s1', `!sleep 60 & echo $! > '${pidFile}'; wait`);
    await vi.waitFor(() => {
      expect(existsSync(pidFile)).toBe(true);
    });
    await rig.service.close();
    const done = await rig.finished();
    expect(done).toMatchObject({ outcome: 'failed', context: 'never' });
    expect(rig.sent).toHaveLength(0);
    const child = Number((await readFile(pidFile, 'utf8')).trim());
    await vi.waitFor(() => {
      expect(() => process.kill(child, 0)).toThrow(/ESRCH/);
    });
    await expect(rig.service.start('s1', '!true')).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('refuses one command too many in a scenario (chat.shell_command.max_running)', async () => {
    const rig = await rigOf();
    rig.set({ shell: { max_running: 1, timeout: null } });
    await rig.service.start('s1', '!sleep 30');
    expect(rig.service.runningIn('s1')).toBe(1);
    await expect(rig.service.start('s1', '!true')).rejects.toBeInstanceOf(Conflict);
    await rig.service.close();
  });
});

describe('the ! command: what refuses', () => {
  it('refuses with chat.shell_command: off and with app.terminal: off, and runs nothing', async () => {
    const rig = await rigOf();
    const mark = join(rig.worktree, 'ran.txt');
    rig.set({ shell: { mode: 'off' } });
    await expect(rig.service.start('s1', `!touch '${mark}'`)).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    rig.set({ shell: { mode: 'on' }, terminalMode: 'off' });
    await expect(rig.service.start('s1', `!touch '${mark}'`)).rejects.toThrow(/app\.terminal: off/);
    expect(existsSync(mark)).toBe(false);
    expect(await rig.events('chat.shell_command.started')).toEqual([]);
  });

  it('refuses an empty command and a scenario that does not exist', async () => {
    const rig = await rigOf();
    await expect(rig.service.start('s1', '!   ')).rejects.toBeInstanceOf(InvalidInput);
    await expect(rig.service.start('nope', '!true')).rejects.toThrow(/no scenario/);
  });

  it('never runs unconfined: app.terminal: sandbox with no sandbox is a refusal', async () => {
    const rig = await rigOf();
    const mark = join(rig.worktree, 'ran.txt');
    rig.set({ terminalMode: 'sandbox' });
    await expect(rig.service.start('s1', `!touch '${mark}'`)).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
    expect(existsSync(mark)).toBe(false);
  });

  itWithLauncher('does not run the command when the sandbox cannot wrap it', async () => {
    const rig = await rigOf({ confine: () => Promise.reject(new Error('the sandbox is gone')) });
    const mark = join(rig.worktree, 'ran.txt');
    rig.set({ terminalMode: 'sandbox' });
    await expect(rig.service.start('s1', `!touch '${mark}'`)).rejects.toThrow(/sandbox is gone/);
    expect(existsSync(mark)).toBe(false);
  });

  it('refuses where there is no process launcher', async () => {
    const rig = await rigOf({ launcher: undefined });
    await expect(rig.service.start('s1', '!true')).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('refuses context: ask when nobody can be asked', async () => {
    const rig = await rigOf();
    rig.set({ shell: { context: 'ask' } });
    await expect(rig.service.start('s1', '!true')).rejects.toBeInstanceOf(AdapterUnavailable);
  });
});

describeWithLauncher('the ! command: chat.shell_command.context', () => {
  it('never: the output stays in the chat and the log, the Director hears nothing', async () => {
    const rig = await rigOf();
    rig.set({ shell: { context: 'never' } });
    await rig.service.start('s1', '!echo hi');
    const done = await rig.finished();
    expect(done).toMatchObject({ context: 'never' });
    expect(done.attachmentId).toMatch(/^A\d+$/);
    expect(rig.sent).toHaveLength(0);
  });

  it('auto: a command that did nothing worth telling is not sent either', async () => {
    const rig = await rigOf();
    await rig.service.start('s1', '!true');
    expect(await rig.finished()).toMatchObject({ context: 'none', attachmentId: null });
    expect(rig.sent).toHaveLength(0);
    // ...but a failure with no output is: the Director learns it failed.
    await rig.service.start('s1', '!false');
    await vi.waitFor(() => {
      expect(rig.sent).toHaveLength(1);
    });
    expect(rig.sent[0]).toMatchObject({ attachments: [] });
    expect(rig.sent[0]?.text).toContain('exited with code 1');
    expect(rig.sent[0]?.text).toContain('printed no output');
  });

  it('ask: the Producer is asked and the answer Send sends it', async () => {
    const rig = await rigOf({ answer: { selected: [SEND_LABEL] } });
    rig.set({ shell: { context: 'ask' } });
    await rig.service.start('s1', '!echo hi');
    const done = await rig.finished();
    expect(done.context).toBe('asked');
    await vi.waitFor(() => {
      expect(rig.sent).toHaveLength(1);
    });
    expect(rig.asked).toHaveLength(1);
    expect(JSON.stringify(rig.asked[0])).toContain('echo hi');
    expect(rig.sent[0]?.attachments).toEqual([done.attachmentId]);
  });

  it('ask: the question says where it comes from, with the command it is about (N205)', async () => {
    const rig = await rigOf({ answer: { selected: [KEEP_LABEL] } });
    rig.set({ shell: { context: 'ask' } });
    await rig.service.start('s1', '!echo hi');
    const done = await rig.finished();
    await vi.waitFor(() => {
      expect(rig.asked).toHaveLength(1);
    });
    expect(rig.asked[0]).toMatchObject({
      source: 'shell',
      shell: { commandId: done.commandId, command: 'echo hi', exitCode: 0, lines: 1 },
    });
  });

  it('ask: Keep, free text or anything else sends nothing', async () => {
    for (const answer of [{ selected: [KEEP_LABEL] }, 'sure, why not', [SEND_LABEL, KEEP_LABEL]]) {
      const rig = await rigOf({ answer });
      rig.set({ shell: { context: 'ask' } });
      await rig.service.start('s1', '!echo hi');
      expect((await rig.finished()).context).toBe('asked');
      await vi.waitFor(() => {
        expect(rig.asked).toHaveLength(1);
      });
      // Let the answer be read before saying it was not sent.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rig.sent).toHaveLength(0);
    }
  });
});

describe('the ! command: layer 3 (the sandbox)', () => {
  let issue: string | undefined;

  beforeAll(async () => {
    const availability = await probeSandbox();
    if (!availability.ok) {
      issue = availability.reason;
      if (process.env.OT_REQUIRE_SANDBOX === '1') {
        throw new Error(
          `OT_REQUIRE_SANDBOX=1 but the sandbox is not available: ${availability.reason}`,
        );
      }
    }
  });

  it('with app.terminal: sandbox a write inside the worktree goes through and one outside is blocked', async (context) => {
    if (issue !== undefined) context.skip();
    const tmp = await makeTempDataDir();
    const composition = await compose(parseConfig(''), {
      dataDir: tmp.dir,
      overrides: {
        clock: realClock,
        store: new InMemoryStore({ clock: realClock }),
        vault: new InMemorySecretVault(),
      },
    });
    try {
      const confine = composition.sandbox?.confineCommand;
      expect(confine, 'the sandbox is available, so compose wired it').toBeDefined();
      const rig = await rigOf({ confine });
      rig.set({ terminalMode: 'sandbox' });
      const outside = join(rig.root, 'outside.txt');
      await rig.service.start('s1', '!echo inside > inside.txt; echo outside > ../outside.txt');
      const done = await rig.finished();
      expect((await rig.events('chat.shell_command.started'))[0]?.payload).toMatchObject({
        place: 'sandbox',
      });
      expect(await readFile(join(rig.worktree, 'inside.txt'), 'utf8')).toBe('inside\n');
      expect(existsSync(outside)).toBe(false);
      expect(done.exitCode).not.toBe(0);
      expect(done.outcome).toBe('exited');
    } finally {
      await composition.close();
      await tmp.dispose();
    }
  });
});
