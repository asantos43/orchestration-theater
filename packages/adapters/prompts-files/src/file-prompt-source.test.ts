// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  assertValidPrompts,
  OFFICIAL_ROLES,
  OFFICIAL_TOOLS,
  PROMPT_SOURCE_PORT_VERSION,
} from '@otheater/core';
import { describePromptSourceConformance } from '@otheater/sdk';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_PROMPTS_DIR,
  FilePromptSource,
  FilePromptSourceConfigSchema,
  filePromptSourceAdapter,
} from './index.js';

async function tempDir(): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'otheater-prompts-'));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

describePromptSourceConformance('FilePromptSource', async () => {
  const { dir, remove } = await tempDir();
  const prompts = { actor: 'You write code.', critic: 'You judge the work.' };
  for (const [role, text] of Object.entries(prompts)) {
    await writeFile(join(dir, `${role}.md`), `${text}\n`);
  }
  return { source: new FilePromptSource({ directory: dir }), prompts, dispose: remove };
});

describe('FilePromptSource', () => {
  it('normalizes a BOM, CRLF line breaks and the blank space around the text', async () => {
    const { dir, remove } = await tempDir();
    try {
      await writeFile(join(dir, 'actor.md'), '﻿\n\n  First line\r\nSecond line\r\n\r\n\n');
      expect(await new FilePromptSource({ directory: dir }).get('actor')).toBe(
        'First line\nSecond line',
      );
    } finally {
      await remove();
    }
  });

  it('ignores files that are not <role id>.md', async () => {
    const { dir, remove } = await tempDir();
    try {
      await writeFile(join(dir, 'actor.md'), 'text');
      await writeFile(join(dir, 'README.txt'), 'x');
      await writeFile(join(dir, 'Director.md'), 'x');
      await writeFile(join(dir, '.hidden.md'), 'x');
      await mkdir(join(dir, 'nested.md'));
      expect(await new FilePromptSource({ directory: dir }).roles()).toEqual(['actor', 'nested']);
    } finally {
      await remove();
    }
  });

  it('rejects with ADAPTER_UNAVAILABLE when the folder is missing', async () => {
    const { dir, remove } = await tempDir();
    try {
      const source = new FilePromptSource({ directory: join(dir, 'missing') });
      await expect(source.roles()).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
      await expect(source.get('actor')).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    } finally {
      await remove();
    }
  });

  it('rejects with ADAPTER_UNAVAILABLE for an empty file', async () => {
    const { dir, remove } = await tempDir();
    try {
      await writeFile(join(dir, 'actor.md'), ' \n\n');
      await expect(new FilePromptSource({ directory: dir }).get('actor')).rejects.toMatchObject({
        code: 'ADAPTER_UNAVAILABLE',
      });
    } finally {
      await remove();
    }
  });

  it('reads the file again on every call, so an edit applies to the next session', async () => {
    const { dir, remove } = await tempDir();
    try {
      const source = new FilePromptSource({ directory: dir });
      await writeFile(join(dir, 'actor.md'), 'one');
      expect(await source.get('actor')).toBe('one');
      await writeFile(join(dir, 'actor.md'), 'two');
      expect(await source.get('actor')).toBe('two');
    } finally {
      await remove();
    }
  });
});

describe('the repository prompts', () => {
  const registries = {
    roles: { list: () => OFFICIAL_ROLES },
    tools: { list: () => OFFICIAL_TOOLS },
  };

  it('are the default folder and cover exactly the roles of the registry', async () => {
    const source = new FilePromptSource();
    expect(basename(BUNDLED_PROMPTS_DIR)).toBe('prompts');
    expect(existsSync(join(dirname(BUNDLED_PROMPTS_DIR), 'locales'))).toBe(true);
    expect(await source.roles()).toEqual(OFFICIAL_ROLES.map((role) => role.id).sort());
  });

  it('pass the start-up validation against the official registries', async () => {
    const prompts = await assertValidPrompts(new FilePromptSource(), registries);
    expect(prompts.size).toBe(OFFICIAL_ROLES.length);
  });

  it('are English text, with Unix line breaks and a first line that names the role', async () => {
    const source = new FilePromptSource();
    for (const role of await source.roles()) {
      const text = await source.get(role);
      expect(text).not.toContain('\r');
      expect(text.length).toBeGreaterThan(400);
      expect(text.split('\n')[0]).toMatch(/^You are /);
    }
  });
});

describe('the adapter declaration and config', () => {
  it('declares the PromptSource port and the range of the current version', () => {
    expect(filePromptSourceAdapter).toEqual({
      id: 'files',
      implements: { port: 'PromptSource', range: `^${PROMPT_SOURCE_PORT_VERSION}` },
    });
  });

  it('accepts an empty config or a directory, and refuses anything else', () => {
    expect(FilePromptSourceConfigSchema.parse({})).toEqual({});
    expect(FilePromptSourceConfigSchema.parse({ directory: 'my-prompts' })).toEqual({
      directory: 'my-prompts',
    });
    expect(FilePromptSourceConfigSchema.safeParse({ dir: 'x' }).success).toBe(false);
    expect(FilePromptSourceConfigSchema.safeParse({ directory: '' }).success).toBe(false);
  });
});
