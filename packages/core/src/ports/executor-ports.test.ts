// SPDX-License-Identifier: MPL-2.0
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Adapter } from './adapter.js';
import {
  AGENT_SESSION_PORT_VERSION,
  type AgentSession,
  type SessionOpenParams,
  type SessionSetup,
  type SessionTransport,
} from './agent-session.js';
import {
  CLIENT_ADAPTER_PORT_VERSION,
  ROLE_POLICY_FIELDS,
  type ClientAdapterContract,
  type Enforcement,
  type RolePolicy,
} from './client-adapter.js';
import {
  LOCAL_MODEL_SERVER_PORT_VERSION,
  SERVER_HEALTH_STATUSES,
  type LocalModelServer,
} from './local-model-server.js';
import { MODEL_CATALOG_PORT_VERSION, type ModelCatalog } from './model-catalog.js';
import {
  QUOTA_PROBE_PORT_VERSION,
  QuotaReadingSchema,
  type QuotaProbe,
  type QuotaReading,
} from './quota-probe.js';

describe('port versions', () => {
  it('start at 0.1.0 (architecture 5.18, "O que a Fase 1 fixou")', () => {
    expect(
      [
        AGENT_SESSION_PORT_VERSION,
        LOCAL_MODEL_SERVER_PORT_VERSION,
        MODEL_CATALOG_PORT_VERSION,
        QUOTA_PROBE_PORT_VERSION,
      ].every((v) => v === '0.1.0'),
    ).toBe(true);
  });

  it('moves the ClientAdapter port to 0.3.0 with the policy v2 (Phase 4, P1)', () => {
    expect(CLIENT_ADAPTER_PORT_VERSION).toBe('0.3.2');
  });
});

describe('types', () => {
  it('adapters extend Adapter; the catalog and the session do not', () => {
    expectTypeOf<ClientAdapterContract>().toExtend<Adapter>();
    expectTypeOf<QuotaProbe>().toExtend<Adapter>();
    expectTypeOf<LocalModelServer>().toExtend<Adapter>();
    expectTypeOf<ModelCatalog>().not.toExtend<Adapter>();
    expectTypeOf<AgentSession>().not.toExtend<Adapter>();
  });

  it('QuotaProbe.watch is the only optional method', () => {
    expectTypeOf<QuotaProbe['watch']>().toBeNullable();
    expectTypeOf<QuotaProbe['read']>().not.toBeNullable();
  });

  it('a session transport opens and loads sessions', () => {
    expectTypeOf<SessionTransport['open']>().parameters.toEqualTypeOf<[SessionOpenParams]>();
    expectTypeOf<SessionTransport['open']>().returns.resolves.toEqualTypeOf<AgentSession>();
    expectTypeOf<SessionTransport['load']>().returns.resolves.toEqualTypeOf<AgentSession>();
    const acp: SessionSetup = { via: 'acp', configOptions: { model: 'm' } };
    const headless: SessionSetup = { via: 'headless', args: [], env: {} };
    expect([acp.via, headless.via]).toEqual(['acp', 'headless']);
  });

  it('Enforcement has one entry per RolePolicy field, except the release rules of onAsk', () => {
    expectTypeOf<keyof Enforcement>().toEqualTypeOf<Exclude<keyof RolePolicy, 'rules'>>();
    expect([...ROLE_POLICY_FIELDS].sort()).toEqual(
      [
        'bypass',
        'mcpServers',
        'mcpTools',
        'nativeShell',
        'nativeTools',
        'network',
        'onAsk',
        'writeScope',
      ].sort(),
    );
  });
});

describe('QuotaReadingSchema', () => {
  it('accepts a reading and refuses a malformed one', () => {
    const reading: QuotaReading = QuotaReadingSchema.parse({
      observedAt: 1_700_000_000_000,
      windows: [{ window: '5h', usedPercent: 42.5, resetsAt: 1_700_000_900_000 }],
      planType: 'max',
    });
    expect(reading.windows).toHaveLength(1);
    for (const bad of [
      { windows: [] },
      { observedAt: 1.5, windows: [] },
      { observedAt: 1, windows: [{ window: '', usedPercent: 1 }] },
      { observedAt: 1, windows: [{ window: '5h', usedPercent: -1 }] },
      { observedAt: 1, windows: [], extra: true },
    ]) {
      expect(QuotaReadingSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('local model server', () => {
  it('has three health statuses', () => {
    expect([...SERVER_HEALTH_STATUSES]).toEqual(['ok', 'loading', 'unreachable']);
  });
});
