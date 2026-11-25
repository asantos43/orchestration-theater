#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# [proposta] The update with a piece in progress (Phase 10, N303 (3)), with the fake agent in place of
# the Claude Code: the same `otheater-release acceptance-busy` of the level `phase10-busy` of
# real-acceptance.sh (tools/release/src/acceptance-busy.ts), with no real client, no quota, no login
# and no network. An optional test: it does not run in the CI. It is the way to check, before a real
# round, that the update waits for the attempt (`idle`) or parks it and comes back (`park`).
#
#   tools/acceptance/busy-fake.sh
#
# Before it: `pnpm install --frozen-lockfile` and `pnpm -s build` (it reads tools/release/dist and
# packages/fake-agent/dist), and a standalone Node in OT_SEA_NODE to make the two single executables
# (as in the level phase10; the Node of a distribution package, with a shared libnode, is refused).
#
# What it does: makes a key only of this run, builds the 1.0.0 and the 1.0.1, writes a wrapper in the
# folder of the run that starts tools/acceptance/busy-fake-proxy.mjs over the fake agent (`role-play`
# script), and runs `acceptance-busy` with `--client-command <wrapper>`, no profile linked and a model
# the fake agent knows (OT_TEST_BUSY_FAKE_MODEL). The proxy holds the first prompt of a worktree for OT_TEST_BUSY_FAKE_HOLD_MS, so an attempt is
# in progress when the 1.0.1 is published; the park cancels it and the 1.0.1 brings it back.
#
# What it never does: use the real home, the keyring, a real client, the network or sudo; install a
# service; kill a process it did not start. Everything is in a temporary folder under $TMPDIR, removed
# at the end unless OT_TEST_BUSY_FAKE_KEEP=1.
#
# Keys (environment), each with its default:
#   OT_TEST_BUSY_MODES          idle,park   the modes, each in a new home (idle, park or idle,park)
#   OT_TEST_BUSY_FAKE_HOLD_MS   25000       how long the first prompt of a worktree is held
#   OT_TEST_BUSY_FAKE_MODEL     fake-model  the model (the fake agent takes fake-model or fake-model-2)
#   OT_TEST_BUSY_MAX_WAIT       20m         `updates.max_wait` of the idle run
#   OT_TEST_BUSY_RESUME_FORM    native      native (the `session/load`) or any (also a new attempt)
#   OT_TEST_BUSY_NEED           a small need for the Director; the fake Director opens the play only
#                               when the line starts with `#ot-play ` (packages/fake-agent/src/role-play.ts)
#   OT_TEST_PLAY_TIMEOUT_MS     600000      the longest a piece may take, per mode
#   OT_TEST_PLAY_LIMITS         moderate    `limits.preset`
#   OT_ACCEPT_BUILD_TIMEOUT     15m         each build of an executable
#   OT_ACCEPT_TIMEOUT           40m         the whole acceptance-busy
#   OT_TEST_BUSY_FAKE_KEEP      0           1 keeps the folder of the run (its path is printed)
#   OT_SEA_NODE                 (PATH)      the standalone Node of the build
set -euo pipefail

TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TOOLS/../.." && pwd)"
cd "$ROOT"

die() {
  echo "busy-fake.sh: $*" >&2
  exit 1
}

modes="${OT_TEST_BUSY_MODES:-idle,park}"
hold_ms="${OT_TEST_BUSY_FAKE_HOLD_MS:-25000}"
model="${OT_TEST_BUSY_FAKE_MODEL:-fake-model}"
max_wait="${OT_TEST_BUSY_MAX_WAIT:-20m}"
resume_form="${OT_TEST_BUSY_RESUME_FORM:-native}"
need="${OT_TEST_BUSY_NEED:-#ot-play Create a file named fib.js that exports a function fib(n) (iterative, returns the n-th Fibonacci number), and a file fib.test.js with at least five cases using node:test. Keep it minimal.}"
play_timeout="${OT_TEST_PLAY_TIMEOUT_MS:-600000}"
limits="${OT_TEST_PLAY_LIMITS:-moderate}"
build_timeout="${OT_ACCEPT_BUILD_TIMEOUT:-15m}"
run_timeout="${OT_ACCEPT_TIMEOUT:-40m}"
keep="${OT_TEST_BUSY_FAKE_KEEP:-0}"
sea_node="${OT_SEA_NODE:-}"

