#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import { createFakeAgent, serveStdio } from './agent.js';
import { parseScriptSpec, ScriptError } from './scripts.js';

/** Entry point of the `fake-agent` binary: an ACP agent on stdio. FAKE_AGENT_SCRIPT sets the default script. */
async function main(): Promise<void> {
  const spec = process.env.FAKE_AGENT_SCRIPT;
  const defaultScript = spec === undefined || spec === '' ? undefined : parseScriptSpec(spec);
  await serveStdio(createFakeAgent(defaultScript === undefined ? {} : { defaultScript }));
}

main().catch((error: unknown) => {
  // Stdout is the protocol channel: diagnostics go to stderr only.
  const text = error instanceof ScriptError ? error.message : String(error);
  process.stderr.write(`fake-agent: ${text}\n`);
  process.exitCode = 1;
});
