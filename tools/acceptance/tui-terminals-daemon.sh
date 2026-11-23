#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Sobe um daemon de teste para o roteiro manual da TUI (tools/acceptance/tui-terminals.md): o
# `fake-agent` faz todos os papéis (roteiro `role-play`), o repositório, o remote e a hospedagem de
# código são falsos e ficam numa pasta temporária, e o relógio é o real. Nada gasta cota e nada toca
# o seu perfil. O script imprime a pasta de dados e o comando para abrir a TUI em OUTRO terminal.
#
# Uso, da raiz do repositório (depois de `pnpm install --frozen-lockfile` e `pnpm build`):
#   bash tools/acceptance/tui-terminals-daemon.sh
#
# Fica de pé até Ctrl+C (ou SIGTERM), até existir o arquivo de parada que ele imprime, ou até o prazo
# (OT_MANUAL_MINUTES, padrão 120; aceita fração). Ao parar, apaga a pasta temporária. O daemon é o
# teste packages/tui/src/manual-terminals.manual.test.ts, que só roda com OT_TEST_MANUAL_TERMINALS=1
# (a suíte e a CI o pulam). Só Linux e macOS (usa setsid, se houver).
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 1

for built in packages/fake-agent/dist/cli.js packages/daemon/dist/cli.js packages/tui/dist/main.js; do
  if [ ! -f "$root/$built" ]; then
    echo "Falta $built: rode 'pnpm install --frozen-lockfile' e 'pnpm build' na raiz e tente de novo." >&2
    exit 2
  fi
done
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm não está no PATH." >&2
  exit 2
fi

ctl="$(mktemp -d "${TMPDIR:-/tmp}/otheater-manual-XXXXXX")"
log="$ctl/vitest.log"
pid=""

# Ctrl+C e SIGTERM viram o arquivo de parada: o teste para o daemon e apaga as pastas por conta própria.
request_stop() { : >"$ctl/stop"; }
trap request_stop INT TERM

export OT_TEST_MANUAL_TERMINALS=1
export OT_MANUAL_CTL_DIR="$ctl"
# O teste roda num grupo de processos próprio (setsid): o Ctrl+C do terminal chega só a este script,
# que pede a parada e espera o daemon limpar, em vez de matar o vitest no meio da limpeza.
if command -v setsid >/dev/null 2>&1; then
  setsid pnpm exec vitest run --reporter=dot packages/tui/src/manual-terminals.manual.test.ts >"$log" 2>&1 &
else
  pnpm exec vitest run --reporter=dot packages/tui/src/manual-terminals.manual.test.ts >"$log" 2>&1 &
fi
pid=$!

echo "Subindo o daemon de teste (fake-agent, relógio real)..."
printed=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$printed" = 0 ] && [ -f "$ctl/info.txt" ]; then
    echo
    cat "$ctl/info.txt"
    printed=1
  fi
  sleep 0.5
done
# `wait` volta cedo se um sinal chegou durante o sleep; aqui o processo já acabou.
wait "$pid"
status=$?

if [ "$printed" = 0 ] || [ "$status" != 0 ]; then
  echo "O daemon de teste não subiu ou caiu (código $status). Fim do log:" >&2
  tail -n 40 "$log" >&2
fi
rm -rf "$ctl"
echo "Daemon de teste parado; a pasta temporária foi apagada."
exit "$status"
