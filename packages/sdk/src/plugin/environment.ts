// SPDX-License-Identifier: MPL-2.0
import { isAbsolute, resolve } from 'node:path';

/**
 * The variable that carries the folder of the project to the server of a plugin [proposta].
 *
 * The daemon runs one process per plugin and project (N238), and the working directory of that
 * process is the folder of the plugin (`server.cwd` of the manifest is relative to it), so the
 * working directory cannot say which project the plugin works on. The daemon (P5) hands the
 * absolute path of the project in this variable, one of the few variables the process gets.
 */
export const PLUGIN_PROJECT_DIR_ENV = 'OTHEATER_PROJECT_DIR';

/**
 * The folder of the project the plugin works on: the variable {@link PLUGIN_PROJECT_DIR_ENV}
 * (an absolute path), or, when it is not set, the working directory of the process, which is what
 * a plugin started by hand from a project folder, in development, gets. An empty or relative
 * value is an error: a relative path would silently change meaning with the working directory.
 */
export function pluginProjectDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): string {
  const value = env[PLUGIN_PROJECT_DIR_ENV];
  if (value === undefined) return resolve(cwd);
  if (value === '' || !isAbsolute(value)) {
    throw new Error(`${PLUGIN_PROJECT_DIR_ENV} must be an absolute path, and it is "${value}"`);
  }
  return value;
}
