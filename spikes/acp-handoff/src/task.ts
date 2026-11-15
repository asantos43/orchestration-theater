// A tarefa de teste: 3 funcoes + testes, em 7 passos, e como medir o estado da worktree.
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCRATCH =
  process.env.SPIKE_SCRATCH ?? join(tmpdir(), "otheater-spikes", "acp-handoff");
export const REPO = join(SCRATCH, "repo");
export const ROOT = join(import.meta.dirname, "..");
export const OUT = join(ROOT, "out");
mkdirSync(OUT, { recursive: true });

export const ORDERS = `You are working in a small Node.js ESM project (no dependencies) in the current directory. Files: lib.mjs (the library) and lib.test.mjs (node:test tests).

GOAL: implement three functions in lib.mjs, each with its own tests in lib.test.mjs, and make \`node --test lib.test.mjs\` pass.

Function specs:
1. slugify(str): lowercase the string; strip diacritics (use Unicode NFD and remove combining marks); replace every run of characters that are not [a-z0-9] with a single "-"; remove leading and trailing "-". Returns a string ("" if nothing is left).
2. wordFreq(str): a word is a maximal run of Unicode letters or digits (regex \\p{L}|\\p{N}, flag u), compared in lowercase (so "it's" gives the words "it" and "s"). Returns an array of [word, count] pairs sorted by count descending, then by word ascending (plain < comparison). Empty input gives [].
3. chunk(arr, size): split arr into consecutive arrays of at most size items. size must be an integer >= 1, otherwise throw a RangeError. Does not mutate arr. chunk([], n) gives [].

ORDERS (follow strictly, in this order, one file edit per step; do not combine, reorder or skip steps; do not rewrite what an earlier step already did):
1. Edit lib.mjs: add and export slugify.
2. Edit lib.test.mjs: add at least 3 tests for slugify.
3. Edit lib.mjs: add and export wordFreq.
4. Edit lib.test.mjs: add at least 3 tests for wordFreq.
5. Edit lib.mjs: add and export chunk.
6. Edit lib.test.mjs: add at least 3 tests for chunk.
7. Run \`node --test lib.test.mjs\` and fix any failure.
8. Final answer: the single word DONE and the number of passing tests.

Constraints: only touch lib.mjs and lib.test.mjs; named exports only; do not install anything; do not create other files.`;

export const STEPS = [
  "1. lib.mjs: slugify",
  "2. lib.test.mjs: tests for slugify",
  "3. lib.mjs: wordFreq",
  "4. lib.test.mjs: tests for wordFreq",
  "5. lib.mjs: chunk",
  "6. lib.test.mjs: tests for chunk",
] as const;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });

/** Cria o repositorio de teste (idempotente: apaga e refaz). */
export function setupRepo() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  git(REPO, "config", "user.email", "spike@example.invalid");
  git(REPO, "config", "user.name", "spike");
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "handoff-task", private: true, type: "module" }, null, 2) + "\n");
  writeFileSync(join(REPO, "lib.mjs"), "// Library: slugify, wordFreq, chunk (to be implemented)\n");
  writeFileSync(
    join(REPO, "lib.test.mjs"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport * as lib from "./lib.mjs";\n\n// tests go below\n`,
  );
  git(REPO, "add", "-A");
  git(REPO, "commit", "-q", "-m", "base");
  return git(REPO, "rev-parse", "HEAD").trim();
}

export const baseSha = () => git(REPO, "rev-parse", "main").trim();

/** Worktree nova a partir de um commit/branch. */
export function addWorktree(name: string, from: string) {
  const dir = join(SCRATCH, name);
  git(REPO, "worktree", "add", "-q", "-b", name, dir, from);
  return dir;
}

export function checkpoint(dir: string, msg = "checkpoint") {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", msg);
  return git(dir, "rev-parse", "HEAD").trim();
}

export const diffAgainst = (dir: string, base: string) => git(dir, "diff", base);
export const numstat = (dir: string, base: string) => git(dir, "diff", "--numstat", base).trim();

export type Progress = { done: boolean[]; n: number };
/** Estado por passo, lido dos arquivos (deterministico). */
export function progress(dir: string): Progress {
  const rd = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  const lib = rd("lib.mjs");
  const tst = rd("lib.test.mjs");
  const impl = (n: string) => new RegExp(`export\\s+(async\\s+)?(function\\s+${n}\\b|const\\s+${n}\\b)|export\\s*\\{[^}]*\\b${n}\\b`).test(lib);
  const tests = (n: string) => (tst.match(new RegExp(`\\b${n}\\s*\\(`, "g")) ?? []).length >= 3;
  const done = [impl("slugify"), tests("slugify"), impl("wordFreq"), tests("wordFreq"), impl("chunk"), tests("chunk")];
  return { done, n: done.filter(Boolean).length };
}

function tap(out: string) {
  const g = (k: string) => Number(out.match(new RegExp(`^# ${k} (\\d+)`, "m"))?.[1] ?? NaN);
  return { tests: g("tests"), pass: g("pass"), fail: g("fail") };
}

/** Roda os testes proprios do agente e os de aceite (copiados so durante a avaliacao). */
export function evaluate(dir: string) {
  const run = (file: string) => {
    const r = spawnSync("node", ["--test", "--test-reporter=tap", file], { cwd: dir, encoding: "utf8", timeout: 60000 });
    return { code: r.status, ...tap(r.stdout + r.stderr) };
  };
  const own = run("lib.test.mjs");
  const acc = join(dir, "accept.test.mjs");
  copyFileSync(join(ROOT, "fixtures", "accept.test.mjs"), acc);
  const accept = run("accept.test.mjs");
  rmSync(acc, { force: true });
  const p = progress(dir);
  return { own, accept, steps: p.done, stepsDone: p.n, ok: own.code === 0 && accept.code === 0 && p.n === 6 };
}

export { dirname };
