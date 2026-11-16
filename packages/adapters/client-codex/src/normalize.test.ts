// SPDX-License-Identifier: MPL-2.0
import { NormalizedUpdateSchema } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import * as errors from './fixtures/errors.js';
import * as updates from './fixtures/updates.js';
import { contentOf, normalizeCodexError, normalizeCodexUpdate } from './normalize.js';

function normalized(raw: unknown) {
  const update = normalizeCodexUpdate(raw);
  // Whatever comes out has to pass the strict schema of core.
  if (update !== null) NormalizedUpdateSchema.parse(update);
  return update;
}

describe('normalizeCodexUpdate', () => {
  it('turns message and thought chunks into text chunks', () => {
    expect(normalized(updates.AGENT_MESSAGE_CHUNK)).toEqual({
      kind: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
      messageId: 'msg-1',
    });
    expect(normalized(updates.AGENT_THOUGHT_CHUNK)).toEqual({
      kind: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
    });
  });

  it('drops client-only fields of a tool call and keeps the valid locations', () => {
    expect(normalized(updates.TOOL_CALL)).toEqual({
      kind: 'tool_call',
      toolCallId: 'call-1',
      title: 'Run ls',
      toolKind: 'execute',
      status: 'in_progress',
      locations: [{ path: '/work/src/a.ts', line: 3 }, { path: '/work/src/b.ts' }],
    });
  });

  it('carries only what changed in a tool call update', () => {
    expect(normalized(updates.TOOL_CALL_UPDATE)).toEqual({
      kind: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
    });
  });

  it('falls back to kind other and status pending for values it does not know', () => {
    expect(
      normalized({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 't', kind: 'teleport' }),
    ).toMatchObject({ toolKind: 'other', status: 'pending' });
  });

  it('swallows a tool call with no id', () => {
    expect(normalized({ sessionUpdate: 'tool_call', title: 't' })).toBeNull();
    expect(normalized({ sessionUpdate: 'tool_call_update' })).toBeNull();
  });

  it('keeps plan entries that have content and repairs the enums', () => {
    expect(normalized(updates.PLAN)).toEqual({
      kind: 'plan',
      entries: [
        { content: 'read', priority: 'high', status: 'completed' },
        { content: 'edit', priority: 'medium', status: 'in_progress' },
        { content: 'test', priority: 'medium', status: 'pending' },
      ],
    });
  });

  it('turns usage_update into context use and cost', () => {
    expect(normalized(updates.USAGE_UPDATE)).toEqual({
      kind: 'usage',
      contextUsed: 1200,
      contextSize: 258000,
      costUsd: 0.25,
    });
    expect(normalized({ sessionUpdate: 'usage_update' })).toBeNull();
    expect(normalized({ sessionUpdate: 'usage_update', used: 1.5 })).toBeNull();
  });

  it('turns the commands, dropping the ones with no name', () => {
    expect(normalized(updates.AVAILABLE_COMMANDS_UPDATE)).toEqual({
      kind: 'available_commands',
      commands: [
        { name: 'review', description: 'Review the changes', inputHint: 'what to review' },
        { name: 'compact', description: 'Compact the context' },
      ],
    });
  });

  it('turns mode and config option changes into config_changed', () => {
    expect(normalized(updates.CURRENT_MODE_UPDATE)).toEqual({
      kind: 'config_changed',
      options: [{ id: 'mode', category: 'mode', value: 'workspace-write' }],
    });
    expect(normalized(updates.CONFIG_OPTION_UPDATE)).toEqual({
      kind: 'config_changed',
      options: [
        { id: 'model', category: 'model', value: 'model-a' },
        { id: 'fast-mode', value: true },
      ],
    });
    expect(
      normalized({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'x' }] }),
    ).toBeNull();
  });

  it('swallows session_info_update, the replay of the user and unknown types', () => {
    expect(normalized(updates.SESSION_INFO_UPDATE)).toBeNull();
    expect(normalized(updates.USER_MESSAGE_CHUNK)).toBeNull();
    expect(normalized({ sessionUpdate: 'something_new' })).toBeNull();
    expect(normalized('text')).toBeNull();
    expect(normalized(null)).toBeNull();
    expect(normalized([])).toBeNull();
  });

  it('swallows a chunk whose content is not a content block', () => {
    expect(
      normalized({ sessionUpdate: 'agent_message_chunk', content: { type: 'video' } }),
    ).toBeNull();
    expect(normalized({ sessionUpdate: 'agent_message_chunk' })).toBeNull();
  });
});

