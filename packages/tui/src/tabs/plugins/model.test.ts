// SPDX-License-Identifier: MPL-2.0
import type { ApiPanelBlock, ApiPlugin, PluginActionResult } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { cellWidth } from '../../layout/text.js';
import {
  RESULT_TEXT_MAX,
  UNREADABLE_BLOCK,
  actionResultLines,
  activationRows,
  cellText,
  columnWidths,
  missingSecretsOf,
  panelView,
  safeText,
  secretCommand,
  secretRows,
  stateOf,
  type Translate,
} from './model.js';

/** A `t` that shows the key and the options, so a test reads what was asked for. */
const t: Translate = (key, options) => {
  const params = Object.entries(options ?? {})
    .filter(([name]) => name !== 'defaultValue')
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(' ');
  return params === '' ? key : `${key} ${params}`;
};

function plugin(overrides: Partial<ApiPlugin> = {}): ApiPlugin {
  return {
    id: 'notes',
    version: '1.0.0',
    origin: 'path:/plugins/notes',
    description: null,
    manifestHash: 'a'.repeat(64),
    problem: null,
    projects: [],
    ...overrides,
  };
}

const NO_DATA = { source: 'list_notes', error: null, truncated: null } as const;

describe('safeText', () => {
  it('takes escape sequences, controls and line breaks out of what a plugin says', () => {
    expect(safeText('\u001b[31mred\u001b[0m')).toBe('red');
    expect(safeText('a\u001b]0;title\u0007b')).toBe('ab');
    expect(safeText('one\ntwo\tthree\r\nfour')).toBe('one two three four');
    expect(safeText('bell\u0007 and nul\u0000 and csi\u009b31m')).toBe('bell and nul and csi31m');
    expect(safeText('  spaced   out  ')).toBe('spaced out');
  });
});

describe('cellText', () => {
  it('draws any JSON value as one safe line', () => {
    expect(cellText(null)).toBe('');
    expect(cellText('plain')).toBe('plain');
    expect(cellText(12)).toBe('12');
    expect(cellText(false)).toBe('false');
    expect(cellText({ a: 1, b: ['x'] })).toBe('{"a":1,"b":["x"]}');
    expect(cellText('x\u001b[2Jy')).toBe('xy');
  });
});

describe('stateOf', () => {
  it('reads the state of the plugin in the project, and off without one', () => {
    const entry = plugin({
      projects: [
        { project: 'S1', state: 'active' },
        { project: 'S2', state: 'needs_approval' },
      ],
    });
    expect(stateOf(entry, 'S1')).toBe('active');
    expect(stateOf(entry, 'S2')).toBe('needs_approval');
    expect(stateOf(entry, 'S3')).toBe('off');
    expect(stateOf(entry, undefined)).toBe('off');
  });

  it('is broken whenever the folder cannot be used', () => {
    const entry = plugin({ problem: 'missing', projects: [{ project: 'S1', state: 'active' }] });
    expect(stateOf(entry, 'S1')).toBe('broken');
  });
});

describe('columnWidths', () => {
  it('keeps the natural widths when they fit', () => {
    expect(columnWidths([3, 10, 8], 40)).toEqual([3, 10, 8]);
  });

  it('narrows the widest column first until the row fits', () => {
    const widths = columnWidths([3, 60, 20], 40);
    expect(widths.reduce((sum, width) => sum + width, 0) + 4).toBeLessThanOrEqual(40);
    expect(widths[0]).toBe(3);
    expect(widths[1]).toBeLessThan(60);
    expect(widths[2]).toBeLessThanOrEqual(20);
  });

  it('stops at a small floor instead of looping when there is no room at all', () => {
    expect(columnWidths([20, 20, 20, 20], 5).every((width) => width >= 1)).toBe(true);
  });
});

