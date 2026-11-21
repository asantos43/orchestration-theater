// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInstance, type TFunction } from 'i18next';
import type { Env } from './paths.js';

export const LOCALES = ['en', 'pt-BR'] as const;
export type Locale = (typeof LOCALES)[number];
export type LocaleSetting = 'auto' | Locale;

/**
 * `ui.locale` to a real locale (architecture 5.22). `auto` follows the system: any `pt-*` becomes
 * `pt-BR`, everything else (and an unknown system locale) becomes `en`. Pure.
 */
export function resolveLocale(setting: LocaleSetting, systemLocale: string | undefined): Locale {
  if (setting !== 'auto') return setting;
  const language = systemLocale?.trim().replace(/_/g, '-').toLowerCase() ?? '';
  return language === 'pt' || language.startsWith('pt-') ? 'pt-BR' : 'en';
}

/**
 * The system locale as a BCP 47 tag, or `undefined`. [proposta] First what the JavaScript runtime
 * reports (`Intl`); when that says nothing, `LC_ALL`, `LC_MESSAGES` and `LANG`, in this order.
 * `C` and `POSIX` mean "no locale". Both sources are arguments so a test controls them.
 */
export function detectSystemLocale(
  env: Env,
  intlLocale: string | undefined = Intl.DateTimeFormat().resolvedOptions().locale,
): string | undefined {
  // The default applies to `undefined`, so here `intlLocale` is always a string (maybe empty).
  if (intlLocale !== '') return intlLocale;
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const value = env[name];
    if (value === undefined || value === '' || value === 'C' || value === 'POSIX') continue;
    // `pt_BR.UTF-8@euro` -> `pt-BR`
    return value.replace(/[.@].*$/, '').replace(/_/g, '-');
  }
  return undefined;
}

/**
 * [proposta] Folder of the catalogs. They live in `locales/` at the repository root, where
 * `verify catalogs` checks that every language has the same keys; this is that folder relative to
 * this file, in the source tree and in `dist/` alike. A packaged install must ship them (or pass
 * `localesDir`).
 */
export const DEFAULT_LOCALES_DIR = fileURLToPath(new URL('../../../locales/', import.meta.url));

/** Namespace of the messages `ot` shows to humans. */
export const CLI_NAMESPACE = 'cli';

export interface CreateTranslatorOptions {
  readonly localesDir?: string;
  /** The catalog file to load (`<namespace>.json`). Default: {@link CLI_NAMESPACE}. */
  readonly namespace?: string;
}

/**
 * A translation function for `locale`, with English as the fallback for a key the catalog lacks.
 * Used only for what `ot` prints to people: logs, events and error codes stay in English.
 */
export async function createTranslator(
  locale: Locale,
  options: CreateTranslatorOptions = {},
): Promise<TFunction> {
  const dir = options.localesDir ?? DEFAULT_LOCALES_DIR;
  const namespace = options.namespace ?? CLI_NAMESPACE;
  const resources = Object.fromEntries(
    LOCALES.map((lng) => [
      lng,
      {
        [namespace]: JSON.parse(readFileSync(`${dir}/${lng}/${namespace}.json`, 'utf8')) as object,
      },
    ]),
  );
  const instance = createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: 'en',
    supportedLngs: [...LOCALES],
    ns: [namespace],
    defaultNS: namespace,
    resources,
    // Output goes to a terminal, not into HTML.
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance.t;
}
