#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# The chaos roteiro of the owner (Phase 11, P11): a test daemon with the fake agent, in a temporary home
# and data folder, that you break by hand (kill -9, kill -STOP, a full volume, a provider that is down) and
# then ask `check` whether the invariants I1 to I8 still hold. The guide is tools/acceptance/chaos.md.
#
#   ./tools/acceptance/chaos.sh help
#
# What it never does: use the real home, the real keyring, a real client (Claude Code, Codex, OpenCode),
# the network or sudo; install a service; kill a process it did not start (it kills only the pids it
# recorded and the processes of the run, found by the unique folder of the run).
set -u

TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TOOLS/../.." && pwd)"
POINTER="${TMPDIR:-/tmp}/otheater-chaos-roteiro-$(id -u).current"
MARKER=".otheater-chaos-roteiro"

die() {
  echo "chaos.sh: $*" >&2
  exit 1
}

# The folder of the current run (a plain variable: it is never exported, so the shell of the owner does
# not carry the folder of the run, and the census of the verifier finds only the processes of the run).
RUN=""
load_run() {
  [ -f "$POINTER" ] || die "nenhuma execução em curso; rode: $0 start"
  RUN="$(cat "$POINTER")"
  [ -f "$RUN/$MARKER" ] || die "o ponteiro $POINTER não aponta para uma execução deste roteiro"
}

in_volume() { [ -f "$RUN/volume.pid" ]; }

# Runs a command in the mount namespace of the small volume when there is one (the volume exists only there).
ns() {
  if in_volume; then
    local holder
    holder="$(cat "$RUN/volume.pid")"
    kill -0 "$holder" 2>/dev/null || die "o volume pequeno acabou (pid $holder): rode stop e start de novo"
    timeout 150 nsenter -t "$holder" -U -m --preserve-credentials -- "$@"
  else
    timeout 150 "$@"
  fi
}

verifier() {
  ns node --disable-warning=ExperimentalWarning "$TOOLS/chaos-check.mjs" "$@"
}

daemon_pid() { [ -f "$RUN/daemon.pid" ] && cat "$RUN/daemon.pid"; }
daemon_alive() {
  local pid
  pid="$(daemon_pid)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)" != "Z" ]
}

# ---------------------------------------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Roteiro de caos do dono (o guia completo está em tools/acceptance/chaos.md).

  chaos.sh start [--plan none|crash-push|crash-commit|fail-log|<arquivo.json>] [--volume 8m]
                 [--stuck 10m] [--minutes 120]
                          sobe o daemon de teste (fake-agent, HOME e dados temporários);
                          --stuck é o resume.stuck.no_event_for (quanto o daemon espera um Executor mudo)
  chaos.sh steps          lista os cenários; `steps <n>` mostra um, com os pids de agora
  chaos.sh status         daemon, clientes, plays e os últimos eventos
  chaos.sh plays          o estado de cada play
  chaos.sh play [hold|quota|<fichas>]   abre um play (hold: o Executor fica vivo, esperando; quota: erro de cota)
  chaos.sh chat [texto]   abre uma conversa (padrão: o Diretor fica pendurado, para ter um cliente vivo)
  chaos.sh provider ok|down|quota|auth  o que os próximos clientes encontram (down = provedor fora ou rede cortada)
  chaos.sh fill | free    enche / esvazia o volume pequeno (só com start --volume)
  chaos.sh plan none|crash-push|crash-commit|fail-log|<arquivo.json>
                          troca o plano de falhas (vale no próximo start do daemon; o plano conta por processo)
  chaos.sh restart        sobe o daemon de novo, sobre os mesmos dados (depois de um kill)
  chaos.sh check [--wait 90] [--allow DONE,...]
                          os invariantes I1 a I8: imprime `ok` ou `falhou: <motivo>` (saída 0 ou 1)
  chaos.sh stop [--keep]  encerra o daemon, o que sobrou da execução e apaga a pasta (--keep a mantém)
EOF
}

