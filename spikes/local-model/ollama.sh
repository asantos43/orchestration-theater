#!/usr/bin/env bash
# Ollama local para desenvolvimento e testes do OTheater (2026-11-15).
# Instalação na pasta do usuário, sem sudo e sem serviço do sistema:
#   binário em $OT_OLLAMA_DIR (padrão ~/.local/opt/ollama-v0.40.16), modelos em ~/.ollama/models.
# Escuta só em 127.0.0.1. A iGPU AMD (gfx90c) funciona por Vulkan com OLLAMA_IGPU_ENABLE=1;
# pelo ROCm ela trava ("GPU Hang"), por isso o ROCm fica de fora.
#
# Uso: ./ollama.sh start|stop|status|import
#   import: cria o modelo gemma4-e4b a partir do GGUF local ($OT_GGUF), sem baixar nada.
#   Nesta máquina o modelo já foi importado, e o GGUF do cache foi apagado; o import só serve numa máquina nova.
set -euo pipefail

OLLAMA_DIR="${OT_OLLAMA_DIR:-$HOME/.local/opt/ollama-v0.40.16}"
PORT="${OT_OLLAMA_PORT:-47510}"
# Contexto padrão do servidor. Teto de 32K (dono, 2026-11-19): mais que isso esta máquina não aguenta.
CTX="${OT_CTX:-32768}"
(( CTX >= 512 && CTX <= 32768 )) || { echo "OT_CTX=$CTX fora de 512..32768" >&2; exit 2; }
# Tipo do cache de KV: f16 (padrão do Ollama), q8_0 ou q4_0. Os quantizados cortam a memória do
# contexto pela metade ou por quatro e exigem flash attention, que o script liga junto.
KV_CACHE="${OT_OLLAMA_KV_CACHE:-f16}"
case "$KV_CACHE" in f16|q8_0|q4_0) ;; *) echo "OT_OLLAMA_KV_CACHE=$KV_CACHE: use f16, q8_0 ou q4_0" >&2; exit 2;; esac
FLASH="${OT_OLLAMA_FLASH_ATTENTION:-}"
[[ $KV_CACHE != f16 && -z $FLASH ]] && FLASH=1
# Modelos carregados ao mesmo tempo. Padrão 1 (ordem do dono, 2026-11-19): esta máquina não
# aguenta dois modelos locais juntos; trocar de modelo descarrega o anterior.
MAX_LOADED="${OT_OLLAMA_MAX_LOADED:-1}"
GGUF="${OT_GGUF:-$HOME/.cache/llama.cpp/gemma-4-E4B-it-Q4_0.gguf}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"
PIDF="$OUT/ollama.pid"
LOG="$OUT/ollama-serve.log"
BIN="$OLLAMA_DIR/bin/ollama"
export OLLAMA_HOST="127.0.0.1:$PORT"

mkdir -p "$OUT"
running() { [[ -f $PIDF ]] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }

case "${1:-start}" in
  start)
    if running; then echo "já está rodando, PID $(cat "$PIDF")"; exit 0; fi
    [[ -n $FLASH ]] && export OLLAMA_FLASH_ATTENTION="$FLASH"
    OLLAMA_MODELS="$HOME/.ollama/models" OLLAMA_IGPU_ENABLE=1 OLLAMA_CONTEXT_LENGTH="$CTX" \
      OLLAMA_MAX_LOADED_MODELS="$MAX_LOADED" OLLAMA_NUM_PARALLEL=1 OLLAMA_NO_CLOUD=1 OLLAMA_KEEP_ALIVE=60m \
      OLLAMA_KV_CACHE_TYPE="$KV_CACHE" nohup "$BIN" serve >"$LOG" 2>&1 &
    echo $! >"$PIDF"
    for _ in $(seq 20); do grep -q 'inference compute' "$LOG" && break; sleep 0.5; done
    grep 'inference compute' "$LOG" | sed -E 's/.*(library=[^ ]+).*(description="[^"]*").*/\1 \2/' || true
    echo "cache de KV $KV_CACHE${FLASH:+, flash attention $FLASH}"
    echo "PID $(cat "$PIDF"); API OpenAI em http://$OLLAMA_HOST/v1; log em $LOG"
    ;;
  stop)
    if running; then kill "$(cat "$PIDF")"; rm -f "$PIDF"; echo "parado"; else echo "não está rodando"; fi
    ;;
  status)
    if running; then echo "rodando, PID $(cat "$PIDF")"; "$BIN" list; else echo "parado"; fi
    ;;
  import)
    running || { echo "suba antes com ./ollama.sh start" >&2; exit 1; }
    [[ -f $GGUF ]] || { echo "GGUF não encontrado: $GGUF (defina OT_GGUF)" >&2; exit 1; }
    mf="$(mktemp)"; trap 'rm -f "$mf"' EXIT
    printf 'FROM %s\n' "$GGUF" >"$mf"
    "$BIN" create otheater-gemma4-e4b -f "$mf"
    "$BIN" cp otheater-gemma4-e4b gemma4-e4b   # nome que o run-tasks.ts manda ao servidor
    ;;
  *)
    echo "uso: $0 start|stop|status|import" >&2; exit 2
    ;;
esac
