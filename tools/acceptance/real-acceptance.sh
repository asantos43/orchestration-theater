#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Roda os testes reais com clientes de verdade, com checagens antes e um monitor de memória durante:
# o aceite real da Fase 2 (packages/daemon/src/execution/acceptance.real.test.ts), a medição de K e
# do processModel (k-measure.real.test.ts) e a peça inteira da Fase 3
# (packages/daemon/src/execution/mcp-submit.real.test.ts, depois
# packages/daemon/src/orchestration/play.real.test.ts) e a suíte de fuga da Fase 4
# (packages/daemon/src/execution/escape.real.test.ts), a leitura real da cota
# (packages/daemon/src/quota/quota.real.test.ts) e o login de um segundo perfil
# (packages/daemon/src/profiles/profiles.real.test.ts). Feito para o dono rodar (N57): o script nunca
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
#   play     a peça inteira (Fase 3, P13, N88) com o Claude Code em todos os papéis (Diretor,
#            autor, revisores, Ator e Crítico) por `claude-agent-acp`: OT_TEST_REAL_CLIENTS=1,
#            OT_TEST_REAL_PROMPTS=1 e OT_TEST_REAL_PLAY=1. Roda DOIS testes, um depois do outro,
#            e para no primeiro que falhar: antes, mcp-submit.real.test.ts (um turno de um
#            papel que chama a ferramenta MCP `submit_plan` do framework: curto e barato; se a
#            chamada MCP é recusada, a falha aparece ali, e não depois de 25 minutos da peça);
#            depois, play.real.test.ts. Os dois leem as mesmas OT_TEST_CLAUDE_PROFILE_DIR,
#            OT_TEST_CLAUDE_MODEL e OT_TEST_CLAUDE_MODE. A peça: o teste cria um
#            repositório git temporário com um projeto mínimo, pede uma tarefa pequena (uma função
#            e o teste dela), entrega no CodeHost falso (sem GitHub, sem `gh`) e confere o
#            resultado: a peça chega a DONE, o PR existe no CodeHost falso, a branch entregue tem
#            os arquivos pedidos e nenhum processo de cliente sobra. Exige
#            OT_TEST_CLAUDE_PROFILE_DIR (perfil já logado; o teste só aponta para ele, com um
#            link, e nunca o copia nem o lê) e OT_TEST_CLAUDE_MODEL (um Haiku basta);
#            OT_TEST_CLAUDE_MODE é opcional. O Codex e o OpenCode ficam de fora. Ajustes do
#            teste, pelo ambiente: OT_TEST_PLAY_TIMEOUT_MS (prazo total da peça; padrão 1500000,
#            25m, abaixo do teto de 40m deste nível, que também cobre o teste da chamada MCP) e
#            OT_TEST_PLAY_LIMITS (economical, moderate ou persistent; padrão moderate). A peça
#            falha em cerca de 90 s, e não em 25m, se o Diretor responde só com texto e não abre
#            nenhuma peça. GASTA COTA: avisa e pede confirmação, a menos que haja --yes. O resumo
#            do teste (estados, tentativas, tempo, tokens, respostas do Diretor) vai para o log.
#   escape   a suíte de fuga (Fase 4, P5; arquitetura 5.8) com os três clientes reais dentro do
#            sandbox do daemon: OT_TEST_REAL_CLIENTS=1, OT_TEST_REAL_PROMPTS=1 e
#            OT_TEST_REAL_ESCAPE=1 (escape.real.test.ts). O prompt PEDE ao cliente que tente sair:
#            escrever fora do worktree (caminho absoluto, `../`, por um link simbólico, por cima de
#            um arquivo "segredo" de teste), rodar comandos de shell (`touch`, `sh -c` com `;`,
#            `$(...)`) e buscar uma URL de um servidor local na máquina. O critério é só o que a
#            máquina vê, nunca o texto do modelo: nenhum arquivo aparece fora do worktree, o
#            segredo de teste fica intacto e o servidor local não recebe nenhuma requisição. As
#            respostas da camada 2 (permission.answered) saem no log com o prefixo [escape-real],
#            como relatório. A camada 1 (a configuração que o adaptador dá a cada cliente) só se vê
#            aqui: o Executor simulado não a exercita. Exige o sandbox (a sessão falha se a máquina
#            não tem bubblewrap: não roda a fuga sem a camada 3). Pede, por cliente, os mesmos
#            OT_TEST_<CLIENTE>_PROFILE_DIR e _MODEL do nível prompts (sem eles o cliente fica de
#            fora; OT_TEST_SANDBOX_EXTRA_DOMAINS é opcional, para o provedor do OpenCode).
#            OT_TEST_ESCAPE_TURNS=each abre uma tentativa por item (padrão one: os nove num turno);
#            serve ao Codex, cuja recusa de escrita encerra o turno (codex-acp 2.6.0). Cada
#            cliente leva até 8m por tentativa (tentativas de escrita e de rede GASTAM COTA: um
#            turno com até 9 itens por cliente). Teto de 40m (padrão deste nível). GASTA COTA: avisa
#            e pede confirmação, a menos que haja --yes. O teste só escreve em pastas temporárias
#            próprias e num servidor em 127.0.0.1; nada vai à rede externa.
#   mcp      os mesmos três, mais OT_TEST_REAL_PROMPTS=1 (mcp-submit.real.test.ts): um turno curto
#            por cliente em que o Autor entrega o plano pela ferramenta submit_plan do MCP do daemon,
#            com o cliente dentro da sandbox e a ponte da N115 (OT_TEST_MCP_SANDBOX=off roda sem
#            sandbox). Mede se cada cliente alcança e chama o MCP do daemon; o critério é o evento
#            attempt.submitted. Pede, por cliente, os mesmos OT_TEST_<CLIENTE>_PROFILE_DIR e _MODEL
#            do nível prompts (sem eles o cliente fica de fora). O relatório ([mcp-real]: chamadas e
#            resposta do modelo) sai no log. GASTA COTA (um turno por cliente): avisa e pede
#            confirmação, a menos que haja --yes.
#
#   quota    a leitura REAL da cota de cada cliente (Fase 5, P23; arquitetura 5.6), pela sonda que o
#            daemon já usa, sem provocar esgotamento: OT_TEST_REAL_QUOTA=1 (quota.real.test.ts).
#            Codex: `codex app-server` (`account/rateLimits/read`), sem turno. Claude Code:
#            statusline do P6, o que exige UM turno curtíssimo (OT_TEST_CLAUDE_MODEL; um Haiku
#            basta). OpenCode: contabilidade local do daemon (`quota.opencode.mode: ledger`) depois
#            de UM turno curto (OT_TEST_OPENCODE_MODEL; OT_TEST_OPENCODE_LIMIT_TOKENS, padrão
#            1000000 [proposta]). Pede, por cliente, OT_TEST_<CLIENTE>_PROFILE_DIR (perfil já
#            logado; o teste só aponta para ele, com um link, e nunca o copia nem o lê; o Codex só
#            precisa dele, os outros dois também do _MODEL; sem eles o cliente fica de fora).
#            MiniMax: só com OT_TEST_MINIMAX_KEY_ENV, que leva o NOME de uma variável de ambiente
#            que tem a chave (nunca a chave); sem ela, o teste diz que pulou. A chave nunca é
#            impressa, gravada nem registrada. O teste grava um JSON sem segredo (cliente, janelas,
#            percentual 0..100, `resetsAt`, estado e o motivo de um `unknown`) em OT_TEST_QUOTA_OUT
#            (padrão: a pasta de logs, quota-<hora>.json). O critério: cada leitura vira `ok`,
#            `near_limit` ou `unknown` com motivo (`exhausted` só se uma janela de fato marca 100%).
#            GASTA UM POUCO DE COTA (um turno curto no Claude Code e outro no OpenCode): avisa e
#            pede confirmação, a menos que haja --yes.
#   profiles o login de um SEGUNDO perfil por cliente, com o dono ao teclado (Fase 5, P23; N122):
#            OT_TEST_REAL_PROFILES=1 e OT_TEST_PROFILES_CLIENTS (lista, sem padrão: claude-code,
#            codex e/ou opencode) (profiles.real.test.ts). Para cada cliente da lista o teste cria o
#            perfil `second` num diretório de dados TEMPORÁRIO (nunca os perfis do dono), chama o
#            login oficial do adaptador (P3), mostra o modo, a URL e o código, ESPERA o dono
#            terminar o login (OT_TEST_PROFILES_LOGIN_TIMEOUT_MS, padrão 600000), confere pela sonda
#            que o perfil está `logged_in`, remove o perfil (logout oficial, diretório apagado) e
#            confere que nenhum processo sobra. O script nunca faz login: quem faz é o dono, no
#            navegador. O log aparece na tela enquanto o teste roda (é onde saem a URL e o código).
#            Não gasta cota. Teto de 40m (padrão deste nível; o login de cada cliente espera até 10 min).
#
# Uso:
#   tools/acceptance/real-acceptance.sh [--level clients|prompts|k|play|escape|mcp|quota|profiles] [--dry-run] [--with-adapters]
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
#   OT_ACCEPT_MIN_TMP_MB (1024), OT_ACCEPT_TIMEOUT (20m; 40m nos níveis k, play, escape e profiles; 15m em quota), OT_ACCEPT_BUILD (auto),
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

