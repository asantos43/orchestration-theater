// SPDX-License-Identifier: MPL-2.0
import { EventEmitter } from 'node:events';
import { getHeapStatistics } from 'node:v8';
import { Box, render, Text } from 'ink';
import { memo, useEffect, useState, type ReactNode } from 'react';

/**
 * A measurement, not a test: it renders about 5,000 messages with the real Ink and reads the heap
 * (decision N37, the default of `ui.runtime.maxOldSpaceMB`). It is outside the suite on purpose:
 * it takes seconds and its numbers depend on the machine. No AI model is involved: the messages are
 * made-up text, and the terminal is a stream that throws everything away.
 *
 *     pnpm exec tsc -b packages/tui
 *     node --expose-gc --max-semi-space-size=2 packages/tui/dist/measure-heap.js [messages] [updates] [window]
 *
 * `window` is how many of the last messages are drawn (0: all), what `ui.render.historyWindow` will
 * do. Add `--max-old-space-size=<MB>` to see whether it still fits in a given cap. The numbers come out
 * as one JSON object on the standard output, so the run can be pasted into a document.
 */

interface Message {
  readonly id: number;
  readonly author: string;
  readonly text: string;
}

/** A terminal of 120 x 40 that discards what it is told (but answers the write callback). */
class NullTty extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 40;
  bytes = 0;
  write(chunk: string | Uint8Array, callback?: () => void): boolean {
    this.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (callback !== undefined) setImmediate(callback);
    return true;
  }
}

class NullStdin extends EventEmitter {
  isTTY = true;
  setEncoding(): void {
    // Nothing to do.
  }
  setRawMode(): void {
    // Nothing to do.
  }
  resume(): void {
    // Nothing to do.
  }
  pause(): void {
    // Nothing to do.
  }
  ref(): void {
    // Nothing to do.
  }
  unref(): void {
    // Nothing to do.
  }
  read(): null {
    return null;
  }
}

const WORDS = (
  'the agent reads the file runs the test and writes a patch for the failing case while the ' +
  'director waits for the next decision from the owner about the scenario and the budget'
).split(' ');

/** Messages of 1 to about 6 lines on a 120-column screen, like a conversation with an agent. */
function makeMessages(count: number): Message[] {
  const messages: Message[] = [];
  for (let id = 0; id < count; id += 1) {
    const length = 20 + ((id * 37) % 90);
    const words: string[] = [];
    for (let word = 0; word < length; word += 1) {
      words.push(WORDS[(id + word * 7) % WORDS.length] ?? '');
    }
    messages.push({ id, author: id % 3 === 0 ? 'owner' : 'agent', text: words.join(' ') });
  }
  return messages;
}

const Row = memo(function Row(props: { readonly message: Message }): ReactNode {
  const { message } = props;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={message.author === 'owner' ? 'cyan' : 'green'}>
        {message.author}
      </Text>
      <Text>{message.text}</Text>
    </Box>
  );
});

function Transcript(props: { readonly messages: readonly Message[]; readonly tick: number }) {
  return (
    <Box flexDirection="column">
      <Text>{String(props.tick)}</Text>
      {props.messages.map((message) => (
        <Row key={message.id} message={message} />
      ))}
    </Box>
  );
}

/** Re-renders the transcript `updates` times (a stream of text), one after the other. */
function Driver(props: {
  readonly messages: readonly Message[];
  readonly updates: number;
  readonly onDone: () => void;
}): ReactNode {
  const [tick, setTick] = useState(0);
  const { onDone, updates } = props;
  useEffect(() => {
    if (tick >= updates) {
      onDone();
      return;
    }
    const timer = setImmediate(() => {
      setTick(tick + 1);
    });
    return () => {
      clearImmediate(timer);
    };
  }, [tick, updates, onDone]);
  return <Transcript messages={props.messages} tick={tick} />;
}

const MB = 1024 * 1024;

function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error('run with --expose-gc');
  gc();
  gc();
}

function sample(): { heapUsedMB: number; heapTotalMB: number; rssMB: number } {
  collect();
  const memory = process.memoryUsage();
  return {
    heapUsedMB: round(memory.heapUsed / MB),
    heapTotalMB: round(memory.heapTotal / MB),
    rssMB: round(memory.rss / MB),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

async function measure(count: number, updates: number, window: number): Promise<void> {
  // All the messages stay in memory; only the last `window` are drawn (0: all of them).
  const all = makeMessages(count);
  const messages = window > 0 ? all.slice(-window) : all;
  const before = sample();
  const stdout = new NullTty();
  let peakUsed = 0;
  const sampler = setInterval(() => {
    peakUsed = Math.max(peakUsed, getHeapStatistics().used_heap_size);
  }, 5);
  let unmount: () => void = () => undefined;
  const started = performance.now();
  const finished = new Promise<void>((resolve) => {
    const instance = render(
      <Driver
        messages={messages}
        updates={updates}
        onDone={() => {
          resolve();
        }}
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new NullStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        interactive: true,
      },
    );
    unmount = () => {
      instance.unmount();
    };
  });
  await finished;
  unmount();
  const elapsedMs = Math.round(performance.now() - started);
  clearInterval(sampler);
  const after = sample();
  const stats = getHeapStatistics();
  process.stdout.write(
    `${JSON.stringify(
      {
        messages: count,
        drawn: messages.length,
        updates,
        elapsedMs,
        msPerUpdate: round(elapsedMs / Math.max(updates, 1)),
        outputMB: round(stdout.bytes / MB),
        before,
        after,
        peakHeapUsedMB: round(peakUsed / MB),
        heapSizeLimitMB: round(stats.heap_size_limit / MB),
        node: process.version,
        execArgv: process.execArgv,
      },
      null,
      2,
    )}\n`,
  );
}

const count = Number(process.argv[2] ?? 5000);
const updates = Number(process.argv[3] ?? 100);
const window = Number(process.argv[4] ?? 0);
await measure(count, updates, window);
process.exit(0);
