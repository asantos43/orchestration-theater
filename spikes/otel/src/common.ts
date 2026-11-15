import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCRATCH =
  process.env.SPIKE_SCRATCH ?? join(tmpdir(), "otheater-spikes", "otel");
export const REPO = join(SCRATCH, "repo");
export const OUT = join(import.meta.dirname, "..", "out");
export const PORT = Number(process.env.OTEL_SPIKE_PORT ?? 47301);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ambiente limpo: so o minimo. Descarta tudo que o Claude Desktop/Code que me lancou deixou (CLAUDE_*, ANTHROPIC_*, OTEL_*). */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "SHELL", "TERM", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMPDIR"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  env.NO_COLOR = "1";
  return { ...env, ...extra };
}

export const PROMPT_TOOL = "Leia o arquivo hello.txt (use a ferramenta Read) e responda so com o conteudo.";
export const PROMPT_SHORT = "Responda apenas: ok";

export type Run = { tag: string; ms: number; code: number | null; stdout: string; stderr: string; startedAt: number; endedAt: number };

export async function run(tag: string, cmd: string, args: string[], env: Record<string, string>, opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<Run> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, cwd: opts.cwd ?? REPO, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => c.kill("SIGTERM"), opts.timeoutMs ?? 180000);
    c.stdin.end(opts.input ?? "");
    c.on("close", (code) => {
      clearTimeout(timer);
      const endedAt = Date.now();
      resolve({ tag, ms: endedAt - startedAt, code, stdout, stderr, startedAt, endedAt });
    });
  });
}

export function saveRun(r: Run, extra: Record<string, unknown> = {}) {
  const dir = join(OUT, r.tag);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ tag: r.tag, ms: r.ms, code: r.code, startedAt: r.startedAt, endedAt: r.endedAt, stderrHead: r.stderr.slice(0, 1500), stdoutHead: r.stdout.slice(0, 3000), ...extra }, null, 1));
}