steps() {
  local only="${1:-}" pids=""
  if [ -n "$RUN" ] && daemon_alive; then pids="$(verifier pids "$RUN" 2>/dev/null | tr '\n' ';')"; fi
  local text
  text="$(cat <<EOF
1. Queda do daemon com um play em curso (kill -9 só do daemon; o cliente órfão fica vivo)
   $0 play hold          # um Executor vivo, esperando
   $0 status             # anote o pid do daemon e o do cliente
   kill -9 <pid do daemon>
   $0 restart            # a reconciliação deve encerrar o cliente órfão e o play deve terminar
   $0 check
2. Queda da árvore (kill -9 do daemon e dos clientes juntos)
   $0 play hold
   $0 status
   kill -9 <pid do daemon> <pids dos clientes>
   $0 restart
   $0 check
3. Executor parado (kill -STOP) e o daemon que o encerra (precisa de: $0 start --stuck 30s)
   $0 play hold
   $0 status
   kill -STOP <pid do Executor>
   (espere; o daemon decide sozinho depois de resume.stuck.no_event_for; use start --stuck 30s para ver logo)
   $0 status; $0 check --allow DONE,BLOCKED
4. Disco cheio (precisa de: $0 start --volume 8m)
   $0 play hold
   $0 fill               # o daemon avisa (disk_full) e recusa trabalho novo
   $0 events             # procure daemon.notice disk_full
   $0 free               # o daemon volta sozinho (disk_recovered)
   $0 check
5. Provedor fora do ar / rede cortada
   $0 provider down
   $0 play
   $0 provider ok        # os clientes seguintes funcionam e o play termina
   $0 check
6. Ponto de queda do plano de falhas (precisa de: $0 start --plan crash-push; ou crash-commit)
   $0 play               # o daemon se mata ao empurrar o branch (CRASHPOINT no daemon.log)
   $0 plan none          # o plano conta por processo: sem isso o daemon novo cairia no mesmo ponto
   $0 restart
   $0 check
7. Atualização interrompida: não há como fazer neste roteiro [N] (ver chaos.md)
EOF
)"
  if [ -n "$only" ]; then
    echo "$text" | awk -v n="$only" '/^[0-9]+\. /{show = ($1 == n".")} show'
  else
    echo "$text"
  fi
  [ -n "$pids" ] && echo && echo "Agora: $pids"
  return 0
}

# ---------------------------------------------------------------------------------------------------------

write_config() {
  local stuck="${STUCK:-10m}" backoff="${OT_CHAOS_BACKOFF:-3s, 6s, 12s}"
  {
    cat <<EOF
# The config of the test daemon of the chaos roteiro. Edit it between a kill and a restart, if you want
# to try another value: the keys are the ones of the product.
backup:
  when: manual
security:
  unenforced: warn
limits:
  submit_retries: 1
orchestration:
  executor:
    client: fake
    profile: one
    model: fake-model
# No real client, no download: the three official clients are off and the daemon installs no adapter.
clients:
  adapters:
    install: off
  claude-code:
    enabled: false
  codex:
    enabled: false
  opencode:
    enabled: false
faults:
  inject: plan
  plan_file: $RUN/fault-plan.json
resume:
  stuck:
    no_event_for: $stuck
  transient_backoff: [$backoff]
EOF
    if in_volume; then
      cat <<EOF
disk:
  min_free: ${OT_CHAOS_DISK_MIN_FREE:-1MB}
  check_every: ${OT_CHAOS_DISK_CHECK_EVERY:-1s}
EOF
    fi
  } >"$RUN/config.yaml"
}

write_plan() {
  local plan="$1"
  case "$plan" in
    none) echo '{"crash":[],"fail":[]}' >"$RUN/fault-plan.json" ;;
    crash-push) echo '{"crash":[{"point":"effects.after_execute","detail":"git_push","nth":1}],"fail":[]}' >"$RUN/fault-plan.json" ;;
    crash-commit) echo '{"crash":[{"point":"store.before_commit","nth":40}],"fail":[]}' >"$RUN/fault-plan.json" ;;
    fail-log) echo '{"crash":[],"fail":[{"point":"fs.write","detail":"log","code":"ENOSPC","nth":3,"times":3}]}' >"$RUN/fault-plan.json" ;;
    *) [ -f "$plan" ] || die "plano desconhecido: $plan (none, crash-push, crash-commit, fail-log ou um arquivo)"
       cp "$plan" "$RUN/fault-plan.json" ;;
  esac
}

