// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { DirectiveRecord } from '../ports/directives.js';
import { OFFICIAL_TOOLS } from '../registries/tools.js';
import { assemblePrefix, type PrefixInput } from './prefix.js';

function order(seq: number, extra: Partial<DirectiveRecord> = {}): DirectiveRecord {
  return {
    id: `O${String(seq)}`,
    seq,
    scope: 'global',
    scenarioId: null,
    kind: 'instruction',
    text: `Order number ${String(seq)}`,
    ruleKey: null,
    ruleValue: null,
    suspendsId: null,
    roles: [],
    startsAt: 0,
    endsAt: null,
    timezone: 'UTC',
    state: 'active',
    origin: 'chat',
    replacesId: null,
    createdAt: 0,
    updatedAt: 0,
    revokedAt: null,
    revokeReason: null,
    ...extra,
  };
}

const base: PrefixInput = {
  role: 'critic',
  rolePrompt: 'You judge the work.\n',
  tools: OFFICIAL_TOOLS,
};

describe('assemblePrefix', () => {
  it('is deterministic: the same input gives the same text', () => {
    const input = { ...base, directives: [order(2), order(1)], contract: 'A contract' };
    expect(assemblePrefix(input)).toBe(assemblePrefix(input));
  });

  it('puts rules, orders, role, tools and contract in this order, the variable part last', () => {
    const text = assemblePrefix({
      ...base,
      projectRules: 'Use pnpm.',
      directives: [order(1)],
      contract: 'Deliver X.',
    });
    const positions = [
      '## Project rules',
      '## Orders from the Producer',
      '## Your role: critic',
      '## Your tools',
      '## Contract',
    ].map((heading) => text.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('leaves out the sections that are empty', () => {
    const text = assemblePrefix({ ...base, projectRules: '  ', directives: [], contract: '' });
    expect(text).not.toContain('## Project rules');
    expect(text).not.toContain('## Orders from the Producer');
    expect(text).not.toContain('## Contract');
    expect(text).toContain('## Your role: critic');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('lists exactly the tools of the role, and nothing else', () => {
    const critic = assemblePrefix(base);
    for (const name of ['view_diff', 'submit_critique', 'run_tests', 'read_contract', 'submit']) {
      expect(critic).toContain(`- \`${name}\``);
    }
    for (const name of ['submit_plan', 'git_commit', 'ask_producer', 'next_action']) {
      expect(critic).not.toContain(`\`${name}\``);
    }
  });

  it('says which tools act on the worktree or outside it', () => {
    const actor = assemblePrefix({ ...base, role: 'actor' });
    expect(actor).toContain('- `git_commit` (changes your worktree)');
    const director = assemblePrefix({ ...base, role: 'director' });
    expect(director).toContain('- `open_pr` (acts outside the worktree)');
    expect(director).toContain('- `status`\n');
  });

  it('puts only instruction orders that reach the role, global before local, by seq', () => {
    const text = assemblePrefix({
      ...base,
      directives: [
        order(4, { scope: 'local', scenarioId: 's1', text: 'Local one' }),
        order(3, { text: 'Second global' }),
        order(1, { text: 'First global' }),
        order(2, { kind: 'rule', ruleKey: 'limits.preset', ruleValue: 'persistent' }),
        order(5, { text: 'For the actor only', roles: ['actor'] }),
        order(6, { text: 'For the critic', roles: ['critic'] }),
      ],
    });
    expect(text).toContain(
      '### Global orders\n- O1: First global\n- O3: Second global\n- O6: For the critic',
    );
    expect(text).toContain('### Local orders\n- O4: Local one');
    expect(text).not.toContain('For the actor only');
    expect(text).not.toContain('limits.preset');
  });

  it('indents the later lines of a multi-line order under its item', () => {
    const text = assemblePrefix({
      ...base,
      directives: [order(1, { text: 'Line one\nLine two\n' })],
    });
    expect(text).toContain('- O1: Line one\n  Line two\n');
  });

  it('says when an order ends, in the time zone of the order, and says nothing for one with no end', () => {
    const text = assemblePrefix({
      ...base,
      directives: [
        order(1, { endsAt: Date.UTC(2026, 10, 20, 21, 0, 0), timezone: 'America/Sao_Paulo' }),
        order(2),
      ],
    });
    expect(text).toContain('- O1 (until 2026-11-20 18:00 America/Sao_Paulo): Order number 1');
    expect(text).toContain('- O2: Order number 2');
  });

  it('changes only the orders part when an order is added, so the role part stays the same', () => {
    const without = assemblePrefix(base);
    const withOrder = assemblePrefix({ ...base, directives: [order(1)] });
    const tail = (text: string): string => text.slice(text.indexOf('## Your role'));
    expect(tail(withOrder)).toBe(tail(without));
    expect(withOrder).not.toBe(without);
  });
});
