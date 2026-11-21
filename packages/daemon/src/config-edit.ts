// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { InvalidInput } from '@otheater/core';
import { Document, isSeq, parseDocument, type YAMLSeq } from 'yaml';
import { parseConfig, type DaemonConfig } from './config.js';

/**
 * Edits of `<data>/config.yaml` made by a command (Phase 5, P14: the cadastro of an Executor writes
 * `executors.<id>`, the lists of the roles and the `local` block of a profile). The file belongs to
 * the Producer, who edits it by hand, so a command must leave it as it found it: the comments, the
 * order and the spelling of what it does not touch stay (the `yaml` Document API keeps them).
 *
 * Safety, in this order: the file is read and parsed (a file that is not valid YAML is never
 * touched); the edit runs on the document; the RESULT is validated with `parseConfig` (so an edit
 * can never leave a config the daemon would refuse to start with); only then it is written, to a
 * temporary file next to it and renamed over it, so a crash leaves the old file or the new one.
 */

/** The YAML document of the config, as an edit sees it. */
export interface ConfigEditor {
  /** Sets `path` (created as needed) to a plain value. */
  set(path: readonly string[], value: unknown): void;
  /** Takes `path` out; the parents that become empty stay (a comment may live there). */
  remove(path: readonly string[]): boolean;
  has(path: readonly string[]): boolean;
  /** The plain value at `path`, or `undefined`. */
  get(path: readonly string[]): unknown;
  /**
   * Puts `value` in the list at `path` at `position` (clamped to the list; the list is created when
   * missing). Does nothing when the list already holds the value; returns whether it was added.
   */
  insert(path: readonly string[], position: number, value: string): boolean;
  /** Takes `value` out of the list at `path`; the list is removed when it becomes empty. */
  withdraw(path: readonly string[], value: string): boolean;
}

function editorOf(doc: Document): ConfigEditor {
  const seqAt = (path: readonly string[]): YAMLSeq | undefined => {
    const node = doc.getIn([...path], true);
    return isSeq(node) ? node : undefined;
  };
  return {
    set: (path, value) => {
      doc.setIn([...path], doc.createNode(value));
    },
    remove: (path) => doc.deleteIn([...path]),
    has: (path) => doc.hasIn([...path]),
    get: (path) => {
      const node = doc.getIn([...path]);
      return node;
    },
    insert: (path, position, value) => {
      const seq = seqAt(path);
      if (seq === undefined) {
        doc.setIn([...path], doc.createNode([value]));
        return true;
      }
      if (seq.items.some((item) => String(isSeqScalar(item)) === value)) return false;
      seq.items.splice(Math.max(0, Math.min(position, seq.items.length)), 0, doc.createNode(value));
      return true;
    },
    withdraw: (path, value) => {
      const seq = seqAt(path);
      if (seq === undefined) return false;
      const index = seq.items.findIndex((item) => String(isSeqScalar(item)) === value);
      if (index === -1) return false;
      seq.items.splice(index, 1);
      if (seq.items.length === 0) doc.deleteIn([...path]);
      return true;
    },
  };
}

function isSeqScalar(item: unknown): unknown {
  if (typeof item === 'object' && item !== null && 'value' in item) {
    return item.value;
  }
  return item;
}

/** Text of `path`, or `''` when the file does not exist. */
async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new InvalidInput(`Cannot read ${path}: ${String(error)}`, { cause: error });
  }
}

/**
 * Runs `edit` on the config file at `path`, validates the result and writes it. Returns the new
 * configuration. Throws `InvalidInput` (naming the key) when the file is not valid YAML or the
 * edited one would not be a valid configuration; the file is not written in that case.
 */
export function editConfigFile(
  path: string,
  edit: (editor: ConfigEditor) => void,
): Promise<DaemonConfig> {
  // The file is read, changed and written whole, so two edits of the same file must not overlap:
  // `PUT /v1/config`, the setup assistant (P4) and the cadastro of an Executor all come through
  // here, and the queue keeps the last one from silently undoing the first (P16, N188).
  const previous = queues.get(path) ?? Promise.resolve();
  const run = (): Promise<DaemonConfig> => editNow(path, edit);
  const next = previous.then(run, run);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(path, tail);
  void tail.then(() => {
    if (queues.get(path) === tail) queues.delete(path);
  });
  return next;
}

/** The edits waiting or running, by file: the tail of each file's queue. */
const queues = new Map<string, Promise<void>>();

async function editNow(path: string, edit: (editor: ConfigEditor) => void): Promise<DaemonConfig> {
  const text = await readOrEmpty(path);
  const doc: Document = parseDocument(text, { keepSourceTokens: false });
  if (doc.errors.length > 0) {
    throw new InvalidInput(`${path}: not valid YAML: ${doc.errors[0]?.message ?? 'unknown'}`);
  }
  doc.contents ??= doc.createNode({});
  edit(editorOf(doc));
  const out = String(doc);
  const config = parseConfig(out, path);
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, out, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return config;
}