describe('contentOf', () => {
  it('cuts each block down to the fields of the schema', () => {
    expect(contentOf({ type: 'text', text: 'a', annotations: {} })).toEqual({
      type: 'text',
      text: 'a',
    });
    expect(
      contentOf({ type: 'image', data: 'AA', mimeType: 'image/png', uri: 'file:///i.png' }),
    ).toEqual({
      type: 'image',
      data: 'AA',
      mimeType: 'image/png',
      uri: 'file:///i.png',
    });
    expect(contentOf({ type: 'audio', data: 'AA', mimeType: 'audio/wav' })).toEqual({
      type: 'audio',
      data: 'AA',
      mimeType: 'audio/wav',
    });
    expect(contentOf({ type: 'resource_link', uri: 'file:///a', name: 'a', size: 3 })).toEqual({
      type: 'resource_link',
      uri: 'file:///a',
      name: 'a',
    });
    expect(contentOf({ type: 'resource', resource: { uri: 'file:///a', text: 't' } })).toEqual({
      type: 'resource',
      resource: { uri: 'file:///a', text: 't' },
    });
    expect(
      contentOf({ type: 'resource', resource: { uri: 'file:///a', blob: 'AA', mimeType: 'x/y' } }),
    ).toEqual({
      type: 'resource',
      resource: { uri: 'file:///a', blob: 'AA', mimeType: 'x/y' },
    });
  });

  it('rejects what is incomplete', () => {
    expect(contentOf({ type: 'image', data: 'AA' })).toBeUndefined();
    expect(contentOf({ type: 'resource', resource: { uri: 'file:///a' } })).toBeUndefined();
    expect(contentOf({ type: 'resource_link', uri: 'file:///a' })).toBeUndefined();
    expect(contentOf('x')).toBeUndefined();
  });
});

describe('normalizeCodexError', () => {
  it('maps the usage limit to quota_exhausted, without inventing a reset time', () => {
    const result = normalizeCodexError(errors.QUOTA_EXHAUSTED);
    expect(result.kind).toBe('quota_exhausted');
    expect(result.resetsAt).toBeUndefined();
    expect(result.message).toContain('usage limit');
    expect(result.cause).toBe(errors.QUOTA_EXHAUSTED);
  });

  it('uses a reset time when the error carries one', () => {
    expect(normalizeCodexError(errors.QUOTA_EXHAUSTED_WITH_RESET).resetsAt).toBe(
      Date.parse('2026-11-20T12:31:00.000Z'),
    );
    const seconds = {
      ...errors.QUOTA_EXHAUSTED,
      data: { codexErrorInfo: 'usageLimitExceeded', resets_at: 1_800_000_000 },
    };
    expect(normalizeCodexError(seconds).resetsAt).toBe(1_800_000_000_000);
    const garbage = {
      ...errors.QUOTA_EXHAUSTED,
      data: { codexErrorInfo: 'usageLimitExceeded', resetsAt: 'soon' },
    };
    expect(normalizeCodexError(garbage).resetsAt).toBeUndefined();
  });

  it('maps a missing login to auth_required', () => {
    expect(normalizeCodexError(errors.AUTHENTICATION_REQUIRED).kind).toBe('auth_required');
    expect(normalizeCodexError({ message: 'Please log in' }).kind).toBe('auth_required');
    expect(
      normalizeCodexError({ code: -32603, message: 'x', data: { codexErrorInfo: 'unauthorized' } })
        .kind,
    ).toBe('auth_required');
  });

  it('maps connection trouble to transient and a sandbox error to permission', () => {
    expect(normalizeCodexError(errors.TRANSIENT).kind).toBe('transient');
    expect(
      normalizeCodexError({ message: 'x', data: { codexErrorInfo: 'sandboxError' } }).kind,
    ).toBe('permission');
  });

  it('tells a stuck client and a dead one apart', () => {
    expect(normalizeCodexError(new Error('the client is unresponsive')).kind).toBe('stuck');
    expect(normalizeCodexError(new Error('ACP connection closed')).kind).toBe('client_crash');
    expect(normalizeCodexError({ code: -32603, message: 'connection closed' }).kind).toBe(
      'unknown',
    );
  });

  it('is unknown for anything else, also for a value that is not an error', () => {
    expect(normalizeCodexError({ code: -32603, message: 'boom' }).kind).toBe('unknown');
    expect(normalizeCodexError('plain text')).toMatchObject({
      kind: 'unknown',
      message: 'plain text',
    });
    expect(normalizeCodexError(undefined).kind).toBe('unknown');
  });
});