IFS=',' read -r -a mode_list <<<"$modes"
[ "${#mode_list[@]}" -gt 0 ] || die "OT_TEST_BUSY_MODES está vazia (use idle, park ou idle,park)"
for name in "${mode_list[@]}"; do
  case "$name" in idle | park) ;; *) die "OT_TEST_BUSY_MODES: modo desconhecido (use idle ou park): $name" ;; esac
done
[[ "$hold_ms" =~ ^[0-9]+$ ]] || die "OT_TEST_BUSY_FAKE_HOLD_MS deve ser um inteiro em ms: $hold_ms"
case "$model" in fake-model | fake-model-2) ;; *) die "OT_TEST_BUSY_FAKE_MODEL deve ser fake-model ou fake-model-2: $model" ;; esac
[[ "$max_wait" =~ ^[0-9]+(ms|s|m|h|d)$ ]] || die "OT_TEST_BUSY_MAX_WAIT deve ser uma duração como 90s ou 20m: $max_wait"
case "$resume_form" in native | any) ;; *) die "OT_TEST_BUSY_RESUME_FORM deve ser native ou any: $resume_form" ;; esac
[[ "$play_timeout" =~ ^[0-9]+$ ]] || die "OT_TEST_PLAY_TIMEOUT_MS deve ser um inteiro em ms: $play_timeout"
[ -n "$need" ] || die "OT_TEST_BUSY_NEED está vazia"
case "$keep" in 0 | 1) ;; *) die "OT_TEST_BUSY_FAKE_KEEP deve ser 0 ou 1: $keep" ;; esac
[ -f tools/release/dist/cli.js ] || die "falta tools/release/dist/cli.js: rode 'pnpm -s build'"
[ -f packages/fake-agent/dist/cli.js ] || die "falta packages/fake-agent/dist/cli.js: rode 'pnpm -s build'"
node_bin="$(command -v node)" || die "falta o node no PATH"
if [ -n "$sea_node" ]; then
  [ -x "$sea_node" ] || die "OT_SEA_NODE não é executável: $sea_node"
else
  echo "busy-fake.sh: OT_SEA_NODE vazio: o build usa o node do PATH, que precisa ser um build standalone" >&2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/otheater-busy-fake.XXXXXX")"
if [ "$keep" = 1 ]; then
  echo "busy-fake.sh: a pasta da rodada fica: $work"
else
  trap 'rm -rf "$work"' EXIT
fi

# The wrapper is the `clients.claude-code.command` of the run: absolute paths, in the folder of the run.
{
  echo '#!/bin/sh'
  echo 'FAKE_AGENT_SCRIPT=role-play; export FAKE_AGENT_SCRIPT'
  printf 'exec %q %q %q %q %q\n' "$node_bin" "$TOOLS/busy-fake-proxy.mjs" "$hold_ms" "$work/fake" \
    "$ROOT/packages/fake-agent/dist/cli.js"
} >"$work/agent.sh"
chmod +x "$work/agent.sh"

cli=(node tools/release/dist/cli.js)
sea_args=()
[ -z "$sea_node" ] || sea_args=(--node "$sea_node")
"${cli[@]}" ephemeral-key --out "$work/key"
for version in 1.0.0 1.0.1; do
  out="$work/n"
  [ "$version" = 1.0.0 ] || out="$work/n1"
  timeout "$build_timeout" "${cli[@]}" build --target linux-x64 --out "$out" --version "$version" \
    --public-key "$work/key/ephemeral-public.pem" "${sea_args[@]}"
done
keep_args=()
[ "$keep" = 0 ] || keep_args=(--keep)
timeout --kill-after=30s "$run_timeout" "${cli[@]}" acceptance-busy \
  --exe-n "$work/n/linux-x64/otheater" --version-n 1.0.0 \
  --exe-n1 "$work/n1/linux-x64/otheater" --version-n1 1.0.1 \
  --key "$work/key/ephemeral-private.pem" --install-script installer/install.sh \
  --work-dir "$work/run" --modes "${modes// /}" --max-wait "$max_wait" \
  --resume-form "$resume_form" --need "$need" --play-timeout-ms "$play_timeout" \
  --limits "$limits" --model "$model" --client-command "$work/agent.sh" \
  --daemon-path "$PATH" --prefix '[busy-fake]' "${keep_args[@]}"
