// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, isOTheaterError } from '@otheater/core';
import { applyHotSections, splitByReload } from '../../config-hot.js';
import type { DaemonConfig } from '../../config.js';
import { editConfigFile } from '../../config-edit.js';
import { writeSituation } from '../../situations.js';
import type { CommandRegistrar } from './command.js';
import type { CommandRouteDeps } from './deps.js';
import { redactTree, treeAt } from './redact.js';

/**
 * The command that edits the configuration file (P6 of docs/17). [proposta] The rules:
 * - the edit is the one of `config-edit.ts`: comments and order stay, the result is validated like a
 *   start validates it, the write is atomic;
 * - a value that the read route would hold back as a secret is refused (a secret goes to the vault,
 *   never to the YAML, and the edit would otherwise return it to anyone who reads the file);
 * - edits that arrive together run one after the other (the file is read, changed and written whole;
 *   `editConfigFile` keeps one queue per file, shared with the setup assistant);
 * - N188 (P16 of Phase 7): the sections `ui`, `chat`, `limits` and `roles` are reloaded into the
 *   running configuration right after the write, with the event `config.changed`; the other keys
 *   apply on restart, and the answer lists which is which. Both events carry the paths, never the
 *   values.
 */
export function registerConfigCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  const { store, logger, configPath, config: live } = deps;

  /** The failure with the path of the file replaced, so a response does not say where the daemon lives. */
  const scrubbed = (error: unknown): unknown =>
    error instanceof InvalidInput
      ? new InvalidInput(error.message.split(configPath).join('config.yaml'))
      : error;

  register('putConfig', async ({ body }) => {
    const set = body.set ?? [];
    const remove = body.remove ?? [];
    for (const [index, entry] of set.entries()) {
      if (redactTree(treeAt(entry.path, entry.value)).paths.length > 0) {
        throw new InvalidInput(
          `The value of ${entry.path.join('.')} looks like a secret: keep secrets in the vault, not in the configuration (set[${String(index)}])`,
        );
      }
    }
    const removed: string[] = [];
    let next: DaemonConfig;
    try {
      next = await editConfigFile(configPath, (editor) => {
        for (const entry of set) editor.set(entry.path, entry.value);
        for (const path of remove) {
          // A key that is not in the file is already at its default: nothing to take out.
          if (editor.has(path) && editor.remove(path)) removed.push(path.join('.'));
        }
      });
    } catch (error) {
      if (isOTheaterError(error)) throw scrubbed(error);
      // A path the file cannot hold (a key under a value that is not a map).
      throw new InvalidInput(
        `The edit does not fit the file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const setPaths = set.map((entry) => entry.path.join('.'));
    const { hot, restart } =
      live === undefined
        ? { hot: [], restart: [...setPaths, ...removed] }
        : splitByReload([...setPaths, ...removed]);
    if (live !== undefined && hot.length > 0) applyHotSections(live, next);
    const appliesOn = restart.length === 0 ? 'hot' : hot.length === 0 ? 'restart' : 'mixed';
    await writeSituation(store.events, logger, 'config.edited', {
      set: setPaths,
      removed,
      appliesOn,
    });
    if (hot.length > 0)
      await writeSituation(store.events, logger, 'config.changed', { hot, restart });
    return { appliesOn, set: setPaths, removed, hot, restart } as const;
  });
}
