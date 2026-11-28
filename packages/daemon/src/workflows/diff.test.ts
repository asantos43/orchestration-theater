// SPDX-License-Identifier: MPL-2.0
import type { JsonObject } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { canonicalJson, diffWorkflows } from './diff.js';

const BASE: JsonObject = {
  id: 'w',
  version: '1.0.0',
  engine: '>=1 <2',
  inputs: { issue: { type: 'number' } },
  limits: { redo: 2 },
  nodes: { read: { step: 'fetch_issue' }, say: { step: 'notify', params: { message: 'hi' } } },
  edges: ['read -> say', 'say -> done'],
};

describe('diffWorkflows', () => {
  it('says nothing for the same document, whatever the order of the keys', () => {
    const shuffled: JsonObject = {
      edges: ['say -> done', 'read -> say'],
      nodes: { say: { params: { message: 'hi' }, step: 'notify' }, read: { step: 'fetch_issue' } },
      limits: { redo: 2 },
      inputs: { issue: { type: 'number' } },
      engine: '>=1 <2',
      version: '1.0.1',
      id: 'w',
    };
    expect(diffWorkflows(BASE, shuffled)).toEqual([]);
  });

  it('lists nodes, inputs and limits child by child', () => {
    const next: JsonObject = {
      ...BASE,
      inputs: { issue: { type: 'number' }, label: { type: 'string' } },
      limits: { redo: 3 },
      nodes: { read: { step: 'fetch_issue' }, say: { step: 'notify', params: { message: 'bye' } } },
    };
    expect(diffWorkflows(BASE, next)).toEqual([
      { area: 'inputs', key: 'label', change: 'added', before: null, after: { type: 'string' } },
      { area: 'limits', key: 'redo', change: 'changed', before: 2, after: 3 },
      {
        area: 'nodes',
        key: 'say',
        change: 'changed',
        before: { step: 'notify', params: { message: 'hi' } },
        after: { step: 'notify', params: { message: 'bye' } },
      },
    ]);
  });

  it('compares lists as sets: an edge that changed is one removed and one added', () => {
    const next: JsonObject = { ...BASE, edges: ['read -> say', 'say -> failed'] };
    expect(diffWorkflows(BASE, next)).toEqual([
      { area: 'edges', key: 'say -> done', change: 'removed', before: 'say -> done', after: null },
      {
        area: 'edges',
        key: 'say -> failed',
        change: 'added',
        before: null,
        after: 'say -> failed',
      },
    ]);
  });

  it('names a whole key that only one side has, and a plain key that changed', () => {
    const next: JsonObject = { ...BASE, description: 'new', engine: '>=1' };
    delete (next as Record<string, unknown>).limits;
    expect(diffWorkflows(BASE, next)).toEqual([
      { area: 'description', key: 'description', change: 'added', before: null, after: 'new' },
      { area: 'engine', key: 'engine', change: 'changed', before: '>=1 <2', after: '>=1' },
      { area: 'limits', key: 'limits', change: 'removed', before: { redo: 2 }, after: null },
    ]);
  });

  it('writes canonical JSON with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});
