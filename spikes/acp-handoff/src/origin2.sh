#!/usr/bin/env bash
# Segunda origem de cada par (variacao da origem). Requer SPIKE_SCRATCH com o repo restaurado.
set -u
cd "$(dirname "$0")/.."
: "${SPIKE_SCRATCH:?defina SPIKE_SCRATCH}"
for p in "claude claude-codex-o2" "codex codex-opencode-o2" "opencode opencode-claude-o2"; do
  set -- $p
  timeout -k 10 300 node src/origin.ts "$1" "$2" > "out/origin-$2.stdout" 2>&1 || echo "FALHOU $2"
  echo "$2 ok"
done
