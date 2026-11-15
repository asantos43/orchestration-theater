#!/usr/bin/env bash
# Segunda repeticao das continuacoes do par codex-opencode (OpenCode como destino; foi o unico com falha e o mais lento).
set -u
cd "$(dirname "$0")/.."
S=${SCRATCH:?}
for v in min full; do
  n=cont-codex-opencode-$v
  git -C "$S/repo" worktree remove --force "$S/$n" 2>/dev/null; git -C "$S/repo" branch -D "$n" >/dev/null 2>&1
  for ext in json wire.jsonl; do [ -f out/$n.$ext ] && mv out/$n.$ext out/$n.r1.$ext; done
  mv out/package-codex-opencode-$v.md out/package-codex-opencode-$v.r1.md 2>/dev/null
  node src/cont.ts opencode codex-opencode $v
  for ext in json wire.jsonl; do [ -f out/$n.$ext ] && cp out/$n.$ext out/$n.r2.$ext; done
done
