// SPDX-License-Identifier: MPL-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  DEFAULT_LOCALES_DIR,
  detectSystemLocale,
  LOCALES,
  resolveLocale,
} from './i18n.js';

describe('resolveLocale', () => {
  it('returns an explicit setting as it is', () => {
    expect(resolveLocale('en', 'pt-BR')).toBe('en');
    expect(resolveLocale('pt-BR', 'en-US')).toBe('pt-BR');
  });

  it('follows the system on auto: any pt becomes pt-BR, everything else en', () => {
    expect(resolveLocale('auto', 'pt-BR')).toBe('pt-BR');
    expect(resolveLocale('auto', 'pt_PT')).toBe('pt-BR');
    expect(resolveLocale('auto', 'pt')).toBe('pt-BR');
    expect(resolveLocale('auto', 'en-US')).toBe('en');
    expect(resolveLocale('auto', 'fr-FR')).toBe('en');
    expect(resolveLocale('auto', undefined)).toBe('en');
    expect(resolveLocale('auto', '')).toBe('en');
  });
});

describe('detectSystemLocale', () => {
  it('prefers what Intl says', () => {
    expect(detectSystemLocale({ LANG: 'fr_FR.UTF-8' }, 'pt-BR')).toBe('pt-BR');
  });

  // An empty Intl answer (not undefined, which selects the default) means "nothing to go on".
  it('falls back to LC_ALL, LC_MESSAGES and LANG in this order and cleans the tag', () => {
    expect(detectSystemLocale({ LANG: 'pt_BR.UTF-8' }, '')).toBe('pt-BR');
    expect(detectSystemLocale({ LC_ALL: 'de_DE@euro', LANG: 'pt_BR' }, '')).toBe('de-DE');
    expect(detectSystemLocale({ LC_MESSAGES: 'en_GB.UTF-8', LANG: 'pt_BR' }, '')).toBe('en-GB');
  });

  it('treats C, POSIX and empty values as no locale', () => {
    expect(detectSystemLocale({ LC_ALL: 'C', LANG: 'POSIX' }, '')).toBeUndefined();
    expect(detectSystemLocale({}, '')).toBeUndefined();
  });
});

describe('createTranslator and the catalogs', () => {
  it('translates, interpolating without HTML escaping', async () => {
    const en = await createTranslator('en');
    const pt = await createTranslator('pt-BR');
    expect(en('daemon.stopped')).toBe('Daemon stopped.');
    expect(pt('daemon.stopped')).toBe('Daemon parado.');
    expect(en('restore.done', { path: '/a/b&c' })).toBe('Restored the database at /a/b&c.');
  });

  it('keeps the translator bound after being extracted', async () => {
    const { t } = { t: await createTranslator('pt-BR') };
    expect(t('errors.prefix', { message: 'x' })).toBe('Erro: x');
  });

  it('shows the key of a message nobody wrote, rather than failing', async () => {
    expect((await createTranslator('en'))('no.such.key')).toBe('no.such.key');
  });

  it('has the same keys in every language', () => {
    const keysOf = (value: unknown, prefix = ''): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([key, child]) => keysOf(child, `${prefix}${key}.`))
        : [prefix];
    const [first, ...others] = LOCALES.map((locale) =>
      keysOf(JSON.parse(readFileSync(`${DEFAULT_LOCALES_DIR}/${locale}/cli.json`, 'utf8'))).sort(),
    );
    for (const other of others) expect(other).toEqual(first);
    expect(readdirSync(`${DEFAULT_LOCALES_DIR}/en`)).toContain('cli.json');
  });
});
