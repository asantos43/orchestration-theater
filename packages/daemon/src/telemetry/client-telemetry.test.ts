// SPDX-License-Identifier: MPL-2.0
import { otelBaseEnv } from '@otheater/core';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config.js';
import { ClientTelemetry } from './client-telemetry.js';
import { TelemetrySessions } from './sessions.js';

const ENDPOINT = 'http://127.0.0.1:4318';
const TOKEN = 'test-token-0123456789';

function build(yaml = '', extra: Partial<ConstructorParameters<typeof ClientTelemetry>[0]> = {}) {
  const sessions = new TelemetrySessions();
  const warn = vi.fn();
  const clients = new ClientTelemetry({
    endpoint: ENDPOINT,
    token: TOKEN,
    config: parseConfig(yaml).telemetry,
    sessions,
    logger: { warn },
    ...extra,
  });
  return { clients, sessions, warn };
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

const CONTEXT = {
  playId: 'play-1',
  stageId: 'stage-a',
  attemptId: 'play-1/stage-a/1',
  scenarioId: 'sc-1',
};

describe('ClientTelemetry.prepare', () => {
  it('builds the endpoint, the bearer header and the full session resource', async () => {
    const { clients } = build();
    const prepared = await clients.prepare('claude-code', 'work-a', CONTEXT);
    expect(prepared?.session).toEqual({
      endpoint: ENDPOINT,
      headers: { Authorization: `Bearer ${TOKEN}` },
      resource: {
        'otheater.client': 'claude-code',
        'otheater.profile': 'work-a',
        'otheater.scenario_id': 'sc-1',
        'otheater.play_id': 'play-1',
        'otheater.stage_id': 'stage-a',
        'otheater.attempt_id': 'play-1/stage-a/1',
      },
      traces: false,
      metricsIntervalMs: 5000,
      experimental: false,
    });
  });

  it('keeps the process resource stable, so sessions of two attempts share one process', async () => {
    const { clients } = build();
    const one = await clients.prepare('codex', 'work-a', CONTEXT);
    const two = await clients.prepare('codex', 'work-a', {
      ...CONTEXT,
      attemptId: 'play-2/stage-b/1',
      playId: 'play-2',
    });
    expect(one?.process.resource).toEqual({
      'otheater.client': 'codex',
      'otheater.profile': 'work-a',
    });
    // What goes into the environment of the process (and its pool key) is the same for both.
    expect(otelBaseEnv(defined(one).process)).toEqual(otelBaseEnv(defined(two).process));
    expect(otelBaseEnv(defined(one).session)).not.toEqual(otelBaseEnv(defined(two).session));
  });

  it('turns traces on for Claude Code only with telemetry.clients.claude-code.traces: on', async () => {
    const off = await build().clients.prepare('claude-code', 'p', undefined);
    expect(off?.session.traces).toBe(false);
    const on = await build(
      'telemetry:\n  clients:\n    claude-code:\n      traces: on\n',
    ).clients.prepare('claude-code', 'p', undefined);
    expect(on?.session.traces).toBe(true);
    expect(on?.process.traces).toBe(true);
    // The switch of a client does not leak into another.
    const codex = await build(
      'telemetry:\n  clients:\n    claude-code:\n      traces: on\n',
    ).clients.prepare('codex', 'p', undefined);
    expect(codex?.session.traces).toBe(false);
  });

  it('gives Claude Code a metrics interval of 5s by default, none with client, and none to others', async () => {
    expect(
      (await build().clients.prepare('claude-code', 'p', undefined))?.session.metricsIntervalMs,
    ).toBe(5000);
    const yaml = 'telemetry:\n  clients:\n    claude-code:\n      metrics_interval: 30s\n';
    expect(
      (await build(yaml).clients.prepare('claude-code', 'p', undefined))?.process.metricsIntervalMs,
    ).toBe(30_000);
    const client = await build(
      'telemetry:\n  clients:\n    claude-code:\n      metrics_interval: client\n',
    ).clients.prepare('claude-code', 'p', undefined);
    expect(client?.session).not.toHaveProperty('metricsIntervalMs');
    const codex = await build().clients.prepare('codex', 'p', undefined);
    expect(codex?.session).not.toHaveProperty('metricsIntervalMs');
  });

  it('turns the experimental AI spans on for OpenCode only with ai_spans: on', async () => {
    const yaml = 'telemetry:\n  clients:\n    opencode:\n      ai_spans: on\n';
    expect(
      (await build(yaml).clients.prepare('opencode', 'p', undefined))?.session.experimental,
    ).toBe(true);
    expect((await build(yaml).clients.prepare('codex', 'p', undefined))?.session.experimental).toBe(
      false,
    );
    expect((await build().clients.prepare('opencode', 'p', undefined))?.session.experimental).toBe(
      false,
    );
  });

  it('gives nothing for a client switched off, and sends for one that has no key (the fake)', async () => {
    const { clients } = build('telemetry:\n  clients:\n    codex:\n      enabled: off\n');
    expect(clients.enabled('codex')).toBe(false);
    expect(await clients.prepare('codex', 'p', CONTEXT)).toBeUndefined();
    expect(clients.enabled('fake')).toBe(true);
    expect(await clients.prepare('fake', 'p', CONTEXT)).toBeDefined();
  });

  it('finds the scenario of a play when the caller only knew the play', async () => {
    const scenarioOf = vi.fn(() => Promise.resolve('sc-from-play'));
    const { clients } = build('', { scenarioOf });
    const prepared = await clients.prepare('codex', 'p', { playId: 'play-1' });
    expect(prepared?.entry.scenarioId).toBe('sc-from-play');
    expect(prepared?.session.resource['otheater.scenario_id']).toBe('sc-from-play');
    expect(scenarioOf).toHaveBeenCalledWith('play-1');
    // A scenario the caller gave is not asked again, and a failing lookup is not a failure.
    await clients.prepare('codex', 'p', { playId: 'play-1', scenarioId: 'sc-1' });
    expect(scenarioOf).toHaveBeenCalledTimes(1);
    const failing = build('', { scenarioOf: () => Promise.reject(new Error('no store')) });
    const none = await failing.clients.prepare('codex', 'p', { playId: 'play-1' });
    expect(none?.entry.scenarioId).toBeNull();
  });

  it('leaves out, with a warning, an id the resource format cannot carry', async () => {
    const { clients, warn } = build();
    const prepared = await clients.prepare('claude-code', 'p', {
      ...CONTEXT,
      stageId: 'has space,and=comma',
    });
    expect(prepared?.session.resource['otheater.stage_id']).toBeUndefined();
    expect(prepared?.session.resource['otheater.play_id']).toBe('play-1');
    expect(otelBaseEnv(defined(prepared).session)).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    await clients.prepare('claude-code', 'p', { ...CONTEXT, stageId: 'again,bad' });
    // Said once for each attribute.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('adds the attributes of resourceExtras (the place for otheater.trace_id of P4)', async () => {
    const resourceExtras = vi.fn(() => ({ 'otheater.trace_id': 'a'.repeat(32) }));
    const { clients } = build('', { resourceExtras });
    const prepared = await clients.prepare('claude-code', 'p', CONTEXT);
    expect(prepared?.session.resource['otheater.trace_id']).toBe('a'.repeat(32));
    expect(prepared?.process.resource['otheater.trace_id']).toBeUndefined();
    expect(resourceExtras).toHaveBeenCalledWith('claude-code', CONTEXT);
  });

  it('never throws: a failing hook means a session with no telemetry', async () => {
    const { clients, warn } = build('', {
      resourceExtras: () => {
        throw new Error('boom');
      },
    });
    await expect(clients.prepare('claude-code', 'p', CONTEXT)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('ClientTelemetry.opened / closed', () => {
  it('writes the session into the table and takes it out', async () => {
    const { clients, sessions } = build();
    const prepared = await clients.prepare('codex', 'work-a', CONTEXT);
    clients.opened('conv-1', defined(prepared));
    expect(sessions.correlate({ 'conversation.id': 'conv-1' }, {})).toEqual({
      scenarioId: 'sc-1',
      playId: 'play-1',
      attemptId: 'play-1/stage-a/1',
      sessionId: 'conv-1',
    });
    expect(sessions.get('conv-1')).toMatchObject({
      client: 'codex',
      profile: 'work-a',
      stageId: 'stage-a',
    });
    clients.closed('conv-1');
    // The grace period: the last batch of a closed session is still its own.
    expect(sessions.get('conv-1')).toBeDefined();
  });
});
