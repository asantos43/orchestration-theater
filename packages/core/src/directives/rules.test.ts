// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { DirectiveRecord } from '../ports/directives.js';
import { resolveRule } from './rules.js';

const rule = (seq: number, extra: Partial<DirectiveRecord> = {}): DirectiveRecord => ({
  id: `O${String(seq)}`,
  seq,
  scope: 'global',
  scenarioId: null,
  kind: 'rule',
  text: `Rule ${String(seq)}`,
  ruleKey: 'delivery.mode',
  ruleValue: 'pr',
  suspendsId: null,
  roles: [],
  startsAt: 0,
  endsAt: null,
  timezone: 'America/Sao_Paulo',
  state: 'active',
  origin: 'chat',
  replacesId: null,
  createdAt: 0,
  updatedAt: 0,
  revokedAt: null,
  revokeReason: null,
  ...extra,
});

describe('resolveRule', () => {
  it('gives the configuration value when no rule is in force', () => {
    expect(resolveRule([], 'delivery.mode', 'branch')).toBe('branch');
  });

  it('gives the value of the rule in force for the key', () => {
    expect(resolveRule([rule(1)], 'delivery.mode', 'branch')).toBe('pr');
    expect(resolveRule([rule(1)], 'git.push_after_commit', false)).toBe(false);
  });

  it('gives the configuration value back once the rule is revoked and no longer in force', () => {
    // `DirectiveRegistry.inForce` leaves a revoked or expired directive out, so the rule is gone.
    const revoked = rule(1, { state: 'revoked', revokedAt: 10, revokeReason: 'no longer wanted' });
    const inForce = [revoked].filter((directive) => directive.state === 'active');
    expect(resolveRule(inForce, 'delivery.mode', 'branch')).toBe('branch');
  });

  it('prefers a local rule to a global one, and the newest among equals', () => {
    const global = rule(1, { ruleValue: 'pr' });
    const local = rule(2, { scope: 'local', scenarioId: 's1', ruleValue: 'branch' });
    expect(resolveRule([global, local], 'delivery.mode', 'x')).toBe('branch');
    expect(resolveRule([local, global], 'delivery.mode', 'x')).toBe('branch');
    const newer = rule(3, { ruleValue: 'patch' });
    expect(resolveRule([global, newer], 'delivery.mode', 'x')).toBe('patch');
  });

  it('applies a rule for some roles only to those roles', () => {
    const forCritic = rule(1, { roles: ['critic'], ruleValue: 'patch' });
    expect(resolveRule([forCritic], 'delivery.mode', 'x')).toBe('x');
    expect(resolveRule([forCritic], 'delivery.mode', 'x', 'actor')).toBe('x');
    expect(resolveRule([forCritic], 'delivery.mode', 'x', 'critic')).toBe('patch');
  });

  it('ignores instructions and suspensions', () => {
    const instruction = rule(1, { kind: 'instruction', ruleKey: null, ruleValue: null });
    expect(resolveRule([instruction], 'delivery.mode', 'x')).toBe('x');
  });
});
