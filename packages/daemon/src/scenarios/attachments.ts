// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {
  type AttachmentRecord,
  type AttachmentSource,
  type Clock,
  InvalidInput,
  NotFound,
  type Store,
} from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';

/** The limits of `scenarios.*` the service works under. */
export interface AttachmentLimits {
  /** `scenarios.attachment_max_size`: bytes of a copy; 0 = no limit. */
  readonly maxSize: number;
  /** `scenarios.attachment_read_max`: bytes `read_attachment` returns in one call. */
  readonly readMax: number;
}

export interface AttachmentServiceOptions {
  readonly store: Pick<Store, 'attachments' | 'events' | 'scenarios'>;
  readonly clock?: Clock;
  /** `<dataDir>/scenarios`: the copies live in `<scenarios>/<scenario>/attachments`. */
  readonly scenariosDir: string;
  readonly limits: () => AttachmentLimits;
}

/** What `add` takes: a file, by copy (default) or by reference. */
export interface AddFileInput {
  readonly path: string;
  readonly mode?: AttachmentSource;
  /** Shown name. Default: the file name. */
  readonly name?: string;
  readonly messageId?: string;
}

export interface AddTextInput {
  readonly text: string;
  readonly name?: string;
  readonly messageId?: string;
}

/** What `read_attachment` gives back. */
export interface AttachmentContent {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly kind: 'text' | 'image' | 'binary';
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
  /** The read stopped at `scenarios.attachment_read_max` bytes. */
  readonly truncated: boolean;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.ts': 'text/plain',
  '.js': 'text/plain',
  '.py': 'text/plain',
};

const SIGNATURES: readonly { readonly mime: string; readonly bytes: readonly number[] }[] = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

/**
 * [proposta] The type of an attachment: the magic bytes first (an image renamed `.txt` is still an
 * image, and that decides which Executor may read it), then the extension, then `text/plain` when
 * the head is valid UTF-8 without NUL bytes, and `application/octet-stream` otherwise.
 */
export function mimeOf(name: string, head: Uint8Array): string {
  for (const { mime, bytes } of SIGNATURES) {
    if (bytes.every((byte, index) => head[index] === byte)) return mime;
  }
  const riff = String.fromCharCode(...head.slice(0, 4)) === 'RIFF';
  if (riff && String.fromCharCode(...head.slice(8, 12)) === 'WEBP') return 'image/webp';
  const byName = MIME_BY_EXTENSION[extname(name).toLowerCase()];
  if (byName !== undefined && !byName.startsWith('image/') && byName !== 'application/pdf') {
    return byName;
  }
  return looksLikeText(head) ? 'text/plain' : 'application/octet-stream';
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    // A multi-byte character cut by the end of the sample is not a binary file.
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.slice(0, Math.max(0, bytes.length - 3)),
      );
      return true;
    } catch {
      return false;
    }
  }
}

/** True for a type that only an Executor that accepts images may read. */
export function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

/** How `read_attachment` hands a type over: text as is, an image or anything else as base64. */
export function kindOf(mime: string): AttachmentContent['kind'] {
  if (isImage(mime)) return 'image';
  return mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/yaml' ||
    mime === 'application/xml'
    ? 'text'
    : 'binary';
}

async function headOf(path: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function sha256Of(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => {
        done(hash.digest('hex'));
      });
  });
}

function safeName(name: string): string {
  const cleaned = basename(name).replaceAll(/[^A-Za-z0-9._-]+/g, '_');
  return cleaned === '' || cleaned === '.' || cleaned === '..'
    ? 'attachment'
    : cleaned.slice(0, 80);
}

/**
 * The attachments of a scenario (architecture 5.20): a file copied into the scenario folder, a
 * file referenced in place, or a pasted text. Each becomes `A<n>` (the store numbers them), and
 * `scenario.attachment_added` is written. The limit `scenarios.attachment_max_size` applies to
 * what is copied; a reference copies nothing, so it has no limit. [proposta] The copy is named
 * by the hash of its bytes, so the same file attached twice is stored once.
 */
export class AttachmentService {
  readonly #options: AttachmentServiceOptions;

  constructor(options: AttachmentServiceOptions) {
    this.#options = options;
  }

