#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Roda o aceite real da Fase 2 (packages/daemon/src/execution/acceptance.real.test.ts) e a medição
# de K e do processModel (k-measure.real.test.ts) com checagens antes e um monitor de memória
# durante. Feito para o dono rodar (N57): o script nunca
# faz login, nunca lê nem imprime credencial e nunca baixa nada. Só Linux: usa /proc/meminfo,
# setsid e o timeout do coreutils (o teste pula no Windows; lá o aceite roda na CI).
#
# Níveis (--level):
#   clients  OT_TEST_REAL_CLIENTS=1. Cada cliente achado no PATH sobe, faz o initialize e abre uma
#            sessão num perfil VAZIO criado pelo teste. Sem prompt.
#   prompts  também OT_TEST_REAL_PROMPTS=1: o critério inteiro (stream, timeout, WIP, sem órfão),
#            com prompts reais que gastam cota. Cada cliente precisa de
#            OT_TEST_<CLIENTE>_PROFILE_DIR (perfil já logado) e OT_TEST_<CLIENTE>_MODEL;
#            OT_TEST_<CLIENTE>_MODE é opcional. <CLIENTE> = CLAUDE, CODEX ou OPENCODE.
#   k        medição de `K` (pool.sessions_per_process) e do processModel, com os clientes reais
#            (k-measure.real.test.ts; não roda o aceite): OT_TEST_REAL_CLIENTS=1,
#            OT_TEST_REAL_PROMPTS=1 e OT_TEST_REAL_MEASURE_K=1. Para cada cliente e cada N em
#            OT_TEST_K_VALUES (padrão 1,2,4,6) abre N sessões no pool do daemon, cada uma num
#            worktree próprio e todas no mesmo perfil, e mede ocioso (processos, RSS e PSS por
#            tipo, lidos de /proc) e com um prompt trivial por sessão, todos de uma vez. Cliente
#            que compartilha processo (Codex, OpenCode) roda cada N maior que 1 duas vezes
#            (`shared`: K=N, um processo; `own`: K=1, N processos); o Claude Code é um processo
#            por sessão e roda uma vez. Os prompts GASTAM COTA: cerca de 13 turnos curtos no
#            Claude Code e 25 em cada um dos outros com os N padrão (o script conta antes de
#            rodar). Pede os mesmos OT_TEST_<CLIENTE>_PROFILE_DIR e _MODEL do nível prompts; sem
#            eles o cliente fica de fora. Teto de 40m (padrão deste nível). O teste pula um N
#            (e os maiores) se MemAvailable < OT_TEST_K_MIN_AVAILABLE_MB (1536). Ajustes do
#            teste, pelo ambiente: OT_TEST_K_VALUES, OT_TEST_K_SETTLE_MS (3000),
#            OT_TEST_K_SAMPLE_MS (250), OT_TEST_K_MIN_AVAILABLE_MB (1536). Saída, na pasta de
#            logs: k-measure-<hora>.tsv, .json e .txt (tabela legível, com as versões dos
#            clientes), além do log e das amostras de memória do script.
#
# Uso:
#   tools/acceptance/real-acceptance.sh [--level clients|prompts|k] [--dry-run] [--with-adapters]
#       [--build auto|always|never] [--build-timeout DURAÇÃO]
#       [--min-available-mb N] [--abort-below-mb N] [--min-tmp-mb N] [--timeout DURAÇÃO]
#       [--log-dir DIR] [--bin-dir DIR]... [--yes]
#
# Build (--build): o teste lê o `dist` dos pacotes (o Executor simulado e, com --with-adapters, os
# adaptadores), então um `dist` velho dá falha que não é do código. Local e offline (`pnpm build`).
#   auto    (padrão) pergunta ao `tsc -b --dry` (não grava nada) e compila se ele construiria
#           algum projeto `tsconfig.src.json`, ou seja, algum `dist`; mudança só em teste
#           (`tsconfig.test.json`, que gera `dist-test`) não conta; senão não faz nada.
#   always  sempre roda `pnpm build`.
#   never   nunca compila; falha se o `dist` do fake-agent não existe e avisa dos pacotes velhos.
# Com --dry-run o script só diz o que faria com o build.
#
# --bin-dir põe DIR na frente do PATH, para achar um adaptador ACP instalado fora dele (por
# exemplo, o node_modules/.bin de um projeto). Pode repetir.
#
# Cada opção também lê uma variável (a opção ganha):
#   OT_ACCEPT_LEVEL (clients), OT_ACCEPT_MIN_AVAILABLE_MB (4096), OT_ACCEPT_ABORT_BELOW_MB (1024),
#   OT_ACCEPT_MIN_TMP_MB (1024), OT_ACCEPT_TIMEOUT (20m; 40m no nível k), OT_ACCEPT_BUILD (auto),
#   OT_ACCEPT_BUILD_TIMEOUT (10m), OT_ACCEPT_LOG_DIR
#   (${XDG_STATE_HOME:-~/.local/state}/otheater/acceptance), OT_ACCEPT_BIN_DIRS (pastas separadas
#   por ':').

