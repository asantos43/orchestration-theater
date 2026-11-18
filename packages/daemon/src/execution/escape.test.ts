// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RolePolicy } from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeSandbox } from '../compose.js';
import {
  BASE_POLICY,
  chunksOf,
  escapePrompt,
  FAKE_AGENT_CLI,
  installFakes,
  permissionsOf,
  SHELLS_POLICY,
  specOf,
  toolCallsOf,
  toolEndsOf,
  withFakeDaemon,
  withOutside,
  type Outside,
  type Rig,
} from './escape-fixture.js';

installFakes({
  clock: () => new FakeClock(),
  vault: () => new InMemorySecretVault(),
  client: ({ parts, unenforced, enforcement, command }) =>
    new FakeClientAdapter({
      launcher: parts.launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      enforcement,
      unenforced,
      command,
      ...(parts.sandbox === undefined
        ? {}
        : { sandbox: parts.sandbox.capabilities, launchWrapper: parts.sandbox.launchWrapper }),
    }),
});

/**
 * The escape suite (Phase 4, P5; architecture 5.8): a fake agent that tries to leave its
 * confinement, one attempt per step, and a test that never believes what the agent says. The
 * ground truth is the disk (no file outside, the secret untouched), the network (a local server
 * that must receive nothing) and the events of the daemon (`permission.answered` for layer 2,
 * `tool.finished` for the shells), which also say WHICH layer stopped each attempt.
 *
 * Three groups, by who holds:
 * - layer 2, the answers of the daemon to `session/request_permission` (here with the fake agent
 *   over the real ACP stdio; no sandbox needed, the checks are the daemon's own);
 * - the shells of the daemon (`restricted_shell`, `run_tests`): argv rules and path confinement;
 * - layer 3, the operating system (bubblewrap on Linux): what no rule of the daemon can see, a
 *   write the client makes by itself, a program it runs by itself, the network. Skipped without a
 *   working sandbox, unless `OT_REQUIRE_SANDBOX=1` (the CI sets it), which turns it into a failure.
 *
 * Layer 1 (the configuration of each real client) cannot be seen with the fake agent: it is what
 * `escape.real.test.ts` and the level `escape` of `tools/acceptance/real-acceptance.sh` are for.
 * The client is the compiled `dist/cli.js`, so `pnpm build` comes first.
 */

let sandboxIssue: string | undefined;

beforeAll(async () => {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
  const availability = await probeSandbox();
  if (!availability.ok) {
    sandboxIssue = availability.reason;
    if (process.env.OT_REQUIRE_SANDBOX === '1') {
      throw new Error(
        `OT_REQUIRE_SANDBOX=1 but the sandbox is not available: ${availability.reason}`,
      );
    }
  }
});
afterAll(disposeTestGitIsolation);

/** Layer 2 without layer 3: the checks are the daemon's own, so any machine can run them. */
const NO_SANDBOX = { config: 'sandbox:\n  mode: off\n', unenforced: true } as const;

const RULES = (
  rules: NonNullable<RolePolicy['rules']>,
  network: readonly string[] = [],
): RolePolicy => ({
  ...BASE_POLICY,
  onAsk: 'rules',
  rules,
  network: { allow: network },
});

/** What an attempt left on the disk: the files of the outside folder, with the secret. */
async function outsideFiles(outside: Outside): Promise<string[]> {
  return (await readdir(outside.outsideDir)).sort();
}

async function secretIntact(outside: Outside): Promise<boolean> {
  return (await readFile(join(outside.outsideDir, 'secret.txt'), 'utf8')) === 'not a real secret\n';
}

/** Runs one attempt of the fake agent with the steps and returns what the test checks. */
async function attempt(
  rig: Rig,
  demandId: string,
  steps: readonly Record<string, unknown>[],
  policy: RolePolicy,
  role: 'author' | 'actor' = 'actor',
) {
  const runner = rig.daemon.execution?.runner;
  if (runner === undefined) throw new Error('the daemon has no execution');
  const result = await runner.run(specOf(rig, demandId, escapePrompt(steps), policy, role));
  const events = await rig.daemon.store.events.readFrom(0, 100_000);
  return {
    result,
    worktree: result.worktree,
    /** The folder the worktrees of the attempts live in: what `../x` from the worktree reaches. */
    parent: dirname(result.worktree),
    text: chunksOf(events, result.attemptId),
    permissions: permissionsOf(events, result.attemptId),
    tools: toolEndsOf(events, result.attemptId),
    toolCalls: (tool: string) => toolCallsOf(events, result.attemptId, tool),
  };
}

