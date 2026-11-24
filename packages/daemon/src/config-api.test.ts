// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { API_REMOTE_MODES, API_TOKEN_MODES, parseConfig } from './config.js';

describe('parseConfig, the api block (P3 of docs/17)', () => {
  it('defaults: auto port, persistent token, remote off, no CORS origin, 1 MiB body', () => {
    expect(parseConfig('').api).toEqual({
      port: 'auto',
      token: 'persistent',
      remote: 'off',
      cors: { origins: [] },
      max_body_bytes: 1_048_576,
      rejection_events: { every: 10_000 },
      idempotency_ttl: 86_400_000,
      idempotency_max_entries: 10_000,
      max_json_depth: 64,
      sse: {
        buffer_events: 1000,
        heartbeat: 15_000,
        retry: 2000,
        max_streams: 32,
        lagged_events: { every: 10_000 },
      },
      chat: {
        ticket_ttl: 30_000,
        heartbeat: 30_000,
        close_grace: 2000,
        max_message_bytes: 1_048_576,
        max_pending_pongs: 60,
        state_interval: 1000,
        resume_window: 250,
        max_tickets: 64,
        max_sockets: 32,
        max_queued_messages: 256,
      },
    });
  });

  it('takes a fixed port from 1024 to 65535 or auto, and nothing else', () => {
    expect(parseConfig('api:\n  port: 1024\n').api.port).toBe(1024);
    expect(parseConfig('api:\n  port: 65535\n').api.port).toBe(65535);
    expect(parseConfig('api:\n  port: auto\n').api.port).toBe('auto');
    for (const bad of ['80', '65536', '1.5', 'random', 'null']) {
      expect(() => parseConfig(`api:\n  port: ${bad}\n`)).toThrow(/api\.port/);
    }
  });

  it('lists the token modes and rejects any other word', () => {
    expect(API_TOKEN_MODES).toEqual(['persistent', 'per_start']);
    for (const mode of API_TOKEN_MODES) {
      expect(parseConfig(`api:\n  token: ${mode}\n`).api.token).toBe(mode);
    }
    expect(() => parseConfig('api:\n  token: forever\n')).toThrow(/api\.token/);
  });

  it('accepts remote off and refuses vpn and proxy with the Phase 12 message', () => {
    expect(API_REMOTE_MODES).toEqual(['off', 'vpn', 'proxy']);
    expect(parseConfig('api:\n  remote: off\n').api.remote).toBe('off');
    for (const mode of ['vpn', 'proxy']) {
      expect(() => parseConfig(`api:\n  remote: ${mode}\n`)).toThrow(/Phase 12/);
    }
    expect(() => parseConfig('api:\n  remote: public\n')).toThrow(/api\.remote/);
  });

  it('takes a list of origins, and rejects a path, a wildcard or a bare host', () => {
    expect(
      parseConfig(
        'api:\n  cors:\n    origins:\n      - https://app.example\n      - http://localhost:5173\n',
      ).api.cors.origins,
    ).toEqual(['https://app.example', 'http://localhost:5173']);
    for (const bad of [
      '"*"',
      'https://app.example/path',
      'app.example',
      '"https://app.example/"',
    ]) {
      expect(() => parseConfig(`api:\n  cors:\n    origins: [${bad}]\n`)).toThrow(InvalidInput);
    }
  });

  it('takes max_body_bytes as a positive integer', () => {
    expect(parseConfig('api:\n  max_body_bytes: 4096\n').api.max_body_bytes).toBe(4096);
    for (const bad of ['0', '-1', '1.5', '"1MB"']) {
      expect(() => parseConfig(`api:\n  max_body_bytes: ${bad}\n`)).toThrow(/max_body_bytes/);
    }
  });

  it('takes the window of the rejection events as a duration and rejects zero or a bare number', () => {
    expect(parseConfig('api:\n  rejection_events:\n    every: 30s\n').api.rejection_events).toEqual(
      {
        every: 30_000,
      },
    );
    for (const bad of ['0s', '"soon"', '5']) {
      expect(() => parseConfig(`api:\n  rejection_events:\n    every: ${bad}\n`)).toThrow(
        /rejection_events/,
      );
    }
  });

  it('keeps sse.buffer_events and rejects unknown keys of the block', () => {
    expect(parseConfig('api:\n  sse:\n    buffer_events: 5\n').api.sse.buffer_events).toBe(5);
    expect(() => parseConfig('api:\n  host: 0.0.0.0\n')).toThrow(/host/);
    expect(() => parseConfig('api:\n  cors:\n    allow_all: true\n')).toThrow(/allow_all/);
  });

  it('takes the api.chat keys: durations for ticket_ttl, heartbeat, close_grace, state_interval and resume_window, integers for the rest', () => {
    const yaml =
      'api:\n  chat:\n    ticket_ttl: 10s\n    heartbeat: 5s\n    close_grace: 500ms\n    max_message_bytes: 4096\n    max_pending_pongs: 3\n    state_interval: 250ms\n    resume_window: 100ms\n';
    expect(parseConfig(yaml).api.chat).toEqual({
      ticket_ttl: 10_000,
      heartbeat: 5000,
      close_grace: 500,
      max_message_bytes: 4096,
      max_pending_pongs: 3,
      state_interval: 250,
      resume_window: 100,
      max_tickets: 64,
      max_sockets: 32,
      max_queued_messages: 256,
    });
    for (const bad of [
      'ticket_ttl: 0s',
      'heartbeat: 5',
      'max_message_bytes: 0',
      'max_pending_pongs: 1.5',
      'state_interval: 0s',
      'resume_window: 0s',
    ]) {
      expect(() => parseConfig(`api:\n  chat:\n    ${bad}\n`)).toThrow(/chat/);
    }
    expect(() => parseConfig('api:\n  chat:\n    token: x\n')).toThrow(/token/);
  });
});
