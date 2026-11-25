// SPDX-License-Identifier: MPL-2.0
import { ATOMIC_TEMPORARY_SHAPE, sweepTemporaries } from '@otheater/client/node';
import { CONFIG_TEMPORARY_SHAPE } from './config-edit.js';
import { pluginPaths } from './plugins/registry.js';

/**
 * The start-up cleaning of the files the daemon writes by "a temporary beside it, then a rename" and
 * reads or writes again only later (N306, the continuation of #347): `config.yaml` and `plugins.json`.
 * The three files of the API are swept by `sweepApiTemporaries`; the others sweep after each write.
 * Nothing here is told by a return value: a temporary that cannot be removed goes to the sink of
 * `onTemporarySweepFailure` (the log plus `daemon.notice`, kind `temporary_cleanup_failed`), and the
 * start goes on. What counts as an orphan is the `temporaries` policy in force.
 */
export async function sweepDaemonFileTemporaries(input: {
  readonly configPath: string;
  readonly dataDir: string;
}): Promise<string[]> {
  const removed: string[] = [];
  for (const [file, shape] of [
    [input.configPath, CONFIG_TEMPORARY_SHAPE],
    [pluginPaths(input.dataDir).file, ATOMIC_TEMPORARY_SHAPE],
  ] as const) {
    // At start-up nothing of this process has written yet, so a name with its own pid is an old one too.
    removed.push(...(await sweepTemporaries(file, { ...shape, includeOwnPid: true })));
  }
  return removed;
}