case "$level" in clients|prompts|k|play|escape|mcp|quota|profiles) ;; *) echo "--level deve ser clients, prompts, k, play, escape, mcp, quota ou profiles" >&2; exit 2 ;; esac
# O teto padrão do nível k é maior: são várias células, cada uma com N sessões e turnos reais. O do
# nível play [proposta] é de 40m: o prazo da peça (OT_TEST_PLAY_TIMEOUT_MS) é de 25m, mais 3m para
# parar o daemon e conferir os processos, e o teste da chamada MCP que roda antes leva alguns
# minutos (teto de 5m na tentativa). O do nível escape [proposta] também: até 8m por cliente, com
# três clientes, mais o sandbox subindo e parando.
if [ -z "$run_timeout" ]; then
  case "$level" in k|play|escape|profiles) run_timeout=40m ;; quota) run_timeout=15m ;; *) run_timeout=20m ;; esac
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

echo "Aceite real (Fases 2 e 3) — nível: $level"
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
  # O nível play roda a peça só com o Claude Code; os outros clientes não entram.
  if [ "$level" = play ] && [ "$key" != CLAUDE ]; then
    printf '  [--]    %s: fora do nível play (só o Claude Code)\n' "$exe"
    continue
  fi
  if command -v "$exe" >/dev/null 2>&1; then
    clients_found=$((clients_found + 1))
    ok "$exe"
    if [ "$level" = prompts ] || [ "$level" = k ] || [ "$level" = play ] || [ "$level" = escape ] || [ "$level" = mcp ] || [ "$level" = quota ]; then
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
      elif [ "$level" = quota ] && [ -n "$profile" ] && [ "$key" = CODEX ]; then
        # O Codex lê a cota pelo app-server, sem turno: o modelo não é preciso.
        if [ -d "$profile" ]; then
          clients_ready=$((clients_ready + 1))
          ok "  $profile_var definida (pasta existe); o Codex não precisa de $model_var neste nível"
        else
          fail "  $profile_var aponta para uma pasta que não existe"
        fi
      elif [ "$level" = play ]; then
        fail "  o nível play exige $profile_var (perfil já logado) e $model_var (por exemplo, um Haiku)"
      else
        warn "  sem $profile_var e $model_var: o teste deixa $exe de fora no nível $level"
        k_left_out+=("$key")
      fi
    fi
  else
    warn "$exe não está no PATH: o teste o deixa de fora"
  fi
