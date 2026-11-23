// SPDX-License-Identifier: MPL-2.0
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useChalkLevel, type ChalkLevel } from '../color.test-support.js';
import type { ThemeMode } from '../settings.js';
import { ThemeProvider } from './theme-context.js';
import { TOKEN } from './theme.js';
import { Text } from './themed-text.js';

let restore: (() => void) | undefined;
beforeAll(async () => {
  restore = await useChalkLevel(3);
});
afterAll(() => {
  restore?.();
});

function raw(mode: ThemeMode, node: ReactNode): string {
  const view = render(
    <ThemeProvider mode={mode}>
      <Box>{node}</Box>
    </ThemeProvider>,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

describe('the Text of the theme', () => {
  it('otheater: a role is the hex colour of the mockup', () => {
    expect(raw('otheater', <Text color={TOKEN.ok}>x</Text>)).toContain('\x1b[38;2;79;201;143m');
    expect(raw('otheater', <Text color={TOKEN.warn}>x</Text>)).toContain('\x1b[38;2;232;169;72m');
  });

  it('terminal: a role is the named colour', () => {
    expect(raw('terminal', <Text color={TOKEN.ok}>x</Text>)).toContain('\x1b[32m');
    expect(raw('terminal', <Text color={TOKEN.borderActive}>x</Text>)).toContain('\x1b[94m');
  });

  it('otheater: dim is a colour, not the SGR dim; terminal keeps the SGR dim', () => {
    const themed = raw('otheater', <Text dimColor>x</Text>);
    expect(themed).toContain('\x1b[38;2;107;115;128m');
    expect(themed).not.toContain('\x1b[2m');
    expect(
      raw(
        'otheater',
        <Text dimColor hint>
          x
        </Text>,
      ),
    ).toContain('\x1b[38;2;154;163;175m');
    const plain = raw('terminal', <Text dimColor>x</Text>);
    expect(plain).toContain('\x1b[2m');
    expect(plain).not.toContain('38;2;');
  });

  it('otheater: dim with its own colour is the faded one (the seven-day bars)', () => {
    expect(
      raw(
        'otheater',
        <Text color={TOKEN.ok} dimColor>
          x
        </Text>,
      ),
    ).toContain('\x1b[38;2;54;129;96m');
    expect(
      raw(
        'terminal',
        <Text color={TOKEN.ok} dimColor>
          x
        </Text>,
      ),
    ).toContain('\x1b[2m');
  });

  it('the row under the cursor: the background of the selection, or inverse', () => {
    expect(raw('otheater', <Text selection>x</Text>)).toContain('\x1b[48;2;35;42;68m');
    expect(raw('otheater', <Text selection>x</Text>)).not.toContain('\x1b[7m');
    expect(raw('terminal', <Text selection>x</Text>)).toContain('\x1b[7m');
    expect(raw('terminal', <Text selection>x</Text>)).not.toContain('48;2;');
  });

  it('the caret: a light block, or inverse', () => {
    expect(raw('otheater', <Text caret>x</Text>)).toContain('\x1b[48;2;201;206;214m');
    expect(raw('terminal', <Text caret>x</Text>)).toContain('\x1b[7m');
  });

  it('the text of the screen has the colour of the mockup in otheater only', () => {
    expect(raw('otheater', <Text>x</Text>)).toContain('\x1b[38;2;201;206;214m');
    expect(raw('terminal', <Text>x</Text>)).toBe('x');
  });

  it('a nested text keeps the colour of its parent', () => {
    const frame = raw(
      'otheater',
      <Text color={TOKEN.warn}>
        a<Text bold>b</Text>
      </Text>,
    );
    expect(frame).not.toContain('38;2;230;232;236');
  });

  it('chalk lowers the hex to 256 and 16 colours when the terminal has less than truecolor', async () => {
    for (const [level, code] of [
      [2, /\[38;5;\d+m/],
      [1, /\[(?:3|9)\dm/],
    ] as [ChalkLevel, RegExp][]) {
      const back = await useChalkLevel(level);
      const frame = raw('otheater', <Text color={TOKEN.ok}>x</Text>);
      back();
      expect(frame, `level ${String(level)}`).toMatch(code);
      expect(frame).not.toContain('38;2;');
    }
  });
});
