// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

function refusal(yaml: string): string {
  try {
    parseConfig(yaml);
  } catch (error) {
    if (error instanceof InvalidInput) return error.message;
    throw error;
  }
  throw new Error('the configuration was accepted');
}

describe('flows and scenario.flow in the configuration (P12)', () => {
  it('have no flow and no choice by default', () => {
    const config = parseConfig('');
    expect(config.flows).toEqual({});
    expect(config.scenario).toEqual({});
  });

  it('accepts a flow without the review of the plan and a choice that names it', () => {
    const config = parseConfig(`
flows:
  no-review:
    version: 1
    steps:
      plan_review: { enabled: false }
scenario:
  flow: no-review
`);
    expect(config.scenario.flow).toBe('no-review');
    expect(config.flows['no-review']?.steps.plan_review?.enabled).toBe(false);
  });

  it('refuses a flow that removes a mandatory step, with the path of the field', () => {
    const message = refusal(`
flows:
  broken:
    version: 1
    steps:
      delivery: { enabled: false }
`);
    expect(message).toContain('flows.broken.steps.delivery.enabled');
    expect(message).toContain('mandatory step');
  });

  it("refuses a step outside the registry, a role that is not the step's own and a permission key", () => {
    expect(refusal('flows:\n  x:\n    version: 1\n    steps:\n      lunch: {}')).toMatch(
      /flows\.x\.steps: .*"lunch"/u,
    );
    expect(
      refusal('flows:\n  x:\n    version: 1\n    steps:\n      execution: { role: critic }'),
    ).toContain('flows.x.steps.execution.role');
    expect(refusal('flows:\n  x:\n    version: 1\n    permissions: allow')).toMatch(
      /flows\.x: .*"permissions"/u,
    );
  });

  it('refuses the id of an official flow and a choice that names no flow', () => {
    expect(refusal('flows:\n  play:\n    version: 1')).toContain('official flow');
    expect(refusal('scenario:\n  flow: nothing')).toContain(
      'scenario.flow: scenario.flow names "nothing"',
    );
    expect(parseConfig('scenario:\n  flow: play').scenario.flow).toBe('play');
  });
});
