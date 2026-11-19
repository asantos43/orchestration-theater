#!/usr/bin/env bash
# Diretor com qwen3:14b e contexto de 32K cheio (pedido do dono, 2026-11-19). Um modelo só.
# Cache de KV q8_0 para caber em 12 GB; um vigia descarrega o modelo se o `ollama ps` passar de 12 GB.
HERE="$(cd "$(dirname "$0")" && pwd)"
S="${N148_OUT:-$HERE/out}"; mkdir -p "$S"
W=$HERE
B="${OT_OLLAMA_DIR:-$HOME/.local/opt/ollama-v0.40.16}/bin/ollama"
M=qwen3:14b
export OLLAMA_HOST=127.0.0.1:47510
# Servidor já no ar subiu sem o cache q8_0: não reaproveita.
$W/ollama.sh status | grep -q '^parado' || { echo "ABORTA: Ollama já está no ar"; exit 1; }
OT_OLLAMA_KV_CACHE=q8_0 $W/ollama.sh start
[ "$($B ps | tail -n +2 | grep -c .)" = 0 ] || { echo "ABORTA: já há modelo carregado"; $B ps; $W/ollama.sh stop; exit 1; }
free -h | sed -n 2p
BASE=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo); echo "base disponível ${BASE} MB"
NUM_CTX=32768 HISTORY_TOKENS=22000 timeout 7200 python3 -I "$W/n148-eval.py" $M 2 > $S/eval-32k.log 2>&1 &
EVAL=$!
(
  # O `ollama ps` erra o tamanho nesta iGPU (memória unificada): o vigia mede a queda do MemAvailable
  # desde antes da carga. Queda acima de 12 GB = modelo fora do limite do dono; descarrega e para.
  for _ in $(seq 1800); do
    av=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo); drop=$((BASE - av))
    echo "$(date +%T) disponível ${av} MB, queda ${drop} MB | $($B ps | tail -n +2 | head -1)"
    if [ "$drop" -gt 12288 ]; then
      echo "VIGIA: queda de ${drop} MB > 12 GB, descarregando"
      echo "ABORTADO-12GB queda ${drop} MB" > $S/vigia-32k.flag
      kill $EVAL 2>/dev/null
      curl -s -m 60 http://127.0.0.1:47510/api/generate -d "{\"model\":\"$M\",\"keep_alive\":0}" >/dev/null
      break
    fi
    timeout 5 tail -f /dev/null
  done
) > $S/mon-32k.log 2>&1 &
MON=$!
wait $EVAL; echo "eval exit=$?"
kill $MON 2>/dev/null
tail -1 $S/eval-32k.log; cat $S/vigia-32k.flag 2>/dev/null
$B ps
$W/ollama.sh stop
