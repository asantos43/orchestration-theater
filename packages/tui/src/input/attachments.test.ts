// SPDX-License-Identifier: MPL-2.0
import type { AddAttachmentBody } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import {
  bindAttachments,
  draftsInText,
  markerFor,
  nextMarkerNumber,
  type AttachmentDraft,
} from './attachments.js';

function draft(
  kind: AttachmentDraft['kind'],
  number: number,
  body: AddAttachmentBody,
): AttachmentDraft {
  return { marker: markerFor(kind, number), number, kind, body };
}

describe('the attachments of the message', () => {
  it('names each kind of marker with one sequence of numbers', () => {
    expect(markerFor('text', 1)).toBe('[Pasted text #1]');
    expect(markerFor('image', 2)).toBe('[Image #2]');
    expect(markerFor('file', 3)).toBe('[File #3]');
  });

  it('keeps only the drafts whose marker is still in the text, in the order of the text', () => {
    const a = draft('text', 1, { text: 'a' });
    const b = draft('image', 2, { path: '/tmp/b.png' });
    const c = draft('file', 3, { path: '/tmp/c.txt' });
    const text = `see ${b.marker} and ${a.marker}`;
    expect(draftsInText(text, [a, b, c])).toEqual([b, a]);
    expect(draftsInText('nothing', [a, b, c])).toEqual([]);
  });

  it('numbers the next marker after every one in use', () => {
    const a = draft('text', 4, { text: 'a' });
    expect(nextMarkerNumber(0, [])).toBe(1);
    expect(nextMarkerNumber(2, [])).toBe(3);
    expect(nextMarkerNumber(2, [a])).toBe(5);
  });

  it('uploads the drafts in order and rewrites each marker with the id the store gave', async () => {
    const a = draft('text', 1, { text: 'whole text', name: 'pasted-text-1.txt' });
    const b = draft('image', 2, { path: '/tmp/b.png', mode: 'copy' });
    const uploaded: AddAttachmentBody[] = [];
    const bound = await bindAttachments(
      { text: `${a.marker} then ${b.marker} and again ${a.marker}`, attachments: [a, b] },
      (body) => {
        uploaded.push(body);
        return Promise.resolve({ id: `A${String(uploaded.length + 6)}` });
      },
    );
    expect(uploaded).toEqual([a.body, b.body]);
    expect(bound.attachments).toEqual(['A7', 'A8']);
    expect(bound.text).toBe('[Pasted text A7] then [Image A8] and again [Pasted text A7]');
  });

  it('stops at the first upload that fails, without sending the rest', async () => {
    const a = draft('text', 1, { text: 'a' });
    const b = draft('text', 2, { text: 'b' });
    let calls = 0;
    await expect(
      bindAttachments({ text: `${a.marker}${b.marker}`, attachments: [a, b] }, () => {
        calls += 1;
        return Promise.reject(new Error('daemon down'));
      }),
    ).rejects.toThrow('daemon down');
    expect(calls).toBe(1);
  });
});
