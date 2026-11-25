// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from './definition.js';
import { canonicalWorkflowJson, workflowHash } from './hash.js';
import { PLAY_WORKFLOW } from './definitions/play.js';

const written: WorkflowDefinition = {
  id: 'triage',
  version: '1.0.0',
  engine: '>=1 <2',
  nodes: { read: { step: 'fetch_issue' }, check: { step: 'critique' } },
  edges: [
    'read -> check',
    'check -> done when  output.approved ',
    { from: 'check', to: 'read', limit: 'redo' },
  ],
  limits: { redo: 2 },
};

// The same definition: other key order, other edge forms.
const reordered: WorkflowDefinition = {
  limits: { redo: 2 },
  edges: [
    { to: 'check', from: 'read' },
    { 'check -> done when': 'output.approved' },
    'check -> read',
  ],
  nodes: { check: { step: 'critique' }, read: { step: 'fetch_issue' } },
  engine: '>=1 <2',
  version: '1.0.0',
  id: 'triage',
};

describe('the hash of a definition', () => {
  it('is sha256 of the canonical JSON', async () => {
    expect(await workflowHash(written)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('does not depend on the key order nor on the form of the edges', async () => {
    const fixed = {
      ...reordered,
      edges: [...reordered.edges.slice(0, 2), { from: 'check', to: 'read', limit: 'redo' }],
    };
    expect(canonicalWorkflowJson(fixed)).toBe(canonicalWorkflowJson(written));
    expect(await workflowHash(fixed)).toBe(await workflowHash(written));
  });

  it('changes with what the definition says', async () => {
    const other = { ...written, limits: { redo: 3 } };
    expect(await workflowHash(other)).not.toBe(await workflowHash(written));
    // The order of the edges is meaning: the first that matches is taken.
    const swapped = {
      ...written,
      edges: [written.edges[0], written.edges[2], written.edges[1]],
    } as WorkflowDefinition;
    expect(await workflowHash(swapped)).not.toBe(await workflowHash(written));
  });

  it('drops what is undefined and keeps the edges as objects', () => {
    const json = JSON.parse(canonicalWorkflowJson({ ...written, description: undefined })) as {
      edges: unknown[];
    };
    expect(Object.keys(json)).toEqual(['edges', 'engine', 'id', 'limits', 'nodes', 'version']);
    expect(json.edges[1]).toEqual({ from: 'check', to: 'done', when: 'output.approved' });
  });

  it('is stable for the play', async () => {
    expect(await workflowHash(PLAY_WORKFLOW)).toBe(
      await workflowHash(structuredClone(PLAY_WORKFLOW)),
    );
  });
});
