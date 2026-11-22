// SPDX-License-Identifier: MPL-2.0

/** The number in front of the newest migration (`0010_setup_runs` is 10); 0 when there is none. */
export function newestMigration(migrations: Readonly<Record<string, unknown>>): number {
  let newest = 0;
  for (const name of Object.keys(migrations)) {
    const number = Number.parseInt(name, 10);
    if (Number.isInteger(number) && number > newest) newest = number;
  }
  return newest;
}
