import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { HELP, parseArgs } from './args.js';
import { createInput } from './input.js';
import { disableMouse, enableMouse, installMouseCleanup } from './mouse.js';

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('É preciso um terminal interativo (stdin e stdout em TTY).');
  process.exit(1);
}

installMouseCleanup();
const input = createInput(args.input, process.stdin);
const app = render(<App screen={args.screen} mouse={args.mouse} bus={input.bus} />, { stdin: input.stdin, alternateScreen: true, exitOnCtrlC: true, patchConsole: false });
enableMouse(args.mouse);
const done = (code: number) => { disableMouse(); input.dispose(); process.exit(code); };
app.waitUntilExit().then(() => done(0), () => done(1));