describe('layer 2: the native tools of the client are answered by the role policy', () => {
  it('rejects a write that leaves the worktree, whichever way it is spelled, even under a rule that allows edits', async () => {
    await withOutside(async (outside) => {
      await withFakeDaemon(NO_SANDBOX, async (rig) => {
        const abs = join(outside.outsideDir, 'abs.txt');
        const seen = await attempt(
          rig,
          'write-escape',
          [
            { label: 'inside', kind: 'write', path: 'inside.txt' },
            { label: 'dotdot', kind: 'write', path: '../escaped-dotdot.txt' },
            { label: 'nested', kind: 'write', path: 'docs/../../escaped-nested.txt' },
            { label: 'absolute', kind: 'write', path: abs },
            { kind: 'symlink', link: 'evil-dir', target: outside.outsideDir },
            { label: 'dir-link', kind: 'write', path: 'evil-dir/through-dir-link.txt' },
            { label: 'dir-link-new', kind: 'write', path: 'evil-dir/sub/new.txt' },
            { kind: 'symlink', link: 'evil-file', target: join(outside.outsideDir, 'secret.txt') },
            { label: 'file-link', kind: 'write', path: 'evil-file' },
          ],
          RULES([{ id: 'any-edit', action: 'allow', kind: 'edit' }]),
        );
        expect(seen.result).toMatchObject({ state: 'completed' });

        // Layer 2 answered: the write inside by the rule, every escape by N99, over the rule.
        expect(seen.permissions.map((p) => [p.answer, p.reason, p.overruledRule])).toEqual([
          ['allow', 'rule', undefined],
          ...Array.from({ length: 6 }, () => ['reject', 'write_outside_worktree', 'any-edit']),
        ]);
        expect(seen.permissions[0]?.rule).toBe('any-edit');

        // The disk: the allowed write landed; nothing landed outside; the secret is untouched.
        expect(existsSync(join(seen.worktree, 'inside.txt'))).toBe(true);
        expect(existsSync(join(seen.parent, 'escaped-dotdot.txt'))).toBe(false);
        expect(existsSync(join(seen.parent, 'escaped-nested.txt'))).toBe(false);
        expect(await outsideFiles(outside)).toEqual(['secret.txt']);
        expect(await secretIntact(outside)).toBe(true);
      });
    });
  }, 90_000);

  it('rejects the native shell of the client in every spelling, even under a rule that allows it', async () => {
    await withOutside(async (outside) => {
      await withFakeDaemon(NO_SANDBOX, async (rig) => {
        const out = (name: string): string => join(outside.outsideDir, name);
        const seen = await attempt(
          rig,
          'shell-escape',
          [
            { kind: 'native_shell', command: `touch ${out('n1')}` },
            { kind: 'native_shell', command: `bash -c 'touch ${out('n2')}'` },
            { kind: 'native_shell', command: `/bin/touch ${out('n3')}` },
            { kind: 'native_shell', command: `true; touch ${out('n4')}` },
            { kind: 'native_shell', command: `echo $(touch ${out('n5')})` },
            { kind: 'native_shell', command: `true | touch ${out('n6')}` },
            { kind: 'native_shell', command: 'touch inside-shell.txt' },
          ],
          RULES([{ id: 'any-exec', action: 'allow', kind: 'execute' }]),
        );
        expect(seen.result).toMatchObject({ state: 'completed' });
        expect(seen.permissions).toHaveLength(7);
        for (const answer of seen.permissions) {
          expect(answer).toMatchObject({
            kind: 'execute',
            answer: 'reject',
            reason: 'native_shell',
            overruledRule: 'any-exec',
          });
        }
        // Not even the harmless command inside the worktree ran: the shell of the client is never
        // available, in the worktree or out of it.
        expect(existsSync(join(seen.worktree, 'inside-shell.txt'))).toBe(false);
        expect(await outsideFiles(outside)).toEqual(['secret.txt']);
      });
    });
  }, 90_000);

  it('rejects the native fetch to a host outside network.allow and a switch of mode, over the rules', async () => {
    await withOutside(async (outside) => {
      await withFakeDaemon(NO_SANDBOX, async (rig) => {
        const url = `http://127.0.0.1:${String(outside.port)}/`;
        const seen = await attempt(
          rig,
          'fetch-escape',
          [
            { kind: 'native_fetch', url },
            { kind: 'native_fetch', url: `http://localhost:${String(outside.port)}/` },
            { kind: 'native_fetch', url: 'not a url' },
            { kind: 'switch_mode', mode: 'bypassPermissions' },
          ],
          RULES([
            { id: 'any-fetch', action: 'allow', kind: 'fetch' },
            { id: 'any-switch', action: 'allow', kind: 'switch_mode' },
          ]),
        );
        expect(seen.result).toMatchObject({ state: 'completed' });
        expect(seen.permissions.map((p) => [p.answer, p.reason, p.overruledRule, p.host])).toEqual([
          ['reject', 'network_outside_allow', 'any-fetch', '127.0.0.1'],
          ['reject', 'network_outside_allow', 'any-fetch', 'localhost'],
          ['reject', 'network_outside_allow', 'any-fetch', undefined],
          ['reject', 'mode_switch', 'any-switch', undefined],
        ]);
        expect(outside.requests()).toBe(0);
      });
    });
  }, 90_000);

  it('lets the fetch through only to a host that network.allow names (the control of the test above)', async () => {
    await withOutside(async (outside) => {
      await withFakeDaemon(NO_SANDBOX, async (rig) => {
        const seen = await attempt(
          rig,
          'fetch-allowed',
          [
            { kind: 'native_fetch', url: `http://127.0.0.1:${String(outside.port)}/` },
            { kind: 'native_fetch', url: `http://localhost:${String(outside.port)}/` },
          ],
          RULES([{ id: 'any-fetch', action: 'allow', kind: 'fetch' }], ['127.0.0.1']),
        );
        expect(seen.permissions.map((p) => [p.answer, p.reason, p.host])).toEqual([
          ['allow', 'rule', '127.0.0.1'],
          ['reject', 'network_outside_allow', 'localhost'],
        ]);
        // Only the allowed host was reached: one request, from the first step.
        expect(outside.requests()).toBe(1);
      });
    });
  }, 90_000);

  it('with the default onAsk: reject nothing is released, not even a write inside the worktree', async () => {
    await withOutside(async (outside) => {
      await withFakeDaemon(NO_SANDBOX, async (rig) => {
        const seen = await attempt(
          rig,
          'on-ask-reject',
          [
            { kind: 'write', path: 'inside.txt' },
            { kind: 'write', path: join(outside.outsideDir, 'abs.txt') },
            { kind: 'native_shell', command: 'touch inside-shell.txt' },
            { kind: 'native_fetch', url: `http://127.0.0.1:${String(outside.port)}/` },
            { kind: 'switch_mode' },
          ],
          BASE_POLICY,
        );
        expect(seen.permissions.map((p) => [p.answer, p.reason, p.rule])).toEqual(
          Array.from({ length: 5 }, () => ['reject', 'on_ask_reject', 'none']),
        );
        expect(existsSync(join(seen.worktree, 'inside.txt'))).toBe(false);
        expect(existsSync(join(seen.worktree, 'inside-shell.txt'))).toBe(false);
        expect(await outsideFiles(outside)).toEqual(['secret.txt']);
        expect(outside.requests()).toBe(0);
      });
    });
  }, 90_000);
});

