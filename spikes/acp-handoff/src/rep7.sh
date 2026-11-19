#!/usr/bin/env bash
# Item 6 da Fase 5 (bastao com n maior): leva as 6 direcoes base a n=5 por variante e mede o destino OpenCode com openai/gpt-6-luna.
# Requer SPIKE_SCRATCH com o repo restaurado por restore-origins.ts. Mesmo padrao do rep3.sh; cada continuacao e uma sessao nova.
# Fluxo Y = destinos Claude e Codex (rapidos). Fluxo X = destino OpenCode: flash-lite (o modelo das celulas base) e depois gpt-6-luna (par -luna).
#   uso: SPIKE_SCRATCH=<pasta> ./src/rep7.sh [x|y|todos]
set -u
cd "$(dirname "$0")/.."
: "${SPIKE_SCRATCH:?defina SPIKE_SCRATCH}"
export OT_WATCHDOG_MS="${OT_WATCHDOG_MS:-600000}"
# run <cliente-destino> <par> <origem> <variante> <tag> [modelo-opencode]
run() {
  local cli=$1 pair=$2 origin=$3 v=$4 tag=$5 model=${6:-}
  echo "[$(date +%H:%M:%S)] $cli $pair $v $tag ${model:+model=$model}"
  env OT_ORIGIN=$origin OT_TAG=$tag ${model:+OT_MODEL=$model} timeout -k 10 700 node src/cont.ts "$cli" "$pair" "$v" >/dev/null 2>"out/cont-$pair-$v.$tag.stderr" \
    || echo "  FALHOU/expirou: $cli $pair $v $tag"
  [ -s "out/cont-$pair-$v.$tag.stderr" ] || rm -f "out/cont-$pair-$v.$tag.stderr"
}
fluxo_y() {
  for t in r4 r5; do for v in min full; do run codex claude-codex claude-codex.restored $v $t; done; done
  for t in r4 r5; do for v in min full; do run claude opencode-claude opencode-claude.restored $v $t; done; done
  for t in r3 r4 r5; do for v in min full; do run claude codex-claude codex-opencode.restored $v $t; done; done
  for t in r3 r4 r5; do for v in min full; do run codex opencode-codex opencode-claude.restored $v $t; done; done
  echo "[$(date +%H:%M:%S)] fluxo Y terminou"
}
fluxo_x() {
  for v in min full; do run opencode codex-opencode codex-opencode.restored $v r4; done
  for t in r3 r4 r5; do for v in min full; do run opencode claude-opencode claude-codex.restored $v $t; done; done
  for t in r1 r2 r3 r4 r5; do
    for v in min full; do
      run opencode codex-opencode-luna codex-opencode.restored $v $t openai/gpt-6-luna
      run opencode claude-opencode-luna claude-codex.restored $v $t openai/gpt-6-luna
    done
  done
  echo "[$(date +%H:%M:%S)] fluxo X terminou"
}
case "${1:-todos}" in
  x) fluxo_x ;;
  y) fluxo_y ;;
  *) fluxo_x & fluxo_y & wait ;;
esac
