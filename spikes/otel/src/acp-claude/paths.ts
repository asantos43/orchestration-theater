import { join } from "node:path";
import { SCRATCH, REPO } from "../common.ts";
export { SCRATCH, REPO };
export const OUT = join(import.meta.dirname, "..", "..", "out", "acp-claude-logs");