/**
 * The shells of the daemon (`nativeShell: 'shells'`): the Executor never gets the shell of its
 * client, it gets `restricted_shell {argv}`, which has no shell at all. Each case is one call and
 * the code the daemon answered with; a refused call ran nothing, so the markers must be absent.
 */
interface ShellCase {
  readonly label: string;
  readonly tool: 'restricted_shell' | 'run_tests';
  readonly arguments: Record<string, unknown>;
  readonly outcome: 'refused' | 'ok' | 'failed';
  readonly code?: string;
}

describe('the shells of the daemon: argv rules and confinement to the worktree', () => {
  it('refuses chains, pipes, substitutions, programs by path, paths that climb, symlinks and flags that write', async () => {
    await withOutside(async (outside) => {
      await withFakeDaemon(
        {
          ...NO_SANDBOX,
          config: `${NO_SANDBOX.config}tools:\n  commands:\n    test: node --version\n`,
        },
        async (rig) => {
          const marker = join(outside.outsideDir, 'marker');
          const shell = (
            label: string,
            argv: readonly string[],
            outcome: ShellCase['outcome'],
            code?: string,
          ): ShellCase => ({
            label,
            tool: 'restricted_shell',
            arguments: { argv },
            outcome,
            ...(code === undefined ? {} : { code }),
          });
          const cases: ShellCase[] = [
            // The control: the shell works for what it is meant to do.
            shell('control: cat a file of the worktree', ['cat', 'README.md'], 'ok'),
            // No shell, so syntax is not understood: it is refused when it is whole...
            shell('chain with ;', ['ls', '.', ';', 'touch', marker], 'refused', 'shell_syntax'),
            shell('pipe with |', ['cat', 'README.md', '|', 'sh'], 'refused', 'shell_syntax'),
            shell('chain with &&', ['ls', '&&', 'touch', marker], 'refused', 'shell_syntax'),
            shell('chain with ||', ['ls', '||', 'touch', marker], 'refused', 'shell_syntax'),
            shell('background with &', ['ls', '&', 'touch', marker], 'refused', 'shell_syntax'),
            shell('substitution $()', ['ls', `$(touch ${marker})`], 'refused', 'shell_syntax'),
            shell(
              'substitution with backticks',
              ['ls', `\`touch ${marker}\``],
              'refused',
              'shell_syntax',
            ),
            shell('variable expansion', ['ls', '$HOME'], 'refused', 'shell_syntax'),
            shell(
              'redirect as its own argument',
              ['cat', 'README.md', '>', marker],
              'refused',
              'shell_syntax',
            ),
            shell(
              'redirect glued to a path',
              ['cat', 'README.md', `>${marker}`],
              'refused',
              'shell_syntax',
            ),
            // ...and inert when it is glued: with no shell it is one odd file name (the call runs,
            // `ls` finds nothing, and `touch` never starts).
            shell('control: glued chain is a file name', ['ls', `a;touch ${marker}`], 'failed'),
            // A program called by path, or one that is not on the list, or that hides in an option.
            shell('program by absolute path', ['/bin/touch', marker], 'refused', 'program_by_path'),
            shell('program by relative path', ['./run.sh'], 'refused', 'program_by_path'),
            shell('program in the parent folder', ['../tool'], 'refused', 'program_by_path'),
            shell('program with the home folder', ['~/bin/tool'], 'refused', 'program_by_path'),
            shell('sh -c', ['sh', '-c', `touch ${marker}`], 'refused', 'program_not_allowed'),
            shell('bash -c', ['bash', '-c', `touch ${marker}`], 'refused', 'program_not_allowed'),
            shell('env as a launcher', ['env', 'touch', marker], 'refused', 'program_not_allowed'),
            shell('touch itself', ['touch', marker], 'refused', 'program_not_allowed'),
            shell('curl', ['curl', 'http://127.0.0.1:1/'], 'refused', 'program_not_allowed'),
            shell(
              'git with an option before the subcommand',
              ['git', '-C', '..', 'status'],
              'refused',
              'program_not_allowed',
            ),
            shell(
              'git with a configured pager',
              ['git', '-c', 'core.pager=sh', 'log'],
              'refused',
              'program_not_allowed',
            ),
            shell(
              'git subcommand that writes',
              ['git', 'checkout', '-b', 'x'],
              'refused',
              'program_not_allowed',
            ),
            // Flags that turn a reader into a writer or a launcher.
            shell(
              'git diff --output',
              ['git', 'diff', `--output=${marker}`],
              'refused',
              'forbidden_flag',
            ),
            shell('git --ext-diff', ['git', 'diff', '--ext-diff'], 'refused', 'forbidden_flag'),
            shell('rg --pre', ['rg', '--pre=sh', 'x'], 'refused', 'forbidden_flag'),
            // Paths that leave the worktree.
            shell('dotdot', ['cat', '../../etc/passwd'], 'refused', 'path_escapes'),
            shell('nested dotdot', ['ls', 'docs/../../..'], 'refused', 'path_escapes'),
            shell('absolute path', ['cat', '/etc/passwd'], 'refused', 'path_escapes'),
            shell('home folder', ['ls', '~'], 'refused', 'path_escapes'),
            shell(
              'absolute path in an option',
              ['rg', 'x', '--ignore-file=/etc/passwd'],
              'refused',
              'path_escapes',
            ),
            shell('absolute path after --', ['cat', '--', marker], 'refused', 'path_escapes'),
            // Symlinks the Executor made inside the worktree, pointing out.
            shell(
              'symlink to a folder',
              ['cat', 'dir-link/secret.txt'],
              'refused',
              'symlink_escapes',
            ),
            shell('symlink to a file', ['cat', 'file-link'], 'refused', 'symlink_escapes'),
            // run_tests takes no command from the model, and its target is a path of the worktree.
            { label: 'run_tests, no target', tool: 'run_tests', arguments: {}, outcome: 'ok' },
            {
              label: 'run_tests, target out',
              tool: 'run_tests',
              arguments: { target: '../outside' },
              outcome: 'refused',
              code: 'path_escapes',
            },
            {
              label: 'run_tests, absolute target',
              tool: 'run_tests',
              arguments: { target: outside.outsideDir },
              outcome: 'refused',
              code: 'path_escapes',
            },
            {
              label: 'run_tests, option as target',
              tool: 'run_tests',
              arguments: { target: '--eval=x' },
              outcome: 'refused',
              code: 'forbidden_flag',
            },
          ];
          const seen = await attempt(
            rig,
            'shell-rules',
            [
              { kind: 'symlink', link: 'dir-link', target: outside.outsideDir },
              {
                kind: 'symlink',
                link: 'file-link',
                target: join(outside.outsideDir, 'secret.txt'),
              },
              ...cases.map((c) => ({
                kind: 'mcp',
                label: c.label,
                tool: c.tool,
                arguments: c.arguments,
              })),
            ],
            SHELLS_POLICY,
          );
          expect(seen.result).toMatchObject({ state: 'completed' });

          // One tool.finished per call, in order: the layer (the code) is part of the answer.
          expect(seen.tools.map((t) => [t.tool, t.outcome, t.errorCode])).toEqual(
            cases.map((c) => [c.tool, c.outcome, c.code]),
          );
          // Nothing refused ran: no marker outside, none inside, the secret untouched.
          expect(await outsideFiles(outside)).toEqual(['secret.txt']);
          expect(await secretIntact(outside)).toBe(true);
          expect(existsSync(join(seen.worktree, 'marker'))).toBe(false);
          // The agent was told so, in the words of the code, not only in the events.
          expect(seen.text).toContain('shell_syntax');
          expect(seen.text).toContain('symlink_escapes');
          // And the permission layer saw nothing: the tools are MCP calls, they never ask.
          expect(seen.permissions).toEqual([]);
        },
      );
    });
  }, 120_000);

  it('does not list or call a tool that mcpTools leaves out of the role', async () => {
    await withOutside(async (outside) => {
      await withFakeDaemon(NO_SANDBOX, async (rig) => {
        const marker = join(outside.outsideDir, 'marker');
        const seen = await attempt(
          rig,
          'mcp-filter',
          [
            {
              kind: 'mcp',
              label: 'restricted_shell not granted',
              tool: 'restricted_shell',
              arguments: { argv: ['ls'] },
            },
            {
              kind: 'mcp',
              label: 'install_deps not granted',
              tool: 'install_deps',
              arguments: {},
            },
          ],
          { ...SHELLS_POLICY, mcpTools: { otheater: ['read_blackboard'] } },
        );
        expect(seen.result).toMatchObject({ state: 'completed' });
        // The daemon never got to the handler: no tool.called, nothing ran, and the agent was told.
        expect(seen.toolCalls('restricted_shell')).toBe(0);
        expect(seen.toolCalls('install_deps')).toBe(0);
        expect(seen.tools).toEqual([]);
        expect(seen.text).not.toMatch(/escape restricted_shell not granted: ok/);
        expect(existsSync(marker)).toBe(false);
      });
    });
  }, 90_000);
});