describe('panelView', () => {
  const table: ApiPanelBlock = {
    type: 'table',
    title: 'Notes',
    ...NO_DATA,
    columns: [
      { key: 'id', label: '#' },
      { key: 'text', label: 'Note' },
    ],
    rows: [
      { id: 1, text: 'first note' },
      { id: 2, text: 'second \u001b[31mnote\u001b[0m' },
    ],
  };

  it('draws a table as a title, a header and one line per row, inside the width', () => {
    const view = panelView({ blocks: [table] }, 30, t);
    expect(view.lines.map((line) => line.tone)).toEqual(['title', 'head', 'text', 'text']);
    expect(view.lines[0]?.text).toBe('Notes');
    expect(view.lines[1]?.text).toContain('Note');
    expect(view.lines[3]?.text).toContain('second note');
    for (const line of view.lines) expect(cellWidth(line.text)).toBeLessThanOrEqual(30);
  });

  it('cuts a cell that does not fit with an ellipsis and keeps the other columns', () => {
    const wide: ApiPanelBlock = {
      ...table,
      type: 'table',
      rows: [{ id: 1, text: 'x'.repeat(200) }],
    };
    const view = panelView({ blocks: [wide] }, 24, t);
    const row = view.lines[2]?.text ?? '';
    expect(cellWidth(row)).toBeLessThanOrEqual(24);
    expect(row.startsWith('1')).toBe(true);
    expect(row).toContain('…');
  });

  it('draws a list, metrics, and an empty block as such', () => {
    const view = panelView(
      {
        blocks: [
          { type: 'list', title: 'Todo', ...NO_DATA, items: ['a', { b: 2 }] },
          { type: 'metrics', title: 'Stats', ...NO_DATA, metrics: [{ key: 'count', value: 3 }] },
          { type: 'list', title: 'None', ...NO_DATA, items: [] },
        ],
      },
      40,
      t,
    );
    const texts = view.lines.map((line) => line.text);
    expect(texts).toContain('• a');
    expect(texts).toContain('• {"b":2}');
    expect(texts).toContain('count: 3');
    expect(texts).toContain('plugins.block.empty');
  });

  it('says why a block has no data, with the code of the daemon, and no rows', () => {
    const view = panelView(
      {
        blocks: [
          {
            ...table,
            error: { code: 'plugin_timeout', message: 'took too long\u001b[2J' },
          },
        ],
      },
      40,
      t,
    );
    expect(view.lines.map((line) => line.tone)).toEqual(['title', 'warn']);
    expect(view.lines[1]?.text).toContain('plugins.errorCode.plugin_timeout');
    expect(view.lines[1]?.text).toContain('took too long');
    expect(view.lines[1]?.text).not.toContain('\u001b');
  });

  it('says that the data was cut, with what stayed, what came and the limit', () => {
    const view = panelView(
      {
        blocks: [
          { ...table, truncated: { reason: 'rows', total: 500, kept: 100, limit: 100 } },
          {
            type: 'list',
            title: 'Big',
            ...NO_DATA,
            items: [],
            truncated: { reason: 'bytes', total: 90_000, kept: 0, limit: 65_536 },
          },
        ],
      },
      40,
      t,
    );
    const texts = view.lines.map((line) => line.text);
    expect(texts).toContain('plugins.block.cutRows kept=100 total=500 limit=100');
    expect(texts).toContain('plugins.block.cutBytes kept=0 total=90000 limit=65536');
  });

  it('lists the action blocks in order and leaves their line for the screen to draw', () => {
    const view = panelView(
      {
        blocks: [
          { type: 'action', label: 'Delete all', tool: 'clear_notes', approval: 'manifest' },
          table,
          { type: 'action', label: 'Refresh', tool: 'refresh', approval: 'none' },
        ],
      },
      40,
      t,
    );
    expect(view.actions).toEqual([
      { label: 'Delete all', tool: 'clear_notes', approval: 'manifest' },
      { label: 'Refresh', tool: 'refresh', approval: 'none' },
    ]);
    expect(view.lines.filter((line) => line.tone === 'action').map((line) => line.action)).toEqual([
      0, 1,
    ]);
  });

  it('turns a block it cannot read into one line and draws the rest', () => {
    const odd = { type: 'gauge', title: 'New kind' } as unknown as ApiPanelBlock;
    const broken = { type: 'table', title: 'No rows' } as unknown as ApiPanelBlock;
    const view = panelView({ blocks: [UNREADABLE_BLOCK, odd, broken, table] }, 40, t);
    const texts = view.lines.map((line) => line.text);
    expect(texts.filter((text) => text === 'plugins.block.unreadable')).toHaveLength(3);
    expect(texts).toContain('Notes');
    expect(view.actions).toEqual([]);
  });

  it('says so when the manifest declares no panel', () => {
    expect(panelView({ blocks: [] }, 40, t).lines.map((line) => line.text)).toEqual([
      'plugins.panel.noBlocks',
    ]);
  });
});

