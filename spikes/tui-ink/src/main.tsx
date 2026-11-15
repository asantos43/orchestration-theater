import React from 'react';
import { render } from 'ink';
import { parseArgs } from './args.js';
import { App } from './App.js';
import { ChatModel, TrajModel, Store, Generator, buildHistory, makeStep, randomText, clock } from './model.js';
import { mulberry32 } from './prng.js';
import { startTrace, trace } from './trace.js';
import { hooks } from './flush.js';

const args = parseArgs(process.argv.slice(2));
if (args.trace) startTrace(args.trace);
Store.COALESCE_MS = args.coalesce;
Store.USER_NOW = args.keyRender === 'flush';
const chat = new ChatModel();
const traj = new TrajModel();
chat.historyWindow = args.historyWindow;

if (args.scenario === 'history') {
  const h = buildHistory(args.messages, args.steps, args.seed);
  chat.bulk(h.msgs);
  traj.bulk(h.steps);
} else {
  const rnd = mulberry32(args.seed + 7);
  chat.bulk([
    { id: 0, role: 'you', time: clock(0), text: 'Quero login OAuth com Google e GitHub na API, com testes de ponta a ponta.' },
    { id: 1, role: 'orq', time: clock(3), text: randomText(rnd, 120) },
  ]);
  traj.bulk(Array.from({ length: 12 }, (_, i) => makeStep(rnd, i + 1)));
}

const gen = new Generator(chat, traj, args.seed, args.scenario === 'stream' ? args.rate : 0, args.duration);

const app = render(
  <App chat={chat} traj={traj} memoMode={args.memo} inputKind={args.input} scenario={args.scenario} rate={args.rate} genDone={() => gen.done} />,
  { alternateScreen: args.alt, incrementalRendering: args.incremental, maxFps: args.maxFps, exitOnCtrlC: true, patchConsole: false, onRender: args.trace ? ({ renderTime }) => trace({ k: 'r', ms: Math.round(renderTime * 100) / 100 }) : undefined },
);
if (args.keyRender === 'flush') hooks.flush = () => { void app.waitUntilRenderFlush(); };
gen.start(() => chat.refresh());
app.waitUntilExit().then(() => { gen.stop(); process.exit(0); });