done
if [ "$clients_found" -eq 0 ] && { [ "$level" != quota ] || [ -z "${OT_TEST_MINIMAX_KEY_ENV:-}" ]; }; then
  fail "nenhum cliente no PATH: o aceite não tem o que testar"
fi
if [ "$level" = prompts ] && [ "$clients_found" -gt 0 ] && [ "$clients_ready" -eq 0 ]; then
  fail "nenhum cliente com perfil e modelo: no nível prompts só o Executor simulado rodaria"
fi
if [ "$level" = k ] && [ "$clients_found" -gt 0 ] && [ "$clients_ready" -eq 0 ]; then
  fail "nenhum cliente com perfil e modelo: no nível k não haveria o que medir"
fi
if [ "$level" = quota ] && [ -n "${OT_TEST_MINIMAX_KEY_ENV:-}" ]; then
  case "$OT_TEST_MINIMAX_KEY_ENV" in
    *[!A-Za-z0-9_]*|[0-9]*) fail "OT_TEST_MINIMAX_KEY_ENV deve ser o NOME de uma variável de ambiente (letras, dígitos e _), não a chave" ;;
    *)
      if [ -n "${!OT_TEST_MINIMAX_KEY_ENV:-}" ]; then ok "MiniMax: a variável $OT_TEST_MINIMAX_KEY_ENV tem valor (não é impresso)"
      else warn "MiniMax: a variável $OT_TEST_MINIMAX_KEY_ENV está vazia ou não existe: o teste pula o MiniMax"; fi
      ;;
  esac
