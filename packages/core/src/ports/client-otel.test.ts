// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { InvalidInput } from '../errors.js';
import {
  otelBaseEnv,
  otelEndpoint,
  otelHeaders,
  otelResourceAttributes,
  otelSignalUrl,
  type ClientOtel,
} from './client-otel.js';

const otel: ClientOtel = {
  endpoint: 'http://127.0.0.1:4318/',
  headers: { Authorization: 'Bearer tok-1' },
  resource: { 'otheater.play_id': 'p1', 'otheater.attempt_id': 'a1' },
};

describe('otelEndpoint and otelSignalUrl', () => {
  it('drops the trailing slash and appends the signal path', () => {
    expect(otelEndpoint('http://127.0.0.1:4318/')).toBe('http://127.0.0.1:4318');
    expect(otelSignalUrl('http://127.0.0.1:4318//', 'traces')).toBe(
      'http://127.0.0.1:4318/v1/traces',
    );
    expect(otelSignalUrl('https://collector.example/otlp', 'logs')).toBe(
      'https://collector.example/otlp/v1/logs',
    );
  });

  it('refuses what is not an http(s) URL, or carries a credential', () => {
    expect(() => otelEndpoint('not a url')).toThrow(InvalidInput);
    expect(() => otelEndpoint('file:///tmp/x')).toThrow(InvalidInput);
    expect(() => otelEndpoint('http://user:secret@127.0.0.1:4318')).toThrow(InvalidInput);
  });
});

describe('otelResourceAttributes', () => {
  it('sorts by key, so the same set always gives the same text', () => {
    expect(otelResourceAttributes({ b: '2', a: '1' })).toBe('a=1,b=2');
    expect(otelResourceAttributes({})).toBe('');
  });

  it('refuses a key or a value the format cannot carry, naming the key and never the value', () => {
    for (const resource of [
      { 'a b': '1' },
      { 'a=b': '1' },
      { a: '' },
      { a: 'x,y' },
      { a: 'x=y' },
      { a: 'x y' },
      { a: 'x\ny' },
    ]) {
      expect(() => otelResourceAttributes(resource)).toThrow(InvalidInput);
    }
    expect(() => otelResourceAttributes({ k: 'secret-value,x' })).toThrow(/otel\.resource\["k"\]/u);
    expect(() => otelResourceAttributes({ k: 'secret-value,x' })).not.toThrow(/secret-value/u);
  });
});

describe('otelHeaders', () => {
  it('keeps the spaces of a value and sorts by name', () => {
    expect(otelHeaders({ Z: '1', Authorization: 'Bearer tok' })).toBe(
      'Authorization=Bearer tok,Z=1',
    );
  });

  it('refuses a name that is not an HTTP token, and a value with a comma, a control or nothing', () => {
    for (const headers of [
      { 'Bad Name': 'x' },
      { '': 'x' },
      { A: '' },
      { A: 'x,y' },
      { A: 'x\ry' },
    ]) {
      expect(() => otelHeaders(headers)).toThrow(InvalidInput);
    }
    expect(() => otelHeaders({ A: 'tok-secret,x' })).toThrow(/otel\.headers\["A"\]/u);
    expect(() => otelHeaders({ A: 'tok-secret,x' })).not.toThrow(/tok-secret/u);
  });
});

describe('otelBaseEnv', () => {
  it('gives the endpoint, the headers and the resource, and nothing about traces or the content', () => {
    expect(otelBaseEnv(otel)).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer tok-1',
      OTEL_RESOURCE_ATTRIBUTES: 'otheater.attempt_id=a1,otheater.play_id=p1',
    });
  });

  it('leaves the headers variable out when there is no header', () => {
    expect(otelBaseEnv({ ...otel, headers: {} })).not.toHaveProperty('OTEL_EXPORTER_OTLP_HEADERS');
  });
});
