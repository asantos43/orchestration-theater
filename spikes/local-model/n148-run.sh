#!/usr/bin/env bash
# Um modelo por vez: confere `ollama ps` vazio antes de cada avaliação.
HERE="$(cd "$(dirname "$0")" && pwd)"
S="${N148_OUT:-$HERE/out}"; mkdir -p "$S"
W=$HERE
B="${OT_OLLAMA_DIR:-$HOME/.local/opt/ollama-v0.40.16}/bin/ollama"
export OLLAMA_HOST=127.0.0.1:47510
$W/ollama.sh start
loaded() { $B ps | tail -n +2 | grep -c . ; }
for m in gemma4-e4b qwen3:8b qwen3:14b gemma4:12b-it-q4_K_M; do
  case $m in qwen3:14b|gemma4:12b*) timeout 3600 $B pull $m > $S/pull-${m//:/_}.log 2>&1; echo "pull $m exit=$?";; esac
  [ "$(loaded)" = 0 ] || { echo "ABORTA: modelo carregado antes de $m"; $B ps; break; }
  free -h | sed -n 2p
  ( for _ in $(seq 100); do date +%T; $B ps | tail -n +2; free -m | sed -n 2p; timeout 30 tail -f /dev/null; done ) > $S/mon-${m//:/_}.log 2>&1 &
  MON=$!
  timeout 3000 python3 -I "$W/n148-eval.py" $m 4 > $S/eval-${m//:/_}.log 2>&1; echo "$m exit=$?"; tail -1 $S/eval-${m//:/_}.log
  kill $MON 2>/dev/null
  $B ps
done
$W/ollama.sh stop
