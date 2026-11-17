// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { FrameworkMcpServer, ToolHandlers, type McpGrant } from '../mcp/index.js';
import { buildDaemonRegistries } from '../registries.js';
import { DirectiveService } from './service.js';
import { registerDirectiveTools } from './tools.js';

const registries = buildDaemonRegistries();
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);

interface Harness {
  readonly server: FrameworkMcpServer;
  readonly service: DirectiveService;
  readonly store: InMemoryStore;
  grant(role: string): McpGrant;
}

const running: FrameworkMcpServer[] = [];

async function harness(): Promise<Harness> {
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  const service = new DirectiveService({
    store,
    clock,
    ruleKeys: registries.ruleKeys,
    settings: { timezone: 'America/Sao_Paulo', expiringNoticeMs: 0 },
    logger: createSilentLogger(),
  });
  const handlers = new ToolHandlers();
  registerDirectiveTools(handlers, service, store);
  const server = await FrameworkMcpServer.start({
    registries,
    port: 'auto',
    submitRetries: 2,
    handlers,
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  running.push(server);
  return {
    server,
    service,
    store,
    grant: (role) =>
      server.grant({
        attemptId: 'p1/d1/1',
        role,
        correlation: { playId: 'p1', demandId: 'd1', attemptId: 'p1/d1/1' },
        record: () => Promise.resolve(),
      }),
  };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

let nextId = 1;

async function call(
  h: Harness,
  grant: McpGrant,
  name: string,
  args: unknown,
): Promise<{ isError: boolean; value: Record<string, unknown> | unknown[] }> {
  const response = await fetch(h.server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...grant.server.headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  const data = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim() ?? '{}');
  const body = JSON.parse(data) as {
    result?: { isError?: boolean; content: { text: string }[] };
    error?: unknown;
  };
  const result = body.result;
  if (result === undefined) throw new Error(`no result: ${data}`);
  return {
    isError: result.isError === true,
    value: JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown> | unknown[],
  };
}

describe('the tools of the orders, for the Director (architecture 5.17)', () => {
  it('propose_directive leaves a draft; the order exists only after the Producer confirms', async () => {
    const h = await harness();
    const director = h.grant('director');
    const proposed = await call(h, director, 'propose_directive', {
      text: 'Write a changelog entry for every PR.',
      scope: 'global',
      scenarioId: 's1',
      for: '7d',
    });
    expect(proposed.isError).toBe(false);
    const draft = proposed.value as { draftId: string; preview: Record<string, unknown> };
    expect(draft.preview).toMatchObject({ action: 'create', scope: 'global', kind: 'instruction' });

    // Nothing is in force yet, for the Director or for anyone.
    expect((await call(h, director, 'list_directives', { scenarioId: 's1' })).value).toEqual([]);

    await h.service.confirmDraft(draft.draftId);
    const listed = (await call(h, director, 'list_directives', { scenarioId: 's1' })).value as {
      id: string;
      text: string;
    }[];
    expect(listed.map((d) => d.text)).toEqual(['Write a changelog entry for every PR.']);
  });

  it('extend_directive and revoke_directive also only leave drafts', async () => {
    const h = await harness();
    const director = h.grant('director');
    const order = await h.service.create({ text: 'x', scope: 'global', validity: { for: '1d' } });
    const extend = await call(h, director, 'extend_directive', {
      directiveId: order.id,
      scenarioId: 's1',
      for: '1d',
    });
    const revoke = await call(h, director, 'revoke_directive', {
      directiveId: order.id,
      scenarioId: 's1',
      reason: 'No longer needed.',
    });
    expect(extend.isError).toBe(false);
    expect(revoke.isError).toBe(false);
    expect((await h.service.get(order.id))?.state).toBe('active');
    expect((await h.service.get(order.id))?.endsAt).toBe(order.endsAt);
    expect(await h.service.listDrafts()).toHaveLength(2);
  });

  it('answers a structured error for a bad date, an unknown rule key and a missing reason', async () => {
    const h = await harness();
    const director = h.grant('director');
    const date = await call(h, director, 'propose_directive', {
      text: 'x',
      scope: 'global',
      scenarioId: 's1',
      until: 'someday',
    });
    expect(date.isError).toBe(true);
    expect(date.value).toMatchObject({ error: 'invalid_date' });

    const key = await call(h, director, 'propose_directive', {
      text: 'x',
      scope: 'global',
      scenarioId: 's1',
      kind: 'rule',
      ruleKey: 'permissions.bypass',
      ruleValue: true,
    });
    expect(key.value).toMatchObject({ error: 'unknown_rule_key' });

    const order = await h.service.create({ text: 'x', scope: 'global' });
    const noReason = await call(h, director, 'revoke_directive', { directiveId: order.id });
    expect(noReason.isError).toBe(true);
    expect(noReason.value).toMatchObject({ error: 'invalid_input' });
    const missing = await call(h, director, 'revoke_directive', {
      directiveId: 'O99',
      scenarioId: 's1',
      reason: 'x',
    });
    expect(missing.value).toMatchObject({ error: 'not_found' });
  });

  it('shows the clash of a rule draft and asks for a scenario when the session has no play', async () => {
    const h = await harness();
    const director = h.grant('director');
    const first = await h.service.create({
      text: 'PR.',
      scope: 'global',
      kind: 'rule',
      ruleKey: 'delivery.mode',
      ruleValue: 'pr',
    });
    const clash = await call(h, director, 'propose_directive', {
      text: 'Ask.',
      scope: 'global',
      scenarioId: 's1',
      kind: 'rule',
      ruleKey: 'delivery.mode',
      ruleValue: 'ask',
    });
    expect(clash.value).toMatchObject({ conflicts: [first.id] });

    const lost = await call(h, director, 'propose_directive', { text: 'x', scope: 'global' });
    expect(lost.value).toMatchObject({ error: 'scenario_required' });
  });

  it('an Executor does not have the tools of the orders', async () => {
    const h = await harness();
    const actor = h.grant('actor');
    const response = await fetch(h.server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...actor.server.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} }),
    });
    const text = await response.text();
    for (const name of [
      'propose_directive',
      'extend_directive',
      'revoke_directive',
      'list_directives',
    ]) {
      expect(text).not.toContain(`"${name}"`);
    }
  });
});
