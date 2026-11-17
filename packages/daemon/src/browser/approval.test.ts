// SPDX-License-Identifier: MPL-2.0
import type { JsonValue } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { ToolFailure } from '../mcp/handlers.js';
import { ToolRefusal } from '../tools/context.js';
import { WriteApprovals, isApproval, type ApprovalRequest, type AskApproval } from './approval.js';

describe('isApproval', () => {
  it.each<[JsonValue, boolean]>([
    ['Allow', true],
    ['  allow ', true],
    [{ selected: ['Allow'] }, true],
    [{ answer: 'Allow' }, true],
    [['Allow'], true],
    ['Deny', false],
    ['ok', false],
    ['', false],
    [null, false],
    [42, false],
    [['Allow', 'Deny'], false],
    [{ selected: ['Allow', 'Deny'] }, false],
    [{}, false],
  ])('%j is %s', (answer, expected) => {
    expect(isApproval(answer)).toBe(expected);
  });
});

function request(over: Partial<ApprovalRequest> = {}, said: string[] = []): ApprovalRequest {
  return {
    mode: 'always',
    action: 'click',
    scenarioId: 's1',
    domain: 'example.com',
    url: 'https://example.com/',
    what: 'click ref e1',
    callId: 'c1',
    correlation: {},
    emit: (event) => {
      said.push((event.payload as { state: string }).state);
      return Promise.resolve();
    },
    ...over,
  };
}

function manual() {
  const resolvers: ((value: JsonValue) => void)[] = [];
  const ask: AskApproval = () => {
    const answer = new Promise<JsonValue>((resolve) => resolvers.push(resolve));
    return Promise.resolve({ decisionId: `d${String(resolvers.length)}`, answer });
  };
  return {
    ask,
    asked: () => resolvers.length,
    answer: (index: number, value: JsonValue) => resolvers[index]?.(value),
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('WriteApprovals', () => {
  it('always: asks for every action, and does not remember', async () => {
    const chat = manual();
    const approvals = new WriteApprovals(chat.ask);
    for (let i = 0; i < 2; i += 1) {
      const pending = approvals.require(request());
      await tick();
      chat.answer(i, 'Allow');
      await pending;
    }
    expect(chat.asked()).toBe(2);
  });

  it('per_domain: remembers a yes per scenario and domain, and forget() clears it', async () => {
    const chat = manual();
    const approvals = new WriteApprovals(chat.ask);
    const first = approvals.require(request({ mode: 'per_domain' }));
    await tick();
    chat.answer(0, 'Allow');
    await first;
    await approvals.require(request({ mode: 'per_domain' }));
    expect(chat.asked()).toBe(1);
    // another domain asks again
    const other = approvals.require(request({ mode: 'per_domain', domain: 'other.test' }));
    await tick();
    expect(chat.asked()).toBe(2);
    chat.answer(1, 'Allow');
    await other;
    approvals.forget('s1');
    const again = approvals.require(request({ mode: 'per_domain' }));
    await tick();
    expect(chat.asked()).toBe(3);
    chat.answer(2, 'Allow');
    await again;
  });

  it('per_domain: a no is not remembered, and a write waiting on the same question shares its answer', async () => {
    const chat = manual();
    const approvals = new WriteApprovals(chat.ask);
    const a = approvals.require(request({ mode: 'per_domain' }));
    const b = approvals.require(request({ mode: 'per_domain', callId: 'c2' }));
    const settled = Promise.allSettled([a, b]);
    await tick();
    expect(chat.asked()).toBe(1);
    chat.answer(0, 'Deny');
    const results = await settled;
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ToolRefusal);
    }
    const next = approvals.require(request({ mode: 'per_domain' }));
    await tick();
    expect(chat.asked()).toBe(2);
    chat.answer(1, 'Allow');
    await next;
  });

  it('refuses when nobody can be asked, with no channel or with the channel declining', async () => {
    const said: string[] = [];
    await expect(new WriteApprovals(undefined).require(request({}, said))).rejects.toMatchObject({
      code: 'approval_unavailable',
    });
    const declined = new WriteApprovals(() => Promise.resolve(undefined));
    await expect(declined.require(request())).rejects.toMatchObject({
      code: 'approval_unavailable',
    });
    expect(said).toEqual([]);
  });

  it('a cancelled question is a failure (not a refusal) and the events say it was requested', async () => {
    const said: string[] = [];
    const approvals = new WriteApprovals(() =>
      Promise.resolve({ decisionId: 'd', answer: Promise.reject(new Error('gone')) }),
    );
    const error: unknown = await approvals.require(request({}, said)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolFailure);
    expect(error).not.toBeInstanceOf(ToolRefusal);
    expect((error as ToolFailure).code).toBe('approval_cancelled');
    expect(said).toEqual(['requested']);
  });

  it('asks a question that carries the action and the domain', async () => {
    let question = '';
    const approvals = new WriteApprovals((_scenario, input) => {
      question = input.questions[0]?.question ?? '';
      return Promise.resolve({ decisionId: 'd', answer: Promise.resolve('Allow') });
    });
    await approvals.require(request({ what: 'type 14 characters into ref e2' }));
    expect(question).toContain('type 14 characters into ref e2');
    expect(question).toContain('example.com');
  });
});