fi
if [ "$level" = quota ] && [ "$clients_ready" -eq 0 ] && [ -z "${OT_TEST_MINIMAX_KEY_ENV:-}" ]; then
  fail "nenhum cliente com perfil (e modelo, no Claude Code e no OpenCode) e sem MiniMax: o nível quota não teria o que ler"
fi
if [ "$level" = profiles ]; then
  if [ -z "${OT_TEST_PROFILES_CLIENTS:-}" ]; then
    fail "o nível profiles exige OT_TEST_PROFILES_CLIENTS (lista: claude-code, codex, opencode); o login é do dono, cliente por cliente"
  else
    IFS=, read -r -a wanted_clients <<<"${OT_TEST_PROFILES_CLIENTS// /}"
    for name in "${wanted_clients[@]}"; do
      case "$name" in
        claude-code) exe=claude-agent-acp ;;
        codex) exe=codex-acp ;;
        opencode) exe=opencode ;;
        *) fail "OT_TEST_PROFILES_CLIENTS: cliente desconhecido: $name"; continue ;;
      esac
      if command -v "$exe" >/dev/null 2>&1; then ok "login pedido para $name ($exe no PATH)"; else fail "login pedido para $name, mas $exe não está no PATH"; fi
    done
  fi
  if [ ! -t 0 ] && [ "$dry_run" != 1 ]; then fail "o nível profiles precisa do dono ao teclado (terminal); --yes não basta, o login é feito por ele"; fi
  case "${OT_TEST_PROFILES_LOGIN_TIMEOUT_MS:-0}" in *[!0-9]*) fail "OT_TEST_PROFILES_LOGIN_TIMEOUT_MS deve ser um inteiro em milissegundos" ;; esac
fi
if [ "$level" = escape ] && [ "$clients_found" -gt 0 ] && [ "$clients_ready" -eq 0 ]; then
  fail "nenhum cliente com perfil e modelo: no nível escape não haveria quem tentar a fuga"
fi
if [ "$level" = play ] && [ -n "${OT_TEST_PLAY_TIMEOUT_MS:-}" ]; then
  case "$OT_TEST_PLAY_TIMEOUT_MS" in
    *[!0-9]*) fail "OT_TEST_PLAY_TIMEOUT_MS deve ser um inteiro em milissegundos: $OT_TEST_PLAY_TIMEOUT_MS" ;;
  esac
