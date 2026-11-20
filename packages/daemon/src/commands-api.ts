// SPDX-License-Identifier: MPL-2.0
import { hasErrorCode } from '@otheater/core';
import { API_ROUTES } from '@otheater/protocol';
import { generateApiToken, readApiToken, readDiscovery, writePrivateFile } from './api/files.js';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from './commands.js';
import { InstanceLock } from './instance-lock.js';
import { dataPaths, ensureDataDir } from './paths.js';

/** The `fetch` the command uses to reach the daemon; tests give their own. */
export type ApiFetch = typeof fetch;

/**
 * `ot api rotate-token` (P3 of docs/17). [proposta] Two paths, decided by the instance lock, as
 * `ot backup`:
 * - no daemon: this process takes the lock and writes a new token into `api-token` (the next
 *   start reuses it with `api.token: persistent`);
 * - daemon running: the new token is made by the daemon, through `POST /v1/api-token/rotate`,
 *   authenticated with the current token (read from `api-token`) at the address `api.json` gives.
 *   The old token stops working at once; the command never prints a token.
 */
export async function runApiRotateTokenCommand(
  context: CommandContext,
  fetchImpl: ApiFetch = fetch,
): Promise<number> {
  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);

  let lock: InstanceLock | undefined;
  try {
    lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
  } catch (error) {
    if (!hasErrorCode(error, 'CONFLICT')) throw error;
  }
  if (lock !== undefined) {
    try {
      await writePrivateFile(paths.apiToken, generateApiToken());
    } finally {
      await lock.release();
    }
    context.out(context.t('api.rotatedOffline'));
    return EXIT_OK;
  }

  const discovery = await readDiscovery(paths.apiDiscovery);
  if (discovery.kind !== 'live') {
    context.err(context.t('api.noApi'));
    return EXIT_FAILED;
  }
  const token = await readApiToken(paths.apiToken);
  if (token === undefined) {
    context.err(context.t('api.noToken'));
    return EXIT_FAILED;
  }
  const route = API_ROUTES.rotateApiToken;
  let response: Response;
  try {
    response = await fetchImpl(`${discovery.info.url}${route.path}`, {
      method: route.method,
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    context.err(context.t('api.unreachable', { url: discovery.info.url }));
    return EXIT_FAILED;
  }
  if (response.status === 401 || response.status === 403) {
    context.err(context.t('api.rejected', { status: response.status }));
    return EXIT_FAILED;
  }
  if (!response.ok) {
    context.err(context.t('api.failed', { status: response.status }));
    return EXIT_FAILED;
  }
  context.out(context.t('api.rotated'));
  return EXIT_OK;
}
