// SPDX-License-Identifier: MPL-2.0
import type { TFunction } from 'i18next';
import { LOCALES, createTranslator, type Locale } from '../i18n.js';

/** The namespace of the catalog of the commands: `locales/<lng>/commands.json`. */
export const COMMANDS_NAMESPACE = 'commands';

/** Translates a key of the catalog of the commands. */
export type SlashTranslator = (key: string, vars?: Readonly<Record<string, unknown>>) => string;

/** The catalog of the commands in every language, loaded once. */
export class SlashCatalog {
  readonly #translators: ReadonlyMap<Locale, TFunction>;

  private constructor(translators: ReadonlyMap<Locale, TFunction>) {
    this.#translators = translators;
  }

  /** Reads `commands.json` of every language. Rejects when a file is missing or is not JSON. */
  static async load(localesDir?: string): Promise<SlashCatalog> {
    const entries = await Promise.all(
      LOCALES.map(
        async (locale) =>
          [
            locale,
            await createTranslator(locale, {
              namespace: COMMANDS_NAMESPACE,
              ...(localesDir === undefined ? {} : { localesDir }),
            }),
          ] as const,
      ),
    );
    return new SlashCatalog(new Map(entries));
  }

  /** The translator of one language. */
  translator(locale: Locale): SlashTranslator {
    const t = this.#translators.get(locale);
    if (t === undefined) throw new Error(`The catalog of the commands has no ${locale}`);
    // `t` returns a string for a key of the catalog and the key itself for one it lacks.
    return (key, vars) => t(key, vars as Record<string, unknown>);
  }
}
