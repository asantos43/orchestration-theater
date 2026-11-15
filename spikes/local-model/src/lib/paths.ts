import { tmpdir } from "node:os";
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = join(ROOT, 'out');
/** Pasta de trabalho fora do repositório: $SPIKE_SCRATCH ou <tmpdir>/otheater-spikes/local-model. */
export const SCRATCH =
  process.env.SPIKE_SCRATCH ?? join(tmpdir(), "otheater-spikes", "local-model");
/** Faixa de portas do spike: 47500-47599. */
export const LLAMA_PORT = 47500;
export const MCP_PORT = 47501;
export const MODEL_FILE = process.env.OT_GGUF ?? `${process.env.HOME}/.cache/llama.cpp/gemma-4-E4B-it-Q4_0.gguf`;

mkdirSync(OUT, { recursive: true });
