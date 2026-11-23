// SPDX-License-Identifier: MPL-2.0
import { gunzipSync } from 'node:zlib';

/**
 * A reader of the `.tgz` an npm registry serves (Phase 10, P13; N254 revised). It is written here and
 * not taken from a package: the installer needs nothing but gunzip and the ustar format, and the
 * executable must not carry one more dependency for it. Only what an npm tarball holds is read:
 * regular files and directories, `ustar` names with a prefix, pax headers (`path`) and GNU long
 * names. Links, devices and the rest are skipped, never created. Every path is checked.
 */

export interface TarFile {
  /** The path inside the archive, with the first component (npm's `package/`) removed. */
  readonly path: string;
  readonly data: Buffer;
  /** True when any execute bit is set in the archive. */
  readonly executable: boolean;
}

export class TarError extends Error {
  override readonly name = 'TarError';
}

export interface TarOptions {
  /** Upper bound of the uncompressed size. Default 512 MiB. */
  readonly maxBytes?: number;
  /**
   * Upper bound of the entries (files, directories, links and the rest; not the pax and long-name
   * headers). A bigger archive is a {@link TarError}. Default {@link DEFAULT_MAX_ENTRIES}.
   */
  readonly maxEntries?: number;
}

/** The default of `clients.adapters.tar_max_entries`. */
export const DEFAULT_MAX_ENTRIES = 20_000;

const BLOCK = 512;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

function text(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function octal(block: Buffer, start: number, length: number): number {
  // GNU base-256 (high bit set) is for sizes over 8 GiB: not an npm package.
  if (((block[start] ?? 0) & 0x80) !== 0) throw new TarError('unsupported base-256 number');
  const value = text(block, start, length).trim();
  if (value === '') return 0;
  if (!/^[0-7]+$/u.test(value)) throw new TarError(`bad number in the header: ${value}`);
  return Number.parseInt(value, 8);
}

function checksumOk(block: Buffer): boolean {
  const stored = octal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  return sum === stored;
}

/** `key=value` records of a pax header: `<length> <key>=<value>\n`. */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isInteger(length) || length <= space - offset + 1 || offset + length > data.length)
      throw new TarError('bad pax record');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    offset += length;
  }
  return records;
}

/**
 * The relative path an archive entry may be written to, or a {@link TarError}: the first component
 * is dropped, and an empty, absolute, drive or `..` path is refused (no entry writes outside).
 */
export function safeArchivePath(name: string): string | undefined {
  const parts = name
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.');
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/u.test(name))
    throw new TarError(`absolute path in the archive: ${name}`);
  if (parts.includes('..')) throw new TarError(`path leaves the archive: ${name}`);
  const rest = parts.slice(1);
  return rest.length === 0 ? undefined : rest.join('/');
}

/**
 * The regular files of a `.tgz`, in archive order. An entry that repeats a path (or only the case of
 * one, which is the same file on a case-insensitive disk) is a {@link TarError}: the second would
 * replace the first after it was checked, and nothing in an npm tarball needs it.
 */
export function readTarGz(archive: Buffer, options: TarOptions = {}): TarFile[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const seen = new Set<string>();
  let entries = 0;
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxBytes });
  } catch (error) {
    throw new TarError(
      `not a gzip file or too large: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files: TarFile[] = [];
  let offset = 0;
  let longName: string | undefined;
  let pax: Map<string, string> | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      offset = tar.length;
      break;
    }
    if (!checksumOk(header)) throw new TarError('bad checksum in a header');
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0x30);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new TarError('the archive is cut');
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      pax = paxRecords(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = text(data, 0, data.length);
      continue;
    }
    entries += 1;
    if (entries > maxEntries) throw new TarError(`more than ${String(maxEntries)} entries`);
    const prefix = text(header, 345, 155);
    const baseName = text(header, 0, 100);
    const name =
      pax?.get('path') ?? longName ?? (prefix === '' ? baseName : `${prefix}/${baseName}`);
    pax = undefined;
    longName = undefined;
    if (type !== '0' && type !== '\0') continue; // directories are made by their files; links are not made
    const relative = safeArchivePath(name);
    if (relative === undefined) continue;
    const key = relative.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new TarError(`the archive has the path twice: ${relative}`);
    seen.add(key);
    files.push({
      path: relative,
      data: Buffer.from(data),
      executable: (octal(header, 100, 8) & 0o111) !== 0,
    });
  }
  if (offset !== tar.length) throw new TarError('the archive is cut');
  return files;
}
