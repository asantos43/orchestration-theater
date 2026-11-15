#!/usr/bin/env bash
# Roda os tres pares do item 1 em sequencia (cada par: origem + continuacoes min e full).
set -u
cd "$(dirname "$0")/.."
node src/cont.ts codex claude-codex full
node src/origin.ts codex codex-opencode
node src/cont.ts opencode codex-opencode min
node src/cont.ts opencode codex-opencode full
node src/origin.ts opencode opencode-claude
node src/cont.ts claude opencode-claude min
node src/cont.ts claude opencode-claude full
