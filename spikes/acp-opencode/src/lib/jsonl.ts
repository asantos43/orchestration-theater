import { appendFileSync, writeFileSync } from 'node:fs';

/** Log JSONL com relógio monotônico (ms desde a criação). */
export class Jsonl {
  readonly t0 = performance.now();
  readonly file: string;
  constructor(file: string, truncate = true) {
    this.file = file;
    if (truncate) writeFileSync(file, '');
  }
  now(): number {
    return Math.round((performance.now() - this.t0) * 10) / 10;
  }
  write(rec: Record<string, unknown>): void {
    appendFileSync(this.file, JSON.stringify({ t: this.now(), ...rec }) + '\n');
  }
}
