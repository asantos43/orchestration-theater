// SPDX-License-Identifier: MPL-2.0
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSeaProcess, readSeaAsset } from '@otheater/client/node';
import i18next, { type i18n as I18nInstance, type Resource } from 'i18next';
import type { LocaleSetting } from './settings.js';

/** The languages of the catalogs (`locales/<lang>/*.json`). */
export const LOCALES = ['en', 'pt-BR'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** The namespace of the TUI catalog (`locales/<lang>/tui.json`). */
export const TUI_NAMESPACE = 'tui';

/** `pt`, `pt-BR`, `pt_PT.UTF-8`... become `pt-BR`; anything else is `en` (architecture 5.22). */
export function localeFromTag(tag: string | undefined): Locale {
  if (tag === undefined) return DEFAULT_LOCALE;
  return /^pt([-_.@]|$)/i.test(tag.trim()) ? 'pt-BR' : DEFAULT_LOCALE;
}

export interface SystemLocaleEnv {
  readonly LC_ALL?: string | undefined;
  readonly LC_MESSAGES?: string | undefined;
  readonly LANG?: string | undefined;
  readonly LANGUAGE?: string | undefined;
}

/** The language the environment asks for (POSIX order of precedence). */
export function detectSystemLocale(env: SystemLocaleEnv = process.env): Locale {
  for (const value of [env.LC_ALL, env.LC_MESSAGES, env.LANGUAGE, env.LANG]) {
    if (value !== undefined && value !== '' && value !== 'C' && value !== 'POSIX') {
      return localeFromTag(value.split(':')[0]);
    }
  }
  return DEFAULT_LOCALE;
}

export function resolveLocale(setting: LocaleSetting, env: SystemLocaleEnv = process.env): Locale {
  return setting === 'auto' ? detectSystemLocale(env) : setting;
}

/**
 * Where the catalogs are: the `locales` folder of the repository, found by going up from this file
 * (the same layout the daemon uses: `packages/tui/{src,dist}/` is two levels under `packages/`).
 */
export function defaultLocalesDir(from: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'locales');
    if (existsSync(join(candidate, DEFAULT_LOCALE))) return candidate;
    dir = resolve(dir, '..');
  }
  return resolve(dirname(fileURLToPath(from)), '../../../locales');
}

/**
 * TODO(P7): replace with `loadUiCatalogs` of `@otheater/client/node`, which P7 adds and which reads
 * the same files. This one reads `locales/<lang>/tui.json` straight from the disk.
 */
export function loadTuiCatalogs(localesDir?: string): Resource {
  // In the single executable (Phase 10, P1) the catalogs are assets, not files; an explicit folder
  // (a test, a custom install) still wins.
  const fromAssets = localesDir === undefined && isSeaProcess();
  const folder = localesDir ?? (fromAssets ? '' : defaultLocalesDir());
  const resources: Resource = {};
  for (const locale of LOCALES) {
    const text = fromAssets
      ? readSeaAsset(`locales/${locale}/${TUI_NAMESPACE}.json`)
      : readFileSync(join(folder, locale, `${TUI_NAMESPACE}.json`), 'utf8');
    if (text === undefined) throw new Error(`The executable has no catalog for ${locale}`);
    resources[locale] = { [TUI_NAMESPACE]: JSON.parse(text) as Record<string, unknown> };
  }
  return resources;
}

/**
 * The translator of the TUI. One instance per app: `changeLanguage` switches the text of every
 * component that uses `useTranslation`, with no restart.
 */
export async function createTuiI18n(
  locale: Locale,
  resources: Resource = loadTuiCatalogs(),
): Promise<I18nInstance> {
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...LOCALES],
    ns: [TUI_NAMESPACE],
    defaultNS: TUI_NAMESPACE,
    resources,
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
    react: { useSuspense: false },
  });
  return instance;
}

/**
 * Holds the setting `ui.locale` and applies it to the translator. `apply` is called again whenever
 * the setting is read again (after a reconnection, or by hand), so a change shows at once.
 */
export class LocaleController {
  readonly #i18n: I18nInstance;
  readonly #env: SystemLocaleEnv;
  #setting: LocaleSetting;

  constructor(i18n: I18nInstance, setting: LocaleSetting, env: SystemLocaleEnv = process.env) {
    this.#i18n = i18n;
    this.#setting = setting;
    this.#env = env;
  }

  get setting(): LocaleSetting {
    return this.#setting;
  }

  get locale(): Locale {
    return resolveLocale(this.#setting, this.#env);
  }

  /** Sets the setting and switches the language when it changed. */
  async apply(setting: LocaleSetting): Promise<void> {
    this.#setting = setting;
    const next = this.locale;
    if (this.#i18n.language !== next) await this.#i18n.changeLanguage(next);
  }
}