set -euo pipefail

level="${OT_ACCEPT_LEVEL:-clients}"
min_available_mb="${OT_ACCEPT_MIN_AVAILABLE_MB:-4096}"
abort_below_mb="${OT_ACCEPT_ABORT_BELOW_MB:-1024}"
min_tmp_mb="${OT_ACCEPT_MIN_TMP_MB:-1024}"
run_timeout="${OT_ACCEPT_TIMEOUT:-}"
build_mode="${OT_ACCEPT_BUILD:-auto}"
build_timeout="${OT_ACCEPT_BUILD_TIMEOUT:-10m}"
log_dir="${OT_ACCEPT_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/otheater/acceptance}"
dry_run=0
with_adapters=0
assume_yes=0
bin_dirs="${OT_ACCEPT_BIN_DIRS:-}"

usage() { awk 'NR >= 3 && /^#/ { sub(/^# ?/, ""); print; next } NR >= 3 { exit }' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --level) level="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --with-adapters) with_adapters=1; shift ;;
    --min-available-mb) min_available_mb="$2"; shift 2 ;;
    --abort-below-mb) abort_below_mb="$2"; shift 2 ;;
    --min-tmp-mb) min_tmp_mb="$2"; shift 2 ;;
    --timeout) run_timeout="$2"; shift 2 ;;
    --build) build_mode="$2"; shift 2 ;;
    --build-timeout) build_timeout="$2"; shift 2 ;;
    --log-dir) log_dir="$2"; shift 2 ;;
    --bin-dir) bin_dirs="${bin_dirs:+$bin_dirs:}$2"; shift 2 ;;
    --yes|-y) assume_yes=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$level" in clients|prompts|k) ;; *) echo "--level deve ser clients, prompts ou k" >&2; exit 2 ;; esac
# O teto padrão do nível k é maior: são várias células, cada uma com N sessões e turnos reais.
if [ -z "$run_timeout" ]; then
  if [ "$level" = k ]; then run_timeout=40m; else run_timeout=20m; fi
fi
case "$build_mode" in auto|always|never) ;; *) echo "--build deve ser auto, always ou never" >&2; exit 2 ;; esac
for n in "$min_available_mb" "$abort_below_mb" "$min_tmp_mb"; do
  case "$n" in ''|*[!0-9]*) echo "valor numérico inválido: $n" >&2; exit 2 ;; esac
done

if [ "$(uname -s)" != Linux ] || [ ! -r /proc/meminfo ]; then
  echo "este script é só para Linux" >&2
  exit 2
fi

# As pastas do --bin-dir valem a partir de onde o script foi chamado.
if [ -n "$bin_dirs" ]; then
  IFS=: read -r -a extra <<<"$bin_dirs"
  for dir in "${extra[@]}"; do
    [ -d "$dir" ] || { echo "--bin-dir: $dir não é uma pasta" >&2; exit 2; }
    PATH="$(cd "$dir" && pwd):$PATH"
  done
  export PATH
fi

# A pasta dos logs também vale a partir de onde o script foi chamado.
mkdir -p "$log_dir"
log_dir="$(cd "$log_dir" && pwd)"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

ok() { printf '  [ok]    %s\n' "$*"; }
warn() { printf '  [aviso] %s\n' "$*"; }
fail() { printf '  [falha] %s\n' "$*"; failures=$((failures + 1)); }
failures=0

# ---- memória e disco ----------------------------------------------------------------------------

# MemAvailable em MB.
available_mb() { awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo; }

swap_free_mb() { awk '/^SwapFree:/ { printf "%d", $2 / 1024 }' /proc/meminfo; }

tmp_dir="${TMPDIR:-/tmp}"
tmp_free_mb() { df -Pm "$tmp_dir" | awk 'NR == 2 { print $4 }'; }

