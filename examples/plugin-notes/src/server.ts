// SPDX-License-Identifier: MPL-2.0
import { pluginProjectDirectory, servePlugin } from '@otheater/sdk/plugin';
import { notesPlugin } from './plugin.js';

// The entry of the server: `node dist/server.js`, as the manifest says. The project folder comes
// from OTHEATER_PROJECT_DIR, which the daemon sets; by hand it is the current folder.
servePlugin(notesPlugin(pluginProjectDirectory()));
