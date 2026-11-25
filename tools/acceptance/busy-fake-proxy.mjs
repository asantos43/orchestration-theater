// SPDX-License-Identifier: MPL-2.0
//
// Test-only stdio proxy between the daemon and the fake agent, for tools/acceptance/busy-fake.sh
// (N303 (3)). The fake agent answers a prompt at once, so on its own no attempt is ever "in progress"
// when the update is asked for. This proxy holds the FIRST `session/prompt` of a session whose cwd is a
// worktree for <hold-ms>, so the attempt stays busy; a `session/cancel` (the park of the update) answers
// the held turn with `cancelled` at once. Everything else goes through unchanged, except one rewrite:
// the fake agent has no `acceptEdits` mode, so `session/set_config_option` `mode: acceptEdits` becomes
// `default` (the real Claude Code takes `acceptEdits`).
//
// One hold per data folder: each mode of the run (idle, park) has its own data folder, and the hold
// flag and the state of the role-play are kept per data folder (the part of the cwd before
// `/worktrees/`), so the second mode is held too and does not see the counts of the first.
//
//   node busy-fake-proxy.mjs <hold-ms> <state-root> <fake-agent cli.js>
//
// It writes nothing but the flag and the state of the fake agent under <state-root>, and logs nothing.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const [holdArg, stateRoot, cli] = process.argv.slice(2);
const holdMs = Number(holdArg);
if (!Number.isInteger(holdMs) || holdMs < 0 || stateRoot === undefined || cli === undefined) {
  process.stderr.write('usage: busy-fake-proxy.mjs <hold-ms> <state-root> <fake-agent cli.js>\n');
  process.exit(2);
}

const marker = `${path.sep}worktrees${path.sep}`;
const cwd = process.cwd();
const at = cwd.indexOf(marker);
// The data folder of the session (or the cwd when it is not in a worktree), as a short name.
const scope = createHash('sha256')
  .update(at === -1 ? cwd : cwd.slice(0, at))
  .digest('hex')
  .slice(0, 16);
const scopeDir = path.join(stateRoot, scope);
mkdirSync(path.join(scopeDir, 'role-play'), { recursive: true });
const flag = path.join(scopeDir, 'held');
const holds = at !== -1 && !existsSync(flag);

const child = spawn(process.execPath, [cli], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, FAKE_AGENT_STATE_DIR: path.join(scopeDir, 'role-play') },
});
child.stdout.pipe(process.stdout);
child.on('exit', (code) => process.exit(code ?? 0));

/** @type {{ id: unknown; line: string; timer: NodeJS.Timeout } | undefined} */
let held;
const release = () => {
  if (held === undefined) return;
  clearTimeout(held.timer);
  child.stdin.write(`${held.line}\n`);
  held = undefined;
};

const lines = createInterface({ input: process.stdin });
lines.on('line', (raw) => {
  let line = raw;
  /** @type {{ id?: unknown; method?: unknown; params?: { configId?: unknown; value?: unknown } }} */
  let message;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- a plain script: the JSDoc type above is the shape it reads
    message = JSON.parse(line);
  } catch {
    child.stdin.write(`${line}\n`);
    return;
  }
  if (
    message.method === 'session/set_config_option' &&
    message.params?.configId === 'mode' &&
    message.params.value === 'acceptEdits'
  ) {
    message.params.value = 'default';
    line = JSON.stringify(message);
  }
  if (holds && held === undefined && !existsSync(flag) && message.method === 'session/prompt') {
    writeFileSync(flag, 'held\n');
    held = { id: message.id, line, timer: setTimeout(release, holdMs) };
    return;
  }
  if (held !== undefined && message.method === 'session/cancel') {
    clearTimeout(held.timer);
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: held.id, result: { stopReason: 'cancelled' } })}\n`,
    );
    held = undefined;
  }
  child.stdin.write(`${line}\n`);
});
lines.on('close', () => {
  child.kill('SIGKILL');
  process.exit(0);
});