echo "Aceite real da Fase 2 — nível: $level"
echo
echo "Recursos:"
avail="$(available_mb)"
if [ "$avail" -ge "$min_available_mb" ]; then
  ok "memória disponível: ${avail} MB (mínimo ${min_available_mb} MB)"
else
  fail "memória disponível: ${avail} MB, abaixo do mínimo de ${min_available_mb} MB"
fi
swapf="$(swap_free_mb)"
if [ "$swapf" -lt 1024 ]; then
  warn "swap livre: ${swapf} MB. Com pouca swap, um pico fora do teste pode acionar o OOM killer; evite outra carga pesada durante o aceite"
else
  ok "swap livre: ${swapf} MB"
fi
tmpf="$(tmp_free_mb)"
if [ "$tmpf" -ge "$min_tmp_mb" ]; then
  ok "espaço livre em $tmp_dir: ${tmpf} MB (mínimo ${min_tmp_mb} MB)"
else
  fail "espaço livre em $tmp_dir: ${tmpf} MB, abaixo do mínimo de ${min_tmp_mb} MB"
fi

# ---- ferramentas --------------------------------------------------------------------------------

echo
echo "Ferramentas:"
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" -ge 24 ]; then ok "node $(node --version)"; else fail "node $(node --version): precisa de 24 ou mais"; fi
else
  fail "node não está no PATH"
fi
for tool in pnpm git timeout; do
  if command -v "$tool" >/dev/null 2>&1; then ok "$tool"; else fail "$tool não está no PATH"; fi
done
if [ -d node_modules ]; then ok "node_modules presente"; else fail "falta node_modules: rode 'pnpm install --frozen-lockfile'"; fi

# ---- clientes (só procura no PATH; não executa nenhum) ------------------------------------------

echo
echo "Clientes no PATH (sem executar):"
clients_found=0
clients_ready=0
k_left_out=()
declare -A executable=([CLAUDE]=claude-agent-acp [CODEX]=codex-acp [OPENCODE]=opencode)
for key in CLAUDE CODEX OPENCODE; do
  exe="${executable[$key]}"
  if command -v "$exe" >/dev/null 2>&1; then
    clients_found=$((clients_found + 1))
    ok "$exe"
    if [ "$level" = prompts ] || [ "$level" = k ]; then
      profile_var="OT_TEST_${key}_PROFILE_DIR"
      model_var="OT_TEST_${key}_MODEL"
      mode_var="OT_TEST_${key}_MODE"
      profile="${!profile_var:-}"
      model="${!model_var:-}"
      if [ -n "$profile" ] && [ -n "$model" ]; then
        if [ -d "$profile" ]; then
          clients_ready=$((clients_ready + 1))
          ok "  $profile_var definida (pasta existe), $model_var=$model${!mode_var:+, $mode_var=${!mode_var}}"
        else
          fail "  $profile_var aponta para uma pasta que não existe"
        fi
      else
        warn "  sem $profile_var e $model_var: o teste deixa $exe de fora no nível $level"
        k_left_out+=("$key")
      fi
    fi
  else
    warn "$exe não está no PATH: o teste o deixa de fora"
  fi
done
[ "$clients_found" -gt 0 ] || fail "nenhum cliente no PATH: o aceite não tem o que testar"
if [ "$level" = prompts ] && [ "$clients_found" -gt 0 ] && [ "$clients_ready" -eq 0 ]; then
  fail "nenhum cliente com perfil e modelo: no nível prompts só o Executor simulado rodaria"
fi
if [ "$level" = k ] && [ "$clients_found" -gt 0 ] && [ "$clients_ready" -eq 0 ]; then
  fail "nenhum cliente com perfil e modelo: no nível k não haveria o que medir"
fi
if [ "$level" = k ] && [ -n "${OT_TEST_K_VALUES:-}" ]; then
  case "$OT_TEST_K_VALUES" in
    *[!0-9,\ ]*|'') fail "OT_TEST_K_VALUES deve ser uma lista de inteiros separados por vírgula: $OT_TEST_K_VALUES" ;;
  esac
fi

# ---- build (decide aqui, compila depois da confirmação) -----------------------------------------

