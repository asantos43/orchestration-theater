// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { NormalizedUpdate } from '@otheater/core';
import { silentReplyText, TurnTools } from './director-silence.js';

/** What the tool calls of a silent turn of the Director are made of (N183). */

const started = (toolCallId: string, title: string): NormalizedUpdate => ({
  kind: 'tool_call',
  toolCallId,
  title,
  toolKind: 'other',
  status: 'in_progress',
});

describe('TurnTools', () => {
  it('keeps the tools in the order they started, with the last status each reported', () => {
    const tools = new TurnTools();
    tools.note(started('a', 'framework_open_play'));
    tools.note(started('b', 'framework_ask_producer'));
    tools.note({ kind: 'tool_call_update', toolCallId: 'a', status: 'completed' });
    tools.note({ kind: 'tool_call_update', toolCallId: 'b', status: 'failed' });
    expect(tools.list()).toEqual([
      { name: 'framework_open_play', status: 'completed' },
      { name: 'framework_ask_producer', status: 'failed' },
    ]);
  });

  it('takes a later title, ignores the other updates, and names a call the client left without one', () => {
    const tools = new TurnTools();
    tools.note({ kind: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
    tools.note(started('a', ''));
    tools.note({ kind: 'tool_call_update', toolCallId: 'a', title: 'open_play' });
    tools.note({ kind: 'tool_call_update', toolCallId: 'late', status: 'completed' });
    expect(tools.list()).toEqual([
      { name: 'open_play', status: 'in_progress' },
      { name: 'tool', status: 'completed' },
    ]);
  });

  it('flattens and shortens a title that is a whole command line', () => {
    const tools = new TurnTools();
    tools.note(started('a', `run\n  ${'x'.repeat(200)}`));
    const [tool] = tools.list();
    expect(tool?.name.startsWith('run xxx')).toBe(true);
    expect(tool?.name).toHaveLength(80);
  });
});

describe('silentReplyText', () => {
  it('says the Director did not answer when no tool was called', () => {
    expect(silentReplyText([], null)).toBe('The Director ended the turn without a reply.');
  });

  it('lists the tools, marks the failed one and names the play', () => {
    expect(
      silentReplyText(
        [
          { name: 'open_play', status: 'completed' },
          { name: 'ask_producer', status: 'failed' },
        ],
        'play-7',
      ),
    ).toBe(
      'The Director ended the turn without a reply. Tools called: open_play, ask_producer (failed). Play opened: play-7.',
    );
  });

  it('leaves the play out when there was none', () => {
    expect(silentReplyText([{ name: 'open_play', status: null }], null)).toBe(
      'The Director ended the turn without a reply. Tools called: open_play.',
    );
  });
});
