// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  COMMON_COMMANDS,
  COMMON_OPTIONS,
  commonArgsFor,
  commonNames,
  translateCommonArgs,
  type CommonArgsMap,
  type CommonArgsOverrides,
} from './profile-cli.js';

const CODEX: CommonArgsMap = {
  commands: {
    login: ['login'],
    logout: ['logout'],
    status: ['login', 'status'],
    run: ['exec'],
  },
  options: { model: ['--model'] },
};
const NONE: CommonArgsOverrides = { commands: {}, options: {} };
const NAMES = commonNames(NONE);

describe('translateCommonArgs (P28a, N159)', () => {
  it('has the built-in names', () => {
    expect(COMMON_COMMANDS).toEqual(['login', 'logout', 'status', 'run']);
    expect(COMMON_OPTIONS).toEqual(['model']);
    expect(NAMES).toEqual({ commands: ['login', 'logout', 'run', 'status'], options: ['model'] });
  });

  it('turns a common command into the tokens of the client', () => {
    expect(translateCommonArgs(['status'], CODEX, NAMES)).toEqual({
      ok: true,
      args: ['login', 'status'],
      command: 'status',
    });
    expect(translateCommonArgs(['run', 'say hi'], CODEX, NAMES)).toEqual({
      ok: true,
      args: ['exec', 'say hi'],
      command: 'run',
    });
  });

  it('the common word wins over the same word of the client, and -- reaches the original', () => {
    expect(
      translateCommonArgs(['login'], { ...CODEX, commands: { login: ['auth', 'x'] } }, NAMES),
    ).toMatchObject({ ok: true, args: ['auth', 'x'] });
    expect(translateCommonArgs(['--', 'login', '--device-auth'], CODEX, NAMES)).toEqual({
      ok: true,
      args: ['login', '--device-auth'],
      command: null,
    });
  });

  it('puts leading common options after the common command', () => {
    expect(translateCommonArgs(['--model', 'gpt-x', 'run', 'hi'], CODEX, NAMES)).toEqual({
      ok: true,
      args: ['exec', '--model', 'gpt-x', 'hi'],
      command: 'run',
    });
    expect(translateCommonArgs(['--model=gpt-x', 'run', 'hi'], CODEX, NAMES)).toMatchObject({
      args: ['exec', '--model', 'gpt-x', 'hi'],
    });
  });

  it('translates a common option later on, up to a --, which goes on with the rest', () => {
    const map: CommonArgsMap = { commands: { run: ['-p'] }, options: { model: ['-m'] } };
    expect(translateCommonArgs(['run', '--model', 'a', '--', '--model', 'b'], map, NAMES)).toEqual({
      ok: true,
      args: ['-p', '-m', 'a', '--', '--model', 'b'],
      command: 'run',
    });
  });

  it('passes a word that is not common as it is', () => {
    expect(translateCommonArgs(['exec', '--json', 'x'], CODEX, NAMES)).toEqual({
      ok: true,
      args: ['exec', '--json', 'x'],
      command: null,
    });
    expect(translateCommonArgs([], CODEX, NAMES)).toEqual({ ok: true, args: [], command: null });
    // A common word that is not first is the client's.
    expect(translateCommonArgs(['exec', 'login'], CODEX, NAMES)).toMatchObject({
      args: ['exec', 'login'],
      command: null,
    });
    // An option of the client that only starts like a common one.
    expect(translateCommonArgs(['--models'], CODEX, NAMES)).toMatchObject({ args: ['--models'] });
  });

  it('refuses a common word this client has no translation for, with what it has', () => {
    const bare: CommonArgsMap = { commands: { login: ['login'] }, options: {} };
    expect(translateCommonArgs(['run', 'x'], bare, NAMES)).toEqual({
      ok: false,
      reason: 'not_for_client',
      kind: 'command',
      name: 'run',
      available: { commands: ['login'], options: [] },
    });
    expect(translateCommonArgs(['--model', 'x'], bare, NAMES)).toMatchObject({
      ok: false,
      kind: 'option',
      name: 'model',
    });
  });

  it('refuses a common option with no value', () => {
    expect(translateCommonArgs(['run', '--model'], CODEX, NAMES)).toEqual({
      ok: false,
      reason: 'missing_value',
      name: 'model',
    });
  });
});

describe('commonArgsFor and commonNames (configuration)', () => {
  const overrides: CommonArgsOverrides = {
    commands: { review: { codex: ['review'] }, status: { codex: ['doctor'] } },
    options: { effort: { codex: ['-c', 'model_reasoning_effort'] } },
  };

  it('adds and rewrites the words of the client named, and leaves the others alone', () => {
    const map = commonArgsFor(CODEX, 'codex', overrides);
    expect(map.commands).toMatchObject({ review: ['review'], status: ['doctor'], run: ['exec'] });
    expect(map.options).toEqual({ model: ['--model'], effort: ['-c', 'model_reasoning_effort'] });
    expect(commonArgsFor(CODEX, 'claude-code', overrides)).toEqual(CODEX);
  });

  it('makes a configured name common for every client', () => {
    const names = commonNames(overrides);
    expect(names.commands).toContain('review');
    expect(names.options).toEqual(['effort', 'model']);
    // Common now, and the client named has it; another one gets the error.
    expect(
      translateCommonArgs(['review'], commonArgsFor(CODEX, 'codex', overrides), names),
    ).toMatchObject({ ok: true, args: ['review'], command: 'review' });
    expect(translateCommonArgs(['review'], CODEX, names)).toMatchObject({
      ok: false,
      name: 'review',
    });
  });
});
