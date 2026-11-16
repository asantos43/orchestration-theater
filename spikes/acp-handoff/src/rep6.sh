#!/usr/bin/env bash
# Destino OpenCode com modelos free (Zen) e Gemma pelo Google (README, "Destino OpenCode com modelos free"). Par Codex->OpenCode, origem 1.
# Requer SPIKE_SCRATCH com o repo restaurado por restore-origins.ts. Perfil padrao do OpenCode do dono; so OT_MODEL muda (sem OPENCODE_CONFIG_CONTENT).
#   uso: SPIKE_SCRATCH=<pasta> ./src/rep6.sh <modelo> <rotulo> <min|full> <tag> [<min|full> <tag> ...]
#   rotulo = sufixo do par: glm | deepseek | minimax | gemma26 | gemma31 | gpt61sol (vira codex-opencode-<rotulo>; agg.ts rotula)
#   ex.: ./src/rep6.sh opencode/glm-5.3-flash-free glm min r1 full r1
set -u
cd "$(dirname "$0")/.."
: "${SPIKE_SCRATCH:?defina SPIKE_SCRATCH}"
model=${1:?modelo}; label=${2:?rotulo}; shift 2
pair="codex-opencode-$label"
export OT_MODEL="$model" OT_WATCHDOG_MS="${OT_WATCHDOG_MS:-600000}"
while [ $# -ge 2 ]; do
  v=$1 t=$2; shift 2
  echo "[$(date +%H:%M:%S)] opencode $pair $v $t model=$OT_MODEL"
  env OT_ORIGIN=codex-opencode.restored OT_TAG=$t timeout -k 10 700 node src/cont.ts opencode "$pair" "$v" >/dev/null 2>"out/cont-$pair-$v.$t.stderr" \
    || echo "  FALHOU/expirou: $v $t"
  [ -s "out/cont-$pair-$v.$t.stderr" ] || rm -f "out/cont-$pair-$v.$t.stderr"
done
echo "[$(date +%H:%M:%S)] terminou"
