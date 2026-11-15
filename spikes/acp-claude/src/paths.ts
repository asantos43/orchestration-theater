import { tmpdir } from "node:os";
import { join } from "node:path";

// Repositorio de teste (fora do repositorio do OTheater), criado na scratchpad.
export const SCRATCH =
  process.env.SPIKE_SCRATCH ?? join(tmpdir(), "otheater-spikes", "acp-claude");
export const REPO = join(SCRATCH, "repo");
export const WT = (n: number) => join(SCRATCH, `wt${n}`);
export const OUT = join(import.meta.dirname, "..", "out");
