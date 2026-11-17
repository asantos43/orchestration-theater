// SPDX-License-Identifier: MPL-2.0
import { isSecretPath, resolveSecretPaths } from '@otheater/core';
import { secretPathEntries, type DaemonConfig } from '../config.js';
import type { IsSecretPath } from './file-origin.js';

/**
 * The check `file://` runs on a path (architecture 5.19): the ONE list of secret paths of the
 * daemon, the same the Sandbox hides from an Executor. The list is `security.secret_paths`, or its
 * alias `browser.secret_paths`; `~` is `home` and `<data>` is `dataDir`. A list that cannot be
 * built (an entry the module refuses) throws: the caller must not start the browser tools then.
 */
export function secretPathCheck(
  config: Pick<DaemonConfig, 'security' | 'browser'>,
  home: string,
  dataDir: string,
): IsSecretPath {
  const entries = secretPathEntries(config);
  const list = resolveSecretPaths({ home, dataDir, add: entries.add, remove: entries.remove });
  return (path) => isSecretPath(path, list);
}