launch_daemon() {
  local before crashes
  before="$(grep -c '^STARTED' "$RUN/daemon.log" 2>/dev/null || true)"
  before="${before:-0}"
  crashes="$(grep -c '^CRASHPOINT' "$RUN/daemon.log" 2>/dev/null || true)"
  crashes="${crashes:-0}"
  local launch=(
    env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GH_TOKEN -u GITHUB_TOKEN
    "HOME=$RUN/home" "XDG_CONFIG_HOME=$RUN/home/.config" "XDG_DATA_HOME=$RUN/home/.local/share"
    "XDG_STATE_HOME=$RUN/home/.local/state" "XDG_CACHE_HOME=$RUN/home/.cache"
    GIT_CONFIG_NOSYSTEM=1 "GIT_CONFIG_GLOBAL=$RUN/home/.gitconfig"
    "GIT_AUTHOR_NAME=OTheater Chaos" "GIT_AUTHOR_EMAIL=chaos@example.invalid"
    "GIT_COMMITTER_NAME=OTheater Chaos" "GIT_COMMITTER_EMAIL=chaos@example.invalid"
    "OT_CHAOS_MAX_MINUTES=$MINUTES"
    node --disable-warning=ExperimentalWarning "$TOOLS/chaos-daemon.mjs" "$RUN"
  )
  if in_volume; then
    nsenter -t "$(cat "$RUN/volume.pid")" -U -m --preserve-credentials -- setsid "${launch[@]}" >>"$RUN/daemon.log" 2>&1 </dev/null &
  else
    setsid "${launch[@]}" >>"$RUN/daemon.log" 2>&1 </dev/null &
  fi
  local waited=0 now
  while [ "$waited" -lt 120 ]; do
    now="$(grep -c '^STARTED' "$RUN/daemon.log" 2>/dev/null || true)"
    if [ "${now:-0}" -gt "$before" ]; then
      echo "daemon de pé: pid $(daemon_pid)"
      return 0
    fi
    # A daemon that kills itself at a crash point (plan) before STARTED is a result, not a failure of the start.
    now="$(grep -c '^CRASHPOINT' "$RUN/daemon.log" 2>/dev/null || true)"
    if [ "${now:-0}" -gt "$crashes" ] && ! daemon_alive; then
      echo "o daemon se matou antes de subir, num ponto do plano de falhas:"
      grep '^CRASHPOINT' "$RUN/daemon.log" | tail -1
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  tail -20 "$RUN/daemon.log" >&2
  die "o daemon não subiu em 60 s (veja $RUN/daemon.log)"
}