# Pacotes cujo `dist` o build mudaria, um por linha: o que o `tsc -b --dry` diz que construiria,
# fora os projetos de teste (`tsconfig.test.json` gera `dist-test`, que o teste não lê). Quem
# decide é o próprio `tsc`, com as regras de `include`/`exclude` de cada pacote; um `touch` sem
# mudança de conteúdo não conta. Se o `tsc` falhar, compila (o build mostra o erro).
stale_packages() {
  local out
  if ! out="$(timeout 120 pnpm exec tsc -b --dry 2>&1)"; then
    echo "(tsc -b --dry falhou: compila para ver o erro)"
    return
  fi
  grep -o "would build project '[^']*'" <<<"$out" \
    | sed "s/^would build project '//; s/'\$//" \
    | grep -v '/tsconfig\.test\.json$' \
    | sed "s|^$PWD/||; s|/tsconfig[^/]*\.json\$||" \
    | sort -u || true
}

echo
echo "Build (--build $build_mode):"
will_build=0
stale=()
if [ "$build_mode" != always ]; then
  mapfile -t stale < <(stale_packages)
fi
case "$build_mode" in
  always)
    will_build=1
    ok "vai rodar 'pnpm build' (--build always)"
    ;;
  auto)
    if [ "${#stale[@]}" -gt 0 ]; then
      will_build=1
      ok "vai rodar 'pnpm build': ${#stale[@]} pacote(s) com dist ausente ou velho"
      printf '            %s\n' "${stale[@]}"
    else
      ok "dist em dia em todos os pacotes: não precisa compilar"
    fi
    ;;
  never)
    if [ "${#stale[@]}" -gt 0 ]; then
      warn "--build never: ${#stale[@]} pacote(s) com dist ausente ou velho (o teste lê o dist)"
      printf '            %s\n' "${stale[@]}"
    else
      ok "dist em dia em todos os pacotes"
    fi
    if [ ! -f packages/fake-agent/dist/cli.js ]; then
      fail "--build never e falta packages/fake-agent/dist/cli.js: rode 'pnpm build' ou use --build auto"
    fi
    ;;
esac

# ---- resumo antes de rodar ----------------------------------------------------------------------

tests=(packages/daemon/src/execution/acceptance.real.test.ts)
if [ "$level" = k ]; then
  tests=(packages/daemon/src/execution/k-measure.real.test.ts)
  [ "$with_adapters" = 0 ] || warn "--with-adapters não vale no nível k: roda só a medição de K"
elif [ "$with_adapters" = 1 ]; then
  tests+=(packages/adapters/client-claude-code/src/claude-code.real.test.ts
          packages/adapters/client-codex/src/codex.real.test.ts
          packages/adapters/client-opencode/src/opencode.real.test.ts)
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "Checagens: $failures falha(s). Nada foi rodado."
  exit 1
fi
echo "Checagens: tudo certo."
echo "Vai rodar: OT_TEST_REAL_CLIENTS=1$([ "$level" != clients ] && echo ' OT_TEST_REAL_PROMPTS=1')$([ "$level" = k ] && echo ' OT_TEST_REAL_MEASURE_K=1') vitest run ${tests[*]}"
case "$build_mode" in
  always) echo "Build: 'pnpm build' antes do teste (--build always; teto de $build_timeout)." ;;
  auto) if [ "$will_build" = 1 ]; then echo "Build: 'pnpm build' antes do teste (--build auto, dist velho; teto de $build_timeout)."; else echo "Build: nada a compilar (--build auto, dist em dia)."; fi ;;
  never) echo "Build: nenhum (--build never)." ;;
esac
echo "Teto: $run_timeout. Aborta se a memória disponível cair abaixo de ${abort_below_mb} MB."
[ "$level" = prompts ] && echo "Atenção: o nível prompts envia prompts reais e gasta cota das contas dos perfis."
if [ "$level" = k ]; then
  echo "Atenção: o nível k envia prompts reais (curtos, sem ferramentas) e gasta cota das contas dos perfis."
  # Um turno por sessão e por célula; mesmo plano do teste (planCells): N=1 uma célula; N>1 duas
  # nos clientes que compartilham processo (shared e own) e uma no Claude Code.
  k_values="${OT_TEST_K_VALUES:-1,2,4,6}"
  for key in CLAUDE CODEX OPENCODE; do
    command -v "${executable[$key]}" >/dev/null 2>&1 || continue
    case " ${k_left_out[*]:-} " in *" $key "*) continue ;; esac
    turns=0
    IFS=, read -r -a ns <<<"${k_values// /}"
    for n in "${ns[@]}"; do
      if [ "$n" -le 1 ]; then turns=$((turns + 1))
      elif [ "$key" = CLAUDE ]; then turns=$((turns + n))
      else turns=$((turns + 2 * n)); fi
    done
    echo "  $key: ~$turns prompts (N = ${k_values// /})"
  done
  echo "Saída: $log_dir/k-measure-<hora>.tsv, .json e .txt"