/**
 * What the rules of the shells do NOT cover, and layer 3 must. These two tests show the limit with
 * layer 3 off (`sandbox.mode: off`): an allowed program (`node`) can do what the model writes in
 * its argument, so a path hidden in code lands anywhere. It is not a bug of the rules (`node`
 * runs code; the argv rules read paths, not code): it is the reason `security.unenforced` refuses
 * a session with no layer 3 by default, and the reason the sandbox section below exists.
 */
describe('the limit of the rules: without layer 3 an allowed program writes anywhere', () => {
  it('lets node -e write outside the worktree when the sandbox is off and unenforced is warn', async () => {
    await withOutside(async (outside) => {
      await withFakeDaemon(NO_SANDBOX, async (rig) => {
        const target = join(outside.outsideDir, 'by-node.txt');
        const seen = await attempt(
          rig,
          'node-no-sandbox',
          [
            {
              kind: 'mcp',
              label: 'node writes a path hidden in code',
              tool: 'restricted_shell',
              arguments: {
                argv: ['node', '-e', `require("fs").writeFileSync(${JSON.stringify(target)},"x")`],
              },
            },
          ],
          SHELLS_POLICY,
        );
        // The rules let it pass (a plain relative-looking argument) and nothing else holds: this is
        // the control that says why layer 3 is not optional.
        expect(seen.tools.map((t) => t.outcome)).toEqual(['ok']);
        expect(existsSync(target)).toBe(true);
      });
    });
  }, 90_000);

  it('does not start the same session with the defaults (unenforced: refuse), so the escape above never runs', async () => {
    await withOutside(async (outside) => {
      await withFakeDaemon(
        { config: 'sandbox:\n  mode: off\n', unenforced: false },
        async (rig) => {
          const target = join(outside.outsideDir, 'by-node.txt');
          const seen = await attempt(
            rig,
            'node-refused',
            [
              {
                kind: 'mcp',
                tool: 'restricted_shell',
                arguments: {
                  argv: [
                    'node',
                    '-e',
                    `require("fs").writeFileSync(${JSON.stringify(target)},"x")`,
                  ],
                },
              },
            ],
            SHELLS_POLICY,
          );
          expect(seen.result).toMatchObject({ state: 'interrupted', cause: 'permission' });
          expect(seen.tools).toEqual([]);
          expect(existsSync(target)).toBe(false);
        },
      );
    });
  }, 90_000);
});

