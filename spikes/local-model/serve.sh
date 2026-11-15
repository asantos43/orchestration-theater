#!/usr/bin/env bash
# Sobe o llama-server na porta 47500, só CPU, e grava o PID em out/llama.pid.
# OBSOLETO desde 2026-11-15: o pacote llama-cpp do Fedora foi removido; use ./ollama.sh.
# `--device none` é necessário: o backend ROCm do pacote trava a GPU (gfx90c) e derruba o processo (ver README).
# Uso: ./serve.sh [ctx=32768] [extra...]
set -euo pipefail
cd "$(dirname "$0")"
CTX="${1:-32768}"; shift 1 2>/dev/null || true
MODEL="${OT_GGUF:-$HOME/.cache/llama.cpp/gemma-4-E4B-it-Q4_0.gguf}"
LOG="out/llama-server.log"
# Esconde a GPU do runtime ROCm neste processo: mesmo com --device none, o servidor morreu com "HW Exception ... GPU Hang" numa corrida anterior (causa [N], ver README).
export ROCR_VISIBLE_DEVICES=-1 HIP_VISIBLE_DEVICES=-1
nohup llama-server -m "$MODEL" --jinja --host 127.0.0.1 --port 47500 -c "$CTX" -np 1 --device none --metrics --no-mmproj -t "${OT_THREADS:-6}" --reasoning "${OT_REASONING:-off}" "$@" > "$LOG" 2>&1 &
echo $! > out/llama.pid
echo "pid $(cat out/llama.pid), log $LOG"
