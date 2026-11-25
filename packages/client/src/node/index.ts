// SPDX-License-Identifier: MPL-2.0
import { homedir } from 'node:os';
import { DaemonDirectory, type DaemonDirectoryOptions } from '../directory.js';
import { FileDaemonListStore, localDaemonSource } from './files.js';
import { clientConfigFile, resolveClientConfigDir, resolveDataDir, type Env } from './paths.js';

export * from './paths.js';
export * from './files.js';
export * from './temporaries.js';
export * from './layout-file.js';

export interface NodeDaemonDirectoryOptions extends Pick<
  DaemonDirectoryOptions,
  'fetch' | 'timeoutMs'
> {
  /** Defaults to `process.env`. */
  readonly env?: Env | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly homedir?: string | undefined;
  /** The folder of `client.json`. Default: {@link resolveClientConfigDir}. */
  readonly configDir?: string | undefined;
  /** The data folder of the local daemon. Default: {@link resolveDataDir}. */
  readonly dataDir?: string | undefined;
}

/**
 * The directory of this machine: the list in `client.json` and the local daemon found in the data
 * folder. Environment, platform and home are arguments so a test points them at a temporary folder.
 */
export function createNodeDaemonDirectory(
  options: NodeDaemonDirectoryOptions = {},
): DaemonDirectory {
  const where = {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    homedir: options.homedir ?? homedir(),
  };
  const configDir = options.configDir ?? resolveClientConfigDir(where);
  const dataDir = options.dataDir ?? resolveDataDir(where);
  return new DaemonDirectory({
    store: new FileDaemonListStore(clientConfigFile(configDir)),
    local: localDaemonSource(dataDir),
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
}
export * from './ui-catalog.js';
export * from './sea.js';
