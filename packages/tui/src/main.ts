// SPDX-License-Identifier: MPL-2.0
import { runTuiMain } from './run-main.js';

/** The entry of the process the launcher starts: `node [flags] main.js --data-dir <dir>`. */
await runTuiMain(process.argv.slice(2));