cmd_start() {
  local plan="none" volume="" MINUTES=120 STUCK=10m
  while [ $# -gt 0 ]; do
    case "$1" in
      --plan) plan="${2:-}"; shift 2 ;;
      --volume) volume="${2:-}"; shift 2 ;;
      --minutes) MINUTES="${2:-}"; shift 2 ;;
      --stuck) STUCK="${2:-}"; shift 2 ;;
      *) die "opção desconhecida: $1" ;;
    esac
  done
  [ "$(uname -s)" = Linux ] || die "o roteiro roda só no Linux (o censo de processos lê /proc); veja chaos.md"
  command -v node >/dev/null || die "node não encontrado"
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || die "precisa do Node 24 ou mais (descarta os tipos dos fontes do harness)"
  command -v git >/dev/null || die "git não encontrado"
  for file in packages/daemon/dist/daemon.js packages/core/dist/testing/index.js packages/fake-agent/dist/cli.js; do
    [ -f "$ROOT/$file" ] || die "falta $file: rode 'pnpm build' na raiz do repositório"
  done
  if [ -f "$POINTER" ]; then
    RUN="$(cat "$POINTER")"
    if [ -f "$RUN/$MARKER" ]; then die "já há uma execução em $RUN: rode '$0 stop' antes"; fi
  fi
  if [ -n "$volume" ]; then
    command -v unshare >/dev/null && command -v nsenter >/dev/null || die "--volume precisa de unshare e nsenter (util-linux)"
  fi

  RUN="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/otheater-chaos-roteiro.XXXXXX")")"
  : >"$RUN/$MARKER"
  echo "$RUN" >"$POINTER"
  mkdir -p "$RUN/home" "$RUN/data" "$RUN/state/pids" "$RUN/control"
  echo ok >"$RUN/provider-mode"

  if [ -n "$volume" ]; then
    # A tmpfs of its own, in a mount namespace of this user (no root, no sudo). The holder keeps the
    # namespace (and so the volume) alive while the daemon is killed and started again.
    setsid unshare -rm sh -c 'mount -t tmpfs -o "size=$2" tmpfs "$1/data" && echo $$ >"$1/volume.pid" && exec sleep "$3"' \
      sh "$RUN" "$volume" "$((MINUTES * 60 + 600))" >/dev/null 2>&1 </dev/null &
    local waited=0
    while [ ! -s "$RUN/volume.pid" ] && [ "$waited" -lt 40 ]; do sleep 0.25; waited=$((waited + 1)); done
    [ -s "$RUN/volume.pid" ] || { rm -f "$POINTER"; die "não consegui montar o volume pequeno sem root (veja chaos.md, seção do disco cheio)"; }
    echo "volume pequeno de $volume em $RUN/data (visível só dentro do namespace do holder, pid $(cat "$RUN/volume.pid"))"
  fi

  # The repository the plays work on, with its `origin`, as the harness makes it.
  local git=(git -c user.name="OTheater Chaos" -c user.email="chaos@example.invalid")
  timeout 60 "${git[@]}" init --quiet --bare --initial-branch=main "$RUN/remote.git" || die "git init falhou"
  timeout 60 "${git[@]}" init --quiet --initial-branch=main "$RUN/repo" || die "git init falhou"
  echo base >"$RUN/repo/shared.txt"
  timeout 60 "${git[@]}" -C "$RUN/repo" add shared.txt
  timeout 60 "${git[@]}" -C "$RUN/repo" commit --quiet -m "initial commit" || die "git commit falhou"
  timeout 60 "${git[@]}" -C "$RUN/repo" remote add origin "$RUN/remote.git"
  timeout 60 "${git[@]}" -C "$RUN/repo" push --quiet origin main || die "git push falhou"

  write_plan "$plan"
  write_config
  echo "execução em $RUN (config.yaml e fault-plan.json estão lá; plano: $plan)"
  MINUTES="$MINUTES" launch_daemon
  echo "próximo passo: $0 steps"
}

cmd_plan() {
  load_run
  [ $# -eq 1 ] || die "uso: plan none|crash-push|crash-commit|fail-log|<arquivo.json>"
  write_plan "$1"
  echo "plano de falhas: $1 (vale no próximo start do daemon)"
}

cmd_restart() {
  load_run
  if daemon_alive; then die "o daemon ainda está vivo (pid $(daemon_pid)): mate-o antes (passo 1) ou rode stop"; fi
  echo "o que a queda deixou vivo (o censo de I3):"
  verifier census-save "$RUN" || die "o verificador falhou"
  MINUTES="${OT_CHAOS_MINUTES:-120}" launch_daemon
}

# One command to the daemon, through the control folder; prints its answer.
send() {
  local name answer waited=0
  daemon_alive || die "o daemon não está vivo (restart?)"
  name="$(date +%s%N)-$1"
  # Written outside the folder and moved in, so the daemon never reads a half-written command.
  printf '%s\n' "$*" >"$RUN/control.tmp"
  mv "$RUN/control.tmp" "$RUN/control/$name"
  answer="$RUN/control/$name.done"
  while [ ! -f "$answer" ] && [ "$waited" -lt 240 ]; do sleep 0.25; waited=$((waited + 1)); done
  [ -f "$answer" ] || die "o daemon não respondeu em 60 s"
  cat "$answer"
  echo
}

wait_client() {
  local waited=0
  while [ "$waited" -lt 240 ]; do
    if verifier pids "$RUN" 2>/dev/null | grep -q '^cliente'; then return 0; fi
    sleep 0.25
    waited=$((waited + 1))
  done
  echo "(nenhum cliente vivo apareceu em 60 s: veja status)" >&2
}

cmd_play() {
  load_run
  local kind="${1:-}"
  case "$kind" in
    hold)
      # The fake agent hangs once per demand and attempt, counted in the state folder: zero the count so
      # every `play hold` of a run holds again.
      rm -f "$RUN/state/actor-hang-alpha-1.count"
      send play '#actor-hang:alpha@1' ;;
    quota) send play "#actor-quota:alpha=$(date -u -d '+45 seconds' +%Y-%m-%dT%H:%M:%SZ)@1" ;;
    "") send play ;;
    *) shift; send play "$kind $*" ;;
  esac
  [ "$kind" = hold ] && wait_client
  return 0
}

