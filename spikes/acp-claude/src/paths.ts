import { join } from "node:path";

// Repositorio de teste (fora do repositorio do OTheater), criado na scratchpad.
export const SCRATCH =
  "/tmp/claude-1000/-home-anderson--claude-spares-spare-stJI7q/7fae85d3-3bfb-4d0b-aaf1-48870b56d0b2/scratchpad/acp-claude";
export const REPO = join(SCRATCH, "repo");
export const WT = (n: number) => join(SCRATCH, `wt${n}`);
export const OUT = join(import.meta.dirname, "..", "out");
