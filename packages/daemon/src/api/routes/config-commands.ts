// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, isOTheaterError, type JsonObject, type JsonValue } from '@otheater/core';
import { editConfigFile } from '../../config-edit.js';
import { writeSituation } from '../../situations.js';
import type { CommandRegistrar } from './command.js';
import type { CommandRouteDeps } from './deps.js';
import { redactTree } from './redact.js';

/** The value as the tree `config.yaml` would hold it at `path`, to ask the redaction about it. */
export function treeAt(path: readonly string[], value: JsonValue): JsonObject {
  let node: JsonValue = value;
  for (const key of [...path].reverse()) node = { [key]: node };
  return node as JsonObject;
}

/**
 * The command that edits the configuration file (P6 of docs/17). [proposta] The rules:
 * - the edit is the one of `config-edit.ts`: comments and order stay, the result is validated like a
 *   start validates it, the write is atomic;
 * - a value that the read route would hold back as a secret is refused (a secret goes to the vault,
 *   never to the YAML, and the edit would otherwise return it to anyone who reads the file);
 * - edits that arrive together run one after the other (the file is read, changed and written whole);
 * - the daemon keeps the configuration it started with, so the answer says the edit applies on
 *   restart; the event `config.edited` carries the paths, never the values.
 */
export function registerConfigCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  const { store, logger, configPath } = deps;
  let chain: Promise<unknown> = Promise.resolve();

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
    const run = async (): Promise<{ set: string[]; removed: string[] }> => {
      const removed: string[] = [];
      try {
        await editConfigFile(configPath, (editor) => {
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
      return { set: set.map((entry) => entry.path.join('.')), removed };
    };
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    const done = await next;
    await writeSituation(store.events, logger, 'config.edited', {
      set: done.set,
      removed: done.removed,
      appliesOn: 'restart',
    });
    return { appliesOn: 'restart' as const, set: done.set, removed: done.removed };
  });
}