fi
if [ "$dry_run" = 1 ]; then
  echo "--dry-run: parando aqui."
  exit 0
fi
if [ "$assume_yes" != 1 ]; then
  if [ ! -t 0 ]; then echo "sem terminal para confirmar: use --yes" >&2; exit 1; fi
  read -r -p "Rodar agora? [s/N] " answer
  case "$answer" in s|S|sim|Sim|y|Y) ;; *) echo "Cancelado."; exit 0 ;; esac
fi

# ---- build (local, offline) ---------------------------------------------------------------------

if [ "$will_build" = 1 ]; then
  echo
  echo "Compilando ('pnpm build', teto de $build_timeout)..."
  if ! timeout --kill-after=30s "$build_timeout" pnpm build; then
    echo "Resultado: o build falhou ou estourou o teto de $build_timeout. O teste não foi rodado." >&2
    exit 1
  fi
fi

# ---- execução com monitor de memória ------------------------------------------------------------

mkdir -p "$log_dir"
stamp="$(date +%Y%m%d-%H%M%S)"
log="$log_dir/real-acceptance-$level-$stamp.log"
mem_log="$log_dir/real-acceptance-$level-$stamp.mem.tsv"
printf 'hora\tdisponivel_mb\tswap_livre_mb\n' >"$mem_log"

export OT_TEST_REAL_CLIENTS=1
if [ "$level" = prompts ] || [ "$level" = k ]; then export OT_TEST_REAL_PROMPTS=1; else unset OT_TEST_REAL_PROMPTS; fi
if [ "$level" = k ]; then
  export OT_TEST_REAL_MEASURE_K=1
  # O teste grava k-measure-<stamp>.* na pasta de logs, com o mesmo carimbo deste log.
  export OT_TEST_K_OUT_DIR="$log_dir" OT_TEST_K_STAMP="$stamp"
else
  unset OT_TEST_REAL_MEASURE_K
fi

baseline="$(available_mb)"
# setsid põe o teste num grupo de processos próprio: o aborto mata só esse grupo, nada mais.
setsid timeout --kill-after=30s "$run_timeout" pnpm exec vitest run "${tests[@]}" >"$log" 2>&1 &
runner=$!
pgid="$runner"

aborted=0
lowest="$baseline"
while kill -0 "$runner" 2>/dev/null; do
  now="$(available_mb)"
  printf '%s\t%s\t%s\n' "$(date +%H:%M:%S)" "$now" "$(swap_free_mb)" >>"$mem_log"
  [ "$now" -lt "$lowest" ] && lowest="$now"
  if [ "$now" -lt "$abort_below_mb" ]; then
    echo "Memória disponível em ${now} MB, abaixo de ${abort_below_mb} MB: abortando o teste."
    kill -TERM -- "-$pgid" 2>/dev/null || true
    sleep 10
    kill -KILL -- "-$pgid" 2>/dev/null || true
    aborted=1
    break
  fi
  sleep 2
done
set +e
wait "$runner"
status=$?
set -e

echo
grep -E 'Test Files|Tests |✓|✗|×|FAIL|skipped|left out|\[k-measure\]' "$log" | tail -60 || true
echo
echo "Memória disponível: ${baseline} MB no início, mínimo de ${lowest} MB durante o teste (consumo de pico ≈ $((baseline - lowest)) MB)."
echo "Log completo: $log"
echo "Amostras de memória: $mem_log"
if [ "$level" = k ]; then
  echo "Medição de K: $log_dir/k-measure-$stamp.tsv (.json e .txt na mesma pasta)"
  if [ -f "$log_dir/k-measure-$stamp.txt" ]; then
    echo
    cat "$log_dir/k-measure-$stamp.txt"
  fi
fi
if [ "$aborted" = 1 ]; then
  echo "Resultado: ABORTADO por falta de memória."
  exit 3
elif [ "$status" = 124 ] || [ "$status" = 137 ]; then
  echo "Resultado: estourou o teto de $run_timeout."
  exit "$status"
elif [ "$status" != 0 ]; then
  echo "Resultado: FALHOU (código $status)."
  exit "$status"
fi
echo "Resultado: passou."