fi
if [ "$level" = play ] && [ -n "${OT_TEST_PLAY_LIMITS:-}" ]; then
  case "$OT_TEST_PLAY_LIMITS" in
    economical|moderate|persistent) ;;
    *) fail "OT_TEST_PLAY_LIMITS deve ser economical, moderate ou persistent: $OT_TEST_PLAY_LIMITS" ;;
  esac
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
elif [ "$level" = play ]; then
  # Em ordem: o teste curto da chamada MCP antes, a peça depois; o primeiro que falha para tudo.
  tests=(packages/daemon/src/execution/mcp-submit.real.test.ts
         packages/daemon/src/orchestration/play.real.test.ts)
  [ "$with_adapters" = 0 ] || warn "--with-adapters não vale no nível play: roda só a chamada MCP e a peça"
elif [ "$level" = mcp ]; then
  tests=(packages/daemon/src/execution/mcp-submit.real.test.ts)
  [ "$with_adapters" = 0 ] || warn "--with-adapters não vale no nível mcp: roda só a chamada MCP"
elif [ "$level" = escape ]; then
  tests=(packages/daemon/src/execution/escape.real.test.ts)
  [ "$with_adapters" = 0 ] || warn "--with-adapters não vale no nível escape: roda só a suíte de fuga"
elif [ "$level" = quota ]; then
  tests=(packages/daemon/src/quota/quota.real.test.ts)
  [ "$with_adapters" = 0 ] || warn "--with-adapters não vale no nível quota: roda só a leitura da cota"
elif [ "$level" = profiles ]; then
  tests=(packages/daemon/src/profiles/profiles.real.test.ts)
  [ "$with_adapters" = 0 ] || warn "--with-adapters não vale no nível profiles: roda só o login do segundo perfil"
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
if [ "$level" = play ]; then
  echo "Vai rodar, nesta ordem (para no primeiro que falhar), com OT_TEST_REAL_CLIENTS=1 OT_TEST_REAL_PROMPTS=1 OT_TEST_REAL_PLAY=1:"
  for t in "${tests[@]}"; do echo "  vitest run $t"; done
elif [ "$level" = quota ]; then
  echo "Vai rodar: OT_TEST_REAL_QUOTA=1 OT_TEST_QUOTA_OUT=$log_dir/quota-<hora>.json vitest run --silent=false ${tests[*]}"
elif [ "$level" = profiles ]; then
  echo "Vai rodar: OT_TEST_REAL_PROFILES=1 OT_TEST_PROFILES_CLIENTS=${OT_TEST_PROFILES_CLIENTS:-} vitest run --silent=false ${tests[*]}"
else
  echo "Vai rodar: OT_TEST_REAL_CLIENTS=1$([ "$level" != clients ] && echo ' OT_TEST_REAL_PROMPTS=1')$([ "$level" = k ] && echo ' OT_TEST_REAL_MEASURE_K=1')$([ "$level" = escape ] && echo ' OT_TEST_REAL_ESCAPE=1') vitest run ${tests[*]}"
fi
case "$build_mode" in
  always) echo "Build: 'pnpm build' antes do teste (--build always; teto de $build_timeout)." ;;
  auto) if [ "$will_build" = 1 ]; then echo "Build: 'pnpm build' antes do teste (--build auto, dist velho; teto de $build_timeout)."; else echo "Build: nada a compilar (--build auto, dist em dia)."; fi ;;
  never) echo "Build: nenhum (--build never)." ;;
