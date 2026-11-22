// SPDX-License-Identifier: MPL-2.0
import { Box, Text, useInput, type DOMElement } from 'ink';
import { useRef } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_UI_SETTINGS } from '../settings.js';
import { MouseLayer } from './provider.js';
import { sgrReport } from './sgr.js';
import { ClickTarget, MouseModalScope, useMouseTarget, type ClickTargetProps } from './target.js';
import type { LocalPoint } from './registry.js';

/**
 * The hit-test over a real Ink tree: where a box is now, with the part that a box around it hides
 * cut away, and a scroll (a negative margin) counted in.
 */

afterEach(cleanup);

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

function mount(tree: (onClick: (point: LocalPoint) => void) => React.ReactNode) {
  const clicks: LocalPoint[] = [];
  const view = render(
    <MouseLayer
      mode="full"
      copy="off"
      tuning={DEFAULT_UI_SETTINGS.tuiMouse}
      terminal={{ write: () => undefined }}
    >
      <Keys />
      {tree((point) => clicks.push(point))}
    </MouseLayer>,
  );
  const click = async (col: number, row: number): Promise<void> => {
    view.stdin.write(sgrReport({ action: 'press', button: 'left', col, row }));
    await settle();
    view.stdin.write(sgrReport({ action: 'release', button: 'left', col, row }));
    await settle();
  };
  return { clicks, click, settle };
}

/** What the app always has: something that reads the keyboard, so Ink listens to the input. */
function Keys(): null {
  useInput(() => undefined);
  return null;
}

const lines = (count: number): React.ReactNode =>
  Array.from({ length: count }, (_, index) => <Text key={index}>{`line ${String(index)}`}</Text>);

describe('the hit-test', () => {
  it('finds a box by its cells and gives the point inside it', async () => {
    const view = mount((onClick) => (
      <Box flexDirection="column">
        <Text>header</Text>
        <ClickTarget marginLeft={4} width={6} height={2} onClick={onClick}>
          <Text>{'ab\ncd'}</Text>
        </ClickTarget>
      </Box>
    ));
    await view.settle();
    await view.click(5, 2);
    await view.click(0, 2);
    await view.click(5, 4);
    expect(view.clicks).toEqual([{ x: 1, y: 1, col: 5, row: 2 }]);
  });

  it('discounts the scroll and the part a box around it hides', async () => {
    // A window of 3 rows (the rows 1 to 3 of the screen) over a target of 6 rows scrolled by 2:
    // its rows 0 and 1 are above the window and its rows 5 to 7 would be under the text below it.
    const view = mount((onClick) => (
      <Box flexDirection="column">
        <Text>top</Text>
        <Box height={3} overflow="hidden" flexDirection="column">
          <Box marginTop={-2} flexDirection="column">
            <ClickTarget height={6} onClick={onClick}>
              <Text>{lines(6)}</Text>
            </ClickTarget>
          </Box>
        </Box>
        <Text>bottom</Text>
      </Box>
    ));
    await view.settle();
    await view.click(1, 0);
    await view.click(1, 4);
    expect(view.clicks).toEqual([]);
    // The first row of the window is the row 2 of the target, and the last one its row 4.
    await view.click(1, 1);
    await view.click(1, 3);
    expect(view.clicks.map((point) => point.y)).toEqual([2, 4]);
  });

  it('lets an overlay take the clicks from what is behind it', async () => {
    const view = mount((onClick) => (
      <Box flexDirection="column">
        <ClickTarget onClick={onClick}>
          <Text>behind</Text>
        </ClickTarget>
        <MouseModalScope>
          <Text>overlay</Text>
        </MouseModalScope>
      </Box>
    ));
    await view.settle();
    await view.click(1, 0);
    expect(view.clicks).toEqual([]);
  });

  it('ignores a target that is off', async () => {
    const props: Omit<ClickTargetProps, 'onClick'> = { enabled: false };
    const view = mount((onClick) => (
      <ClickTarget {...props} onClick={onClick}>
        <Text>off</Text>
      </ClickTarget>
    ));
    await view.settle();
    await view.click(1, 0);
    expect(view.clicks).toEqual([]);
  });
});

describe('the press of an area', () => {
  function Area(props: {
    readonly onPress: (point: LocalPoint) => void;
    readonly enabled?: boolean;
    readonly children?: React.ReactNode;
  }): React.ReactNode {
    const ref = useRef<DOMElement>(null);
    useMouseTarget(ref, { onPress: props.onPress }, { enabled: props.enabled });
    return (
      <Box ref={ref} flexDirection="column" width={20} height={4}>
        {props.children}
      </Box>
    );
  }

  it('is told with the point of the press, and the target inside gets its click anyway', async () => {
    const presses: LocalPoint[] = [];
    const view = mount((onClick) => (
      <Area onPress={(point) => presses.push(point)}>
        <ClickTarget marginLeft={2} width={6} height={1} onClick={onClick}>
          <Text>inner</Text>
        </ClickTarget>
      </Area>
    ));
    await view.settle();
    await view.click(3, 0);
    expect(presses).toEqual([{ x: 3, y: 0, col: 3, row: 0 }]);
    expect(view.clicks).toEqual([{ x: 1, y: 0, col: 3, row: 0 }]);
    // On the area, outside the inner target: only the press.
    await view.click(15, 2);
    expect(presses).toHaveLength(2);
    expect(view.clicks).toHaveLength(1);
    // Outside the area: neither.
    await view.click(30, 2);
    expect(presses).toHaveLength(2);
  });

  it('goes to every area that shows the cell, nested ones included', async () => {
    const order: string[] = [];
    const view = mount(() => (
      <Area onPress={() => order.push('outer')}>
        <Area onPress={() => order.push('inner')} />
      </Area>
    ));
    await view.settle();
    await view.click(1, 1);
    expect(order.sort()).toEqual(['inner', 'outer']);
  });

  it('is not told while an overlay is open, nor when the area is off', async () => {
    const presses: string[] = [];
    const view = mount(() => (
      <Box flexDirection="column">
        <Area onPress={() => presses.push('off')} enabled={false} />
        <Area onPress={() => presses.push('behind')} />
        <MouseModalScope>
          <Text>overlay</Text>
        </MouseModalScope>
      </Box>
    ));
    await view.settle();
    await view.click(1, 5);
    await view.click(1, 1);
    expect(presses).toEqual([]);
  });
});
