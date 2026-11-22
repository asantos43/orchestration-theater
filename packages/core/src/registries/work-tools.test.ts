// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { OFFICIAL_TOOLS } from './index.js';

function schemas(name: string) {
  const found = OFFICIAL_TOOLS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

const command = {
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  truncated: false,
  durationMs: 3,
  timedOut: false,
  stdoutBytes: 2,
  stderrBytes: 0,
};

describe('the input and output schemas of the work tools', () => {
  it('give the three command tools the same output', () => {
    for (const name of ['restricted_shell', 'run_tests', 'install_deps']) {
      const { output } = schemas(name);
      expect(output.safeParse(command).success, name).toBe(true);
      expect(output.safeParse({ ...command, exitCode: null, timedOut: true }).success, name).toBe(
        true,
      );
      expect(output.safeParse({ ...command, stdout: undefined }).success, name).toBe(false);
      expect(output.safeParse({ ...command, extra: 1 }).success, name).toBe(false);
    }
  });

  it('take restricted_shell as an argv list only', () => {
    const { input } = schemas('restricted_shell');
    expect(input.safeParse({ argv: ['git', 'status'] }).success).toBe(true);
    expect(input.safeParse({ argv: [] }).success).toBe(false);
    expect(input.safeParse({ argv: 'git status' }).success).toBe(false);
    expect(input.safeParse({ command: 'git status' }).success).toBe(false);
  });

  it('give run_tests and install_deps no way to name the command', () => {
    expect(schemas('run_tests').input.safeParse({}).success).toBe(true);
    expect(schemas('run_tests').input.safeParse({ target: 'src/a.test.ts' }).success).toBe(true);
    expect(schemas('run_tests').input.safeParse({ command: 'rm -rf /' }).success).toBe(false);
    expect(schemas('install_deps').input.safeParse({}).success).toBe(true);
    expect(schemas('install_deps').input.safeParse({ command: 'x' }).success).toBe(false);
  });

  it('describe git_commit, view_diff and http_get', () => {
    expect(schemas('git_commit').input.safeParse({ message: '' }).success).toBe(false);
    expect(schemas('git_commit').output.safeParse({ sha: 'abc', reused: false }).success).toBe(
      true,
    );
    expect(schemas('view_diff').input.safeParse({}).success).toBe(true);
    expect(
      schemas('view_diff').output.safeParse({ diff: '', truncated: false, originalBytes: 0 })
        .success,
    ).toBe(true);
    expect(schemas('http_get').input.safeParse({ url: 'not a url' }).success).toBe(false);
    expect(schemas('http_get').effect).toBe('network');
    expect(schemas('http_get').idempotencyKey).toBe('attempt_step');
    const body = {
      url: 'http://127.0.0.1:1/',
      status: 200,
      contentType: null,
      body: 'x',
      truncated: false,
      originalBytes: 1,
    };
    expect(schemas('http_get').output.safeParse({ ...body, untrusted: true }).success).toBe(true);
    expect(schemas('http_get').output.safeParse({ ...body, untrusted: false }).success).toBe(false);
  });

  it('describe the browser tools: opening and reading reach the network, clicks and keys are external writes', () => {
    for (const name of ['browser_open', 'browser_read', 'browser_screenshot']) {
      expect(schemas(name).effect, name).toBe('network');
      expect(schemas(name).idempotencyKey, name).toBe('attempt_step');
      expect(schemas(name).roles, name).toEqual(['actor', 'consultant']);
    }
    for (const name of ['browser_click', 'browser_fill', 'browser_press_key']) {
      expect(schemas(name).effect, name).toBe('external_write');
      expect(schemas(name).idempotencyKey, name).toBe('attempt_step');
    }
    expect(schemas('browser_open').input.safeParse({ url: 'file:///tmp/a.html' }).success).toBe(
      true,
    );
    expect(schemas('browser_open').input.safeParse({ url: '' }).success).toBe(false);
    expect(schemas('browser_read').input.safeParse({}).success).toBe(true);
    expect(schemas('browser_read').input.safeParse({ ref: 'f1e6' }).success).toBe(true);
    expect(schemas('browser_click').input.safeParse({}).success).toBe(false);
    expect(schemas('browser_fill').input.safeParse({ ref: 'f1e6', value: '' }).success).toBe(true);
    expect(schemas('browser_fill').input.safeParse({ ref: 'f1e6' }).success).toBe(false);
    expect(schemas('browser_press_key').input.safeParse({ key: 'Enter' }).success).toBe(true);
    const page = { url: 'http://127.0.0.1:1/', title: 't' };
    expect(
      schemas('browser_read').output.safeParse({
        ...page,
        text: 'x',
        tree: '- heading',
        truncated: false,
        untrusted: true,
      }).success,
    ).toBe(true);
    expect(
      schemas('browser_read').output.safeParse({
        ...page,
        text: 'x',
        tree: '',
        truncated: false,
        untrusted: false,
      }).success,
    ).toBe(false);
    expect(
      schemas('browser_click').output.safeParse({ ...page, reused: false, untrusted: true })
        .success,
    ).toBe(true);
  });
});
