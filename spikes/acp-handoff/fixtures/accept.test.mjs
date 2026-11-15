// Testes de aceite ocultos: ficam fora da worktree dos agentes; o harness copia para a worktree so na hora de avaliar.
import test from "node:test";
import assert from "node:assert/strict";
import { slugify, wordFreq, chunk } from "./lib.mjs";

test("slugify basico", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Olá, Mundo!  "), "ola-mundo");
  assert.equal(slugify("a---b___c"), "a-b-c");
  assert.equal(slugify(""), "");
  assert.equal(slugify("Crème Brûlée 2026"), "creme-brulee-2026");
  assert.equal(slugify("--x--"), "x");
  assert.equal(slugify("!!!"), "");
});

test("wordFreq ordena por contagem desc e palavra asc", () => {
  assert.deepEqual(wordFreq("the cat the dog"), [["the", 2], ["cat", 1], ["dog", 1]]);
  assert.deepEqual(wordFreq("B a b A"), [["a", 2], ["b", 2]]);
  assert.deepEqual(wordFreq(""), []);
});

test("wordFreq: palavra = sequencia de letras/digitos Unicode", () => {
  assert.deepEqual(wordFreq("it's"), [["it", 1], ["s", 1]]);
  assert.deepEqual(wordFreq("Olá olá, OLÁ!"), [["olá", 3]]);
  assert.deepEqual(wordFreq("x1 x1 y"), [["x1", 2], ["y", 1]]);
});

test("chunk", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
  assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]]);
});

test("chunk valida size e nao muda a entrada", () => {
  for (const bad of [0, -1, 1.5, "2", NaN, undefined]) assert.throws(() => chunk([1], bad), RangeError);
  const a = [1, 2, 3];
  chunk(a, 2);
  assert.deepEqual(a, [1, 2, 3]);
});