cmd_chat() {
  load_run
  if [ $# -eq 0 ]; then send chat '#ot-director-hang\n#ot-chat hello'; else send chat "$*"; fi
  wait_client
}

cmd_status() {
  load_run
  echo "execução: $RUN"
  if daemon_alive; then
    echo "daemon vivo: pid $(daemon_pid)"
    echo "disco (o que o daemon vê): $(send status | sed -n 's/.*"paused":\([a-z]*\),"disk":{"state":"\([a-z]*\)".*/pausado=\1 estado=\2/p')"
  else
    echo "daemon: não está vivo"
  fi
  verifier pids "$RUN"
  verifier plays "$RUN"
  verifier events "$RUN" 12
}

cmd_provider() {
  load_run
  case "${1:-}" in
    ok | down | quota | auth) echo "$1" >"$RUN/provider-mode"; echo "provedor: $1 (vale para os próximos clientes que o daemon abrir)" ;;
    *) die "uso: provider ok|down|quota|auth" ;;
  esac
}

cmd_fill() {
  load_run
  in_volume || die "fill só com o volume pequeno: start --volume 8m"
  # `dd` ends with ENOSPC on purpose: that is the volume becoming full.
  ns dd if=/dev/zero of="$RUN/data/ballast" bs=64k status=none 2>&1 | tail -1
  ns df -h "$RUN/data" | tail -1
}

cmd_free() {
  load_run
  in_volume || die "free só com o volume pequeno: start --volume 8m"
  ns rm -f "$RUN/data/ballast"
  ns df -h "$RUN/data" | tail -1
}

cmd_stop() {
  load_run
  local keep=0
  [ "${1:-}" = "--keep" ] && keep=1
  local pid
  if daemon_alive; then
    pid="$(daemon_pid)"
    kill -CONT "$pid" 2>/dev/null
    kill -TERM "$pid" 2>/dev/null
    local waited=0
    while daemon_alive && [ "$waited" -lt 80 ]; do sleep 0.25; waited=$((waited + 1)); done
    if daemon_alive; then kill -KILL "$pid" 2>/dev/null; echo "o daemon não parou com SIGTERM em 20 s: SIGKILL"; fi
  fi
  echo "o que a execução deixou vivo depois do daemon:"
  verifier kill-leftovers "$RUN" || true
  if in_volume; then
    local holder
    holder="$(cat "$RUN/volume.pid")"
    kill -TERM "$holder" 2>/dev/null
  fi
  sleep 0.5
  if [ "$keep" -eq 1 ]; then
    echo "pasta mantida: $RUN (o ponteiro $POINTER segue; apague os dois depois)"
    return 0
  fi
  case "$RUN" in
    "${TMPDIR:-/tmp}"/otheater-chaos-roteiro.*) [ -f "$RUN/$MARKER" ] && rm -rf "$RUN" ;;
    *) die "não apago $RUN: não é uma pasta deste roteiro" ;;
  esac
  rm -f "$POINTER"
  echo "execução encerrada e apagada"
}

main() {
  local sub="${1:-help}"
  [ $# -gt 0 ] && shift
  case "$sub" in
    help | -h | --help) usage ;;
    start) cmd_start "$@" ;;
    steps) [ -f "$POINTER" ] && load_run; steps "$@" ;;
    status) cmd_status ;;
    plays) load_run; verifier plays "$RUN" ;;
    play) cmd_play "$@" ;;
    chat) cmd_chat "$@" ;;
    provider) cmd_provider "$@" ;;
    fill) cmd_fill ;;
    free) cmd_free ;;
    plan) cmd_plan "$@" ;;
    restart) cmd_restart ;;
    events) load_run; verifier events "$RUN" "${1:-30}" ;;
    check) load_run; verifier check "$RUN" "$@" ;;
    stop) cmd_stop "$@" ;;
    *) usage; exit 2 ;;
  esac
}
main "$@"
