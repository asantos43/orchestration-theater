// SPDX-License-Identifier: MPL-2.0
import { definePlugin, pluginTool, readPluginManifest } from '@otheater/sdk/plugin';
import { z } from 'zod';
import { MAX_NOTE_CHARS, NotesStore } from './notes.js';

/** The `plugin.yaml` of this package: `dist/plugin.js` is one level below it. */
export const MANIFEST_URL = new URL('../plugin.yaml', import.meta.url);

/**
 * The plugin, over the notes of `projectDir`. The manifest says what the tools are (roles,
 * effects, approval); this says what they do. `definePlugin` refuses the pair if they disagree.
 */
export function notesPlugin(projectDir: string, now?: () => Date) {
  const store = new NotesStore(projectDir, now);
  return definePlugin({
    manifest: readPluginManifest(MANIFEST_URL),
    tools: {
      list_notes: pluginTool({
        handler: () => store.list(),
      }),
      add_note: pluginTool({
        input: z.object({
          text: z.string().trim().min(1).max(MAX_NOTE_CHARS).describe('The text of the note.'),
        }),
        handler: async ({ text }, { emit }) => {
          const note = await store.add(text);
          await emit('note_added', { id: note.id, length: note.text.length });
          return note;
        },
      }),
      clear_notes: pluginTool({
        handler: async () => ({ deleted: await store.clear() }),
      }),
    },
  });
}
