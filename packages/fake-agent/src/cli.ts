#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import { createFakeAgent, serveStdio } from './agent.js';
import { parseScriptSpec, ScriptError } from './scripts.js';

/** Entry point of the `fake-agent` binary: an ACP agent on stdio. FAKE_AGENT_SCRIPT sets the default script; FAKE_AGENT_UPDATES_ON_CONFIG=1 turns on `updatesOnConfig`. FAKE_AGENT_SURVIVE_EOF=1 keeps the process alive after the client closed stdin: a test-only way to make an orphan that outlives a daemon killed with `kill -9`. */
async function main(): Promise<void> {
  const spec = process.env.FAKE_AGENT_SCRIPT;
  const defaultScript = spec === undefined || spec === '' ? undefined : parseScriptSpec(spec);
  await serveStdio(
    createFakeAgent({
      ...(defaultScript === undefined ? {} : { defaultScript }),
      ...(process.env.FAKE_AGENT_UPDATES_ON_CONFIG === '1' ? { updatesOnConfig: true } : {}),
    }),
  );
  if (process.env.FAKE_AGENT_SURVIVE_EOF === '1') {
    // [proposta] An interval keeps the event loop alive; nothing else is served.
    setInterval(() => undefined, 60_000);
  }
}

main().catch((error: unknown) => {
  // Stdout is the protocol channel: diagnostics go to stderr only.
  const text = error instanceof ScriptError ? error.message : String(error);
  process.stderr.write(`fake-agent: ${text}\n`);
  process.exitCode = 1;
});
