#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Roda o aceite real da Fase 2 (packages/daemon/src/execution/acceptance.real.test.ts) com
# checagens antes e um monitor de memória durante. Feito para o dono rodar (N57): o script nunca
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
#
# Uso:
#   tools/acceptance/real-acceptance.sh [--level clients|prompts] [--dry-run] [--with-adapters]
#       [--build auto|always|never] [--build-timeout DURAÇÃO]
#       [--min-available-mb N] [--abort-below-mb N] [--min-tmp-mb N] [--timeout DURAÇÃO]
#       [--log-dir DIR] [--bin-dir DIR]... [--yes]
#
# Build (--build): o teste lê o `dist` dos pacotes (o Executor simulado e, com --with-adapters, os
# adaptadores), então um `dist` velho dá falha que não é do código. Local e offline (`pnpm build`).
#   auto    (padrão) compila se algum pacote de packages/ (inclui packages/adapters/*) não tem
#           `dist` ou tem arquivo em `src`, `package.json` ou `tsconfig*.json` mais novo que o
#           arquivo mais novo do `dist` dele; senão não faz nada.
#   always  sempre roda `pnpm build`.
#   never   nunca compila; falha se o `dist` do fake-agent não existe e avisa dos pacotes velhos.
# Com --dry-run o script só diz o que faria com o build.
#
# --bin-dir põe DIR na frente do PATH, para achar um adaptador ACP instalado fora dele (por
# exemplo, o node_modules/.bin de um projeto). Pode repetir.
#
# Cada opção também lê uma variável (a opção ganha):
#   OT_ACCEPT_LEVEL (clients), OT_ACCEPT_MIN_AVAILABLE_MB (4096), OT_ACCEPT_ABORT_BELOW_MB (1024),
#   OT_ACCEPT_MIN_TMP_MB (1024), OT_ACCEPT_TIMEOUT (20m), OT_ACCEPT_BUILD (auto),
#   OT_ACCEPT_BUILD_TIMEOUT (10m), OT_ACCEPT_LOG_DIR
#   (${XDG_STATE_HOME:-~/.local/state}/otheater/acceptance), OT_ACCEPT_BIN_DIRS (pastas separadas
#   por ':').

set -euo pipefail

level="${OT_ACCEPT_LEVEL:-clients}"
min_available_mb="${OT_ACCEPT_MIN_AVAILABLE_MB:-4096}"
abort_below_mb="${OT_ACCEPT_ABORT_BELOW_MB:-1024}"
min_tmp_mb="${OT_ACCEPT_MIN_TMP_MB:-1024}"
run_timeout="${OT_ACCEPT_TIMEOUT:-20m}"
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

case "$level" in clients|prompts) ;; *) echo "--level deve ser clients ou prompts" >&2; exit 2 ;; esac
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
declare -A executable=([CLAUDE]=claude-agent-acp [CODEX]=codex-acp [OPENCODE]=opencode)
for key in CLAUDE CODEX OPENCODE; do
  exe="${executable[$key]}"
  if command -v "$exe" >/dev/null 2>&1; then
    clients_found=$((clients_found + 1))
    ok "$exe"
    if [ "$level" = prompts ]; then
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
        warn "  sem $profile_var e $model_var: o teste deixa $exe de fora no nível prompts"
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

# ---- build (decide aqui, compila depois da confirmação) -----------------------------------------

# Pacotes de packages/ com `dist` ausente, vazio ou mais velho que as fontes: um por linha, com o
# motivo. O teste lê o `dist`; um `dist` velho dá falha que não é do código.
stale_packages() {
  local dir newest
  for dir in packages/* packages/adapters/*; do
    [ -f "$dir/package.json" ] || continue
    if [ ! -d "$dir/dist" ]; then echo "$dir (sem dist)"; continue; fi
    newest="$(find "$dir/dist" -type f -printf '%T@ %p\n' | sort -rn | sed -n 1p | cut -d' ' -f2-)"
    if [ -z "$newest" ]; then echo "$dir (dist vazio)"; continue; fi
    if [ -n "$(find "$dir/src" "$dir/package.json" "$dir"/tsconfig*.json -newer "$newest" -print -quit 2>/dev/null)" ]; then
      echo "$dir (fonte mais nova que o dist)"
    fi
  done
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
if [ "$with_adapters" = 1 ]; then
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
echo "Vai rodar: OT_TEST_REAL_CLIENTS=1$([ "$level" = prompts ] && echo ' OT_TEST_REAL_PROMPTS=1') vitest run ${tests[*]}"
case "$build_mode" in
  always) echo "Build: 'pnpm build' antes do teste (--build always; teto de $build_timeout)." ;;
  auto) if [ "$will_build" = 1 ]; then echo "Build: 'pnpm build' antes do teste (--build auto, dist velho; teto de $build_timeout)."; else echo "Build: nada a compilar (--build auto, dist em dia)."; fi ;;
  never) echo "Build: nenhum (--build never)." ;;
esac
echo "Teto: $run_timeout. Aborta se a memória disponível cair abaixo de ${abort_below_mb} MB."
[ "$level" = prompts ] && echo "Atenção: o nível prompts envia prompts reais e gasta cota das contas dos perfis."
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
if [ "$level" = prompts ]; then export OT_TEST_REAL_PROMPTS=1; else unset OT_TEST_REAL_PROMPTS; fi

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
grep -E 'Test Files|Tests |✓|✗|×|FAIL|skipped|left out' "$log" | tail -40 || true
echo
echo "Memória disponível: ${baseline} MB no início, mínimo de ${lowest} MB durante o teste (consumo de pico ≈ $((baseline - lowest)) MB)."
echo "Log completo: $log"
echo "Amostras de memória: $mem_log"
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
