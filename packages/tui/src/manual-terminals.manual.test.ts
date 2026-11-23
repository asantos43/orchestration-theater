// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { describe, it } from 'vitest';
import { FAKE_AGENT_CLI, NO_LAUNCHER, startChatDaemon } from './chat/fake-agent.test-support.js';

/**
 * The daemon of the manual script of the terminals (`tools/acceptance/tui-terminals.md`, "Antes de
 * começar"): not a test, a launcher that lives in the test tree to reuse `startChatDaemon` (the daemon
 * of the chat tests, with the fake agent in every role, `role-play`) for a person to open the TUI on.
 * Nothing real runs: temporary folders, loopback, a fake code host, a vault in memory and `git` with
 * no configuration of the person. Unlike the tests, the clock is the REAL one (the person uses the TUI
 * for a long time), and `config.yaml` is written in the data folder, so `ui.mouse` and
 * `ui.clipboard.copy` can be changed by hand while the roteiro goes on.
 *
 * It runs only with `OT_TEST_MANUAL_TERMINALS=1` (the suite and the CI skip it, as they skip the
 * `*.real.test.ts`), and it is started by `tools/acceptance/tui-terminals-daemon.sh`, which gives it
 * a control folder (`OT_MANUAL_CTL_DIR`): the launcher writes `info.txt` there when the daemon is up,
 * and stops (and deletes every temporary folder) when `stop` appears there, or at the deadline
 * (`OT_MANUAL_MINUTES`, default 120). The script turns Ctrl+C into that `stop` file.
 */

const TUI_ENTRY = fileURLToPath(new URL('../../daemon/dist/cli.js', import.meta.url));
const enabled =
  process.env.OT_TEST_MANUAL_TERMINALS === '1' &&
  process.env.OT_MANUAL_CTL_DIR !== undefined &&
  process.env.OT_MANUAL_CTL_DIR !== '' &&
  process.platform !== 'win32' &&
  !NO_LAUNCHER &&
  existsSync(FAKE_AGENT_CLI) &&
  existsSync(TUI_ENTRY);

const DEFAULT_MINUTES = 120;
/** The deadline in ms: `OT_MANUAL_MINUTES` may be fractional (a short run to check the launcher). */
function deadlineMs(): number {
  const raw = process.env.OT_MANUAL_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_MINUTES * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`OT_MANUAL_MINUTES must be a number of minutes above zero, got "${raw}"`);
  }
  return Math.round(minutes * 60_000);
}

/** The config the daemon starts with has these (the defaults, written so a person finds the keys). */
const EXTRA = [
  'ui:',
  // The setup assistant would take the screen on the first run; the roteiro starts at the three areas.
  '  setup:',
  '    open: never',
  '  mouse: full',
  '  clipboard:',
  '    copy: osc52',
  '',
].join('\n');

const suite = enabled ? describe : describe.skip;
const TEARDOWN_MARGIN_MS = 60_000;

suite('the daemon of the manual script of the terminals', () => {
  it(
    'stays up until the stop file, a signal or the deadline',
    async () => {
      const ctl = process.env.OT_MANUAL_CTL_DIR ?? '';
      const total = deadlineMs();
      const chat = await startChatDaemon(
        {
          codeHost: new FakeCodeHost(),
          clock: new FakeClock(),
          vault: new InMemorySecretVault(),
          client: (launcher, command, env) =>
            new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
        },
        { extra: EXTRA, persistConfig: true, realClock: true },
      );
      let stop = 'o prazo';
      try {
        const lines = [
          `Pasta de dados: ${chat.dataDir}`,
          `Repositório do cenário: ${chat.repo}`,
          'Para abrir a TUI, em OUTRO terminal (um comando só, a partir da raiz do repositório):',
          `  OT_DATA_DIR=${chat.dataDir} OT_CLIENT_CONFIG_DIR=${join(chat.dataDir, '..', 'client')} node ${TUI_ENTRY} tui`,
          `Configuração (ui.mouse, ui.clipboard.copy): ${join(chat.dataDir, 'config.yaml')}`,
          `Para parar: Ctrl+C aqui, ou: touch ${join(ctl, 'stop')}`,
          `Prazo: ${String(Math.round(total / 600) / 100)} min.`,
          '',
        ];
        // The file is what the script prints; stderr is the way out when the test runs by itself.
        await writeFile(join(ctl, 'info.txt'), lines.join('\n'));
        process.stderr.write(`${lines.join('\n')}\n`);

        const stopFile = join(ctl, 'stop');
        const end = Date.now() + total;
        const onSignal = (name: string) => (): void => {
          stop = name;
        };
        const onInt = onSignal('SIGINT');
        const onTerm = onSignal('SIGTERM');
        process.on('SIGINT', onInt);
        process.on('SIGTERM', onTerm);
        try {
          while (stop === 'o prazo' && Date.now() < end) {
            if (existsSync(stopFile)) stop = 'o arquivo de parada';
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        } finally {
          process.off('SIGINT', onInt);
          process.off('SIGTERM', onTerm);
        }
      } finally {
        process.stderr.write(
          `Parando o daemon de teste (${stop}) e apagando a pasta temporária.\n`,
        );
        await chat.dispose();
      }
    },
    deadlineMs() + TEARDOWN_MARGIN_MS,
  );
});