  async addFile(scenarioId: string, input: AddFileInput): Promise<AttachmentRecord> {
    const { store, scenariosDir, limits } = this.#options;
    await this.#scenario(scenarioId);
    const source = resolve(input.path);
    const info = await stat(source).catch(() => undefined);
    if (!info?.isFile()) {
      throw new InvalidInput(`"${source}" is not a file that can be attached`);
    }
    const mode = input.mode ?? 'copy';
    const { maxSize } = limits();
    if (mode === 'copy' && maxSize > 0 && info.size > maxSize) {
      throw new InvalidInput(
        `"${basename(source)}" has ${String(info.size)} bytes, over scenarios.attachment_max_size (${String(maxSize)} bytes); attach it by reference instead`,
      );
    }
    const name = input.name ?? basename(source);
    const mime = mimeOf(name, await headOf(source, 512));
    const hash = await sha256Of(source);
    let path = source;
    if (mode === 'copy') {
      const folder = join(scenariosDir, scenarioId, 'attachments');
      await mkdir(folder, { recursive: true });
      path = join(folder, `${hash.slice(0, 16)}-${safeName(name)}`);
      await copyFile(source, path);
    }
    const record = await store.attachments.add({
      scenarioId,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      name,
      mime,
      size: info.size,
      hash,
      source: mode,
      path,
    });
    await this.#announce(record);
    return record;
  }

  async addText(scenarioId: string, input: AddTextInput): Promise<AttachmentRecord> {
    const { store, scenariosDir, limits } = this.#options;
    await this.#scenario(scenarioId);
    const bytes = Buffer.from(input.text, 'utf8');
    const { maxSize } = limits();
    if (bytes.length === 0) throw new InvalidInput('The pasted text is empty');
    if (maxSize > 0 && bytes.length > maxSize) {
      throw new InvalidInput(
        `The text has ${String(bytes.length)} bytes, over scenarios.attachment_max_size (${String(maxSize)} bytes)`,
      );
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const name = input.name ?? 'pasted.txt';
    const folder = join(scenariosDir, scenarioId, 'attachments');
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${hash.slice(0, 16)}-${safeName(name)}`);
    await writeFile(path, bytes);
    const record = await store.attachments.add({
      scenarioId,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      name,
      mime: 'text/plain',
      size: bytes.length,
      hash,
      source: 'copy',
      path,
    });
    await this.#announce(record);
    return record;
  }

  /** The attachment, or `NotFound`. */
  async get(scenarioId: string, id: string): Promise<AttachmentRecord> {
    const record = await this.#options.store.attachments.get(scenarioId, id);
    if (record === undefined) throw new NotFound(`There is no attachment "${id}" in this scenario`);
    return record;
  }

  /** The line a prompt shows for an attachment: id, name, type and size (5.20). */
  static describe(record: AttachmentRecord): string {
    return `${record.id}: ${record.name} (${record.mime}, ${String(record.size)} bytes)`;
  }

  /**
   * What `read_attachment` returns: the text itself, or an image or binary file as base64. A read
   * is cut at `scenarios.attachment_read_max` bytes; text says so (`truncated`), and an image or
   * binary file that does not fit is refused, because half an image is useless. The check of
   * who may read an image is the caller's (it knows the Executor).
   */
  async read(record: AttachmentRecord): Promise<AttachmentContent> {
    const { readMax } = this.#options.limits();
    const max = readMax > 0 ? readMax : Number.MAX_SAFE_INTEGER;
    const kind = kindOf(record.mime);
    const info = await stat(record.path).catch(() => undefined);
    if (!info?.isFile()) {
      throw new NotFound(`The file of attachment ${record.id} is gone (${record.source})`);
    }
    const base = {
      id: record.id,
      name: record.name,
      mime: record.mime,
      size: info.size,
      kind,
    } as const;
    if (kind === 'text') {
      const head = await headOf(record.path, Math.min(info.size, max));
      return {
        ...base,
        encoding: 'utf8',
        content: Buffer.from(head).toString('utf8'),
        truncated: info.size > max,
      };
    }
    if (info.size > max) {
      throw new InvalidInput(
        `Attachment ${record.id} has ${String(info.size)} bytes, over scenarios.attachment_read_max (${String(max)} bytes)`,
      );
    }
    const bytes = await headOf(record.path, info.size);
    return {
      ...base,
      encoding: 'base64',
      content: Buffer.from(bytes).toString('base64'),
      truncated: false,
    };
  }

  async #scenario(scenarioId: string): Promise<void> {
    if ((await this.#options.store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
  }

  async #announce(record: AttachmentRecord): Promise<void> {
    await this.#options.store.events.append({
      ...buildDaemonEvent('scenario.attachment_added', {
        scenarioId: record.scenarioId,
        attachmentId: record.id,
        name: record.name,
        mime: record.mime,
        size: record.size,
        hash: record.hash,
        source: record.source,
      }),
      scenarioId: record.scenarioId,
    });
  }
}
