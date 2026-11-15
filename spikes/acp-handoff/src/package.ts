// Monta o pacote de continuacao (arquitetura 5.16) a partir do que o harness registrou: ordens, diff da worktree
// e trajetoria capturada nos eventos ACP. Nada vem da memoria do modelo.
import { ORDERS, STEPS, diffAgainst, progress } from "./task.ts";
import type { ToolRec } from "./acp.ts";

export type Variant = "min" | "full";
export type OriginRec = { clientName: string; base: string; checkpoint: string; dir: string; killed: boolean; trace: { tools: ToolRec[]; messages: string[] }; progress: { done: boolean[] } };

const rel = (s: string | undefined, dir: string) => (s ?? "").split(dir + "/").join("").split(dir).join(".");
const one = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

function trajectory(o: OriginRec) {
  const tools = o.trace.tools;
  const reads = [...new Set(tools.filter((t) => t.kind === "read").flatMap((t) => (t.locations ?? []).map((l) => rel(l, o.dir))))];
  const edits = tools.filter((t) => t.kind === "edit" && t.status === "completed");
  const editedFiles = [...new Set(edits.flatMap((t) => (t.locations ?? []).map((l) => rel(l, o.dir))))];
  const cmds = tools.filter((t) => t.kind === "execute");
  const lines: string[] = [];
  lines.push(`- files read: ${reads.length ? reads.join(", ") : "(none recorded)"}`);
  lines.push(`- files edited (completed edits: ${edits.length}): ${editedFiles.join(", ") || "(none)"}`);
  lines.push(`- commands run (${cmds.length}):`);
  for (const c of cmds) lines.push(`  - \`${one(rel(c.cmd ?? c.title, o.dir), 120)}\` -> ${c.status}${c.output ? `; output: ${one(rel(c.output, o.dir), 160)}` : ""}`);
  const last = o.trace.messages.filter((m) => m.trim()).at(-1);
  lines.push(`- last agent message: ${last ? `"${one(last, 400)}"` : "(none)"}`);
  const unfinished = tools.filter((t) => t.status !== "completed" && t.status !== "failed");
  if (unfinished.length) lines.push(`- tool calls in flight at interruption (effect unknown, check the diff): ${unfinished.map((t) => one(rel(t.title, o.dir), 80)).join("; ")}`);
  return lines.join("\n");
}

export function buildPackage(variant: Variant, o: OriginRec, dir: string) {
  const diff = rel(diffAgainst(dir, o.base), dir);
  const head = `# CONTINUATION PACKAGE (${variant})\nYou are taking over a task that another coding agent started and could not finish. You cannot see its conversation; everything you need is below. The files in the current directory already contain its work.\n`;
  const s1 = `\n## 1. Task and orders (verbatim, still in force)\n${ORDERS}\n`;
  const s2 = `\n## 2. Worktree state: diff against the base commit of the attempt\n\`\`\`diff\n${diff.trimEnd()}\n\`\`\`\n`;
  const tail = `\n## Instruction\nContinue from this state. Do not redo what is already in the diff.`;
  if (variant === "min") return head + s1 + s2 + tail + " Finish the task.\n";
  const p = progress(dir);
  const check = STEPS.map((s, i) => `- [${p.done[i] ? "x" : " "}] ${s}`).join("\n") + `\n- [ ] 7. run \`node --test lib.test.mjs\` and fix failures (not done yet)\n- [ ] 8. final answer`;
  const why = `\n## 3. Why it stopped\nThe agent process (another client) was killed in the middle of the work; there is no stop reason and its last message may be incomplete. Not a failure of the task itself.\n`;
  const prog = `\n## 4. Progress (computed from the files, not from the agent's memory)\n${check}\n`;
  const traj = `\n## 5. Trajectory so far (recorded from the client's events)\n${trajectory(o)}\n`;
  const remaining = STEPS.map((s, i) => (p.done[i] ? null : s)).filter(Boolean);
  const rem = `\n## 6. What remains\n${remaining.join("\n")}\n7. run the tests and fix failures\n8. final answer\n`;
  return head + s1 + s2 + why + prog + traj + rem + tail + " Do not redo steps marked [x]; do the remaining steps in order, and do not rewrite earlier code unless a test proves it wrong.\n";
}
