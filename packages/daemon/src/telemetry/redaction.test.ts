// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import type {
  TelemetryBatch,
  TelemetryLogRecord,
  TelemetryMetricPoint,
  TelemetrySpan,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { REDACTED_ATTRIBUTE, Redactor } from './redaction.js';

// Fake values only: nothing here is, or looks like, a real account.
const NO_CORRELATION = { scenarioId: null, playId: null, attemptId: null, sessionId: null };

function log(
  attributes: TelemetryLogRecord['attributes'],
  extra: Partial<TelemetryLogRecord> = {},
): TelemetryLogRecord {
  return {
    ...NO_CORRELATION,
    timeUnixNano: 1n,
    severity: 9,
    severityText: null,
    body: null,
    traceId: null,
    spanId: null,
    attributes,
    resource: {},
    ...extra,
  };
}

function span(
  attributes: TelemetrySpan['attributes'],
  extra: Partial<TelemetrySpan> = {},
): TelemetrySpan {
  return {
    ...NO_CORRELATION,
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'turn',
    kind: 1,
    startTimeUnixNano: 1n,
    endTimeUnixNano: 2n,
    status: 'unset',
    statusMessage: null,
    attributes,
    resource: {},
    ...extra,
  };
}

function point(
  attributes: TelemetryMetricPoint['attributes'],
  resource: TelemetryMetricPoint['resource'] = {},
): TelemetryMetricPoint {
  return {
    ...NO_CORRELATION,
    name: 'tokens',
    unit: null,
    kind: 'sum',
    timeUnixNano: 1n,
    startTimeUnixNano: 0n,
    value: 3,
    detail: null,
    attributes,
    resource,
  };
}

