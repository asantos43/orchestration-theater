import { tmpdir } from "node:os";
import { join } from "node:path";

// Repositorio de teste (fora do repositorio do OTheater), criado na scratchpad.
export const SCRATCH =
  process.env.SPIKE_SCRATCH ?? join(tmpdir(), "otheater-spikes", "quota-probes");
export const REPO = join(SCRATCH, "repo");
export const OUT = join(import.meta.dirname, "..", "out");
