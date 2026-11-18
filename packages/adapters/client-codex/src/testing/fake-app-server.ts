// SPDX-License-Identifier: MPL-2.0
// Tests of this package only; not exported by it.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A program that speaks the part of the `codex app-server` protocol the quota probe uses (JSON-RPC,
 * one JSON object per line on stdio; the shapes are the ones of `app-server-types.ts`), so the tests
 * run the whole conversation without the real client, an account or the network. It never opens a
 * credential file. Run as `node <script>`; the scenario comes from `FAKE_APP_SCENARIO`:
 *
 * - `ok`: `initialize`, then `account/rateLimits/read` answers the windows of a Plus account
 *   (primary 300 min, secondary 10080 min, resets in epoch seconds).
 * - `sparse`: as `ok`, then after `FAKE_UPDATE_MS` pushes `account/rateLimits/updated` with only the
 *   primary window (and the plan left out), and once more with the secondary one.
 * - `noauth`: the read is refused with the JSON-RPC error `-32000` "Authentication required".
 * - `noauth-exit`: says "Authentication required" on stderr and exits 1 before answering.
 * - `hang`: answers `initialize` and never answers the read; it starts a child that also never ends,
 *   its pid written to `FAKE_CHILD_PID_FILE`.
 * - `garbage`: lines that are not JSON around the right answers.
 * - `reached`: the limit is reported reached with no window at 100%.
 * - `empty`: both windows are `null`.
 * - `shape`: the answer has an unknown shape.
 *
 * Every request and notification the program receives is appended (method name, one per line) to
 * `FAKE_LOG` when it is set, together with `CODEX_HOME=<value>` and `CWD=<value>` on start, so a
 * test can assert what was asked and where.
 */
export const FAKE_APP_SERVER_SOURCE = String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const scenario = process.env.FAKE_APP_SCENARIO ?? 'ok';
const log = (line) => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, line + '\n'); };
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const updateMs = Number(process.env.FAKE_UPDATE_MS ?? 60);

log('CODEX_HOME=' + (process.env.CODEX_HOME ?? ''));
log('CWD=' + process.cwd());

const RESET_5H = 1900000000;
const RESET_7D = 1900400000;
const snapshot = (over = {}) => ({
  limitId: 'codex', limitName: null, normalModelSlug: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: RESET_5H },
  secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: RESET_7D },
  credits: null, individualLimit: null, spendControlReached: null,
  planType: 'plus', rateLimitReachedType: null,
  ...over,
});
const response = (rateLimits) => ({
  ordinaryUsageAllowed: true, rateLimits, rateLimitsByLimitId: { codex: rateLimits },
  rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
});

if (scenario === 'noauth-exit') {
  process.stderr.write('Authentication required: run codex login\n');
  process.exit(1);
}
if (scenario === 'garbage') process.stdout.write('this is not json\n{"half"\n');
if (scenario === 'hang' && process.env.FAKE_CHILD_PID_FILE) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  log(message.method ?? 'answer');
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-app-server/0.0.0', codexHome: process.env.CODEX_HOME } });
    return;
  }
  if (message.method !== 'account/rateLimits/read') return;
  if (scenario === 'hang') return;
  if (scenario === 'noauth') {
    send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
    return;
  }
  if (scenario === 'empty') {
    send({ id: message.id, result: response(snapshot({ primary: null, secondary: null })) });
    return;
  }
  if (scenario === 'shape') {
    send({ id: message.id, result: { something: 'else' } });
    return;
  }
  if (scenario === 'reached') {
    send({ id: message.id, result: response(snapshot({
      primary: null, secondary: null, rateLimitReachedType: 'workspace_member_credits_depleted',
    })) });
    return;
  }
  send({ id: message.id, result: response(snapshot()) });
  if (scenario === 'sparse') {
    setTimeout(() => send({ method: 'account/rateLimits/updated', params: { rateLimits: {
      limitId: 'codex', primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: RESET_5H + 60 },
      secondary: null, planType: null, rateLimitReachedType: null,
    } } }), updateMs);
    setTimeout(() => send({ method: 'account/rateLimits/updated', params: { rateLimits: {
      limitId: 'codex', primary: null,
      secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: RESET_7D },
      planType: null, rateLimitReachedType: null,
    } } }), updateMs * 3);
  }
});
`;

/** The reset times the fake app-server reports, in epoch seconds. */
export const FAKE_RESET_5H = 1_900_000_000;
export const FAKE_RESET_7D = 1_900_400_000;

/** Writes the fake app-server in `dir` and returns the command that runs it. */
export async function writeFakeAppServer(
  dir: string,
): Promise<{ cmd: string; args: readonly string[] }> {
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'fake-app-server.mjs');
  await writeFile(script, FAKE_APP_SERVER_SOURCE);
  return { cmd: process.execPath, args: [script] };
}
