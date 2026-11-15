#!/usr/bin/env bash
# Repeticoes e pares novos do item 1 (README, "Rodada 2"). Requer SPIKE_SCRATCH com o repo restaurado por restore-origins.ts.
# Dois fluxos em paralelo: X = destino OpenCode (lento), Y = destino Claude/Codex (rapido). Cada continuacao e uma sessao nova.
#   uso: SPIKE_SCRATCH=<pasta> ./src/rep3.sh [x|y|todos]
set -u
cd "$(dirname "$0")/.."
: "${SPIKE_SCRATCH:?defina SPIKE_SCRATCH}"
# run <cliente-destino> <par> <origem> <variante> <tag> [modelo-opencode]
run() {
  local cli=$1 pair=$2 origin=$3 v=$4 tag=$5 model=${6:-}
  echo "[$(date +%H:%M:%S)] $cli $pair $v $tag ${model:+model=$model}"
  env OT_ORIGIN=$origin OT_TAG=$tag ${model:+OT_MODEL=$model} timeout -k 10 700 node src/cont.ts "$cli" "$pair" "$v" >/dev/null 2>"out/cont-$pair-$v.$tag.stderr" \
    || echo "  FALHOU/expirou: $cli $pair $v $tag"
  [ -s "out/cont-$pair-$v.$tag.stderr" ] || rm -f "out/cont-$pair-$v.$tag.stderr"
}
fluxo_y() {
  for t in r2 r3; do for v in min full; do run codex claude-codex claude-codex.restored $v $t; done; done
  for t in r2 r3; do for v in min full; do run claude opencode-claude opencode-claude.restored $v $t; done; done
  for t in r1 r2; do for v in min full; do run claude codex-claude codex-opencode.restored $v $t; done; done
  for t in r1 r2; do for v in min full; do run codex opencode-codex opencode-claude.restored $v $t; done; done
  echo "[$(date +%H:%M:%S)] fluxo Y terminou"
}
fluxo_x() {
  for v in min full; do run opencode codex-opencode codex-opencode.restored $v r3; done
  for t in r1 r2; do for v in min full; do run opencode claude-opencode claude-codex.restored $v $t; done; done
  for t in r1 r2; do for v in min full; do run opencode codex-opencode-g35f codex-opencode.restored $v $t google/gemini-3.5-flash; done; done
  echo "[$(date +%H:%M:%S)] fluxo X terminou"
}
fluxo_modelo() { # so as 4 execucoes com modelo mais forte no OpenCode (reexecucao depois de corrigir o env)
  for t in r1 r2; do for v in min full; do run opencode codex-opencode-g35f codex-opencode.restored $v $t google/gemini-3.5-flash; done; done
  echo "[$(date +%H:%M:%S)] fluxo modelo terminou"
}
case "${1:-todos}" in
  modelo) fluxo_modelo ;;
  x) fluxo_x ;;
  y) fluxo_y ;;
  *) fluxo_x & fluxo_y & wait ;;
esac
