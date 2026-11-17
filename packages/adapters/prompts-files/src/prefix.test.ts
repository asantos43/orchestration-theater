// SPDX-License-Identifier: MPL-2.0
import {
  assemblePrefix,
  OFFICIAL_ROLES,
  OFFICIAL_TOOLS,
  type DirectiveRecord,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { FilePromptSource } from './index.js';

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

const ORDERS: readonly DirectiveRecord[] = [
  order(1, { text: 'Answer the Producer in Brazilian Portuguese.' }),
  order(2, { text: 'Prefer small commits.', roles: ['actor'] }),
  order(3, { scope: 'local', scenarioId: 's1', text: 'Do not touch the legacy folder.' }),
];

const CONTRACT = 'Demand D1: deliver the parser described in contract C1.';

// The assembled prefix of every role, with the bundled prompt, is committed under `__snapshots__`:
// a change to a prompt, to the layout or to a role's tools shows up as a diff to review.
describe('the assembled prefix of each role', () => {
  const source = new FilePromptSource();

  for (const { id: role } of OFFICIAL_ROLES) {
    it(`${role}: without orders`, async () => {
      const prefix = assemblePrefix({
        role,
        rolePrompt: await source.get(role),
        tools: OFFICIAL_TOOLS,
      });
      await expect(prefix).toMatchFileSnapshot(`__snapshots__/prefix/${role}.plain.md`);
    });

    it(`${role}: with project rules, orders and a contract`, async () => {
      const prefix = assemblePrefix({
        role,
        rolePrompt: await source.get(role),
        tools: OFFICIAL_TOOLS,
        projectRules: 'Use pnpm. Write tests first.',
        directives: ORDERS,
        contract: CONTRACT,
      });
      await expect(prefix).toMatchFileSnapshot(`__snapshots__/prefix/${role}.full.md`);
    });
  }
});
