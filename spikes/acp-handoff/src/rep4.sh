#!/usr/bin/env bash
# Continuacoes a partir da SEGUNDA origem de cada par (origin2.sh): mede a variacao da origem. n=2 por variante.
#   uso: SPIKE_SCRATCH=<pasta> ./src/rep4.sh [rapido|lento]   (rapido = destinos Codex e Claude; lento = destino OpenCode)
set -u
cd "$(dirname "$0")/.."
: "${SPIKE_SCRATCH:?defina SPIKE_SCRATCH}"
run() {
  local cli=$1 pair=$2 origin=$3 v=$4 tag=$5
  echo "[$(date +%H:%M:%S)] $cli $pair $v $tag"
  OT_ORIGIN=$origin OT_TAG=$tag timeout -k 10 700 node src/cont.ts "$cli" "$pair" "$v" >/dev/null 2>"out/cont-$pair-$v.$tag.stderr" || echo "  FALHOU/expirou: $cli $pair $v $tag"
  [ -s "out/cont-$pair-$v.$tag.stderr" ] || rm -f "out/cont-$pair-$v.$tag.stderr"
}
case "${1:-rapido}" in
  rapido)
    for t in r1 r2; do for v in min full; do run codex claude-codex-o2 claude-codex-o2 $v $t; done; done
    for t in r1 r2; do for v in min full; do run claude opencode-claude-o2 opencode-claude-o2 $v $t; done; done ;;
  lento)
    for t in r1 r2; do for v in min full; do run opencode codex-opencode-o2 codex-opencode-o2 $v $t; done; done ;;
esac
echo "[$(date +%H:%M:%S)] rep4 $1 terminou"
