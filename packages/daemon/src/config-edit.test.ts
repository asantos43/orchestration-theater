// SPDX-License-Identifier: MPL-2.0
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { editConfigFile } from './config-edit.js';
import { makeTempDataDir } from './test-helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fileWith(text?: string): Promise<{ dir: string; path: string }> {
  const tmp = await makeTempDataDir();
  cleanups.push(tmp.dispose);
  const path = join(tmp.dir, 'config.yaml');
  if (text !== undefined) await writeFile(path, text);
  return { dir: tmp.dir, path };
}

describe('editConfigFile', () => {
  it('creates the file when there is none, and validates what it wrote', async () => {
    const { path } = await fileWith();
    const config = await editConfigFile(path, (editor) => {
      editor.set(['executors', 'on_register'], 'none');
    });
    expect(config.executors.on_register).toBe('none');
    expect(await readFile(path, 'utf8')).toContain('on_register: none');
  });

  it('keeps the comments and the order of what it does not touch', async () => {
    const text = [
      '# my notes',
      'backup:',
      '  when: manual # keep it',
      '',
      'roles:',
      '  author:',
      '    executors: [a-low@claude-code/main] # the usual',
      '',
    ].join('\n');
    const { path } = await fileWith(text);
    await editConfigFile(path, (editor) => {
      editor.set(['executors', 'on_register'], 'ask');
    });
    const after = await readFile(path, 'utf8');
    expect(after).toContain('# my notes');
    expect(after).toContain('when: manual # keep it');
    expect(after).toContain('# the usual');
    expect(after.indexOf('backup:')).toBeLessThan(after.indexOf('roles:'));
  });

  it('inserts into a list at a position, creates the list, ignores a duplicate, withdraws and drops the empty list', async () => {
    const { path } = await fileWith(
      'roles:\n  author:\n    executors: [one-low@claude-code/main, two-low@claude-code/main]\n',
    );
    const at = ['roles', 'author', 'executors'] as const;
    await editConfigFile(path, (editor) => {
      expect(editor.insert(at, 1, 'mid-low@claude-code/main')).toBe(true);
      expect(editor.insert(at, 0, 'one-low@claude-code/main')).toBe(false);
      expect(editor.insert(at, 99, 'last-low@claude-code/main')).toBe(true);
      expect(editor.insert(['roles', 'critic', 'executors'], 0, 'solo-low@claude-code/main')).toBe(
        true,
      );
    });
    let after = await readFile(path, 'utf8');
    const parsed = parse(after) as { roles: Record<string, { executors: string[] }> };
    expect(parsed.roles.author?.executors).toEqual(
      ['one', 'mid', 'two', 'last'].map((name) => `${name}-low@claude-code/main`),
    );

    await editConfigFile(path, (editor) => {
      expect(editor.withdraw(['roles', 'critic', 'executors'], 'solo-low@claude-code/main')).toBe(
        true,
      );
      expect(editor.withdraw(['roles', 'critic', 'executors'], 'solo-low@claude-code/main')).toBe(
        false,
      );
      expect(editor.has(['roles', 'critic', 'executors'])).toBe(false);
      expect(editor.get(['roles', 'author', 'executors'])).toBeDefined();
    });
    after = await readFile(path, 'utf8');
    expect(after).not.toContain('solo-low@claude-code/main');
  });

  it('refuses an edit that would leave an invalid config, and leaves the file as it was', async () => {
    const text = '# untouched\nexecutors:\n  on_register: ask\n';
    const { dir, path } = await fileWith(text);
    await expect(
      editConfigFile(path, (editor) => {
        editor.set(['executors', 'on_register'], 'sometimes');
      }),
    ).rejects.toBeInstanceOf(InvalidInput);
    expect(await readFile(path, 'utf8')).toBe(text);
    // And no temporary file was left behind.
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('never touches a file that is not valid YAML', async () => {
    const text = 'executors: [unclosed\n';
    const { path } = await fileWith(text);
    await expect(editConfigFile(path, () => undefined)).rejects.toBeInstanceOf(InvalidInput);
    expect(await readFile(path, 'utf8')).toBe(text);
  });
});
