// SPDX-License-Identifier: MPL-2.0
import { PLAY_WORKFLOW, validateWorkflow, type ValidWorkflow } from '@otheater/workflows';
import { describe, expect, it } from 'vitest';
import { workflowYaml } from './packages.test-support.js';
import { addedPermissions, describePermissions, permissionKeys } from './permissions.js';

function valid(document: unknown): ValidWorkflow {
  const result = validateWorkflow(document);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.workflow;
}

describe('describePermissions', () => {
  it('reads tools, plugins, effects and public writes from the validated definition', () => {
    const workflow = valid({
      ...JSON.parse(workflowYaml('triage', '1.0.0', { requiresTools: ['lint'] })),
      requires: { tools: ['lint'], plugins: ['github'] },
    });
    const permissions = describePermissions([workflow]);
    expect(permissions.tools).toEqual(['lint']);
    expect(permissions.plugins).toEqual(['github']);
    expect(permissions.publicWrites).toEqual(['comment']);
    expect(permissions.effects).not.toContain('none');
    expect(permissions.effects.length).toBeGreaterThan(0);
  });

  it('adds the tool a call_tool node names and joins several workflows without repeats', () => {
    const base = JSON.parse(workflowYaml('a', '1.0.0')) as Record<string, unknown>;
    const withTool = valid({
      ...base,
      id: 'b',
      nodes: { run: { step: 'call_tool', params: { tool: 'lint' } } },
      edges: ['run -> done when output.ok', 'run -> failed'],
    });
    const permissions = describePermissions([valid(base), withTool, valid(base)]);
    expect(permissions.tools).toEqual(['lint']);
    expect(permissions.publicWrites).toEqual(['comment']);
  });

  it('shows nothing for a workflow that asks for nothing', () => {
    const permissions = describePermissions([valid(PLAY_WORKFLOW)]);
    expect(permissions.tools).toEqual([]);
    expect(permissions.plugins).toEqual([]);
  });
});

describe('permissionKeys and addedPermissions', () => {
  const permissions = {
    tools: ['lint'],
    plugins: ['github'],
    effects: ['agent'],
    publicWrites: ['comment' as const],
  };

  it('flattens the permissions into stable keys', () => {
    expect(permissionKeys(permissions)).toEqual([
      'tool:lint',
      'plugin:github',
      'effect:agent',
      'public_write:comment',
    ]);
  });

  it('reports everything in a first install and only the new ones in an update', () => {
    expect(addedPermissions([], permissions)).toEqual(permissionKeys(permissions));
    expect(addedPermissions(['tool:lint', 'plugin:github'], permissions)).toEqual([
      'effect:agent',
      'public_write:comment',
    ]);
    expect(addedPermissions(permissionKeys(permissions), permissions)).toEqual([]);
  });
});
