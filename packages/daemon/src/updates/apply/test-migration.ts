// SPDX-License-Identifier: MPL-2.0

/**
 * The hook of the tests of the backup before a migration (Phase 10, P8; N57). With `OT_TEST_MIGRATION`
 * set (to `store`, `telemetry` or both, comma separated), a daemon that is not the release build
 * acts as if the new version needed a newer schema of those bases, so the backup is made, and the
 * fake executable of a test writes into the base to prove that the rollback restores it.
 *
 * It exists only outside the release build: the release build defines `__OT_BUILD_VERSION__`, and
 * there the hook answers nothing, whatever the environment says. [proposta]
 */

declare const __OT_BUILD_VERSION__: string | undefined;

export const TEST_MIGRATION_VARIABLE = 'OT_TEST_MIGRATION';

export interface TestMigrationInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Default: whether this process is the release build. */
  readonly releaseBuild?: boolean | undefined;
}

/** The bases the hook says need a migration: empty in the release build or without the variable. */
export function migrationTestHook(input: TestMigrationInput): readonly ('store' | 'telemetry')[] {
  const release = input.releaseBuild ?? typeof __OT_BUILD_VERSION__ === 'string';
  if (release) return [];
  const value = input.env[TEST_MIGRATION_VARIABLE];
  if (value === undefined || value === '') return [];
  const wanted = value.split(',').map((part) => part.trim());
  const bases: ('store' | 'telemetry')[] = [];
  if (wanted.includes('store') || wanted.includes('1') || wanted.includes('true')) {
    bases.push('store');
  }
  if (wanted.includes('telemetry') || wanted.includes('1') || wanted.includes('true')) {
    bases.push('telemetry');
  }
  return bases;
}