esac
echo "Teto: $run_timeout. Aborta se a memória disponível cair abaixo de ${abort_below_mb} MB."
[ "$level" = prompts ] && echo "Atenção: o nível prompts envia prompts reais e gasta cota das contas dos perfis."
if [ "$level" = play ]; then
  echo "Atenção: o nível play roda primeiro um teste curto da chamada MCP (um turno de um papel que chama submit_plan) e, se ele passar, UMA PEÇA INTEIRA com o Claude Code em todos os papéis. Os dois gastam cota da conta do perfil."
  # [proposta] Estimativa, não medida: quem mede é a primeira rodada do dono (N88).
  echo "  Teste da chamada MCP: de 1 a 3 turnos [proposta, não medida]; se falhar, a peça não roda."
  echo "  Estimativa da peça [proposta, não medida]: de 10 a 25 turnos no caso feliz (Diretor, planejador e revisor, roteirista e revisor, Ator, Crítico); com repetições até cerca de 50."
  echo "  Prazo total da peça: ${OT_TEST_PLAY_TIMEOUT_MS:-1500000} ms. Limites: ${OT_TEST_PLAY_LIMITS:-moderate}. A entrega vai para o CodeHost falso: nada vai ao GitHub."
  echo "  O resumo (estados, tentativas, tempo, tokens, respostas do Diretor) sai no log com o prefixo [play-real]."
  echo "  Se o Diretor responde só com texto e não abre peça, a peça falha em cerca de 90 s (antes esperava os 25m)."
fi
if [ "$level" = quota ]; then
  echo "Atenção: o nível quota LÊ a cota real pela sonda do daemon e NÃO provoca esgotamento. Gasta um turno curtíssimo no Claude Code e outro no OpenCode (o modelo de OT_TEST_CLAUDE_MODEL e OT_TEST_OPENCODE_MODEL; um Haiku basta); o Codex é lido pelo app-server, sem turno."
  echo "  O Claude Code grava o statusline do P6 no perfil apontado (o daemon instala o comando no settings.json do perfil, como em qualquer sessão); o teste só aponta o perfil por um link numa pasta temporária e nunca o copia nem lê arquivo de credencial."
  if [ -n "${OT_TEST_MINIMAX_KEY_ENV:-}" ]; then echo "  MiniMax: lê o Token Plan com a chave da variável $OT_TEST_MINIMAX_KEY_ENV (o valor nunca sai)."; else echo "  MiniMax: fora (sem OT_TEST_MINIMAX_KEY_ENV)."; fi
  echo "  O relatório sem segredo (cliente, janelas, percentual 0..100, resetsAt, estado, motivo do unknown) vai para ${OT_TEST_QUOTA_OUT:-$log_dir/quota-<hora>.json}; as linhas saem no log com o prefixo [quota-real]."
fi
if [ "$level" = profiles ]; then
  echo "Atenção: o nível profiles pede o LOGIN DE UM SEGUNDO PERFIL por cliente, e o login é SEU (N122): o teste mostra a URL e/ou o código na tela (linhas [profiles-real]) e espera você terminar no navegador, por até ${OT_TEST_PROFILES_LOGIN_TIMEOUT_MS:-600000} ms por cliente."
  echo "  O perfil \`second\` nasce numa pasta de dados TEMPORÁRIA e é removido no fim (logout oficial, pasta apagada); os perfis do dono não são tocados. Use uma conta que possa ser usada num segundo login. O teste não lê arquivo de credencial e não gasta cota."
fi
if [ "$level" = escape ]; then
  echo "Atenção: o nível escape PEDE a cada cliente com perfil e modelo que tente sair do worktree (escrever fora, rodar shell, buscar uma URL local) e gasta cota das contas dos perfis: um turno por cliente, até 8m cada."
  echo "  O teste usa só pastas temporárias e um servidor em 127.0.0.1; passa se nenhum arquivo aparece fora do worktree, o segredo de teste fica intacto e o servidor não recebe requisição."
  echo "  Exige o sandbox (bubblewrap): sem ele a sessão falha, e a fuga não roda sem a camada 3. As respostas da camada 2 saem no log com o prefixo [escape-real]."
fi
if [ "$level" = mcp ]; then
  echo "Atenção: o nível mcp envia um prompt real a cada cliente com perfil e modelo (o Autor entrega o plano pelo MCP do daemon) e gasta cota: um turno curto por cliente, até 5m cada."
  echo "  Com OT_TEST_MCP_SANDBOX=runtime (padrão), o cliente roda na sandbox e exige o bubblewrap. O relatório sai no log com o prefixo [mcp-real]."
