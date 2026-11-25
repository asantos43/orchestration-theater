// SPDX-License-Identifier: MPL-2.0

/**
 * The modes of `collab.notes.mode` (N308, option 1; plan of Phase 11b, P13). [proposta] `play`
 * (default): an Actor reads the notes of every demand of its play; `deps`: only of the demands it
 * depends on and of the ones that depend on it; `off`: no notes board.
 */
export const COLLAB_NOTES_MODES = ['play', 'deps', 'off'] as const;
export type CollabNotesMode = (typeof COLLAB_NOTES_MODES)[number];

/** `collab.notes` as the handlers read it. */
export interface CollabNotesSettings {
  readonly mode: CollabNotesMode;
  readonly max_per_actor: number;
  readonly max_chars: number;
}

/** The defaults of `collab.notes`, for a handler built without a configuration. */
export const DEFAULT_COLLAB_NOTES: CollabNotesSettings = {
  mode: 'play',
  max_per_actor: 20,
  max_chars: 2000,
};