/**
 * Layer 3: the sandbox of the daemon. Everything here is something the client does BY ITSELF (a
 * write with no question, a program it starts, a socket it opens), which no rule of layer 2 or of
 * the shells ever sees, so the daemon's events must stay empty and the answer comes from the
 * operating system. The config has no `security.unenforced: warn`: the session starts only
 * because the sandbox counts as the layer of `writeScope` and `network`.
 */
describe('layer 3: what the operating system holds', () => {
  const DENIED = /failed (EROFS|EACCES|EPERM|ENOENT)/;

  it('stops a write, a program and a connection the client starts by itself', async (context) => {
    if (sandboxIssue !== undefined) {
      context.skip();
      return;
    }
    await withOutside(async (outside) => {
      await withFakeDaemon({}, async (rig) => {
        const out = (name: string): string => join(outside.outsideDir, name);
        const url = `http://127.0.0.1:${String(outside.port)}/`;
        const seen = await attempt(
          rig,
          'direct',
          [
            // The control: the worktree is writable, and a program of the system runs in it.
            { label: 'inside write', kind: 'write', path: 'inside.txt', via: 'direct' },
            { label: 'inside program', kind: 'spawn', argv: ['sh', '-c', 'touch inside-sh.txt'] },
            { label: 'inside by path', kind: 'spawn', argv: ['/bin/touch', 'inside-bin.txt'] },
            // Native writes with no question, by path traversal, absolute path and symlink.
            { label: 'dotdot', kind: 'write', path: '../escaped-dotdot.txt', via: 'direct' },
            { label: 'absolute', kind: 'write', path: out('abs.txt'), via: 'direct' },
            { kind: 'symlink', link: 'evil-dir', target: outside.outsideDir },
            { label: 'dir-link', kind: 'write', path: 'evil-dir/through.txt', via: 'direct' },
            { kind: 'symlink', link: 'evil-file', target: out('secret.txt') },
            { label: 'file-link', kind: 'write', path: 'evil-file', via: 'direct' },
            // Programs the client runs: in sh -c, by path, chained, with a substitution.
            { label: 'sh -c', kind: 'spawn', argv: ['sh', '-c', `touch ${out('s1')}`] },
            { label: 'by path', kind: 'spawn', argv: ['/bin/touch', out('s2')] },
            { label: 'glued chain', kind: 'spawn', argv: ['sh', '-c', `true;touch ${out('s3')}`] },
            {
              label: 'substitution',
              kind: 'spawn',
              argv: ['sh', '-c', `echo $(touch ${out('s4')})`],
            },
            { label: 'pipe', kind: 'spawn', argv: ['sh', '-c', `echo x | tee ${out('s5')}`] },
            // The network, raw, direct and through the proxy of the sandbox.
            { label: 'raw connect', kind: 'connect', target: `127.0.0.1:${String(outside.port)}` },
            { label: 'direct get', kind: 'direct_get', url },
            { label: 'proxy get', kind: 'proxy_get', url },
            { label: 'proxy get, other host', kind: 'proxy_get', url: 'http://example.invalid/' },
          ],
          BASE_POLICY,
        );
        // The turn ended: the attempts failed one by one, none of them ended the session.
        expect(seen.result).toMatchObject({ state: 'completed', stopReason: 'end_turn' });

        // The controls ran, so the denials below are about WHERE, not about the machine.
        expect(seen.text).toContain('escape inside write: ok');
        expect(seen.text).toContain('escape inside program: exit 0');
        expect(seen.text).toContain('escape inside by path: exit 0');
        expect(existsSync(join(seen.worktree, 'inside.txt'))).toBe(true);
        expect(existsSync(join(seen.worktree, 'inside-sh.txt'))).toBe(true);
        expect(existsSync(join(seen.worktree, 'inside-bin.txt'))).toBe(true);

        // Native writes, every one denied by the system.
        for (const label of ['absolute', 'dir-link', 'file-link']) {
          expect(seen.text, label).toMatch(new RegExp(`escape ${label}: ${DENIED.source}`));
        }
        // `../x` from the worktree names the folder that holds the mount point of the worktree. In
        // the namespace of bubblewrap that folder is a private tmpfs the sandbox creates for the
        // mount, so the write may succeed THERE [V, measured here]: it is a file of the sandbox that
        // dies with it. The ground truth is the host disk, checked below.
        expect(seen.text).toMatch(/escape dotdot: (ok|failed (EROFS|EACCES|EPERM|ENOENT))/);
        expect(existsSync(join(seen.parent, 'escaped-dotdot.txt'))).toBe(false);
        // Programs: the file is absent, whatever the program printed.
        for (const label of ['sh -c', 'by path', 'glued chain']) {
          expect(seen.text, label).toMatch(new RegExp(`escape ${label}: exit [1-9]`));
        }
        expect(await outsideFiles(outside)).toEqual(['secret.txt']);
        expect(await secretIntact(outside)).toBe(true);

        // The network: no route, a denied proxy, and the server of the host saw nothing at all.
        expect(seen.text).toMatch(/escape raw connect: failed (ECONNREFUSED|ENETUNREACH)/);
        expect(seen.text).toMatch(/escape direct get: failed (ECONNREFUSED|ENETUNREACH)/);
        expect(seen.text).not.toMatch(/escape proxy get: ok/);
        expect(seen.text).not.toMatch(/escape proxy get, other host: ok/);
        expect(outside.requests()).toBe(0);

        // Which layer held: none of the daemon's, they never heard of these attempts.
        expect(seen.permissions).toEqual([]);
        expect(seen.tools).toEqual([]);
      });
    });
  }, 120_000);

  it('confines what an allowed program does: node -e with a hidden path, a child, a socket', async (context) => {
    if (sandboxIssue !== undefined) {
      context.skip();
      return;
    }
    await withOutside(async (outside) => {
      await withFakeDaemon({}, async (rig) => {
        const out = (name: string): string => join(outside.outsideDir, name);
        const node = (code: string): Record<string, unknown> => ({
          kind: 'mcp',
          label: code.slice(0, 40),
          tool: 'restricted_shell',
          arguments: { argv: ['node', '-e', code] },
        });
        const seen = await attempt(
          rig,
          'node-sandbox',
          [
            node(`require("fs").writeFileSync("inside-node.txt","x")`),
            node(`require("fs").writeFileSync(${JSON.stringify(out('by-node.txt'))},"x")`),
            node(
              `require("child_process").execSync(${JSON.stringify(`touch ${out('by-node-child.txt')}`)})`,
            ),
            node(
              `fetch("http://127.0.0.1:${String(outside.port)}/").then(()=>process.exit(0),()=>process.exit(3))`,
            ),
          ],
          SHELLS_POLICY,
        );
        expect(seen.result).toMatchObject({ state: 'completed' });
        // The rules passed all four (an allowed program, arguments that look like text): the answer
        // is the exit code of each, and layer 3 is the only thing that can have made it differ.
        expect(seen.tools.map((t) => [t.outcome, t.exitCode === 0])).toEqual([
          ['ok', true],
          ['failed', false],
          ['failed', false],
          ['failed', false],
        ]);
        expect(seen.tools[3]?.exitCode).toBe(3);
        expect(existsSync(join(seen.worktree, 'inside-node.txt'))).toBe(true);
        expect(await outsideFiles(outside)).toEqual(['secret.txt']);
        expect(outside.requests()).toBe(0);
      });
    });
  }, 120_000);

  it('holds a program that the any mode lets through, glued operators included', async (context) => {
    if (sandboxIssue !== undefined) {
      context.skip();
      return;
    }
    await withOutside(async (outside) => {
      await withFakeDaemon(
        { config: 'tools:\n  shell_allowlist:\n    mode: any\n' },
        async (rig) => {
          const out = (name: string): string => join(outside.outsideDir, name);
          const sh = (label: string, script: string): Record<string, unknown> => ({
            kind: 'mcp',
            label,
            tool: 'restricted_shell',
            arguments: { argv: ['sh', '-c', script] },
          });
          const seen = await attempt(
            rig,
            'any-mode',
            [
              sh('inside', 'touch inside-any.txt'),
              sh('outside', `touch ${out('any1')}`),
              // `true;touch x` has no blank around the operator: the argv rules read it as one
              // word, `sh` runs it as two commands. The rules do not stop it; layer 3 does.
              sh('glued chain', `true;touch ${out('any2')}`),
              sh('spaced chain', `true ; touch ${out('any3')}`),
              sh('substitution', `echo $(touch ${out('any4')})`),
            ],
            SHELLS_POLICY,
          );
          expect(seen.tools.map((t) => [t.outcome, t.errorCode])).toEqual([
            ['ok', undefined],
            ['failed', undefined],
            ['failed', undefined],
            ['refused', 'shell_syntax'],
            ['refused', 'shell_syntax'],
          ]);
          expect(existsSync(join(seen.worktree, 'inside-any.txt'))).toBe(true);
          expect(await outsideFiles(outside)).toEqual(['secret.txt']);
        },
      );
    });
  }, 120_000);
});
