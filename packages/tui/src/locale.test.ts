// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocaleController,
  createTuiI18n,
  defaultLocalesDir,
  detectSystemLocale,
  loadTuiCatalogs,
  localeFromTag,
  resolveLocale,
} from './locale.js';

describe('locale resolution', () => {
  it('auto: pt-* is pt-BR, anything else is en', () => {
    for (const tag of ['pt', 'pt-BR', 'pt_BR.UTF-8', 'pt_PT', 'PT-br']) {
      expect(localeFromTag(tag)).toBe('pt-BR');
    }
    for (const tag of ['en', 'en_US.UTF-8', 'fr_FR', 'ptx', '', undefined]) {
      expect(localeFromTag(tag)).toBe('en');
    }
  });

  it('when the runtime reports no locale, reads the environment in POSIX order and ignores C and POSIX', () => {
    expect(detectSystemLocale({ LC_ALL: 'pt_BR.UTF-8', LANG: 'en_US' }, '')).toBe('pt-BR');
    expect(detectSystemLocale({ LC_ALL: 'C', LANG: 'pt_BR' }, '')).toBe('pt-BR');
    expect(detectSystemLocale({ LANGUAGE: 'pt_BR:en', LANG: 'en_US' }, '')).toBe('pt-BR');
    expect(detectSystemLocale({ LANG: 'POSIX' }, '')).toBe('en');
    expect(detectSystemLocale({}, '')).toBe('en');
  });

  it('the locale of the runtime comes first, as in the CLI (Windows has no LANG; N323)', () => {
    expect(detectSystemLocale({}, 'pt-BR')).toBe('pt-BR');
    expect(detectSystemLocale({ LANG: 'en_US' }, 'pt-BR')).toBe('pt-BR');
    expect(detectSystemLocale({ LANG: 'pt_BR' }, 'en-US')).toBe('en');
    expect(resolveLocale('auto', {}, 'pt-PT')).toBe('pt-BR');
  });

  it('an explicit setting wins over the environment', () => {
    expect(resolveLocale('en', { LANG: 'pt_BR' }, 'pt-BR')).toBe('en');
    expect(resolveLocale('pt-BR', { LANG: 'en_US' }, 'en-US')).toBe('pt-BR');
    expect(resolveLocale('auto', { LANG: 'pt_BR' }, '')).toBe('pt-BR');
  });
});

describe('catalogs and the live switch', () => {
  it('both catalogs have the same keys', () => {
    const catalogs = loadTuiCatalogs();
    const keys = (value: unknown, prefix = ''): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`))
        : [prefix];
    const en = keys(catalogs.en?.tui).sort();
    const pt = keys(catalogs['pt-BR']?.tui).sort();
    expect(en.length).toBeGreaterThan(10);
    expect(pt).toEqual(en);
  });

  it('LocaleController switches the translator without a restart, only when the language changes', async () => {
    const i18n = await createTuiI18n('en');
    const changes: string[] = [];
    i18n.on('languageChanged', (language) => changes.push(language));
    const controller = new LocaleController(i18n, 'auto', { LANG: 'en_US' }, '');
    expect(i18n.t('app.quit_hint')).toMatch(/quit/i);

    await controller.apply('pt-BR');
    expect(controller.setting).toBe('pt-BR');
    expect(controller.locale).toBe('pt-BR');
    expect(i18n.t('app.quit_hint')).toMatch(/ sai/i);

    await controller.apply('pt-BR');
    await controller.apply('en');
    expect(i18n.t('app.quit_hint')).toMatch(/quit/i);
    expect(changes).toEqual(['pt-BR', 'en']);

    await controller.apply('auto');
    expect(controller.locale).toBe('en');
  });

  it('a missing key falls back to English', async () => {
    const i18n = await createTuiI18n('pt-BR', {
      en: { tui: { only_en: 'English only' } },
      'pt-BR': { tui: {} },
    });
    expect(i18n.t('only_en')).toBe('English only');
  });

  describe('the catalogs folder', () => {
    const dirs: string[] = [];
    afterEach(async () => {
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    it('is found going up from the module', async () => {
      const root = await mkdtemp(join(tmpdir(), 'otheater-tui-locales-'));
      dirs.push(root);
      await mkdir(join(root, 'locales', 'en'), { recursive: true });
      await mkdir(join(root, 'a', 'b'), { recursive: true });
      await writeFile(join(root, 'a', 'b', 'x.js'), '');
      expect(defaultLocalesDir(pathToFileURL(join(root, 'a', 'b', 'x.js')).href)).toBe(
        join(root, 'locales'),
      );
    });
  });
});
