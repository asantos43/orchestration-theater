#!/usr/bin/env bash
# Destino OpenCode com o modelo local Gemma 4 E4B no Ollama (README, "Destino OpenCode com modelo local"). Par Codex->OpenCode, origem 1.
# Requer SPIKE_SCRATCH com o repo restaurado por restore-origins.ts e o Ollama no ar (spikes/local-model/ollama.sh start; porta 47510, ctx 32768).
# O OpenCode usa o perfil padrao do dono (mesmas ferramentas do bastao com o Gemini); so o provedor local e acrescentado, por
# OPENCODE_CONFIG_CONTENT (herdado pelo processo filho; o acp.ts nao mudou). O raciocinio fica no padrao do Ollama (ligado).
#   uso: SPIKE_SCRATCH=<pasta> ./src/rep5.sh <min|full> <tag> [<min|full> <tag> ...]   ex.: ./src/rep5.sh min r1 full r1 min r2 full r2
set -u
cd "$(dirname "$0")/.."
: "${SPIKE_SCRATCH:?defina SPIKE_SCRATCH}"
PORT="${OT_OLLAMA_PORT:-47510}"
export OPENCODE_CONFIG_CONTENT="{\"\$schema\":\"https://opencode.ai/config.json\",\"provider\":{\"local\":{\"npm\":\"@ai-sdk/openai-compatible\",\"name\":\"Ollama (local)\",\"options\":{\"baseURL\":\"http://127.0.0.1:$PORT/v1\",\"apiKey\":\"none\"},\"models\":{\"gemma4-e4b\":{\"name\":\"Gemma 4 E4B (Q4_0)\",\"tool_call\":true,\"reasoning\":false,\"limit\":{\"context\":32768,\"output\":4096}}}}}}"
export OT_MODEL=local/gemma4-e4b OT_WATCHDOG_MS="${OT_WATCHDOG_MS:-1500000}"
while [ $# -ge 2 ]; do
  v=$1 t=$2; shift 2
  echo "[$(date +%H:%M:%S)] opencode codex-opencode-gemma $v $t model=$OT_MODEL"
  env OT_ORIGIN=codex-opencode.restored OT_TAG=$t timeout -k 10 1600 node src/cont.ts opencode codex-opencode-gemma "$v" >/dev/null 2>"out/cont-codex-opencode-gemma-$v.$t.stderr" \
    || echo "  FALHOU/expirou: $v $t"
  [ -s "out/cont-codex-opencode-gemma-$v.$t.stderr" ] || rm -f "out/cont-codex-opencode-gemma-$v.$t.stderr"
done
echo "[$(date +%H:%M:%S)] terminou"