describe('actionResultLines', () => {
  const base: PluginActionResult = {
    plugin: 'notes',
    project: 'S1',
    tool: 'clear_notes',
    ok: true,
    result: null,
    truncated: null,
    error: null,
  };

  it('says it was done, with the answer when there is one', () => {
    expect(actionResultLines('Delete all', base, t)).toEqual([
      { tone: 'ok', text: 'plugins.action.done action=Delete all' },
    ]);
    expect(actionResultLines('Delete all', { ...base, result: { deleted: 3 } }, t)).toEqual([
      { tone: 'ok', text: 'plugins.action.doneWith action=Delete all result={"deleted":3}' },
    ]);
  });

  it('cuts a long answer and takes the escapes out of it', () => {
    const [line] = actionResultLines(
      'Go',
      { ...base, result: `\u001b[31m${'x'.repeat(RESULT_TEXT_MAX * 2)}` },
      t,
    );
    expect(line?.text).toContain('…');
    expect(line?.text).not.toContain('\u001b');
    expect(line?.text.length).toBeLessThan(RESULT_TEXT_MAX + 80);
  });

  it('says the code of the failure, and that an answer was too big to show', () => {
    expect(
      actionResultLines(
        'Go',
        { ...base, ok: false, error: { code: 'tool_error', message: 'boom' } },
        t,
      ),
    ).toEqual([
      {
        tone: 'error',
        text: 'plugins.action.failed action=Go code=plugins.errorCode.tool_error message=boom',
      },
    ]);
    expect(
      actionResultLines(
        'Go',
        { ...base, truncated: { reason: 'bytes', total: 9, kept: 0, limit: 1 } },
        t,
      ),
    ).toEqual([{ tone: 'warn', text: 'plugins.action.tooBig action=Go' }]);
  });
});

describe('secrets', () => {
  it('names the command that sets a secret, with the project when there is one', () => {
    expect(secretCommand('notes', 'API_KEY', 'S1')).toBe(
      'ot plugin secret set notes API_KEY --project S1',
    );
    expect(secretCommand('notes', 'API_KEY', undefined)).toBe('ot plugin secret set notes API_KEY');
  });

  it('lists the declared names and the ones an event named, the missing first', () => {
    const detail = { summary: { secrets: ['B_KEY', 'A_KEY'] } } as never;
    expect(secretRows(detail, ['C_KEY', 'A_KEY'])).toEqual([
      { name: 'A_KEY', missing: true },
      { name: 'C_KEY', missing: true },
      { name: 'B_KEY', missing: false },
    ]);
    expect(secretRows(undefined, [])).toEqual([]);
  });

  it('reads the names of a plugin.secret_missing payload and nothing else', () => {
    expect(
      missingSecretsOf({ plugin: 'notes', project: 'S1', secrets: ['A_KEY', 'bad name', 3] }),
    ).toEqual({ plugin: 'notes', project: 'S1', secrets: ['A_KEY'] });
    expect(missingSecretsOf({ plugin: 'notes' })).toBeUndefined();
    expect(missingSecretsOf(null)).toBeUndefined();
  });
});

describe('activationRows', () => {
  it('wraps each line of the text of the daemon to the width, none cut, and clean', () => {
    const rows = activationRows(
      { activation: ['Runs a program: node dist/server.js --flag --other', 'ok\u001b[0m'] },
      20,
    );
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(cellWidth(row)).toBeLessThanOrEqual(20);
    expect(rows.join(' ')).toContain('--other');
    expect(rows.join('')).not.toContain('\u001b');
  });
});
