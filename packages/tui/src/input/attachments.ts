// SPDX-License-Identifier: MPL-2.0
import type { AddAttachmentBody } from '@otheater/protocol';

/**
 * What the box keeps of what the Producer attached while writing: the pasted text, the image of the
 * clipboard, the file whose path was pasted. The text of the message holds a marker where each one
 * went (`[Pasted text #1]`); the box does not talk to the daemon, so the owner of the box uploads
 * the drafts with {@link bindAttachments} when the message is sent.
 */

export const ATTACHMENT_KINDS = ['text', 'image', 'file'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export interface AttachmentDraft {
  /** The marker in the text, such as `[Pasted text #1]`. */
  readonly marker: string;
  /** The number of the marker (`#1`), unique in the box. */
  readonly number: number;
  readonly kind: AttachmentKind;
  /** What the daemon takes (`POST /v1/scenarios/:scenarioId/attachments`). */
  readonly body: AddAttachmentBody;
  /** A file the box created (the image of the clipboard) and removes when it is done. */
  readonly temporaryPath?: string | undefined;
}

/** What the box hands to its owner when the Producer sends. */
export interface ProducerMessage {
  /** The text as written, with the markers. */
  readonly text: string;
  /** Only the drafts whose marker is still in the text, in the order of the markers. */
  readonly attachments: readonly AttachmentDraft[];
}

const MARKER_LABELS = { text: 'Pasted text', image: 'Image', file: 'File' } as const;

/**
 * The marker of a draft. The words are the ones the coding agents use (`[Pasted text #1]`,
 * `[Image #1]`) and are part of the message the agents read, so they are not translated.
 */
export function markerFor(kind: AttachmentKind, number: number): string {
  return `[${MARKER_LABELS[kind]} #${String(number)}]`;
}

/** The drafts whose marker is in `text`, in the order they appear. */
export function draftsInText(
  text: string,
  drafts: readonly AttachmentDraft[],
): readonly AttachmentDraft[] {
  return drafts
    .map((draft) => ({ draft, at: text.indexOf(draft.marker) }))
    .filter((found) => found.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((found) => found.draft);
}

/** The next number for a marker: after every one in use (the drafts and the sequence). */
export function nextMarkerNumber(sequence: number, drafts: readonly AttachmentDraft[]): number {
  return Math.max(sequence, ...drafts.map((draft) => draft.number)) + 1;
}

export interface BoundMessage {
  /** The text with each marker's `#n` replaced by the id the store gave (`[Pasted text A3]`). */
  readonly text: string;
  /** The ids (`A<n>`), in the order of the markers: the `attachments` of the chat message. */
  readonly attachments: readonly string[];
}

/**
 * Uploads the drafts of a message with `upload` (the owner's call to the attachments route) and
 * rewrites the markers with the ids. [proposta] The agent reads `[Pasted text A3]` in the text and
 * `A3` in the attachments, so the marker tells which attachment it stands for.
 */
export async function bindAttachments(
  message: ProducerMessage,
  upload: (body: AddAttachmentBody) => Promise<{ readonly id: string }>,
): Promise<BoundMessage> {
  let text = message.text;
  const ids: string[] = [];
  for (const draft of message.attachments) {
    const { id } = await upload(draft.body);
    ids.push(id);
    text = text.split(draft.marker).join(draft.marker.replace(/#\d+\]$/, `${id}]`));
  }
  return { text, attachments: ids };
}
