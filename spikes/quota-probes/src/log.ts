import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./paths.ts";

export const t0 = Date.now();
export const now = () => Date.now() - t0;

export class Jsonl {
  readonly file: string;
  constructor(name: string) {
    mkdirSync(OUT, { recursive: true });
    this.file = join(OUT, `${name}.jsonl`);
  }
  write(rec: Record<string, unknown>) {
    appendFileSync(this.file, JSON.stringify({ t: now(), ...rec }) + "\n");
  }
}

// Contador de prompts (limite do dono: 25). Cada chamada de session/prompt conta.
export function countPrompt(scenario: string) {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(join(OUT, "prompts.log"), `${new Date().toISOString()} ${scenario}\n`);
}
