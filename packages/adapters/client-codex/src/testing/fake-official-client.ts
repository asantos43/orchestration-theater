// SPDX-License-Identifier: MPL-2.0
// The same file lives in the three client adapters (`adapter-isolation` forbids sharing it): keep
// the copies identical. Tests of this package only; not exported by it.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A program that imitates what the official login of a client prints and does, so the tests run the
 * whole flow without any real client, account or browser. It is run as
 * `node <script> <HOME_VARIABLE> <command>`: `HOME_VARIABLE` names the environment variable that
 * points the "client" at the profile directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`),
 * `command` is one of `login`, `logout`, `status-json`, `status-count`, `status-garbage`.
 *
 * The "login" it keeps is a marker file of its own in that directory: it is the fake client's state,
 * not a credential, and no test reads it (the tests ask the probe, which is what a real login would
 * be read through). The scenario is chosen by `FAKE_SCENARIO` in the environment of the process:
 * `browser`, `callback-first`, `device`, `terminal`, `quiet`, `silent`, `fail`, `hang`, `paste`; `FAKE_DELAY_MS`
 * (default 120) is how long the "user" takes to sign in. `paste` prints the URL and then waits for
 * a code on its standard input, like Claude Code: `good-code#state` signs in, anything else fails.
 * `callback-first` prints its callback server on this machine before the sign-in URL, like Codex.
 */
export const FAKE_CLIENT_SOURCE = String.raw`
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [homeVariable, command] = process.argv.slice(2);
const home = process.env[homeVariable];
if (home === undefined || home === '') {
  process.stderr.write('fake client: ' + homeVariable + ' is not set\n');
  process.exit(3);
}
const marker = join(home, 'fake-client-session.state');
const scenario = process.env.FAKE_SCENARIO ?? 'browser';
const delay = Number(process.env.FAKE_DELAY_MS ?? 120);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => process.stdout.write(text);

async function login() {
  mkdirSync(home, { recursive: true });
  if (scenario === 'fail') {
    process.stderr.write('Login failed: access denied\n');
    process.exit(1);
  }
  if (scenario === 'browser' || scenario === 'hang') {
    say('\u001b[1mOpen this URL to sign in:\u001b[0m\n');
    await wait(20);
    say('https://auth.example.test/authorize?state=abc123.\n');
  } else if (scenario === 'callback-first') {
    say('Starting local login server on http://localhost:1455.\n');
    await wait(30);
    say('If your browser did not open, navigate to this URL to authenticate:\n\n');
    say('https://auth.example.test/oauth/authorize?state=abc123\n');
  } else if (scenario === 'device') {
    say('Visit https://auth.example.test/device\n');
    await wait(20);
    say('and enter the code ABCD-1234\n');
  } else if (scenario === 'terminal') {
    say('Select a provider (use the arrow keys)\n');
  }
  if (scenario === 'paste') {
    say('If the browser did not open, visit: https://auth.example.test/authorize?state=abc123\n');
    say('Paste code here if prompted > ');
    let typed = '';
    for await (const chunk of process.stdin) {
      typed += String(chunk);
      if (typed.includes('\n')) break;
    }
    if (typed.split('\n')[0] !== 'good-code#state') {
      process.stderr.write("Login failed: That code wasn't accepted.\n");
      process.exit(1);
    }
    writeFileSync(marker, 'signed-in\n');
    say('Logged in\n');
    process.exit(0);
  }
  if (scenario === 'hang') {
    setInterval(() => undefined, 1000);
    return;
  }
  await wait(scenario === 'quiet' ? Math.max(delay, 400) : delay);
  writeFileSync(marker, 'signed-in\n');
  say('Logged in\n');
}

switch (command) {
  case 'login':
    await login();
    break;
  case 'logout':
    if (scenario === 'logout-fail') {
      process.stderr.write('Logout failed\n');
      process.exit(2);
    }
    rmSync(marker, { force: true });
    say('Logged out\n');
    break;
  case 'status-json':
    say(JSON.stringify({ loggedIn: existsSync(marker) }) + '\n');
    process.exit(existsSync(marker) ? 0 : 1);
    break;
  case 'status-count':
    say('Credentials\n' + (existsSync(marker) ? '1 credentials\n' : '0 credentials\n'));
    break;
  case 'status-garbage':
    say('something else entirely\n');
    break;
  default:
    process.stderr.write('fake client: unknown command ' + String(command) + '\n');
    process.exit(4);
}
`;

/** Writes the fake client into `dir` and returns the command that runs `command` of it. */
export async function writeFakeClient(
  dir: string,
  homeVariable: string,
): Promise<(command: string) => { cmd: string; args: string[] }> {
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'fake-official-client.mjs');
  await writeFile(script, FAKE_CLIENT_SOURCE);
  return (command) => ({ cmd: process.execPath, args: [script, homeVariable, command] });
}
