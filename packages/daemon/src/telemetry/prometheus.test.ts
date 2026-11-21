// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  PROMETHEUS_CONTENT_TYPE,
  escapeHelp,
  escapeLabelValue,
  formatValue,
  renderPrometheus,
} from './prometheus.js';

describe('Prometheus text format 0.0.4', () => {
  it('says its content type', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('renders HELP, TYPE and the samples, ending with a line feed', () => {
    const text = renderPrometheus([
      {
        name: 'otheater_scheduler_queue_depth',
        help: 'Items waiting.',
        type: 'gauge',
        samples: [
          { labels: { queue: 'prompts' }, value: 3 },
          { labels: { queue: 'session_pool' }, value: 0 },
        ],
      },
    ]);
    expect(text).toBe(
      [
        '# HELP otheater_scheduler_queue_depth Items waiting.',
        '# TYPE otheater_scheduler_queue_depth gauge',
        'otheater_scheduler_queue_depth{queue="prompts"} 3',
        'otheater_scheduler_queue_depth{queue="session_pool"} 0',
        '',
      ].join('\n'),
    );
  });

  it('keeps the header of a family with no sample and renders no labels as none', () => {
    expect(
      renderPrometheus([
        { name: 'a_total', help: 'A.', type: 'counter', samples: [] },
        { name: 'b', help: 'B.', type: 'gauge', samples: [{ labels: {}, value: 1.5 }] },
      ]),
    ).toBe('# HELP a_total A.\n# TYPE a_total counter\n# HELP b B.\n# TYPE b gauge\nb 1.5\n');
  });

  it('renders nothing for no family', () => {
    expect(renderPrometheus([])).toBe('');
  });

  it('escapes backslash, double quote and line feed in a label value', () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
    const text = renderPrometheus([
      { name: 'm', help: 'M.', type: 'gauge', samples: [{ labels: { l: 'x"y\\z\n' }, value: 1 }] },
    ]);
    expect(text).toContain('m{l="x\\"y\\\\z\\n"} 1\n');
  });

  it('escapes backslash and line feed in HELP, but not the quote', () => {
    expect(escapeHelp('a\\b\n"c"')).toBe('a\\\\b\\n"c"');
  });

  it('spells the special values', () => {
    expect(formatValue(Number.NaN)).toBe('NaN');
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('+Inf');
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe('-Inf');
    expect(formatValue(0.25)).toBe('0.25');
    expect(formatValue(1e21)).toBe('1e+21');
  });

  it('refuses an invalid metric or label name instead of writing a broken scrape', () => {
    expect(() =>
      renderPrometheus([{ name: '1bad', help: '', type: 'gauge', samples: [] }]),
    ).toThrow(TypeError);
    expect(() =>
      renderPrometheus([
        {
          name: 'ok',
          help: '',
          type: 'gauge',
          samples: [{ labels: { 'bad-name': 'x' }, value: 1 }],
        },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      renderPrometheus([
        {
          name: 'ok',
          help: '',
          type: 'gauge',
          samples: [{ labels: { __reserved: 'x' }, value: 1 }],
        },
      ]),
    ).toThrow(TypeError);
  });
});
