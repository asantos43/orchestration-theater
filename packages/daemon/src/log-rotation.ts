// SPDX-License-Identifier: MPL-2.0
import { closeSync, fstatSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';

/**
 * The rotation of `daemon.log` by size (Phase 8, P8; `log.rotate.*`). [proposta]
 * The file is `daemon.log`; the copies are `daemon.log.1` (the newest) to `daemon.log.<keep>`, and
 * the one past `keep` is deleted. `keep: 0` keeps no copy: the full file is deleted.
 *
 * Linux, macOS and Windows: a file that is open cannot be renamed or deleted on Windows, so the
 * descriptor is closed before the chain of renames and opened again after it. If a step fails (a
 * viewer holds a copy open on Windows, the disk is read-only), the log goes on in the file it has,
 * which is opened again in append mode, the failure is told once through `onError`, and the next
 * attempt waits until the file has grown by another `maxBytes`.
 */
export interface LogRotation {
  /** The file rotates before a line that would take it past this size. */
  readonly maxBytes: number;
  /** The copies kept (`daemon.log.1` to `daemon.log.<keep>`); `0` keeps none. */
  readonly keep: number;
}

export interface RotatingFileOptions extends LogRotation {
  readonly path: string;
  /** The mode of a file created here. */
  readonly mode: number;
  /** Told once for each rotation that failed; never throws into the logger. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

/**
 * A synchronous `DestinationStream` for pino: one `write` is one `writeSync`, so nothing is lost in
 * a crash or a flush race at shutdown, and the size it tracks is the size of the file.
 */
export class RotatingFile {
  readonly #o: RotatingFileOptions;
  #fd: number | undefined;
  #size = 0;
  /** The size the file must reach before the next rotation is tried (it grows after a failure). */
  #limit: number;
  #ended = false;

  constructor(options: RotatingFileOptions) {
    this.#o = options;
    this.#limit = options.maxBytes;
    this.#open();
  }

  write(chunk: string | Uint8Array): void {
    if (this.#ended) return;
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (this.#size > 0 && this.#size + data.length > this.#limit) this.#rotate();
    if (this.#fd === undefined) this.#open();
    if (this.#fd === undefined) return;
    try {
      let written = 0;
      while (written < data.length) {
        written += writeSync(this.#fd, data, written, data.length - written);
      }
      this.#size += data.length;
    } catch {
      // A log that cannot be written (disk full) must not stop the daemon: the line is lost.
    }
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#close();
  }

  #open(): void {
    try {
      this.#fd = openSync(this.#o.path, 'a', this.#o.mode);
      this.#size = fstatSync(this.#fd).size;
    } catch {
      this.#fd = undefined;
    }
  }

  #close(): void {
    if (this.#fd === undefined) return;
    try {
      closeSync(this.#fd);
    } catch {
      // Nothing to do: the descriptor is gone either way.
    }
    this.#fd = undefined;
  }

  #rotate(): void {
    this.#close();
    try {
      rotateChain(this.#o.path, this.#o.keep);
      this.#limit = this.#o.maxBytes;
    } catch (error) {
      // The next attempt waits for another `maxBytes` of log, so a locked copy is not retried per line.
      this.#open();
      this.#limit = this.#size + this.#o.maxBytes;
      try {
        this.#o.onError?.(error);
      } catch {
        // The report may not break the log.
      }
      return;
    }
    this.#open();
  }
}

/**
 * Moves `path` to `path.1`, `path.1` to `path.2` and so on up to `keep`; what would pass `keep` is
 * deleted (all of them are, with `keep: 0`). A name that is already free is skipped.
 */
export function rotateChain(path: string, keep: number): void {
  if (keep <= 0) {
    removeIfThere(path);
    return;
  }
  // The oldest copy goes first, so every rename below finds its target free (Windows does not
  // replace a file by renaming over it in every setup).
  removeIfThere(`${path}.${String(keep)}`);
  for (let n = keep - 1; n >= 1; n -= 1) {
    renameIfThere(`${path}.${String(n)}`, `${path}.${String(n + 1)}`);
  }
  renameIfThere(path, `${path}.1`);
}

function removeIfThere(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function renameIfThere(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