/** The whole record as text (times are bigints), to look for what must not be in it. */
function text(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

const FAKE_VAULT_VALUE = 'vault-value-0123456789';
const PROMPT = 'please rewrite the module';

function first<T>(items: readonly T[] | undefined): T {
  const [item] = items ?? [];
  if (item === undefined) throw new Error('no record');
  return item;
}

describe('Redactor: always (both modes)', () => {
  for (const mode of ['default', 'full'] as const) {
    it(`deletes the identity of the account and the machine (${mode})`, () => {
      const redactor = new Redactor({ mode });
      const out = redactor.redact({
        logs: [
          log(
            {
              'user.email': 'someone@example.invalid',
              'user.id': 'u-1',
              'user.account_id': 'acc-1',
              'user.account_uuid': '0000',
              'organization.id': 'org-1',
              'host.name': 'a-machine',
              'event.name': 'user_prompt',
              model: 'fake-model',
            },
            { resource: { 'host.name': 'a-machine', 'service.name': 'fake' } },
          ),
        ],
      });
      const record = first(out.logs);
      expect(Object.keys(record.attributes).sort()).toEqual(
        ['event.name', 'model', REDACTED_ATTRIBUTE].sort(),
      );
      expect(record.resource).toEqual({ 'service.name': 'fake' });
      expect(record.attributes[REDACTED_ATTRIBUTE]).toEqual([
        'host.name',
        'organization.id',
        'resource:host.name',
        'user.account_id',
        'user.account_uuid',
        'user.email',
        'user.id',
      ]);
      expect(text(out)).not.toContain('example.invalid');
    });

    it(`masks the value of a secret-looking key and the shape of a credential (${mode})`, () => {
      const redactor = new Redactor({ mode });
      const out = redactor.redact({
        spans: [
          span(
            {
              api_key: 'plain-but-secret',
              'http.authorization': 'whatever',
              note: 'sent Bearer abcdefghijklmnop to the host',
              token_type: 'bearer',
              'tokens.input': 12,
              password_file: '/run/x',
              ok: 'fine',
            },
            { statusMessage: 'failed with sk-FAKEFAKEFAKEFAKEFAKE0000' },
          ),
        ],
      });
      const record = first(out.spans);
      expect(record.attributes.api_key).toBe('[redacted]');
      expect(record.attributes['http.authorization']).toBe('[redacted]');
      expect(record.attributes.note).toBe('sent [REDACTED] to the host');
      expect(record.attributes.token_type).toBe('bearer');
      expect(record.attributes['tokens.input']).toBe(12);
      expect(record.attributes.password_file).toBe('/run/x');
      expect(record.attributes.ok).toBe('fine');
      expect(record.statusMessage).toBe('failed with [REDACTED]');
      expect(record.attributes[REDACTED_ATTRIBUTE]).toEqual([
        'api_key',
        'http.authorization',
        'note',
        'status.message',
      ]);
    });

    it(`replaces every value the vault holds, wherever it is (${mode})`, () => {
      const redactor = new Redactor({ mode, secrets: () => [FAKE_VAULT_VALUE, 'short'] });
      const out = redactor.redact({
        logs: [
          log(
            {
              cmd: `run --key ${FAKE_VAULT_VALUE} --short short`,
              nested: { a: [FAKE_VAULT_VALUE] },
            },
            { body: `used ${FAKE_VAULT_VALUE}`, resource: { env: FAKE_VAULT_VALUE } },
          ),
        ],
      });
      const record = first(out.logs);
      expect(text(record)).not.toContain(FAKE_VAULT_VALUE);
      // A value under the minimum length is not searched: it would tear ordinary text apart.
      expect(record.attributes.cmd).toBe('run --key [redacted] --short short');
      expect(record.body).toBe('used [redacted]');
      expect(record.attributes[REDACTED_ATTRIBUTE]).toEqual([
        'body',
        'cmd',
        'nested',
        'resource:env',
      ]);
    });

    it(`does not change the input and leaves the ids of OTheater alone (${mode})`, () => {
      const redactor = new Redactor({ mode });
      const original: TelemetryBatch = {
        metrics: [
          point(
            { 'user.email': 'someone@example.invalid' },
            { 'otheater.attempt_id': 'play-1/stage-a/1', 'otheater.client': 'codex' },
          ),
        ],
      };
      const copy = structuredClone(original);
      const out = redactor.redact(original);
      expect(original).toEqual(copy);
      expect(first(out.metrics).resource).toEqual({
        'otheater.attempt_id': 'play-1/stage-a/1',
        'otheater.client': 'codex',
      });
    });
  }

  it('returns a batch with only the signals it was given', () => {
    const redactor = new Redactor({ mode: 'default' });
    expect(redactor.redact({ spans: [] })).toEqual({ spans: [] });
  });
});

describe('Redactor: content (default mode)', () => {
  const codexToolResult = log(
    {
      'event.name': 'codex.tool_result',
      tool_name: 'shell',
      arguments: '{"cmd":["ls","-la"]}',
      output: 'file-a\nfile-b\n',
      success: 'true',
      'conversation.id': 'conv-1',
    },
    { body: null },
  );

  it('replaces the arguments and the output of codex.tool_result by size and hash', () => {
    const redactor = new Redactor({ mode: 'default' });
    const record = first(redactor.redact({ logs: [codexToolResult] }).logs);
    expect(record.attributes.arguments).toEqual({
      redacted: 'content',
      size: '{"cmd":["ls","-la"]}'.length,
      sha256: createHash('sha256').update('{"cmd":["ls","-la"]}').digest('hex'),
    });
    expect(record.attributes.output).toMatchObject({ redacted: 'content', size: 14 });
    expect(record.attributes.tool_name).toBe('shell');
    expect(record.attributes['conversation.id']).toBe('conv-1');
    expect(record.attributes[REDACTED_ATTRIBUTE]).toEqual(['arguments', 'output']);
    expect(text(record)).not.toContain('file-a');
  });

  it('keeps `arguments` and `output` of an event that is not a tool result', () => {
    const redactor = new Redactor({ mode: 'default' });
    const record = first(
      redactor.redact({ logs: [log({ 'event.name': 'other', output: 'kept' })] }).logs,
    );
    expect(record.attributes.output).toBe('kept');
    expect(record.attributes[REDACTED_ATTRIBUTE]).toBeUndefined();
  });

  it('reads the event name from the body when there is no event.name attribute', () => {
    const redactor = new Redactor({ mode: 'default' });
    const record = first(
      redactor.redact({ logs: [log({ output: 'gone' }, { body: 'codex.tool_result' })] }).logs,
    );
    expect(record.attributes.output).toMatchObject({ redacted: 'content' });
  });

  it('replaces prompts and answers of the clients, and keeps what is about the answer', () => {
    const redactor = new Redactor({ mode: 'default' });
    const record = first(
      redactor.redact({
        spans: [
          span({
            prompt: PROMPT,
            user_prompt: PROMPT,
            'ai.prompt.messages': '[{"role":"user"}]',
            'ai.response.text': 'the answer',
            'ai.response.finishReason': 'stop',
            'ai.response.model': 'fake-model',
            'gen_ai.user.message.content': PROMPT,
            'gen_ai.usage.input_tokens': 5,
            tool_parameters: '{"a":1}',
            empty_prompt: '',
          }),
        ],
      }).spans,
    );
    for (const name of [
      'prompt',
      'user_prompt',
      'ai.prompt.messages',
      'ai.response.text',
      'gen_ai.user.message.content',
      'tool_parameters',
    ]) {
      expect(record.attributes[name], name).toMatchObject({ redacted: 'content' });
    }
    expect(record.attributes['ai.response.finishReason']).toBe('stop');
    expect(record.attributes['ai.response.model']).toBe('fake-model');
    expect(record.attributes['gen_ai.usage.input_tokens']).toBe(5);
    expect(text(record)).not.toContain(PROMPT);
  });

  it('gives two equal contents the same hash and two different ones another', () => {
    const redactor = new Redactor({ mode: 'default' });
    const out = redactor.redact({
      logs: [log({ prompt: 'a' }), log({ prompt: 'a' }), log({ prompt: 'b' })],
    });
    const hashes = (out.logs ?? []).map(
      (record) => (record.attributes.prompt as { sha256: string }).sha256,
    );
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });
});

describe('Redactor: full mode', () => {
  it('keeps the content, and still deletes the identity and masks the secrets', () => {
    const redactor = new Redactor({ mode: 'full', secrets: () => [FAKE_VAULT_VALUE] });
    const record = first(
      redactor.redact({
        logs: [
          log({
            'event.name': 'codex.tool_result',
            arguments: `{"key":"${FAKE_VAULT_VALUE}"}`,
            output: 'file-a',
            prompt: PROMPT,
            'user.email': 'someone@example.invalid',
          }),
        ],
      }).logs,
    );
    expect(record.attributes.output).toBe('file-a');
    expect(record.attributes.prompt).toBe(PROMPT);
    expect(record.attributes.arguments).toBe('{"key":"[redacted]"}');
    expect(record.attributes['user.email']).toBeUndefined();
    expect(record.attributes[REDACTED_ATTRIBUTE]).toEqual(['arguments', 'user.email']);
  });
});

describe('Redactor.drain', () => {
  it('reports what was removed, once, with names and no values', () => {
    const redactor = new Redactor({ mode: 'default' });
    expect(redactor.drain()).toBeUndefined();
    redactor.redact({
      logs: [
        log({ 'user.email': 'someone@example.invalid', prompt: PROMPT }),
        log({ prompt: PROMPT }),
        log({ plain: 'x' }),
      ],
    });
    const report = redactor.drain();
    expect(report).toEqual({
      mode: 'default',
      count: 3,
      records: 2,
      names: ['prompt', 'user.email'],
    });
    expect(text(report)).not.toContain(PROMPT);
    expect(redactor.drain()).toBeUndefined();
  });

  it('masks a long text in chunks without losing the credentials in it', () => {
    const redactor = new Redactor({ mode: 'full' });
    const filler = 'lorem ipsum dolor sit amet '.repeat(5000);
    const record = first(
      redactor.redact({
        logs: [log({}, { body: `${filler}\nsk-FAKEFAKEFAKEFAKEFAKE0000\n${filler}` })],
      }).logs,
    );
    expect(record.body).not.toContain('sk-FAKE');
    expect(record.body?.length).toBeGreaterThan(filler.length * 2);
  });
});
