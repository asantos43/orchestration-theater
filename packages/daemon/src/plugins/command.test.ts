// SPDX-License-Identifier: MPL-2.0
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../cli.js';
import { makeTempDataDir } from '../test-helpers.js';
import { isolatedEnv, makeGitRepo, manifestText, writePluginFolder } from './plugin-fixture.js';

interface Captured {
  readonly out: string[];
  readonly err: string[];
  readonly code: number;
}

async function ot(
  argv: readonly string[],
  data: string,
  work: string,
  extra: Partial<CliDeps> = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, '--data-dir', data], {
    env: isolatedEnv(work),
    platform: 'linux',
    homedir: work,
    cwd: work,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    systemLocale: 'en',
    version: '1.2.3',
    overrides: { clock: new FakeClock(Date.UTC(2026, 10, 21, 15)) },
    ...extra,
  });
  return { out, err, code };
}

async function scene<T>(body: (paths: { data: string; work: string }) => Promise<T>): Promise<T> {
  const data = await makeTempDataDir();
  const work = await makeTempDataDir();
  try {
    return await body({ data: data.dir, work: work.dir });
  } finally {
    await data.dispose();
    await work.dispose();
  }
}

describe('ot plugin', () => {
  it('installs from a folder, lists it off, enables with --yes, lists it on, disables and removes', async () => {
    await scene(async ({ data, work }) => {
      const folder = await writePluginFolder(join(work, 'demo-db'));

      const install = await ot(['plugin', 'install', folder], data, work);
      expect(install.code).toBe(0);
      expect(install.out.join('\n')).toContain('demo-db');
      expect(install.out.join('\n')).toMatch(/off|enable/i);

      const listed = await ot(['plugin', 'list', '--json'], data, work);
      const views = JSON.parse(listed.out.join('\n')) as { id: string; projects: unknown[] }[];
      expect(views.map((view) => view.id)).toEqual(['demo-db']);
      expect(views[0]?.projects).toEqual([]);

      const enabled = await ot(
        ['plugin', 'enable', 'demo-db', '--project', 'p1', '--yes'],
        data,
        work,
      );
      expect(enabled.code).toBe(0);
      const text = enabled.out.join('\n');
      expect(text).toContain('query_sql');
      expect(text).toContain('migration_applied');

      const onlyP1 = await ot(['plugin', 'list', '--project', 'p1', '--json'], data, work);
      expect(
        (JSON.parse(onlyP1.out.join('\n')) as { projects: { state: string }[] }[])[0]?.projects[0]
          ?.state,
      ).toBe('active');
      const onlyP2 = await ot(['plugin', 'list', '--project', 'p2', '--json'], data, work);
      expect(JSON.parse(onlyP2.out.join('\n'))).toEqual([]);

      expect(
        (
          await ot(['plugin', 'enable', 'demo-db', '--project', 'p1', '--yes'], data, work)
        ).out.join('\n'),
      ).toMatch(/already/i);
      expect((await ot(['plugin', 'disable', 'demo-db', '--project', 'p1'], data, work)).code).toBe(
        0,
      );
      expect(
        (await ot(['plugin', 'disable', 'demo-db', '--project', 'p1'], data, work)).out.join('\n'),
      ).toMatch(/already|not on/i);
      expect((await ot(['plugin', 'remove', 'demo-db'], data, work)).code).toBe(0);
      expect((await ot(['plugin', 'list'], data, work)).out.join('\n')).toMatch(/no plugin/i);
      // The local folder is the user's: it is still there.
      await access(join(folder, 'plugin.yaml'));
    });
  });

  it('installs from a local git repository (file://), pinned to the commit', async () => {
    await scene(async ({ data, work }) => {
      const marker = join(work, 'MARKER');
      const repo = await makeGitRepo(work, 'repo', { marker });
      // The hooks of the fixture ran when it was made; what counts is the install.
      await rm(marker, { force: true });
      const result = await ot(['plugin', 'install', `git:${repo.url}#main`, '--json'], data, work);
      expect(result.code).toBe(0);
      expect(result.out.join('\n')).toContain(repo.commit);
      await expect(access(marker)).rejects.toThrow();
    });
  });

  it('refuses an invalid manifest with the P3 message and exit code 1, registering nothing', async () => {
    await scene(async ({ data, work }) => {
      const folder = await writePluginFolder(join(work, 'bad'));
      await writeFile(
        join(folder, 'plugin.yaml'),
        manifestText().replace('effects: read', 'effects: delete_everything'),
      );
      const result = await ot(['plugin', 'install', folder], data, work);
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain('Invalid plugin.yaml');
      expect(result.err.join('\n')).toContain('tools[0].effects');
      expect((await ot(['plugin', 'list', '--json'], data, work)).out.join('')).toBe('[]');
    });
  });

  it('shows what enable asks for and approves only after a yes; a no turns nothing on', async () => {
    await scene(async ({ data, work }) => {
      await ot(['plugin', 'install', await writePluginFolder(join(work, 'demo-db'))], data, work);
      const questions: string[] = [];

      const declined = await ot(['plugin', 'enable', 'demo-db', '--project', 'p1'], data, work, {
        confirm: (question) => {
          questions.push(question);
          return Promise.resolve(false);
        },
      });
      expect(declined.code).toBe(1);
      expect(questions).toHaveLength(1);
      expect(declined.out.join('\n')).toContain('query_sql');
      expect(
        (await ot(['plugin', 'list', '--project', 'p1', '--json'], data, work)).out.join(''),
      ).toBe('[]');

      const accepted = await ot(['plugin', 'enable', 'demo-db', '--project', 'p1'], data, work, {
        confirm: () => Promise.resolve(true),
      });
      expect(accepted.code).toBe(0);
    });
  });

  it('without a terminal and without --yes, enable is a usage error and nothing is turned on', async () => {
    await scene(async ({ data, work }) => {
      await ot(['plugin', 'install', await writePluginFolder(join(work, 'demo-db'))], data, work);
      const result = await ot(['plugin', 'enable', 'demo-db', '--project', 'p1'], data, work);
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toContain('--yes');
      expect(
        (await ot(['plugin', 'list', '--project', 'p1', '--json'], data, work)).out.join(''),
      ).toBe('[]');
    });
  });

  it('an edited local folder turns the plugin off; enable shows the new manifest and approves it', async () => {
    await scene(async ({ data, work }) => {
      const folder = await writePluginFolder(join(work, 'demo-db'));
      await ot(['plugin', 'install', folder], data, work);
      await ot(['plugin', 'enable', 'demo-db', '--project', 'p1', '--yes'], data, work);

      await writeFile(join(folder, 'plugin.yaml'), manifestText({ variant: 'changed' }));
      const listed = await ot(['plugin', 'list', '--project', 'p1', '--json'], data, work);
      expect(
        (JSON.parse(listed.out.join('\n')) as { projects: { state: string }[] }[])[0]?.projects[0]
          ?.state,
      ).toBe('needs_approval');

      const again = await ot(
        ['plugin', 'enable', 'demo-db', '--project', 'p1', '--yes'],
        data,
        work,
      );
      expect(again.code).toBe(0);
      const text = again.out.join('\n');
      expect(text).toContain('drop_table');
      expect(text).toContain('PG_URL');
      expect(text).toMatch(/not the one approved/i);
    });
  });

  it('prints in pt-BR when the system says so', async () => {
    await scene(async ({ data, work }) => {
      await ot(['plugin', 'install', await writePluginFolder(join(work, 'demo-db'))], data, work);
      const result = await ot(
        ['plugin', 'enable', 'demo-db', '--project', 'p1', '--yes'],
        data,
        work,
        {
          systemLocale: 'pt_BR.UTF-8',
        },
      );
      expect(result.out.join('\n')).toMatch(/pede/);
    });
  });

  it('answers usage errors with exit code 2 and does not create the data directory content', async () => {
    await scene(async ({ data, work }) => {
      const cases: (readonly string[])[] = [
        ['plugin'],
        ['plugin', 'frobnicate'],
        ['plugin', 'install'],
        ['plugin', 'install', 'a', 'b'],
        ['plugin', 'remove'],
        ['plugin', 'enable', 'demo-db'],
        ['plugin', 'disable', 'demo-db'],
        ['plugin', 'list', 'extra'],
      ];
      for (const argv of cases) {
        const result = await ot(argv, data, work);
        expect(result.code, argv.join(' ')).toBe(2);
        expect(result.err.length).toBeGreaterThan(0);
      }
      await expect(readFile(join(data, 'plugins.json'), 'utf8')).rejects.toThrow();
    });
  });

  it('keeps the sources of config.yaml: a source that is off is refused', async () => {
    await scene(async ({ data, work }) => {
      await writeFile(join(data, 'config.yaml'), 'plugins:\n  install:\n    sources: [npm]\n');
      const folder = await writePluginFolder(join(work, 'demo-db'));
      const result = await ot(['plugin', 'install', folder], data, work);
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain('"path" is off');
    });
  });
});