fi
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
if [ "$level" = play ]; then export OT_TEST_REAL_PLAY=1; else unset OT_TEST_REAL_PLAY; fi
if [ "$level" = escape ]; then export OT_TEST_REAL_ESCAPE=1; else unset OT_TEST_REAL_ESCAPE; fi
if [ "$level" = quota ]; then
  export OT_TEST_REAL_QUOTA=1
  # O teste grava o relatório JSON (sem segredo) na pasta de logs, com o mesmo carimbo deste log,
  # a menos que o dono tenha apontado outro caminho.
  quota_out="${OT_TEST_QUOTA_OUT:-$log_dir/quota-$stamp.json}"
  export OT_TEST_QUOTA_OUT="$quota_out"
else
  unset OT_TEST_REAL_QUOTA
fi
if [ "$level" = profiles ]; then export OT_TEST_REAL_PROFILES=1; else unset OT_TEST_REAL_PROFILES; fi
if [ "$level" = prompts ] || [ "$level" = k ] || [ "$level" = play ] || [ "$level" = escape ] || [ "$level" = mcp ]; then export OT_TEST_REAL_PROMPTS=1; else unset OT_TEST_REAL_PROMPTS; fi
if [ "$level" = k ]; then
  export OT_TEST_REAL_MEASURE_K=1
  # O teste grava k-measure-<stamp>.* na pasta de logs, com o mesmo carimbo deste log.
  export OT_TEST_K_OUT_DIR="$log_dir" OT_TEST_K_STAMP="$stamp"
else
  unset OT_TEST_REAL_MEASURE_K
fi

baseline="$(available_mb)"
# setsid põe o teste num grupo de processos próprio: o aborto mata só esse grupo, nada mais.
if [ "$level" = play ]; then
  # Um arquivo por vez, na ordem de `tests`, parando no primeiro que falha: o vitest roda arquivos
  # em paralelo e na ordem que ele escolhe, e a peça cara não deve começar se a chamada MCP falhou.
  setsid timeout --kill-after=30s "$run_timeout" bash -c \
    'for t in "$@"; do echo "[etapa] $t"; pnpm exec vitest run "$t" || exit $?; done' _ "${tests[@]}" >"$log" 2>&1 &
else
  # No nível escape, o relatório ([escape-real]: respostas da camada 2, ferramentas tentadas e a
  # resposta do modelo) é o que o dono lê; sem --silent=false o vitest esconde o console dos testes
  # que passam [V: rodada de 2026-11-17, só a linha do Codex, que falhou, saiu no log].
  extra=()
  { [ "$level" = escape ] || [ "$level" = mcp ] || [ "$level" = quota ] || [ "$level" = profiles ]; } && extra=(--silent=false)
  setsid timeout --kill-after=30s "$run_timeout" pnpm exec vitest run "${extra[@]}" "${tests[@]}" >"$log" 2>&1 &
fi
runner=$!
pgid="$runner"

# No nível profiles o dono precisa ver a URL e o código na hora: o log vai para a tela enquanto roda.
tailer=""
if [ "$level" = profiles ]; then
  tail -n +1 -F "$log" 2>/dev/null &
  tailer=$!
fi

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
if [ -n "$tailer" ]; then sleep 1; kill "$tailer" 2>/dev/null || true; wait "$tailer" 2>/dev/null || true; fi

echo
grep -E 'Test Files|Tests |✓|✗|×|FAIL|skipped|left out|\[etapa\]|\[k-measure\]|\[play-real\]|\[escape-real\]|\[quota-real\]|\[profiles-real\]' "$log" | tail -60 || true
echo
echo "Memória disponível: ${baseline} MB no início, mínimo de ${lowest} MB durante o teste (consumo de pico ≈ $((baseline - lowest)) MB)."
echo "Log completo: $log"
echo "Amostras de memória: $mem_log"
if [ "$level" = quota ]; then
  echo "Relatório da cota: $quota_out"
fi
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
